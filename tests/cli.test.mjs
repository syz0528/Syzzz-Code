import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectDirectory, 'dist', 'index.js');

test('CLI help exposes the interactive switch command', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    cwd: projectDirectory,
    encoding: 'utf-8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /switch/);
  assert.match(result.stdout, /chat/);
  assert.match(result.stdout, /config/);
});

test('switch selects configured values and persists them', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'syzzz-cli-'));
  const configDirectory = join(testHome, '.syzzz-code');
  const configPath = join(configDirectory, 'config.json');

  try {
    mkdirSync(configDirectory);
    writeFileSync(configPath, JSON.stringify({
      currentProvider: 'alpha',
      providers: {
        alpha: {
          name: 'Alpha',
          type: 'openai-compatible',
          model: 'alpha-1',
          models: ['alpha-1'],
          env: {
            BASE_URL: 'https://alpha.example.com/v1',
            API_KEY: ''
          }
        },
        beta: {
          name: 'Beta',
          type: 'anthropic',
          model: 'beta-1',
          models: ['beta-1', 'beta-2'],
          env: {
            BASE_URL: 'https://beta.example.com',
            API_KEY: ''
          }
        }
      }
    }));

    const result = spawnSync(process.execPath, [cliPath, 'switch'], {
      cwd: projectDirectory,
      encoding: 'utf-8',
      input: '2\n2\n',
      timeout: 5_000,
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome
      }
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Switched to Beta \(beta-2\)/);

    const savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(savedConfig.currentProvider, 'beta');
    assert.equal(savedConfig.providers.beta.model, 'beta-2');
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('interactive session processes consecutive messages exactly once', () => {
  const script = `
    import { runInteractiveSession } from './dist/interactive.js';

    const engine = {
      async chat(message) {
        console.log('HANDLED:' + message);
        return 'reply:' + message;
      }
    };

    await runInteractiveSession(engine);
  `;

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: projectDirectory,
      encoding: 'utf-8',
      input: 'first\nsecond\nexit\n',
      timeout: 5_000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal((result.stdout.match(/HANDLED:first/g) ?? []).length, 1);
  assert.equal((result.stdout.match(/HANDLED:second/g) ?? []).length, 1);
  assert.match(result.stdout, /reply:first/);
  assert.match(result.stdout, /reply:second/);
  assert.match(result.stdout, /Goodbye!/);
});

test('interactive approval input is not handled as a chat message', () => {
  const script = `
    import { runInteractiveSession } from './dist/interactive.js';

    const engine = {
      async chat(message, options) {
        console.log('HANDLED:' + message);
        if (message === 'change') {
          const approved = await options.requestApproval({
            toolCallId: 'write-1',
            toolName: 'Write',
            risk: 'write',
            input: { path: 'file.txt' },
            description: 'Update file.txt',
            preview: '-before\\n+after'
          }, options.signal);
          console.log('APPROVED:' + approved);
        }
        return 'reply:' + message;
      }
    };

    await runInteractiveSession(engine);
  `;

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: projectDirectory,
      encoding: 'utf-8',
      input: 'change\ny\nnext\nexit\n',
      timeout: 5_000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /APPROVED:true/);
  assert.equal((result.stdout.match(/HANDLED:change/g) ?? []).length, 1);
  assert.equal((result.stdout.match(/HANDLED:next/g) ?? []).length, 1);
  assert.doesNotMatch(result.stdout, /HANDLED:y/);
});

test('interactive /permissions does not become a chat message and can switch modes', () => {
  const script = `
    import { runInteractiveSession } from './dist/interactive.js';

    const engine = {
      mode: 'safe',
      getPermissionMode() {
        return this.mode;
      },
      setPermissionMode(mode) {
        this.mode = mode;
        console.log('MODE:' + mode);
      },
      async chat(message) {
        console.log('HANDLED:' + message);
        return 'reply:' + message;
      }
    };

    await runInteractiveSession(engine);
    console.log('FINAL:' + engine.mode);
  `;

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: projectDirectory,
      encoding: 'utf-8',
      input: '/permissions\n/permissions acceptEdits\nhello\n/permissions fullAccess\nnope\n/permissions fullAccess\nI understand\nexit\n',
      timeout: 5_000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Current permission mode/);
  assert.match(result.stdout, /MODE:acceptEdits/);
  assert.equal((result.stdout.match(/HANDLED:hello/g) ?? []).length, 1);
  assert.doesNotMatch(result.stdout, /HANDLED:\/permissions/);
  assert.doesNotMatch(result.stdout, /HANDLED:I understand/);
  assert.doesNotMatch(result.stdout, /MODE:fullAccess\n.*MODE:fullAccess/s);
  assert.match(result.stdout, /Full Access not enabled/);
  assert.match(result.stdout, /MODE:fullAccess/);
  assert.match(result.stdout, /FINAL:fullAccess/);
});

test('permission mode helpers parse aliases', async () => {
  const { parsePermissionMode, FULL_ACCESS_CONFIRMATION } = await import(
    '../dist/permissions/mode.js'
  );
  assert.equal(parsePermissionMode('accept'), 'acceptEdits');
  assert.equal(parsePermissionMode('full'), 'fullAccess');
  assert.equal(parsePermissionMode('yolo'), 'fullAccess');
  assert.equal(parsePermissionMode('nope'), null);
  assert.equal(FULL_ACCESS_CONFIRMATION, 'I understand');
});
