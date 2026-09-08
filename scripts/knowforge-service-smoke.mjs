import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultConfig } from '../dist/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.KNOWFORGE_API_URL ?? 'http://127.0.0.1:18080';
const model = process.env.KNOWFORGE_MODEL ?? 'knowforge-qwen3-4b-base';
const key = process.env.KNOWFORGE_API_KEY ?? '';
const headers = {
  'content-type': 'application/json',
  ...(key ? { authorization: `Bearer ${key}` } : {})
};
const output = join(root, 'artifacts', 'knowforge-service', randomUUID());
const home = join(output, 'home');
const workspace = join(output, 'empty-workspace');
await mkdir(join(home, '.syzzz-code'), { recursive: true });
await mkdir(workspace, { recursive: true });
const config = getDefaultConfig();
config.currentProvider = 'knowforge';
config.providers = {
  knowforge: {
    name: 'KnowForge Server',
    type: 'openai-compatible',
    model,
    models: [model],
    modelContextWindows: { [model]: 16384 },
    env: {
      BASE_URL: `${baseUrl}/v1`,
      API_KEY: key ? '' : 'local-only',
      ...(key ? { API_KEY_ENV: 'KNOWFORGE_API_KEY' } : {})
    }
  }
};
config.rag = {
  enabled: true,
  autoRetrieve: 'off',
  autoRefresh: false,
  service: {
    enabled: true,
    baseUrl,
    collections: ['techdocs', 'juststudy', 'library'],
    timeoutMs: 30000,
    ...(key ? { apiKeyEnv: 'KNOWFORGE_API_KEY' } : {})
  }
};
config.sessions.autoSave = false;
config.skills.enabled = false;
config.subagents.enabled = false;
await writeFile(join(home, '.syzzz-code', 'config.json'), JSON.stringify(config, null, 2), {
  mode: 0o600
});

async function json(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function cli(id, prompt) {
  const events = [];
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      join(root, 'dist/index.js'),
      'chat',
      '--mode',
      'ask',
      '-m',
      prompt,
      '--output-format',
      'stream-json'
    ],
    {
      cwd: workspace,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  let buffer = '';
  let stderr = '';
  let parseError = false;
  child.stdout.on('data', (bytes) => {
    buffer += bytes.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        parseError = true;
      }
    }
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString();
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 240000);
  const code = await new Promise((accept, reject) => {
    child.on('error', reject);
    child.on('close', accept);
  });
  clearTimeout(timer);
  const answer = events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
  const tools = events
    .filter((event) => event.type === 'tool_completed')
    .map((event) => ({ name: event.toolName, outcome: event.outcome }));
  const verification = events
    .filter((event) => event.type.startsWith('rag_verification_'))
    .map((event) => ({
      type: event.type,
      outcome: event.outcome,
      invalidCitationCount: event.invalidCitationCount
    }));
  const result = {
    id,
    exitCode: code,
    timedOut,
    ndjsonValid: !parseError && !buffer.trim(),
    durationMs: Math.round(performance.now() - started),
    tools,
    verification,
    outputSha256: createHash('sha256').update(answer).digest('hex'),
    outputChars: answer.length,
    completed: events.some((event) => event.type === 'turn_completed'),
    failed: events.filter((event) => event.type === 'turn_failed').map((event) => event.error.code),
    stderrPresent: Boolean(stderr.trim())
  };
  // Display for the operator, but persist only hashes and diagnostic metadata.
  console.log(JSON.stringify(result));
  console.log(`ANSWER ${id}: ${answer}`);
  return { result, answer };
}

const report = {
  schemaVersion: 1,
  kind: 'unified-service-smoke',
  model,
  createdAt: new Date().toISOString(),
  privacy: { promptPersisted: false, responsePersisted: false, secretsPersisted: false },
  checks: {},
  cases: []
};
report.checks.health = (await json('/healthz')).status === 'ready';
const statuses = await json('/knowledge/status');
report.collections = statuses.collections.map(({ name, fileCount, chunkCount, health }) => ({
  name,
  fileCount,
  chunkCount,
  health
}));
report.collectionProbes = [];
for (const [name, query] of [
  ['techdocs', 'TestClient lifespan with statement'],
  ['juststudy', 'RAG'],
  ['library', 'Syzzz RAG']
]) {
  const found = await json('/knowledge/search', { collections: [name], query, limit: 3 });
  const read = await json('/knowledge/read', {
    collections: [name],
    chunkIds: found.hits.map((hit) => hit.chunkId)
  });
  report.collectionProbes.push({
    name,
    found: found.hits.length,
    read: read.chunks.length,
    passed:
      found.hits.length > 0 &&
      read.chunks.length > 0 &&
      read.chunks.every((chunk) => chunk.virtualPath.startsWith(`rag://${name}/`))
  });
}
report.checks.allCollectionsReadable = report.collectionProbes.every((probe) => probe.passed);
const raw = await json('/v1/chat/completions', {
  model,
  messages: [{ role: 'user', content: 'Reply with only OK.' }],
  max_tokens: 16,
  temperature: 0
});
report.checks.nonStream =
  typeof raw.choices[0].message.content === 'string' &&
  raw.choices[0].message.content.length > 0 &&
  Boolean(raw.choices[0].finish_reason) &&
  raw.usage?.total_tokens > 0;
report.modelObservations = { exactOkInstruction: raw.choices[0].message.content.trim() === 'OK' };
const stream = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers,
  signal: AbortSignal.timeout(60000),
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'List the numbers 1 to 20, separated by spaces.' }],
    max_tokens: 96,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0
  })
});
let streamText = '';
let networkChunks = 0;
let firstDeltaMs;
const streamStarted = performance.now();
for await (const bytes of stream.body) {
  networkChunks += 1;
  streamText += Buffer.from(bytes).toString('utf8');
  if (firstDeltaMs === undefined && /"content"\s*:\s*"[^"\s]/.test(streamText))
    firstDeltaMs = Math.round(performance.now() - streamStarted);
}
report.checks.streaming = stream.ok && networkChunks > 1 && streamText.includes('[DONE]');
report.streaming = {
  networkChunks,
  firstDeltaMs,
  totalMs: Math.round(performance.now() - streamStarted)
};
const ordinary = await cli('ordinary', '请用两句话解释 RAG，不需要使用任何工具。');
report.cases.push(ordinary.result);
const evidence = await cli(
  'evidence',
  '只使用 techdocs。先调用 RagSearch，query 为 TestClient lifespan with statement；再 RagRead 最相关片段。请用中文一句话说明如何在测试中运行 lifespan，必须包含准确的 [[rag:...]] 引用，不要写代码，不要补充其他方法。'
);
report.cases.push(evidence.result);
const unsupported = await cli(
  'no-evidence',
  '请用中文回答，只根据 techdocs：FastAPI 官方商业支持合同的价格、SLA 和退款条款是什么？先检索；没有明确材料就回答证据不足，不要猜测。'
);
report.cases.push(unsupported.result);
report.checks.cliOrdinary = ordinary.result.completed && ordinary.result.exitCode === 0;
report.checks.cliEvidence =
  evidence.result.completed &&
  evidence.result.exitCode === 0 &&
  evidence.result.ndjsonValid &&
  evidence.result.tools.some((t) => t.name === 'RagRead' && t.outcome === 'success') &&
  evidence.result.verification.some(
    (event) => event.outcome === 'supported' && event.invalidCitationCount === 0
  ) &&
  /\[\[rag:[a-f0-9]+\]\]/.test(evidence.answer) &&
  /with/.test(evidence.answer) &&
  !/```|TestClient\s*\(/.test(evidence.answer) &&
  !/grounding blocked/.test(evidence.answer);
report.checks.cliNoEvidence =
  unsupported.result.completed &&
  unsupported.result.tools.some((t) => t.name === 'RagSearch') &&
  /证据不足|没有.{0,15}(明确|说明|信息)|no relevant evidence|cannot provide|insufficient evidence/i.test(
    unsupported.answer
  ) &&
  !/\[\[rag:/.test(unsupported.answer);
report.modelObservations.chineseRefusal = /\p{Script=Han}/u.test(unsupported.answer);
report.passed = Object.values(report.checks).every(Boolean);
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    report: join(output, 'report.json'),
    passed: report.passed,
    checks: report.checks
  })
);
process.exitCode = report.passed ? 0 : 1;
