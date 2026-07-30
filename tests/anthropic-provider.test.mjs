import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../dist/providers/anthropic.js';
import { runProviderRequest } from '../dist/providers/runner.js';

async function collect(generator) {
  const events = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { events, response: next.value };
    }
    events.push(next.value);
  }
}

test('Anthropic stays non-streaming under the unified runner contract', async () => {
  const provider = new AnthropicProvider('test-key', 'https://example.invalid', 'claude-test');
  assert.equal(provider.client.maxRetries, 0);
  assert.deepEqual(provider.getInfo(), {
    name: 'Anthropic Claude',
    type: 'anthropic',
    model: 'claude-test',
    capabilities: {
      streaming: false,
      reasoningToggle: false
    }
  });

  let capturedRequest;
  provider.client = {
    messages: {
      create(request) {
        capturedRequest = request;
        return {
          async withResponse() {
            return {
              data: {
                id: 'message-1',
                model: 'reported-claude',
                content: [
                  {
                    type: 'text',
                    text: 'Anthropic response.'
                  }
                ],
                stop_reason: 'end_turn',
                usage: {
                  input_tokens: 7,
                  output_tokens: 3
                }
              },
              response: {
                headers: {
                  get(name) {
                    return name === 'request-id' ? 'req-anthropic' : null;
                  }
                }
              }
            };
          }
        };
      }
    }
  };

  const { events, response } = await collect(
    runProviderRequest(
      provider,
      {
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        systemPrompt: 'system'
      },
      { idFactory: () => 'attempt-anthropic' }
    )
  );

  assert.equal(capturedRequest.model, 'claude-test');
  assert.equal(response.message.content, 'Anthropic response.');
  assert.equal(response.requestId, 'req-anthropic');
  assert.equal(response.reportedModel, 'reported-claude');
  assert.deepEqual(response.usage, {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['request_started', 'text_delta', 'usage', 'request_completed']
  );
  assert.equal(events.filter((event) => event.type === 'text_delta').length, 1);
});

test('Anthropic model switching updates provider information', () => {
  const provider = new AnthropicProvider('test-key', 'https://example.invalid', 'claude-before', {
    'claude-before': 100_000,
    'claude-after': 200_000
  });

  assert.equal(provider.getInfo().contextWindowTokens, 100_000);
  provider.setModel('claude-after');
  assert.equal(provider.getInfo().model, 'claude-after');
  assert.equal(provider.getInfo().contextWindowTokens, 200_000);
  assert.equal(provider.getInfo().capabilities.streaming, false);
  assert.throws(() => provider.setModel(''), /non-empty string/);
});
