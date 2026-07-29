import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeAgentTurn,
  formatTurnFooter,
  HumanEventRenderer,
  sanitizeAgentEventForStream,
  serializeAgentEvent,
  stopSpinnerIfActive,
  turnResultExitCode
} from '../dist/cli-renderer.js';

function event(type, payload = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session',
    turnId: 'turn',
    sequence: 1,
    timestamp: '2026-07-22T00:00:00.000Z',
    type,
    ...payload
  };
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

test('stream-json removes tool results and metadata', () => {
  const rawEvent = event('tool_completed', {
    toolCallId: 'tool-1',
    toolName: 'Read',
    outcome: 'success',
    durationMs: 2,
    result: 'PRIVATE FILE BODY',
    metadata: { diff: 'PRIVATE DIFF' }
  });
  const safeEvent = sanitizeAgentEventForStream(rawEvent);
  const serialized = serializeAgentEvent(rawEvent);

  assert.equal(safeEvent.result, undefined);
  assert.equal(safeEvent.metadata, undefined);
  assert.equal(serialized.includes('PRIVATE FILE BODY'), false);
  assert.equal(serialized.includes('PRIVATE DIFF'), false);
  assert.deepEqual(JSON.parse(serialized), safeEvent);
  assert.doesNotMatch(serialized, /\u001b\[/);
});

test('stream-json extension events expose status metadata but no private payloads', () => {
  const events = [
    event('mcp_server_status', {
      server: 'fixture',
      source: 'project',
      transport: 'stdio',
      state: 'ready',
      toolCount: 2
    }),
    event('hook_completed', {
      hook: 'policy',
      event: 'SubagentStop',
      source: 'project',
      outcome: 'success',
      durationMs: 3
    }),
    event('subagent_completed', {
      role: 'explore',
      outcome: 'success',
      durationMs: 12,
      toolCalls: 2,
      providerCalls: 3,
      stopReason: 'completed',
      reportTruncated: false,
      usage: { inputTokens: 20, outputTokens: 4 }
    })
  ];
  const serialized = events.map(serializeAgentEvent).join('\n');
  assert.doesNotMatch(
    serialized,
    /"(?:task|transcript|report|headers|result)"\s*:/
  );
  assert.equal(
    serialized.split('\n').every(line => JSON.parse(line).schemaVersion === 1),
    true
  );
});

test('stream-json emits valid NDJSON events', () => {
  const events = [
    event('retry_scheduled', {
      attempt: 1,
      nextAttempt: 2,
      delayMs: 0,
      reason: 'malformed_response'
    }),
    event('text_delta', {
      attempt: 1,
      attemptId: 'a',
      delta: 'hello'
    }),
    event('turn_completed', { durationMs: 12 })
  ];
  const ndjson = events.map(serializeAgentEvent).join('\n') + '\n';
  const parsed = ndjson
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].reason, 'malformed_response');
  assert.equal(parsed[0].delayMs, 0);
  assert.equal(parsed[1].delta, 'hello');
  assert.equal(parsed[2].type, 'turn_completed');
});

test('stream-json is ASCII-safe and round-trips Unicode text', () => {
  const rawEvent = event('text_delta', {
    attempt: 1,
    attemptId: 'unicode',
    delta: '中文标点：你好 😊'
  });
  const serialized = serializeAgentEvent(rawEvent);

  assert.doesNotMatch(serialized, /[^\x20-\x7e]/);
  assert.equal(JSON.parse(serialized).delta, rawEvent.delta);
});

test('streaming text stops an active spinner only once', () => {
  let isSpinning = true;
  let stopCalls = 0;
  const spinner = {
    get isSpinning() {
      return isSpinning;
    },
    stop() {
      stopCalls += 1;
      isSpinning = false;
    }
  };

  stopSpinnerIfActive(spinner);
  stopSpinnerIfActive(spinner);
  stopSpinnerIfActive(undefined);

  assert.equal(stopCalls, 1);
});

test('turn consumer returns the generator result', async () => {
  async function* turn() {
    yield event('text_delta', {
      attempt: 1,
      attemptId: 'a',
      delta: 'one'
    });
    yield event('text_delta', {
      attempt: 1,
      attemptId: 'a',
      delta: 'two'
    });
    return {
      status: 'completed',
      response: 'onetwo',
      durationMs: 1000
    };
  }
  const seen = [];
  const result = await consumeAgentTurn(
    turn(),
    current => seen.push(current.type)
  );

  assert.deepEqual(seen, ['text_delta', 'text_delta']);
  assert.equal(result.response, 'onetwo');
  assert.equal(formatTurnFooter(result), '1.0s');
});

test('footer and exit codes follow the CLI contract', () => {
  assert.equal(formatTurnFooter({
    status: 'completed',
    response: 'ok',
    durationMs: 1234,
    finishReason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13
    }
  }), 'tokens 10 in / 3 out | 1.2s | finish: stop');

  assert.equal(turnResultExitCode({
    status: 'completed',
    response: 'ok',
    durationMs: 1
  }), 0);
  assert.equal(turnResultExitCode({
    status: 'failed',
    durationMs: 1,
    error: { code: 'x', message: 'x' }
  }), 1);
  assert.equal(turnResultExitCode({
    status: 'cancelled',
    durationMs: 1,
    reason: 'cancelled'
  }), 130);
});

test('human renderer buffers text and keeps only useful status lines', () => {
  const chunks = [];
  let spinning = false;
  const spinner = {
    text: '',
    get isSpinning() {
      return spinning;
    },
    start() {
      spinning = true;
    },
    stop() {
      spinning = false;
    }
  };
  const renderer = new HumanEventRenderer({
    streamOutput: false,
    spinner,
    output: { write: chunk => chunks.push(chunk) }
  });

  renderer.handle(event('text_delta', {
    attempt: 1,
    attemptId: 'a',
    delta: 'buffered response'
  }));
  assert.doesNotMatch(chunks.join(''), /buffered response/);

  renderer.handle(event('tool_started', {
    toolCallId: 'read-1',
    toolName: 'Read'
  }));
  renderer.handle(event('tool_completed', {
    toolCallId: 'read-1',
    toolName: 'Read',
    outcome: 'success',
    durationMs: 2
  }));
  renderer.handle(event('tool_completed', {
    toolCallId: 'shell-1',
    toolName: 'Shell',
    outcome: 'success',
    durationMs: 1200
  }));
  renderer.handle(event('tool_completed', {
    toolCallId: 'read-2',
    toolName: 'Read',
    outcome: 'error',
    durationMs: 3,
    result: 'failed to read file'
  }));
  renderer.handle(event('retry_scheduled', {
    attempt: 1,
    nextAttempt: 2,
    delayMs: 500,
    reason: 'network'
  }));
  renderer.finish({
    status: 'completed',
    response: 'buffered response',
    durationMs: 2000,
    finishReason: 'stop'
  });

  const rendered = stripAnsi(chunks.join(''));
  assert.match(rendered, /Assistant:\n/);
  assert.match(rendered, /buffered response/);
  assert.doesNotMatch(rendered, /Read success/);
  assert.match(rendered, /Shell success \(1\.2s\)/);
  assert.match(rendered, /Read error \(3ms\): failed to read file/);
  assert.match(rendered, /Retrying attempt 2 in 500ms \(network\)/);
  assert.match(rendered, /tools 3 \(1 failed\)/);
  assert.match(rendered, /retries 1/);

  const recoveryChunks = [];
  let recoverySpinning = false;
  const recoverySpinner = {
    text: '',
    get isSpinning() {
      return recoverySpinning;
    },
    start() {
      recoverySpinning = true;
    },
    stop() {
      recoverySpinning = false;
    }
  };
  const recoveryRenderer = new HumanEventRenderer({
    streamOutput: true,
    spinner: recoverySpinner,
    output: { write: chunk => recoveryChunks.push(chunk) }
  });
  recoveryRenderer.handle(event('retry_scheduled', {
    attempt: 2,
    nextAttempt: 3,
    delayMs: 0,
    reason: 'malformed_response'
  }));
  assert.equal(recoverySpinner.text, 'Adjusting provider response mode...');
  assert.equal(recoveryChunks.join(''), '');
  assert.equal(recoveryRenderer.getStats().retries, 1);

  recoveryRenderer.handle(event('retry_scheduled', {
    attempt: 1,
    nextAttempt: 2,
    delayMs: 0,
    reason: 'unsupported_feature'
  }));
  assert.equal(recoverySpinner.text, 'Adjusting provider compatibility...');
  assert.equal(recoveryChunks.join(''), '');
  assert.equal(recoveryRenderer.getStats().retries, 2);
});
