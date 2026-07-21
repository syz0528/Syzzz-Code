import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAICompatibleProvider,
  convertMessagesToOpenAI,
  convertToolsToOpenAI
} from '../dist/providers/openai-compatible.js';
import {
  convertMessagesToAnthropic,
  convertToolsToAnthropic
} from '../dist/providers/anthropic.js';

const messages = [
  { role: 'user', content: 'Read package.json' },
  {
    role: 'assistant',
    content: '',
    reasoningContent: 'Need to inspect the package before answering.',
    toolCalls: [
      {
        id: 'call-1',
        name: 'Read',
        input: { path: 'package.json' }
      }
    ]
  },
  {
    role: 'tool',
    toolCallId: 'call-1',
    toolName: 'Read',
    content: '{"name":"syzzz-code"}'
  }
];

const tools = [
  {
    name: 'Read',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path']
    }
  }
];

test('converts tool history to OpenAI message protocol', () => {
  assert.deepEqual(convertMessagesToOpenAI(messages, 'System prompt'), [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Read package.json' },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need to inspect the package before answering.',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'Read',
            arguments: '{"path":"package.json"}'
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"name":"syzzz-code"}'
    }
  ]);
});

test('converts tools to OpenAI function definitions', () => {
  assert.deepEqual(convertToolsToOpenAI(tools), [
    {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file',
        parameters: tools[0].inputSchema
      }
    }
  ]);
});

test('converts tool history to Anthropic message protocol', () => {
  assert.deepEqual(convertMessagesToAnthropic(messages), [
    { role: 'user', content: 'Read package.json' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'Read',
          input: { path: 'package.json' }
        }
      ]
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: '{"name":"syzzz-code"}'
        }
      ]
    }
  ]);
});

test('converts tools to Anthropic definitions', () => {
  assert.deepEqual(convertToolsToAnthropic(tools), [
    {
      name: 'Read',
      description: 'Read a file',
      input_schema: tools[0].inputSchema
    }
  ]);
});

test('preserves tool error semantics across provider protocols', () => {
  const errorMessages = [
    { role: 'user', content: 'Read a missing file' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'error-1', name: 'Read', input: { path: 'missing.txt' } }]
    },
    {
      role: 'tool',
      toolCallId: 'error-1',
      toolName: 'Read',
      content: 'Read failed: file not found',
      isError: true
    }
  ];

  assert.deepEqual(convertMessagesToOpenAI(errorMessages, 'System prompt').at(-1), {
    role: 'tool',
    tool_call_id: 'error-1',
    content: 'Read failed: file not found'
  });
  assert.deepEqual(convertMessagesToAnthropic(errorMessages).at(-1), {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'error-1',
        content: 'Read failed: file not found',
        is_error: true
      }
    ]
  });
});

function createProviderWithResponses(responses) {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'deepseek-v4-flash-free',
    'Deepseek'
  );
  const requests = [];

  provider.client = {
    chat: {
      completions: {
        create: async request => {
          requests.push(request);
          const response = responses.shift();
          if (response instanceof Error) {
            throw response;
          }
          return response;
        }
      }
    }
  };

  return { provider, requests };
}

function completion(message, finishReason = 'stop') {
  return {
    choices: [{ message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    }
  };
}

const basicRequest = {
  messages: [{ role: 'user', content: '你好？' }],
  tools,
  systemPrompt: 'You are a coding assistant.'
};

test('recovers a reasoning-only stop once with thinking disabled', async () => {
  const { provider, requests } = createProviderWithResponses([
    completion({ role: 'assistant', content: '', reasoning_content: 'Private reasoning.' }),
    completion({ role: 'assistant', content: '你好！' })
  ]);

  const result = await provider.chat(basicRequest);

  assert.equal(result.message.content, '你好！');
  assert.equal(result.message.reasoningContent, undefined);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'deepseek-v4-flash-free');
  assert.equal(requests[0].thinking, undefined);
  assert.equal(requests[1].model, 'deepseek-v4-flash-free');
  assert.deepEqual(requests[1].thinking, { type: 'disabled' });
  assert.deepEqual(requests[1].messages, requests[0].messages);
  assert.deepEqual(requests[1].tools, requests[0].tools);
});

test('preserves reasoning metadata for tool calls without retrying', async () => {
  const { provider, requests } = createProviderWithResponses([
    completion({
      role: 'assistant',
      content: '',
      reasoning_content: 'I need to inspect the file.',
      tool_calls: [{
        id: 'call-2',
        type: 'function',
        function: {
          name: 'Read',
          arguments: '{"path":"package.json"}'
        }
      }]
    }, 'tool_calls')
  ]);

  const result = await provider.chat(basicRequest);

  assert.equal(requests.length, 1);
  assert.equal(result.message.reasoningContent, 'I need to inspect the file.');
  assert.deepEqual(result.message.toolCalls, [{
    id: 'call-2',
    name: 'Read',
    input: { path: 'package.json' }
  }]);
});

test('fails clearly when the single empty-response recovery is exhausted', async () => {
  const { provider, requests } = createProviderWithResponses([
    completion({ role: 'assistant', content: '', reasoning_content: 'First reasoning.' }),
    completion({ role: 'assistant', content: '', reasoning_content: 'Second reasoning.' })
  ]);

  await assert.rejects(
    provider.chat(basicRequest),
    /Deepseek API Error: Provider returned an empty response after one recovery attempt/
  );
  assert.equal(requests.length, 2);
});
