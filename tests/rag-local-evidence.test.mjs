import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readUtf8Range } from '../dist/tools/read-range.js';
import { LocalReadEvidenceStore } from '../dist/rag/local-evidence.js';
import { RagRuntime } from '../dist/rag/runtime.js';
import { RagStore } from '../dist/rag/store.js';
import { createProviderRagVerifier } from '../dist/rag/verifier.js';
import { QueryEngine } from '../dist/engine.js';

const signal = () => new AbortController().signal;
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-local-evidence-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(
    join(workspace, 'docs.md'),
    '# Lifespan\nUse TestClient with a with statement for lifespan.\n'
  );
  await writeFile(
    join(workspace, 'local.py'),
    'client = TestClient(app)\nassert client.get("/").status_code == 200\n'
  );
  const runtime = new RagRuntime({
    workspaceRoot: workspace,
    config: { enabled: true, autoRetrieve: 'off', autoRefresh: false },
    store: new RagStore(join(root, 'rag'))
  });
  await runtime.index({ signal: signal() });
  try {
    await run({ workspace, runtime });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const snapshot = (workspace, start = 1, count = 1) =>
  readUtf8Range(join(workspace, 'local.py'), 'local.py', start, count, true, signal());

test('local evidence uses structured returned ranges, stays bounded and validates current hash', async () => {
  await fixture(async ({ workspace }) => {
    const read = await snapshot(workspace);
    assert.equal(read.data.text, 'client = TestClient(app)');
    assert.equal(read.data.endLine, 1);
    assert.equal(read.metadata.truncated, true);
    assert.ok(!JSON.stringify(read.metadata).includes('client ='));
    const store = new LocalReadEvidenceStore();
    assert.equal(store.capture(read.content), false);
    assert.equal(store.capture({ ...read.data, path: '../escape.py' }), false);
    assert.equal(store.capture({ ...read.data, text: '中'.repeat(2000) }), false);
    assert.equal(store.capture(read.data), true);
    assert.equal((await store.validate(workspace, signal())).evidence[0].text, read.data.text);
    await writeFile(join(workspace, 'local.py'), 'changed\n');
    const stale = await store.validate(workspace, signal());
    assert.equal(stale.invalid, true);
    assert.deepEqual(stale.evidence, []);
    await assert.rejects(store.validate(workspace, AbortSignal.abort()), /cancel|abort/i);
  });
});

test('local evidence rejects oversized and forged snapshots and missing source files', async () => {
  await fixture(async ({ workspace }) => {
    const read = await snapshot(workspace);
    const store = new LocalReadEvidenceStore();
    for (let n = 0; n < 4; n++)
      assert.equal(
        store.capture({ ...read.data, path: `file${n}.py`, text: 'x'.repeat(2000) }),
        true
      );
    assert.equal(store.capture({ ...read.data, path: 'fifth.py' }), false);
    assert.equal((await store.validate(workspace, signal())).invalid, true);
    const forged = new LocalReadEvidenceStore();
    forged.capture({ ...read.data, sourceHash: '0'.repeat(64) });
    assert.equal((await forged.validate(workspace, signal())).evidence.length, 0);
  });
});

async function prepare(runtime, workspace) {
  const [hit] = await runtime.search({
    query: 'TestClient lifespan',
    path: 'docs.md',
    signal: signal()
  });
  await runtime.readChunks([hit.chunkId], 't', signal());
  runtime.recordLocalRead('t', (await snapshot(workspace)).data);
  return hit;
}

test('mixed verification accepts only real local code; rejects new code, fake source IDs and stale reads', async () => {
  await fixture(async ({ workspace, runtime }) => {
    const hit = await prepare(runtime, workspace);
    const draft = `Local file contains \`client = TestClient(app)\`; documents require with [[rag:${hit.chunkId}]]`;
    runtime.setSemanticVerifier(async ({ localEvidence, chunks }) => {
      assert.equal(chunks.length, 1);
      assert.equal(localEvidence[0].path, 'local.py');
      assert.ok(!chunks.some((c) => c.id === localEvidence[0].id));
      return [
        {
          claim: '__overall__',
          outcome: 'supported',
          citations: [hit.chunkId, localEvidence[0].id]
        }
      ];
    });
    assert.equal((await runtime.verify(draft, 't', signal())).outcome, 'supported');
    assert.equal(
      (await runtime.verifyRepairedAnswer(draft + '\n`run_tests()`', 't', signal())).outcome,
      'unsupported'
    );
    runtime.setSemanticVerifier(async () => [
      { claim: '__overall__', outcome: 'supported', citations: ['local-read-999'] }
    ]);
    assert.equal(
      (await runtime.verifyRepairedAnswer(draft, 't', signal())).outcome,
      'unverifiable'
    );
    await writeFile(join(workspace, 'local.py'), 'changed\n');
    runtime.setSemanticVerifier(async () => [
      { claim: '__overall__', outcome: 'supported', citations: [hit.chunkId] }
    ]);
    assert.equal(
      (await runtime.verifyRepairedAnswer(draft, 't', signal())).outcome,
      'unverifiable'
    );
    runtime.clearTurn('t');
    assert.equal(runtime.hasLocalReadEvidence('t'), false);
    assert.equal(runtime.hasLocalReadEvidence('other'), false);
  });
});

test('verifier labels local source scope without exposing it through audit events', async () => {
  const requests = [],
    events = [];
  const provider = {
    fork() {
      return this;
    },
    getInfo() {
      return { name: 'Mock', model: 'mock' };
    },
    async chat(request) {
      requests.push(request);
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            claims: [{ claim: '__overall__', outcome: 'supported', citations: ['local-read-1'] }]
          })
        },
        finishReason: 'stop'
      };
    }
  };
  await createProviderRagVerifier(provider)({
    draft: 'Observation',
    chunks: [],
    localEvidence: [
      {
        id: 'local-read-1',
        kind: 'file-read',
        path: 'local.py',
        sourceHash: 'a'.repeat(64),
        startLine: 1,
        endLine: 1,
        text: 'PRIVATE_LOCAL_TEXT'
      }
    ],
    signal: signal(),
    emitEvent: (event) => events.push(event)
  });
  assert.match(requests[0].systemPrompt, /do not prove tests ran/);
  assert.match(requests[0].messages[0].content, /PRIVATE_LOCAL_TEXT/);
  assert.deepEqual(requests[0].tools, []);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_LOCAL_TEXT|local.py/);
});

const reply = (content) => ({ message: { role: 'assistant', content }, finishReason: 'stop' });
const call = (name, input, id) => ({
  message: { role: 'assistant', content: '', toolCalls: [{ name, input, id }] },
  finishReason: 'tool_calls'
});
async function drain(engine, prompt) {
  const events = [];
  const turn = engine.runTurn(prompt);
  while (true) {
    const next = await turn.next();
    if (next.done) return { result: next.value, events };
    events.push(next.value);
  }
}

test('Engine supplies actual current-turn Read snapshots and never repairs a mixed answer using only RAG', async () => {
  await fixture(async ({ workspace, runtime }) => {
    let verdict = 'supported',
      repairs = 0,
      observedLocal = false;
    runtime.setSemanticVerifier(async ({ chunks, localEvidence }) => {
      observedLocal = localEvidence?.[0]?.path === 'local.py';
      return [
        { claim: '__overall__', outcome: verdict, citations: [chunks[0].id, 'local-read-1'] }
      ];
    });
    runtime.setAnswerRepairer(async () => {
      repairs++;
      return 'must not run';
    });
    const provider = {
      getInfo() {
        return {
          name: 'Mock',
          type: 'mock',
          model: 'mock',
          contextWindowTokens: 16384,
          capabilities: { streaming: false, reasoningToggle: false }
        };
      },
      async chat(request) {
        const tools = request.messages.filter((m) => m.role === 'tool');
        if (tools.length === 0) return call('Read', { path: 'local.py', limit: 1 }, 'local');
        if (tools.length === 1)
          return call('RagSearch', { query: 'TestClient lifespan', path: 'docs.md' }, 's');
        if (tools.length === 2)
          return call('RagRead', { chunkIds: [/\b[a-f0-9]{32}\b/.exec(tools[1].content)[0]] }, 'r');
        assert.equal(request.maxOutputTokens, 256);
        assert.equal(request.stopSequences, undefined);
        assert.match(request.systemPrompt, /observed local file\/range/);
        assert.match(request.systemPrompt, /successful Read is not a test execution result/);
        assert.doesNotMatch(request.systemPrompt, /Start the response.*two short sentences/);
        return reply(
          `Documents require with; local code contains \`client = TestClient(app)\`. ${/\[\[rag:[a-f0-9]{32}\]\]/.exec(tools[2].content)[0]}`
        );
      }
    };
    for (verdict of ['supported', 'unsupported']) {
      const engine = new QueryEngine({
        provider,
        rag: runtime,
        workspaceRoot: workspace,
        mode: 'ask',
        audit: false
      });
      try {
        const { result } = await drain(engine, 'Inspect local.py against docs');
        assert.equal(observedLocal, true);
        if (verdict === 'supported') assert.doesNotMatch(result.response, /grounding blocked/);
        else assert.match(result.response, /grounding blocked/);
      } finally {
        await engine.close();
      }
    }
    assert.equal(repairs, 0);
  });
});

test('local RagRead budgets do not register deferred sources and keep manual reads compatible', async () => {
  await fixture(async ({ runtime }) => {
    const hits = await runtime.search({ query: 'TestClient', signal: signal() });
    assert.ok(hits.length >= 2);
    const ids = hits.map((hit) => hit.chunkId);
    const result = await runtime.readChunks(ids, 'bounded', signal(), {
      maxChunks: 1,
      maxBytes: 6000
    });
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0].id, ids[0]);
    assert.equal(result.deferredChunkIds.length, ids.length - 1);
    assert.equal(runtime.getTurnReceipts('bounded').length, 1);
    runtime.reconcileToolReadDelivery('bounded', []);
    assert.equal(runtime.getTurnReceipts('bounded').length, 0);
    const manual = await runtime.readChunks(ids, 'manual', signal());
    assert.equal(manual.chunks.length, ids.length);
    runtime.reconcileToolReadDelivery('manual', []);
    assert.equal(runtime.getTurnReceipts('manual').length, ids.length);
  });
});

test('Engine withdraws citation receipts after a downstream tool-result truncation', async () => {
  await fixture(async ({ workspace, runtime }) => {
    const [hit] = await runtime.search({ query: 'lifespan', path: 'docs.md', signal: signal() });
    const tools = runtime.getTools().map((tool) =>
      tool.name !== 'RagRead'
        ? tool
        : {
            ...tool,
            async execute(input, context) {
              const result = await tool.execute(input, { ...context, maximumResultBytes: 8192 });
              assert.equal(runtime.getTurnReceipts(context.turnId).length, 1);
              return {
                ...result,
                content: 'oversized tool decoration '.repeat(1000) + result.content
              };
            }
          }
    );
    let turnId;
    const read = runtime.readChunks.bind(runtime);
    runtime.readChunks = (...args) => {
      turnId = args[1];
      return read(...args);
    };
    const provider = {
      getInfo: () => ({
        name: 'Mock',
        type: 'mock',
        model: 'mock',
        contextWindowTokens: 16384,
        capabilities: { streaming: false, reasoningToggle: false }
      }),
      async chat(request) {
        const results = request.messages.filter((message) => message.role === 'tool');
        if (!results.length) return call('RagSearch', { query: 'lifespan', path: 'docs.md' }, 's');
        if (results.length === 1) return call('RagRead', { chunkIds: [hit.chunkId] }, 'r');
        assert.equal(runtime.getTurnReceipts(turnId).length, 0);
        assert.ok(!results[1].content.includes(hit.chunkId));
        return reply('Evidence delivery was truncated; I cannot give a supported conclusion.');
      }
    };
    const engine = new QueryEngine({
      provider,
      rag: runtime,
      tools,
      workspaceRoot: workspace,
      mode: 'ask',
      audit: false,
      context: { maxToolResultBytes: 1024 }
    });
    try {
      await drain(engine, 'Read lifespan evidence');
    } finally {
      await engine.close();
    }
  });
});
