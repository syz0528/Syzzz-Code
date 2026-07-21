import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig } from '../dist/config.js';

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
    /must be "anthropic" or "openai-compatible"/
  );
});

test('rejects a selected model missing from the configured model list', () => {
  const config = createValidConfig();
  config.providers.local.model = 'model-c';

  assert.throws(
    () => validateConfig(config),
    /model must be included/
  );
});

test('rejects a current provider that is not configured', () => {
  const config = createValidConfig();
  config.currentProvider = 'missing';

  assert.throws(
    () => validateConfig(config),
    /does not exist in providers/
  );
});

test('importing configuration does not load a workspace .env file', () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'syzzz-config-env-'));
  const variableName = 'SYZZZ_DOTENV_SHOULD_NOT_LOAD';
  const environment = { ...process.env };
  delete environment[variableName];

  try {
    writeFileSync(
      join(workingDirectory, '.env'),
      `${variableName}=secret\n`,
      'utf8'
    );
    const configModuleUrl = pathToFileURL(
      join(projectDirectory, 'dist', 'config.js')
    ).href;
    const script =
      'await import(' + JSON.stringify(configModuleUrl) + ');' +
      'console.log(process.env.' + variableName + " ?? 'unset');";
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: workingDirectory,
        encoding: 'utf8',
        env: environment
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'unset');
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});
