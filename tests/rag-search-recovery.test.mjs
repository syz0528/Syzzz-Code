import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { RagRuntime } from '../dist/rag/runtime.js';
import { createProviderRagQueryRewriter } from '../dist/rag/query-rewriter.js';

const hit = {
  chunkId: 'a'.repeat(32),
  collection: 'techdocs',
  virtualPath: 'rag://techdocs/guide/testing.md',
  lineStart: 1,
  lineEnd: 2,
  summary: 'TestClient with statement',
  score: 1,
  rank: 1,
  channels: ['lexical'],
  revision: 'r1'
};
const signal = () => new AbortController().signal;

async function fixture(run, respond = () => []) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw);
    calls.push(body);
    const hits = respond(body, calls.length);
    response.setHeader('content-type', 'application/json');
    if (typeof hits === 'number') {
      response.writeHead(hits);
      response.end('{}');
    } else response.end(JSON.stringify({ schemaVersion: 1, hits }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = (queryRewriter) =>
    new RagRuntime({
      workspaceRoot: tmpdir(),
      config: {
        enabled: true,
        autoRetrieve: 'off',
        autoRefresh: false,
        service: {
          enabled: true,
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          collections: ['techdocs'],
          timeoutMs: 2000
        }
      },
      store: new Proxy(
        {},
        {
          get() {
            throw new Error('Unexpected local access');
          }
        }
      ),
      queryRewriter
    });
  try {
    await run({ runtime, calls });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('empty RAG search retries once, retaining original query, collection and exact path', async () => {
  await fixture(
    async ({ runtime, calls }) => {
      const rewrites = [];
      const events = [];
      const rag = runtime(async (input) => {
        rewrites.push(input.query);
        return ['TestClient with statement'];
      });
      const hits = await rag.search({
        query: '测试期间 TestClient',
        collections: ['techdocs'],
        path: 'rag://techdocs/guide',
        limit: 12,
        signal: signal(),
        emitEvent: (e) => events.push(e)
      });
      assert.equal(hits.length, 1);
      assert.equal(rewrites.length, 1);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].queries, ['测试期间 TestClient']);
      assert.deepEqual(calls[1].queries, ['测试期间 TestClient', 'TestClient with statement']);
      for (const call of calls) {
        assert.deepEqual(call.collections, ['techdocs']);
        assert.equal(call.path, 'guide');
        assert.equal(call.limit, 12);
      }
      assert.equal(events.filter((e) => e.type === 'rag_retrieval_started').length, 2);
      assert.ok(!JSON.stringify(events).includes('测试期间'));
    },
    (_body, count) => (count === 1 ? [] : [hit])
  );
});

test('nonempty same-language retrieval does not invoke a rewriter', async () => {
  await fixture(
    async ({ runtime, calls }) => {
      let rewrites = 0;
      const hits = await runtime(async () => {
        rewrites++;
        return ['test'];
      }).search({ query: 'testing TestClient', signal: signal() });
      assert.equal(hits.length, 1);
      assert.equal(rewrites, 0);
      assert.equal(calls.length, 1);
    },
    () => [hit]
  );
});

test('CJK query with lexical English hits recovers once without widening scope', async () => {
  await fixture(
    async ({ runtime, calls }) => {
      let rewrites = 0;
      const rag = runtime(async () => {
        rewrites++;
        return ['TestClient lifespan with statement'];
      });
      const options = {
        query: '测试 lifespan 如何执行',
        collections: ['techdocs'],
        path: 'guide',
        turnId: 'gap',
        signal: signal()
      };
      await rag.search(options);
      await rag.search(options);
      assert.equal(rewrites, 1);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[1].queries, [options.query, 'TestClient lifespan with statement']);
      assert.ok(calls.every((call) => call.path === 'guide' && call.collections[0] === 'techdocs'));
    },
    () => [hit]
  );
});

test('language recovery retains existing candidates on rewrite or second search failure', async () => {
  for (const failure of ['rewrite', 'search', 'empty']) {
    await fixture(
      async ({ runtime }) => {
        const rag = runtime(async () => {
          if (failure === 'rewrite') throw new Error('offline');
          return ['TestClient with statement'];
        });
        assert.deepEqual(await rag.search({ query: '测试生命周期', signal: signal() }), [hit]);
      },
      (_body, n) => (n === 1 ? [hit] : failure === 'empty' ? [] : 503)
    );
  }
});

test('Chinese candidates and non-lexical retrieval do not trigger language recovery', async () => {
  for (const candidate of [
    { ...hit, summary: '测试 with 语句' },
    { ...hit, channels: ['lexical', 'vector'] }
  ]) {
    await fixture(
      async ({ runtime, calls }) => {
        const rag = runtime(async () => {
          throw new Error('must not rewrite');
        });
        assert.equal((await rag.search({ query: '测试', signal: signal() })).length, 1);
        assert.equal(calls.length, 1);
      },
      () => [candidate]
    );
  }
});

test('empty English retrieval can recover; another empty result never loops or drops path', async () => {
  await fixture(async ({ runtime, calls }) => {
    let rewrites = 0;
    const hits = await runtime(async () => {
      rewrites++;
      return ['TestClient with statement'];
    }).search({ query: 'testing lifecycle', path: 'missing.md', signal: signal() });
    assert.deepEqual(hits, []);
    assert.equal(rewrites, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.path === 'missing.md'));
  });
});

test('backend errors and invalid source scope never invoke a model', async () => {
  for (const status of [401, 503])
    await fixture(
      async ({ runtime, calls }) => {
        let rewrites = 0;
        const rag = runtime(async () => {
          rewrites++;
          return ['test'];
        });
        await assert.rejects(rag.search({ query: '测试', signal: signal() }));
        await assert.rejects(
          rag.search({ query: '测试', collections: ['private'], signal: signal() })
        );
        await assert.rejects(rag.search({ query: '测试', path: '../secret', signal: signal() }));
        assert.equal(rewrites, 0);
        assert.equal(calls.length, 1);
      },
      () => status
    );
});

test('multi-query and oversized rewrite inputs are retrieved intact without merging constraints', async () => {
  await fixture(async ({ runtime, calls }) => {
    let rewrites = 0;
    const rag = runtime(async () => {
      rewrites++;
      return ['test'];
    });
    const queries = ['lifespan without events', 'schemas with existing SDK'];
    await rag.search({ queries, signal: signal() });
    await rag.search({ query: 'a'.repeat(4097), signal: signal() });
    await assert.rejects(rag.search({ queries: ['1', '2', '3', '4', '5'], signal: signal() }));
    await assert.rejects(rag.search({ query: 'a'.repeat(8193), signal: signal() }));
    assert.equal(rewrites, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].queries, queries);
    assert.equal(calls[1].queries[0].length, 4097);
  });
});

test('invalid, empty or duplicate rewrites do not trigger another retrieval', async () => {
  for (const output of [
    [],
    ['original'],
    [''],
    ['a'.repeat(513)],
    ['1', '2', '3', '4'],
    [12],
    null
  ]) {
    await fixture(async ({ runtime, calls }) => {
      assert.deepEqual(
        await runtime(async () => output).search({ query: 'original', signal: signal() }),
        []
      );
      assert.equal(calls.length, 1);
    });
  }
});

test('rewriter failure preserves empty result; cancellation aborts instead of becoming absence', async () => {
  await fixture(async ({ runtime, calls }) => {
    assert.deepEqual(
      await runtime(async () => {
        throw new Error('private response');
      }).search({ query: 'test', signal: signal() }),
      []
    );
    const controller = new AbortController();
    const rag = runtime(async () => {
      controller.abort();
      throw new Error('cancelled');
    });
    await assert.rejects(rag.search({ query: 'test', signal: controller.signal }), {
      name: 'AbortError'
    });
    await assert.rejects(rag.search({ query: 'test', signal: controller.signal }), {
      name: 'AbortError'
    });
    assert.equal(calls.length, 2);
  });
});

test('provider rewrite rejects malformed or truncated query lists instead of silently editing them', async () => {
  for (const content of [
    '{}',
    '{"queries":[1]}',
    JSON.stringify({ queries: ['a'.repeat(513)] }),
    '{"queries":["1","2","3","4"]}',
    '{"queries":["unfinished'
  ]) {
    const rewrite = createProviderRagQueryRewriter({
      fork: () => ({
        getInfo: () => ({ name: 'Mock', model: 'mock' }),
        chat: async () => ({ message: { content } })
      })
    });
    await assert.rejects(rewrite({ query: 'test', signal: signal() }));
  }
});

test('provider rewrite cancellation settles even if the provider ignores AbortSignal', async () => {
  const controller = new AbortController();
  const rewrite = createProviderRagQueryRewriter({
    fork: () => ({
      getInfo: () => ({ name: 'Mock', model: 'mock' }),
      chat: () => new Promise(() => {})
    })
  });
  const pending = rewrite({ query: 'test', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('provider rewrite timeout is bounded even when an isolated provider does not settle', async () => {
  const events = [];
  const rewrite = createProviderRagQueryRewriter({
    fork: () => ({
      getInfo: () => ({ name: 'Mock', model: 'mock' }),
      chat: () => new Promise(() => {})
    })
  });
  // Keep the event loop alive: AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setInterval(() => {}, 1000);
  const started = Date.now();
  try {
    await assert.rejects(
      rewrite({ query: 'test', signal: signal(), emitEvent: (e) => events.push(e) })
    );
    assert.ok(Date.now() - started < 15_000);
    assert.ok(events.some((e) => e.type === 'provider_request_failed' && e.willRetry === false));
  } finally {
    clearInterval(keepAlive);
  }
});

test('provider rewrite validates its input without truncation or dispatch', async () => {
  assert.equal(createProviderRagQueryRewriter({}), undefined);
  let calls = 0;
  const rewrite = createProviderRagQueryRewriter({
    fork: () => {
      calls++;
      return {};
    }
  });
  for (const query of ['', 'a'.repeat(4097)]) {
    await assert.rejects(rewrite({ query, signal: signal() }));
  }
  assert.equal(calls, 0);
});

test('repeated RagSearch calls share one recovery budget per turn and release it on cleanup', async () => {
  await fixture(async ({ runtime, calls }) => {
    let rewrites = 0;
    const rag = runtime(async () => {
      rewrites++;
      return ['other query'];
    });
    const tool = rag.getTools().find((t) => t.name === 'RagSearch');
    const context = { turnId: 'one', signal: signal() };
    for (let n = 0; n < 4; n++)
      await tool.execute({ query: 'original', path: 'missing.md' }, context);
    assert.equal(rewrites, 1);
    assert.equal(calls.length, 5);
    await tool.execute({ query: 'different', path: 'missing.md' }, context);
    assert.equal(rewrites, 1);
    await tool.execute({ query: 'original' }, { ...context, turnId: 'two' });
    assert.equal(rewrites, 2);
    rag.clearTurn('one');
    await tool.execute({ query: 'original' }, context);
    assert.equal(rewrites, 3);
  });
});

test('failed recovery consumes its turn budget and concurrent searches cannot double-spend it', async () => {
  await fixture(async ({ runtime }) => {
    let rewrites = 0;
    const rag = runtime(async () => {
      rewrites++;
      throw new Error('unavailable');
    });
    await Promise.all(
      [1, 2, 3].map(() => rag.search({ query: 'original', turnId: 'same', signal: signal() }))
    );
    assert.equal(rewrites, 1);
  });
});
