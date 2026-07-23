import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBackoffDelay,
  runProviderRequest
} from '../dist/providers/runner.js';
import {
  normalizeProviderError,
  ProviderError
} from '../dist/providers/errors.js';

function info(streaming = false, reasoningToggle = false) {
  return {
    name: 'Runner Provider',
    type: 'test',
    model: 'runner-model',
    capabilities: { streaming, reasoningToggle }
  };
}

const request = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  systemPrompt: 'system'
};

async function collect(generator) {
  const events = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

async function collectFailure(generator) {
  const events = [];
  try {
    while (true) {
      const next = await generator.next();
      if (next.done) {
        assert.fail('provider runner unexpectedly completed');
      }
      events.push(next.value);
    }
  } catch (error) {
    return { events, error };
  }
}

test('retries a network error with deterministic exponential backoff', async () => {
  let attempts = 0;
  const delays = [];
  const provider = {
    async chat() {
      attempts += 1;
      if (attempts === 1) {
        throw new ProviderError('network', {
          provider: 'Runner Provider'
        });
      }
      return {
        message: { role: 'assistant', content: 'Recovered.' },
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      };
    },
    getInfo() {
      return info();
    }
  };
  let id = 0;

  const { events, result } = await collect(runProviderRequest(
    provider,
    request,
    {
      random: () => 0.5,
      sleep: async delay => delays.push(delay),
      idFactory: () => 'attempt-' + (++id)
    }
  ));

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(result.message.content, 'Recovered.');
  assert.deepEqual(events.map(event => event.type), [
    'request_started',
    'request_failed',
    'retry_scheduled',
    'request_started',
    'text_delta',
    'usage',
    'request_completed'
  ]);
  assert.equal(events[1].willRetry, true);
});

test('does not retry after a visible text delta', async () => {
  let attempts = 0;
  const provider = {
    async chat() {
      throw new Error('unused');
    },
    async *chatStream() {
      attempts += 1;
      yield { type: 'text_delta', text: 'partial' };
      throw new ProviderError('network', {
        provider: 'Runner Provider'
      });
    },
    getInfo() {
      return info(true, true);
    }
  };

  const { events, error } = await collectFailure(runProviderRequest(
    provider,
    request,
    { sleep: async () => assert.fail('retry sleep should not run') }
  ));

  assert.equal(attempts, 1);
  assert.equal(error.code, 'network');
  assert.equal(
    events.find(event => event.type === 'request_failed').willRetry,
    false
  );
  assert.equal(
    events.some(event => event.type === 'retry_scheduled'),
    false
  );
});

test('does not retry after receiving any tool call fragment', async () => {
  let attempts = 0;
  const provider = {
    async chat() {
      throw new Error('unused');
    },
    async *chatStream() {
      attempts += 1;
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-1',
        name: 'Read',
        arguments: '{'
      };
      throw new ProviderError('network', {
        provider: 'Runner Provider'
      });
    },
    getInfo() {
      return info(true, true);
    }
  };

  const { events } = await collectFailure(runProviderRequest(
    provider,
    request
  ));
  assert.equal(attempts, 1);
  assert.equal(
    events.find(event => event.type === 'request_failed').willRetry,
    false
  );
});

test('recovers reasoning-only output inside the shared attempt budget', async () => {
  const optionsSeen = [];
  const provider = {
    async chat() {
      throw new Error('unused');
    },
    async *chatStream(_request, options) {
      optionsSeen.push({
        attempt: options.attempt,
        disableReasoning: options.disableReasoning
      });
      if (options.attempt === 1) {
        yield {
          type: 'reasoning_delta',
          text: 'private reasoning'
        };
        return {
          message: {
            role: 'assistant',
            content: '',
            reasoningContent: 'private reasoning'
          },
          finishReason: 'stop'
        };
      }
      yield { type: 'text_delta', text: 'Visible answer.' };
      return {
        message: {
          role: 'assistant',
          content: 'Visible answer.'
        },
        finishReason: 'stop'
      };
    },
    getInfo() {
      return info(true, true);
    }
  };

  const { events, result } = await collect(runProviderRequest(
    provider,
    request,
    {
      sleep: async () => {},
      idFactory: () => 'attempt-id'
    }
  ));

  assert.deepEqual(optionsSeen, [
    { attempt: 1, disableReasoning: false },
    { attempt: 2, disableReasoning: true }
  ]);
  assert.equal(result.message.content, 'Visible answer.');
  assert.equal(
    events.filter(event => event.type === 'reasoning_status').length,
    2
  );
  assert.equal(
    events.find(event => event.type === 'retry_scheduled').delayMs,
    0
  );
  assert.equal(
    JSON.stringify(events).includes('private reasoning'),
    false
  );
});

test('retries without stream_options when the endpoint rejects it', async () => {
  const includeUsageValues = [];
  const provider = {
    async chat() {
      throw new Error('unused');
    },
    async *chatStream(_request, options) {
      includeUsageValues.push(options.includeUsage);
      if (options.includeUsage) {
        throw new ProviderError('unsupported_feature', {
          provider: 'Runner Provider',
          feature: 'stream_options'
        });
      }
      yield { type: 'text_delta', text: 'Compatible.' };
      return {
        message: {
          role: 'assistant',
          content: 'Compatible.'
        }
      };
    },
    getInfo() {
      return info(true, true);
    }
  };

  const { events, result } = await collect(runProviderRequest(
    provider,
    request,
    { sleep: async () => {} }
  ));

  assert.deepEqual(includeUsageValues, [true, false]);
  assert.equal(result.message.content, 'Compatible.');
  assert.equal(
    events.find(event => event.type === 'retry_scheduled').reason,
    'unsupported_feature'
  );
});

test('refuses Retry-After beyond the configured maximum', async () => {
  let attempts = 0;
  const provider = {
    async chat() {
      attempts += 1;
      throw new ProviderError('rate_limit', {
        provider: 'Runner Provider',
        retryAfterMs: 30_001
      });
    },
    getInfo() {
      return info();
    }
  };

  const { events, error } = await collectFailure(runProviderRequest(
    provider,
    request
  ));
  assert.equal(attempts, 1);
  assert.equal(error.code, 'rate_limit');
  assert.equal(
    events.find(event => event.type === 'request_failed').willRetry,
    false
  );
});

test('distinguishes attempt timeout from user cancellation', async () => {
  const waitingProvider = {
    chat(providerRequest) {
      return new Promise((resolve, reject) => {
        providerRequest.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true }
        );
      });
    },
    getInfo() {
      return info();
    }
  };

  const timeoutOutcome = await collectFailure(runProviderRequest(
    waitingProvider,
    request,
    {
      maxAttempts: 1,
      attemptTimeoutMs: 10,
      totalTimeoutMs: 100
    }
  ));
  assert.equal(timeoutOutcome.error.code, 'timeout');
  assert.equal(timeoutOutcome.events.at(-1).error.code, 'timeout');

  const ignoresAbortProvider = {
    chat() {
      return new Promise(() => {});
    },
    getInfo() {
      return info();
    }
  };
  const hardTimeoutStartedAt = Date.now();
  const hardTimeoutOutcome = await collectFailure(runProviderRequest(
    ignoresAbortProvider,
    request,
    {
      maxAttempts: 1,
      attemptTimeoutMs: 10,
      totalTimeoutMs: 100
    }
  ));
  assert.equal(hardTimeoutOutcome.error.code, 'timeout');
  assert.ok(Date.now() - hardTimeoutStartedAt < 500);

  const controller = new AbortController();
  let signalStarted;
  const started = new Promise(resolve => {
    signalStarted = resolve;
  });
  const cancellableProvider = {
    chat(providerRequest) {
      signalStarted();
      return new Promise((resolve, reject) => {
        providerRequest.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true }
        );
      });
    },
    getInfo() {
      return info();
    }
  };
  const cancellation = collectFailure(runProviderRequest(
    cancellableProvider,
    { ...request, signal: controller.signal }
  ));
  await started;
  controller.abort();
  const cancelledOutcome = await cancellation;
  assert.equal(cancelledOutcome.error.name, 'AbortError');
  assert.equal(
    cancelledOutcome.events.some(event =>
      event.type === 'request_failed'
    ),
    false
  );
});

test('maps SDK errors into stable public categories', () => {
  const cases = [
    [{ status: 401 }, 'authentication'],
    [{ status: 403 }, 'permission'],
    [{ status: 400, code: 'model_not_found' }, 'model_not_found'],
    [{ status: 404, message: 'route missing' }, 'not_found'],
    [{ status: 429 }, 'rate_limit'],
    [{
      status: 400,
      code: 'context_length_exceeded'
    }, 'context_exceeded'],
    [{
      status: 400,
      message: 'stream_options is not supported'
    }, 'unsupported_feature'],
    [{
      status: 503,
      message: 'Gateway Timeout'
    }, 'provider_internal'],
    [{
      name: 'APIConnectionError',
      message: 'connection failed'
    }, 'network'],
    [{ status: 422, message: 'bad input' }, 'unknown']
  ];

  for (const [shape, expectedCode] of cases) {
    const error = new Error(shape.message ?? 'failure');
    Object.assign(error, shape);
    assert.equal(
      normalizeProviderError(error, 'Mapped').code,
      expectedCode
    );
  }

  const rejectedStreamUsage = new Error('stream_options is unsupported');
  Object.assign(rejectedStreamUsage, { status: 422 });
  const streamUsageError = normalizeProviderError(rejectedStreamUsage, 'Mapped');
  assert.equal(streamUsageError.code, 'unsupported_feature');
  assert.equal(streamUsageError.feature, 'stream_options');

  const withHeaders = new Error('limited');
  Object.assign(withHeaders, {
    status: 429,
    requestID: 'req-429',
    headers: new Headers({ 'retry-after': '2' })
  });
  const mapped = normalizeProviderError(withHeaders, 'Mapped', 0);
  assert.equal(mapped.requestId, 'req-429');
  assert.equal(mapped.retryAfterMs, 2_000);
});

test('backoff jitter stays inside twenty percent', () => {
  assert.equal(calculateBackoffDelay(1, {
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    random: () => 0
  }), 400);
  assert.equal(calculateBackoffDelay(1, {
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    random: () => 1
  }), 600);
  assert.equal(calculateBackoffDelay(10, {
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    random: () => 0.5
  }), 10_000);
});
test('retries only documented transient categories up to three attempts', async () => {
  const transientErrors = [
    new ProviderError('rate_limit', {
      provider: 'Runner Provider'
    }),
    new ProviderError('timeout', {
      provider: 'Runner Provider'
    }),
    new ProviderError('network', {
      provider: 'Runner Provider'
    }),
    new ProviderError('provider_internal', {
      provider: 'Runner Provider',
      status: 503
    })
  ];

  for (const transientError of transientErrors) {
    let attempts = 0;
    const provider = {
      async chat() {
        attempts += 1;
        throw transientError;
      },
      getInfo() {
        return info();
      }
    };
    const outcome = await collectFailure(runProviderRequest(
      provider,
      request,
      { sleep: async () => {} }
    ));

    assert.equal(attempts, 3, transientError.code);
    assert.equal(
      outcome.events.filter(event =>
        event.type === 'retry_scheduled'
      ).length,
      2,
      transientError.code
    );
  }

  const permanent = new ProviderError('authentication', {
    provider: 'Runner Provider',
    status: 401
  });
  let permanentAttempts = 0;
  const permanentProvider = {
    async chat() {
      permanentAttempts += 1;
      throw permanent;
    },
    getInfo() {
      return info();
    }
  };
  await collectFailure(runProviderRequest(
    permanentProvider,
    request,
    { sleep: async () => assert.fail('must not retry') }
  ));
  assert.equal(permanentAttempts, 1);
});

test('honors an acceptable Retry-After value', async () => {
  let attempts = 0;
  const delays = [];
  const provider = {
    async chat() {
      attempts += 1;
      if (attempts === 1) {
        throw new ProviderError('rate_limit', {
          provider: 'Runner Provider',
          retryAfterMs: 2_000
        });
      }
      return {
        message: {
          role: 'assistant',
          content: 'After waiting.'
        }
      };
    },
    getInfo() {
      return info();
    }
  };

  const { result } = await collect(runProviderRequest(
    provider,
    request,
    { sleep: async delay => delays.push(delay) }
  ));
  assert.deepEqual(delays, [2_000]);
  assert.equal(result.message.content, 'After waiting.');
});

test('stops retries when the total budget is exhausted', async () => {
  let clock = 0;
  let attempts = 0;
  const provider = {
    async chat() {
      attempts += 1;
      clock += 100;
      throw new ProviderError('network', {
        provider: 'Runner Provider'
      });
    },
    getInfo() {
      return info();
    }
  };

  const outcome = await collectFailure(runProviderRequest(
    provider,
    request,
    {
      totalTimeoutMs: 150,
      attemptTimeoutMs: 120,
      baseDelayMs: 10,
      maxDelayMs: 10,
      random: () => 0.5,
      now: () => clock,
      sleep: async delay => {
        clock += delay;
      }
    }
  ));

  assert.equal(attempts, 2);
  assert.equal(outcome.error.code, 'network');
  assert.equal(
    outcome.events.filter(event =>
      event.type === 'retry_scheduled'
    ).length,
    1
  );
});

test('stream_options compatibility recovery is attempted only once', async () => {
  let attempts = 0;
  const provider = {
    async chat() {
      throw new Error('unused');
    },
    async *chatStream() {
      attempts += 1;
      throw new ProviderError('unsupported_feature', {
        provider: 'Runner Provider',
        feature: 'stream_options'
      });
    },
    getInfo() {
      return info(true, true);
    }
  };

  const outcome = await collectFailure(runProviderRequest(
    provider,
    request,
    { sleep: async () => {} }
  ));
  assert.equal(attempts, 2);
  assert.equal(outcome.error.code, 'unsupported_feature');
  assert.equal(
    outcome.events.filter(event =>
      event.type === 'retry_scheduled'
    ).length,
    1
  );
});
test('closing the runner closes the underlying provider stream', async () => {
  let streamClosed = false;
  const provider = {
    async chat() {
      throw new Error('unused');
    },
    async *chatStream() {
      try {
        yield { type: 'text_delta', text: 'partial' };
        await new Promise(() => {});
      } finally {
        streamClosed = true;
      }
    },
    getInfo() {
      return info(true, true);
    }
  };

  const runner = runProviderRequest(provider, request);
  assert.equal((await runner.next()).value.type, 'request_started');
  assert.equal((await runner.next()).value.type, 'text_delta');
  await runner.return();
  assert.equal(streamClosed, true);
});
