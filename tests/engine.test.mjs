import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
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
    inputSchema: z.object({ path: z.string() }).strict(),
    risk: 'read',
    approval: 'never',
    async execute(input, context) {
      assert.deepEqual(input, { path: 'package.json' });
      assert.equal(context.toolCallId, 'call-1');
      return { content: '{"name":"syzzz-code"}' };
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

test('rejects invalid tool input before execution', async () => {
  const requests = [];
  let executionCount = 0;
  const provider = {
    async chat(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'invalid-1', name: 'Read', input: { path: 42 } }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Input rejected.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tool = {
    name: 'Read',
    description: 'Read a file',
    inputSchema: z.object({ path: z.string() }).strict(),
    risk: 'read',
    approval: 'never',
    async execute() {
      executionCount += 1;
      return { content: 'unexpected' };
    }
  };

  const engine = new QueryEngine({ provider, tools: [tool], announceProvider: false });
  assert.equal(await engine.chat('Use an invalid tool input'), 'Input rejected.');
  assert.equal(executionCount, 0);
  assert.equal(requests[1].messages.at(-1).isError, true);
  assert.match(requests[1].messages.at(-1).content, /Invalid tool input/);
});

test('preserves a structured tool error in provider history', async () => {
  const requests = [];
  const provider = {
    async chat(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'error-1', name: 'Read', input: { path: 'missing' } }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'The tool failed.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tool = {
    name: 'Read',
    description: 'Read a file',
    inputSchema: z.object({ path: z.string() }).strict(),
    risk: 'read',
    approval: 'never',
    async execute() {
      return { content: 'Read failed: file not found', isError: true };
    }
  };

  const engine = new QueryEngine({ provider, tools: [tool], announceProvider: false });
  assert.equal(await engine.chat('Read a missing file'), 'The tool failed.');
  assert.deepEqual(requests[1].messages.at(-1), {
    role: 'tool',
    toolCallId: 'error-1',
    toolName: 'Read',
    content: 'Read failed: file not found',
    isError: true
  });
});

test('denies a high-risk tool without approval and does not execute it', async () => {
  const requests = [];
  let executionCount = 0;
  const provider = {
    async chat(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'write-1', name: 'Write', input: { value: 'new' } }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'No change was made.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tool = {
    name: 'Write',
    description: 'Write data',
    inputSchema: z.object({ value: z.string() }).strict(),
    risk: 'write',
    approval: 'always',
    async prepareApproval() {
      return { description: 'Replace a file', preview: 'sample diff' };
    },
    async execute() {
      executionCount += 1;
      return { content: 'written' };
    }
  };

  const engine = new QueryEngine({ provider, tools: [tool], announceProvider: false });
  assert.equal(await engine.chat('Write without approval'), 'No change was made.');
  assert.equal(executionCount, 0);
  assert.equal(requests[1].messages.at(-1).isError, true);
  assert.match(requests[1].messages.at(-1).content, /requires user approval/);
});

test('honors an explicit approval decision before executing a tool', async () => {
  let requestCount = 0;
  let executionCount = 0;
  const provider = {
    async chat() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'shell-1', name: 'Shell', input: { command: 'echo ok' } }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Approved.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tool = {
    name: 'Shell',
    description: 'Execute a command',
    inputSchema: z.object({ command: z.string() }).strict(),
    risk: 'execute',
    approval: 'always',
    async prepareApproval(input) {
      return {
        description: 'Execute command',
        preview: input.command,
        executionData: { approved: true }
      };
    },
    async execute(_input, context) {
      executionCount += 1;
      assert.deepEqual(context.approvalData, { approved: true });
      return { content: 'ok' };
    }
  };
  const approvalRequests = [];

  const engine = new QueryEngine({ provider, tools: [tool], announceProvider: false });
  const response = await engine.chat('Run a command', {
    async requestApproval(request) {
      approvalRequests.push(request);
      return true;
    }
  });

  assert.equal(response, 'Approved.');
  assert.equal(executionCount, 1);
  assert.equal(approvalRequests.length, 1);
  assert.equal(approvalRequests[0].risk, 'execute');
  assert.equal(approvalRequests[0].preview, 'echo ok');
});

test('does not execute a tool when the user rejects approval', async () => {
  let requestCount = 0;
  let executionCount = 0;
  let toolResult;
  const provider = {
    async chat(request) {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'write-denied', name: 'Write', input: { value: 'new' } }]
          }
        };
      }
      toolResult = structuredClone(request.messages.at(-1));
      return { message: { role: 'assistant', content: 'Denied.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tool = {
    name: 'Write',
    description: 'Write data',
    inputSchema: z.object({ value: z.string() }).strict(),
    risk: 'write',
    approval: 'always',
    async prepareApproval() {
      return { description: 'Replace a file', preview: 'sample diff' };
    },
    async execute() {
      executionCount += 1;
      return { content: 'written' };
    }
  };

  const engine = new QueryEngine({ provider, tools: [tool], announceProvider: false });
  const response = await engine.chat('Reject this write', {
    async requestApproval() {
      return false;
    }
  });

  assert.equal(response, 'Denied.');
  assert.equal(executionCount, 0);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content, /denied by the user/);
});

test('cancels an active provider request without committing the turn', async () => {
  let shouldWaitForCancellation = true;
  const provider = {
    chat(request) {
      if (!shouldWaitForCancellation) {
        return Promise.resolve({
          message: { role: 'assistant', content: 'Recovered.' }
        });
      }

      return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new Error('provider request aborted'));
        }, { once: true });
      });
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const engine = new QueryEngine({ provider, tools: [], announceProvider: false });
  const abortController = new AbortController();

  const cancelledTurn = engine.chat('Cancel me', { signal: abortController.signal });
  abortController.abort();
  await assert.rejects(cancelledTurn, error => error?.name === 'AbortError');
  assert.deepEqual(engine.getMessages(), []);

  shouldWaitForCancellation = false;
  assert.equal(await engine.chat('Try again'), 'Recovered.');
});

test('acceptEdits auto-approves write tools and still runs prepareApproval', async () => {
  let requestCount = 0;
  let prepareCount = 0;
  let approvalHandlerCalls = 0;
  let executionCount = 0;
  const provider = {
    async chat() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'write-auto', name: 'Write', input: { value: 'new' } }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Wrote without a prompt.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tool = {
    name: 'Write',
    description: 'Write data',
    inputSchema: z.object({ value: z.string() }).strict(),
    risk: 'write',
    approval: 'always',
    async prepareApproval() {
      prepareCount += 1;
      return {
        description: 'Replace a file',
        preview: 'sample diff',
        executionData: { approved: true }
      };
    },
    async execute(_input, context) {
      executionCount += 1;
      assert.deepEqual(context.approvalData, { approved: true });
      return { content: 'written' };
    }
  };

  const engine = new QueryEngine({
    provider,
    tools: [tool],
    announceProvider: false,
    permissionMode: 'acceptEdits'
  });
  const response = await engine.chat('Write automatically', {
    async requestApproval() {
      approvalHandlerCalls += 1;
      return false;
    }
  });

  assert.equal(response, 'Wrote without a prompt.');
  assert.equal(prepareCount, 1);
  assert.equal(executionCount, 1);
  assert.equal(approvalHandlerCalls, 0);
});

test('acceptEdits still requires approval for shell tools', async () => {
  let requestCount = 0;
  let executionCount = 0;
  const provider = {
    async chat() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'shell-1', name: 'Shell', input: { command: 'echo hi' } }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Shell blocked.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tool = {
    name: 'Shell',
    description: 'Execute a command',
    inputSchema: z.object({ command: z.string() }).strict(),
    risk: 'execute',
    approval: 'always',
    async prepareApproval() {
      return { description: 'Run shell' };
    },
    async execute() {
      executionCount += 1;
      return { content: 'ok' };
    }
  };

  const engine = new QueryEngine({
    provider,
    tools: [tool],
    announceProvider: false,
    permissionMode: 'acceptEdits'
  });
  const response = await engine.chat('Run shell', {
    // No handler — must fail closed for execute risk.
  });

  assert.equal(response, 'Shell blocked.');
  assert.equal(executionCount, 0);
});

test('fullAccess skips shell approval prompts while preserving executionData prep', async () => {
  let requestCount = 0;
  let prepareCount = 0;
  let approvalHandlerCalls = 0;
  let executionCount = 0;
  const provider = {
    async chat() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'shell-full', name: 'Shell', input: { command: 'echo full' } }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Shell ran.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tool = {
    name: 'Shell',
    description: 'Execute a command',
    inputSchema: z.object({ command: z.string() }).strict(),
    risk: 'execute',
    approval: 'always',
    async prepareApproval(input) {
      prepareCount += 1;
      return {
        description: 'Execute command',
        preview: input.command,
        executionData: { approved: true }
      };
    },
    async execute(_input, context) {
      executionCount += 1;
      assert.deepEqual(context.approvalData, { approved: true });
      return { content: 'ok' };
    }
  };

  const engine = new QueryEngine({
    provider,
    tools: [tool],
    announceProvider: false,
    permissionMode: 'fullAccess'
  });
  const response = await engine.chat('Run freely', {
    async requestApproval() {
      approvalHandlerCalls += 1;
      return false;
    }
  });

  assert.equal(response, 'Shell ran.');
  assert.equal(prepareCount, 1);
  assert.equal(executionCount, 1);
  assert.equal(approvalHandlerCalls, 0);
  assert.equal(engine.getPermissionMode(), 'fullAccess');
});

test('system prompt includes platform and shell executor details', async () => {
  let capturedPrompt = '';
  const provider = {
    async chat(request) {
      capturedPrompt = request.systemPrompt;
      return { message: { role: 'assistant', content: 'ok' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    announceProvider: false,
    workspaceRoot: '/tmp/workspace'
  });
  await engine.chat('hello');

  assert.match(capturedPrompt, /Platform: /);
  assert.match(capturedPrompt, /Shell executor: /);
  assert.match(capturedPrompt, /ListDirectory/);
  assert.match(capturedPrompt, /Permission mode: safe/);
});
