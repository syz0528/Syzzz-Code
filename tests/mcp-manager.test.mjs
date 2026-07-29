import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  McpManager,
  resolveMcpStdioInvocation
} from '../dist/extensions/mcp-manager.js';

function server(name = 'fixture') {
  return {
    name,
    source: 'user',
    trusted: true,
    config: {
      type: 'stdio',
      command: 'fixture-server',
      args: [],
      env: {},
      enabled: true,
      startupTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
      protocolMode: 'legacy'
    }
  };
}

function tool(name, readOnlyHint) {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' }
      },
      required: ['value'],
      additionalProperties: false
    },
    annotations: { readOnlyHint }
  };
}

function fakeFactory(options = {}) {
  const state = {
    connections: 0,
    listCalls: 0,
    callCalls: 0,
    closes: 0,
    changed: undefined,
    lifecycle: []
  };
  return {
    state,
    factory: async ({ onToolsChanged, onClose, onError }) => {
      state.connections += 1;
      state.changed = onToolsChanged;
      state.lifecycle.push({ onClose, onError });
      return {
        async listTools() {
          state.listCalls += 1;
          return options.tools ?? [
            tool('read_data', true),
            tool('mutate_data', false)
          ];
        },
        async callTool(selected, input) {
          state.callCalls += 1;
          if (options.callError) {
            throw options.callError;
          }
          return options.result ?? {
            content: [{
              type: 'text',
              text: `${selected.name}:${input.value}`
            }],
            isError: false
          };
        },
        async close() {
          state.closes += 1;
        }
      };
    }
  };
}

test('MCP discovery is lazy, qualified, paginated, and refreshes on list_changed', async () => {
  const fake = fakeFactory();
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: fake.factory
  });
  const signal = new AbortController().signal;

  assert.equal(fake.state.connections, 0);
  const first = await manager.search({ limit: 1 }, signal);
  assert.equal(fake.state.connections, 1);
  assert.equal(fake.state.listCalls, 1);
  assert.equal(first.total, 2);
  assert.equal(first.shown, 1);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.tools[0].qualifiedName, 'fixture__read_data');
  assert.equal(first.tools[0].risk, 'read');

  const second = await manager.search({ offset: 1, limit: 1 }, signal);
  assert.equal(second.tools[0].qualifiedName, 'fixture__mutate_data');
  assert.equal(second.tools[0].risk, 'execute');
  assert.equal(fake.state.listCalls, 1);

  fake.state.changed();
  await manager.search({}, signal);
  assert.equal(fake.state.listCalls, 2);
  await manager.close();
  assert.equal(fake.state.closes, 1);
});

test('local MCP policies only tighten tools and contradictory hints fail closed', async () => {
  const fake = fakeFactory({
    tools: [
      tool('read_data', true),
      {
        ...tool('conflicted', true),
        annotations: {
          readOnlyHint: true,
          destructiveHint: true
        }
      },
      tool('forced', true)
    ]
  });
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    toolPolicies: [{
      qualifiedName: 'fixture__read_data',
      policy: 'disabled',
      sources: ['user']
    }, {
      qualifiedName: 'fixture__forced',
      policy: 'execute',
      sources: ['project']
    }],
    connectionFactory: fake.factory
  });
  const signal = new AbortController().signal;

  const search = await manager.search({}, signal);
  assert.deepEqual(
    search.tools.map(entry => entry.qualifiedName),
    ['fixture__conflicted', 'fixture__forced']
  );
  await assert.rejects(
    manager.resolveTool('fixture__read_data', signal),
    error => error.code === 'policy_denied'
  );
  const inspection = await manager.inspectServer('fixture', signal);
  const conflicted = inspection.tools.find(entry =>
    entry.qualifiedName === 'fixture__conflicted'
  );
  const disabled = inspection.tools.find(entry =>
    entry.qualifiedName === 'fixture__read_data'
  );
  const forced = inspection.tools.find(entry =>
    entry.qualifiedName === 'fixture__forced'
  );
  assert.equal(disabled.risk, 'disabled');
  assert.equal(disabled.riskSource, 'local-policy');
  assert.deepEqual(disabled.policySources, ['user']);
  assert.equal(conflicted.risk, 'execute');
  assert.match(conflicted.annotationWarning, /conflicts/);
  assert.equal(forced.risk, 'execute');
  assert.equal(forced.riskSource, 'local-policy');
  assert.deepEqual(forced.policySources, ['project']);
  await manager.close();
});

test('MCP lifecycle callbacks discard stale generations and reconnect lazily', async () => {
  const fake = fakeFactory();
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: fake.factory
  });
  const signal = new AbortController().signal;

  await manager.search({}, signal);
  assert.equal(fake.state.connections, 1);
  fake.state.lifecycle[0].onError(new Error('network warning'));
  assert.equal(manager.getStatuses()[0].state, 'error');
  assert.equal(manager.getStatuses()[0].toolCount, 0);
  assert.equal(fake.state.closes, 1);
  fake.state.lifecycle[0].onClose();
  assert.equal(manager.getStatuses()[0].state, 'error');

  await manager.search({}, signal);
  assert.equal(fake.state.connections, 2);
  assert.equal(manager.getStatuses()[0].state, 'ready');
  fake.state.lifecycle[0].onClose();
  assert.equal(manager.getStatuses()[0].state, 'ready');
  await manager.close();
});

test('a connection failure is not replayed and the next action reconnects', async () => {
  const fake = fakeFactory({
    callError: new Error('connection lost')
  });
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: fake.factory
  });
  const signal = new AbortController().signal;

  await assert.rejects(
    manager.call('fixture__read_data', { value: 'one' }, signal),
    error => error.code === 'connection'
  );
  assert.equal(fake.state.callCalls, 1);
  assert.equal(manager.getStatuses()[0].state, 'error');
  assert.equal(manager.getStatuses()[0].errorCode, 'connection');
  await manager.search({}, signal);
  assert.equal(fake.state.connections, 2);
  assert.equal(fake.state.callCalls, 1);
  await manager.close();
});

test('MCP calls validate input, do not retry, and mark bounded output untrusted', async () => {
  const hugeResult = 'x'.repeat(100_000);
  const fake = fakeFactory({
    result: {
      content: [{ type: 'text', text: hugeResult }],
      structuredContent: { ok: true },
      isError: false
    }
  });
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: fake.factory
  });
  const signal = new AbortController().signal;

  await assert.rejects(
    manager.call('fixture__read_data', {}, signal),
    error => error.code === 'validation'
  );
  assert.equal(fake.state.callCalls, 0);

  const result = await manager.call(
    'fixture__read_data',
    { value: 'ok' },
    signal
  );
  assert.match(result.content, /untrusted_mcp_output/);
  assert.equal(Buffer.byteLength(result.content, 'utf8') <= 40 * 1024, true);
  assert.equal(result.metadata.outputTruncated, true);
  assert.equal(fake.state.callCalls, 1);
});

test('MCP side-effect calls are never replayed after a remote failure', async () => {
  const fake = fakeFactory({ callError: new Error('remote exploded') });
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: fake.factory
  });

  await assert.rejects(
    manager.call(
      'fixture__mutate_data',
      { value: 'once' },
      new AbortController().signal
    ),
    /remote exploded/
  );
  assert.equal(fake.state.callCalls, 1);
});

test('Windows batch MCP commands use an explicit ComSpec invocation', () => {
  assert.deepEqual(
    resolveMcpStdioInvocation(
      { command: 'fixture.cmd', args: ['--value', 'hello world'] },
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    ),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/c',
        'call',
        'fixture.cmd',
        '--value',
        'hello world'
      ]
    }
  );
  assert.deepEqual(
    resolveMcpStdioInvocation(
      { command: '/usr/bin/node', args: ['server.mjs'] },
      'linux',
      {}
    ),
    {
      command: '/usr/bin/node',
      args: ['server.mjs']
    }
  );
});

test('malformed catalog tools are isolated and catalog output is bounded', async () => {
  const tools = [
    tool('valid', true),
    { name: '', inputSchema: { type: 'object' } },
    { name: 'missing_schema' },
    ...Array.from({ length: 20 }, (_, index) => ({
      ...tool(`large_${index}`, true),
      description: `description-${index}-${'x'.repeat(5_000)}`
    }))
  ];
  const fake = fakeFactory({ tools });
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: fake.factory
  });

  const result = await manager.search(
    { detail: 'descriptions', limit: 20 },
    new AbortController().signal
  );

  assert.equal(result.total, 21);
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.content, 'utf8') <= 40 * 1024, true);
  assert.match(result.content, /^<untrusted_mcp_catalog>/);
  assert.equal(result.tools.some(entry => entry.name === ''), false);
  await manager.close();
});

test('oversized MCP schemas fail closed even when resolved directly', async () => {
  const fake = fakeFactory({
    tools: [{
      ...tool('oversized', true),
      inputSchema: {
        type: 'object',
        description: 'x'.repeat(4 * 1024 * 1024 + 1)
      }
    }]
  });
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: fake.factory
  });

  await assert.rejects(
    manager.resolveTool(
      'fixture__oversized',
      new AbortController().signal
    ),
    error => error.code === 'output_limit'
  );
  assert.equal(manager.getStatuses()[0].state, 'error');
  assert.equal(manager.getStatuses()[0].errorCode, 'output_limit');
  await manager.close();
});

test('stdio timeouts disconnect the server and calls are not retried', async () => {
  const fake = fakeFactory({ callError: new Error('request timeout') });
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: fake.factory
  });

  await assert.rejects(
    manager.call(
      'fixture__read_data',
      { value: 'once' },
      new AbortController().signal
    ),
    error => error.code === 'timeout'
  );
  assert.equal(fake.state.callCalls, 1);
  assert.equal(fake.state.closes, 1);
  assert.equal(manager.getStatuses()[0].state, 'error');
});

test('cancelling an active stdio call disconnects it without replay', async () => {
  const state = {
    calls: 0,
    closes: 0
  };
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [server()],
    connectionFactory: async () => ({
      async listTools() {
        return [tool('read_data', true)];
      },
      async callTool(_tool, _input, signal) {
        state.calls += 1;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      async close() {
        state.closes += 1;
      }
    })
  });
  const controller = new AbortController();
  const call = manager.call(
    'fixture__read_data',
    { value: 'once' },
    controller.signal
  );
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(call, error => error.name === 'AbortError');
  assert.equal(state.calls, 1);
  assert.equal(state.closes, 1);
  assert.equal(manager.getStatuses()[0].state, 'disconnected');
});

async function waitForFile(file, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test('official stdio MCP transport stays lazy and strips ambient credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'syzzz-mcp-stdio-'));
  const previousSecret = process.env.TEST_PROVIDER_API_KEY;
  const previousSource = process.env.MCP_SAFE_SOURCE;
  process.env.TEST_PROVIDER_API_KEY = 'must-not-leak';
  process.env.MCP_SAFE_SOURCE = 'configured-value';
  const fixture = path.resolve('tests/fixtures/mcp-stdio-server.mjs');
  const manager = new McpManager({
    workspaceRoot: directory,
    forbiddenEnvironmentNames: ['TEST_PROVIDER_API_KEY'],
    servers: [{
      name: 'official',
      source: 'user',
      trusted: true,
      config: {
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: { MCP_SAFE_VALUE: '${MCP_SAFE_SOURCE}' },
        enabled: true,
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 5_000,
        protocolMode: 'legacy'
      }
    }]
  });

  try {
    assert.equal(manager.getStatuses()[0].state, 'disconnected');
    const catalog = await manager.search({}, new AbortController().signal);
    assert.equal(manager.getStatuses()[0].state, 'ready');
    assert.equal(catalog.tools.some(entry =>
      entry.qualifiedName === 'official__echo' && entry.risk === 'read'
    ), true);
    assert.equal(catalog.tools.some(entry =>
      entry.qualifiedName === 'official__mutate' && entry.risk === 'execute'
    ), true);

    const environment = await manager.call(
      'official__environment',
      {},
      new AbortController().signal
    );
    assert.match(environment.content, /"leakedProviderKey":false/);
    assert.match(environment.content, /"configuredValue":"configured-value"/);

    const echoed = await manager.call(
      'official__echo',
      { value: '你好 MCP' },
      new AbortController().signal
    );
    assert.match(echoed.content, /echo:你好 MCP/);
    assert.match(echoed.content, /"value": "你好 MCP"/);

    const blockedManager = new McpManager({
      workspaceRoot: directory,
      forbiddenEnvironmentNames: ['TEST_PROVIDER_API_KEY'],
      servers: [{
        name: 'blocked',
        source: 'user',
        trusted: true,
        config: {
          type: 'stdio',
          command: process.execPath,
          args: [fixture],
          env: { MCP_SAFE_VALUE: '${TEST_PROVIDER_API_KEY}' },
          enabled: true,
          startupTimeoutMs: 5_000,
          toolTimeoutMs: 5_000,
          protocolMode: 'legacy'
        }
      }]
    });
    try {
      const blocked = await blockedManager.search(
        {},
        new AbortController().signal
      );
      assert.deepEqual(blocked.errors, [{
        server: 'blocked',
        code: 'configuration'
      }]);
    } finally {
      await blockedManager.close();
    }

    if (process.platform === 'win32') {
      const batchFile = path.join(directory, 'mcp fixture.cmd');
      await writeFile(
        batchFile,
        '@echo off\r\n"%~1" "%~2"\r\n',
        'utf8'
      );
      const batchManager = new McpManager({
        workspaceRoot: directory,
        servers: [{
          name: 'batch',
          source: 'user',
          trusted: true,
          config: {
            type: 'stdio',
            command: batchFile,
            args: [process.execPath, fixture],
            env: {},
            enabled: true,
            startupTimeoutMs: 5_000,
            toolTimeoutMs: 5_000,
            protocolMode: 'legacy'
          }
        }]
      });
      try {
        const batchCatalog = await batchManager.search(
          {},
          new AbortController().signal
        );
        assert.equal(batchCatalog.errors.length, 0);
        assert.equal(batchCatalog.tools.some(entry =>
          entry.qualifiedName === 'batch__echo'
        ), true);
      } finally {
        await batchManager.close();
      }
    }
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
    if (previousSecret === undefined) {
      delete process.env.TEST_PROVIDER_API_KEY;
    } else {
      process.env.TEST_PROVIDER_API_KEY = previousSecret;
    }
    if (previousSource === undefined) {
      delete process.env.MCP_SAFE_SOURCE;
    } else {
      process.env.MCP_SAFE_SOURCE = previousSource;
    }
  }
});

test('official stdio MCP transport negotiates the explicitly pinned modern mode', async () => {
  const fixture = path.resolve('tests/fixtures/mcp-stdio-server.mjs');
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [{
      name: 'modern',
      source: 'user',
      trusted: true,
      config: {
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: {},
        enabled: true,
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 5_000,
        protocolMode: 'modern'
      }
    }]
  });
  try {
    const catalog = await manager.search({}, new AbortController().signal);
    assert.equal(catalog.errors.length, 0);
    assert.equal(catalog.tools.some(entry =>
      entry.qualifiedName === 'modern__echo'
    ), true);
    assert.equal(manager.getStatuses()[0].state, 'ready');
  } finally {
    await manager.close();
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function closeServer(server) {
  await new Promise(resolve => server.close(resolve));
}

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.once('error', reject);
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('Streamable HTTP MCP uses configured headers and the legacy handshake', async () => {
  const seen = [];
  const httpServer = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405).end();
      return;
    }
    const message = await readJsonRequest(request);
    seen.push({
      method: message.method,
      authorization: request.headers.authorization,
      ambient: request.headers['x-provider-key']
    });
    if (!('id' in message)) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'http-fixture', version: '1.0.0' }
      };
    } else if (message.method === 'tools/list') {
      result = {
        tools: [{
          name: 'echo',
          description: 'echo',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
          },
          annotations: { readOnlyHint: true }
        }]
      };
    } else if (message.method === 'tools/call') {
      result = {
        content: [{
          type: 'text',
          text: `http:${message.params.arguments.value}`
        }]
      };
    } else {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'not found' }
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result
    }));
  });
  const url = await listen(httpServer);
  const previousHeader = process.env.MCP_HTTP_TOKEN;
  const previousAmbient = process.env.TEST_PROVIDER_API_KEY;
  process.env.MCP_HTTP_TOKEN = 'header-value';
  process.env.TEST_PROVIDER_API_KEY = 'ambient-secret';
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [{
      name: 'http',
      source: 'user',
      trusted: true,
      config: {
        type: 'http',
        url,
        headers: { Authorization: 'Bearer ${MCP_HTTP_TOKEN}' },
        enabled: true,
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 5_000,
        protocolMode: 'legacy'
      }
    }]
  });
  try {
    const catalog = await manager.search({}, new AbortController().signal);
    assert.equal(catalog.tools[0].qualifiedName, 'http__echo');
    const result = await manager.call(
      'http__echo',
      { value: 'hello' },
      new AbortController().signal
    );
    assert.match(result.content, /http:hello/);
    assert.equal(seen.some(entry => entry.method === 'initialize'), true);
    assert.equal(seen.every(entry =>
      entry.authorization === 'Bearer header-value'
    ), true);
    assert.equal(seen.every(entry => entry.ambient === undefined), true);
  } finally {
    await manager.close();
    await closeServer(httpServer);
    if (previousHeader === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = previousHeader;
    }
    if (previousAmbient === undefined) {
      delete process.env.TEST_PROVIDER_API_KEY;
    } else {
      process.env.TEST_PROVIDER_API_KEY = previousAmbient;
    }
  }
});

test('Streamable HTTP MCP never follows redirects', async () => {
  let redirectedRequests = 0;
  const destination = createServer((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const destinationUrl = await listen(destination);
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: destinationUrl }).end();
  });
  const redirectUrl = await listen(redirect);
  const manager = new McpManager({
    workspaceRoot: process.cwd(),
    servers: [{
      name: 'redirect',
      source: 'user',
      trusted: true,
      config: {
        type: 'http',
        url: redirectUrl,
        headers: {},
        enabled: true,
        startupTimeoutMs: 2_000,
        toolTimeoutMs: 2_000,
        protocolMode: 'legacy'
      }
    }]
  });
  try {
    const result = await manager.search({}, new AbortController().signal);
    assert.deepEqual(result.errors, [{
      server: 'redirect',
      code: 'connection'
    }]);
    assert.equal(redirectedRequests, 0);
  } finally {
    await manager.close();
    await closeServer(redirect);
    await closeServer(destination);
  }
});

test(
  'closing a stdio MCP server removes its descendant process on Windows',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'syzzz-mcp-tree-'));
    const ready = path.join(directory, 'descendant-ready.txt');
    const survived = path.join(directory, 'descendant-survived.txt');
    const fixture = path.resolve('tests/fixtures/mcp-stdio-server.mjs');
    const manager = new McpManager({
      workspaceRoot: directory,
      servers: [{
        name: 'tree',
        source: 'user',
        trusted: true,
        config: {
          type: 'stdio',
          command: process.execPath,
          args: [fixture],
          env: {
            MCP_DESCENDANT_READY: ready,
            MCP_DESCENDANT_SURVIVED: survived
          },
          enabled: true,
          startupTimeoutMs: 5_000,
          toolTimeoutMs: 5_000,
          protocolMode: 'legacy'
        }
      }]
    });

    try {
      await manager.search({}, new AbortController().signal);
      await waitForFile(ready);
      await manager.close();
      await new Promise(resolve => setTimeout(resolve, 1_800));
      await assert.rejects(readFile(survived, 'utf8'), error =>
        error?.code === 'ENOENT'
      );
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
