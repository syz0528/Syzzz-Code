import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AnthropicProvider } from '../dist/providers/anthropic.js';
import { runProviderRequest } from '../dist/providers/runner.js';
import { anthropicEvent, anthropicEvents } from './support/anthropic-sse.mjs';

const input = (overrides = {}) => ({
  systemPrompt: 'fixture system',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  ...overrides
});
const message = (content = [{ type: 'text', text: 'Unicode 中文 OK' }], stop = 'end_turn') => ({
  id: 'msg-fixture',
  type: 'message',
  role: 'assistant',
  model: 'reported-claude',
  content,
  stop_reason: stop,
  usage: { input_tokens: 7, output_tokens: 3 }
});
const attempts = { maxAttempts: 3, sleep: async () => {} };

async function fixture(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, path: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    respond(res, requests.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    requests,
    provider: new AnthropicProvider(
      'dummy-key',
      `http://127.0.0.1:${server.address().port}/gateway/v1`,
      'claude-test',
      {},
      { 'x-client-fixture': 'fixture-value' }
    )
  };
}

function send(res, events, end = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req-stream' });
  res.write(events.map(anthropicEvent).join(''));
  if (end) res.end();
}

for (const streaming of [false, true])
  test(`Anthropic forwards explicit tool closure (${streaming ? 'stream' : 'chat'}) and leaves defaults unchanged`, async (t) => {
    const { provider, requests } = await fixture(t, (res) => {
      if (streaming) send(res, anthropicEvents(message()));
      else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(message()));
      }
    });
    for (const toolChoice of ['none', undefined]) {
      const request = input(toolChoice ? { toolChoice } : {});
      if (streaming) {
        const run = runProviderRequest(provider, request);
        while (!(await run.next()).done) {}
      } else await provider.chat(request);
    }
    assert.deepEqual(requests[0].body.tool_choice, { type: 'none' });
    assert.equal(requests[0].body.tools, undefined);
    assert.equal(requests[1].body.tool_choice, undefined);
  });

test('Anthropic normalizes root, versioned and full Messages URLs without duplicating v1', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    requests.push({
      path: request.url,
      body: JSON.parse(Buffer.concat(parts).toString()),
      header: request.headers['x-test-header']
    });
    if (request.url !== '/zen/v1/messages' && request.url !== '/v1/messages') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'not_found_error', message: 'not found' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        model: 'union-alpha',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 }
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const prefix of ['', '/zen']) {
      for (const suffix of ['', '/', '/v1', '/v1/', '/v1/messages', '/v1/messages/']) {
        for (const headers of [undefined, { 'x-test-header': 'test-value' }]) {
          const provider = new AnthropicProvider(
            'test-key',
            origin + prefix + suffix,
            'union-alpha',
            {},
            headers
          );
          for (const instance of [provider, provider.fork()]) {
            const result = await instance.chat({
              systemPrompt: 'system',
              messages: [{ role: 'user', content: 'test' }],
              tools: [],
              maxOutputTokens: 16
            });
            assert.equal(result.message.content, 'OK');
            assert.equal(requests.at(-1).path, prefix + '/v1/messages');
            assert.equal(requests.at(-1).body.model, 'union-alpha');
            assert.equal(requests.at(-1).header, headers?.['x-test-header']);
          }
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Anthropic URL normalization preserves proxy prefixes and only strips terminal API suffixes', () => {
  for (const [base, expected] of [
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://opencode.ai/zen/v1', 'https://opencode.ai/zen/v1/messages'],
    [
      'https://proxy.invalid/api/anthropic/v1/messages',
      'https://proxy.invalid/api/anthropic/v1/messages'
    ],
    ['https://proxy.invalid/v1/proxy', 'https://proxy.invalid/v1/proxy/v1/messages'],
    ['https://proxy.invalid/v10', 'https://proxy.invalid/v10/v1/messages']
  ]) {
    const provider = new AnthropicProvider('key', base, 'test-model');
    assert.equal(provider.client.buildURL('/v1/messages'), expected);
  }
});

async function collect(generator) {
  const events = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { events, response: next.value };
    }
    events.push(next.value);
  }
}

test('Anthropic preserves direct non-streaming chat alongside streaming capability', async () => {
  const provider = new AnthropicProvider('test-key', 'https://example.invalid', 'claude-test');
  assert.equal(provider.client.maxRetries, 0);
  assert.deepEqual(provider.getInfo(), {
    name: 'Anthropic Claude',
    type: 'anthropic',
    model: 'claude-test',
    capabilities: {
      streaming: true,
      reasoningToggle: false
    }
  });

  let capturedRequest;
  provider.client = {
    messages: {
      create(request) {
        capturedRequest = request;
        return {
          async withResponse() {
            return {
              data: {
                id: 'message-1',
                model: 'reported-claude',
                content: [
                  {
                    type: 'text',
                    text: 'Anthropic response.'
                  }
                ],
                stop_reason: 'end_turn',
                usage: {
                  input_tokens: 7,
                  output_tokens: 3
                }
              },
              response: {
                headers: {
                  get(name) {
                    return name === 'request-id' ? 'req-anthropic' : null;
                  }
                }
              }
            };
          }
        };
      }
    }
  };

  const response = await provider.chat({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    systemPrompt: 'system'
  });

  assert.equal(capturedRequest.model, 'claude-test');
  assert.equal(response.message.content, 'Anthropic response.');
  assert.equal(response.requestId, 'req-anthropic');
  assert.equal(response.reportedModel, 'reported-claude');
  assert.deepEqual(response.usage, {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10
  });
});

test('Anthropic model switching updates provider information', () => {
  const provider = new AnthropicProvider('test-key', 'https://example.invalid', 'claude-before', {
    'claude-before': 100_000,
    'claude-after': 200_000
  });

  assert.equal(provider.getInfo().contextWindowTokens, 100_000);
  provider.setModel('claude-after');
  assert.equal(provider.getInfo().model, 'claude-after');
  assert.equal(provider.getInfo().contextWindowTokens, 200_000);
  assert.equal(provider.getInfo().capabilities.streaming, true);
  assert.throws(() => provider.setModel(''), /non-empty string/);
});

test(
  'Anthropic emits Unicode text before HTTP completion and preserves wire contract',
  { timeout: 5000 },
  async (t) => {
    let finish;
    const events = anthropicEvents(message());
    const { provider, requests } = await fixture(t, (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req-stream' });
      res.write(events.slice(0, 2).map(anthropicEvent).join(''));
      const chunk = Buffer.from(
        anthropicEvent({ ...events[2], delta: { type: 'text_delta', text: '中文' } })
      );
      const split = chunk.indexOf(Buffer.from('中')) + 1;
      res.write(chunk.subarray(0, split));
      res.write(chunk.subarray(split));
      finish = () =>
        res.end(
          [
            anthropicEvent({ ...events[3], delta: { type: 'text_delta', text: ' OK' } }),
            ...events.slice(4).map(anthropicEvent)
          ].join('')
        );
    });
    const generator = runProviderRequest(
      provider,
      input({ maxOutputTokens: 128, stopSequences: ['END'] })
    );
    assert.equal((await generator.next()).value.type, 'request_started');
    const first = await generator.next();
    assert.equal(first.value.type, 'text_delta');
    assert.equal(first.value.delta, '中文');
    finish();
    const { response, events: rest } = await collect(generator);
    assert.equal(response.message.content, '中文 OK');
    assert.equal(response.requestId, 'req-stream');
    assert.equal(response.reportedModel, 'reported-claude');
    assert.deepEqual(response.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    assert.equal(rest.filter((e) => e.type === 'usage').length, 1);
    assert.equal(requests[0].path, '/gateway/v1/messages');
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.max_tokens, 128);
    assert.deepEqual(requests[0].body.stop_sequences, ['END']);
    assert.equal(requests[0].body.tools, undefined);
    assert.equal(requests[0].headers['x-api-key'], 'dummy-key');
    assert.equal(requests[0].headers['x-client-fixture'], 'fixture-value');
  }
);

test('Anthropic aggregates multiple tool blocks and replays tool results without merging arguments', async (t) => {
  const blocks = [
    { type: 'text', text: 'Reading' },
    { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: '中文.md' } },
    { type: 'tool_use', id: 'call-2', name: 'Grep', input: { pattern: 'needle' } }
  ];
  const { provider, requests } = await fixture(t, (res, n) =>
    send(res, anthropicEvents(n === 1 ? message(blocks, 'tool_use') : message()))
  );
  const result = await collect(runProviderRequest(provider, input(), attempts));
  assert.equal(result.response.message.toolCalls.length, 2);
  assert.deepEqual(
    result.response.message.toolCalls.map((c) => c.input),
    [{ path: '中文.md' }, { pattern: 'needle' }]
  );
  assert.deepEqual(
    result.events
      .filter((e) => e.type === 'tool_call_delta' && e.delta.id)
      .map((e) => e.delta.index),
    [1, 2]
  );
  await collect(
    runProviderRequest(
      provider.fork(),
      input({
        messages: [
          ...input().messages,
          result.response.message,
          ...result.response.message.toolCalls.map((c) => ({
            role: 'tool',
            toolCallId: c.id,
            toolName: c.name,
            content: 'result'
          }))
        ]
      })
    )
  );
  assert.equal(requests[1].body.messages.at(-1).content.length, 2);
  assert.equal(requests[1].headers['x-client-fixture'], 'fixture-value');
});

for (const scenario of [
  'eof',
  'missing-stop-reason',
  'open-block',
  'invalid-json',
  'array-tool',
  'duplicate-tool',
  'wrong-index',
  'tool-truncated',
  'empty',
  'reasoning-only',
  'invalid-sse'
]) {
  test(`Anthropic rejects ${scenario} without committing or retrying`, async (t) => {
    const events = anthropicEvents(message());
    let wire = events;
    if (scenario === 'eof') wire = events.slice(0, -1);
    if (scenario === 'missing-stop-reason') wire = events.filter((e) => e.type !== 'message_delta');
    if (scenario === 'open-block') wire = events.filter((e) => e.type !== 'content_block_stop');
    if (scenario === 'wrong-index') wire[2] = { ...wire[2], index: 9 };
    if (scenario === 'empty') wire = anthropicEvents(message([]));
    if (['invalid-json', 'array-tool', 'duplicate-tool', 'tool-truncated'].includes(scenario)) {
      wire = anthropicEvents(
        message([{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }], 'tool_use')
      );
      if (scenario === 'invalid-json') wire[2].delta.partial_json = '{broken';
      if (scenario === 'array-tool') {
        wire[2].delta.partial_json = '[';
        wire[3].delta.partial_json = ']';
      }
      if (scenario === 'duplicate-tool') wire.splice(5, 0, { ...wire[1], index: 1 });
      if (scenario === 'tool-truncated') wire.at(-2).delta.stop_reason = 'max_tokens';
    }
    if (scenario === 'reasoning-only')
      wire = [
        events[0],
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'PRIVATE_REASONING' }
        },
        { type: 'content_block_stop', index: 0 },
        ...events.slice(-2)
      ];
    const { provider, requests } = await fixture(t, (res) => {
      if (scenario === 'invalid-sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_start\ndata: {secret-invalid-json\n\n');
      } else send(res, wire);
    });
    const seen = [];
    await assert.rejects(
      async () => {
        for await (const e of runProviderRequest(provider, input(), attempts)) seen.push(e);
      },
      { code: 'malformed_response' }
    );
    assert.equal(requests.length, 1);
    assert.ok(!seen.some((e) => e.type === 'request_completed'));
    assert.doesNotMatch(JSON.stringify(seen), /PRIVATE_REASONING|secret-invalid-json/);
  });
}

for (const unavailable of [false, true]) {
  test(`Anthropic HTTP 400 distinguishes model availability (${unavailable}) without leaking or retrying`, async (t) => {
    const { provider, requests } = await fixture(t, (res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: unavailable
              ? 'Error from provider (Console): Upstream request failed: Model is unavailable. private-prompt'
              : 'invalid parameters private-prompt fixture-value'
          }
        })
      );
    });
    const expected = unavailable ? 'model_unavailable' : 'invalid_request';
    for (const run of [
      () => provider.chat(input()),
      () => collect(runProviderRequest(provider, input(), attempts))
    ]) {
      const before = requests.length;
      await assert.rejects(run, (error) => {
        assert.equal(error.code, expected);
        assert.equal(error.status, 400);
        assert.match(error.message, /HTTP 400/);
        assert.doesNotMatch(error.message, /private-prompt|fixture-value/);
        return true;
      });
      assert.equal(requests.length, before + 1);
    }
  });
}

for (const status of [401, 403, 429, 503, 529, 'overloaded_error', 'rate_limit_error']) {
  test(`Anthropic ${status} uses only bounded Runtime retries`, async (t) => {
    const { provider, requests } = await fixture(t, (res, n) => {
      if (n > 1) {
        send(res, anthropicEvents(message()));
        return;
      }
      if (typeof status === 'string') {
        send(res, [{ type: 'error', error: { type: status, message: 'private-upstream-detail' } }]);
      } else {
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'fixture_error', message: 'private-upstream-detail' }
          })
        );
      }
    });
    if (status === 401 || status === 403) {
      await assert.rejects(collect(runProviderRequest(provider, input(), attempts)), {
        code: status === 401 ? 'authentication' : 'permission'
      });
      assert.equal(requests.length, 1);
    } else {
      const result = await collect(runProviderRequest(provider, input(), attempts));
      assert.equal(requests.length, 2);
      assert.equal(result.events.filter((e) => e.type === 'retry_scheduled').length, 1);
      assert.doesNotMatch(JSON.stringify(result.events), /private-upstream-detail/);
    }
  });
}

test('Anthropic stream error after text never replays visible output', async (t) => {
  const { provider, requests } = await fixture(t, (res) =>
    send(res, [
      ...anthropicEvents(message()).slice(0, 3),
      { type: 'error', error: { type: 'overloaded_error', message: 'private' } }
    ])
  );
  const seen = [];
  await assert.rejects(
    async () => {
      for await (const e of runProviderRequest(provider, input(), attempts)) seen.push(e);
    },
    { code: 'provider_internal' }
  );
  assert.equal(requests.length, 1);
  assert.equal(seen.filter((e) => e.type === 'text_delta').length, 1);
});

for (const action of ['cancel', 'close', 'timeout']) {
  test(`Anthropic ${action} releases a pending HTTP stream`, { timeout: 5000 }, async (t) => {
    let disconnected;
    const closed = new Promise((resolve) => {
      disconnected = resolve;
    });
    const { provider, requests } = await fixture(t, (res) => {
      res.on('close', disconnected);
      send(res, anthropicEvents(message()).slice(0, 3), false);
    });
    const controller = new AbortController();
    const generator = runProviderRequest(provider, input({ signal: controller.signal }), {
      maxAttempts: 1,
      attemptTimeoutMs: action === 'timeout' ? 150 : 4000
    });
    await generator.next();
    assert.equal((await generator.next()).value.type, 'text_delta');
    if (action === 'close') await generator.return();
    else {
      const pending = collect(generator);
      if (action === 'cancel') controller.abort();
      await assert.rejects(pending, action === 'timeout' ? { code: 'timeout' } : /abort|cancel/i);
    }
    await closed;
    assert.equal(requests.length, 1);
  });
}
