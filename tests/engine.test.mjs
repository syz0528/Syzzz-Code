import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryEngine } from '../dist/engine.js';

test('executes a tool call and preserves structured tool history', async () => {
  const requests = [];
  let requestCount = 0;

  const provider = {
    async chat(request) {
      requests.push(structuredClone(request));
      requestCount += 1;

      if (requestCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'Read',
                input: { path: 'package.json' }
              }
            ]
          }
        };
      }

      return {
        message: {
          role: 'assistant',
          content: 'The project is syzzz-code.'
        }
      };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };

  const readTool = {
    name: 'Read',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path']
    },
    async execute(input) {
      assert.deepEqual(input, { path: 'package.json' });
      return '{"name":"syzzz-code"}';
    }
  };

  const engine = new QueryEngine({
    provider,
    tools: [readTool],
    announceProvider: false
  });

  const response = await engine.chat('What is the project name?');

  assert.equal(response, 'The project is syzzz-code.');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.slice(-2), [
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
  ]);
});

test('does not commit a failed turn to conversation history', async () => {
  const provider = {
    async chat() {
      throw new Error('network failure');
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };

  const engine = new QueryEngine({
    provider,
    tools: [],
    announceProvider: false
  });

  await assert.rejects(() => engine.chat('Hello'), /network failure/);
  assert.deepEqual(engine.getMessages(), []);
});

test('rejects a second message while a turn is still processing', async () => {
  let finishRequest;
  const provider = {
    chat() {
      return new Promise(resolve => {
        finishRequest = resolve;
      });
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };

  const engine = new QueryEngine({
    provider,
    tools: [],
    announceProvider: false
  });

  const firstTurn = engine.chat('First');
  await assert.rejects(
    () => engine.chat('Second'),
    /Another message is still being processed/
  );

  finishRequest({
    message: {
      role: 'assistant',
      content: 'Finished'
    }
  });

  assert.equal(await firstTurn, 'Finished');
  assert.deepEqual(engine.getMessages(), [
    { role: 'user', content: 'First' },
    { role: 'assistant', content: 'Finished' }
  ]);
});

test('stops an endless tool-call loop without committing the failed turn', async () => {
  let requestCount = 0;
  const provider = {
    async chat() {
      requestCount += 1;
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: `call-${requestCount}`,
              name: 'MissingTool',
              input: {}
            }
          ]
        }
      };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };

  const engine = new QueryEngine({
    provider,
    tools: [],
    announceProvider: false
  });

  await assert.rejects(
    () => engine.chat('Keep using tools'),
    /Tool call limit exceeded \(10 rounds\)/
  );
  assert.equal(requestCount, 11);
  assert.deepEqual(engine.getMessages(), []);
});
