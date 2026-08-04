import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillInstaller, validateSkillSourceUrl } from '../dist/composition/skill-installer.js';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'syzzz-phase7-installer-'));
  const workspace = join(root, 'workspace');
  const userRoot = join(root, 'user');
  const source = join(root, 'source');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(source, { recursive: true });
  const fakeGit = join(root, 'fake-git.mjs');
  writeFileSync(
    fakeGit,
    [
      "import { cpSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const source = process.argv[2];',
      'const args = process.argv.slice(3);',
      "if (args.includes('init')) mkdirSync(join(process.cwd(), '.git'), { recursive: true });",
      "if (args.includes('checkout')) for (const entry of readdirSync(source)) cpSync(join(source, entry), join(process.cwd(), entry), { recursive: true, force: true });",
      "if (args.includes('rev-parse')) process.stdout.write(readFileSync(join(source, 'COMMIT'), 'utf8').trim());"
    ].join('\n'),
    'utf8'
  );
  return { root, workspace, userRoot, source, fakeGit };
}

function writeSource(source, body, commit) {
  writeFileSync(
    join(source, 'SKILL.md'),
    `---\nname: weather-check\ndescription: Check weather evidence\n---\n\n${body}\n`,
    'utf8'
  );
  writeFileSync(join(source, 'guide.md'), `guide ${body}\n`, 'utf8');
  writeFileSync(join(source, 'COMMIT'), `${commit}\n`, 'utf8');
}

test('Skill source validation accepts public HTTPS and rejects credential or local transports', () => {
  assert.match(validateSkillSourceUrl('https://github.com/example/skills.git'), /^https:/);
  for (const value of [
    'http://github.com/example/skills.git',
    'https://token@github.com/example/skills.git',
    'https://localhost/skills.git',
    'https://127.0.0.1/skills.git',
    'https://10.1.2.3/skills.git',
    'file:///tmp/skills',
    'git://github.com/example/skills.git',
    'git@github.com:example/skills.git'
  ]) {
    assert.throws(() => validateSkillSourceUrl(value));
  }
});

test('managed Skill install pins a commit and supports update, rollback, and remove', async () => {
  const fixture = createFixture();
  try {
    const firstCommit = '1'.repeat(40);
    const secondCommit = '2'.repeat(40);
    writeSource(fixture.source, 'VERSION ONE', firstCommit);
    const installer = new SkillInstaller({
      workspaceRoot: fixture.workspace,
      userRoot: fixture.userRoot,
      gitCommand: {
        executable: process.execPath,
        argumentsPrefix: [fixture.fakeGit, fixture.source]
      }
    });
    const signal = new AbortController().signal;
    const previews = [];
    const confirm = (preview) => {
      previews.push(preview);
      return true;
    };
    const installed = await installer.install('https://example.com/public-skills.git', {
      scope: 'user',
      signal,
      confirm
    });
    const target = join(fixture.root, '.agents', 'skills', 'weather-check');
    assert.equal(installed.resolvedCommit, firstCommit);
    assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /VERSION ONE/);
    assert.equal(previews[0].scriptCount, 0);

    writeSource(fixture.source, 'VERSION TWO', secondCommit);
    const updated = await installer.update('weather-check', {
      scope: 'user',
      signal,
      confirm
    });
    assert.equal(updated.resolvedCommit, secondCommit);
    assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /VERSION TWO/);

    const rolledBack = await installer.rollback('weather-check', {
      scope: 'user',
      signal,
      confirm
    });
    assert.equal(rolledBack.resolvedCommit, firstCommit);
    assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /VERSION ONE/);

    await installer.remove('weather-check', { scope: 'user', signal, confirm });
    assert.equal(existsSync(target), false);
    const store = JSON.parse(readFileSync(join(fixture.userRoot, 'skill-installs.json'), 'utf8'));
    assert.deepEqual(store.installs, {});
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Skill install cancellation and manual directories fail without overwriting content', async () => {
  const fixture = createFixture();
  try {
    writeSource(fixture.source, 'REMOTE', '3'.repeat(40));
    const installer = new SkillInstaller({
      workspaceRoot: fixture.workspace,
      userRoot: fixture.userRoot,
      gitCommand: {
        executable: process.execPath,
        argumentsPrefix: [fixture.fakeGit, fixture.source]
      }
    });
    const signal = new AbortController().signal;
    await assert.rejects(
      installer.install('https://example.com/public-skills.git', {
        signal,
        confirm: () => false
      }),
      /cancelled/
    );
    const target = join(fixture.root, '.agents', 'skills', 'weather-check');
    assert.equal(existsSync(target), false);

    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'manual.txt'), 'keep me', 'utf8');
    await assert.rejects(
      installer.install('https://example.com/public-skills.git', {
        signal,
        confirm: () => true
      }),
      /manually managed/
    );
    assert.equal(readFileSync(join(target, 'manual.txt'), 'utf8'), 'keep me');
    await assert.rejects(
      installer.remove('weather-check', { signal, confirm: () => true }),
      /manual Skills are never removed/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('legacy managed user targets continue updating in place', async () => {
  const fixture = createFixture();
  try {
    writeSource(fixture.source, 'VERSION ONE', '5'.repeat(40));
    const installer = new SkillInstaller({
      workspaceRoot: fixture.workspace,
      userRoot: fixture.userRoot,
      gitCommand: {
        executable: process.execPath,
        argumentsPrefix: [fixture.fakeGit, fixture.source]
      }
    });
    const signal = new AbortController().signal;
    await installer.install('https://example.com/public-skills.git', {
      signal,
      confirm: () => true
    });
    const standardTarget = join(fixture.root, '.agents', 'skills', 'weather-check');
    const legacyTarget = join(fixture.userRoot, 'skills', 'weather-check');
    mkdirSync(join(fixture.userRoot, 'skills'), { recursive: true });
    renameSync(standardTarget, legacyTarget);
    const storePath = join(fixture.userRoot, 'skill-installs.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.installs['weather-check'].targetPath = legacyTarget;
    writeFileSync(storePath, JSON.stringify(store), 'utf8');

    writeSource(fixture.source, 'VERSION TWO', '6'.repeat(40));
    await installer.update('weather-check', { signal, confirm: () => true });
    assert.match(readFileSync(join(legacyTarget, 'SKILL.md'), 'utf8'), /VERSION TWO/);
    assert.equal(existsSync(standardTarget), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Skill management rejects unpinned commits and unsafe paths from a corrupt lock file', async () => {
  const fixture = createFixture();
  try {
    writeSource(fixture.source, 'REMOTE', 'not-a-full-commit');
    const installer = new SkillInstaller({
      workspaceRoot: fixture.workspace,
      userRoot: fixture.userRoot,
      gitCommand: {
        executable: process.execPath,
        argumentsPrefix: [fixture.fakeGit, fixture.source]
      }
    });
    const signal = new AbortController().signal;
    await assert.rejects(
      installer.install('https://example.com/public-skills.git', {
        signal,
        confirm: () => true
      }),
      /full commit ID/
    );

    const outside = join(fixture.root, 'must-not-delete');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'keep me', 'utf8');
    mkdirSync(fixture.userRoot, { recursive: true });
    writeFileSync(
      join(fixture.userRoot, 'skill-installs.json'),
      JSON.stringify({
        schemaVersion: 1,
        installs: {
          'weather-check': {
            schemaVersion: 1,
            name: 'weather-check',
            sourceUrl: 'https://example.com/public-skills.git',
            resolvedCommit: '4'.repeat(40),
            sourceSkillPath: '.',
            scope: 'user',
            installedAt: new Date(0).toISOString(),
            fileCount: 1,
            totalBytes: 7,
            targetPath: outside
          }
        }
      }),
      'utf8'
    );
    await assert.rejects(
      installer.remove('weather-check', { signal, confirm: () => true }),
      /unsafe target path/
    );
    assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'keep me');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
