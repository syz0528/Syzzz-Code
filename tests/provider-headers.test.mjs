import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { validateConfig } from '../dist/config.js';
import { createProvider } from '../dist/providers/factory.js';
import { validateProviderHeaders } from '../dist/providers/headers.js';
import { runProviderRequest } from '../dist/providers/runner.js';
import { startProviderFixture } from './support/provider-fixture.mjs';

const request = () => ({
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  systemPrompt: 'Header test',
  signal: new AbortController().signal
});
function config(type, url, headers) {
  return {
    name: 'Header test',
    type,
    model: 'contract-model',
    models: ['contract-model'],
    env: { BASE_URL: url, API_KEY: 'test-api-key' },
    headers
  };
}
async function collect(generator) {
  while (true) {
    const result = await generator.next();
    if (result.done) return result.value;
  }
}
async function server(handler) {
  const http = createServer(handler);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${http.address().port}`,
    close: () =>
      new Promise((resolve) => {
        http.close(resolve);
        http.closeAllConnections();
      })
  };
}

test('provider headers normalize empty configurations and survive config serialization', () => {
  for (const headers of [undefined, null, {}, { 'x-empty': '', 'x-spaces': '   ' }]) {
    const item = config('openai-compatible', 'http://localhost:8080', headers);
    const parsed = validateConfig({ currentProvider: 'local', providers: { local: item } });
    assert.equal(parsed.providers.local.headers, undefined);
    assert.equal(parsed.schemaVersion, 1);
  }
  const item = config('openai-compatible', 'http://localhost:8080', { 'X-Project': ' example ' });
  const parsed = validateConfig({ currentProvider: 'local', providers: { local: item } });
  assert.equal(parsed.providers.local.headers['x-project'], 'example');
  const restored = validateConfig(JSON.parse(JSON.stringify(parsed)));
  assert.equal(restored.providers.local.headers['x-project'], 'example');
});

test('header validation rejects malformed, duplicate, reserved and oversized values without echo', () => {
  for (const headers of [
    '',
    [],
    { '': 'sentinel-secret' },
    { 'bad name': 'sentinel-secret' },
    { 'x-a': 42 },
    { 'x-a': null },
    { 'x-a': 'sentinel-secret\r\nInjected: yes' },
    { 'x-a': '\t' },
    { 'x-a': '中文' },
    { 'X-A': 'one', 'x-a': 'two' },
    { Authorization: 'sentinel-secret' },
    { 'X-API-Key': 'sentinel-secret' },
    { Host: 'localhost' },
    { 'Content-Length': '4' },
    { 'Content-Type': 'text/plain' },
    { 'anthropic-version': 'bad' },
    { 'x-stainless-test': 'bad' },
    { 'x-big': 'x'.repeat(16384) },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-${i}`, 'ok']))
  ]) {
    assert.throws(
      () => validateProviderHeaders(headers),
      (error) => {
        assert.doesNotMatch(error.message, /sentinel-secret/);
        return true;
      }
    );
  }
});

for (const [type, profile] of [
  ['openai-compatible', 'openai-chat-completions'],
  ['openai-responses', 'openai-responses'],
  ['anthropic', 'anthropic-messages']
]) {
  test(`${type}: sends headers for chat, streaming adapter and forks without cross-provider leakage`, async () => {
    const fixture = await startProviderFixture(profile);
    try {
      const headers = { 'X-Project': 'alpha', 'x-empty': '' };
      const provider = createProvider(config(type, fixture.openAIBaseURL, headers));
      headers['X-Project'] = 'mutated';
      await provider.chat(request());
      await collect(runProviderRequest(provider, request()));
      await provider.fork().chat(request());
      await collect(runProviderRequest(provider.fork(), request()));
      assert.equal(fixture.requests.length, 4);
      for (const received of fixture.requests) {
        assert.equal(received.headers['x-project'], 'alpha');
        assert.equal(received.headers['x-empty'], undefined);
        assert.equal(
          received.headers[type === 'anthropic' ? 'x-api-key' : 'authorization'],
          type === 'anthropic' ? 'test-api-key' : 'Bearer test-api-key'
        );
      }
      await createProvider(config(type, fixture.openAIBaseURL, {})).chat(request());
      assert.equal(fixture.requests.at(-1).headers['x-project'], undefined);
    } finally {
      await fixture.close();
    }
  });

  test(`${type}: redirect is not followed and reflected errors do not expose header credentials`, async () => {
    let forwarded = 0;
    const target = await server((_req, res) => {
      forwarded++;
      res.end('{}');
    });
    let redirect = true;
    const source = await server((req, res) => {
      req.resume();
      if (redirect) {
        res.writeHead(307, { location: target.url });
        res.end();
      } else {
        res.writeHead(401, {
          'content-type': 'application/json',
          'x-request-id': 'gateway-private-value'
        });
        res.end(
          JSON.stringify({
            error: { type: 'authentication_error', message: 'gateway-private-value' }
          })
        );
      }
    });
    try {
      const provider = createProvider(
        config(type, source.url, { 'x-gateway-token': 'gateway-private-value' })
      );
      await assert.rejects(provider.chat(request()));
      assert.equal(forwarded, 0);
      redirect = false;
      for (const call of [
        () => provider.chat(request()),
        () => collect(runProviderRequest(provider.fork(), request()))
      ]) {
        await assert.rejects(call(), (error) => {
          assert.equal(error.code, 'authentication');
          assert.doesNotMatch(inspect(error, { depth: 10 }), /gateway-private-value/);
          return true;
        });
      }
    } finally {
      await source.close();
      await target.close();
    }
  });

  test(`${type}: custom header transport preserves cancellation`, async () => {
    const controller = new AbortController();
    const fixture = await server((req) => {
      req.resume();
      controller.abort();
    });
    try {
      const provider = createProvider(config(type, fixture.url, { 'x-client': 'cancel-test' }));
      await assert.rejects(
        provider.chat({ ...request(), signal: controller.signal }),
        /abort|cancel/i
      );
    } finally {
      await fixture.close();
    }
  });
}

test('Anthropic DEBUG output does not contain custom credentials echoed in error JSON or headers', async () => {
  const secret = 'gateway-"private"-value';
  const fixture = await server((req, res) => {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json', 'x-debug': secret });
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: secret } }));
  });
  const old = process.env.DEBUG;
  const oldLevel = process.env.ANTHROPIC_LOG;
  const log = console.log;
  const logs = [];
  try {
    process.env.DEBUG = 'true';
    process.env.ANTHROPIC_LOG = 'debug';
    console.log = (...values) => logs.push(inspect(values, { depth: 10 }));
    const provider = createProvider(
      config('anthropic', fixture.url, { 'x-gateway-token': secret })
    );
    await assert.rejects(provider.chat(request()));
    assert.equal(logs.length, 0);
    assert.ok(logs.every((line) => !line.includes('gateway-')));
  } finally {
    console.log = log;
    if (old === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = old;
    if (oldLevel === undefined) delete process.env.ANTHROPIC_LOG;
    else process.env.ANTHROPIC_LOG = oldLevel;
    await fixture.close();
  }
});

test('custom headers survive provider retry attempts', async () => {
  const fixture = await startProviderFixture('always-rate-limit');
  try {
    const provider = createProvider(
      config('openai-compatible', fixture.openAIBaseURL, { 'x-client': 'retry-client' })
    );
    await assert.rejects(
      collect(
        runProviderRequest(provider, request(), {
          maxAttempts: 2,
          sleep: async () => {}
        })
      )
    );
    assert.ok(fixture.requests.length >= 2);
    assert.ok(fixture.requests.every((item) => item.headers['x-client'] === 'retry-client'));
  } finally {
    await fixture.close();
  }
});
