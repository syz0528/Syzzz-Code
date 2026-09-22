import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAnthropicSse } from './support/anthropic-sse.mjs';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

for (const status of [200, 403]) {
  test(`real CLI routes Anthropic config and handles HTTP ${status}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'syzzz-cli-provider-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({
        path: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks))
      });
      if (status === 200 && requests.at(-1).body.stream) {
        writeAnthropicSse(res, {
          id: 'msg-fixture',
          type: 'message',
          role: 'assistant',
          model: 'fixture-model',
          content: [{ type: 'text', text: 'CLI_PROVIDER_OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 }
        });
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          status === 200
            ? {
                id: 'msg-fixture',
                type: 'message',
                role: 'assistant',
                model: 'fixture-model',
                content: [{ type: 'text', text: 'CLI_PROVIDER_OK' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 5 }
              }
            : {
                type: 'error',
                error: {
                  type: 'FreeTierError',
                  message:
                    "OpenCode's free tier can only be used from within OpenCode; private-fixture-detail"
                }
              }
        )
      );
    });
    try {
      await mkdir(join(home, '.syzzz-code'), { recursive: true });
      await mkdir(workspace);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      await writeFile(
        join(home, '.syzzz-code', 'config.json'),
        JSON.stringify({
          schemaVersion: 1,
          currentProvider: 'fixture',
          providers: {
            fixture: {
              name: 'Fixture',
              type: 'anthropic',
              model: 'fixture-model',
              models: ['fixture-model'],
              env: {
                BASE_URL: `http://127.0.0.1:${server.address().port}/gateway/v1/`,
                API_KEY: 'dummy-key'
              },
              headers: {
                'user-agent': 'syzzz-test',
                'x-test-session': 'dummy-session',
                'x-test-project': 'dummy-project'
              }
            }
          },
          skills: { enabled: false, allowImplicit: false, disabled: [] },
          rag: { enabled: false, autoRetrieve: 'off', autoRefresh: false },
          audit: { retentionDays: 0, maxBytes: 1048576 }
        })
      );
      const child = spawn(
        process.execPath,
        [cli, 'chat', '-m', 'hello', '--mode', 'ask', '--output-format', 'stream-json'],
        {
          cwd: workspace,
          env: { ...process.env, HOME: home, USERPROFILE: home },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill(), 20000);
      let exitCode;
      try {
        exitCode = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
      } finally {
        clearTimeout(timer);
      }
      assert.equal(requests.length, 1, stderr);
      const request = requests[0];
      assert.equal(request.path, '/gateway/v1/messages');
      assert.equal(request.headers['x-api-key'], 'dummy-key');
      assert.equal(request.headers['user-agent'], 'syzzz-test');
      assert.equal(request.headers['x-test-session'], 'dummy-session');
      assert.equal(request.headers['x-test-project'], 'dummy-project');
      assert.equal(request.body.model, 'fixture-model');
      assert.equal(request.body.stream, true);
      assert.equal(typeof request.body.system, 'string');
      const events = stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (status === 200) {
        assert.equal(exitCode, 0, stderr);
        assert.ok(events.some((event) => event.type === 'turn_completed'));
        const deltas = events.filter((event) => event.type === 'text_delta');
        assert.equal(deltas.length, 2);
        assert.match(JSON.stringify(deltas), /CLI_PRO/);
      } else {
        assert.equal(exitCode, 1, stderr);
        const failure = events.find((event) => event.type === 'turn_failed');
        assert.equal(failure.error.status, 403);
        assert.equal(failure.error.code, 'permission');
        assert.match(failure.error.message, /FreeTierError/);
        assert.ok(!events.some((event) => event.type === 'text_delta'));
        assert.doesNotMatch(stdout + stderr, /private-fixture-detail|dummy-key|dummy-session/);
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}
