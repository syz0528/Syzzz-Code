import type { AgentEvent } from '../events.js';
import { QueryEngine } from '../runtime-engine.js';
import type { AIProvider, ProviderUsage } from '../providers/base.js';
import { OperationAbortedError, throwIfAborted } from '../tools/abort.js';
import { TaskCompositionRuntime } from './runtime.js';
import { readSkillActivationEval } from './skill-authoring.js';
import type { SkillDescriptor } from './types.js';

export interface SkillActivationEvalCaseResult {
  id: string;
  expected: 'activate' | 'not-activate';
  actual: 'activate' | 'not-activate';
  passed: boolean;
  provider: string;
  model: string;
  durationMs: number;
  usage?: ProviderUsage;
  infrastructureError?: string;
}

export interface SkillActivationEvalReport {
  schemaVersion: 1;
  skill: string;
  provider: string;
  model: string;
  passed: number;
  failed: number;
  infrastructureFailures: number;
  cases: SkillActivationEvalCaseResult[];
}

export async function runSkillActivationEval(options: {
  descriptor: SkillDescriptor;
  workspaceRoot: string;
  homeDirectory?: string;
  providerFactory: () => AIProvider;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<SkillActivationEvalReport> {
  const evaluation = await readSkillActivationEval(options.descriptor);
  const results: SkillActivationEvalCaseResult[] = [];
  for (const testCase of evaluation.cases) {
    throwIfAborted(options.signal);
    const provider = options.providerFactory();
    const providerInfo = provider.getInfo();
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: options.workspaceRoot,
      ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
      skills: {
        enabled: true,
        allowImplicit: true,
        disabled: []
      },
      skillAllowlist: [options.descriptor.name]
    });
    const activateSkill = runtime.getTools().find((tool) => tool.name === 'ActivateSkill');
    if (!activateSkill) {
      throw new Error('ActivateSkill tool is unavailable');
    }
    const engine = new QueryEngine({
      provider,
      workspaceRoot: options.workspaceRoot,
      mode: 'ask',
      permissionMode: 'safe',
      composition: runtime,
      tools: [activateSkill],
      maxToolRounds: 3
    });
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('Skill activation eval case timed out')),
      options.timeoutMs ?? 60_000
    );
    timeout.unref?.();
    const startedAt = Date.now();
    let activated = false;
    let usage: ProviderUsage | undefined;
    let infrastructureError: string | undefined;
    try {
      const turn = engine.runTurn(testCase.prompt, { signal: controller.signal });
      while (true) {
        const next = await turn.next();
        if (next.done) {
          if (next.value.status !== 'completed') {
            infrastructureError =
              next.value.status === 'failed'
                ? next.value.error.code
                : options.signal.aborted
                  ? 'cancelled'
                  : 'timeout';
          }
          break;
        }
        const event: AgentEvent = next.value;
        if (
          event.type === 'skill_activated' &&
          event.skill === options.descriptor.name &&
          event.activation === 'implicit'
        ) {
          activated = true;
        }
        if (event.type === 'usage_updated') {
          usage = event.cumulativeUsage;
        }
      }
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', forwardAbort);
    }
    if (options.signal.aborted) {
      throw new OperationAbortedError('Skill activation eval cancelled');
    }
    const actual = activated ? 'activate' : 'not-activate';
    results.push({
      id: testCase.id,
      expected: testCase.expect,
      actual,
      passed: !infrastructureError && actual === testCase.expect,
      provider: providerInfo.name,
      model: providerInfo.model,
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
      ...(infrastructureError ? { infrastructureError } : {})
    });
  }
  const first = results[0];
  return {
    schemaVersion: 1,
    skill: options.descriptor.name,
    provider: first?.provider ?? 'unknown',
    model: first?.model ?? 'unknown',
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed && !result.infrastructureError).length,
    infrastructureFailures: results.filter((result) => result.infrastructureError).length,
    cases: results
  };
}
