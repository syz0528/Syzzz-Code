import { Buffer } from 'node:buffer';
import picomatch from 'picomatch';
import type { AgentEventData } from '../events.js';
import { runBoundedProcess } from '../tools/bounded-process.js';
import { isAbortError, OperationAbortedError, throwIfAborted } from '../tools/abort.js';
import { expandEnvironmentTemplates } from './config.js';
import type {
  ExtensionTurnContext,
  HookConfig,
  HookEventName,
  HookRuntimeStatus,
  ResolvedHookConfig
} from './types.js';

const MAX_HOOK_STDIN_BYTES = 64 * 1024;
const MAX_HOOK_STDOUT_BYTES = 16 * 1024;
const MAX_HOOK_STDERR_BYTES = 8 * 1024;
const MAX_HOOK_REASON_CHARACTERS = 1_000;
const TERMINAL_HOOK_TIMEOUT_MS = 2_000;

const SAFE_INHERITED_ENVIRONMENT = new Set([
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'LANG'
]);
const SAFE_INHERITED_ENVIRONMENT_LOWER = new Set(
  [...SAFE_INHERITED_ENVIRONMENT].map((name) => name.toLowerCase())
);

function shouldInheritEnvironmentVariable(name: string): boolean {
  return (
    SAFE_INHERITED_ENVIRONMENT.has(name) ||
    (process.platform === 'win32' && SAFE_INHERITED_ENVIRONMENT_LOWER.has(name.toLowerCase())) ||
    name.startsWith('LC_')
  );
}

export interface HookInvocation {
  event: HookEventName;
  context: ExtensionTurnContext;
  workspaceRoot: string;
  timestamp: string;
  subject?: string;
  payload: Record<string, unknown>;
}

export interface HookRunResult {
  decision: 'continue' | 'deny';
  reason?: string;
}

interface HookProcessResult {
  outcome: 'success' | 'denied' | 'error' | 'timeout';
  durationMs: number;
  decision: 'continue' | 'deny';
  reason?: string;
  errorCode?: string;
}

function safeEnvironment(
  configured: Record<string, string>,
  forbiddenEnvironmentNames: readonly string[]
): NodeJS.ProcessEnv {
  const normalizeName = (name: string): string =>
    process.platform === 'win32' ? name.toUpperCase() : name;
  const forbidden = new Set(forbiddenEnvironmentNames.map(normalizeName));
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !forbidden.has(normalizeName(name)) &&
      shouldInheritEnvironmentVariable(name)
    ) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    ...expandEnvironmentTemplates(configured, process.env, forbiddenEnvironmentNames)
  };
}

function isTerminalEvent(event: HookEventName): boolean {
  return event === 'TurnCompleted' || event === 'TurnFailed' || event === 'TurnCancelled';
}

function encodeInvocation(invocation: HookInvocation): string {
  const serialized = JSON.stringify({
    schemaVersion: 1,
    event: invocation.event,
    sessionId: invocation.context.sessionId,
    turnId: invocation.context.turnId,
    workspaceRoot: invocation.workspaceRoot,
    mode: invocation.context.mode,
    permissionMode: invocation.context.permissionMode,
    timestamp: invocation.timestamp,
    ...(invocation.subject ? { subject: invocation.subject } : {}),
    payload: invocation.payload
  });
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_HOOK_STDIN_BYTES) {
    throw new Error(`Hook input exceeds ${MAX_HOOK_STDIN_BYTES} bytes`);
  }
  return `${serialized}\n`;
}

function parsePreToolOutput(stdout: string): {
  decision: 'continue' | 'deny';
  reason?: string;
} {
  if (!stdout.trim()) {
    return { decision: 'continue' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('PreToolUse Hook stdout must be one JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('PreToolUse Hook stdout must be one JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.decision !== 'continue' && record.decision !== 'deny') {
    throw new Error('PreToolUse Hook decision must be "continue" or "deny"');
  }
  const unexpectedKeys = Object.keys(record).filter(
    (key) => key !== 'decision' && key !== 'reason'
  );
  if (unexpectedKeys.length > 0) {
    throw new Error(
      `PreToolUse Hook output contains unsupported keys: ` + unexpectedKeys.join(', ')
    );
  }
  const reason =
    record.reason === undefined
      ? undefined
      : typeof record.reason === 'string'
        ? record.reason.trim().slice(0, MAX_HOOK_REASON_CHARACTERS)
        : undefined;
  if (record.reason !== undefined && reason === undefined) {
    throw new Error('PreToolUse Hook reason must be a string');
  }
  return {
    decision: record.decision,
    ...(reason ? { reason } : {})
  };
}

function matchesHook(hook: HookConfig, invocation: HookInvocation): boolean {
  if (!hook.enabled || hook.event !== invocation.event) {
    return false;
  }
  if (!hook.matcher) {
    return true;
  }
  const subject = invocation.subject;
  return (
    subject !== undefined &&
    picomatch.isMatch(subject, hook.matcher, {
      dot: true,
      nocase: process.platform === 'win32'
    })
  );
}

async function runHookProcess(
  hook: HookConfig,
  invocation: HookInvocation,
  signal: AbortSignal,
  forbiddenEnvironmentNames: readonly string[]
): Promise<HookProcessResult> {
  const startedAt = Date.now();
  try {
    const stdin = encodeInvocation(invocation);
    const timeoutMs = isTerminalEvent(invocation.event)
      ? Math.min(hook.timeoutMs, TERMINAL_HOOK_TIMEOUT_MS)
      : hook.timeoutMs;
    const processResult = await runBoundedProcess(hook.command, hook.args, {
      cwd: invocation.workspaceRoot,
      signal,
      timeoutMs,
      maxStdoutBytes: MAX_HOOK_STDOUT_BYTES,
      maxStderrBytes: MAX_HOOK_STDERR_BYTES,
      env: safeEnvironment(hook.env, forbiddenEnvironmentNames),
      stdin
    });
    if (processResult.timedOut) {
      return {
        outcome: 'timeout',
        durationMs: processResult.durationMs,
        decision: hook.onError === 'deny' ? 'deny' : 'continue',
        errorCode: 'timeout'
      };
    }
    if (processResult.stdoutTruncated || processResult.stderrTruncated) {
      return {
        outcome: 'error',
        durationMs: processResult.durationMs,
        decision: hook.onError === 'deny' ? 'deny' : 'continue',
        errorCode: 'output_limit'
      };
    }
    if (processResult.exitCode !== 0) {
      return {
        outcome: 'error',
        durationMs: processResult.durationMs,
        decision: hook.onError === 'deny' ? 'deny' : 'continue',
        errorCode: 'nonzero_exit'
      };
    }
    if (invocation.event !== 'PreToolUse') {
      return {
        outcome: 'success',
        durationMs: processResult.durationMs,
        decision: 'continue'
      };
    }
    const decision = parsePreToolOutput(processResult.stdout.toString('utf8'));
    return {
      outcome: decision.decision === 'deny' ? 'denied' : 'success',
      durationMs: processResult.durationMs,
      decision: decision.decision,
      ...(decision.reason ? { reason: decision.reason } : {})
    };
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new OperationAbortedError('Hook execution cancelled');
    }
    return {
      outcome: 'error',
      durationMs: Math.max(0, Date.now() - startedAt),
      decision: hook.onError === 'deny' ? 'deny' : 'continue',
      errorCode: 'execution_error'
    };
  }
}

export class HookRunner {
  private hooks: ResolvedHookConfig[];
  private lastErrorCode?: string;
  private readonly runStatus = new Map<
    string,
    {
      outcome: HookProcessResult['outcome'];
      durationMs: number;
      errorCode?: string;
    }
  >();
  private readonly forbiddenEnvironmentNames: readonly string[];

  constructor(hooks: ResolvedHookConfig[], forbiddenEnvironmentNames: Iterable<string> = []) {
    this.hooks = [...hooks];
    this.forbiddenEnvironmentNames = [...new Set(forbiddenEnvironmentNames)];
  }

  replaceHooks(hooks: ResolvedHookConfig[]): void {
    this.hooks = [...hooks];
    this.lastErrorCode = undefined;
    this.runStatus.clear();
  }

  getStatus(): HookRuntimeStatus {
    return {
      configured: this.hooks.length,
      enabled: this.hooks.filter((hook) => hook.config.enabled).length,
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
      entries: this.hooks.map((hook) => {
        const latest = this.runStatus.get(hook.config.name);
        return {
          name: hook.config.name,
          event: hook.config.event,
          source: hook.source,
          enabled: hook.config.enabled,
          ...(hook.config.matcher ? { matcher: hook.config.matcher } : {}),
          ...(latest
            ? {
                lastOutcome: latest.outcome,
                lastDurationMs: latest.durationMs,
                ...(latest.errorCode ? { lastErrorCode: latest.errorCode } : {})
              }
            : {})
        };
      })
    };
  }

  async *run(
    invocation: HookInvocation,
    signal: AbortSignal
  ): AsyncGenerator<AgentEventData, HookRunResult> {
    throwIfAborted(signal);
    const matching = this.hooks.filter((hook) => matchesHook(hook.config, invocation));
    for (const hook of matching) {
      throwIfAborted(signal);
      yield {
        type: 'hook_started',
        hook: hook.config.name,
        event: invocation.event,
        source: hook.source
      };
      const result = await runHookProcess(
        hook.config,
        invocation,
        signal,
        this.forbiddenEnvironmentNames
      );
      if (result.errorCode) {
        this.lastErrorCode = result.errorCode;
      }
      this.runStatus.set(hook.config.name, {
        outcome: result.outcome,
        durationMs: result.durationMs,
        ...(result.errorCode ? { errorCode: result.errorCode } : {})
      });
      yield {
        type: 'hook_completed',
        hook: hook.config.name,
        event: invocation.event,
        source: hook.source,
        outcome: result.outcome,
        durationMs: result.durationMs,
        ...(result.errorCode ? { errorCode: result.errorCode } : {})
      };
      if (result.decision === 'deny') {
        return {
          decision: 'deny',
          reason:
            result.reason ??
            (result.errorCode
              ? `Hook ${hook.config.name} failed closed (${result.errorCode})`
              : `Hook ${hook.config.name} denied the operation`)
        };
      }
    }
    return { decision: 'continue' };
  }
}
