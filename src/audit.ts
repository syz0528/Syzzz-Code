import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AuditConfig } from './config.js';
import type { AgentEvent } from './events.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface AgentEventSink {
  record(event: AgentEvent): void;
  flush(): Promise<void>;
}

export interface AuditLoggerOptions {
  config: AuditConfig;
  sessionId: string;
  workspaceRoot: string;
  baseDirectory?: string;
  now?: () => number;
  warn?: (message: string) => void;
}

interface AuditFile {
  path: string;
  mtimeMs: number;
  size: number;
}

interface AuditEnvelope {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  sequence: number;
  timestamp: string;
  workspaceId: string;
  type: string;
  [key: string]: unknown;
}

async function listAuditFiles(directory: string): Promise<AuditFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: AuditFile[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAuditFiles(entryPath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const fileStats = await stat(entryPath);
    files.push({
      path: entryPath,
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size
    });
  }
  return files;
}

async function removeAuditFile(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    // Cleanup is best effort; a later startup can retry the same file.
    return false;
  }
}
export async function cleanupAuditDirectory(
  directory: string,
  config: AuditConfig,
  currentSessionFile: string,
  now: number = Date.now()
): Promise<void> {
  const normalizedCurrentFile = resolve(currentSessionFile);
  const retentionCutoff = now - config.retentionDays * DAY_MS;
  let files = await listAuditFiles(directory);

  for (const file of files) {
    if (resolve(file.path) !== normalizedCurrentFile && file.mtimeMs < retentionCutoff) {
      await removeAuditFile(file.path);
    }
  }

  files = await listAuditFiles(directory);
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const removableFiles = files
    .filter((file) => resolve(file.path) !== normalizedCurrentFile)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);

  for (const file of removableFiles) {
    if (totalBytes <= config.maxBytes) {
      break;
    }
    if (await removeAuditFile(file.path)) {
      totalBytes -= file.size;
    }
  }
}
async function workspaceIdentifier(workspaceRoot: string): Promise<string> {
  let canonicalPath = resolve(workspaceRoot);
  try {
    canonicalPath = await realpath(canonicalPath);
  } catch {
    // The resolved lexical path is sufficient if the workspace disappears.
  }
  const normalizedPath = canonicalPath.replaceAll('\\', '/');
  const hashInput = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  return createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
}

function baseAuditRecord(event: AgentEvent, workspaceId: string): AuditEnvelope {
  return {
    schemaVersion: event.schemaVersion,
    sessionId: event.sessionId,
    turnId: event.turnId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    workspaceId,
    type: event.type
  };
}

export function toAuditRecord(event: AgentEvent, workspaceId: string): AuditEnvelope | undefined {
  const base = baseAuditRecord(event, workspaceId);
  switch (event.type) {
    case 'turn_started':
      return {
        ...base,
        provider: event.provider.name,
        model: event.provider.model,
        mode: event.mode
      };
    case 'phase_changed':
      return { ...base, phase: event.phase };
    case 'provider_request_started':
      return {
        ...base,
        provider: event.provider,
        model: event.model,
        attempt: event.attempt,
        attemptId: event.attemptId,
        ...(event.purpose ? { purpose: event.purpose } : {})
      };
    case 'provider_request_failed':
      return {
        ...base,
        provider: event.provider,
        model: event.model,
        attempt: event.attempt,
        attemptId: event.attemptId,
        durationMs: event.durationMs,
        willRetry: event.willRetry,
        ...(event.purpose ? { purpose: event.purpose } : {}),
        error: {
          code: event.error.code,
          ...(event.error.status === undefined ? {} : { status: event.error.status }),
          ...(event.error.requestId ? { requestId: event.error.requestId } : {})
        }
      };
    case 'provider_request_completed':
      return {
        ...base,
        provider: event.provider,
        model: event.model,
        attempt: event.attempt,
        attemptId: event.attemptId,
        durationMs: event.durationMs,
        finishReason: event.finishReason,
        requestId: event.requestId,
        reportedModel: event.reportedModel,
        ...(event.purpose ? { purpose: event.purpose } : {})
      };
    case 'retry_scheduled':
      return {
        ...base,
        attempt: event.attempt,
        nextAttempt: event.nextAttempt,
        delayMs: event.delayMs,
        reason: event.reason,
        ...(event.purpose ? { purpose: event.purpose } : {})
      };
    case 'usage_updated':
      return {
        ...base,
        attempt: event.attempt,
        attemptId: event.attemptId,
        usage: event.usage,
        cumulativeUsage: event.cumulativeUsage,
        ...(event.purpose ? { purpose: event.purpose } : {})
      };
    case 'context_usage_updated':
      return {
        ...base,
        inputTokens: event.inputTokens,
        contextWindowTokens: event.contextWindowTokens,
        triggerTokens: event.triggerTokens,
        source: event.source
      };
    case 'context_resolved':
      return {
        ...base,
        referenceType: event.referenceType,
        byteCount: event.byteCount,
        ...(event.lineStart === undefined
          ? {}
          : { lineStart: event.lineStart, lineEnd: event.lineEnd }),
        truncated: event.truncated
      };
    case 'context_failed':
      return { ...base, referenceType: event.referenceType, code: event.code };
    case 'instructions_loaded':
      return {
        ...base,
        source: event.source,
        byteCount: event.byteCount,
        truncated: event.truncated
      };
    case 'skill_activated':
      return {
        ...base,
        skill: event.skill,
        activation: event.activation,
        byteCount: event.byteCount
      };
    case 'skill_failed':
      return {
        ...base,
        skill: event.skill,
        activation: event.activation,
        code: event.code
      };
    case 'rag_index_started':
      return { ...base, collection: event.collection, operation: event.operation };
    case 'rag_index_progress':
      return {
        ...base,
        collection: event.collection,
        stage: event.stage,
        completed: event.completed,
        ...(event.total === undefined ? {} : { total: event.total })
      };
    case 'rag_index_completed':
      return {
        ...base,
        collection: event.collection,
        revision: event.revision,
        fileCount: event.fileCount,
        chunkCount: event.chunkCount,
        vectorState: event.vectorState,
        durationMs: event.durationMs
      };
    case 'rag_index_failed':
      return {
        ...base,
        collection: event.collection,
        operation: event.operation,
        code: event.code,
        durationMs: event.durationMs
      };
    case 'rag_retrieval_started':
      return {
        ...base,
        queryCount: event.queryCount,
        collectionCount: event.collectionCount
      };
    case 'rag_retrieval_completed':
      return {
        ...base,
        candidateCount: event.candidateCount,
        resultCount: event.resultCount,
        channels: event.channels,
        staleCollections: event.staleCollections,
        durationMs: event.durationMs
      };
    case 'rag_retrieval_failed':
      return { ...base, code: event.code, durationMs: event.durationMs };
    case 'rag_verification_started':
      return { ...base, citationCount: event.citationCount };
    case 'rag_verification_completed':
      return {
        ...base,
        outcome: event.outcome,
        citationCount: event.citationCount,
        invalidCitationCount: event.invalidCitationCount,
        durationMs: event.durationMs
      };
    case 'rag_verification_failed':
      return { ...base, code: event.code, durationMs: event.durationMs };
    case 'compaction_started':
      return {
        ...base,
        reason: event.reason,
        mode: event.mode,
        beforeTokens: event.beforeTokens,
        contextWindowTokens: event.contextWindowTokens
      };
    case 'compaction_completed':
      return {
        ...base,
        reason: event.reason,
        mode: event.mode,
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        messagesCompacted: event.messagesCompacted,
        durationMs: event.durationMs
      };
    case 'compaction_failed':
      return {
        ...base,
        reason: event.reason,
        mode: event.mode,
        durationMs: event.durationMs,
        recoverable: event.recoverable,
        error: {
          code: event.error.code,
          ...(event.error.provider ? { provider: event.error.provider } : {}),
          ...(event.error.status === undefined ? {} : { status: event.error.status }),
          ...(event.error.requestId ? { requestId: event.error.requestId } : {})
        }
      };
    case 'approval_resolved':
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        choice: event.choice,
        resolution: event.resolution
      };
    case 'user_input_requested':
      return {
        ...base,
        requestId: event.requestId,
        questionCount: event.questionCount,
        questionKinds: event.questionKinds
      };
    case 'user_input_resolved':
      return {
        ...base,
        requestId: event.requestId,
        questionCount: event.questionCount,
        durationMs: event.durationMs,
        outcome: event.outcome
      };
    case 'tool_completed':
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        outcome: event.outcome,
        durationMs: event.durationMs
      };
    case 'mcp_server_status':
      return {
        ...base,
        server: event.server,
        source: event.source,
        transport: event.transport,
        state: event.state,
        toolCount: event.toolCount,
        ...(event.negotiatedProtocolVersion
          ? { negotiatedProtocolVersion: event.negotiatedProtocolVersion }
          : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {})
      };
    case 'hook_started':
      return {
        ...base,
        hook: event.hook,
        event: event.event,
        source: event.source
      };
    case 'hook_completed':
      return {
        ...base,
        hook: event.hook,
        event: event.event,
        source: event.source,
        outcome: event.outcome,
        durationMs: event.durationMs,
        ...(event.errorCode ? { errorCode: event.errorCode } : {})
      };
    case 'subagent_completed':
      return {
        ...base,
        role: event.role,
        outcome: event.outcome,
        durationMs: event.durationMs,
        toolCalls: event.toolCalls,
        ...(event.providerCalls === undefined ? {} : { providerCalls: event.providerCalls }),
        ...(event.stopReason ? { stopReason: event.stopReason } : {}),
        ...(event.reportTruncated === undefined ? {} : { reportTruncated: event.reportTruncated }),
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {})
      };
    case 'turn_completed':
      return {
        ...base,
        durationMs: event.durationMs,
        finishReason: event.finishReason,
        usage: event.usage
      };
    case 'turn_failed':
      return {
        ...base,
        durationMs: event.durationMs,
        error: {
          code: event.error.code,
          ...(event.error.provider ? { provider: event.error.provider } : {}),
          ...(event.error.status === undefined ? {} : { status: event.error.status }),
          ...(event.error.requestId ? { requestId: event.error.requestId } : {})
        }
      };
    case 'turn_cancelled':
      return { ...base, durationMs: event.durationMs };
    default:
      return undefined;
  }
}

export class LocalAuditLogger implements AgentEventSink {
  private enabled: boolean;
  private pending: Promise<void>;
  private hasWarned = false;
  private workspaceId = '';
  private readonly filePath: string;
  private readonly warn: (message: string) => void;

  constructor(options: AuditLoggerOptions) {
    this.enabled = options.config.retentionDays > 0;
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    const now = options.now?.() ?? Date.now();
    const date = new Date(now);
    const baseDirectory = options.baseDirectory ?? join(homedir(), '.syzzz-code', 'audit');
    this.filePath = join(
      baseDirectory,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
      `${options.sessionId}.jsonl`
    );

    this.pending = this.enabled ? this.initialize(baseDirectory, options) : Promise.resolve();
  }

  record(event: AgentEvent): void {
    if (!this.enabled) {
      return;
    }

    this.pending = this.pending
      .then(async () => {
        if (!this.enabled) {
          return;
        }
        const record = toAuditRecord(event, this.workspaceId);
        if (!record) {
          return;
        }
        await appendFile(this.filePath, `${JSON.stringify(record)}\n`, {
          encoding: 'utf8',
          mode: 0o600
        });
      })
      .catch((error) => {
        this.disableWithWarning(error);
      });
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  getFilePath(): string {
    return this.filePath;
  }

  private async initialize(baseDirectory: string, options: AuditLoggerOptions): Promise<void> {
    try {
      this.workspaceId = await workspaceIdentifier(options.workspaceRoot);
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await cleanupAuditDirectory(
        baseDirectory,
        options.config,
        this.filePath,
        options.now?.() ?? Date.now()
      );
    } catch (error) {
      this.disableWithWarning(error);
    }
  }

  private disableWithWarning(error: unknown): void {
    this.enabled = false;
    if (this.hasWarned) {
      return;
    }
    this.hasWarned = true;
    const reason = error instanceof Error ? error.message : String(error);
    this.warn(`Warning: local audit logging disabled after a write failure: ${reason}`);
  }
}
