import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../dist/config.js';
import { createProvider } from '../dist/providers/factory.js';
import {
  convertMessagesToResponses,
  convertToolsToResponses,
  normalizeResponsesBaseURL,
  OpenAIResponsesProvider
} from '../dist/providers/openai-responses.js';
import { runProviderRequest } from '../dist/providers/runner.js';
import { startProviderFixture } from './support/provider-fixture.mjs';

const readTool = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path']
  }
};

function request(content, tools = []) {
  return {
    messages: [{ role: 'user', content }],
    tools,
    systemPrompt: 'Responses contract test',
    signal: new AbortController().signal
  };
}

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

for (const streaming of [false, true])
  test(`Responses forwards explicit tool closure (${streaming ? 'stream' : 'chat'}) and preserves ordinary requests`, async () => {
    const fixture = await startProviderFixture('openai-responses');
    try {
      const provider = new OpenAIResponsesProvider(
        'fixture-key',
        fixture.openAIBaseURL,
        'responses-test'
      );
      for (const toolChoice of ['none', undefined]) {
        const input = { ...request('hello'), ...(toolChoice ? { toolChoice } : {}) };
        if (streaming) await collect(runProviderRequest(provider, input));
        else await provider.chat(input);
      }
      assert.equal(fixture.requests[0].body.tool_choice, 'none');
      assert.equal(fixture.requests[0].body.tools, undefined);
      assert.equal(fixture.requests[1].body.tool_choice, undefined);
    } finally {
      await fixture.close();
    }
  });

test('OpenAI Responses streams semantic text, usage, model and request metadata', async () => {
  const fixture = await startProviderFixture('openai-responses');
  try {
    const provider = new OpenAIResponsesProvider(
      'responses-secret',
      `${fixture.openAIBaseURL}/responses`,
      'gpt-responses-contract',
      'Responses Contract'
    );
    const { events, response } = await collect(runProviderRequest(provider, request('hello')));

    assert.equal(response.message.content, '\u54cd\u5e94_OK');
    assert.equal(response.finishReason, 'completed');
    assert.equal(response.reportedModel, 'gpt-responses-contract');
    assert.equal(response.requestId, 'request-responses-text');
    assert.deepEqual(response.usage, {
      inputTokens: 17,
      outputTokens: 5,
      totalTokens: 22
    });
    assert.equal(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.delta)
        .join(''),
      '\u54cd\u5e94_OK'
    );
    assert.equal(fixture.requests[0].url, '/v1/responses');
    assert.equal(fixture.requests[0].body.instructions, 'Responses contract test');
    assert.deepEqual(fixture.requests[0].body.include, ['reasoning.encrypted_content']);
    assert.equal(fixture.requests[0].body.store, false);
    assert.equal(fixture.requests[0].headers.authorization, 'Bearer responses-secret');
  } finally {
    await fixture.close();
  }
});

test('OpenAI Responses aggregates function calls and replays private output for tool continuation', async () => {
  const fixture = await startProviderFixture('openai-responses');
  try {
    const provider = new OpenAIResponsesProvider(
      'responses-secret',
      fixture.openAIBaseURL,
      'gpt-responses-contract',
      'Responses Contract'
    );
    const first = await collect(runProviderRequest(provider, request('tool-contract', [readTool])));
    assert.deepEqual(first.response.message.toolCalls, [
      { id: 'call_responses_contract', name: 'Read', input: { path: 'README.md' } }
    ]);
    assert.ok(first.response.message.reasoningContent?.startsWith('openai-responses-output-v1:'));
    assert.ok(first.events.some((event) => event.type === 'tool_call_delta'));
    assert.equal(fixture.requests[0].body.tools[0].name, 'Read');
    assert.equal('function' in fixture.requests[0].body.tools[0], false);

    const secondRequest = {
      ...request('unused', [readTool]),
      messages: [
        { role: 'user', content: 'tool-contract' },
        first.response.message,
        {
          role: 'tool',
          toolCallId: 'call_responses_contract',
          toolName: 'Read',
          content: 'README contents'
        }
      ]
    };
    const second = await collect(runProviderRequest(provider, secondRequest));
    assert.equal(second.response.message.content, 'TOOL_RESULT_ACCEPTED');
    const continuation = fixture.requests[1].body.input;
    assert.ok(continuation.some((item) => item.type === 'reasoning'));
    assert.ok(continuation.some((item) => item.type === 'function_call'));
    assert.ok(continuation.some((item) => item.type === 'function_call_output'));
    assert.equal(continuation.filter((item) => item.type === 'function_call').length, 1);
    assert.equal(JSON.stringify(continuation).includes('private reasoning'), false);
  } finally {
    await fixture.close();
  }
});

test('OpenAI Responses supports the non-streaming compatibility method', async () => {
  const fixture = await startProviderFixture('openai-responses');
  try {
    const provider = new OpenAIResponsesProvider(
      'responses-secret',
      fixture.openAIBaseURL,
      'gpt-responses-contract',
      'Responses Contract'
    );
    const response = await provider.chat(request('non-stream'));
    assert.equal(response.message.content, 'RESPONSES_NON_STREAM_OK');
    assert.equal(response.requestId, 'request-responses-non-stream');
    assert.equal(fixture.requests[0].body.stream, undefined);
  } finally {
    await fixture.close();
  }
});

test('OpenAI Responses treats early EOF and response.failed as bounded failures', async () => {
  const fixture = await startProviderFixture('openai-responses');
  try {
    const provider = new OpenAIResponsesProvider(
      'responses-secret',
      fixture.openAIBaseURL,
      'gpt-responses-contract',
      'Responses Contract'
    );
    await assert.rejects(
      collect(runProviderRequest(provider, request('early-eof'))),
      (error) => error?.code === 'malformed_response'
    );
    assert.equal(fixture.requests.length, 1, 'visible text must prevent retries');

    await assert.rejects(
      collect(
        runProviderRequest(provider, request('failed-response'), {
          maxAttempts: 1
        })
      ),
      (error) => error?.code === 'provider_internal'
    );
  } finally {
    await fixture.close();
  }
});

test('OpenAI Responses configuration and factory routing are explicit', () => {
  const raw = {
    currentProvider: 'luna',
    providers: {
      luna: {
        name: 'OpenCode Luna',
        type: 'openai-responses',
        model: 'gpt-5.6-luna',
        models: ['gpt-5.6-luna'],
        env: {
          BASE_URL: 'https://opencode.ai/zen/go/v1/responses',
          API_KEY: 'test-key'
        }
      }
    }
  };
  const config = validateConfig(raw);
  const provider = createProvider(config.providers.luna, {});
  assert.equal(provider.getInfo().type, 'openai-responses');
  assert.equal(provider.getInfo().model, 'gpt-5.6-luna');
  assert.equal(
    normalizeResponsesBaseURL(config.providers.luna.env.BASE_URL),
    'https://opencode.ai/zen/go/v1'
  );
});

test('Responses message conversion does not leak unrelated provider-private metadata', () => {
  assert.deepEqual(
    convertMessagesToResponses([
      { role: 'assistant', content: 'answer', reasoningContent: 'chat-private-reasoning' }
    ]),
    [{ role: 'assistant', content: 'answer' }]
  );
});

test('Responses conversion preserves portable tool history and sanitizes private continuation', () => {
  assert.deepEqual(convertToolsToResponses([readTool]), [
    {
      type: 'function',
      name: 'Read',
      description: 'Read a file',
      parameters: readTool.inputSchema,
      strict: false
    }
  ]);

  assert.deepEqual(
    convertMessagesToResponses([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: 'calling',
        toolCalls: [{ id: 'call-portable', name: 'Read', input: { path: 'README.md' } }]
      },
      {
        role: 'tool',
        toolCallId: 'call-portable',
        toolName: 'Read',
        content: 'contents'
      }
    ]),
    [
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: 'calling' },
      {
        type: 'function_call',
        call_id: 'call-portable',
        name: 'Read',
        arguments: '{"path":"README.md"}'
      },
      { type: 'function_call_output', call_id: 'call-portable', output: 'contents' }
    ]
  );

  const privateOutput =
    'openai-responses-output-v1:' +
    JSON.stringify([
      { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'encrypted' },
      {
        type: 'function_call',
        call_id: 'call-private',
        name: 'Read',
        arguments: '{}'
      },
      { type: 'untrusted-private-shape', secret: 'must-not-pass' }
    ]);
  const converted = convertMessagesToResponses([
    { role: 'assistant', content: 'ignored', reasoningContent: privateOutput }
  ]);
  assert.equal(converted.length, 2);
  assert.equal(converted[0].type, 'reasoning');
  assert.deepEqual(converted[0].summary, []);
  assert.equal(converted[1].type, 'function_call');
  assert.equal(JSON.stringify(converted).includes('must-not-pass'), false);
});

test('OpenAI Responses non-stream parsing supports output fallback and bounded failures', async () => {
  const fixture = await startProviderFixture('openai-responses');
  try {
    const provider = new OpenAIResponsesProvider(
      'responses-secret',
      fixture.openAIBaseURL,
      'gpt-responses-contract',
      'Responses Contract'
    );
    const fallback = await provider.chat(request('non-stream-fallback'));
    assert.equal(fallback.message.content, 'FALLBACK_TEXT');
    assert.equal(fallback.requestId, 'request-responses-fallback');

    const refusal = await provider.chat(request('non-stream-refusal'));
    assert.equal(refusal.message.content, 'REFUSAL_TEXT');

    await assert.rejects(
      provider.chat(request('non-stream-invalid-tool', [readTool])),
      (error) => error?.code === 'malformed_response'
    );
    await assert.rejects(
      provider.chat(request('non-stream-empty')),
      (error) => error?.code === 'malformed_response'
    );
  } finally {
    await fixture.close();
  }
});

test('OpenAI Responses stream handles reasoning, refusal, final fallback, and protocol errors', async () => {
  const fixture = await startProviderFixture('openai-responses');
  try {
    const provider = new OpenAIResponsesProvider(
      'responses-secret',
      fixture.openAIBaseURL,
      'gpt-responses-contract',
      'Responses Contract'
    );
    const semantic = await collect(
      runProviderRequest(provider, request('reasoning-refusal'), { maxAttempts: 1 })
    );
    assert.equal(semantic.response.message.content, 'REFUSED');
    assert.deepEqual(
      semantic.events
        .filter((event) => event.type === 'reasoning_status')
        .map((event) => event.status),
      ['started', 'completed']
    );
    assert.equal(JSON.stringify(semantic.events).includes('PRIVATE_REASONING'), false);
    assert.equal(
      semantic.events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.delta)
        .join(''),
      'REFUSED'
    );

    const finalOnly = await collect(
      runProviderRequest(provider, request('stream-final-only'), { maxAttempts: 1 })
    );
    assert.equal(finalOnly.response.message.content, 'FINAL_ONLY');
    assert.equal(
      finalOnly.events.find((event) => event.type === 'text_delta')?.delta,
      'FINAL_ONLY'
    );

    await assert.rejects(
      collect(runProviderRequest(provider, request('stream-error-rate-limit'), { maxAttempts: 1 })),
      (error) => error?.code === 'rate_limit'
    );
    await assert.rejects(
      collect(runProviderRequest(provider, request('stream-mismatch'), { maxAttempts: 1 })),
      (error) => error?.code === 'malformed_response'
    );
  } finally {
    await fixture.close();
  }
});
