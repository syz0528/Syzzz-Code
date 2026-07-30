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
  let notifyRequestStarted;
  const requestStarted = new Promise((resolve) => {
    notifyRequestStarted = resolve;
  });
  const provider = {
    chat() {
      notifyRequestStarted();
      return new Promise((resolve) => {
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
  await assert.rejects(() => engine.chat('Second'), /Another message is still being processed/);
  await requestStarted;

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
      return 'allow-once';
    }
  });

  assert.equal(response, 'Approved.');
  assert.equal(executionCount, 1);
  assert.equal(approvalRequests.length, 1);
  assert.equal(approvalRequests[0].risk, 'execute');
  assert.equal(approvalRequests[0].preview, 'echo ok');
  assert.deepEqual(approvalRequests[0].choices, ['allow-once', 'deny']);
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
      return 'deny';
    }
  });

  assert.equal(response, 'Denied.');
  assert.equal(executionCount, 0);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content, /denied by the user/);
});

test('allows all edits for the session without granting shell approval', async () => {
  let requestCount = 0;
  let writeExecutions = 0;
  let shellExecutions = 0;
  const approvalRequests = [];
  const provider = {
    async chat() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'write-1', name: 'Write', input: { value: 'one' } }]
          }
        };
      }
      if (requestCount === 2) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'edit-1', name: 'Edit', input: { value: 'two' } }]
          }
        };
      }
      if (requestCount === 3) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'shell-1', name: 'Shell', input: { command: 'echo hi' } }]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Done.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const writeTool = {
    name: 'Write',
    description: 'Write data',
    inputSchema: z.object({ value: z.string() }).strict(),
    risk: 'write',
    approval: 'always',
    async prepareApproval(input) {
      return {
        description: 'Write ' + input.value,
        executionData: { value: input.value }
      };
    },
    async execute() {
      writeExecutions += 1;
      return { content: 'written' };
    }
  };
  const editTool = {
    ...writeTool,
    name: 'Edit',
    description: 'Edit data'
  };
  const shellTool = {
    name: 'Shell',
    description: 'Execute a command',
    inputSchema: z.object({ command: z.string() }).strict(),
    risk: 'execute',
    approval: 'always',
    async prepareApproval() {
      return { description: 'Run shell' };
    },
    async execute() {
      shellExecutions += 1;
      return { content: 'executed' };
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [writeTool, editTool, shellTool],
    announceProvider: false
  });

  const response = await engine.chat('Edit, then run a command', {
    async requestApproval(request) {
      approvalRequests.push(request);
      return request.toolName === 'Write' ? 'allow-edits-session' : 'deny';
    }
  });

  assert.equal(response, 'Done.');
  assert.equal(writeExecutions, 2);
  assert.equal(shellExecutions, 0);
  assert.equal(engine.getPermissionMode(), 'acceptEdits');
  assert.equal(approvalRequests.length, 2);
  assert.deepEqual(approvalRequests[0].choices, ['allow-once', 'allow-edits-session', 'deny']);
  assert.equal(Object.isFrozen(approvalRequests[0].choices), true);
  assert.deepEqual(approvalRequests[1].choices, ['allow-once', 'deny']);
  assert.equal(Object.isFrozen(approvalRequests[1].choices), true);
});

test('fails closed when an approval handler returns a choice not offered', async () => {
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
            toolCalls: [{ id: 'shell-invalid', name: 'Shell', input: { command: 'echo no' } }]
          }
        };
      }
      toolResult = request.messages.at(-1);
      return { message: { role: 'assistant', content: 'Blocked.' } };
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
    async execute() {
      executionCount += 1;
      return { content: 'executed' };
    }
  };
  const engine = new QueryEngine({ provider, tools: [tool], announceProvider: false });

  assert.equal(
    await engine.chat('Run shell', {
      async requestApproval() {
        return 'allow-edits-session';
      }
    }),
    'Blocked.'
  );
  assert.equal(executionCount, 0);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content, /invalid approval choice/);
  assert.equal(engine.getPermissionMode(), 'safe');
});

test('aborts the turn when approval waiting is cancelled', async () => {
  let executionCount = 0;
  const provider = {
    async chat() {
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'write-abort', name: 'Write', input: { value: 'new' } }]
        }
      };
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
    async execute() {
      executionCount += 1;
      return { content: 'written' };
    }
  };
  const abortController = new AbortController();
  const engine = new QueryEngine({ provider, tools: [tool], announceProvider: false });

  await assert.rejects(
    engine.chat('Cancel this write', {
      signal: abortController.signal,
      async requestApproval() {
        abortController.abort();
        return 'allow-once';
      }
    }),
    (error) => error?.name === 'AbortError'
  );
  assert.equal(executionCount, 0);
  assert.deepEqual(engine.getMessages(), []);
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
        request.signal.addEventListener(
          'abort',
          () => {
            reject(new Error('provider request aborted'));
          },
          { once: true }
        );
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
  await assert.rejects(cancelledTurn, (error) => error?.name === 'AbortError');
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
      return 'deny';
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
      return 'deny';
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
  assert.match(capturedPrompt, /Inspect project structure once/);
  assert.match(capturedPrompt, /Do not rerun a successful tool/);
  assert.match(capturedPrompt, /do not call a sampled review complete or exhaustive/);
});

test('ask and plan modes expose only read tools and deny forged side effects', async () => {
  const requests = [];
  let writeExecutions = 0;
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
                id: 'forged-write',
                name: 'Write',
                input: { path: 'blocked.txt' }
              }
            ]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Stayed read-only.' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const tools = [
    {
      name: 'Read',
      description: 'Read',
      inputSchema: z.object({ path: z.string() }).strict(),
      risk: 'read',
      approval: 'never',
      async execute() {
        return { content: 'read' };
      }
    },
    {
      name: 'Write',
      description: 'Write',
      inputSchema: z.object({ path: z.string() }).strict(),
      risk: 'write',
      approval: 'never',
      async execute() {
        writeExecutions += 1;
        return { content: 'written' };
      }
    }
  ];
  const engine = new QueryEngine({
    provider,
    tools,
    mode: 'ask',
    permissionMode: 'fullAccess',
    audit: false
  });

  assert.equal(await engine.chat('Inspect only'), 'Stayed read-only.');
  assert.deepEqual(
    requests[0].tools.map((tool) => tool.name),
    ['Read']
  );
  assert.equal(writeExecutions, 0);
  assert.equal(requests[1].messages.at(-1).isError, true);
  assert.match(requests[1].messages.at(-1).content, /unavailable in ask mode/);
  assert.match(requests[1].messages.at(-1).content, /work mode to code/);
  assert.match(requests[1].messages.at(-1).content, /permission mode is a separate/);

  engine.setMode('plan');
  assert.equal(engine.getMode(), 'plan');
  assert.deepEqual(engine.getStatus().mode, 'plan');
});

test('a successful file side effect is reinforced in the final Provider request', async () => {
  const requests = [];
  let executions = 0;
  const provider = {
    async chat(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'write-side-effect',
                name: 'Write',
                input: { path: 'confirmed.txt' }
              }
            ]
          }
        };
      }
      return {
        message: {
          role: 'assistant',
          content: 'confirmed.txt was created.'
        }
      };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [
      {
        name: 'Write',
        description: 'Write',
        inputSchema: z.object({ path: z.string() }).strict(),
        risk: 'write',
        approval: 'never',
        async execute() {
          executions += 1;
          return { content: 'written' };
        }
      }
    ],
    mode: 'code',
    permissionMode: 'fullAccess',
    audit: false
  });

  assert.equal(await engine.chat('write once'), 'confirmed.txt was created.');
  assert.equal(executions, 1);
  assert.match(requests[1].systemPrompt, /Confirmed file side effects succeeded/);
  assert.match(requests[1].systemPrompt, /must not claim that no file was modified/);
});

test('engine state validation and persistence health fail closed', () => {
  const provider = {
    async chat() {
      return { message: { role: 'assistant', content: 'done' } };
    },
    getInfo() {
      return { name: 'Fake', type: 'test' };
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [],
    audit: false
  });

  assert.deepEqual(engine.getStatus().persistence, {
    state: 'unmanaged',
    dirty: false
  });
  engine.setPersistenceStatusProvider(() => ({
    state: 'degraded',
    dirty: true
  }));
  assert.deepEqual(engine.getStatus().persistence, {
    state: 'degraded',
    dirty: true
  });
  assert.throws(
    () =>
      engine.restoreState({
        schemaVersion: 1,
        messages: [{ role: 'unexpected', content: 'invalid' }],
        pendingFileChangeReceipts: [],
        compactionCount: 0,
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      }),
    /unknown message role/
  );
});
