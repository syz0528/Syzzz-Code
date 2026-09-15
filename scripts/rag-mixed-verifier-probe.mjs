import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createProvider } from '../dist/providers/factory.js';
import { readUtf8Range } from '../dist/tools/read-range.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
if (!args.includes('--baseline') || !args.includes('--output'))
  throw new Error('Provide --baseline <built checkout> --output <new directory>');
const output = resolve(option('--output'));
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const workspace = join(output, 'fixture');
await mkdir(workspace);
await writeFile(
  join(workspace, 'test_lifespan.py'),
  'client = TestClient(app)\nassert client.get("/").status_code == 200\n'
);
const read = await readUtf8Range(
  join(workspace, 'test_lifespan.py'),
  'test_lifespan.py',
  1,
  2,
  true,
  new AbortController().signal
);
const localEvidence = [{ ...read.data, id: 'local-read-1' }];
const text =
  'When you need lifespan to run in your tests, you can use the TestClient with a with statement.';
const chunk = {
  id: 'a'.repeat(32),
  collectionId: 'fixture',
  virtualPath: 'rag://fixture/testing.md',
  lineStart: 1,
  lineEnd: 1,
  text,
  sourceHash: createHash('sha256').update(text).digest('hex'),
  sourceBytes: text.length,
  sourceMtimeMs: 0,
  revision: 'public-fixture-v1',
  language: 'markdown'
};
const citation = `[[rag:${chunk.id}]]`;
const cases = [
  {
    id: 'supported-comparison',
    expected: 'supported',
    draft: `${citation} 文档要求使用 TestClient 的 with 语句运行 lifespan；本地 test_lifespan.py 的第 1–2 行只有 client = TestClient(app) 和断言，没有 with 语句。`
  },
  {
    id: 'invented-local-with',
    expected: 'not-supported',
    draft: `${citation} 本地 test_lifespan.py 第 1–2 行已经使用 with TestClient(app) as client，因此符合文档要求。`
  },
  {
    id: 'invented-test-success',
    expected: 'not-supported',
    draft: `${citation} 已经执行 test_lifespan.py，测试通过，响应状态为 200。`
  }
];
const roots = { baseline: resolve(option('--baseline')), candidate: repo };
const report = {
  schemaVersion: 1,
  kind: 'isolated-mixed-verifier-probe',
  warning:
    'Controlled public evidence and fixed drafts, not end-to-end Agent success or expert accuracy.',
  cases,
  results: []
};
for (const [index, item] of cases.entries()) {
  for (const arm of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const { createProviderRagVerifier } = await import(
      pathToFileURL(join(roots[arm], 'dist/rag/verifier.js')).href
    );
    const model = 'knowforge-qwen3-4b-base';
    const provider = createProvider({
      name: 'KnowForge Server',
      type: 'openai-compatible',
      model,
      modelContextWindows: { [model]: 16384 },
      env: { BASE_URL: 'http://127.0.0.1:18080/v1', API_KEY: 'local-only' }
    });
    const start = performance.now();
    const result = { arm, id: item.id, expected: item.expected };
    try {
      const claims = await createProviderRagVerifier(provider)({
        draft: item.draft,
        chunks: [chunk],
        localEvidence,
        signal: AbortSignal.timeout(45000)
      });
      result.claims = claims;
      result.actual =
        claims.find((claim) => claim.claim === '__overall__')?.outcome ?? 'missing-verdict';
      result.passed =
        item.expected === 'supported'
          ? result.actual === 'supported'
          : ['partial', 'unsupported', 'unverifiable'].includes(result.actual);
    } catch (error) {
      result.actual = 'infrastructure-error';
      result.error = error.code ?? error.name;
      result.passed = false;
    }
    result.durationMs = Math.round(performance.now() - start);
    report.results.push(result);
    console.log(JSON.stringify(result));
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
}
report.complete = true;
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
if (report.results.some((item) => !item.passed)) process.exitCode = 1;
