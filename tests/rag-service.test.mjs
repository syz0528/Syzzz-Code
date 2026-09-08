import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { getDefaultConfig, validateConfig } from '../dist/config.js';
import { RagServiceClient } from '../dist/rag/service-client.js';
import { RagRuntime } from '../dist/rag/runtime.js';
import { manageRag } from '../dist/rag/management.js';
import { QueryEngine } from '../dist/engine.js';

const chunk = {
  id: 'a'.repeat(32),
  collectionId: 'remote-techdocs',
  virtualPath: 'rag://techdocs/testing.md',
  lineStart: 1,
  lineEnd: 1,
  text: 'Use TestClient in a with statement to run lifespan.',
  sourceHash: 'b'.repeat(64),
  sourceBytes: 58,
  sourceMtimeMs: 1,
  revision: 'r1',
  language: 'markdown'
};
const signal = () => new AbortController().signal;

async function fixture(run, customize) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const bytes of request) text += bytes;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path: request.url, body });
    if (customize?.(request, response, body)) return;
    const payload = request.url.endsWith('/status')
      ? {
          schemaVersion: 1,
          serviceId: 'server1',
          lexicalAvailable: true,
          vectorAvailable: false,
          warnings: [],
          collections: [
            {
              id: chunk.collectionId,
              name: 'techdocs',
              kind: 'external',
              mounted: true,
              health: 'fresh',
              fileCount: 1,
              chunkCount: 1,
              revision: 'r1',
              warnings: []
            }
          ]
        }
      : request.url.endsWith('/search')
        ? {
            schemaVersion: 1,
            hits: [
              {
                chunkId: chunk.id,
                collection: 'techdocs',
                virtualPath: chunk.virtualPath,
                lineStart: 1,
                lineEnd: 1,
                summary: chunk.text,
                score: 1,
                rank: 1,
                channels: ['lexical'],
                revision: 'r1'
              }
            ]
          }
        : request.url.endsWith('/read')
          ? {
              schemaVersion: 1,
              serviceId: 'server1',
              chunks: [chunk],
              omittedChunkIds: []
            }
          : {
              schemaVersion: 1,
              checks: body.receipts.map((r) => ({
                token: `[[rag:${r.chunkId}]]`,
                chunkId: r.chunkId,
                status:
                  r.serviceId === 'server1' && r.revision === 'r1' ? 'valid' : 'missing-revision'
              }))
            };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const service = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    collections: ['techdocs'],
    timeoutMs: 2000
  };
  const runtime = new RagRuntime({
    workspaceRoot: tmpdir(),
    config: {
      enabled: true,
      autoRetrieve: 'off',
      autoRefresh: true,
      service
    },
    store: new Proxy(
      {},
      {
        get() {
          throw new Error('Unexpected local knowledge access');
        }
      }
    )
  });
  try {
    await run({ runtime, service, calls });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('remote RAG uses HTTP evidence and never the local index; keeps per-turn receipts', async () => {
  await fixture(async ({ runtime, calls }) => {
    const status = await runtime.getStatus();
    assert.equal(status.backend, 'remote');
    assert.equal(status.collections[0].name, 'techdocs');
    assert.equal(status.autoRefresh, false);
    const hits = await runtime.search({ query: 'lifespan', signal: signal() });
    runtime.recordSearchResults('t1', hits);
    runtime.assertChunksWereSearched('t1', [chunk.id]);
    assert.throws(() => runtime.assertChunksWereSearched('t2', [chunk.id]), /current turn/);
    const result = await runtime.readChunks([chunk.id], 't1', signal());
    assert.equal(result.receipts[0].serviceId, 'server1');
    assert.equal(
      (await runtime.validateCitations(`Use with [[rag:${chunk.id}]]`, 't1', signal()))[0].status,
      'valid'
    );
    assert.equal(
      (await runtime.validateCitations(`[[rag:${chunk.id}]]`, 't2', signal()))[0].status,
      'not-read'
    );
    assert.equal(
      (
        await runtime.validateContextReceipts(
          [{ ...result.receipts[0], revision: 'old' }],
          signal()
        )
      )[0].status,
      'missing-revision'
    );
    assert.equal((await runtime.inspectChunk(chunk.id, signal())).text, chunk.text);
    assert.match((await manageRag({ runtime, action: 'status', signal: signal() })).text, /remote/);
    await manageRag({ runtime, action: 'doctor', signal: signal() });
    await manageRag({ runtime, action: 'collections', signal: signal() });
    assert.ok(calls.every((call) => call.path.startsWith('/knowledge/')));
    assert.ok(!runtime.getTools().some((tool) => tool.name === 'SaveKnowledge'));
    await assert.rejects(runtime.clear('techdocs'), /read-only/);
    await assert.rejects(runtime.mount('techdocs'), /read-only/);
    await assert.rejects(runtime.index({ signal: signal() }), /read-only/);
    await assert.rejects(runtime.ensurePersonalLibrary(), /read-only/);
    await assert.rejects(manageRag({ runtime, action: 'add', signal: signal() }), /read-only/);
    runtime.clearTurn('t1');
    assert.equal(runtime.getTurnReceipts('t1').length, 0);
  });
});

test('semantic verifier and repair receive the remote chunks, not local source paths', async () => {
  await fixture(async ({ runtime }) => {
    await runtime.readChunks([chunk.id], 'turn', signal());
    runtime.setSemanticVerifier(async (input) => {
      assert.equal(input.chunks[0].text, chunk.text);
      return [{ claim: 'Use with', outcome: 'supported', citations: [chunk.id] }];
    });
    runtime.setAnswerRepairer(async (input) => {
      assert.equal(input.chunks[0].id, chunk.id);
      return `Use with [[rag:${chunk.id}]]`;
    });
    const draft = await runtime.repairGroundedAnswer('how?', 'turn', signal());
    assert.equal((await runtime.verify(draft, 'turn', signal())).outcome, 'supported');
    await assert.rejects(runtime.verify(draft, 'turn', signal()), /once/);
  });
});

test('inline executable examples cannot pass with a valid citation and an optimistic verifier', async () => {
  await fixture(async ({ runtime }) => {
    runtime.setSemanticVerifier(async () => [
      { claim: 'Use with', outcome: 'supported', citations: [chunk.id] }
    ]);
    for (const [turn, code, expected] of [
      ['bad-call', '`with TestClient(...):`', 'unsupported'],
      ['bad-assignment', '`client = TestClient(app)`', 'unsupported'],
      ['mention', '`TestClient` with a `with` statement', 'supported']
    ]) {
      await runtime.readChunks([chunk.id], turn, signal());
      const result = await runtime.verify(`${code} [[rag:${chunk.id}]]`, turn, signal());
      assert.equal(result.outcome, expected);
    }
  });
});

test('Engine completes remote search/read/citation and exports recoverable receipts', async () => {
  await fixture(async ({ runtime }) => {
    let step = 0;
    const provider = {
      getInfo: () => ({ name: 'Mock', type: 'mock', model: 'mock' }),
      async chat() {
        step += 1;
        if (step <= 2)
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: `call${step}`,
                  name: step === 1 ? 'RagSearch' : 'RagRead',
                  input:
                    step === 1
                      ? { query: 'TestClient lifespan', collections: ['techdocs'] }
                      : { chunkIds: [chunk.id] }
                }
              ]
            }
          };
        return {
          message: {
            role: 'assistant',
            content: `Use TestClient with a with statement. [[rag:${chunk.id}]]`
          }
        };
      }
    };
    const events = [];
    const engine = new QueryEngine({
      provider,
      rag: runtime,
      mode: 'ask',
      workspaceRoot: tmpdir(),
      audit: false,
      announceProvider: false
    });
    const turn = engine.runTurn('Use techdocs to explain lifespan tests');
    let response;
    while (true) {
      const next = await turn.next();
      if (next.done) {
        response = next.value.response;
        break;
      }
      events.push(next.value);
    }
    assert.match(response, /Use TestClient/);
    assert.ok(events.some((event) => event.type === 'rag_retrieval_completed'));
    const state = engine.exportState();
    assert.equal(state.ragContextReceipts[0].serviceId, 'server1');
    engine.restoreState(state);
    assert.equal(engine.exportState().ragContextReceipts[0].serviceId, 'server1');
  });
});

test('remote config is optional, validated, and keeps schema v1', () => {
  const base = getDefaultConfig();
  assert.equal(validateConfig(base).rag.service, undefined);
  const config = {
    ...base,
    rag: {
      ...base.rag,
      service: { enabled: true, baseUrl: 'http://localhost:18080', collections: ['techdocs'] }
    }
  };
  assert.equal(validateConfig(config).rag.service.timeoutMs, 30000);
  for (const patch of [
    { baseUrl: 'https://user:secret@example.com' },
    { collections: ['../x'] },
    { timeoutMs: 0 },
    { apiKeyEnv: 'bad name' }
  ]) {
    assert.throws(() =>
      validateConfig({
        ...config,
        rag: { ...config.rag, service: { ...config.rag.service, ...patch } }
      })
    );
  }
});

test('remote errors cannot trigger local fallback or leak response bodies', async () => {
  await fixture(
    async ({ runtime }) => {
      const status = await runtime.getStatus();
      assert.equal(status.lexicalAvailable, false);
      assert.match(status.warnings[0], /HTTP 503/);
      await assert.rejects(runtime.search({ query: 'test', signal: signal() }), /HTTP 503/);
    },
    (_request, response) => {
      response.statusCode = 503;
      response.end('SECRET_SOURCE_PATH');
      return true;
    }
  );
});

test('remote scope and malformed responses fail closed', async () => {
  await fixture(
    async ({ service }) => {
      const client = new RagServiceClient(service);
      await assert.rejects(
        client.search({ query: 'x', collections: ['elsewhere'], signal: signal() }),
        /not enabled/
      );
      await assert.rejects(client.read([chunk.id], signal()), /protocol/);
    },
    (_request, response) => {
      response.end(JSON.stringify({ schemaVersion: 1, chunks: [{ text: 'PRIVATE' }] }));
      return true;
    }
  );
});

test('remote body budget, cancellation and timeout are bounded', async () => {
  await fixture(
    async ({ service }) => {
      const client = new RagServiceClient(service);
      await assert.rejects(client.read([chunk.id], signal()), /byte budget/);
    },
    (_request, response) => {
      response.end('x'.repeat(50 * 1024));
      return true;
    }
  );
  await fixture(
    async ({ service }) => {
      const client = new RagServiceClient({ ...service, timeoutMs: 100 });
      await assert.rejects(client.read([chunk.id], signal()), /timed out/);
      const controller = new AbortController();
      const pending = client.read([chunk.id], controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
    },
    () => true
  );
});
