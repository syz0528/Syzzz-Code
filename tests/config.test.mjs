import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../dist/config.js';

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
