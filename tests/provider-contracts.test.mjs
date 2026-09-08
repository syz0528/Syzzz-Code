import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicProvider } from '../dist/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../dist/providers/openai-compatible.js';
import { runProviderRequest } from '../dist/providers/runner.js';
import { startProviderFixture } from './support/provider-fixture.mjs';

const tool = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' }
    },
    required: ['path']
  }
};
const grepTool = {
  name: 'Grep',
  description: 'Search files',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' }
    },
    required: ['pattern']
  }
};

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

function request(content, tools = []) {
  return {
    messages: [{ role: 'user', content }],
    tools,
    systemPrompt: 'Contract test',
    signal: new AbortController().signal
  };
}

test('standard OpenAI-compatible HTTP streaming preserves Unicode, usage and metadata', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    const { events, response } = await collect(
      runProviderRequest(provider, request('text-contract'), {
        idFactory: () => 'attempt-contract'
      })
    );

    assert.equal(response.message.content, '兼容_OK');
    assert.equal(response.finishReason, 'stop');
    assert.equal(response.reportedModel, 'openai-contract-model');
    assert.equal(response.requestId, 'request-contract-text');
    assert.deepEqual(response.usage, {
      inputTokens: 11,
      outputTokens: 3,
      totalTokens: 14
    });
    assert.equal(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.delta)
        .join(''),
      '兼容_OK'
    );
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.requests[0].body.stream_options, { include_usage: true });
    assert.equal(fixture.requests[0].headers.authorization, 'Bearer contract-secret');
  } finally {
    await fixture.close();
  }
});

test('standard OpenAI-compatible HTTP streaming aggregates fragmented tool calls', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    const { events, response } = await collect(
      runProviderRequest(provider, request('tool-contract', [tool]))
    );

    assert.deepEqual(response.message.toolCalls, [
      {
        id: 'call_contract',
        name: 'Read',
        input: { path: 'README.md' }
      }
    ]);
    assert.equal(response.finishReason, 'tool_calls');
    assert.ok(events.some((event) => event.type === 'tool_call_delta'));
    assert.deepEqual(fixture.requests[0].body.tools[0].function.name, 'Read');
  } finally {
    await fixture.close();
  }
});

test('OpenAI-compatible HTTP streaming keeps interleaved tool calls separated by index', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    const { response } = await collect(
      runProviderRequest(provider, request('multi-tool-contract', [tool, grepTool]))
    );

    assert.deepEqual(response.message.toolCalls, [
      {
        id: 'call_contract',
        name: 'Read',
        input: { path: 'README.md' }
      },
      {
        id: 'call_contract_2',
        name: 'Grep',
        input: { pattern: 'tax' }
      }
    ]);
  } finally {
    await fixture.close();
  }
});

test('OpenAI-compatible usage is optional when the endpoint omits the tail packet', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    const { events, response } = await collect(runProviderRequest(provider, request('no-usage')));

    assert.equal(response.usage, undefined);
    assert.equal(
      events.some((event) => event.type === 'usage'),
      false
    );
    assert.equal(response.finishReason, 'stop');
  } finally {
    await fixture.close();
  }
});

test('OpenAI-compatible early EOF fails after visible text without retrying', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    await assert.rejects(
      collect(runProviderRequest(provider, request('early-eof'))),
      (error) => error?.code === 'malformed_response'
    );
    assert.equal(fixture.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test('OpenAI-compatible completion tolerates a missing finish reason when usage closes the stream', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    const { response } = await collect(
      runProviderRequest(provider, request('usage-without-finish'))
    );

    assert.equal(response.message.content, 'usage-confirmed');
    assert.equal(response.finishReason, 'stop');
    assert.deepEqual(response.usage, {
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9
    });
  } finally {
    await fixture.close();
  }
});

test('minimal OpenAI-compatible endpoints recover once without stream_options', async () => {
  const fixture = await startProviderFixture('openai-compatible-minimal');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'minimal-contract-model',
      'Minimal Contract'
    );
    const { events, response } = await collect(
      runProviderRequest(provider, request('minimal-contract'), {
        baseDelayMs: 0,
        sleep: async () => undefined
      })
    );

    assert.equal(response.message.content, '兼容_OK');
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(fixture.requests[0].body.stream_options, { include_usage: true });
    assert.equal('stream_options' in fixture.requests[1].body, false);
    assert.ok(
      events.some(
        (event) =>
          event.type === 'request_failed' &&
          event.error.code === 'unsupported_feature' &&
          event.willRetry
      )
    );
  } finally {
    await fixture.close();
  }
});

test('DeepSeek reasoning-only HTTP response recovers without leaking reasoning deltas', async () => {
  const fixture = await startProviderFixture('deepseek-reasoning');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'deepseek-v4-contract',
      'DeepSeek Contract',
      true
    );
    const { events, response } = await collect(
      runProviderRequest(provider, request('reasoning-contract'), {
        baseDelayMs: 0,
        sleep: async () => undefined
      })
    );

    assert.equal(response.message.content, '恢复_OK');
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[1].body.thinking.type, 'disabled');
    assert.equal(
      events.some((event) => event.type === 'text_delta' && event.delta.includes('private')),
      false
    );
    assert.ok(events.some((event) => event.type === 'reasoning_status'));
  } finally {
    await fixture.close();
  }
});

test('OpenAI-compatible HTTP errors retry through the shared runner without replaying tools', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    const { events, response } = await collect(
      runProviderRequest(provider, request('rate-limit'), {
        baseDelayMs: 0,
        sleep: async () => undefined
      })
    );

    assert.equal(response.message.content, '兼容_OK');
    assert.equal(fixture.requests.length, 2);
    assert.ok(
      events.some((event) => event.type === 'request_failed' && event.error.code === 'rate_limit')
    );
  } finally {
    await fixture.close();
  }
});

test('OpenAI-compatible HTTP status failures preserve stable public categories', async () => {
  const cases = [
    [401, 'authentication'],
    [403, 'permission'],
    [404, 'not_found'],
    [500, 'provider_internal'],
    [502, 'provider_internal'],
    [503, 'provider_internal'],
    [504, 'provider_internal']
  ];

  for (const [status, code] of cases) {
    const fixture = await startProviderFixture('openai-chat-completions');
    try {
      const provider = new OpenAICompatibleProvider(
        'contract-secret',
        fixture.openAIBaseURL,
        'openai-contract-model',
        'OpenAI Contract'
      );
      await assert.rejects(
        collect(
          runProviderRequest(provider, request(`http-${status}`), {
            maxAttempts: 1
          })
        ),
        (error) => error?.code === code && error?.status === status
      );
      assert.equal(fixture.requests.length, 1);
    } finally {
      await fixture.close();
    }
  }
});

test('OpenAI-compatible network resets retry through a fresh HTTP request', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    const { events, response } = await collect(
      runProviderRequest(provider, request('network-reset'), {
        baseDelayMs: 0,
        sleep: async () => undefined
      })
    );

    assert.equal(response.message.content, '兼容_OK');
    assert.equal(fixture.requests.length, 2);
    assert.ok(
      events.some((event) => event.type === 'request_failed' && event.error.code === 'network')
    );
  } finally {
    await fixture.close();
  }
});

test('OpenAI-compatible attempt timeout aborts the request before retrying', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    const { events, response } = await collect(
      runProviderRequest(provider, request('timeout-once'), {
        attemptTimeoutMs: 50,
        baseDelayMs: 0,
        sleep: async () => undefined
      })
    );

    assert.equal(response.message.content, '兼容_OK');
    assert.equal(fixture.requests.length, 2);
    assert.ok(
      events.some((event) => event.type === 'request_failed' && event.error.code === 'timeout')
    );
  } finally {
    await fixture.close();
  }
});

test('malformed OpenAI-compatible SSE fails with a bounded provider error', async () => {
  const fixture = await startProviderFixture('openai-chat-completions');
  try {
    const provider = new OpenAICompatibleProvider(
      'contract-secret',
      fixture.openAIBaseURL,
      'openai-contract-model',
      'OpenAI Contract'
    );
    await assert.rejects(
      collect(
        runProviderRequest(provider, request('malformed'), {
          maxAttempts: 1
        })
      ),
      (error) => {
        assert.equal(error.code, 'malformed_response');
        assert.notEqual(error.message.includes('contract-secret'), true);
        return true;
      }
    );
  } finally {
    await fixture.close();
  }
});

test('Anthropic Messages HTTP contract preserves text, usage and request metadata', async () => {
  const fixture = await startProviderFixture('anthropic-messages');
  try {
    const provider = new AnthropicProvider(
      'anthropic-contract-secret',
      fixture.origin,
      'claude-contract'
    );
    const { response } = await collect(runProviderRequest(provider, request('anthropic-contract')));

    assert.equal(response.message.content, 'ANTHROPIC_OK');
    assert.equal(response.finishReason, 'end_turn');
    assert.equal(response.reportedModel, 'claude-contract');
    assert.equal(response.requestId, 'request-anthropic-contract');
    assert.deepEqual(response.usage, {
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13
    });
    assert.equal(fixture.requests[0].headers['x-api-key'], 'anthropic-contract-secret');
  } finally {
    await fixture.close();
  }
});

test('Anthropic Messages HTTP contract preserves tool use and authentication errors', async () => {
  const fixture = await startProviderFixture('anthropic-messages');
  try {
    const provider = new AnthropicProvider(
      'anthropic-contract-secret',
      fixture.origin,
      'claude-contract'
    );
    const { response } = await collect(
      runProviderRequest(provider, request('tool-contract', [tool]))
    );

    assert.deepEqual(response.message.toolCalls, [
      {
        id: 'toolu_contract',
        name: 'Read',
        input: { path: 'README.md' }
      }
    ]);
    assert.equal(response.finishReason, 'tool_use');

    await assert.rejects(
      collect(
        runProviderRequest(provider, request('anthropic-error-401'), {
          maxAttempts: 1
        })
      ),
      (error) => error?.code === 'authentication' && error?.status === 401
    );
  } finally {
    await fixture.close();
  }
});
