import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { createIsolatedEnvironment } from './support/temp-environment.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(projectRoot, 'dist', 'index.js');
const fixture = join(projectRoot, 'eval', 'fixtures', 'rag-project');

async function runCli(args, cwd, environment) {
  return execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
}

test(
  'RAG CLI manages workspace and mounted external collections without exposing host paths to search',
  { timeout: 90_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'syzzz-rag-cli-test-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const external = join(root, 'external-knowledge');
    const environment = createIsolatedEnvironment(home);
    try {
      await mkdir(home, { recursive: true });
      await cp(fixture, workspace, { recursive: true });
      await mkdir(external, { recursive: true });
      await writeFile(
        join(external, 'guide.md'),
        '# External\nMOUNTED_COLLECTION_EVIDENCE\n',
        'utf8'
      );

      const initial = await runCli(['rag', 'status', '--json'], workspace, environment);
      assert.equal(JSON.parse(initial.stdout).collections[0].health, 'missing');

      const importSource = join(workspace, 'personal-note.md');
      await writeFile(importSource, '# Personal note\nPHASE91_CLI_LIBRARY\n', 'utf8');
      const imported = await runCli(
        ['rag', 'add', importSource, '--yes', '--json'],
        workspace,
        environment
      );
      const importResult = JSON.parse(imported.stdout);
      assert.equal(importResult.virtualPath, 'rag://library/personal-note.md');
      assert.equal(importResult.indexStatus, 'refreshed');
      const personalSearch = await runCli(
        ['rag', 'search', 'PHASE91_CLI_LIBRARY', '--json'],
        workspace,
        environment
      );
      assert.ok(
        JSON.parse(personalSearch.stdout).some(
          (hit) => hit.virtualPath === 'rag://library/personal-note.md'
        )
      );

      const indexed = await runCli(['rag', 'index', '--json'], workspace, environment);
      const indexResult = JSON.parse(indexed.stdout);
      assert.equal(indexResult.collection, 'workspace');
      assert.ok(indexResult.chunkCount > 0);

      const searched = await runCli(
        ['rag', 'search', 'reciprocal', 'rank', 'fusion', '--json'],
        workspace,
        environment
      );
      const hits = JSON.parse(searched.stdout);
      assert.ok(hits.length > 0);
      assert.ok(hits.every((hit) => hit.virtualPath.startsWith('rag://workspace/')));
      assert.doesNotMatch(searched.stdout, new RegExp(root.replaceAll('\\', '\\\\')));

      await runCli(
        ['rag', 'collections', 'add', 'manual-docs', '--path', external],
        workspace,
        environment
      );
      await runCli(['rag', 'mount', 'manual-docs'], workspace, environment);
      await runCli(['rag', 'index', 'manual-docs'], workspace, environment);
      const externalSearch = await runCli(
        ['rag', 'search', 'MOUNTED_COLLECTION_EVIDENCE', '--json'],
        workspace,
        environment
      );
      assert.ok(
        JSON.parse(externalSearch.stdout).some((hit) =>
          hit.virtualPath.startsWith('rag://manual-docs/')
        )
      );

      const doctor = await runCli(['rag', 'doctor', '--json'], workspace, environment);
      assert.equal(JSON.parse(doctor.stdout).lance.ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
