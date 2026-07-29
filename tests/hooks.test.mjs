import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { QueryEngine } from '../dist/engine.js';
import { HookRunner } from '../dist/extensions/hooks.js';

function resolvedHook({
  name,
  event,
  code,
  args = [],
  source = 'user',
  matcher,
  timeoutMs = 1_000,
  onError = 'continue',
  env = {}
}) {
  return {
    source,
    trusted: true,
    config: {
      name,
      event,
      command: process.execPath,
      args: ['-e', code, ...args],
      ...(matcher ? { matcher } : {}),
      timeoutMs,
      onError,
      env,
      enabled: true
    }
  };
}

function invocation(event, workspaceRoot, overrides = {}) {
  return {
    event,
    context: {
      sessionId: 'session-hooks',
      turnId: 'turn-hooks',
      mode: 'code',
      permissionMode: 'safe'
    },
    workspaceRoot,
    timestamp: '2026-07-28T00:00:00.000Z',
    payload: {},
    ...overrides
  };
}

async function collectGenerator(generator) {
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
  const directory = await mkdtemp(path.join(tmpdir(), 'syzzz-hooks-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Hooks execute in configured user-then-project order', async () => {
  await withTempDirectory(async directory => {
    const output = path.join(directory, 'order.txt');
    const code =
      "require('node:fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')";
    const runner = new HookRunner([
      resolvedHook({
        name: 'user-first',
        event: 'PreTurn',
        code,
        args: [output, 'user'],
        source: 'user'
      }),
      resolvedHook({
        name: 'project-second',
        event: 'PreTurn',
        code,
        args: [output, 'project'],
        source: 'project'
      })
    ]);

    const { events, result } = await collectGenerator(
      runner.run(invocation('PreTurn', directory), new AbortController().signal)
    );

    assert.equal(result.decision, 'continue');
    assert.equal(await readFile(output, 'utf8'), 'user\nproject\n');
    assert.deepEqual(events.map(event => event.type), [
      'hook_started',
      'hook_completed',
      'hook_started',
      'hook_completed'
    ]);
  });
});

test('PreToolUse matcher can deny an operation and cannot modify its input', async () => {
  await withTempDirectory(async directory => {
    const runner = new HookRunner([
      resolvedHook({
        name: 'block-shell',
        event: 'PreToolUse',
        matcher: 'builtin:Shell',
        code: "process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked by policy'}))"
      })
    ]);

    const skipped = await collectGenerator(runner.run(
      invocation('PreToolUse', directory, {
        subject: 'builtin:Read',
        payload: { input: { path: 'README.md' } }
      }),
      new AbortController().signal
    ));
    assert.equal(skipped.events.length, 0);

    const denied = await collectGenerator(runner.run(
      invocation('PreToolUse', directory, {
        subject: 'builtin:Shell',
        payload: { input: { command: 'echo original' } }
      }),
      new AbortController().signal
    ));
    assert.equal(denied.result.decision, 'deny');
    assert.equal(denied.result.reason, 'blocked by policy');
    assert.equal(denied.events.at(-1).outcome, 'denied');
  });
});

test('compaction and subagent Hooks are passive, match subjects, and expose status', async () => {
  await withTempDirectory(async directory => {
    const output = path.join(directory, 'passive.jsonl');
    const code = [
      "let input='';",
      "process.stdin.on('data',chunk=>input+=chunk);",
      "process.stdin.on('end',()=>{",
      "require('node:fs').appendFileSync(process.argv[1],input);",
      "process.stdout.write(JSON.stringify({decision:'deny'}));",
      "});"
    ].join('');
    const events = [
      ['pre-compact', 'PreCompact', 'manual'],
      ['post-compact', 'PostCompact', 'manual'],
      ['subagent-start', 'SubagentStart', 'explore'],
      ['subagent-stop', 'SubagentStop', 'explore']
    ];
    const runner = new HookRunner(events.map(([name, event, matcher]) =>
      resolvedHook({
        name,
        event,
        matcher,
        code,
        args: [output]
      })
    ));

    for (const [, event, subject] of events) {
      const run = await collectGenerator(runner.run(
        invocation(event, directory, {
          subject,
          payload: event.includes('Compact')
            ? { reason: subject, beforeTokens: 10, afterTokens: 5 }
            : {
                subagentId: 'bounded-id',
                role: subject,
                outcome: 'success',
                toolCalls: 2
              }
        }),
        new AbortController().signal
      ));
      assert.equal(run.result.decision, 'continue');
      assert.equal(run.events.at(-1).outcome, 'success');
    }

    const payloads = (await readFile(output, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.deepEqual(
      payloads.map(entry => entry.event),
      events.map(([, event]) => event)
    );
    assert.equal(JSON.stringify(payloads).includes('summary'), false);
    assert.equal(JSON.stringify(payloads).includes('report'), false);
    const status = runner.getStatus();
    assert.equal(status.entries.length, 4);
    assert.equal(status.entries.every(entry =>
      entry.lastOutcome === 'success' &&
      typeof entry.lastDurationMs === 'number'
    ), true);
  });
});

test('Hook failures continue by default and fail closed only when configured', async () => {
  await withTempDirectory(async directory => {
    const failingCode = 'process.exitCode=9';
    const continuing = new HookRunner([
      resolvedHook({
        name: 'advisory',
        event: 'PreToolUse',
        code: failingCode
      })
    ]);
    const continued = await collectGenerator(continuing.run(
      invocation('PreToolUse', directory, { subject: 'builtin:Read' }),
      new AbortController().signal
    ));
    assert.equal(continued.result.decision, 'continue');
    assert.equal(continued.events.at(-1).errorCode, 'nonzero_exit');

    const denying = new HookRunner([
      resolvedHook({
        name: 'required-policy',
        event: 'PreToolUse',
        code: failingCode,
        onError: 'deny'
      })
    ]);
    const denied = await collectGenerator(denying.run(
      invocation('PreToolUse', directory, { subject: 'builtin:Read' }),
      new AbortController().signal
    ));
    assert.equal(denied.result.decision, 'deny');
    assert.match(denied.result.reason, /failed closed/);
  });
});

test('Hook timeout and output limits terminate the child process safely', async () => {
  await withTempDirectory(async directory => {
    const timeoutRunner = new HookRunner([
      resolvedHook({
        name: 'slow',
        event: 'PreTurn',
        code: 'setTimeout(()=>{},10_000)',
        timeoutMs: 50
      })
    ]);
    const timedOut = await collectGenerator(timeoutRunner.run(
      invocation('PreTurn', directory),
      new AbortController().signal
    ));
    assert.equal(timedOut.result.decision, 'continue');
    assert.equal(timedOut.events.at(-1).outcome, 'timeout');

    const noisyRunner = new HookRunner([
      resolvedHook({
        name: 'noisy',
        event: 'PreTurn',
        code: "process.stdout.write('x'.repeat(17*1024))"
      })
    ]);
    const limited = await collectGenerator(noisyRunner.run(
      invocation('PreTurn', directory),
      new AbortController().signal
    ));
    assert.equal(limited.events.at(-1).errorCode, 'output_limit');
  });
});

test('Hook environment omits ambient credentials and resolves explicit templates', async () => {
  await withTempDirectory(async directory => {
    const output = path.join(directory, 'environment.json');
    const previousSecret = process.env.TEST_PROVIDER_API_KEY;
    const previousSafeSource = process.env.HOOK_SAFE_SOURCE;
    process.env.TEST_PROVIDER_API_KEY = 'must-not-leak';
    process.env.HOOK_SAFE_SOURCE = 'explicit-value';
    try {
      const runner = new HookRunner([
        resolvedHook({
          name: 'environment',
          event: 'PreTurn',
          code:
            "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({" +
            "secret:process.env.TEST_PROVIDER_API_KEY,safe:process.env.SAFE_TEST}))",
          args: [output],
          env: { SAFE_TEST: '${HOOK_SAFE_SOURCE}' }
        })
      ]);
      await collectGenerator(runner.run(
        invocation('PreTurn', directory),
        new AbortController().signal
      ));
      const captured = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(captured.secret, undefined);
      assert.equal(captured.safe, 'explicit-value');

      const blockedOutput = path.join(directory, 'blocked-environment.json');
      const blockedRunner = new HookRunner([
        resolvedHook({
          name: 'blocked-environment',
          event: 'PreTurn',
          code:
            "require('node:fs').writeFileSync(process.argv[1]," +
            "JSON.stringify({leaked:process.env.LEAKED_KEY}))",
          args: [blockedOutput],
          env: { LEAKED_KEY: '${TEST_PROVIDER_API_KEY}' }
        })
      ], ['TEST_PROVIDER_API_KEY']);
      const blocked = await collectGenerator(blockedRunner.run(
        invocation('PreTurn', directory),
        new AbortController().signal
      ));
      assert.equal(blocked.events.at(-1).errorCode, 'execution_error');
      await assert.rejects(readFile(blockedOutput, 'utf8'), /ENOENT/);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.TEST_PROVIDER_API_KEY;
      } else {
        process.env.TEST_PROVIDER_API_KEY = previousSecret;
      }
      if (previousSafeSource === undefined) {
        delete process.env.HOOK_SAFE_SOURCE;
      } else {
        process.env.HOOK_SAFE_SOURCE = previousSafeSource;
      }
    }
  });
});

function providerInfo() {
  return {
    name: 'Hook Fixture',
    type: 'fixture',
    model: 'fixture',
    capabilities: { streaming: false, reasoningToggle: false }
  };
}

function toolProvider() {
  let call = 0;
  return {
    async chat() {
      call += 1;
      return call === 1
        ? {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'fixture-call',
                name: 'Fixture',
                input: { value: 'original-input' }
              }]
            }
          }
        : { message: { role: 'assistant', content: 'done' } };
    },
    getInfo: providerInfo
  };
}

function fakeExtensionRuntime(hooks) {
  return {
    hooks,
    getStatus() {
      return {
        workspaceTrusted: false,
        projectConfigurationPresent: false,
        mcp: { configured: 0, ready: 0, servers: [] },
        hooks: hooks.getStatus(),
        subagents: { enabled: false, available: false },
        warnings: []
      };
    },
    async close() {}
  };
}

test('Engine runs PreToolUse before approval and fullAccess cannot bypass a denial', async () => {
  await withTempDirectory(async directory => {
    let executions = 0;
    const hooks = new HookRunner([
      resolvedHook({
        name: 'deny-fixture',
        event: 'PreToolUse',
        matcher: 'builtin:Fixture',
        code: "process.stdout.write(JSON.stringify({decision:'deny',reason:'fixture denied'}))"
      })
    ]);
    const engine = new QueryEngine({
      provider: toolProvider(),
      tools: [{
        name: 'Fixture',
        description: 'fixture',
        risk: 'execute',
        approval: 'always',
        inputSchema: z.object({ value: z.string() }),
        async execute() {
          executions += 1;
          return { content: 'should not run' };
        }
      }],
      workspaceRoot: directory,
      mode: 'code',
      permissionMode: 'fullAccess',
      extensions: fakeExtensionRuntime(hooks),
      audit: false
    });

    const { events, result } = await collectGenerator(engine.runTurn('run'));
    assert.equal(result.status, 'completed');
    assert.equal(executions, 0);
    assert.equal(events.some(event => event.type === 'approval_requested'), false);
    const completed = events.find(event => event.type === 'tool_completed');
    assert.equal(completed.outcome, 'denied');
    assert.equal(completed.metadata.reason, 'hook-policy');
    assert.match(completed.result, /fixture denied/);
    const providerToolMessage = engine.getMessages().find(message =>
      message.role === 'tool' && message.toolName === 'Fixture'
    );
    assert.equal(
      providerToolMessage.content,
      'Tool execution denied by a local Hook policy. This denial is ' +
      'definitive for the current turn; do not retry it or attempt an ' +
      'equivalent side effect with another tool.'
    );
    assert.doesNotMatch(providerToolMessage.content, /fixture denied/);
  });
});

test('a Hook denial closes later tools and forces an accurate no-tool response', async () => {
  await withTempDirectory(async directory => {
    let shellExecutions = 0;
    let writeExecutions = 0;
    const requests = [];
    const hooks = new HookRunner([
      resolvedHook({
        name: 'block-shell',
        event: 'PreToolUse',
        matcher: 'builtin:Shell',
        code: "process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked'}))"
      })
    ]);
    const provider = {
      async chat(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'blocked-shell',
                  name: 'Shell',
                  input: { value: 'first' }
                },
                {
                  id: 'write-bypass',
                  name: 'Write',
                  input: { value: 'second' }
                }
              ]
            }
          };
        }
        return {
          message: {
            role: 'assistant',
            content: 'The Hook denied the requested operation.'
          }
        };
      },
      getInfo() {
        return {
          name: 'Hook fixture',
          type: 'fixture',
          model: 'fixture-model',
          capabilities: { streaming: false, reasoningToggle: false }
        };
      }
    };
    const makeTool = (name, execute) => ({
      name,
      description: name,
      risk: name === 'Write' ? 'write' : 'execute',
      approval: 'always',
      inputSchema: z.object({ value: z.string() }),
      execute
    });
    const engine = new QueryEngine({
      provider,
      tools: [
        makeTool('Shell', async () => {
          shellExecutions += 1;
          return { content: 'shell ran' };
        }),
        makeTool('Write', async () => {
          writeExecutions += 1;
          return { content: 'write ran' };
        })
      ],
      workspaceRoot: directory,
      mode: 'code',
      permissionMode: 'fullAccess',
      extensions: fakeExtensionRuntime(hooks),
      audit: false
    });

    const { events, result } = await collectGenerator(engine.runTurn('run'));
    assert.equal(result.status, 'completed');
    assert.equal(shellExecutions, 0);
    assert.equal(writeExecutions, 0);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].tools, []);
    assert.match(requests[1].systemPrompt, /do not retry it/i);
    const completions = events.filter(event => event.type === 'tool_completed');
    assert.equal(completions.length, 2);
    assert.equal(completions[0].metadata.reason, 'hook-policy');
    assert.equal(
      completions[1].metadata.reason,
      'turn-tool-access-closed'
    );
  });
});

test('PostToolUse receives outcome metadata without the raw tool result', async () => {
  await withTempDirectory(async directory => {
    const capture = path.join(directory, 'post.json');
    const hooks = new HookRunner([
      resolvedHook({
        name: 'capture-post',
        event: 'PostToolUse',
        matcher: 'builtin:Fixture',
        code:
          "let s='';process.stdin.on('data',c=>s+=c);" +
          "process.stdin.on('end',()=>require('node:fs').writeFileSync(process.argv[1],s))",
        args: [capture]
      })
    ]);
    const engine = new QueryEngine({
      provider: toolProvider(),
      tools: [{
        name: 'Fixture',
        description: 'fixture',
        risk: 'read',
        approval: 'never',
        inputSchema: z.object({ value: z.string() }),
        async execute() {
          return {
            content: 'RAW_TOOL_SECRET',
            metadata: {
              path: 'secret/path',
              output: 'RAW_METADATA_SECRET',
              versionHash: 'abc123',
              itemCount: 2
            }
          };
        }
      }],
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(hooks),
      audit: false
    });

    const { result } = await collectGenerator(engine.runTurn('run'));
    assert.equal(result.status, 'completed');
    const captured = JSON.parse(await readFile(capture, 'utf8'));
    const serialized = JSON.stringify(captured);
    assert.equal(serialized.includes('RAW_TOOL_SECRET'), false);
    assert.equal(serialized.includes('RAW_METADATA_SECRET'), false);
    assert.equal(serialized.includes('secret/path'), false);
    assert.equal(captured.payload.outcome, 'success');
    assert.equal(captured.payload.metadata.versionHash, 'abc123');
    assert.equal(captured.payload.metadata.itemCount, 2);
  });
});

test('terminal Hook events occur before the unique terminal AgentEvent', async () => {
  await withTempDirectory(async directory => {
    const hooks = new HookRunner([
      resolvedHook({
        name: 'completed-observer',
        event: 'TurnCompleted',
        code: ''
      })
    ]);
    const provider = {
      async chat() {
        return { message: { role: 'assistant', content: 'done' } };
      },
      getInfo: providerInfo
    };
    const engine = new QueryEngine({
      provider,
      tools: [],
      workspaceRoot: directory,
      extensions: fakeExtensionRuntime(hooks),
      audit: false
    });

    const { events, result } = await collectGenerator(engine.runTurn('hello'));
    assert.equal(result.status, 'completed');
    assert.equal(events.at(-1).type, 'turn_completed');
    assert.equal(events.filter(event =>
      ['turn_completed', 'turn_failed', 'turn_cancelled'].includes(event.type)
    ).length, 1);
    const hookCompletedIndex = events.findIndex(event =>
      event.type === 'hook_completed' && event.event === 'TurnCompleted'
    );
    assert.ok(hookCompletedIndex >= 0);
    assert.ok(hookCompletedIndex < events.length - 1);
  });
});
