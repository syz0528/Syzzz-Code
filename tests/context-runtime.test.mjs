import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ContextManager } from '../dist/context-manager.js';
import { QueryEngine } from '../dist/engine.js';
import { HookRunner } from '../dist/extensions/hooks.js';
import { ProviderError } from '../dist/providers/errors.js';

function providerInfo(contextWindowTokens = 65_536) {
  return {
    name: 'Context Test Provider',
    type: 'test',
    model: 'context-test-model',
    contextWindowTokens,
    capabilities: {
      streaming: false,
      reasoningToggle: false
    }
  };
}

async function collectTurn(turn) {
  const events = [];
  while (true) {
    const next = await turn.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

function smallContextOptions() {
  return {
    defaultWindowTokens: 2_500,
    triggerRatio: 0.85,
    targetRatio: 0.5,
    reservedOutputTokens: 256,
    minimumCompactableTokens: 20
  };
}

test('auto compaction summarizes old history without exposing summary text', async () => {
  let normalCalls = 0;
  let summaryCalls = 0;
  const provider = {
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        summaryCalls += 1;
        assert.deepEqual(request.tools, []);
        return {
          message: {
            role: 'assistant',
            content: 'The earlier turn supplied a large body of context.'
          },
          usage: { inputTokens: 800, outputTokens: 20, totalTokens: 820 }
        };
      }
      normalCalls += 1;
      return {
        message: {
          role: 'assistant',
          content: normalCalls === 1 ? 'Earlier answer '.repeat(400) : 'After compaction.'
        },
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: smallContextOptions()
  });

  await engine.chat('seed history');
  const { events, result } = await collectTurn(engine.runTurn('continue'));

  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'After compaction.');
  assert.equal(result.context.compactions, 1);
  assert.equal(summaryCalls, 1);
  assert.equal(events.filter((event) => event.type === 'compaction_started').length, 1);
  assert.equal(events.filter((event) => event.type === 'compaction_completed').length, 1);
  assert.equal(
    events.some(
      (event) => event.type === 'text_delta' && event.delta.includes('earlier turn supplied')
    ),
    false
  );
  assert.ok(
    events.some(
      (event) => event.type === 'provider_request_started' && event.purpose === 'compaction'
    )
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'context_usage_updated' &&
        event.source === 'reported' &&
        event.inputTokens === 100
    )
  );
  const completedCompaction = events.find((event) => event.type === 'compaction_completed');
  assert.ok(completedCompaction.afterTokens < completedCompaction.beforeTokens);
  assert.ok(
    engine
      .getMessages()
      .some((message) => message.role === 'user' && message.kind === 'compaction-summary')
  );
});

test('compaction and turn sampling share the Provider call budget', async () => {
  let normalCalls = 0;
  let summaryCalls = 0;
  const provider = {
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        summaryCalls += 1;
        return {
          message: {
            role: 'assistant',
            content: 'The earlier response contained bounded test context.'
          }
        };
      }
      normalCalls += 1;
      return {
        message: {
          role: 'assistant',
          content: 'Large answer '.repeat(500)
        }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    maxProviderCalls: 1,
    context: smallContextOptions()
  });

  await engine.chat('seed Provider budget history');
  const { events, result } = await collectTurn(engine.runTurn('continue'));

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'provider-call-limit');
  assert.equal(summaryCalls, 1);
  assert.equal(normalCalls, 1);
  assert.equal(
    events.filter(
      (event) => event.type === 'provider_request_started' && event.purpose === 'compaction'
    ).length,
    1
  );
  assert.equal(
    events.some((event) => event.type === 'provider_request_started' && event.purpose === 'turn'),
    false
  );
});

test('manual compaction emits manual events and commits only the reduced history', async () => {
  let normalCalls = 0;
  let summaryCalls = 0;
  const provider = {
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        summaryCalls += 1;
        return {
          message: {
            role: 'assistant',
            content: 'A compact summary of the earlier large response.'
          }
        };
      }
      normalCalls += 1;
      return {
        message: {
          role: 'assistant',
          content: 'Large answer '.repeat(500)
        }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const hooks = new HookRunner([
    {
      source: 'user',
      trusted: true,
      config: {
        name: 'before-compact',
        event: 'PreCompact',
        command: process.execPath,
        args: ['-e', ''],
        matcher: 'manual',
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
        name: 'after-compact',
        event: 'PostCompact',
        command: process.execPath,
        args: ['-e', ''],
        matcher: 'manual',
        timeoutMs: 1_000,
        onError: 'continue',
        env: {},
        enabled: true
      }
    }
  ]);
  const compactHookInvocations = [];
  const runCompactHook = hooks.run.bind(hooks);
  hooks.run = async function* (invocation, signal) {
    compactHookInvocations.push(structuredClone(invocation));
    return yield* runCompactHook(invocation, signal);
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    extensions: { hooks },
    context: smallContextOptions()
  });

  await engine.chat('seed manual compaction');
  const before = engine.getMessages();
  const { events, result } = await collectTurn(engine.compactContext());

  assert.equal(result.status, 'completed');
  assert.equal(result.compactions, 1);
  assert.equal(summaryCalls, 1);
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.ok(
    events.some((event) => event.type === 'compaction_started' && event.reason === 'manual')
  );
  assert.ok(
    events.some((event) => event.type === 'compaction_completed' && event.reason === 'manual')
  );
  const order = events.map((event) =>
    event.type === 'hook_started' ? `${event.type}:${event.event}` : event.type
  );
  assert.ok(order.indexOf('compaction_started') < order.indexOf('hook_started:PreCompact'));
  assert.ok(order.indexOf('hook_started:PreCompact') < order.indexOf('compaction_completed'));
  assert.ok(order.indexOf('compaction_completed') < order.indexOf('hook_started:PostCompact'));
  const preCompactInvocation = compactHookInvocations.find(
    (invocation) => invocation.event === 'PreCompact'
  );
  const postCompactInvocation = compactHookInvocations.find(
    (invocation) => invocation.event === 'PostCompact'
  );
  assert.deepEqual(Object.keys(preCompactInvocation.payload).sort(), [
    'beforeTokens',
    'passes',
    'reason'
  ]);
  assert.deepEqual(Object.keys(postCompactInvocation.payload).sort(), [
    'afterTokens',
    'beforeTokens',
    'durationMs',
    'passes',
    'reason'
  ]);
  assert.notDeepEqual(engine.getMessages(), before);
  assert.ok(
    engine
      .getMessages()
      .some((message) => message.role === 'user' && message.kind === 'compaction-summary')
  );
});

test('cancelling manual compaction rolls back partial multi-pass state', async () => {
  let summaryCalls = 0;
  const provider = {
    async chat() {
      summaryCalls += 1;
      return {
        message: {
          role: 'assistant',
          content: 'summary '.repeat(180)
        }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: smallContextOptions()
  });
  const messages = [];
  for (let index = 0; index < 10; index += 1) {
    messages.push({
      role: 'user',
      content: `user-${index}`.padEnd(100, ' ')
    });
    messages.push({
      role: 'assistant',
      content: `answer-${index}`.padEnd(1_000, ' ')
    });
  }
  engine.restoreState({
    schemaVersion: 1,
    messages,
    pendingFileChangeReceipts: [],
    compactionCount: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  });
  const before = engine.exportState();
  const controller = new AbortController();
  const operation = engine.compactContext({ signal: controller.signal });
  let result;
  while (true) {
    const next = await operation.next();
    if (next.done) {
      result = next.value;
      break;
    }
    if (next.value.type === 'compaction_completed') {
      controller.abort();
    }
  }

  assert.equal(result.status, 'cancelled');
  assert.equal(summaryCalls, 1);
  assert.deepEqual(engine.getMessages(), before.messages);
  assert.equal(engine.getStatus().context.compactions, 0);
  assert.equal(engine.getStatus().context.compactionCircuitOpen, false);
});

test('compaction retries one transient summary failure inside its two-attempt budget', async () => {
  let normalCalls = 0;
  let summaryAttempts = 0;
  const provider = {
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        summaryAttempts += 1;
        if (summaryAttempts === 1) {
          throw new ProviderError('network', {
            provider: 'Context Test Provider'
          });
        }
        return {
          message: { role: 'assistant', content: 'Recovered context summary.' }
        };
      }
      normalCalls += 1;
      return {
        message: {
          role: 'assistant',
          content: normalCalls === 1 ? 'Earlier answer '.repeat(400) : 'Continued.'
        }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: smallContextOptions(),
    providerRunner: { sleep: async () => {} }
  });

  await engine.chat('seed history');
  const { events, result } = await collectTurn(engine.runTurn('continue'));

  assert.equal(result.status, 'completed');
  assert.equal(summaryAttempts, 2);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'retry_scheduled' &&
        event.purpose === 'compaction' &&
        event.nextAttempt === 2
    )
  );
  assert.equal(events.filter((event) => event.type === 'compaction_completed').length, 1);
});

test('context_exceeded performs one forced compaction before retrying', async () => {
  let normalCalls = 0;
  let summaryCalls = 0;
  const provider = {
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        summaryCalls += 1;
        return {
          message: { role: 'assistant', content: 'Earlier context summary.' }
        };
      }
      normalCalls += 1;
      if (normalCalls === 2) {
        throw new ProviderError('context_exceeded', {
          provider: 'Context Test Provider'
        });
      }
      return {
        message: {
          role: 'assistant',
          content: normalCalls === 1 ? 'Baseline.' : 'Recovered.'
        }
      };
    },
    getInfo() {
      return providerInfo(100_000);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: {
      defaultWindowTokens: 100_000,
      minimumCompactableTokens: 20
    }
  });

  await engine.chat('recoverable history '.repeat(100));
  const { events, result } = await collectTurn(engine.runTurn('continue'));

  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'Recovered.');
  assert.equal(summaryCalls, 1);
  assert.equal(normalCalls, 3);
  assert.ok(
    events.some(
      (event) => event.type === 'provider_request_failed' && event.error.code === 'context_exceeded'
    )
  );
  assert.ok(
    events.some(
      (event) => event.type === 'compaction_started' && event.reason === 'context_exceeded'
    )
  );
});

test('switching to a 16K model bounds the summary request and compacts context', async () => {
  let normalCalls = 0;
  let summaryRequest;
  let finalRequest;
  const provider = {
    model: 'large-model',
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        summaryRequest = structuredClone(request);
        return {
          message: { role: 'assistant', content: 'Earlier large-model context.' }
        };
      }
      normalCalls += 1;
      if (normalCalls === 2) {
        finalRequest = structuredClone(request);
      }
      return {
        message: {
          role: 'assistant',
          content: normalCalls === 1 ? 'Large model reply '.repeat(4_000) : 'Small model reply.'
        }
      };
    },
    getInfo() {
      return {
        ...providerInfo(this.model === 'large-model' ? 100_000 : 16_384),
        model: this.model
      };
    },
    setModel(model) {
      this.model = model;
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: {
      defaultWindowTokens: 65_536,
      minimumCompactableTokens: 20
    }
  });

  await engine.chat('seed large-model history');
  engine.setModel('small-model');
  const { events, result } = await collectTurn(engine.runTurn('continue'));

  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'Small model reply.');
  assert.ok(
    events.some((event) => event.type === 'compaction_started' && event.reason === 'model_switch')
  );
  assert.equal(result.context.contextWindowTokens, 16_384);
  assert.match(summaryRequest.messages[0].content, /Compaction input truncated deterministically/);
  const summaryMeasurement = new ContextManager({
    defaultWindowTokens: 65_536,
    minimumCompactableTokens: 20
  }).measure(
    summaryRequest.messages,
    summaryRequest.systemPrompt,
    summaryRequest.tools,
    providerInfo(16_384)
  );
  assert.ok(summaryMeasurement.estimatedInputTokens < summaryMeasurement.triggerTokens);
  assert.ok(
    finalRequest.messages.some(
      (message) => message.role === 'user' && message.kind === 'compaction-summary'
    )
  );
});

test('a required threshold compaction failure fails closed without committing', async () => {
  let normalCalls = 0;
  const provider = {
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        return { message: { role: 'assistant', content: '' } };
      }
      normalCalls += 1;
      return {
        message: {
          role: 'assistant',
          content: normalCalls === 1 ? 'Earlier answer '.repeat(400) : 'Continued.'
        }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: smallContextOptions()
  });

  await engine.chat('seed history');
  const committedHistory = structuredClone(engine.getMessages());
  const { events, result } = await collectTurn(engine.runTurn('continue'));

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'context_compaction_failed');
  const failed = events.find((event) => event.type === 'compaction_failed');
  assert.equal(failed.recoverable, false);
  assert.deepEqual(engine.getMessages(), committedHistory);
  assert.equal(normalCalls, 1);
});

test('three consecutive compaction failures open the session circuit', async () => {
  let normalCalls = 0;
  let summaryCalls = 0;
  const provider = {
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        summaryCalls += 1;
        return { message: { role: 'assistant', content: '' } };
      }
      normalCalls += 1;
      return {
        message: {
          role: 'assistant',
          content:
            normalCalls === 1 ? 'Earlier answer '.repeat(400) : `Normal response ${normalCalls}.`
        }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: smallContextOptions()
  });

  await engine.chat('seed history');
  for (let index = 0; index < 3; index++) {
    const turn = await collectTurn(engine.runTurn(`continue ${index}`));
    assert.equal(turn.result.status, 'failed');
    assert.equal(turn.result.error.code, 'context_compaction_failed');
    assert.equal(turn.events.filter((event) => event.type === 'compaction_failed').length, 1);
  }

  const afterCircuit = await collectTurn(engine.runTurn('after circuit'));
  assert.equal(afterCircuit.result.status, 'failed');
  assert.equal(afterCircuit.result.error.code, 'context_compaction_failed');
  assert.equal(summaryCalls, 3);
  assert.equal(
    afterCircuit.events.some((event) => event.type === 'compaction_started'),
    false
  );
  assert.equal(
    afterCircuit.events.some((event) => event.type === 'compaction_failed'),
    true
  );
  assert.equal(normalCalls, 1);
});

test('cancelling during compaction rolls back the current turn', async () => {
  let notifyCompactionStarted;
  const compactionStarted = new Promise((resolve) => {
    notifyCompactionStarted = resolve;
  });
  let normalCalls = 0;
  const provider = {
    chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        notifyCompactionStarted();
        return new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true
          });
        });
      }
      normalCalls += 1;
      return Promise.resolve({
        message: {
          role: 'assistant',
          content: 'Earlier answer '.repeat(400)
        }
      });
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: smallContextOptions()
  });

  await engine.chat('seed history');
  const committedHistory = structuredClone(engine.getMessages());
  const controller = new AbortController();
  const collecting = collectTurn(
    engine.runTurn('cancel this', {
      signal: controller.signal
    })
  );
  await compactionStarted;
  controller.abort();
  const { events, result } = await collecting;

  assert.equal(result.status, 'cancelled');
  assert.equal(events.at(-1).type, 'turn_cancelled');
  assert.equal(
    events.some((event) => event.type === 'compaction_failed'),
    false
  );
  assert.deepEqual(engine.getMessages(), committedHistory);
  assert.equal(normalCalls, 1);
});

test('tool results are bounded to 40 KiB before entering model history', async () => {
  let calls = 0;
  let capturedToolResult;
  const provider = {
    async chat(request) {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'huge-1',
                name: 'HugeResult',
                input: {}
              }
            ]
          }
        };
      }
      capturedToolResult = request.messages.find((message) => message.role === 'tool');
      return {
        message: { role: 'assistant', content: 'Done.' }
      };
    },
    getInfo() {
      return providerInfo(1_000_000);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [
      {
        name: 'HugeResult',
        description: 'Return a large result',
        inputSchema: z.object({}).strict(),
        risk: 'read',
        approval: 'never',
        async execute() {
          return { content: 'x'.repeat(60 * 1024) };
        }
      }
    ],
    audit: false
  });

  const { events, result } = await collectTurn(engine.runTurn('run'));

  assert.equal(result.status, 'completed');
  assert.ok(Buffer.byteLength(capturedToolResult.content, 'utf8') <= 40 * 1024);
  assert.match(capturedToolResult.content, /Tool output truncated/);
  const completed = events.find(
    (event) => event.type === 'tool_completed' && event.toolName === 'HugeResult'
  );
  assert.equal(completed.metadata.outputTruncated, true);
  assert.equal(completed.metadata.originalBytes, 60 * 1024);
});

test('a 16K model dynamically budgets a large tool result before the next request', async () => {
  let normalCalls = 0;
  let secondRequest;
  const info = providerInfo(16_384);
  const provider = {
    async chat(request) {
      normalCalls += 1;
      if (normalCalls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'huge-16k',
                name: 'HugeResult',
                input: {}
              }
            ]
          }
        };
      }
      secondRequest = structuredClone(request);
      return {
        message: { role: 'assistant', content: 'Done safely.' }
      };
    },
    getInfo() {
      return info;
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [
      {
        name: 'HugeResult',
        description: 'Return a large result',
        inputSchema: z.object({}).strict(),
        risk: 'read',
        approval: 'never',
        async execute() {
          return { content: 'x'.repeat(60 * 1024) };
        }
      }
    ],
    audit: false
  });

  const { events, result } = await collectTurn(engine.runTurn('run'));

  assert.equal(result.status, 'completed');
  const toolResult = secondRequest.messages.find((message) => message.role === 'tool');
  assert.ok(toolResult);
  assert.ok(Buffer.byteLength(toolResult.content, 'utf8') < 40 * 1024);
  const measurement = new ContextManager().measure(
    secondRequest.messages,
    secondRequest.systemPrompt,
    secondRequest.tools,
    info
  );
  assert.ok(measurement.estimatedInputTokens < measurement.triggerTokens);
  const completed = events.find(
    (event) => event.type === 'tool_completed' && event.toolName === 'HugeResult'
  );
  assert.equal(completed.metadata.outputTruncated, true);
  assert.equal(completed.metadata.contextBudgeted, true);
  assert.ok(completed.metadata.contextBudgetBytes < 40 * 1024);
  assert.equal(
    events.some((event) => event.type === 'compaction_started'),
    false
  );
});

test('an oversized newest tool group is compacted atomically before reuse', async () => {
  let normalCalls = 0;
  let summaryRequest;
  let finalRequest;
  const info = providerInfo(16_384);
  const provider = {
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        summaryRequest = structuredClone(request);
        return {
          message: {
            role: 'assistant',
            content: 'The large lookup completed successfully.'
          }
        };
      }
      normalCalls += 1;
      if (normalCalls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'oversized-call',
                name: 'LargeInput',
                input: { payload: `HEAD-${'x'.repeat(60 * 1024)}-TAIL` }
              }
            ]
          }
        };
      }
      finalRequest = structuredClone(request);
      return {
        message: { role: 'assistant', content: 'Finished.' }
      };
    },
    getInfo() {
      return info;
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [
      {
        name: 'LargeInput',
        description: 'Accept a large provider-generated input',
        inputSchema: z.object({ payload: z.string() }).strict(),
        risk: 'read',
        approval: 'never',
        async execute() {
          return { content: 'lookup complete' };
        }
      }
    ],
    audit: false,
    context: { minimumCompactableTokens: 20 }
  });

  const { events, result } = await collectTurn(engine.runTurn('inspect'));

  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'Finished.');
  assert.ok(summaryRequest);
  assert.match(summaryRequest.messages[0].content, /Compaction input truncated deterministically/);
  const summaryMeasurement = new ContextManager({
    minimumCompactableTokens: 20
  }).measure(summaryRequest.messages, summaryRequest.systemPrompt, summaryRequest.tools, info);
  assert.ok(summaryMeasurement.estimatedInputTokens < summaryMeasurement.triggerTokens);
  const started = events.find((event) => event.type === 'compaction_started');
  assert.equal(started.mode, 'intra-turn');
  assert.ok(
    finalRequest.messages.some(
      (message) => message.role === 'user' && message.kind === 'compaction-summary'
    )
  );
  assert.equal(
    finalRequest.messages.some((message) => message.role === 'tool'),
    false
  );
});

test('cancelling emergency tool-group compaction rolls back the turn', async () => {
  let notifyCompactionStarted;
  const compactionStarted = new Promise((resolve) => {
    notifyCompactionStarted = resolve;
  });
  let normalCalls = 0;
  const provider = {
    chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        notifyCompactionStarted();
        return new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true
          });
        });
      }
      normalCalls += 1;
      return Promise.resolve({
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'oversized-cancel',
              name: 'LargeInput',
              input: { payload: 'x'.repeat(60 * 1024) }
            }
          ]
        }
      });
    },
    getInfo() {
      return providerInfo(16_384);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [
      {
        name: 'LargeInput',
        description: 'Accept a large provider-generated input',
        inputSchema: z.object({ payload: z.string() }).strict(),
        risk: 'read',
        approval: 'never',
        async execute() {
          return { content: 'lookup complete' };
        }
      }
    ],
    audit: false,
    context: { minimumCompactableTokens: 20 }
  });
  const controller = new AbortController();
  const collecting = collectTurn(
    engine.runTurn('inspect', {
      signal: controller.signal
    })
  );

  await compactionStarted;
  controller.abort();
  const { events, result } = await collecting;

  assert.equal(result.status, 'cancelled');
  assert.equal(events.at(-1).type, 'turn_cancelled');
  assert.equal(
    events.some((event) => event.type === 'compaction_failed'),
    false
  );
  assert.deepEqual(engine.getMessages(), []);
  assert.equal(normalCalls, 1);
});

test('context still above threshold after three reductions fails closed', async () => {
  let normalCalls = 0;
  let summaryCalls = 0;
  const summarySizes = [50_000, 40_000, 30_000];
  const provider = {
    model: 'large-model',
    async chat(request) {
      if (request.systemPrompt.includes('Compress the supplied conversation')) {
        const content = 's'.repeat(summarySizes[summaryCalls]);
        summaryCalls += 1;
        return {
          message: { role: 'assistant', content }
        };
      }
      normalCalls += 1;
      return {
        message: {
          role: 'assistant',
          content: 'large history '.repeat(8_000)
        }
      };
    },
    getInfo() {
      return {
        ...providerInfo(this.model === 'large-model' ? 100_000 : 16_384),
        model: this.model
      };
    },
    setModel(model) {
      this.model = model;
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: { minimumCompactableTokens: 20 }
  });

  await engine.chat('seed history');
  engine.setModel('small-model');
  const { events, result } = await collectTurn(engine.runTurn('continue'));

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'context_compaction_failed');
  assert.equal(summaryCalls, 3);
  assert.equal(normalCalls, 1);
  assert.equal(events.filter((event) => event.type === 'compaction_completed').length, 3);
  assert.ok(
    events.some((event) => event.type === 'compaction_failed' && event.recoverable === false)
  );
});

test('an uncompactable oversized user message fails before provider sampling', async () => {
  let providerCalls = 0;
  const provider = {
    async chat() {
      providerCalls += 1;
      return {
        message: { role: 'assistant', content: 'should not run' }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: smallContextOptions()
  });

  const { events, result } = await collectTurn(engine.runTurn('x'.repeat(10_000)));

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'context_compaction_failed');
  assert.equal(providerCalls, 0);
  assert.ok(
    events.some((event) => event.type === 'compaction_failed' && event.recoverable === false)
  );
  assert.deepEqual(engine.getMessages(), []);
});

test('disabling auto compaction preserves explicit best-effort provider calls', async () => {
  let providerCalls = 0;
  const provider = {
    async chat() {
      providerCalls += 1;
      return {
        message: { role: 'assistant', content: 'best effort' }
      };
    },
    getInfo() {
      return providerInfo(2_500);
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    context: {
      ...smallContextOptions(),
      autoCompact: false
    }
  });

  const result = await engine.chat('x'.repeat(10_000));

  assert.equal(result, 'best effort');
  assert.equal(providerCalls, 1);
});

test('a failed turn after a file change adds a reread receipt to the next turn', async () => {
  let calls = 0;
  let nextTurnMessages;
  const provider = {
    async chat(request) {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'write-1',
                name: 'Write',
                input: { path: 'src/changed.ts' }
              }
            ]
          }
        };
      }
      if (calls === 2) {
        throw new ProviderError('malformed_response', {
          provider: 'Context Test Provider'
        });
      }
      nextTurnMessages = structuredClone(request.messages);
      return {
        message: { role: 'assistant', content: 'Re-read acknowledged.' }
      };
    },
    getInfo() {
      return providerInfo();
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [
      {
        name: 'Write',
        description: 'Simulate a file write',
        inputSchema: z.object({ path: z.string() }).strict(),
        risk: 'write',
        approval: 'always',
        async prepareApproval() {
          return { description: 'write test file' };
        },
        async execute() {
          return {
            content: 'written',
            metadata: { versionHash: 'abc123' }
          };
        }
      }
    ],
    permissionMode: 'fullAccess',
    audit: false
  });

  const failed = await collectTurn(engine.runTurn('change it'));
  assert.equal(failed.result.status, 'failed');
  assert.deepEqual(engine.getMessages(), []);

  assert.equal(await engine.chat('next'), 'Re-read acknowledged.');
  const receipt = nextTurnMessages.find(
    (message) => message.role === 'user' && message.kind === 'compaction-summary'
  );
  assert.match(receipt.content, /side_effect_receipt/);
  assert.match(receipt.content, /src\/changed\.ts/);
  assert.match(receipt.content, /abc123/);
});
