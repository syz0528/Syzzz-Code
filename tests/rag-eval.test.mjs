import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { createIsolatedEnvironment } from './support/temp-environment.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(projectRoot, 'scripts', 'rag-eval-runner.mjs');

test(
  'offline RAG eval resolves every label, improves hybrid ranking, and stays metadata-only',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syzzz-rag-eval-test-'));
    const output = join(directory, 'rag-offline.json');
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [runner, '--suite', 'offline', '--output', output],
        {
          cwd: projectRoot,
          env: createIsolatedEnvironment(directory),
          timeout: 75_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        }
      );
      assert.match(stdout, /RAG offline eval: PASS/);
      const raw = await readFile(output, 'utf8');
      const report = JSON.parse(raw);
      assert.equal(report.caseCount, 10);
      assert.deepEqual(report.labelResolution, { total: 9, resolved: 9, rate: 1 });
      assert.equal(report.hybridImproved, true);
      assert.equal(report.negativePassed, true);
      assert.ok(report.hybrid.recallAt10 >= 0.9);
      assert.ok(report.hybrid.mrrAt10 >= 0.9);
      assert.doesNotMatch(raw, /PRIVATE_RAG_MARKER|must-never-be-indexed|RagSearch 只返回摘要/);
      assert.ok(
        report.cases.every((entry) =>
          Object.keys(entry).every(
            (key) => !['query', 'path', 'content', 'answer', 'draft'].includes(key)
          )
        )
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test('live RAG eval isolates dataset profile files from benchmark leakage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-rag-live-profile-'));
  const corpus = join(directory, 'corpus');
  const output = join(directory, 'rag-live.json');
  try {
    await mkdir(join(corpus, 'docs', 'evaluation'), { recursive: true });
    await writeFile(join(corpus, 'knowledge.md'), '# Evidence\nPROFILE_EVIDENCE\n', 'utf8');
    await writeFile(
      join(corpus, 'benchmark-leak.md'),
      '# Old answer\nPROFILE_EVIDENCE should not be indexed from this file.\n',
      'utf8'
    );
    await writeFile(
      join(corpus, 'docs', 'evaluation', 'task5.3-rag-eval-v1.json'),
      JSON.stringify({
        version: 1,
        dataset_id: 'profile-isolation',
        corpus_profiles: [{ id: 'declared', source_paths: ['knowledge.md'] }],
        cases: [
          {
            id: 'profile-only',
            question: 'PROFILE_EVIDENCE',
            answerability: 'answerable',
            evidence: [{ source_path: 'knowledge.md', anchor_text: 'PROFILE_EVIDENCE' }]
          }
        ]
      }),
      'utf8'
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [runner, '--suite', 'live', '--root', corpus, '--output', output],
      {
        cwd: projectRoot,
        env: createIsolatedEnvironment(directory),
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      }
    );
    assert.match(stdout, /RAG live eval: PASS/);
    const raw = await readFile(output, 'utf8');
    const report = JSON.parse(raw);
    assert.equal(report.corpusMode, 'profile-union');
    assert.equal(report.corpusFileCount, 1);
    assert.deepEqual(report.labelResolution, { total: 1, resolved: 1, rate: 1 });
    assert.equal(report.retrieval.recallAt10, 1);
    assert.equal(report.retrieval.mrrAt10, 1);
    assert.doesNotMatch(raw, /benchmark-leak|PROFILE_EVIDENCE|knowledge\.md/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
