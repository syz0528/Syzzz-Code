import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { RagRuntime } from '../dist/rag/runtime.js';
import { RagStore } from '../dist/rag/store.js';
import { tokenizeRagText } from '../dist/rag/tokenizer.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(projectRoot, 'eval', 'fixtures', 'rag-project');
const offlineDatasetPath = join(projectRoot, 'eval', 'rag-eval-v1.json');

function parseArguments(argv) {
  let suite = 'offline';
  let root;
  let dataset;
  let output;
  let approveRemote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--suite') suite = argv[++index];
    else if (argument === '--root') root = argv[++index];
    else if (argument === '--dataset') dataset = argv[++index];
    else if (argument === '--output') output = argv[++index];
    else if (argument === '--approve-remote') approveRemote = true;
    else throw new Error(`Unknown RAG eval argument: ${argument}`);
  }
  if (suite !== 'offline' && suite !== 'live')
    throw new Error('RAG eval suite must be offline or live');
  return { suite, root, dataset, output, approveRemote };
}

function vectorFor(text) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const vector = new Array(12).fill(0);
  const concepts = [
    ['durable', 'semantic memory', 'retrieval lifecycle', '持久化知识召回', '版本化本地索引'],
    ['permission', 'read/never', '权限', '只读'],
    ['citation', '引用', 'sourcehash', '行范围'],
    ['context', '上下文', '渐进证据'],
    ['fusion', 'rrf', 'reciprocal rank fusion', '混合检索'],
    ['chinese', 'cjk', '中文', '双字'],
    ['receipt', 'createevidencereceipt', '回执'],
    ['remote', 'embedding', 'reranker', '授权'],
    ['atomic', 'current', 'revision', '原子'],
    ['verify', 'supported', 'partial', '语义验证']
  ];
  concepts.forEach((terms, index) => {
    if (terms.some((term) => normalized.includes(term))) vector[index] += 4;
  });
  for (const token of tokenizeRagText(normalized)) {
    const hash = createHash('sha256').update(token).digest();
    vector[hash[0] % vector.length] += 0.05;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function rerankScore(query, document) {
  const queryTerms = new Set(tokenizeRagText(query));
  const documentTerms = new Set(tokenizeRagText(document));
  let score = [...queryTerms].filter((term) => documentTerms.has(term)).length;
  const queryVector = vectorFor(query);
  const documentVector = vectorFor(document);
  score += queryVector.reduce((sum, value, index) => sum + value * documentVector[index], 0) * 10;
  return score;
}

async function createMockRetrievalServer() {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/embeddings') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      response.end(
        JSON.stringify({
          data: inputs.map((text, index) => ({ index, embedding: vectorFor(String(text)) }))
        })
      );
      return;
    }
    if (request.url === '/v1/rerank') {
      const results = body.documents
        .map((document, index) => ({
          index,
          relevance_score: rerankScore(String(body.query), String(document))
        }))
        .sort(
          (left, right) => right.relevance_score - left.relevance_score || left.index - right.index
        );
      response.end(JSON.stringify({ results }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Mock RAG server did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  };
}

async function readDataset(path) {
  const dataset = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(dataset.cases)) throw new Error('RAG eval dataset has no cases');
  return dataset;
}

function normalizeLiveDataset(dataset) {
  return {
    schemaVersion: 1,
    datasetId: dataset.dataset_id ?? 'external-rag-eval',
    corpusPaths: [
      ...new Set((dataset.corpus_profiles ?? []).flatMap((profile) => profile.source_paths ?? []))
    ],
    cases: dataset.cases.map((entry) => ({
      id: entry.id,
      query: entry.question,
      negative: entry.answerability === 'unanswerable',
      evidence: (entry.evidence ?? []).map((evidence) => ({
        path: evidence.source_path,
        anchor: evidence.anchor_text
      }))
    }))
  };
}

async function materializeLiveCorpus(root, dataset, temporary) {
  const paths = dataset.corpusPaths ?? [];
  if (paths.length === 0) return { root, mode: 'workspace', fileCount: undefined };
  const canonicalRoot = await realpath(root);
  const corpusRoot = join(temporary, 'corpus');
  for (const path of paths) {
    const normalized = String(path).replaceAll('\\', '/');
    if (
      !normalized ||
      isAbsolute(normalized) ||
      /^[a-z]:/iu.test(normalized) ||
      normalized.split('/').some((segment) => segment === '..')
    ) {
      throw new Error(`Live RAG eval contains an unsafe corpus path: ${path}`);
    }
    const source = resolve(root, normalized);
    const destination = resolve(corpusRoot, normalized);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Live RAG eval corpus path is not a regular file: ${path}`);
    }
    const canonicalSource = await realpath(source);
    if (
      relative(canonicalRoot, canonicalSource).startsWith('..') ||
      relative(corpusRoot, destination).startsWith('..')
    ) {
      throw new Error(`Live RAG eval corpus path escapes its root: ${path}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { force: false, errorOnExist: true });
  }
  return { root: corpusRoot, mode: 'profile-union', fileCount: paths.length };
}

async function labelResolution(runtime, cases) {
  let total = 0;
  let resolved = 0;
  for (const entry of cases) {
    for (const evidence of entry.evidence) {
      total += 1;
      const hits = await runtime.search({
        query: evidence.anchor,
        path: evidence.path,
        limit: 50,
        signal: AbortSignal.timeout(20_000)
      });
      const matched = [];
      for (const hit of hits) {
        const chunk = await runtime.inspectChunk(hit.chunkId, AbortSignal.timeout(20_000));
        if (
          chunk?.virtualPath.endsWith(`/${evidence.path}`) &&
          chunk.text.includes(evidence.anchor)
        )
          matched.push(chunk);
      }
      if (matched.length > 0) resolved += 1;
    }
  }
  return { total, resolved, rate: total === 0 ? 1 : resolved / total };
}

function evaluateHits(entry, hits) {
  if (entry.negative) {
    const leaked = hits.some((hit) =>
      /(?:^|\/)(?:\.env(?:\.|$)|credentials(?:\.json)?$)|secret/iu.test(hit.virtualPath)
    );
    return { recall: leaked ? 0 : 1, reciprocalRank: leaked ? 0 : 1, negativePassed: !leaked };
  }
  const expected = new Set(entry.evidence.map((evidence) => evidence.path));
  const found = new Set(
    hits
      .filter((hit) => [...expected].some((path) => hit.virtualPath.endsWith(`/${path}`)))
      .map((hit) => [...expected].find((path) => hit.virtualPath.endsWith(`/${path}`)))
  );
  const firstRelevant = hits.findIndex((hit) =>
    [...expected].some((path) => hit.virtualPath.endsWith(`/${path}`))
  );
  return {
    recall: expected.size === 0 ? 1 : found.size / expected.size,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    negativePassed: true
  };
}

async function runRetrieval(runtime, cases) {
  const rows = [];
  for (const entry of cases) {
    const hits = await runtime.search({
      ...(entry.query ? { query: entry.query } : {}),
      ...(entry.queries ? { queries: entry.queries } : {}),
      ...(entry.path ? { path: entry.path } : {}),
      limit: 10,
      signal: AbortSignal.timeout(30_000)
    });
    rows.push({ id: entry.id, ...evaluateHits(entry, hits), resultCount: hits.length });
  }
  return {
    rows,
    recallAt10: rows.reduce((sum, row) => sum + row.recall, 0) / rows.length,
    mrrAt10: rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length,
    negativePassed: rows.every((row) => row.negativePassed)
  };
}

async function gitCommit() {
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolveCommit) => {
      execFile(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: projectRoot, encoding: 'utf8' },
        (error, stdout) => resolveCommit(error ? undefined : stdout.trim())
      );
    });
  } catch {
    return undefined;
  }
}

async function writeReport(report, output) {
  const path =
    output ??
    join(
      projectRoot,
      'eval-results',
      `${new Date().toISOString().replaceAll(':', '-')}-rag-${report.suite}.json`
    );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

async function runOffline(args) {
  const temporary = await mkdtemp(join(tmpdir(), 'syzzz-rag-eval-'));
  const workspace = join(temporary, 'workspace');
  const server = await createMockRetrievalServer();
  try {
    await cp(fixtureRoot, workspace, { recursive: true });
    const dataset = await readDataset(offlineDatasetPath);
    const store = new RagStore(join(temporary, 'rag'));
    const hybrid = new RagRuntime({
      workspaceRoot: workspace,
      store,
      config: {
        enabled: true,
        autoRetrieve: 'off',
        autoRefresh: true,
        embedding: {
          type: 'openai-compatible',
          model: 'mock-phase9-embedding',
          dimensions: 12,
          env: { BASE_URL: server.baseUrl, API_KEY: 'eval-only' }
        },
        reranker: {
          type: 'jina-compatible',
          model: 'mock-phase9-reranker',
          env: { BASE_URL: server.baseUrl, API_KEY: 'eval-only' }
        }
      }
    });
    await hybrid.index({ signal: AbortSignal.timeout(60_000), confirmRemote: async () => true });
    const lexical = new RagRuntime({
      workspaceRoot: workspace,
      store,
      config: { enabled: true, autoRetrieve: 'off', autoRefresh: true }
    });
    const labels = await labelResolution(lexical, dataset.cases);
    const lexicalMetrics = await runRetrieval(lexical, dataset.cases);
    const hybridMetrics = await runRetrieval(hybrid, dataset.cases);
    const improved =
      hybridMetrics.recallAt10 > lexicalMetrics.recallAt10 ||
      hybridMetrics.mrrAt10 > lexicalMetrics.mrrAt10;
    const passed =
      labels.rate === 1 &&
      hybridMetrics.recallAt10 >= 0.9 &&
      hybridMetrics.mrrAt10 >= 0.9 &&
      hybridMetrics.negativePassed &&
      improved;
    return {
      schemaVersion: 1,
      suite: 'offline',
      datasetId: dataset.datasetId,
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      gitCommit: await gitCommit(),
      caseCount: dataset.cases.length,
      labelResolution: labels,
      lexical: { recallAt10: lexicalMetrics.recallAt10, mrrAt10: lexicalMetrics.mrrAt10 },
      hybrid: { recallAt10: hybridMetrics.recallAt10, mrrAt10: hybridMetrics.mrrAt10 },
      hybridImproved: improved,
      negativePassed: hybridMetrics.negativePassed,
      cases: hybridMetrics.rows.map(
        ({ id, recall, reciprocalRank, resultCount, negativePassed }) => ({
          id,
          recall,
          reciprocalRank,
          resultCount,
          negativePassed
        })
      ),
      passed
    };
  } finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runLive(args) {
  const rootInput = args.root ?? process.env.SYZZZ_RAG_LIVE_ROOT;
  if (!rootInput) throw new Error('Live RAG eval requires --root or SYZZZ_RAG_LIVE_ROOT');
  const root = resolve(rootInput);
  await access(root);
  const datasetPath = resolve(
    args.dataset ??
      process.env.SYZZZ_RAG_LIVE_DATASET ??
      join(root, 'docs', 'evaluation', 'task5.3-rag-eval-v1.json')
  );
  const rawDataset = await readDataset(datasetPath);
  const dataset = rawDataset.dataset_id ? normalizeLiveDataset(rawDataset) : rawDataset;
  const temporary = await mkdtemp(join(tmpdir(), 'syzzz-rag-live-'));
  try {
    const corpus = await materializeLiveCorpus(root, dataset, temporary);
    const configured = loadConfig().rag;
    const remoteEnabled = args.approveRemote && Boolean(configured.embedding);
    const runtime = new RagRuntime({
      workspaceRoot: corpus.root,
      store: new RagStore(join(temporary, 'rag')),
      config: remoteEnabled ? configured : { enabled: true, autoRetrieve: 'off', autoRefresh: true }
    });
    await runtime.index({
      signal: AbortSignal.timeout(180_000),
      confirmRemote: async () => args.approveRemote
    });
    const labels = await labelResolution(runtime, dataset.cases);
    const metrics = await runRetrieval(runtime, dataset.cases);
    return {
      schemaVersion: 1,
      suite: 'live',
      datasetId: dataset.datasetId,
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      gitCommit: await gitCommit(),
      caseCount: dataset.cases.length,
      remoteEnabled,
      corpusMode: corpus.mode,
      ...(corpus.fileCount === undefined ? {} : { corpusFileCount: corpus.fileCount }),
      labelResolution: labels,
      retrieval: { recallAt10: metrics.recallAt10, mrrAt10: metrics.mrrAt10 },
      baselines: {
        originalRecallAt10: 0.6666666666666666,
        originalMrrAt10: 0.5407407407407407,
        phase9PlanGate: 0.667
      },
      negativePassed: metrics.negativePassed,
      cases: metrics.rows.map(({ id, recall, reciprocalRank, resultCount, negativePassed }) => ({
        id,
        recall,
        reciprocalRank,
        resultCount,
        negativePassed
      })),
      passed:
        labels.rate === 1 &&
        metrics.recallAt10 >= 0.667 &&
        metrics.mrrAt10 >= 0.667 &&
        metrics.negativePassed
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const args = parseArguments(process.argv.slice(2));
const report = args.suite === 'offline' ? await runOffline(args) : await runLive(args);
const reportPath = await writeReport(report, args.output);
console.log(`RAG ${report.suite} eval: ${report.passed ? 'PASS' : 'FAIL'}`);
console.log(`Report: ${reportPath}`);
if (!report.passed) process.exitCode = 1;
