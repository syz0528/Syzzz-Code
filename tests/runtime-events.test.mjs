import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { QueryEngine } from '../dist/engine.js';

function providerInfo(streaming = false) {
  return {
    name: 'Test Provider',
    type: 'test',
    model: 'test-model',
    capabilities: {
      streaming,
      reasoningToggle: streaming
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

test('runTurn emits ordered envelopes and one completed terminal event', async () => {
  const provider = {
    async chat() {
      return {
        message: { role: 'assistant', content: 'Hello from events.' },
        finishReason: 'stop',
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
        requestId: 'req-success',
        reportedModel: 'reported-test-model'
      };
    },
    getInfo() {
      return providerInfo();
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false,
    sessionId: 'session-1',
    idFactory: () => 'turn-1',
    now: () => Date.parse('2026-07-22T00:00:00.000Z'),
    providerRunner: { idFactory: () => 'attempt-1' }
  });

  const { events, result } = await collectTurn(engine.runTurn('hello'));

  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'Hello from events.');
  assert.deepEqual(events.map(event => event.type), [
    'turn_started',
    'context_usage_updated',
    'phase_changed',
    'provider_request_started',
    'text_delta',
    'usage_updated',
    'context_usage_updated',
    'provider_request_completed',
    'phase_changed',
    'turn_completed'
  ]);
  assert.deepEqual(
    events.map(event => event.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.ok(events.every(event => event.schemaVersion === 1));
  assert.ok(events.every(event => event.sessionId === 'session-1'));
  assert.ok(events.every(event => event.turnId === 'turn-1'));
  assert.ok(events.every(event =>
    event.timestamp === '2026-07-22T00:00:00.000Z'
  ));
  assert.equal(events.filter(event =>
    ['turn_completed', 'turn_failed', 'turn_cancelled'].includes(event.type)
  ).length, 1);
  assert.equal(
    events.find(event => event.type === 'provider_request_completed').requestId,
    'req-success'
  );
});

test('runTurn reports failure as a terminal event and rolls back history', async () => {
  const provider = {
    async chat() {
      throw new Error('protocol exploded');
    },
    getInfo() {
      return providerInfo();
    }
  };
  const engine = new QueryEngine({ provider, tools: [], audit: false });

  const { events, result } = await collectTurn(engine.runTurn('fail'));

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'unknown');
  assert.equal(events.at(-1).type, 'turn_failed');
  assert.equal(events.filter(event =>
    ['turn_completed', 'turn_failed', 'turn_cancelled'].includes(event.type)
  ).length, 1);
  assert.deepEqual(engine.getMessages(), []);
});

test('closing a generator after provider start releases the processing lock', async () => {
  let calls = 0;
  const provider = {
    async chat() {
      calls += 1;
      return { message: { role: 'assistant', content: 'Recovered.' } };
    },
    getInfo() {
      return providerInfo();
    }
  };
  const engine = new QueryEngine({ provider, tools: [], audit: false });
  const turn = engine.runTurn('first');

  assert.equal((await turn.next()).value.type, 'turn_started');
  assert.equal((await turn.next()).value.type, 'context_usage_updated');
  assert.equal((await turn.next()).value.type, 'phase_changed');
  assert.equal((await turn.next()).value.type, 'provider_request_started');
  await turn.return();

  assert.equal(calls, 0);
  assert.equal(await engine.chat('second'), 'Recovered.');
  assert.equal(calls, 1);
});

test('closing after a text delta aborts and closes the provider stream', async () => {
  let calls = 0;
  let firstStreamClosed = false;
  const provider = {
    async chat() {
      throw new Error('unused');
    },
    async *chatStream() {
      calls += 1;
      if (calls === 1) {
        try {
          yield { type: 'text_delta', text: 'partial' };
          await new Promise(() => {});
        } finally {
          firstStreamClosed = true;
        }
      }

      yield { type: 'text_delta', text: 'Recovered.' };
      return {
        message: { role: 'assistant', content: 'Recovered.' }
      };
    },
    getInfo() {
      return providerInfo(true);
    }
  };
  const engine = new QueryEngine({ provider, tools: [], audit: false });
  const turn = engine.runTurn('first');

  while (true) {
    const next = await turn.next();
    assert.equal(next.done, false);
    if (next.value.type === 'text_delta') {
      break;
    }
  }
  await turn.return();

  assert.equal(firstStreamClosed, true);
  assert.equal(await engine.chat('second'), 'Recovered.');
  assert.equal(calls, 2);
});

test('user cancellation emits turn_cancelled without provider failure', async () => {
  let notifyStarted;
  const started = new Promise(resolve => {
    notifyStarted = resolve;
  });
  const provider = {
    chat(request) {
      notifyStarted();
      return new Promise((resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true }
        );
      });
    },
    getInfo() {
      return providerInfo();
    }
  };
  const engine = new QueryEngine({ provider, tools: [], audit: false });
  const controller = new AbortController();
  const collecting = collectTurn(engine.runTurn('cancel', {
    signal: controller.signal
  }));

  await started;
  controller.abort(new Error('secret abort reason'));
  const { events, result } = await collecting;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'Operation cancelled by the user');
  assert.equal(events.at(-1).type, 'turn_cancelled');
  assert.equal(events.at(-1).reason, 'Operation cancelled by the user');
  assert.equal(JSON.stringify(events).includes('secret abort reason'), false);
  assert.equal(
    events.some(event => event.type === 'provider_request_failed'),
    false
  );
  assert.deepEqual(engine.getMessages(), []);
});

test('approval and tool events preserve the decision order', async () => {
  let requests = 0;
  const provider = {
    async chat() {
      requests += 1;
      if (requests === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'write-1',
              name: 'Write',
              input: { value: 'next' }
            }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Done.' } };
    },
    getInfo() {
      return providerInfo();
    }
  };
  const tool = {
    name: 'Write',
    description: 'Write a value',
    inputSchema: z.object({ value: z.string() }).strict(),
    risk: 'write',
    approval: 'always',
    async prepareApproval() {
      return { description: 'Write value', preview: 'sensitive diff' };
    },
    async execute() {
      return {
        content: 'sensitive tool result',
        metadata: { changed: true }
      };
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [tool],
    audit: false
  });

  const { events, result } = await collectTurn(engine.runTurn('write', {
    async requestApproval() {
      return 'allow-once';
    }
  }));

  assert.equal(result.status, 'completed');
  const relevantTypes = events
    .filter(event => [
      'tool_requested',
      'approval_requested',
      'approval_resolved',
      'tool_started',
      'tool_completed'
    ].includes(event.type))
    .map(event => event.type);
  assert.deepEqual(relevantTypes, [
    'tool_requested',
    'approval_requested',
    'approval_resolved',
    'tool_started',
    'tool_completed'
  ]);
  const completed = events.find(event => event.type === 'tool_completed');
  assert.equal(completed.outcome, 'success');
  assert.equal(completed.result, 'sensitive tool result');
  assert.deepEqual(completed.metadata, { changed: true });
});
test('history commits only when the completed terminal event is emitted', async () => {
  const provider = {
    async chat() {
      return {
        message: {
          role: 'assistant',
          content: 'Complete response.'
        }
      };
    },
    getInfo() {
      return providerInfo();
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false
  });
  const turn = engine.runTurn('close before terminal');

  while (true) {
    const next = await turn.next();
    assert.equal(next.done, false);
    if (
      next.value.type === 'phase_changed' &&
      next.value.phase === 'completed'
    ) {
      break;
    }
  }
  await turn.return();
  assert.deepEqual(engine.getMessages(), []);
});

test('model switching preserves portable history and removes private reasoning metadata', async () => {
  const capturedMessages = [];
  let calls = 0;
  const provider = {
    model: 'model-a',
    async chat(request) {
      capturedMessages.push(structuredClone(request.messages));
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            reasoningContent: 'provider-private reasoning',
            toolCalls: [{
              id: 'echo-1',
              name: 'Echo',
              input: { value: 'first' }
            }]
          }
        };
      }
      return {
        message: {
          role: 'assistant',
          content: calls === 2 ? 'First reply.' : 'Second reply.'
        }
      };
    },
    getInfo() {
      return {
        ...providerInfo(),
        model: this.model
      };
    },
    setModel(model) {
      this.model = model;
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [{
      name: 'Echo',
      description: 'Echo a value',
      inputSchema: z.object({ value: z.string() }).strict(),
      risk: 'read',
      approval: 'never',
      async execute(input) {
        return { content: input.value };
      }
    }],
    audit: false
  });

  assert.equal(await engine.chat('first'), 'First reply.');
  assert.equal(
    engine.getMessages().find(message => message.reasoningContent)?.reasoningContent,
    'provider-private reasoning'
  );
  engine.setModel('model-b');

  assert.equal(engine.getProviderInfo().model, 'model-b');
  assert.equal(
    engine.getMessages().some(message => 'reasoningContent' in message),
    false
  );
  assert.equal(await engine.chat('second'), 'Second reply.');
  assert.equal(
    capturedMessages[2].some(message => 'reasoningContent' in message),
    false
  );
});

test('model switching is rejected while a turn is running or unsupported', async () => {
  let notifyStarted;
  let finishRequest;
  const started = new Promise(resolve => {
    notifyStarted = resolve;
  });
  const provider = {
    model: 'model-a',
    chat() {
      notifyStarted();
      return new Promise(resolve => {
        finishRequest = resolve;
      });
    },
    getInfo() {
      return { ...providerInfo(), model: this.model };
    },
    setModel(model) {
      this.model = model;
    }
  };
  const engine = new QueryEngine({ provider, tools: [], audit: false });
  const earlyTurn = engine.runTurn('lock immediately');
  assert.equal((await earlyTurn.next()).value.type, 'turn_started');
  assert.throws(
    () => engine.setModel('model-b'),
    /while a turn is processing/
  );
  await earlyTurn.return();

  const running = engine.chat('busy');
  await started;

  assert.throws(
    () => engine.setModel('model-b'),
    /while a turn is processing/
  );
  finishRequest({ message: { role: 'assistant', content: 'Done.' } });
  await running;

  const unsupported = new QueryEngine({
    provider: {
      async chat() {
        return { message: { role: 'assistant', content: 'unused' } };
      },
      getInfo() {
        return providerInfo();
      }
    },
    tools: [],
    audit: false
  });
  assert.throws(
    () => unsupported.setModel('model-b'),
    /does not support runtime model switching/
  );
});
