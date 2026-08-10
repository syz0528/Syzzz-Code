import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chunkRagSource, hashRagContent } from '../dist/rag/chunker.js';
import { manageRag } from '../dist/rag/management.js';
import { RagRuntime } from '../dist/rag/runtime.js';
import { RagStore } from '../dist/rag/store.js';
import { tokenizeRagText } from '../dist/rag/tokenizer.js';
import { createProviderRagVerifier } from '../dist/rag/verifier.js';
import { toAuditRecord } from '../dist/audit.js';
import { QueryEngine } from '../dist/engine.js';

const lexicalConfig = {
  enabled: true,
  autoRetrieve: 'off',
  autoRefresh: true
};

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-rag-'));
  const workspace = join(root, 'workspace');
  const ragDirectory = join(root, 'rag');
  await mkdir(join(workspace, 'src'), { recursive: true });
  try {
    await run({ root, workspace, ragDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function signal() {
  return new AbortController().signal;
}

test('RAG chunking preserves Markdown breadcrumbs, code symbols, and CJK terms', () => {
  const markdown = '# 项目\n概述。\n## 安全\n只读边界。';
  const chunks = chunkRagSource({
    collectionId: 'workspace-test',
    virtualPath: 'rag://workspace/README.md',
    content: markdown,
    sourceHash: hashRagContent(markdown),
    sourceBytes: Buffer.byteLength(markdown),
    sourceMtimeMs: 1,
    revision: 'r1'
  });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].heading, '项目 > 安全');
  assert.ok(tokenizeRagText('中文检索 QueryEngine').includes('中文'));
  assert.ok(tokenizeRagText('中文检索 QueryEngine').includes('queryengine'));

  const source = 'export class QueryEngine {}\n\nexport function runTurn() {}';
  const code = chunkRagSource({
    collectionId: 'workspace-test',
    virtualPath: 'rag://workspace/src/runtime.ts',
    content: source,
    sourceHash: hashRagContent(source),
    sourceBytes: Buffer.byteLength(source),
    sourceMtimeMs: 1,
    revision: 'r1'
  });
  assert.deepEqual(
    code.map((chunk) => chunk.symbol),
    ['QueryEngine', 'runTurn']
  );
});

test('lexical RAG indexes safely, retrieves progressively, and rejects stale citations', async () => {
  await withWorkspace(async ({ workspace, ragDirectory }) => {
    await writeFile(
      join(workspace, 'README.md'),
      '# 架构\nSyzzz 使用可信混合检索。\n## 权限\nRAG 工具始终只读。\n',
      'utf8'
    );
    await writeFile(
      join(workspace, 'src', 'runtime.ts'),
      'export class QueryEngine { runTurn() { return "evidence"; } }\n',
      'utf8'
    );
    await writeFile(join(workspace, '.env'), 'SECRET=do-not-index\n', 'utf8');
    await mkdir(join(workspace, 'node_modules', 'hidden'), { recursive: true });
    await writeFile(
      join(workspace, 'node_modules', 'hidden', 'index.js'),
      'secret dependency',
      'utf8'
    );

    const runtime = new RagRuntime({
      workspaceRoot: workspace,
      config: lexicalConfig,
      store: new RagStore(ragDirectory)
    });
    const indexed = await runtime.index({ signal: signal() });
    assert.equal(indexed.fileCount, 2);
    assert.equal(indexed.vectorState, 'unconfigured');
    assert.ok(indexed.chunkCount >= 3);

    const hits = await runtime.search({ query: '只读 权限', signal: signal() });
    assert.ok(hits.length > 0);
    assert.match(hits[0].virtualPath, /^rag:\/\/workspace\//);
    assert.doesNotMatch(JSON.stringify(hits), /SECRET|node_modules|syzzz-rag-/);

    const turnId = 'turn-1';
    const read = await runtime.readChunks([hits[0].chunkId], turnId, signal());
    assert.equal(read.chunks.length, 1);
    const citation = `[[rag:${hits[0].chunkId}]]`;
    assert.deepEqual(
      (await runtime.validateCitations(`结论 ${citation}`, turnId, signal())).map(
        (entry) => entry.status
      ),
      ['valid']
    );
    assert.equal(
      (await runtime.validateCitations('伪造 [[rag:aaaaaaaaaaaaaaaa]]', turnId, signal()))[0]
        .status,
      'not-read'
    );

    assert.equal(
      (await runtime.readChunks([hits[0].chunkId, hits[0].chunkId], turnId, signal())).chunks
        .length,
      1
    );
    await assert.rejects(
      runtime.search({ query: 'runtime', path: '../outside', signal: signal() }),
      /relative path inside a collection/
    );

    const sourcePath = read.chunks[0].virtualPath.endsWith('README.md')
      ? join(workspace, 'README.md')
      : join(workspace, 'src', 'runtime.ts');
    await writeFile(sourcePath, 'changed after retrieval\n', 'utf8');
    assert.equal(
      (await runtime.validateCitations(`结论 ${citation}`, turnId, signal()))[0].status,
      'stale-source'
    );
  });
});

test('cancelled refresh preserves CURRENT and status reports source freshness', async () => {
  await withWorkspace(async ({ workspace, ragDirectory }) => {
    const source = join(workspace, 'README.md');
    await writeFile(source, '# Version one\nCURRENT remains stable.\n', 'utf8');
    const store = new RagStore(ragDirectory);
    const runtime = new RagRuntime({ workspaceRoot: workspace, config: lexicalConfig, store });
    const successEvents = [];
    const first = await runtime.index({
      signal: signal(),
      emitEvent: (event) => successEvents.push(event)
    });
    assert.equal(successEvents[0].type, 'rag_index_started');
    assert.ok(successEvents.some((event) => event.type === 'rag_index_progress'));
    assert.equal(successEvents.at(-1).type, 'rag_index_completed');
    const collection = (await runtime.listCollections())[0];
    assert.equal(await store.currentRevision(collection.id), first.revision);
    assert.equal((await runtime.getStatus()).collections[0].health, 'fresh');

    await writeFile(source, '# Version two\nThe source changed.\n', 'utf8');
    assert.equal((await runtime.getStatus()).collections[0].health, 'stale');
    const controller = new AbortController();
    controller.abort();
    const cancelledEvents = [];
    await assert.rejects(
      runtime.index({
        operation: 'refresh',
        signal: controller.signal,
        emitEvent: (event) => cancelledEvents.push(event)
      }),
      /aborted/i
    );
    assert.equal(cancelledEvents[0].type, 'rag_index_started');
    assert.equal(cancelledEvents.at(-1).type, 'rag_index_failed');
    assert.equal(await store.currentRevision(collection.id), first.revision);
    const collectionDirectory = join(ragDirectory, 'indexes', collection.id);
    assert.equal(
      (await readdir(collectionDirectory)).some((entry) => entry.startsWith('.building-')),
      false
    );

    const refreshed = await runtime.index({ operation: 'refresh', signal: signal() });
    assert.notEqual(refreshed.revision, first.revision);
    assert.equal((await runtime.getStatus()).collections[0].health, 'fresh');
  });
});

test('external collections require an explicit workspace mount and expose virtual paths', async () => {
  await withWorkspace(async ({ root, workspace, ragDirectory }) => {
    const external = join(root, 'knowledge');
    await mkdir(external);
    await writeFile(join(external, 'guide.md'), '# 外部知识\n挂载集合证据。\n', 'utf8');
    const runtime = new RagRuntime({
      workspaceRoot: workspace,
      config: lexicalConfig,
      store: new RagStore(ragDirectory)
    });
    await runtime.registerCollection('docs', external);
    assert.deepEqual(
      (await runtime.listCollections()).map((entry) => entry.name),
      ['workspace']
    );
    await runtime.mount('docs');
    assert.deepEqual(
      (await runtime.listCollections()).map((entry) => entry.name),
      ['workspace', 'docs']
    );
    await runtime.index({ collection: 'docs', signal: signal() });
    const hits = await runtime.search({
      query: '挂载集合',
      collections: ['docs'],
      signal: signal()
    });
    assert.ok(hits.length > 0);
    assert.match(hits[0].virtualPath, /^rag:\/\/docs\//);
    assert.doesNotMatch(JSON.stringify(hits), new RegExp(external.replaceAll('\\', '\\\\')));
    await runtime.unmount('docs');
    await assert.rejects(
      runtime.search({ query: '挂载集合', collections: ['docs'], signal: signal() }),
      /No requested RAG collections are mounted/
    );
  });
});

test('RAG management covers index inspection, clearing, and external collection lifecycle', async () => {
  await withWorkspace(async ({ root, workspace, ragDirectory }) => {
    await writeFile(join(workspace, 'README.md'), '# Management\nMANAGEMENT_EVIDENCE\n', 'utf8');
    const runtime = new RagRuntime({
      workspaceRoot: workspace,
      config: lexicalConfig,
      store: new RagStore(ragDirectory)
    });
    const request = (action, options = {}) =>
      manageRag({ runtime, action, signal: signal(), ...options });

    assert.match((await request('status')).text, /workspace: missing/);
    assert.match((await request('index')).text, /Indexed workspace/);
    const search = await request('search', { target: 'MANAGEMENT_EVIDENCE' });
    assert.equal(search.json.length, 1);
    assert.match(
      (await request('inspect', { target: search.json[0].chunkId })).text,
      /MANAGEMENT_EVIDENCE/
    );

    let confirmations = 0;
    assert.deepEqual(
      (
        await request('clear', {
          confirm: async () => {
            confirmations += 1;
            return false;
          }
        })
      ).json,
      { cleared: false }
    );
    assert.equal(confirmations, 1);
    assert.equal((await request('clear', { yes: true })).json.cleared, true);

    const external = join(root, 'external-docs');
    await mkdir(external);
    await writeFile(
      join(external, 'guide.md'),
      '# External\nEXTERNAL_MANAGEMENT_EVIDENCE\n',
      'utf8'
    );
    assert.match(
      (await request('collections', { target: 'add', rest: ['manual-docs', external] })).text,
      /Registered RAG collection manual-docs/
    );
    assert.match((await request('collections')).text, /manual-docs/);
    assert.equal((await request('mount', { target: 'manual-docs' })).json.mounted, true);
    assert.match((await request('index', { target: 'manual-docs' })).text, /Indexed manual-docs/);
    assert.equal((await request('unmount', { target: 'manual-docs' })).json.mounted, false);
    assert.equal(
      (await request('collections', { target: 'remove', rest: ['manual-docs'] })).json.removed,
      true
    );
    await assert.rejects(request('collections', { target: 'unknown' }), /list, add, or remove/);
    await assert.rejects(request('unknown'), /rag action must be/);
  });
});

test('RAG index locks reject concurrent builders and recover after release', async () => {
  await withWorkspace(async ({ ragDirectory }) => {
    const store = new RagStore(ragDirectory);
    const release = await store.acquireIndexLock('workspace-lock');
    await assert.rejects(store.acquireIndexLock('workspace-lock'), /already active/);
    await release();
    const releaseAgain = await store.acquireIndexLock('workspace-lock');
    await releaseAgain();
  });
});

test('OpenAI-compatible embeddings and Jina-compatible reranking produce a vector index', async () => {
  await withWorkspace(async ({ workspace, ragDirectory }) => {
    await writeFile(
      join(workspace, 'README.md'),
      '# Fruit\napple architecture\nbanana details\n',
      'utf8'
    );
    const requests = [];
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const part of request) raw += part;
      requests.push({ url: request.url, authorization: request.headers.authorization, body: raw });
      const body = JSON.parse(raw);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/embeddings') {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        response.end(
          JSON.stringify({
            data: inputs.map((text, index) => ({
              index,
              embedding: String(text).toLowerCase().includes('apple') ? [1, 0, 0] : [0, 1, 0]
            }))
          })
        );
        return;
      }
      if (request.url === '/v1/rerank') {
        response.end(
          JSON.stringify({
            results: body.documents.map((_, index) => ({
              index,
              relevance_score: index === 0 ? 1 : 0.5
            }))
          })
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/v1`;
    const runtime = new RagRuntime({
      workspaceRoot: workspace,
      store: new RagStore(ragDirectory),
      config: {
        enabled: true,
        autoRetrieve: 'off',
        autoRefresh: true,
        embedding: {
          type: 'openai-compatible',
          model: 'mock-embedding',
          dimensions: 3,
          env: { BASE_URL: base, API_KEY: 'embedding-secret' }
        },
        reranker: {
          type: 'jina-compatible',
          model: 'mock-reranker',
          env: { BASE_URL: base, API_KEY: 'rerank-secret' }
        }
      }
    });
    let confirmations = 0;
    try {
      const result = await runtime.index({
        signal: signal(),
        confirmRemote: async () => {
          confirmations += 1;
          return true;
        }
      });
      assert.equal(result.vectorState, 'ready');
      assert.equal(confirmations, 2);
      const second = await runtime.index({
        operation: 'refresh',
        signal: signal(),
        confirmRemote: async () => {
          confirmations += 1;
          return true;
        }
      });
      assert.equal(second.reusedEmbeddings, second.chunkCount);
      assert.equal(confirmations, 2);
      const hits = await runtime.search({ query: 'apple', signal: signal() });
      assert.ok(hits.some((hit) => hit.channels.includes('vector')));
      assert.ok(hits.some((hit) => hit.channels.includes('rerank')));
      assert.ok(requests.every((entry) => entry.authorization?.startsWith('Bearer ')));
      assert.doesNotMatch(
        JSON.stringify(await runtime.getStatus()),
        /embedding-secret|rerank-secret/
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('semantic RAG verification emits isolated Provider purpose and bounded usage metadata', async () => {
  await withWorkspace(async ({ workspace, ragDirectory }) => {
    await writeFile(join(workspace, 'README.md'), '# Evidence\nVERIFIER_EVIDENCE\n', 'utf8');
    const provider = {
      async chat() {
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              claims: [
                {
                  claim: 'The evidence exists',
                  outcome: 'supported',
                  citations: []
                }
              ]
            })
          },
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          requestId: 'verification-request'
        };
      },
      getInfo() {
        return {
          name: 'Verifier Mock',
          type: 'mock',
          model: 'verifier-model',
          capabilities: { streaming: false, reasoningToggle: false }
        };
      },
      fork() {
        return this;
      }
    };
    const runtime = new RagRuntime({
      workspaceRoot: workspace,
      config: lexicalConfig,
      store: new RagStore(ragDirectory),
      semanticVerifier: createProviderRagVerifier(provider)
    });
    await runtime.index({ signal: signal() });
    const [hit] = await runtime.search({ query: 'VERIFIER_EVIDENCE', signal: signal() });
    await runtime.readChunks([hit.chunkId], 'verify-turn', signal());
    const events = [];
    const verifyTool = runtime.getTools().find((tool) => tool.name === 'RagVerify');
    assert.ok(verifyTool);
    const result = await verifyTool.execute(
      { draft: `Supported [[rag:${hit.chunkId}]]` },
      {
        toolCallId: 'verify-tool-call',
        sessionId: 'verify-session',
        turnId: 'verify-turn',
        workspaceRoot: workspace,
        workingDirectory: workspace,
        mode: 'ask',
        permissionMode: 'safe',
        signal: signal(),
        emitEvent: (event) => events.push(event)
      }
    );
    assert.equal(result.isError, undefined);
    assert.equal(result.metadata.outcome, 'supported');
    assert.deepEqual(
      events.filter((event) => event.type.startsWith('provider_')).map((event) => event.type),
      ['provider_request_started', 'provider_request_completed']
    );
    assert.ok(
      events
        .filter((event) => event.type.startsWith('provider_') || event.type === 'usage_updated')
        .every((event) => event.purpose === 'rag-verification')
    );
    assert.equal(events.find((event) => event.type === 'usage_updated').usage.totalTokens, 20);
    assert.ok(events.some((event) => event.type === 'rag_verification_started'));
    assert.ok(events.some((event) => event.type === 'rag_verification_completed'));
  });
});

test('RAG audit records metadata without queries, paths, chunks, or drafts', () => {
  const envelope = {
    schemaVersion: 1,
    sessionId: 'session',
    turnId: 'turn',
    sequence: 1,
    timestamp: '2026-08-07T00:00:00.000Z'
  };
  const retrieval = toAuditRecord(
    {
      ...envelope,
      type: 'rag_retrieval_completed',
      candidateCount: 20,
      resultCount: 4,
      channels: ['lexical', 'vector'],
      staleCollections: 0,
      durationMs: 12
    },
    'workspace-hash'
  );
  assert.deepEqual(retrieval.channels, ['lexical', 'vector']);
  assert.doesNotMatch(JSON.stringify(retrieval), /query|rag:\/\/|chunk|draft|secret/i);
});

test('Engine exposes read-only RAG tools in ask mode and validates final citations', async () => {
  await withWorkspace(async ({ workspace, ragDirectory }) => {
    await writeFile(join(workspace, 'README.md'), '# Runtime\nPHASE9_ENGINE_EVIDENCE\n', 'utf8');
    const rag = new RagRuntime({
      workspaceRoot: workspace,
      config: lexicalConfig,
      store: new RagStore(ragDirectory)
    });
    await rag.index({ signal: signal() });
    const seenTools = [];
    const provider = {
      async chat(request) {
        seenTools.push(request.tools.map((tool) => tool.name));
        const toolResults = request.messages.filter((message) => message.role === 'tool');
        if (toolResults.length === 0) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'search-1',
                  name: 'RagSearch',
                  input: { query: 'PHASE9_ENGINE_EVIDENCE' }
                }
              ]
            },
            finishReason: 'tool_calls'
          };
        }
        if (toolResults.length === 1) {
          const chunkId = /\b[a-f0-9]{32}\b/.exec(toolResults[0].content)?.[0];
          assert.ok(chunkId);
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'read-1', name: 'RagRead', input: { chunkIds: [chunkId] } }]
            },
            finishReason: 'tool_calls'
          };
        }
        const citation = /\[\[rag:[a-f0-9]{32}\]\]/.exec(toolResults[1].content)?.[0];
        assert.ok(citation);
        return {
          message: { role: 'assistant', content: `Evidence confirmed ${citation}` },
          finishReason: 'stop'
        };
      },
      getInfo() {
        return {
          name: 'RAG Mock',
          type: 'mock',
          model: 'mock',
          capabilities: { streaming: false, reasoningToggle: false }
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: workspace,
      mode: 'ask',
      rag,
      audit: false
    });
    const events = [];
    const turn = engine.runTurn('Use indexed evidence');
    let result;
    while (true) {
      const next = await turn.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }
    assert.equal(result.status, 'completed');
    assert.ok(seenTools.every((tools) => tools.includes('RagSearch') && tools.includes('RagRead')));
    assert.ok(seenTools.every((tools) => !tools.includes('RagVerify')));
    assert.ok(events.some((event) => event.type === 'rag_retrieval_completed'));
    assert.ok(
      events.some(
        (event) => event.type === 'rag_verification_completed' && event.invalidCitationCount === 0
      )
    );
  });
});

test('automatic RAG retrieval uses only a ready index and skips explicit context messages', async () => {
  await withWorkspace(async ({ workspace, ragDirectory }) => {
    await writeFile(join(workspace, 'README.md'), '# Evidence\nAUTO_RAG_READY\n', 'utf8');
    const rag = new RagRuntime({
      workspaceRoot: workspace,
      config: { ...lexicalConfig, autoRetrieve: 'ask-plan' },
      store: new RagStore(ragDirectory)
    });
    await rag.index({ signal: signal() });
    const requests = [];
    const provider = {
      async chat(request) {
        requests.push(request);
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
      },
      getInfo() {
        return {
          name: 'Auto RAG Mock',
          type: 'mock',
          model: 'mock',
          capabilities: { streaming: false, reasoningToggle: false }
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: workspace,
      mode: 'ask',
      rag,
      audit: false
    });
    await engine.chat('AUTO_RAG_READY');
    assert.match(
      requests[0].messages.find((message) => message.role === 'user').content,
      /automatic_rag_evidence/
    );
    await engine.chat('Inspect @README.md');
    const latestUser = requests
      .at(-1)
      .messages.filter((message) => message.role === 'user')
      .at(-1);
    assert.doesNotMatch(latestUser.content, /automatic_rag_evidence/);
  });
});

test('managed personal library imports documents and saves approved knowledge atomically', async () => {
  await withWorkspace(async ({ root, workspace, ragDirectory }) => {
    const sourcePath = join(workspace, 'manual.md');
    await writeFile(sourcePath, '# Manual\nPHASE91_IMPORTED_EVIDENCE\n', 'utf8');
    const runtime = new RagRuntime({
      workspaceRoot: workspace,
      config: lexicalConfig,
      store: new RagStore(ragDirectory)
    });

    const imported = await manageRag({
      runtime,
      action: 'add',
      target: sourcePath,
      yes: true,
      signal: signal()
    });
    assert.equal(imported.json.collection, 'library');
    assert.equal(imported.json.indexStatus, 'refreshed');
    assert.equal(imported.json.virtualPath, 'rag://library/manual.md');
    assert.match(
      await readFile(join(root, 'knowledge', 'library', 'manual.md'), 'utf8'),
      /PHASE91_IMPORTED_EVIDENCE/
    );
    assert.ok(
      (await runtime.search({ query: 'PHASE91_IMPORTED_EVIDENCE', signal: signal() })).some(
        (hit) => hit.virtualPath === 'rag://library/manual.md'
      )
    );
    await assert.rejects(
      runtime.removeCollection('library'),
      /managed RAG library cannot be removed/
    );
    await assert.rejects(
      runtime.registerCollection('library', workspace),
      /reserved RAG collection name library/
    );

    const saveTool = runtime.getTools().find((tool) => tool.name === 'SaveKnowledge');
    assert.ok(saveTool);
    const context = {
      toolCallId: 'save-knowledge-1',
      sessionId: 'save-session',
      turnId: 'save-turn',
      workspaceRoot: workspace,
      workingDirectory: workspace,
      mode: 'code',
      permissionMode: 'safe',
      signal: signal()
    };
    const approval = await saveTool.prepareApproval(
      {
        title: 'Phase 9.1 durable note',
        content: 'PHASE91_CONVERSATIONAL_KNOWLEDGE'
      },
      context
    );
    assert.match(approval.preview, /PHASE91_CONVERSATIONAL_KNOWLEDGE/);
    const saved = await saveTool.execute(
      {
        title: 'Phase 9.1 durable note',
        content: 'PHASE91_CONVERSATIONAL_KNOWLEDGE'
      },
      { ...context, approvalData: approval.executionData }
    );
    assert.equal(saved.isError, undefined);
    assert.equal(saved.metadata.indexStatus, 'refreshed');
    assert.equal(saved.metadata.persistentSideEffect, true);
    assert.match(
      await readFile(join(root, 'knowledge', 'library', 'phase-9-1-durable-note.md'), 'utf8'),
      /syzzz-managed-knowledge.*PHASE91_CONVERSATIONAL_KNOWLEDGE/s
    );
  });
});

test('restored sessions revalidate persisted RAG receipts before reusing old evidence', async () => {
  await withWorkspace(async ({ workspace, ragDirectory }) => {
    const sourcePath = join(workspace, 'README.md');
    await writeFile(sourcePath, '# Evidence\nPHASE91_RESUME_EVIDENCE\n', 'utf8');
    const rag = new RagRuntime({
      workspaceRoot: workspace,
      config: lexicalConfig,
      store: new RagStore(ragDirectory)
    });
    await rag.index({ signal: signal() });
    let step = 0;
    const provider = {
      async chat() {
        step += 1;
        if (step === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'resume-search',
                  name: 'RagSearch',
                  input: { query: 'PHASE91_RESUME_EVIDENCE' }
                }
              ]
            },
            finishReason: 'tool_calls'
          };
        }
        if (step === 2) {
          const [hit] = await rag.search({ query: 'PHASE91_RESUME_EVIDENCE', signal: signal() });
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'resume-read', name: 'RagRead', input: { chunkIds: [hit.chunkId] } }
              ]
            },
            finishReason: 'tool_calls'
          };
        }
        return {
          message: { role: 'assistant', content: 'Evidence captured.' },
          finishReason: 'stop'
        };
      },
      getInfo() {
        return {
          name: 'RAG receipt mock',
          type: 'mock',
          model: 'mock',
          capabilities: { streaming: false, reasoningToggle: false }
        };
      }
    };
    const first = new QueryEngine({
      provider,
      workspaceRoot: workspace,
      mode: 'ask',
      rag,
      audit: false
    });
    await first.chat('Capture indexed evidence');
    const state = first.exportState();
    assert.equal(state.ragContextReceipts.length, 1);

    await writeFile(sourcePath, '# Evidence\nPHASE91_CHANGED_AFTER_SESSION\n', 'utf8');
    const requests = [];
    const resumedProvider = {
      async chat(request) {
        requests.push(request);
        return {
          message: { role: 'assistant', content: 'Revalidation observed.' },
          finishReason: 'stop'
        };
      },
      getInfo: provider.getInfo
    };
    const resumed = new QueryEngine({
      provider: resumedProvider,
      workspaceRoot: workspace,
      mode: 'ask',
      rag,
      audit: false
    });
    resumed.restoreState(state);
    await resumed.chat('Continue safely');
    assert.ok(
      requests[0].messages.some(
        (message) =>
          message.role === 'user' &&
          message.kind === 'compaction-summary' &&
          /persisted RAG evidence receipts are no longer valid/.test(message.content)
      )
    );
    assert.equal(resumed.exportState().ragContextReceipts, undefined);
  });
});

test('Engine saves conversational knowledge only after approval and checkpoints the side effect', async () => {
  await withWorkspace(async ({ root, workspace, ragDirectory }) => {
    const rag = new RagRuntime({
      workspaceRoot: workspace,
      config: lexicalConfig,
      store: new RagStore(ragDirectory)
    });
    let step = 0;
    const provider = {
      async chat(request) {
        step += 1;
        if (step === 1) {
          assert.ok(request.tools.some((tool) => tool.name === 'SaveKnowledge'));
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'save-knowledge-engine',
                  name: 'SaveKnowledge',
                  input: {
                    title: 'Engine checkpoint note',
                    content: 'PHASE91_ENGINE_CHECKPOINT'
                  }
                }
              ]
            },
            finishReason: 'tool_calls'
          };
        }
        return {
          message: { role: 'assistant', content: 'Knowledge saved.' },
          finishReason: 'stop'
        };
      },
      getInfo() {
        return {
          name: 'RAG save mock',
          type: 'mock',
          model: 'mock',
          capabilities: { streaming: false, reasoningToggle: false }
        };
      }
    };
    const checkpoints = [];
    const approvals = [];
    const engine = new QueryEngine({
      provider,
      workspaceRoot: workspace,
      mode: 'code',
      rag,
      audit: false,
      checkpoint(reason, state) {
        checkpoints.push({ reason, state });
      }
    });
    const response = await engine.chat('Save this durable note', {
      async requestApproval(request) {
        approvals.push(request);
        return 'allow-once';
      }
    });
    assert.equal(response, 'Knowledge saved.');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].toolName, 'SaveKnowledge');
    assert.deepEqual(approvals[0].choices, ['allow-once', 'deny']);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].reason, 'file-side-effect');
    assert.equal(
      checkpoints[0].state.pendingFileChangeReceipts[0].path,
      'rag://library/engine-checkpoint-note.md'
    );
    assert.match(
      await readFile(join(root, 'knowledge', 'library', 'engine-checkpoint-note.md'), 'utf8'),
      /PHASE91_ENGINE_CHECKPOINT/
    );
  });
});
