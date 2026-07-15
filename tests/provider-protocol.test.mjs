import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
