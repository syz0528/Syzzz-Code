import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../dist/providers/openai-compatible.js';
import { runProviderRequest } from '../dist/providers/runner.js';
import { QueryEngine } from '../dist/engine.js';
import { z } from 'zod';

function streamFrom(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
  };
}

async function collect(generator) {
  const deltas = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { deltas, response: next.value };
    }
    deltas.push(next.value);
  }
}

const basicRequest = {
  messages: [{ role: 'user', content: 'read a file' }],
  tools: [
    {
      name: 'Read',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  ],
  systemPrompt: 'system'
};

for (const streaming of [false, true])
  test(`OpenAI-compatible forwards explicit tool closure (${streaming ? 'stream' : 'chat'}) only when requested`, async () => {
    const bodies = [];
    const provider = new OpenAICompatibleProvider('key', 'http://localhost', 'test-model');
    provider.client = {
      chat: {
        completions: {
          create: async (body) => {
            bodies.push(body);
            return streaming
              ? streamFrom([
                  { choices: [{ delta: { content: 'final report' }, finish_reason: 'stop' }] }
                ])
              : { choices: [{ message: { content: 'final report' }, finish_reason: 'stop' }] };
          }
        }
      }
    };
    const closed = { ...basicRequest, tools: [], toolChoice: 'none' };
    if (streaming) {
      await collect(runProviderRequest(provider, closed));
      await collect(runProviderRequest(provider, basicRequest));
    } else {
      await provider.chat(closed);
      await provider.chat(basicRequest);
    }
    assert.equal(bodies[0].tool_choice, 'none');
    assert.equal(bodies[0].tools, undefined);
    assert.equal(bodies[1].tool_choice, undefined);
    assert.equal(bodies[1].tools.length, 1);
  });

const lingModel = 'ling-3.0-flash-fin-free';
function lingProvider(override) {
  return new OpenAICompatibleProvider(
    'key',
    'https://opencode.ai/zen/v1',
    lingModel,
    'Deepseek',
    override
  );
}

function mockCompletions(provider, create) {
  provider.client = { chat: { completions: { create } } };
}

test('OpenCode Ling recovery capability is bound to the exact endpoint/model, not its display name', () => {
  const provider = lingProvider();
  assert.equal(provider.getInfo().capabilities.reasoningToggle, true);
  assert.equal(provider.fork().getInfo().capabilities.reasoningToggle, true);
  provider.setModel('ling-unknown');
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
  provider.setModel(lingModel);
  assert.equal(provider.getInfo().capabilities.reasoningToggle, true);
  assert.equal(lingProvider(false).getInfo().capabilities.reasoningToggle, false);
  for (const endpoint of [
    'https://other.invalid/zen/v1',
    'https://opencode.ai/other/v1',
    'http://opencode.ai/zen/v1'
  ]) {
    assert.equal(
      new OpenAICompatibleProvider('key', endpoint, lingModel).getInfo().capabilities
        .reasoningToggle,
      false
    );
  }
  assert.equal(
    new OpenAICompatibleProvider('key', 'https://opencode.ai/zen/v1/', lingModel).getInfo()
      .capabilities.reasoningToggle,
    true
  );
});

test('OpenCode Ling reasoning-only stop recovers once with the verified wire parameter', async () => {
  const provider = lingProvider();
  const bodies = [];
  mockCompletions(provider, (body) => {
    bodies.push(body);
    return streamFrom([
      {
        choices: [
          {
            delta:
              bodies.length === 1 ? { reasoning: 'private-thought' } : { content: 'public-answer' },
            finish_reason: 'stop'
          }
        ]
      }
    ]);
  });
  const request = { ...basicRequest, maxOutputTokens: 128, stopSequences: ['END'] };
  const { deltas, response } = await collect(runProviderRequest(provider, request));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning, undefined);
  assert.equal(bodies[1].thinking, undefined);
  assert.deepEqual(bodies[1], { ...bodies[0], reasoning: { enabled: false } });
  assert.equal(response.message.content, 'public-answer');
  assert.equal(response.message.reasoningContent, undefined);
  assert.ok(!JSON.stringify(deltas).includes('private-thought'));
});

test('OpenCode Ling recovery cannot loop or turn empty/unfinished output into success', async () => {
  for (const [finish, delta, override, expectedCalls] of [
    ['stop', { reasoning: 'private-thought' }, undefined, 2],
    ['stop', { reasoning: 'private-thought' }, false, 1],
    ['length', { reasoning: 'private-thought' }, undefined, 1],
    ['content_filter', { reasoning: 'private-thought' }, undefined, 1],
    [null, { reasoning: 'private-thought' }, undefined, 1],
    ['stop', {}, undefined, 1]
  ]) {
    const provider = lingProvider(override);
    let calls = 0;
    mockCompletions(provider, () => {
      calls++;
      return streamFrom([{ choices: [{ delta, finish_reason: finish }] }]);
    });
    await assert.rejects(collect(runProviderRequest(provider, basicRequest)), (error) => {
      assert.equal(error.code, 'malformed_response');
      assert.doesNotMatch(error.message, /private-thought/);
      return true;
    });
    assert.equal(calls, expectedCalls, `${finish}/${override}`);
  }
});

test('OpenCode Ling never retries after visible text or a tool fragment', async () => {
  for (const delta of [
    { content: 'answer', reasoning: 'private-thought' },
    {
      tool_calls: [{ index: 0, id: 'call', function: { name: 'Read', arguments: '{' } }],
      reasoning: 'private-thought'
    }
  ]) {
    const provider = lingProvider();
    let calls = 0;
    mockCompletions(provider, () => {
      calls++;
      return streamFrom([{ choices: [{ delta, finish_reason: 'stop' }] }]);
    });
    if (delta.content) {
      assert.equal(
        (await collect(runProviderRequest(provider, basicRequest))).response.message.content,
        'answer'
      );
    } else {
      await assert.rejects(collect(runProviderRequest(provider, basicRequest)), /invalid JSON/);
    }
    assert.equal(calls, 1);
  }
});

test('OpenCode Ling cancellation during recovery ends the request without another retry', async () => {
  const provider = lingProvider();
  const abort = new AbortController();
  let calls = 0;
  mockCompletions(provider, (_body, options) => {
    calls++;
    if (calls === 1) {
      return streamFrom([
        { choices: [{ delta: { reasoning: 'private-thought' }, finish_reason: 'stop' }] }
      ]);
    }
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true }
      );
      abort.abort();
    });
  });
  await assert.rejects(
    collect(runProviderRequest(provider, { ...basicRequest, signal: abort.signal }))
  );
  assert.equal(calls, 2);
});

test('direct OpenCode Ling chat uses the same one-shot recovery and preserves the request', async () => {
  for (const recover of [true, false]) {
    const provider = lingProvider();
    const bodies = [];
    mockCompletions(provider, async (body) => {
      bodies.push(body);
      return {
        choices: [
          {
            message:
              recover && bodies.length === 2
                ? { content: 'public-answer' }
                : { reasoning: 'private-thought' },
            finish_reason: 'stop'
          }
        ]
      };
    });
    if (recover) {
      assert.equal((await provider.chat(basicRequest)).message.content, 'public-answer');
    } else {
      await assert.rejects(provider.chat(basicRequest), /after one recovery attempt/);
    }
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], { ...bodies[0], reasoning: { enabled: false } });
  }
});

test('a display name cannot enable DeepSeek-specific retries for a different model', () => {
  const provider = new OpenAICompatibleProvider('key', 'http://localhost', 'ling-test', 'Deepseek');
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
  assert.equal(provider.fork().getInfo().capabilities.reasoningToggle, false);
  provider.setModel('deepseek-v4-flash');
  assert.equal(provider.getInfo().capabilities.reasoningToggle, true);
  provider.setModel('ling-test');
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
});

test('gateway reasoning is activity, never answer text or mismatched continuation metadata', async () => {
  const provider = new OpenAICompatibleProvider('key', 'http://localhost', 'ling-test', 'Gateway');
  provider.client = {
    chat: {
      completions: {
        create: async () =>
          streamFrom([
            { choices: [{ delta: { reasoning: 'private-thought' }, finish_reason: null }] },
            { choices: [{ delta: { content: 'public-answer' }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] }
          ])
      }
    }
  };
  const { deltas, response } = await collect(runProviderRequest(provider, basicRequest));
  assert.equal(response.message.content, 'public-answer');
  assert.equal(response.message.reasoningContent, undefined);
  assert.ok(deltas.some((x) => x.type === 'reasoning_status'));
  assert.ok(!JSON.stringify(deltas).includes('private-thought'));
});

test('reasoning-only gateway streams fail clearly without guessing a toggle or auto-retry', async () => {
  const provider = new OpenAICompatibleProvider('key', 'http://localhost', 'ling-test', 'Deepseek');
  let calls = 0;
  provider.client = {
    chat: {
      completions: {
        create: async (body) => {
          calls++;
          assert.equal(body.thinking, undefined);
          return streamFrom([
            { choices: [{ delta: { reasoning: 'private-thought' }, finish_reason: 'stop' }] }
          ]);
        }
      }
    }
  };
  await assert.rejects(collect(runProviderRequest(provider, basicRequest)), (error) => {
    assert.match(error.message, /only reasoning.*model: ling-test/);
    assert.doesNotMatch(error.message, /private-thought/);
    return true;
  });
  assert.equal(calls, 1);
});

test('non-stream gateway reasoning is not misreported as an empty response', async () => {
  const provider = new OpenAICompatibleProvider('key', 'http://localhost', 'ling-test', 'Deepseek');
  provider.client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            { message: { content: '', reasoning: 'private-thought' }, finish_reason: 'stop' }
          ]
        })
      }
    }
  };
  await assert.rejects(provider.chat(basicRequest), /only reasoning.*model: ling-test/);
});

test('runtime model switching updates OpenAI-compatible capabilities', () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'generic-model',
    'OpenCode',
    undefined,
    {
      'generic-model': 65_536,
      'deepseek-v4-flash': 128_000
    }
  );

  assert.equal(provider.getInfo().model, 'generic-model');
  assert.equal(provider.getInfo().contextWindowTokens, 65_536);
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
  provider.setModel('deepseek-v4-flash');
  assert.equal(provider.getInfo().model, 'deepseek-v4-flash');
  assert.equal(provider.getInfo().contextWindowTokens, 128_000);
  assert.equal(provider.getInfo().capabilities.reasoningToggle, true);
  assert.throws(() => provider.setModel('   '), /non-empty string/);
});

test('streaming aggregates reasoning, usage and tool fragments', async () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'deepseek-v4-flash-free',
    'Deepseek'
  );
  assert.equal(provider.client.maxRetries, 0);
  const requests = [];
  const chunks = [
    {
      id: 'chat-1',
      model: 'reported-model',
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { reasoning_content: 'private ' }
        }
      ]
    },
    {
      id: 'chat-1',
      model: 'reported-model',
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            reasoning_content: 'thought',
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'Re',
                  arguments: '{"pa'
                }
              }
            ]
          }
        }
      ]
    },
    {
      id: 'chat-1',
      model: 'reported-model',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  name: 'ad',
                  arguments: 'th":"package.json"}'
                }
              }
            ]
          }
        }
      ]
    },
    {
      id: 'chat-1',
      model: 'reported-model',
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    }
  ];
  provider.client = {
    chat: {
      completions: {
        create(request) {
          requests.push(request);
          return {
            async withResponse() {
              return {
                data: streamFrom(chunks),
                request_id: 'req-stream'
              };
            }
          };
        }
      }
    }
  };

  const { deltas, response } = await collect(
    provider.chatStream(basicRequest, {
      signal: new AbortController().signal,
      attempt: 1,
      attemptId: 'attempt-1',
      includeUsage: true,
      disableReasoning: false
    })
  );

  assert.equal(requests[0].stream, true);
  assert.deepEqual(requests[0].stream_options, {
    include_usage: true
  });
  assert.equal(requests[0].thinking, undefined);
  assert.deepEqual(response.message.toolCalls, [
    {
      id: 'call-1',
      name: 'Read',
      input: { path: 'package.json' }
    }
  ]);
  assert.equal(response.message.reasoningContent, 'private thought');
  assert.deepEqual(response.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15
  });
  assert.equal(response.finishReason, 'tool_calls');
  assert.equal(response.requestId, 'req-stream');
  assert.equal(response.reportedModel, 'reported-model');
  assert.deepEqual(
    deltas.map((delta) => delta.type),
    ['reasoning_delta', 'reasoning_delta', 'tool_call_delta', 'tool_call_delta', 'usage']
  );
});

test('detects a DeepSeek V4 thinking toggle behind a neutral gateway', () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'deepseek-v4-flash',
    'OpenCode'
  );

  assert.equal(provider.getInfo().capabilities.reasoningToggle, true);
});

test('streaming can disable reasoning and omit stream_options', async () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'model',
    'Compatible'
  );
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
  let capturedRequest;
  provider.client = {
    chat: {
      completions: {
        create(request) {
          capturedRequest = request;
          return streamFrom([
            {
              id: 'chat-2',
              model: 'model',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  delta: { content: 'hello' }
                }
              ]
            }
          ]);
        }
      }
    }
  };

  const { response } = await collect(
    provider.chatStream(basicRequest, {
      signal: new AbortController().signal,
      attempt: 2,
      attemptId: 'attempt-2',
      includeUsage: false,
      disableReasoning: true
    })
  );

  assert.equal(capturedRequest.stream_options, undefined);
  assert.deepEqual(capturedRequest.thinking, {
    type: 'disabled'
  });
  assert.equal(response.message.content, 'hello');
});

test('OpenAI-compatible requests omit an empty tools array', async () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'model',
    'Compatible'
  );
  const requests = [];
  provider.client = {
    chat: {
      completions: {
        create(request) {
          requests.push(request);
          if (request.stream) {
            return streamFrom([
              {
                id: 'chat-no-tools-stream',
                model: 'model',
                choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'streamed' } }]
              }
            ]);
          }
          return {
            id: 'chat-no-tools',
            model: 'model',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'complete' }
              }
            ]
          };
        }
      }
    }
  };
  const request = {
    messages: [{ role: 'user', content: 'summarize' }],
    tools: [],
    systemPrompt: 'system'
  };

  const direct = await provider.chat(request);
  assert.equal(direct.message.content, 'complete');
  const streamed = await collect(
    provider.chatStream(request, {
      signal: new AbortController().signal,
      attempt: 1,
      attemptId: 'no-tools',
      includeUsage: false,
      disableReasoning: false
    })
  );
  assert.equal(streamed.response.message.content, 'streamed');
  assert.equal(requests.length, 2);
  assert.equal('tools' in requests[0], false);
  assert.equal('tools' in requests[1], false);
});

test('streaming accepts usage-confirmed completion when a compatible gateway omits finish_reason', async () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'model',
    'Compatible'
  );
  provider.client = {
    chat: {
      completions: {
        create() {
          return streamFrom([
            {
              id: 'chat-usage-finish',
              model: 'model',
              choices: [{ index: 0, finish_reason: null, delta: { content: 'complete response' } }]
            },
            {
              id: 'chat-usage-finish',
              model: 'model',
              choices: [],
              usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
            }
          ]);
        }
      }
    }
  };

  const { response } = await collect(
    provider.chatStream(basicRequest, {
      signal: new AbortController().signal,
      attempt: 1,
      attemptId: 'attempt-usage-finish',
      includeUsage: true,
      disableReasoning: false
    })
  );

  assert.equal(response.message.content, 'complete response');
  assert.equal(response.finishReason, 'stop');
  assert.deepEqual(response.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
});

test('streaming rejects malformed aggregated tool JSON', async () => {
  const provider = new OpenAICompatibleProvider(
    'test-key',
    'https://example.invalid/v1',
    'model',
    'Compatible'
  );
  assert.equal(provider.getInfo().capabilities.reasoningToggle, false);
  provider.client = {
    chat: {
      completions: {
        create() {
          return streamFrom([
            {
              id: 'chat-3',
              model: 'model',
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-bad',
                        function: {
                          name: 'Read',
                          arguments: '{bad'
                        }
                      }
                    ]
                  }
                }
              ]
            }
          ]);
        }
      }
    }
  };

  await assert.rejects(
    collect(
      provider.chatStream(basicRequest, {
        signal: new AbortController().signal,
        attempt: 1,
        attemptId: 'attempt-bad',
        includeUsage: false,
        disableReasoning: false
      })
    ),
    (error) => error?.code === 'malformed_response'
  );
});

test('mixed valid and malformed tool arguments fail the whole response without execution or retry', async () => {
  for (const malformed of ['{"value":', '{"value":"PRIVATE_SENTINEL",}', '{bad']) {
    let requests = 0;
    let executions = 0;
    const provider = new OpenAICompatibleProvider(
      'test-key',
      'https://example.invalid/v1',
      'model',
      'Compatible'
    );
    mockCompletions(provider, () => {
      requests++;
      return streamFrom([
        {
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'valid',
                    function: { name: 'Inspect', arguments: '{"value":"ok"}' }
                  },
                  { index: 1, id: 'invalid', function: { name: 'Inspect', arguments: malformed } }
                ]
              }
            }
          ]
        }
      ]);
    });
    const engine = new QueryEngine({
      provider,
      audit: false,
      tools: [
        {
          name: 'Inspect',
          description: 'Inspect fixture',
          risk: 'read',
          approval: 'never',
          modeAccess: 'all-modes',
          inputSchema: z.object({ value: z.string() }).strict(),
          async execute() {
            executions++;
            return { content: 'Observed' };
          }
        }
      ]
    });
    const { response: result, deltas: events } = await collect(engine.runTurn('Inspect fixture'));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'malformed_response');
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL|test-key/);
    assert.equal(
      events.some(({ type }) => type === 'tool_requested'),
      false
    );
    assert.equal(requests, 1);
    assert.equal(executions, 0);
  }
});
