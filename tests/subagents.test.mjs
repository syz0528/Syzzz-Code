import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QueryEngine } from '../dist/engine.js';
import { HookRunner } from '../dist/extensions/hooks.js';
import {
  createBoundedSubagentProvider,
  createSubagentToolSet,
  SUBAGENT_CONTEXT_WINDOW_TOKENS,
  SUBAGENT_MAX_REPORT_BYTES
} from '../dist/subagents.js';

function info() {
  return {
    name: 'Subagent Fixture',
    type: 'fixture',
    model: 'fixture-model',
    contextWindowTokens: 65_536,
    capabilities: { streaming: false, reasoningToggle: false }
  };
}

function fakeExtensionRuntime(enabled = true, hooks) {
  let supported = false;
  let configured = enabled;
  return {
    hooks,
    mcp: undefined,
    supportsSubagents() {
      return supported;
    },
    canRunSubagents() {
      return supported && configured;
    },
    setSubagentsAvailable(value) {
      supported = value;
    },
    setSubagentsEnabled(value) {
      configured = value;
    },
    getStatus() {
      return {
        workspaceTrusted: false,
        projectConfigurationPresent: false,
        mcp: { configured: 0, ready: 0, servers: [] },
        hooks: { configured: 0, enabled: 0 },
        subagents: {
          enabled: configured,
          available: supported && configured
        },
        warnings: []
      };
    },
    async close() {}
  };
}

async function collect(generator) {
  const events = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'syzzz-subagent-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function delegatingProvider({
  role = 'explore',
  task = 'Inspect the architecture',
  childResponse = 'bounded child report',
  childUsage = { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  onChildRequest
} = {}) {
  let parentCalls = 0;
  let forks = 0;
  const provider = {
    async chat() {
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'delegate-1',
                name: 'Delegate',
                input: { role, task }
              }
            ]
          },
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
        };
      }
      return {
        message: { role: 'assistant', content: 'parent done' },
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
      };
    },
    getInfo: info,
    fork() {
      forks += 1;
      return {
        async chat(request) {
          onChildRequest?.(request);
          return {
            message: { role: 'assistant', content: childResponse },
            usage: childUsage
          };
        },
        getInfo: info
      };
    }
  };
  return {
    provider,
    getForks: () => forks
  };
}

test('subagent Provider context is capped at 32K without exposing fork()', () => {
  const provider = {
    async chat() {
      return { message: { role: 'assistant', content: 'ok' } };
    },
    getInfo: info,
    fork() {
      return this;
    }
  };
  const bounded = createBoundedSubagentProvider(provider);
  assert.equal(bounded.getInfo().contextWindowTokens, SUBAGENT_CONTEXT_WINDOW_TOKENS);
  assert.equal(bounded.fork, undefined);
});

test('explore and review subagents expose only their bounded read-only tools', () => {
  assert.deepEqual(
    createSubagentToolSet('explore').map((tool) => tool.name),
    ['Glob', 'Grep', 'ListDirectory', 'Read', 'GitStatus', 'RepoMap']
  );
  assert.deepEqual(
    createSubagentToolSet('review').map((tool) => tool.name),
    ['Glob', 'Grep', 'ListDirectory', 'Read', 'GitStatus', 'RepoMap', 'GitDiff', 'Diagnostics']
  );
  for (const tool of createSubagentToolSet('review')) {
    assert.equal(tool.risk, 'read');
    assert.notEqual(tool.name, 'Delegate');
    assert.notEqual(tool.name, 'Shell');
    assert.notEqual(tool.name, 'Write');
  }
});

test('Delegate runs an isolated ask+safe child and aggregates usage', async () => {
  await withTempDirectory(async (directory) => {
    let childRequest;
    const fixture = delegatingProvider({
      role: 'explore',
      onChildRequest(request) {
        childRequest = request;
      }
    });
    const hooks = new HookRunner([
      {
        source: 'user',
        trusted: true,
        config: {
          name: 'subagent-start',
          event: 'SubagentStart',
          command: process.execPath,
          args: ['-e', ''],
          matcher: 'explore',
          timeoutMs: 1_000,
          onError: 'continue',
          env: {},
          enabled: true
        }
      },
      {
        source: 'user',
        trusted: true,
        config: {
          name: 'subagent-stop',
          event: 'SubagentStop',
          command: process.execPath,
          args: ['-e', ''],
          matcher: 'explore',
          timeoutMs: 1_000,
          onError: 'continue',
          env: {},
          enabled: true
        }
      }
    ]);
    const subagentHookInvocations = [];
    const runSubagentHook = hooks.run.bind(hooks);
    hooks.run = async function* (invocation, signal) {
      subagentHookInvocations.push(structuredClone(invocation));
      return yield* runSubagentHook(invocation, signal);
    };
    const engine = new QueryEngine({
      provider: fixture.provider,
      workspaceRoot: directory,
      mode: 'plan',
      permissionMode: 'fullAccess',
      extensions: fakeExtensionRuntime(true, hooks),
      audit: false
    });

    const { events, result } = await collect(engine.runTurn('delegate this'));

    assert.equal(result.status, 'completed');
    assert.equal(result.response, 'parent done');
    assert.deepEqual(result.usage, {
      inputTokens: 25,
      outputTokens: 4,
      totalTokens: 29
    });
    assert.deepEqual(
      childRequest.tools.map((tool) => tool.name),
      ['Glob', 'Grep', 'ListDirectory', 'Read', 'GitStatus', 'RepoMap']
    );
    assert.match(childRequest.systemPrompt, /Work mode: ask/);
    assert.match(childRequest.systemPrompt, /Permission mode: safe/);
    assert.match(childRequest.systemPrompt, /bounded read-only subagent/);
    assert.equal(fixture.getForks(), 1);
    assert.ok(
      events.some(
        (event) => event.type === 'provider_request_started' && event.purpose === 'subagent'
      )
    );
    const completed = events.find((event) => event.type === 'subagent_completed');
    assert.equal(completed.outcome, 'success');
    assert.equal(completed.stopReason, 'completed');
    assert.equal(completed.role, 'explore');
    assert.deepEqual(completed.usage, {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7
    });
    const ordered = events.map((event) =>
      event.type === 'hook_started' ? `${event.type}:${event.event}` : event.type
    );
    assert.ok(ordered.indexOf('subagent_started') < ordered.indexOf('hook_started:SubagentStart'));
    assert.ok(
      ordered.indexOf('hook_started:SubagentStart') < ordered.indexOf('subagent_completed')
    );
    assert.ok(ordered.indexOf('subagent_completed') < ordered.indexOf('hook_started:SubagentStop'));
    const subagentStartInvocation = subagentHookInvocations.find(
      (invocation) => invocation.event === 'SubagentStart'
    );
    const subagentStopInvocation = subagentHookInvocations.find(
      (invocation) => invocation.event === 'SubagentStop'
    );
    assert.deepEqual(subagentStartInvocation.payload, {
      role: 'explore'
    });
    assert.deepEqual(Object.keys(subagentStopInvocation.payload).sort(), [
      'durationMs',
      'outcome',
      'role',
      'stopReason',
      'toolCalls',
      'usage'
    ]);
    assert.deepEqual(engine.getStatus().totalUsage, result.usage);
  });
});

test('only a bounded child report enters parent history', async () => {
  await withTempDirectory(async (directory) => {
    const fixture = delegatingProvider({
      childResponse: 'x'.repeat(SUBAGENT_MAX_REPORT_BYTES * 2)
    });
    const engine = new QueryEngine({
      provider: fixture.provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false
    });

    const { result } = await collect(engine.runTurn('delegate'));
    assert.equal(result.status, 'completed');
    const toolMessage = engine
      .getMessages()
      .find((message) => message.role === 'tool' && message.toolName === 'Delegate');
    assert.ok(toolMessage);
    assert.ok(Buffer.byteLength(toolMessage.content, 'utf8') <= SUBAGENT_MAX_REPORT_BYTES);
    assert.match(toolMessage.content, /Subagent report truncated/);
    assert.equal(JSON.stringify(engine.exportState()).includes('x'.repeat(21_000)), false);
  });
});

test('a parent turn starts at most two subagents', async () => {
  await withTempDirectory(async (directory) => {
    let parentCalls = 0;
    let forks = 0;
    const provider = {
      async chat() {
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [1, 2, 3].map((index) => ({
                id: `delegate-${index}`,
                name: 'Delegate',
                input: {
                  role: 'explore',
                  task: `task ${index}`
                }
              }))
            }
          };
        }
        return { message: { role: 'assistant', content: 'done' } };
      },
      getInfo: info,
      fork() {
        forks += 1;
        return {
          async chat() {
            return { message: { role: 'assistant', content: 'report' } };
          },
          getInfo: info
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false
    });

    const { events, result } = await collect(engine.runTurn('three delegates'));
    assert.equal(result.status, 'completed');
    assert.equal(forks, 2);
    assert.equal(events.filter((event) => event.type === 'subagent_started').length, 2);
    const delegateCompletions = events.filter(
      (event) => event.type === 'tool_completed' && event.toolName === 'Delegate'
    );
    assert.equal(delegateCompletions.length, 3);
    assert.equal(delegateCompletions.at(-1).outcome, 'error');
    assert.match(delegateCompletions.at(-1).result, /at most 2/);
  });
});

test('disabled subagents are hidden and forged Delegate calls fail closed', async () => {
  await withTempDirectory(async (directory) => {
    let parentCalls = 0;
    let firstTools;
    let forks = 0;
    const provider = {
      async chat(request) {
        parentCalls += 1;
        if (parentCalls === 1) {
          firstTools = request.tools.map((tool) => tool.name);
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'forged-delegate',
                  name: 'Delegate',
                  input: { role: 'explore', task: 'forged' }
                }
              ]
            }
          };
        }
        return { message: { role: 'assistant', content: 'done' } };
      },
      getInfo: info,
      fork() {
        forks += 1;
        throw new Error('must not fork');
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(false),
      audit: false
    });

    const { events, result } = await collect(engine.runTurn('disabled'));
    assert.equal(result.status, 'completed');
    assert.equal(firstTools.includes('Delegate'), false);
    assert.equal(forks, 0);
    const completed = events.find(
      (event) => event.type === 'tool_completed' && event.toolName === 'Delegate'
    );
    assert.equal(completed.outcome, 'error');
    assert.match(completed.result, /disabled/);
  });
});

test('parent cancellation aborts the child and emits one cancelled subagent outcome', async () => {
  await withTempDirectory(async (directory) => {
    let notifyChildStarted;
    const childStarted = new Promise((resolve) => {
      notifyChildStarted = resolve;
    });
    let childAborted = false;
    let parentCalls = 0;
    const provider = {
      async chat() {
        parentCalls += 1;
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'cancel-delegate',
                name: 'Delegate',
                input: { role: 'review', task: 'wait' }
              }
            ]
          }
        };
      },
      getInfo: info,
      fork() {
        return {
          chat(request) {
            notifyChildStarted();
            return new Promise((resolve, reject) => {
              request.signal.addEventListener(
                'abort',
                () => {
                  childAborted = true;
                  reject(new Error('aborted'));
                },
                { once: true }
              );
            });
          },
          getInfo: info
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false
    });
    const controller = new AbortController();
    const collecting = collect(
      engine.runTurn('cancel child', {
        signal: controller.signal
      })
    );

    await childStarted;
    controller.abort(new Error('cancel parent'));
    const { events, result } = await collecting;
    assert.equal(result.status, 'cancelled');
    assert.equal(childAborted, true);
    const completed = events.filter((event) => event.type === 'subagent_completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].outcome, 'cancelled');
    assert.equal(events.at(-1).type, 'turn_cancelled');
  });
});

test('subagent closes tools and synthesizes after six tool rounds', async () => {
  await withTempDirectory(async (directory) => {
    let parentCalls = 0;
    let childCalls = 0;
    let finalChildRequest;
    const provider = {
      async chat() {
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'loop-delegate',
                  name: 'Delegate',
                  input: { role: 'explore', task: 'loop' }
                }
              ]
            }
          };
        }
        return { message: { role: 'assistant', content: 'done' } };
      },
      getInfo: info,
      fork() {
        return {
          async chat(request) {
            childCalls += 1;
            if (request.tools.length === 0) {
              finalChildRequest = request;
              return {
                message: {
                  role: 'assistant',
                  content: 'bounded final report'
                }
              };
            }
            return {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [
                  {
                    id: `list-${childCalls}`,
                    name: 'ListDirectory',
                    input: { path: '.' }
                  }
                ]
              }
            };
          },
          getInfo: info
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false
    });

    const { events, result } = await collect(engine.runTurn('loop child'));
    assert.equal(result.status, 'completed');
    assert.equal(childCalls, 7);
    const completed = events.find((event) => event.type === 'subagent_completed');
    assert.equal(completed.outcome, 'partial');
    assert.equal(completed.stopReason, 'tool-round-limit');
    assert.equal(completed.toolCalls, 6);
    assert.equal(completed.providerCalls, 7);
    assert.deepEqual(finalChildRequest.tools, []);
    assert.match(finalChildRequest.systemPrompt, /tool budget is now closed/i);
  });
});

test('subagent soft deadline reserves a final no-tool synthesis request', async () => {
  await withTempDirectory(async (directory) => {
    let clock = 0;
    let parentCalls = 0;
    let childCalls = 0;
    const provider = {
      async chat() {
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'soft-deadline-delegate',
                  name: 'Delegate',
                  input: { role: 'explore', task: 'bounded investigation' }
                }
              ]
            }
          };
        }
        return { message: { role: 'assistant', content: 'parent done' } };
      },
      getInfo: info,
      fork() {
        return {
          async chat(request) {
            childCalls += 1;
            if (request.tools.length === 0) {
              return {
                message: {
                  role: 'assistant',
                  content: 'soft deadline report'
                }
              };
            }
            clock += 50_000;
            return {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [
                  {
                    id: `soft-list-${childCalls}`,
                    name: 'ListDirectory',
                    input: { path: '.' }
                  }
                ]
              }
            };
          },
          getInfo: info
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false,
      now: () => clock
    });

    const { events, result } = await collect(engine.runTurn('soft deadline'));
    assert.equal(result.status, 'completed');
    assert.equal(childCalls, 3);
    const completed = events.find((event) => event.type === 'subagent_completed');
    assert.equal(completed.outcome, 'partial');
    assert.equal(completed.stopReason, 'soft-timeout');
    assert.equal(completed.toolCalls, 2);
  });
});

test('subagent tool-call budget closes tools and reserves one synthesis', async () => {
  await withTempDirectory(async (directory) => {
    let parentCalls = 0;
    let childCalls = 0;
    const provider = {
      async chat() {
        parentCalls += 1;
        return parentCalls === 1
          ? {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [
                  {
                    id: 'tool-budget-delegate',
                    name: 'Delegate',
                    input: { role: 'explore', task: 'bounded calls' }
                  }
                ]
              }
            }
          : { message: { role: 'assistant', content: 'parent done' } };
      },
      getInfo: info,
      fork() {
        return {
          async chat(request) {
            childCalls += 1;
            if (request.tools.length === 0) {
              return {
                message: {
                  role: 'assistant',
                  content: 'tool-call budget report'
                }
              };
            }
            return {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: Array.from({ length: 4 }, (_, index) => ({
                  id: `list-${childCalls}-${index}`,
                  name: 'ListDirectory',
                  input: { path: '.' }
                }))
              }
            };
          },
          getInfo: info
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false
    });

    const { events, result } = await collect(engine.runTurn('tool budget'));
    assert.equal(result.status, 'completed');
    const completed = events.find((event) => event.type === 'subagent_completed');
    assert.equal(completed.outcome, 'partial');
    assert.equal(completed.stopReason, 'tool-call-limit');
    assert.equal(completed.toolCalls, 16);
    assert.equal(completed.providerCalls, 6);
    assert.equal(childCalls, 6);
  });
});

test('subagent soft token budget reserves one final no-tool synthesis', async () => {
  await withTempDirectory(async (directory) => {
    let parentCalls = 0;
    let childCalls = 0;
    const childRequests = [];
    const provider = {
      async chat() {
        parentCalls += 1;
        return parentCalls === 1
          ? {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [
                  {
                    id: 'soft-token-delegate',
                    name: 'Delegate',
                    input: { role: 'explore', task: 'bounded token review' }
                  }
                ]
              }
            }
          : { message: { role: 'assistant', content: 'parent done' } };
      },
      getInfo: info,
      fork() {
        return {
          async chat(request) {
            childCalls += 1;
            childRequests.push(request);
            if (request.tools.length === 0) {
              return {
                message: {
                  role: 'assistant',
                  content: 'soft token budget report'
                },
                usage: {
                  inputTokens: 800,
                  outputTokens: 200,
                  totalTokens: 1_000
                }
              };
            }
            return {
              message: {
                role: 'assistant',
                content: 'Evidence gathered before token synthesis.',
                toolCalls: [
                  {
                    id: 'soft-token-status',
                    name: 'GitStatus',
                    input: {}
                  }
                ]
              },
              usage: {
                inputTokens: 95_000,
                outputTokens: 2_000,
                totalTokens: 97_000
              }
            };
          },
          getInfo: info
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false
    });

    const { events, result } = await collect(engine.runTurn('soft tokens'));
    assert.equal(result.status, 'completed');
    assert.equal(childCalls, 2);
    assert.equal(childRequests[0].tools.length > 0, true);
    assert.deepEqual(childRequests[1].tools, []);
    const completed = events.find((event) => event.type === 'subagent_completed');
    assert.equal(completed.outcome, 'partial');
    assert.equal(completed.stopReason, 'soft-token-limit');
    assert.equal(completed.toolCalls, 1);
    assert.equal(completed.providerCalls, 2);
  });
});

test('subagent hard token budget returns bounded partial evidence without tools', async () => {
  await withTempDirectory(async (directory) => {
    let parentCalls = 0;
    let childCalls = 0;
    const provider = {
      async chat() {
        parentCalls += 1;
        return parentCalls === 1
          ? {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [
                  {
                    id: 'token-budget-delegate',
                    name: 'Delegate',
                    input: { role: 'review', task: 'review safely' }
                  }
                ]
              }
            }
          : { message: { role: 'assistant', content: 'parent used partial' } };
      },
      getInfo: info,
      fork() {
        return {
          async chat() {
            childCalls += 1;
            return {
              message: {
                role: 'assistant',
                content: 'Partial evidence gathered before the hard stop.',
                toolCalls: [
                  {
                    id: 'blocked-after-hard-token',
                    name: 'GitStatus',
                    input: {}
                  }
                ]
              },
              usage: {
                inputTokens: 127_000,
                outputTokens: 2_000,
                totalTokens: 129_000
              }
            };
          },
          getInfo: info
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false
    });

    const { events, result } = await collect(engine.runTurn('hard budget'));
    assert.equal(result.status, 'completed');
    const completed = events.find((event) => event.type === 'subagent_completed');
    assert.equal(completed.outcome, 'partial');
    assert.equal(completed.stopReason, 'hard-token-limit');
    assert.equal(completed.toolCalls, 0);
    assert.equal(completed.providerCalls, 1);
    assert.equal(childCalls, 1);
    const delegateResult = events.find(
      (event) => event.type === 'tool_completed' && event.toolName === 'Delegate'
    );
    assert.match(delegateResult.result, /Partial evidence gathered/);
  });
});

test('a failed Delegate forces the parent to report without tool fallback', async () => {
  await withTempDirectory(async (directory) => {
    const parentRequests = [];
    let parentCalls = 0;
    const provider = {
      async chat(request) {
        parentRequests.push(request);
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'empty-delegate',
                  name: 'Delegate',
                  input: { role: 'review', task: 'return nothing' }
                }
              ]
            }
          };
        }
        return {
          message: {
            role: 'assistant',
            content: 'Delegation failed; no fallback was attempted.'
          }
        };
      },
      getInfo: info,
      fork() {
        return {
          async chat() {
            return { message: { role: 'assistant', content: '' } };
          },
          getInfo: info
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(true),
      audit: false
    });

    const { events, result } = await collect(engine.runTurn('delegate only'));
    assert.equal(result.status, 'completed');
    assert.equal(result.response, 'Delegation failed; no fallback was attempted.');
    assert.equal(parentRequests.length, 2);
    assert.deepEqual(parentRequests[1].tools, []);
    assert.match(parentRequests[1].systemPrompt, /do not retry delegation/i);
    const completed = events.find((event) => event.type === 'subagent_completed');
    assert.equal(completed.outcome, 'error');
    assert.equal(completed.errorCode, 'malformed_response');
  });
});
