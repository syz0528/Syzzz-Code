import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryEngine } from '../dist/engine.js';
import { createProvider } from '../dist/providers/factory.js';
import { RagRuntime } from '../dist/rag/runtime.js';
import {
  createProviderRagVerifier,
  createProviderRagAnswerRepairer
} from '../dist/rag/verifier.js';
import { createProviderRagQueryRewriter } from '../dist/rag/query-rewriter.js';
import { buildCases, fixtureFiles } from './decision-eval-cases.mjs';
import {
  assess,
  canPrefetch,
  compareDecision,
  decisionInstructions,
  decisionState,
  DECISION_SYSTEM,
  percentile,
  ruleDecision,
  validateDecision
} from './decision-eval-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const split = arg('--split', 'dev');
const stage = arg('--stage', 'run');
const arms = arg('--arms', 'baseline,oracle-hint,oracle-route').split(',');
const allowedArms = [
  'baseline',
  'oracle-hint',
  'oracle-route',
  'rule-hint',
  'rule-route',
  'llm-hint',
  'llm-route'
];
if (arms.some((arm) => !allowedArms.includes(arm)) || new Set(arms).size !== arms.length)
  throw new Error('Invalid arms');
if (!['prepare', 'run', 'screen'].includes(stage)) throw new Error('Invalid stage');
const repetitions = Number(arg('--repetitions', '1'));
if (![1, 2].includes(repetitions)) throw new Error('Repetitions must be 1 or 2');
const allCases = buildCases(split);
const selected = arg('--cases', '').split(',').filter(Boolean);
const cases = allCases.filter((item) => !selected.length || selected.includes(item.id));
if (!cases.length || selected.some((id) => !allCases.some((item) => item.id === id)))
  throw new Error('Invalid case IDs');
const output = resolve(
  arg('--output', join(root, 'artifacts/decision-eval', `${Date.now()}-${stage}-${split}`))
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function snapshot() {
  const hashes = {};
  async function walk(directory) {
    for (const file of (await readdir(join(root, directory), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      const path = `${directory}/${file.name}`;
      if (file.isDirectory()) await walk(path);
      else if (file.isFile()) hashes[path] = sha(await readFile(join(root, path)));
    }
  }
  for (const directory of ['src', 'dist', 'scripts']) await walk(directory);
  hashes['package-lock.json'] = sha(await readFile(join(root, 'package-lock.json')));
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true
    }).trim(),
    hash: sha(JSON.stringify(hashes)),
    files: hashes
  };
}
const report = {
  schemaVersion: 1,
  stage,
  split,
  arms,
  repetitions,
  startedAt: new Date().toISOString(),
  datasetHash: sha(JSON.stringify(allCases)),
  baselineSnapshot: await snapshot(),
  review: 'Codex-reviewed synthetic/public fixtures, not independent human Gold',
  complete: false,
  results: [],
  decisions: [],
  protocol: {
    model: 'knowforge-qwen3-4b-base',
    context: 16384,
    autoRetrieve: 'off except route arm prefetch',
    taskCompletionReview: false,
    maxToolRounds: 6,
    maxToolCalls: 10,
    maxProviderCalls: 12,
    turnDeadlineMs: 45000,
    decisionDeadlineMs: 10000,
    approval: 'deny',
    askUserHandler: false,
    history: 'fixed synthetic context via restoreState, no generated setup turn',
    privateCollectionsRead: false,
    externalRequests: false,
    sampling: 'unchanged provider defaults',
    decisionTemperature: 0,
    Jev: 'not tested: no dedicated credential configured',
    scores: 'automatic diagnostics, not expert correctness'
  }
};
await writeFile(join(output, 'dataset.json'), JSON.stringify(allCases, null, 2));
await writeFile(
  join(output, 'review-samples.md'),
  '# 需求标注复核样例\n\n审核：Codex，用户授权代审，不是独立人工 Gold。\n\n' +
    allCases
      .slice(0, 12)
      .map(
        (item) =>
          `## ${item.id}\n\n${item.prompt}\n\n历史：${JSON.stringify(item.history ?? [])}\n\n期望：${JSON.stringify(item.expected)}\n\n判断依据：${item.group === 'scope' ? '引号内指令是数据；外层明确禁止知识库和修改。' : item.group === 'clarify' ? '历史有两个候选对象且未选择，需要先澄清，不应擅自读取。' : item.group === 'mixed' ? '请求明确包含文档结论和本地设置两个独立交付。' : item.expected.rag ? '回答受技术文档来源约束；商业条款题仍应先检索再说明材料局限。' : '仅使用给定文本或指定本地文件，不需要知识库。'}\n`
      )
      .join('\n')
);
const save = async () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
if (stage === 'prepare') {
  report.complete = true;
  await save();
  console.log(
    JSON.stringify({ stage, output, cases: allCases.length, datasetHash: report.datasetHash })
  );
  process.exit(0);
}

const base = 'http://127.0.0.1:18080';
const control = new AbortController();
const cancel = () => control.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
async function api(path, body, signal = AbortSignal.timeout(10000)) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.any([signal, control.signal]),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`Loopback ${path}: HTTP ${response.status}`);
  return response.json();
}
const model = report.protocol.model;
function provider() {
  return createProvider({
    name: 'KnowForge eval',
    type: 'openai-compatible',
    model,
    modelContextWindows: { [model]: 16384 },
    env: { BASE_URL: base + '/v1', API_KEY: 'local-only' }
  });
}
let faultServer;
let faultUrl;

async function decide(item) {
  const started = performance.now();
  const record = { id: item.id, candidate: 'llm', elapsedMs: 0 };
  try {
    const result = await api(
      '/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: DECISION_SYSTEM },
          { role: 'user', content: JSON.stringify(decisionState(item)) }
        ],
        max_tokens: 256,
        temperature: 0,
        stream: false
      },
      AbortSignal.timeout(10000)
    );
    const content = result.choices?.[0]?.message?.content;
    record.decision = validateDecision(JSON.parse(content));
    record.usage = result.usage;
    record.finishReason = result.choices?.[0]?.finish_reason;
  } catch (error) {
    if (control.signal.aborted) throw error;
    record.error = error.name + ': ' + error.message.slice(0, 256);
  }
  record.elapsedMs = Math.round(performance.now() - started);
  record.score = compareDecision(record.decision, item.expected);
  return record;
}

async function run(item, arm, repetition) {
  const started = performance.now();
  const deadline = AbortSignal.timeout(45000);
  const signal = AbortSignal.any([deadline, control.signal]);
  const workspace = join(output, `${item.id}-${arm}-${repetition}`);
  await mkdir(workspace);
  const files = fixtureFiles([item]);
  for (const [file, content] of Object.entries(files))
    await writeFile(join(workspace, file), content);
  const entry = {
    id: item.id,
    group: item.group,
    arm,
    repetition,
    tools: [],
    retrievals: 0,
    evidence: [],
    verification: [],
    requests: [],
    drafts: [],
    answer: '',
    usage: { input: 0, output: 0 },
    firstTextMs: null
  };
  let decision;
  if (arm.startsWith('oracle')) decision = item.expected;
  else if (arm.startsWith('rule')) decision = ruleDecision(item);
  else if (arm.startsWith('llm')) {
    entry.decision = await decide(item);
    decision = entry.decision.decision;
  }
  const main = provider();
  const original = main.chatStream.bind(main);
  main.chatStream = async function* (...parameters) {
    const generator = original(...parameters);
    try {
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          entry.drafts.push(next.value.message.content.slice(0, 8192));
          return next.value;
        }
        if (
          next.value.type === 'text_delta' &&
          entry.firstTextMs === null &&
          next.value.text.trim()
        )
          entry.firstTextMs = Math.round(performance.now() - started);
        yield next.value;
      }
    } finally {
      await generator.return();
    }
  };
  const rag = new RagRuntime({
    workspaceRoot: workspace,
    config: {
      enabled: true,
      autoRetrieve: arm.endsWith('route') && canPrefetch(decision) ? 'all' : 'off',
      autoRefresh: false,
      service: {
        enabled: true,
        baseUrl: item.fault ? faultUrl : base,
        collections: ['techdocs'],
        timeoutMs: 10000
      }
    },
    queryRewriter: createProviderRagQueryRewriter(main),
    semanticVerifier: createProviderRagVerifier(main),
    answerRepairer: createProviderRagAnswerRepairer(main)
  });
  const search = rag.search.bind(rag);
  rag.search = async (input) => {
    entry.retrievals++;
    return search(input);
  };
  const read = rag.readChunks.bind(rag);
  rag.readChunks = async (...input) => {
    const result = await read(...input);
    entry.evidence.push(...result.chunks.map((chunk) => chunk.virtualPath));
    return result;
  };
  const engine = new QueryEngine({
    provider: main,
    rag,
    workspaceRoot: workspace,
    mode: 'ask',
    permissionMode: 'safe',
    audit: false,
    maxToolRounds: 6,
    maxToolCalls: 10,
    maxProviderCalls: 12,
    experimentalTaskCompletionReview: false,
    ...(decision ? { systemPromptSuffix: decisionInstructions(decision) } : {})
  });
  if (item.history) engine.restoreState({ ...engine.exportState(), messages: item.history });
  const usages = new Map();
  try {
    const generator = engine.runTurn(item.prompt, { signal, requestApproval: async () => 'deny' });
    try {
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          entry.status = next.value.status;
          entry.answer = next.value.response ?? '';
          entry.error = next.value.error;
          break;
        }
        const event = next.value;
        if (event.type === 'tool_completed')
          entry.tools.push({
            name: event.toolName,
            outcome: event.outcome,
            result: (event.result ?? '').slice(0, 10000)
          });
        if (event.type.startsWith('rag_verification_'))
          entry.verification.push({
            type: event.type,
            outcome: event.outcome,
            invalidCitationCount: event.invalidCitationCount,
            code: event.code
          });
        if (event.type === 'usage_updated') usages.set(event.attemptId, event.usage);
        if (event.type === 'provider_request_completed' || event.type === 'provider_request_failed')
          entry.requests.push({
            type: event.type,
            purpose: event.purpose,
            durationMs: event.durationMs,
            error: event.error?.code
          });
      }
    } finally {
      await generator.return();
    }
  } catch (error) {
    entry.status = 'harness-error';
    entry.error = { code: error.name, message: error.message.slice(0, 512) };
  } finally {
    await engine.close();
  }
  entry.durationMs = Math.round(performance.now() - started);
  entry.deadlineReached = deadline.aborted;
  entry.filesUnchanged =
    JSON.stringify((await readdir(workspace)).sort()) === JSON.stringify(Object.keys(files).sort());
  for (const [file, content] of Object.entries(files))
    entry.filesUnchanged &&= (await readFile(join(workspace, file), 'utf8')) === content;
  for (const usage of usages.values()) {
    entry.usage.input += usage.inputTokens ?? 0;
    entry.usage.output += usage.outputTokens ?? 0;
  }
  entry.usage.input += entry.decision?.usage?.prompt_tokens ?? 0;
  entry.usage.output += entry.decision?.usage?.completion_tokens ?? 0;
  entry.checks = assess(item, entry);
  entry.automaticPass = Object.values(entry.checks).every(Boolean);
  report.results.push(entry);
  await save();
  console.log(
    JSON.stringify({
      id: item.id,
      arm,
      repetition,
      status: entry.status,
      pass: entry.automaticPass,
      failed: Object.entries(entry.checks)
        .filter(([, ok]) => !ok)
        .map(([key]) => key),
      durationMs: entry.durationMs,
      answer: entry.answer.slice(0, 500)
    })
  );
}

try {
  const health = await api('/healthz');
  if (!health.modelReady || !health.knowledgeReady) throw new Error('Service unavailable');
  const models = await api('/v1/models');
  if (!models.data.some((item) => item.id === model)) throw new Error('Wrong model');
  const status = await api('/knowledge/status');
  report.collection = status.collections.find((item) => item.name === 'techdocs');
  if (report.collection?.health !== 'fresh') throw new Error('techdocs not fresh');
  // Refuse accidental remote calls, including a redirect. Never inspect private collections.
  const originalFetch = globalThis.fetch;
  faultServer = createServer((_req, res) => {
    res.writeHead(503);
    res.end('{}');
  });
  await new Promise((resolve) => faultServer.listen(0, '127.0.0.1', resolve));
  faultUrl = `http://127.0.0.1:${faultServer.address().port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input.url ?? input.href));
    if (![base, faultUrl].includes(url.origin)) throw new Error('Evaluation network scope denied');
    if (url.pathname.startsWith('/knowledge/') && typeof init?.body === 'string') {
      const body = JSON.parse(init.body);
      if (body.collections?.some((name) => name !== 'techdocs'))
        throw new Error('Private collection access denied');
    }
    return originalFetch(input, { ...init, redirect: 'error' });
  };
  try {
    await api('/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      max_tokens: 8,
      temperature: 0
    });
    if (stage === 'screen') {
      for (const item of cases) {
        if (control.signal.aborted) break;
        const rules = validateDecision(ruleDecision(item));
        report.decisions.push(
          {
            id: item.id,
            candidate: 'rule',
            decision: rules,
            score: compareDecision(rules, item.expected)
          },
          await decide(item)
        );
        await save();
        console.log(JSON.stringify({ id: item.id, decisions: report.decisions.slice(-2) }));
      }
    } else {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        for (const [index, item] of cases.entries()) {
          const offset = (index + repetition - 1) % arms.length;
          const order = [...arms.slice(offset), ...arms.slice(0, offset)];
          for (const arm of order) {
            if (control.signal.aborted) break;
            await run(item, arm, repetition);
          }
          if (control.signal.aborted) break;
        }
        if (control.signal.aborted) break;
      }
    }
    const after = (await api('/knowledge/status')).collections.find(
      (item) => item.name === 'techdocs'
    );
    report.collectionUnchanged = JSON.stringify(after) === JSON.stringify(report.collection);
  } finally {
    globalThis.fetch = originalFetch;
  }
  report.codeUnchanged = (await snapshot()).hash === report.baselineSnapshot.hash;
  report.complete =
    !control.signal.aborted &&
    report.collectionUnchanged &&
    report.codeUnchanged &&
    (stage === 'screen'
      ? report.decisions.length === cases.length * 2
      : report.results.length === cases.length * arms.length * repetitions);
} catch (error) {
  report.infrastructureError = error.message;
} finally {
  if (faultServer) {
    faultServer.closeAllConnections();
    await new Promise((resolve) => faultServer.close(resolve));
  }
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(
    arms.map((arm) => {
      const rows = report.results.filter((item) => item.arm === arm);
      return [
        arm,
        {
          count: rows.length,
          automaticPass: rows.filter((item) => item.automaticPass).length,
          p50: percentile(
            rows.map((item) => item.durationMs),
            0.5
          ),
          p95: percentile(
            rows.map((item) => item.durationMs),
            0.95
          ),
          timeouts: rows.filter((item) => item.deadlineReached).length,
          input: rows.reduce((sum, item) => sum + item.usage.input, 0),
          output: rows.reduce((sum, item) => sum + item.usage.output, 0)
        }
      ];
    })
  );
  await save();
  console.log(
    JSON.stringify({
      output,
      complete: report.complete,
      summary: report.summary,
      error: report.infrastructureError
    })
  );
}
process.exitCode = control.signal.aborted ? 130 : report.complete ? 0 : 1;
