import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAICompatibleProvider
} from '../dist/providers/openai-compatible.js';

function streamFrom(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
  };
}

async function collect(generator) {
  const deltas = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { deltas, response: next.value };
    }
    deltas.push(next.value);
  }
}

const basicRequest = {
  messages: [{ role: 'user', content: 'read a file' }],
  tools: [{
    name: 'Read',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }],
  systemPrompt: 'system'
};

test('runtime model switching updates OpenAI-compatible capabilities', () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'generic-model',
    'OpenCode',
    undefined,
    {
      'generic-model': 65_536,
      'deepseek-v4-flash': 128_000
    }
  );

  assert.equal(provider.getInfo().model, 'generic-model');
  assert.equal(provider.getInfo().contextWindowTokens, 65_536);
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
  provider.setModel('deepseek-v4-flash');
  assert.equal(provider.getInfo().model, 'deepseek-v4-flash');
  assert.equal(provider.getInfo().contextWindowTokens, 128_000);
  assert.equal(provider.getInfo().capabilities.reasoningToggle, true);
  assert.throws(() => provider.setModel('   '), /non-empty string/);
});

test('streaming aggregates reasoning, usage and tool fragments', async () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'deepseek-v4-flash-free',
    'Deepseek'
  );
  assert.equal(provider.client.maxRetries, 0);
  const requests = [];
  const chunks = [
    {
      id: 'chat-1',
      model: 'reported-model',
      choices: [{
        index: 0,
        finish_reason: null,
        delta: { reasoning_content: 'private ' }
      }]
    },
    {
      id: 'chat-1',
      model: 'reported-model',
      choices: [{
        index: 0,
        finish_reason: null,
        delta: {
          reasoning_content: 'thought',
          tool_calls: [{
            index: 0,
            id: 'call-1',
            type: 'function',
            function: {
              name: 'Re',
              arguments: '{"pa'
            }
          }]
        }
      }]
    },
    {
      id: 'chat-1',
      model: 'reported-model',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              name: 'ad',
              arguments: 'th":"package.json"}'
            }
          }]
        }
      }]
    },
    {
      id: 'chat-1',
      model: 'reported-model',
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    }
  ];
  provider.client = {
    chat: {
      completions: {
        create(request) {
          requests.push(request);
          return {
            async withResponse() {
              return {
                data: streamFrom(chunks),
                request_id: 'req-stream'
              };
            }
          };
        }
      }
    }
  };

  const { deltas, response } = await collect(provider.chatStream(
    basicRequest,
    {
      signal: new AbortController().signal,
      attempt: 1,
      attemptId: 'attempt-1',
      includeUsage: true,
      disableReasoning: false
    }
  ));

  assert.equal(requests[0].stream, true);
  assert.deepEqual(requests[0].stream_options, {
    include_usage: true
  });
  assert.equal(requests[0].thinking, undefined);
  assert.deepEqual(response.message.toolCalls, [{
    id: 'call-1',
    name: 'Read',
    input: { path: 'package.json' }
  }]);
  assert.equal(
    response.message.reasoningContent,
    'private thought'
  );
  assert.deepEqual(response.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15
  });
  assert.equal(response.finishReason, 'tool_calls');
  assert.equal(response.requestId, 'req-stream');
  assert.equal(response.reportedModel, 'reported-model');
  assert.deepEqual(deltas.map(delta => delta.type), [
    'reasoning_delta',
    'reasoning_delta',
    'tool_call_delta',
    'tool_call_delta',
    'usage'
  ]);
});

test('detects a DeepSeek V4 thinking toggle behind a neutral gateway', () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'deepseek-v4-flash',
    'OpenCode'
  );

  assert.equal(provider.getInfo().capabilities.reasoningToggle, true);
});

test('streaming can disable reasoning and omit stream_options', async () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'model',
    'Compatible'
  );
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
  let capturedRequest;
  provider.client = {
    chat: {
      completions: {
        create(request) {
          capturedRequest = request;
          return streamFrom([{
            id: 'chat-2',
            model: 'model',
            choices: [{
              index: 0,
              finish_reason: 'stop',
              delta: { content: 'hello' }
            }]
          }]);
        }
      }
    }
  };

  const { response } = await collect(provider.chatStream(
    basicRequest,
    {
      signal: new AbortController().signal,
      attempt: 2,
      attemptId: 'attempt-2',
      includeUsage: false,
      disableReasoning: true
    }
  ));

  assert.equal(capturedRequest.stream_options, undefined);
  assert.deepEqual(capturedRequest.thinking, {
    type: 'disabled'
  });
  assert.equal(response.message.content, 'hello');
});

test('streaming rejects malformed aggregated tool JSON', async () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'model',
    'Compatible'
  );
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
  provider.client = {
    chat: {
      completions: {
        create() {
          return streamFrom([{
            id: 'chat-3',
            model: 'model',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call-bad',
                  function: {
                    name: 'Read',
                    arguments: '{bad'
                  }
                }]
              }
            }]
          }]);
        }
      }
    }
  };

  await assert.rejects(
    collect(provider.chatStream(basicRequest, {
      signal: new AbortController().signal,
      attempt: 1,
      attemptId: 'attempt-bad',
      includeUsage: false,
      disableReasoning: false
    })),
    error => error?.code === 'malformed_response'
  );
});
