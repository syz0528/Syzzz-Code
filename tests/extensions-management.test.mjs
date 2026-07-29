import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDirectory = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..'
);
const cliPath = join(projectDirectory, 'dist', 'index.js');

function runCli(home, workspace, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MCP_SOURCE_SECRET: 'resolved-but-never-printed',
      HOOK_SOURCE_SECRET: 'hook-secret-never-printed'
    }
  });
}

function assertSucceeded(result) {
  assert.equal(
    result.status,
    0,
    result.stderr || result.error?.message
  );
}

test('MCP management supports lifecycle operations without printing secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'syzzz-mcp-management-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  try {
    const added = runCli(home, workspace, [
      'mcp',
      'add',
      'fixture',
      process.execPath,
      'tests/fixtures/mcp-stdio-server.mjs',
      '--env',
      'MCP_SAFE_VALUE=${MCP_SOURCE_SECRET}',
      '--json'
    ]);
    assertSucceeded(added);
    assert.deepEqual(JSON.parse(added.stdout), {
      action: 'added',
      name: 'fixture',
      scope: 'user',
      transport: 'stdio',
      protocolMode: 'legacy',
      enabled: true
    });
    assert.doesNotMatch(added.stdout, /resolved-but-never-printed/);
    assert.doesNotMatch(added.stdout, /MCP_SOURCE_SECRET/);

    const httpAdded = runCli(home, workspace, [
      'mcp',
      'add',
      'remote',
      '--url',
      'https://example.test/mcp?token=query-secret',
      '--header',
      'Authorization=Bearer ${MCP_SOURCE_SECRET}',
      '--json'
    ]);
    assertSucceeded(httpAdded);
    assert.doesNotMatch(httpAdded.stdout, /query-secret|Authorization|Bearer/);

    const listed = runCli(home, workspace, ['mcp', 'list', '--json']);
    assertSucceeded(listed);
    const entries = JSON.parse(listed.stdout);
    assert.equal(entries.length, 2);
    assert.equal(
      entries.find(entry => entry.name === 'remote').target,
      'https://example.test/mcp?[redacted]'
    );
    assert.doesNotMatch(
      listed.stdout,
      /query-secret|resolved-but-never-printed|Authorization|Bearer/
    );

    const disabled = runCli(home, workspace, [
      'mcp',
      'disable',
      'fixture',
      '--json'
    ]);
    assertSucceeded(disabled);
    assert.equal(JSON.parse(disabled.stdout).action, 'disable');

    const enabled = runCli(home, workspace, [
      'mcp',
      'enable',
      'fixture',
      '--json'
    ]);
    assertSucceeded(enabled);
    assert.equal(JSON.parse(enabled.stdout).action, 'enable');

    const removed = runCli(home, workspace, [
      'mcp',
      'remove',
      'fixture',
      '--json'
    ]);
    assertSucceeded(removed);
    assert.equal(JSON.parse(removed.stdout).action, 'removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Hook management is offline and never executes configured commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'syzzz-hook-management-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const marker = join(root, 'hook-executed.txt');
  const hookScript = join(root, 'offline-hook.mjs');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    hookScript,
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(marker)}, 'bad');\n`,
    'utf8'
  );
  try {
    const added = runCli(home, workspace, [
      'hooks',
      'add',
      'offline-check',
      process.execPath,
      hookScript,
      '--event',
      'PreTurn',
      '--env',
      'HOOK_SAFE_VALUE=${HOOK_SOURCE_SECRET}',
      '--json'
    ]);
    assertSucceeded(added);
    assert.doesNotMatch(added.stdout, /hook-secret-never-printed|HOOK_SOURCE_SECRET/);

    const diagnosed = runCli(home, workspace, [
      'hooks',
      'doctor',
      '--json'
    ]);
    assertSucceeded(diagnosed);
    assert.equal(existsSync(marker), false);
    assert.doesNotMatch(
      diagnosed.stdout,
      /hook-secret-never-printed|HOOK_SOURCE_SECRET/
    );

    const disabled = runCli(home, workspace, [
      'hooks',
      'disable',
      'offline-check',
      '--json'
    ]);
    assertSucceeded(disabled);
    const enabled = runCli(home, workspace, [
      'hooks',
      'enable',
      'offline-check',
      '--json'
    ]);
    assertSucceeded(enabled);
    const removed = runCli(home, workspace, [
      'hooks',
      'remove',
      'offline-check',
      '--json'
    ]);
    assertSucceeded(removed);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('management lists a corrupt project scope without hiding valid user entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'syzzz-extension-list-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  try {
    const added = runCli(home, workspace, [
      'mcp',
      'add',
      'user-server',
      process.execPath,
      '--json'
    ]);
    assertSucceeded(added);
    writeFileSync(join(workspace, '.mcp.json'), '{broken json', 'utf8');

    const listed = runCli(home, workspace, ['mcp', 'list', '--json']);
    assertSucceeded(listed);
    const entries = JSON.parse(listed.stdout);
    assert.equal(entries.some(entry => entry.name === 'user-server'), true);
    assert.equal(entries.some(entry =>
      entry.name === 'project-configuration' && entry.valid === false
    ), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI help exposes MCP and Hook management commands', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    cwd: projectDirectory,
    encoding: 'utf8'
  });
  assertSucceeded(result);
  assert.match(result.stdout, /\bmcp\b/);
  assert.match(result.stdout, /\bhooks\b/);
});
