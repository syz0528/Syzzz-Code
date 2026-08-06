import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig } from '../dist/config.js';
import { resolveProviderCredential } from '../dist/config.js';

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

function createValidConfig() {
  return {
    currentProvider: 'local',
    providers: {
      local: {
        name: 'Local Provider',
        type: 'openai-compatible',
        model: 'model-a',
        models: ['model-a', 'model-b'],
        env: {
          BASE_URL: 'http://localhost:8080/v1/',
          API_KEY: 'test-key'
        }
      }
    }
  };
}

test('validates and normalizes a provider configuration', () => {
  const config = validateConfig(createValidConfig());
  assert.equal(config.currentProvider, 'local');
  assert.equal(config.providers.local.env.BASE_URL, 'http://localhost:8080/v1');
});

test('rejects an unknown provider protocol type', () => {
  const config = createValidConfig();
  config.providers.local.type = 'custom';

  assert.throws(
    () => validateConfig(config),
    /must be "anthropic", "openai-compatible", or "openai-responses"/
  );
});

test('rejects a selected model missing from the configured model list', () => {
  const config = createValidConfig();
  config.providers.local.model = 'model-c';

  assert.throws(() => validateConfig(config), /model must be included/);
});

test('rejects a current provider that is not configured', () => {
  const config = createValidConfig();
  config.currentProvider = 'missing';

  assert.throws(() => validateConfig(config), /does not exist in providers/);
});

test('importing configuration does not load a workspace .env file', () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'syzzz-config-env-'));
  const variableName = 'SYZZZ_DOTENV_SHOULD_NOT_LOAD';
  const environment = { ...process.env };
  delete environment[variableName];

  try {
    writeFileSync(join(workingDirectory, '.env'), `${variableName}=secret\n`, 'utf8');
    const configModuleUrl = pathToFileURL(join(projectDirectory, 'dist', 'config.js')).href;
    const script =
      'await import(' +
      JSON.stringify(configModuleUrl) +
      ');' +
      'console.log(process.env.' +
      variableName +
      " ?? 'unset');";
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: workingDirectory,
      encoding: 'utf8',
      env: environment
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'unset');
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});
test('audit configuration defaults safely for existing config files', () => {
  const config = validateConfig(createValidConfig());
  assert.deepEqual(config.audit, {
    retentionDays: 30,
    maxBytes: 20 * 1024 * 1024
  });
});

test('UI streaming defaults safely and validates explicit configuration', () => {
  const legacyConfig = validateConfig(createValidConfig());
  assert.deepEqual(legacyConfig.ui, {
    streamOutput: true,
    mode: 'auto',
    persistentHistory: true,
    language: 'auto',
    frameRate: 'auto'
  });

  const buffered = createValidConfig();
  buffered.ui = { streamOutput: false };
  assert.deepEqual(validateConfig(buffered).ui, {
    streamOutput: false,
    mode: 'auto',
    persistentHistory: true,
    language: 'auto',
    frameRate: 'auto'
  });

  const explicit = createValidConfig();
  explicit.ui = {
    streamOutput: true,
    mode: 'inline',
    persistentHistory: false,
    language: 'zh-CN',
    frameRate: 60
  };
  assert.deepEqual(validateConfig(explicit).ui, explicit.ui);

  const invalid = createValidConfig();
  invalid.ui = { streamOutput: 'sometimes' };
  assert.throws(() => validateConfig(invalid), /ui.streamOutput must be a boolean/);

  const invalidMode = createValidConfig();
  invalidMode.ui = { streamOutput: true, mode: 'windowed' };
  assert.throws(() => validateConfig(invalidMode), /ui.mode/);

  const invalidFrameRate = createValidConfig();
  invalidFrameRate.ui = { streamOutput: true, frameRate: 45 };
  assert.throws(() => validateConfig(invalidFrameRate), /ui.frameRate/);
});

test('context configuration defaults safely and validates model overrides', () => {
  const legacyConfig = validateConfig(createValidConfig());
  assert.deepEqual(legacyConfig.context, {
    autoCompact: true,
    defaultWindowTokens: 65_536
  });

  const configured = createValidConfig();
  configured.context = {
    autoCompact: false,
    defaultWindowTokens: 128_000
  };
  configured.providers.local.modelContextWindows = {
    'model-a': 64_000,
    'model-b': 128_000
  };
  const validated = validateConfig(configured);
  assert.deepEqual(validated.context, configured.context);
  assert.deepEqual(
    validated.providers.local.modelContextWindows,
    configured.providers.local.modelContextWindows
  );

  const unknownModel = createValidConfig();
  unknownModel.providers.local.modelContextWindows = {
    'model-c': 64_000
  };
  assert.throws(() => validateConfig(unknownModel), /is not a configured model/);

  const invalidWindow = createValidConfig();
  invalidWindow.context = {
    autoCompact: true,
    defaultWindowTokens: 8_000
  };
  assert.throws(() => validateConfig(invalidWindow), /context.defaultWindowTokens/);
});

test('validates audit retention and size bounds', () => {
  const invalidRetention = createValidConfig();
  invalidRetention.audit = {
    retentionDays: -1,
    maxBytes: 1024
  };
  assert.throws(() => validateConfig(invalidRetention), /audit.retentionDays/);

  const invalidSize = createValidConfig();
  invalidSize.audit = {
    retentionDays: 30,
    maxBytes: 0
  };
  assert.throws(() => validateConfig(invalidSize), /audit.maxBytes/);

  const disabled = createValidConfig();
  disabled.audit = {
    retentionDays: 0,
    maxBytes: 4096
  };
  assert.deepEqual(validateConfig(disabled).audit, {
    retentionDays: 0,
    maxBytes: 4096
  });
});

test('rejects Provider URLs that could expose embedded credentials', () => {
  const embedded = createValidConfig();
  embedded.providers.local.env.BASE_URL = 'https://user:secret@example.com/v1';
  assert.throws(() => validateConfig(embedded), /must not contain embedded credentials/);

  const query = createValidConfig();
  query.providers.local.env.BASE_URL = 'https://example.com/v1?api_key=secret';
  assert.throws(() => validateConfig(query), /must not contain a query or fragment/);
});

test('configuration v1 adds session and subagent defaults and rejects future schemas', () => {
  const legacy = validateConfig(createValidConfig());
  assert.equal(legacy.schemaVersion, 1);
  assert.deepEqual(legacy.sessions, { autoSave: true, startup: 'ask' });
  assert.deepEqual(legacy.subagents, { enabled: true });

  const disabled = createValidConfig();
  disabled.schemaVersion = 1;
  disabled.sessions = { autoSave: false };
  disabled.subagents = { enabled: false };
  const validatedDisabled = validateConfig(disabled);
  assert.deepEqual(validatedDisabled.sessions, { autoSave: false, startup: 'ask' });
  assert.deepEqual(validatedDisabled.subagents, { enabled: false });

  const invalidSubagents = createValidConfig();
  invalidSubagents.subagents = { enabled: 'sometimes' };
  assert.throws(() => validateConfig(invalidSubagents), /subagents.enabled must be a boolean/);

  const future = createValidConfig();
  future.schemaVersion = 99;
  assert.throws(() => validateConfig(future), /unsupported configuration schemaVersion/);
});

test('Skills configuration defaults compatibly and validates disabled names', () => {
  const legacyConfig = validateConfig(createValidConfig());
  assert.deepEqual(legacyConfig.skills, {
    enabled: true,
    allowImplicit: true,
    disabled: []
  });

  const configured = createValidConfig();
  configured.skills = {
    enabled: false,
    allowImplicit: false,
    disabled: ['review-code']
  };
  assert.deepEqual(validateConfig(configured).skills, configured.skills);

  const duplicate = createValidConfig();
  duplicate.skills = {
    enabled: true,
    allowImplicit: true,
    disabled: ['review-code', 'review-code']
  };
  assert.throws(() => validateConfig(duplicate), /must not contain duplicates/);
});

test('environment credentials take precedence without mutating process.env', () => {
  const provider = createValidConfig().providers.local;
  provider.env.API_KEY = 'stored-secret';
  provider.env.API_KEY_ENV = 'SYZZZ_TEST_API_KEY';
  const environment = { SYZZZ_TEST_API_KEY: 'environment-secret' };

  assert.deepEqual(resolveProviderCredential(provider, environment), {
    value: 'environment-secret',
    source: 'environment',
    environmentVariable: 'SYZZZ_TEST_API_KEY'
  });
  delete environment.SYZZZ_TEST_API_KEY;
  assert.deepEqual(resolveProviderCredential(provider, environment), {
    value: 'stored-secret',
    source: 'stored',
    environmentVariable: 'SYZZZ_TEST_API_KEY'
  });
  provider.env.API_KEY = '   ';
  assert.deepEqual(resolveProviderCredential(provider, environment), {
    value: '',
    source: 'missing',
    environmentVariable: 'SYZZZ_TEST_API_KEY'
  });
});

test('loading a legacy config creates a private migration backup', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'syzzz-config-migrate-'));
  const configDirectory = join(testHome, '.syzzz-code');
  const configPath = join(configDirectory, 'config.json');
  try {
    mkdirSync(configDirectory);
    writeFileSync(configPath, JSON.stringify(createValidConfig()));
    const configModuleUrl = pathToFileURL(join(projectDirectory, 'dist', 'config.js')).href;
    const script =
      `const m = await import(${JSON.stringify(configModuleUrl)});` +
      `console.log(JSON.stringify(m.loadConfig()));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: projectDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
    const files = readdirSync(configDirectory);
    assert.ok(files.some((name) => name.endsWith('.pre-v1.bak')));
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).schemaVersion, 1);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});
