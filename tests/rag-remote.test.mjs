import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createEmbeddings, RagRemoteError, resolveRagCredential } from '../dist/rag/remote.js';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function embeddingConfig(baseUrl) {
  return {
    type: 'openai-compatible',
    model: 'mock-embedding',
    dimensions: 3,
    env: { BASE_URL: baseUrl, API_KEY: 'stored-value', API_KEY_ENV: 'RAG_TEST_KEY' }
  };
}

test('RAG credentials prefer the configured environment variable without exposing it', () => {
  const resolved = resolveRagCredential(embeddingConfig('https://example.test/v1'), {
    RAG_TEST_KEY: 'environment-value'
  });
  assert.deepEqual(resolved, { value: 'environment-value', source: 'environment' });
});

test('embedding authentication failures are classified and never retried', async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests += 1;
      response.statusCode = 401;
      response.setHeader('x-request-id', 'request-private-shape');
      response.end('{}');
    },
    async (baseUrl) => {
      await assert.rejects(
        createEmbeddings(embeddingConfig(baseUrl), ['hello'], new AbortController().signal),
        (error) =>
          error instanceof RagRemoteError &&
          error.code === 'authentication' &&
          error.status === 401 &&
          error.requestId === 'request-private-shape'
      );
    }
  );
  assert.equal(requests, 1);
});

test('embedding rate limits honor Retry-After and retry only the failed remote request', async () => {
  let requests = 0;
  await withServer(
    async (request, response) => {
      requests += 1;
      for await (const _part of request) {
        // Consume the request before responding so the fixture matches real HTTP behavior.
      }
      response.setHeader('content-type', 'application/json');
      if (requests === 1) {
        response.statusCode = 429;
        response.setHeader('retry-after', '0');
        response.end('{}');
        return;
      }
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
    },
    async (baseUrl) => {
      assert.deepEqual(
        await createEmbeddings(embeddingConfig(baseUrl), ['hello'], new AbortController().signal),
        [[1, 0, 0]]
      );
    }
  );
  assert.equal(requests, 2);
});

test('embedding responses reject reordered rows and inconsistent dimensions', async () => {
  await withServer(
    async (request, response) => {
      for await (const _part of request) {
        // Consume request body.
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: [
            { index: 1, embedding: [1, 0, 0] },
            { index: 0, embedding: [1, 0] }
          ]
        })
      );
    },
    async (baseUrl) => {
      await assert.rejects(
        createEmbeddings(
          embeddingConfig(baseUrl),
          ['first', 'second'],
          new AbortController().signal
        ),
        /inconsistent vector dimensions/
      );
    }
  );
});

test('user cancellation interrupts an in-flight embedding request', async () => {
  await withServer(
    async (request, response) => {
      for await (const _part of request) {
        // Keep the connection valid until the client cancels.
      }
      setTimeout(() => response.end(JSON.stringify({ data: [] })), 5_000).unref();
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const pending = createEmbeddings(embeddingConfig(baseUrl), ['hello'], controller.signal);
      setTimeout(() => controller.abort(), 20).unref();
      await assert.rejects(pending, /cancelled|aborted/i);
    }
  );
});
