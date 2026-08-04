import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../dist/config.js';
import { createProvider } from '../dist/providers/factory.js';
import {
  convertMessagesToResponses,
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
