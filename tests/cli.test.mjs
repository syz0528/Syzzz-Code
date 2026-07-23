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

  const chatHelp = spawnSync(process.execPath, [cliPath, 'chat', '--help'], {
    cwd: projectDirectory,
    encoding: 'utf-8'
  });
  assert.equal(chatHelp.status, 0, chatHelp.stderr);
  assert.match(chatHelp.stdout, /--stream <mode>/);
});

test('stream-json rejects the human display stream override', () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    'chat',
    '--message',
    'hello',
    '--output-format',
    'stream-json',
    '--stream',
    'off'
  ], {
    cwd: projectDirectory,
    encoding: 'utf-8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--stream cannot be used with --output-format stream-json/);
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

test('interactive stream and model commands persist user configuration', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'syzzz-cli-session-'));
  const configDirectory = join(testHome, '.syzzz-code');
  const configPath = join(configDirectory, 'config.json');

  try {
    mkdirSync(configDirectory);
    writeFileSync(configPath, JSON.stringify({
      currentProvider: 'local',
      providers: {
        local: {
          name: 'Local',
          type: 'openai-compatible',
          model: 'model-a',
          models: ['model-a', 'model-b'],
          env: {
            BASE_URL: 'https://example.invalid/v1',
            API_KEY: 'test-key'
          }
        }
      },
      audit: {
        retentionDays: 0,
        maxBytes: 4096
      },
      ui: {
        streamOutput: true
      }
    }));

    const result = spawnSync(process.execPath, [cliPath], {
      cwd: projectDirectory,
      encoding: 'utf-8',
      input: '/stream off\n/model model-b\n/exit\n',
      timeout: 5_000,
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome
      }
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Stream display set to off/);
    assert.match(result.stdout, /Model switched to model-b/);
    const savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(savedConfig.ui.streamOutput, false);
    assert.equal(savedConfig.providers.local.model, 'model-b');
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
            preview: '-before\\n+after',
            choices: ['allow-once', 'allow-edits-session', 'deny']
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
  assert.match(result.stdout, /APPROVED:allow-once/);
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
      input: '/permissions\n/permissions acceptEdits\nhello\n/permissions fullAccess\nyes\n/permissions fullAccess\ny\nexit\n',
      timeout: 5_000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Current permission mode/);
  assert.match(result.stdout, /MODE:acceptEdits/);
  assert.equal((result.stdout.match(/HANDLED:hello/g) ?? []).length, 1);
  assert.doesNotMatch(result.stdout, /HANDLED:\/permissions/);
  assert.doesNotMatch(result.stdout, /HANDLED:yes/);
  assert.doesNotMatch(result.stdout, /HANDLED:y/);
  assert.doesNotMatch(result.stdout, /MODE:fullAccess\n.*MODE:fullAccess/s);
  assert.match(result.stdout, /Full Access not enabled/);
  assert.match(result.stdout, /MODE:fullAccess/);
  assert.match(result.stdout, /FINAL:fullAccess/);
});

test('interactive slash commands control display and the current provider model', () => {
  const script = `
    import { runInteractiveSession } from './dist/interactive.js';

    const engine = {
      model: 'model-a',
      getProviderInfo() {
        return {
          name: 'Test Provider',
          type: 'test',
          model: this.model,
          capabilities: { streaming: true, reasoningToggle: false }
        };
      },
      setModel(model) {
        this.model = model;
        console.log('MODEL:' + model);
      },
      async chat(message) {
        console.log('HANDLED:' + message);
        return 'reply:' + message;
      }
    };

    await runInteractiveSession(engine, {
      streamOutput: true,
      availableModels: ['model-a', 'model-b'],
      persistStreamOutput(enabled) {
        console.log('STREAM_SAVED:' + enabled);
      },
      persistModel(model) {
        console.log('MODEL_SAVED:' + model);
      }
    });
    console.log('FINAL_MODEL:' + engine.model);
  `;

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: projectDirectory,
      encoding: 'utf-8',
      input: '/help\n/?\n/stream off\n/model model-b\n/model missing\n/stram\n//literal\n/quit\n',
      timeout: 5_000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Available commands:/);
  assert.match(result.stdout, /STREAM_SAVED:false/);
  assert.match(result.stdout, /MODEL:model-b/);
  assert.match(result.stdout, /MODEL_SAVED:model-b/);
  assert.match(result.stdout, /FINAL_MODEL:model-b/);
  assert.match(result.stdout, /Model is not configured/);
  assert.match(result.stdout, /Unknown command: \/stram/);
  assert.match(result.stdout, /Did you mean: \/stream/);
  assert.equal((result.stdout.match(/HANDLED:\/literal/g) ?? []).length, 1);
  assert.doesNotMatch(result.stdout, /HANDLED:\/help/);
  assert.doesNotMatch(result.stdout, /HANDLED:\/stream/);
  assert.doesNotMatch(result.stdout, /HANDLED:\/model/);
});

test('full access confirmation accepts only y or Y and fails closed for other input', () => {
  const script = `
    import { runInteractiveSession } from './dist/interactive.js';

    const engine = {
      mode: 'safe',
      getPermissionMode() {
        return this.mode;
      },
      setPermissionMode(mode) {
        this.mode = mode;
      },
      async chat(message) {
        console.log('HANDLED:' + message);
        return 'reply:' + message;
      }
    };

    await runInteractiveSession(engine);
    console.log('FINAL:' + engine.mode);
  `;
  const cases = [
    { label: 'lowercase y', answer: 'y', expectedMode: 'fullAccess' },
    { label: 'uppercase Y', answer: 'Y', expectedMode: 'fullAccess' },
    { label: 'yes', answer: 'yes', expectedMode: 'safe' },
    { label: 'n', answer: 'n', expectedMode: 'safe' },
    { label: 'empty line', answer: '', expectedMode: 'safe' },
    { label: 'unrecognized text', answer: '乱码', expectedMode: 'safe' },
    { label: 'EOF', answer: null, expectedMode: 'safe' }
  ];

  for (const confirmationCase of cases) {
    const confirmationInput = confirmationCase.answer === null
      ? '/permissions fullAccess\n'
      : `/permissions fullAccess\n${confirmationCase.answer}\n`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: projectDirectory,
        encoding: 'utf-8',
        input: confirmationInput,
        timeout: 5_000
      }
    );

    assert.equal(
      result.status,
      0,
      `${confirmationCase.label}: ${result.stderr || result.error?.message}`
    );
    assert.match(
      result.stdout,
      new RegExp(`FINAL:${confirmationCase.expectedMode}`),
      confirmationCase.label
    );
    assert.doesNotMatch(result.stdout, /HANDLED:/, confirmationCase.label);
  }
});

test('Ctrl+C cancels full access confirmation without exiting or changing mode', () => {
  const script = `
    import { PassThrough } from 'node:stream';

    const originalStdout = process.stdout;
    const input = new PassThrough();
    const output = new PassThrough();
    Object.defineProperty(input, 'isTTY', { value: true });
    Object.defineProperty(output, 'isTTY', { value: true });
    Object.defineProperty(output, 'columns', { value: 120 });
    Object.defineProperty(output, 'rows', { value: 40 });
    Object.defineProperty(process, 'stdin', { value: input });
    Object.defineProperty(process, 'stdout', { value: output });

    let transcript = '';
    output.on('data', chunk => {
      transcript += chunk.toString('utf8');
    });

    const { runInteractiveSession } = await import('./dist/interactive.js');
    const engine = {
      mode: 'safe',
      getPermissionMode() {
        return this.mode;
      },
      setPermissionMode(mode) {
        this.mode = mode;
      },
      async chat(message) {
        transcript += 'HANDLED:' + message;
        return 'unexpected';
      }
    };

    const deadline = setTimeout(() => input.end(), 3_000);
    const promptWatcher = setInterval(() => {
      if (transcript.includes('[y/N]:') && !transcript.includes('CTRL_C_SENT')) {
        transcript += 'CTRL_C_SENT';
        input.write('\\x03');
        setTimeout(() => input.write('exit\\n'), 50);
      }
    }, 10);

    input.write('/permissions fullAccess\\n');
    await runInteractiveSession(engine);
    clearTimeout(deadline);
    clearInterval(promptWatcher);
    originalStdout.write(JSON.stringify({ mode: engine.mode, transcript }));
  `;

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: projectDirectory,
      encoding: 'utf-8',
      timeout: 5_000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.mode, 'safe');
  assert.match(outcome.transcript, /Cancelling the current operation/);
  assert.match(outcome.transcript, /Permission command cancelled/);
  assert.match(outcome.transcript, /Goodbye!/);
  assert.doesNotMatch(outcome.transcript, /HANDLED:/);
});

test('permission mode helpers parse aliases', async () => {
  const { parsePermissionMode } = await import(
    '../dist/permissions/mode.js'
  );
  assert.equal(parsePermissionMode('accept'), 'acceptEdits');
  assert.equal(parsePermissionMode('full'), 'fullAccess');
  assert.equal(parsePermissionMode('yolo'), 'fullAccess');
  assert.equal(parsePermissionMode('nope'), null);
});
