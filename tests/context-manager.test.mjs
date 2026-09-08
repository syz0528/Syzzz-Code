import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextManager,
  applyCompactionPlan,
  createCompactionSummaryMessage,
  estimateUtf8Tokens,
  formatMessagesForCompaction,
  formatMessagesForCompactionBounded
} from '../dist/context-manager.js';

test('fallback context window can be changed at runtime without overriding Provider metadata', () => {
  const manager = new ContextManager({ defaultWindowTokens: 65_536 });
  assert.equal(manager.contextWindowTokens({}), 65_536);

  manager.setDefaultWindowTokens(200_000);
  assert.equal(manager.contextWindowTokens({}), 200_000);
  assert.equal(manager.contextWindowTokens({ contextWindowTokens: 128_000 }), 128_000);
});

const providerInfo = {
  name: 'Test',
  type: 'openai-compatible',
  model: 'test-model',
  contextWindowTokens: 2_000,
  capabilities: {
    streaming: true,
    reasoningToggle: false
  }
};

test('context estimation is conservative for UTF-8 and includes fixed request data', () => {
  assert.ok(estimateUtf8Tokens('你好世界') >= 4);
  const manager = new ContextManager({
    defaultWindowTokens: 2_000,
    triggerRatio: 0.5,
    targetRatio: 0.25,
    reservedOutputTokens: 100,
    minimumCompactableTokens: 10
  });
  const measurement = manager.measure(
    [{ role: 'user', content: 'x'.repeat(2_000) }],
    'system prompt',
    [
      {
        name: 'Read',
        description: 'read',
        inputSchema: { type: 'object', properties: {} }
      }
    ],
    providerInfo
  );

  assert.ok(measurement.fixedTokens > 0);
  assert.ok(measurement.messageTokens > 0);
  assert.equal(measurement.contextWindowTokens, 2_000);
  assert.equal(measurement.triggerTokens, 1_000);
  assert.equal(measurement.shouldCompact, true);
});

test('small model windows scale the output reserve without changing large-window behavior', () => {
  const manager = new ContextManager();
  const small = manager.measure([], 'system', [], {
    ...providerInfo,
    contextWindowTokens: 16_384
  });
  const large = manager.measure([], 'system', [], {
    ...providerInfo,
    contextWindowTokens: 65_536
  });

  assert.equal(small.triggerTokens, 12_288);
  assert.equal(large.triggerTokens, Math.floor(65_536 * 0.85));
});

test('small model windows can compact useful history below the large-window minimum', () => {
  const manager = new ContextManager({ defaultWindowTokens: 16_384 });
  const info = { ...providerInfo, contextWindowTokens: 16_384 };
  const messages = [
    { role: 'user', content: 'older request '.repeat(300) },
    { role: 'assistant', content: 'older answer '.repeat(180) },
    { role: 'user', content: 'current request' }
  ];
  const measurement = manager.measure(messages, 's'.repeat(21_000), [], info);

  assert.ok(measurement.estimatedInputTokens >= measurement.triggerTokens);
  assert.ok(measurement.messageTokens < 4_000);
  const plan = manager.createPlan(messages, measurement);
  assert.ok(plan);
  assert.equal(plan.mode, 'history');
  assert.equal(plan.selectedMessages.at(-1).role, 'assistant');
});

test('auto compaction can be disabled without changing context measurement', () => {
  const manager = new ContextManager({
    autoCompact: false,
    defaultWindowTokens: 2_000,
    triggerRatio: 0.5,
    reservedOutputTokens: 100
  });
  const measurement = manager.measure(
    [{ role: 'user', content: 'x'.repeat(4_000) }],
    'system',
    [],
    providerInfo
  );

  assert.ok(measurement.estimatedInputTokens >= measurement.triggerTokens);
  assert.equal(measurement.shouldCompact, false);
});

test('history compaction never splits assistant tool calls from tool results', () => {
  const manager = new ContextManager({
    defaultWindowTokens: 2_000,
    triggerRatio: 0.3,
    targetRatio: 0.2,
    reservedOutputTokens: 100,
    minimumCompactableTokens: 10
  });
  const messages = [
    { role: 'user', content: 'old request '.repeat(40) },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'Read', input: { path: 'a.ts' } }]
    },
    {
      role: 'tool',
      toolCallId: 'call-1',
      toolName: 'Read',
      content: 'old tool result '.repeat(100)
    },
    { role: 'user', content: 'current request' }
  ];
  const measurement = manager.measure(messages, 'system', [], providerInfo);
  const plan = manager.createPlan(messages, measurement);

  assert.ok(plan);
  assert.equal(plan.mode, 'history');
  const assistantIndex = plan.selectedMessages.findIndex((message) => message.role === 'assistant');
  if (assistantIndex !== -1) {
    assert.equal(plan.selectedMessages[assistantIndex + 1].role, 'tool');
  }
  const compacted = applyCompactionPlan(messages, plan, 'Preserved summary');
  assert.equal(compacted.at(-1).content, 'current request');
  assert.equal(
    compacted.some((message) => message.kind === 'compaction-summary'),
    true
  );
});

test('intra-turn compaction retains the current user and newest tool group', () => {
  const manager = new ContextManager({
    defaultWindowTokens: 1_500,
    triggerRatio: 0.3,
    targetRatio: 0.2,
    reservedOutputTokens: 100,
    minimumCompactableTokens: 10
  });
  const messages = [
    { role: 'user', content: 'current request' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'old', name: 'Read', input: { path: 'old.ts' } }]
    },
    {
      role: 'tool',
      toolCallId: 'old',
      toolName: 'Read',
      content: 'old result '.repeat(160)
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'new', name: 'Read', input: { path: 'new.ts' } }]
    },
    {
      role: 'tool',
      toolCallId: 'new',
      toolName: 'Read',
      content: 'new result'
    }
  ];
  const measurement = manager.measure(messages, 'system', [], providerInfo);
  const plan = manager.createPlan(messages, measurement);

  assert.ok(plan);
  assert.equal(plan.mode, 'intra-turn');
  assert.equal(plan.startIndex, 1);
  assert.equal(plan.endIndex, 3);
  const compacted = applyCompactionPlan(messages, plan, 'Earlier tool work');
  assert.equal(compacted[0].content, 'current request');
  assert.equal(compacted[1].kind, 'compaction-summary');
  assert.equal(compacted.at(-1).toolCallId, 'new');
});

test('emergency intra-turn compaction selects the newest tool group atomically', () => {
  const manager = new ContextManager({
    defaultWindowTokens: 2_000,
    triggerRatio: 0.5,
    targetRatio: 0.25,
    reservedOutputTokens: 100,
    minimumCompactableTokens: 10
  });
  const messages = [
    { role: 'user', content: 'current request' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'latest',
          name: 'Read',
          input: { path: 'large.ts' }
        }
      ]
    },
    {
      role: 'tool',
      toolCallId: 'latest',
      toolName: 'Read',
      content: 'large result '.repeat(300)
    }
  ];
  const measurement = manager.measure(messages, 'system', [], providerInfo);

  assert.equal(manager.createPlan(messages, measurement), undefined);
  const emergencyPlan = manager.createPlan(messages, measurement, {
    allowLatestIntraTurn: true
  });
  assert.ok(emergencyPlan);
  assert.equal(emergencyPlan.mode, 'intra-turn');
  assert.equal(emergencyPlan.startIndex, 1);
  assert.equal(emergencyPlan.endIndex, 3);
  assert.deepEqual(
    emergencyPlan.selectedMessages.map((message) => message.role),
    ['assistant', 'tool']
  );
});

test('later compaction folds an earlier summary back into old history', () => {
  const manager = new ContextManager({
    defaultWindowTokens: 1_500,
    triggerRatio: 0.4,
    targetRatio: 0.2,
    reservedOutputTokens: 100,
    minimumCompactableTokens: 10
  });
  const messages = [
    createCompactionSummaryMessage('Earlier summary.'),
    { role: 'user', content: 'older details '.repeat(120) },
    { role: 'assistant', content: 'older answer '.repeat(80) },
    { role: 'user', content: 'current request' }
  ];
  const measurement = manager.measure(messages, 'system', [], providerInfo);
  const plan = manager.createPlan(messages, measurement);

  assert.ok(plan);
  assert.equal(plan.mode, 'history');
  assert.equal(
    plan.selectedMessages.some((message) => message.kind === 'compaction-summary'),
    true
  );
  assert.ok(plan.selectedMessages.length > 1);

  const compacted = applyCompactionPlan(messages, plan, 'Consolidated summary.');
  assert.equal(compacted.filter((message) => message.kind === 'compaction-summary').length, 1);
  assert.equal(compacted.at(-1).content, 'current request');
});

test('compaction transcript excludes private reasoning and keeps tool facts', () => {
  const transcript = formatMessagesForCompaction([
    { role: 'user', content: 'inspect' },
    {
      role: 'assistant',
      content: 'working',
      reasoningContent: 'PRIVATE REASONING',
      toolCalls: [{ id: 'one', name: 'Read', input: { path: 'x.ts' } }]
    },
    {
      role: 'tool',
      toolCallId: 'one',
      toolName: 'Read',
      content: 'file fact'
    }
  ]);
  assert.match(transcript, /file fact/);
  assert.match(transcript, /"name":"Read"/);
  assert.doesNotMatch(transcript, /PRIVATE REASONING/);
});

test('compaction transcript is deterministically bounded below request threshold', () => {
  const manager = new ContextManager({
    defaultWindowTokens: 2_000,
    triggerRatio: 0.8,
    targetRatio: 0.5,
    reservedOutputTokens: 100
  });
  const summarySystemPrompt = 'Summarize context safely.';
  const promptPrefix = 'Summarize:\n\n';
  const budget = manager.compactionInputBudgetBytes(
    summarySystemPrompt,
    providerInfo,
    promptPrefix
  );
  const bounded = formatMessagesForCompactionBounded(
    [
      { role: 'user', content: `HEAD-${'x'.repeat(10_000)}-TAIL` },
      {
        role: 'assistant',
        content: 'visible',
        reasoningContent: 'PRIVATE REASONING'
      }
    ],
    budget
  );

  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.content, 'utf8') <= budget);
  assert.match(bounded.content, /HEAD-/);
  assert.match(bounded.content, /visible/);
  assert.match(bounded.content, /middle omitted/);
  assert.doesNotMatch(bounded.content, /PRIVATE REASONING/);

  const measurement = manager.measure(
    [{ role: 'user', content: promptPrefix + bounded.content }],
    summarySystemPrompt,
    [],
    providerInfo
  );
  assert.ok(measurement.estimatedInputTokens < measurement.triggerTokens);
});

test('context manager validates reducing summaries and opens its failure circuit', () => {
  const manager = new ContextManager({
    minimumCompactableTokens: 1,
    maxConsecutiveFailures: 3
  });
  const plan = {
    mode: 'history',
    startIndex: 0,
    endIndex: 1,
    selectedMessages: [{ role: 'user', content: 'x'.repeat(4_000) }],
    selectedTokens: 2_000,
    beforeMessageTokens: 2_100,
    retainedMessageTokens: 100
  };
  assert.equal(manager.isUsefulSummary(plan, 'short useful summary'), true);
  assert.equal(manager.isUsefulSummary(plan, 'x'.repeat(4_000)), false);

  manager.recordCompactionFailure();
  manager.recordCompactionFailure();
  assert.equal(manager.circuitOpen, false);
  manager.recordCompactionFailure();
  assert.equal(manager.circuitOpen, true);
  manager.recordCompactionSuccess();
  assert.equal(manager.circuitOpen, false);
  assert.equal(manager.compactions, 1);
});

test('tool result limiting keeps command error head and tail', () => {
  const manager = new ContextManager({ maxToolResultBytes: 200 });
  const limited = manager.limitToolResult('Shell', `HEADER\n${'middle'.repeat(100)}\nTAIL`, true);
  assert.equal(limited.truncated, true);
  assert.match(limited.content, /HEADER/);
  assert.match(limited.content, /TAIL/);
  assert.ok(Buffer.byteLength(limited.content, 'utf8') <= 200);
});

test('tool result budget adapts to the remaining model context', () => {
  const manager = new ContextManager({
    defaultWindowTokens: 16_384,
    minimumCompactableTokens: 20
  });
  const info = {
    ...providerInfo,
    contextWindowTokens: 16_384
  };
  const tools = [
    {
      name: 'HugeResult',
      description: 'return data',
      inputSchema: { type: 'object', properties: {} }
    }
  ];
  const messages = [
    { role: 'user', content: 'inspect' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'huge', name: 'HugeResult', input: {} }]
    }
  ];
  const budget = manager.toolResultBudgetBytes(
    messages,
    'system',
    tools,
    info,
    'huge',
    'HugeResult'
  );
  const limited = manager.limitToolResult('HugeResult', 'x'.repeat(60 * 1024), false, budget);
  const withResult = [
    ...messages,
    {
      role: 'tool',
      toolCallId: 'huge',
      toolName: 'HugeResult',
      content: limited.content
    }
  ];
  const measurement = manager.measure(withResult, 'system', tools, info);

  assert.ok(budget < 40 * 1024);
  assert.ok(Buffer.byteLength(limited.content, 'utf8') <= budget);
  assert.ok(measurement.estimatedInputTokens < measurement.triggerTokens);
});

test('UTF-8 output limits remain hard even when the marker exceeds the cap', () => {
  const manager = new ContextManager({ maxToolResultBytes: 8 });
  const limited = manager.limitToolResult('Read', '浣犲ソ'.repeat(20), false);

  assert.equal(limited.truncated, true);
  assert.ok(Buffer.byteLength(limited.content, 'utf8') <= 8);
});
