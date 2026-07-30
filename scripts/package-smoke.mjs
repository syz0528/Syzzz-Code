import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startProviderFixture } from '../tests/support/provider-fixture.mjs';
import { createIsolatedEnvironment } from '../tests/support/temp-environment.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('npm_execpath is unavailable; run this check through npm run smoke:package');
  }
  return {
    command: process.execPath,
    args: [npmCli, ...args]
  };
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
    windowsHide: true
  });
}

async function runNpm(args, options) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, options);
}

async function runInstalledShim(shim, environment) {
  if (process.platform !== 'win32') {
    return run(shim, ['--version'], { cwd: projectRoot, env: environment });
  }
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', shim, '--version'], {
    cwd: projectRoot,
    env: environment
  });
}

function parseNdjson(stdout) {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Installed CLI emitted invalid NDJSON on line ${index + 1}`);
    }
  });
}

const root = await mkdtemp(join(tmpdir(), 'syzzz-package-smoke-'));
let fixture;
try {
  const packDirectory = join(root, 'pack');
  const prefix = join(root, 'prefix');
  const home = join(root, 'home');
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(prefix, { recursive: true }),
    mkdir(home, { recursive: true })
  ]);

  const packed = await runNpm(
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    {
      cwd: projectRoot,
      env: createIsolatedEnvironment(home)
    }
  );
  const manifests = JSON.parse(packed.stdout);
  assert.equal(manifests.length, 1, 'npm pack must create exactly one tarball');
  const tarball = join(packDirectory, basename(manifests[0].filename));
  await stat(tarball);

  await runNpm(
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball
    ],
    {
      cwd: root,
      env: createIsolatedEnvironment(home),
      timeout: 180_000
    }
  );

  const installedRoot =
    process.platform === 'win32'
      ? join(prefix, 'node_modules', packageJson.name)
      : join(prefix, 'lib', 'node_modules', packageJson.name);
  const installedCli = join(installedRoot, 'dist', 'index.js');
  const shim =
    process.platform === 'win32' ? join(prefix, 'syzzz.cmd') : join(prefix, 'bin', 'syzzz');
  await Promise.all([stat(installedCli), stat(shim)]);

  const environment = createIsolatedEnvironment(home);
  const version = await runInstalledShim(shim, environment);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await run(process.execPath, [installedCli, '--help'], {
    cwd: root,
    env: environment
  });
  assert.match(help.stdout, /Syzzz Code - AI Programming Assistant/u);

  fixture = await startProviderFixture('openai-chat-completions');
  const configDirectory = join(home, '.syzzz-code');
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, 'config.json'),
    `${JSON.stringify(
      {
        currentProvider: 'fixture',
        providers: {
          fixture: {
            name: 'Package Fixture',
            type: 'openai-compatible',
            model: 'fixture-model',
            models: ['fixture-model'],
            env: {
              BASE_URL: fixture.openAIBaseURL,
              API_KEY: 'package-smoke-placeholder'
            }
          }
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const textChat = await run(
    process.execPath,
    [installedCli, 'chat', '-m', 'package smoke text', '--mode', 'ask'],
    {
      cwd: root,
      env: environment
    }
  );
  assert.match(textChat.stdout, /Assistant:/u);

  const migrated = JSON.parse(await readFile(join(configDirectory, 'config.json'), 'utf8'));
  assert.equal(migrated.schemaVersion, 1);
  assert.ok((await readdir(configDirectory)).some((name) => name.endsWith('.pre-v1.bak')));

  const jsonChat = await run(
    process.execPath,
    [
      installedCli,
      'chat',
      '-m',
      'package smoke ndjson',
      '--mode',
      'ask',
      '--output-format',
      'stream-json'
    ],
    {
      cwd: root,
      env: environment
    }
  );
  const events = parseNdjson(jsonChat.stdout);
  assert.equal(events[0]?.type, 'turn_started');
  assert.equal(events.at(-1)?.type, 'turn_completed');

  const doctor = await run(process.execPath, [installedCli, 'doctor'], {
    cwd: root,
    env: environment
  });
  assert.match(doctor.stdout, /\[OK\]\s+Node\.js/u);
  assert.match(doctor.stdout, /\[OK\]\s+Configuration/u);

  console.log(
    `Package smoke OK: ${packageJson.name}@${packageJson.version} installed from ` +
      `${basename(tarball)} and passed CLI, migration, text, NDJSON, and doctor checks`
  );
} finally {
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
}
