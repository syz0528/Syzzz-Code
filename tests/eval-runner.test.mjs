import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { createIsolatedEnvironment } from './support/temp-environment.mjs';
import { startProviderFixture } from './support/provider-fixture.mjs';
import { collectEvalExecutionMetadata } from '../scripts/eval-reporting.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(projectRoot, 'scripts', 'eval-runner.mjs');

const forbiddenReportKeys = new Set([
  'answer',
  'content',
  'prompt',
  'reasoning',
  'response',
  'shellOutput',
  'source',
  'stderr',
  'stdout',
  'transcript'
]);

function assertReportIsMetadataOnly(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertReportIsMetadataOnly(entry);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assert.equal(forbiddenReportKeys.has(key), false, `forbidden report key: ${key}`);
    assertReportIsMetadataOnly(entry);
  }
}

test(
  'offline eval completes every fixed task and writes a metadata-only report',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syzzz-eval-test-'));
    const output = join(directory, 'offline.json');
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [runner, '--suite', 'offline', '--output', output],
        {
          cwd: projectRoot,
          env: createIsolatedEnvironment(directory, {
            SYZZZ_EVAL_SECRET_SENTINEL: 'must-not-appear-in-eval-report'
          }),
          timeout: 45_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        }
      );
      assert.match(stdout, /Eval offline: 12 passed, 0 failed/u);

      const raw = await readFile(output, 'utf8');
      const report = JSON.parse(raw);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.suite, 'offline');
      assert.equal(report.tasks.length, 12);
      assert.equal(report.summary.passed, 12);
      assert.equal(report.summary.failed, 0);
      assert.equal(report.summary.infrastructureErrors, 0);
      assert.equal(report.summary.safetyPassed, true);
      assert.equal(report.summary.functionalSuccessRate, 1);
      for (const task of report.tasks) {
        assert.equal(task.terminalStatus, 'completed');
        assert.equal(task.stopReason, 'completed');
        assert.deepEqual(Object.keys(task.toolOutcomeCounts).sort(), [
          'cancelled',
          'denied',
          'error',
          'success'
        ]);
        assert.deepEqual(Object.keys(task.approvalOutcomeCounts).sort(), [
          'allow-edits-session',
          'allow-once',
          'deny'
        ]);
      }
      assert.doesNotMatch(raw, /must-not-appear-in-eval-report/u);
      assert.doesNotMatch(raw, /THIS MUST NOT EXIST/u);
      assert.doesNotMatch(raw, /return subtotal \* rate/u);
      assertReportIsMetadataOnly(report);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test('live eval is explicitly skipped when credentials are not configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-live-eval-test-'));
  const output = join(directory, 'live.json');
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [runner, '--suite', 'live', '--output', output],
      {
        cwd: projectRoot,
        env: createIsolatedEnvironment(directory),
        timeout: 15_000,
        windowsHide: true
      }
    );
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.match(stdout, /SKIP live-provider/u);
    assert.equal(report.summary.skipped, 1);
    assert.equal(report.tasks[0].status, 'skipped');
    assert.equal(report.tasks[0].terminalStatus, 'not-run');
    assert.equal(report.tasks[0].stopReason, 'missing-configuration');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('live eval stops the whole suite after a Provider infrastructure failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-live-infrastructure-test-'));
  const output = join(directory, 'live.json');
  const fixture = await startProviderFixture('always-rate-limit');
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [runner, '--suite', 'live', '--output', output], {
        cwd: projectRoot,
        env: createIsolatedEnvironment(directory, {
          SYZZZ_EVAL_PROVIDER_TYPE: 'openai-compatible',
          SYZZZ_EVAL_BASE_URL: fixture.openAIBaseURL,
          SYZZZ_EVAL_API_KEY: 'fixture-placeholder-key',
          SYZZZ_EVAL_MODEL: 'fixture-model'
        }),
        timeout: 15_000,
        windowsHide: true
      })
    );
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.summary.infrastructureErrors, 1);
    assert.equal(report.summary.skipped, 11);
    assert.equal(report.tasks[0].status, 'infrastructure-error');
    assert.ok(report.tasks.slice(1).every((task) => task.status === 'skipped'));
    assert.ok(
      report.tasks
        .slice(1)
        .every(
          (task) =>
            task.terminalStatus === 'not-run' && task.stopReason === 'blocked-by-infrastructure'
        )
    );
    assert.equal(fixture.requests.length, 3);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Eval execution metadata reports bounded outcomes and classifies tool round limits', () => {
  const events = [
    { type: 'tool_completed', outcome: 'success' },
    { type: 'tool_completed', outcome: 'error' },
    { type: 'tool_completed', outcome: 'denied' },
    { type: 'approval_resolved', choice: 'allow-once' },
    { type: 'approval_resolved', choice: 'deny' }
  ];
  const metadata = collectEvalExecutionMetadata(events, {
    status: 'failed',
    error: {
      code: 'runtime_error',
      message: 'Tool call limit exceeded (10 rounds)'
    }
  });

  assert.deepEqual(metadata, {
    terminalStatus: 'failed',
    stopReason: 'tool-round-limit',
    toolOutcomeCounts: {
      success: 1,
      error: 1,
      denied: 1,
      cancelled: 0
    },
    approvalOutcomeCounts: {
      'allow-once': 1,
      'allow-edits-session': 0,
      deny: 1
    }
  });
  assert.equal(
    collectEvalExecutionMetadata([], { status: 'cancelled', reason: 'private detail' }, true)
      .stopReason,
    'eval-timeout'
  );
});
