import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../dist/version.js';
import {
  createAgentEvalSummary,
  selectLatestAgentEvalReport
} from '../scripts/release-eval-summary.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function read(path) {
  return readFile(join(projectRoot, path), 'utf8');
}

test('package.json is the single CLI version and release metadata source', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  assert.equal(PACKAGE_NAME, packageJson.name);
  assert.equal(PACKAGE_VERSION, packageJson.version);
  assert.equal(packageJson.engines.node, '>=22');
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.equal(packageJson.publishConfig.access, 'public');
  assert.equal(packageJson.bin.syzzz, './dist/index.js');
  assert.equal(packageJson.main, undefined);
  assert.equal(packageJson.exports, undefined);

  const { stdout } = await execFileAsync(process.execPath, ['dist/index.js', '--version'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(stdout.trim(), packageJson.version);
});

test('clean builds do not retain the removed static Provider registry', async () => {
  await assert.rejects(access(join(projectRoot, 'dist', 'providers', 'registry.js')));
});

test('CI actions are immutable and release publication is manually gated', async () => {
  const ci = await read('.github/workflows/ci.yml');
  const codeql = await read('.github/workflows/codeql.yml');
  const release = await read('.github/workflows/release.yml');
  const dependabot = await read('.github/dependabot.yml');
  const publisher = await read('scripts/publish-package.mjs');
  const secretScan = await read('scripts/secret-scan.mjs');
  const workflows = [ci, codeql, release];

  for (const workflow of [...workflows, dependabot]) {
    const parsed = parseDocument(workflow);
    assert.deepEqual(
      parsed.errors.map((error) => error.message),
      []
    );
  }
  for (const workflow of workflows) {
    for (const match of workflow.matchAll(/uses:\s+([^\s#]+)/gu)) {
      assert.match(match[1], /@[a-f0-9]{40}$/u, `Action is not pinned: ${match[1]}`);
    }
  }

  assert.match(ci, /permissions:\s*\n\s+contents: read/u);
  assert.match(ci, /ubuntu-latest/u);
  assert.match(ci, /windows-latest/u);
  assert.match(ci, /node:\s*\n\s+- 22\s*\n\s+- 24/u);
  assert.match(release, /workflow_dispatch:/u);
  assert.match(release, /environment: npm-release/u);
  assert.match(release, /scripts\/publish-package\.mjs/u);
  assert.match(publisher, /'--provenance'/u);
  assert.match(release, /RELEASE_CONFIRMATION/u);
  assert.ok(
    release.indexOf('scripts/publish-package.mjs') < release.indexOf('npm logout') &&
      release.indexOf('npm logout') < release.indexOf('git tag -a'),
    'the one-time npm token must be revoked before creating release metadata'
  );
  assert.match(secretScan, /--format=%H%x00%B%x00/u);
  assert.match(dependabot, /mcp-sdk:\s*\n\s+patterns:\s*\n\s+- '@modelcontextprotocol\/\*'/u);
  assert.doesNotMatch(dependabot, /ignore:\s*\n\s+- dependency-name: '@modelcontextprotocol/u);
  assert.doesNotMatch(release, /^\s*push:/mu);
  assert.match(codeql, /security-events: write/u);
});

test('release metadata selects Agent Eval when a newer RAG report exists', () => {
  const agentReport = {
    schemaVersion: 1,
    suite: 'offline',
    runId: 'agent-run',
    tasks: [{ id: 'architecture', status: 'passed' }]
  };
  const ragReport = {
    schemaVersion: 1,
    suite: 'offline',
    runId: 'rag-run',
    cases: [{ id: 'retrieval', passed: true }]
  };

  const selected = selectLatestAgentEvalReport([
    { name: '2026-08-10T10-22-40.152Z-offline.json', report: agentReport },
    { name: '2026-08-10T10-22-56.690Z-rag-offline.json', report: ragReport }
  ]);
  const summary = createAgentEvalSummary(selected);

  assert.equal(summary.runId, 'agent-run');
  assert.deepEqual(summary.tasks, [
    {
      id: 'architecture',
      status: 'passed',
      durationMs: undefined,
      providerCalls: undefined,
      toolCalls: undefined,
      approvals: undefined,
      retries: undefined,
      compactions: undefined,
      usage: undefined,
      changedFiles: undefined,
      insertions: undefined,
      deletions: undefined,
      graderChecks: undefined
    }
  ]);
});
