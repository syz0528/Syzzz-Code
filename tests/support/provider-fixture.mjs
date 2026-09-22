import { createServer } from 'node:http';
import { writeAnthropicSse } from './anthropic-sse.mjs';

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function sseEvent(body) {
  return Buffer.from(`data: ${JSON.stringify(body)}\n\n`, 'utf8');
}

function writeSplitBuffer(response, value, splitAt) {
  response.write(value.subarray(0, splitAt));
  response.write(value.subarray(splitAt));
}

function writeOpenAIText(response, model, text = '兼容_OK', includeUsage = true) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'x-request-id': 'request-contract-text'
  });
  const first = sseEvent({
    id: 'chatcmpl-contract',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  });
  const multibyte = Buffer.from('兼', 'utf8');
  const byteIndex = first.indexOf(multibyte);
  writeSplitBuffer(response, first, byteIndex + 1);
  response.write(
    sseEvent({
      id: 'chatcmpl-contract',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    })
  );
  if (includeUsage) {
    response.write(
      sseEvent({
        id: 'chatcmpl-contract',
        object: 'chat.completion.chunk',
        model,
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 3,
          total_tokens: 14
        }
      })
    );
  }
  response.end('data: [DONE]\n\n');
}

function writeOpenAITool(response, model, multiple = false) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'x-request-id': 'request-contract-tool'
  });
  response.write(
    sseEvent({
      id: 'chatcmpl-tool',
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_contract',
                type: 'function',
                function: { name: 'Re', arguments: '{"pa' }
              },
              ...(multiple
                ? [
                    {
                      index: 1,
                      id: 'call_contract_2',
                      type: 'function',
                      function: { name: 'Gre', arguments: '{"pat' }
                    }
                  ]
                : [])
            ]
          },
          finish_reason: null
        }
      ]
    })
  );
  response.write(
    sseEvent({
      id: 'chatcmpl-tool',
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              ...(multiple
                ? [
                    {
                      index: 1,
                      function: { name: 'p', arguments: 'tern":"tax"}' }
                    }
                  ]
                : []),
              {
                index: 0,
                function: { name: 'ad', arguments: 'th":"README.md"}' }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    })
  );
  response.write(
    sseEvent({
      id: 'chatcmpl-tool',
      object: 'chat.completion.chunk',
      model,
      choices: [],
      usage: {
        prompt_tokens: 13,
        completion_tokens: 7,
        total_tokens: 20
      }
    })
  );
  response.end('data: [DONE]\n\n');
}

function openAIUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  return typeof last?.content === 'string' ? last.content : '';
}

function handleOpenAI(profile, body, response, requestCount) {
  const model = typeof body.model === 'string' ? body.model : 'contract-model';
  const userText = openAIUserText(body);

  if (profile === 'always-rate-limit') {
    json(
      response,
      429,
      {
        error: {
          message: 'fixture rate limit',
          type: 'rate_limit_error',
          code: 'rate_limit'
        }
      },
      { 'retry-after': '0' }
    );
    return;
  }

  const statusMatch = /\bhttp-(401|403|404|500|502|503|504)\b/u.exec(userText);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1], 10);
    json(response, status, {
      error: {
        message: status === 404 ? 'fixture route missing' : `fixture HTTP ${status}`,
        type: status >= 500 ? 'server_error' : 'request_error',
        code: `fixture_${status}`
      }
    });
    return;
  }

  if (userText.includes('network-reset') && requestCount === 1) {
    response.destroy();
    return;
  }

  if (userText.includes('timeout-once') && requestCount === 1) {
    setTimeout(() => {
      if (!response.destroyed) {
        writeOpenAIText(response, model);
      }
    }, 500);
    return;
  }

  if (profile === 'openai-compatible-minimal' && body.stream_options) {
    json(response, 400, {
      error: {
        message: 'Unsupported parameter: stream_options.include_usage',
        type: 'invalid_request_error',
        param: 'stream_options',
        code: 'unsupported_parameter'
      }
    });
    return;
  }

  if (profile === 'deepseek-reasoning' && body.thinking?.type !== 'disabled') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'x-request-id': 'request-contract-reasoning'
    });
    response.write(
      sseEvent({
        id: 'chatcmpl-reasoning',
        object: 'chat.completion.chunk',
        model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: 'private reasoning' },
            finish_reason: null
          }
        ]
      })
    );
    response.write(
      sseEvent({
        id: 'chatcmpl-reasoning',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })
    );
    response.end('data: [DONE]\n\n');
    return;
  }

  if (userText.includes('rate-limit') && requestCount === 1) {
    json(
      response,
      429,
      {
        error: {
          message: 'rate limit',
          type: 'rate_limit_error',
          code: 'rate_limit'
        }
      },
      { 'retry-after': '0' }
    );
    return;
  }

  if (userText.includes('malformed')) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.end('data: {"choices":[}\n\ndata: [DONE]\n\n');
    return;
  }

  if (userText.includes('early-eof')) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.end(
      sseEvent({
        id: 'chatcmpl-early-eof',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }]
      })
    );
    return;
  }

  if (userText.includes('usage-without-finish')) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(
      sseEvent({
        id: 'chatcmpl-usage-without-finish',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { content: 'usage-confirmed' }, finish_reason: null }]
      })
    );
    response.write(
      sseEvent({
        id: 'chatcmpl-usage-without-finish',
        object: 'chat.completion.chunk',
        model,
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }
      })
    );
    response.end('data: [DONE]\n\n');
    return;
  }

  if (userText.includes('tool-contract')) {
    writeOpenAITool(response, model, userText.includes('multi-tool-contract'));
    return;
  }

  if (!body.stream) {
    json(response, 200, {
      id: 'chatcmpl-contract',
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'compatible_OK' },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }
    });
    return;
  }

  writeOpenAIText(
    response,
    model,
    profile === 'deepseek-reasoning' ? '恢复_OK' : '兼容_OK',
    !userText.includes('no-usage')
  );
}

function responsesUserText(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const users = input.filter((item) => item?.role === 'user');
  const last = users.at(-1);
  return typeof last?.content === 'string' ? last.content : '';
}

function responsesUsage() {
  return {
    input_tokens: 17,
    output_tokens: 5,
    total_tokens: 22,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 }
  };
}

function completedResponse(model, output, outputText = '') {
  return {
    id: 'resp_contract',
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model,
    output,
    output_text: outputText,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    background: false,
    max_output_tokens: null,
    previous_response_id: null,
    prompt: null,
    reasoning: null,
    service_tier: 'default',
    store: false,
    truncation: 'disabled',
    usage: responsesUsage(),
    user: null
  };
}

function responseMessage(text) {
  return {
    id: 'msg_responses_contract',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }]
  };
}

function writeResponsesText(response, model, text = '\u54cd\u5e94_OK') {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'x-request-id': 'request-responses-text'
  });
  const deltaEvent = sseEvent({
    type: 'response.output_text.delta',
    sequence_number: 1,
    item_id: 'msg_responses_contract',
    output_index: 0,
    content_index: 0,
    delta: text,
    logprobs: []
  });
  const multibyte = Buffer.from('\u54cd', 'utf8');
  const byteIndex = deltaEvent.indexOf(multibyte);
  writeSplitBuffer(response, deltaEvent, byteIndex + 1);
  response.write(
    sseEvent({
      type: 'response.completed',
      sequence_number: 2,
      response: completedResponse(model, [responseMessage(text)], text)
    })
  );
  response.end('data: [DONE]\n\n');
}

function writeResponsesTool(response, model) {
  const call = {
    id: 'fc_responses_contract',
    type: 'function_call',
    call_id: 'call_responses_contract',
    name: 'Read',
    arguments: '{"path":"README.md"}',
    status: 'completed'
  };
  const reasoning = {
    id: 'rs_responses_contract',
    type: 'reasoning',
    summary: [],
    encrypted_content: 'encrypted-contract-reasoning',
    status: 'completed'
  };
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'x-request-id': 'request-responses-tool'
  });
  response.write(
    sseEvent({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 1,
      item: { ...call, arguments: '', status: 'in_progress' }
    })
  );
  response.write(
    sseEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      item_id: call.id,
      output_index: 1,
      delta: '{"path":"READ'
    })
  );
  response.write(
    sseEvent({
      type: 'response.function_call_arguments.delta',
      sequence_number: 3,
      item_id: call.id,
      output_index: 1,
      delta: 'ME.md"}'
    })
  );
  response.write(
    sseEvent({
      type: 'response.function_call_arguments.done',
      sequence_number: 4,
      item_id: call.id,
      output_index: 1,
      name: call.name,
      arguments: call.arguments
    })
  );
  response.write(
    sseEvent({
      type: 'response.output_item.done',
      sequence_number: 5,
      output_index: 1,
      item: call
    })
  );
  response.write(
    sseEvent({
      type: 'response.completed',
      sequence_number: 6,
      response: completedResponse(model, [reasoning, call])
    })
  );
  response.end('data: [DONE]\n\n');
}

function handleResponses(body, response) {
  const model = typeof body.model === 'string' ? body.model : 'responses-contract-model';
  const input = Array.isArray(body.input) ? body.input : [];
  const userText = responsesUserText(body);

  if (!body.stream) {
    if (userText.includes('non-stream-fallback')) {
      json(response, 200, completedResponse(model, [responseMessage('FALLBACK_TEXT')]), {
        'x-request-id': 'request-responses-fallback'
      });
      return;
    }
    if (userText.includes('non-stream-refusal')) {
      const refusal = {
        ...responseMessage(''),
        content: [{ type: 'refusal', refusal: 'REFUSAL_TEXT' }]
      };
      json(response, 200, completedResponse(model, [refusal]));
      return;
    }
    if (userText.includes('non-stream-invalid-tool')) {
      json(
        response,
        200,
        completedResponse(model, [
          {
            type: 'function_call',
            call_id: 'call_invalid',
            name: 'Read',
            arguments: '{invalid'
          }
        ])
      );
      return;
    }
    if (userText.includes('non-stream-empty')) {
      json(response, 200, completedResponse(model, []));
      return;
    }
    const text = 'RESPONSES_NON_STREAM_OK';
    json(response, 200, completedResponse(model, [responseMessage(text)], text), {
      'x-request-id': 'request-responses-non-stream'
    });
    return;
  }
  if (userText.includes('early-eof')) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.end(
      sseEvent({
        type: 'response.output_text.delta',
        sequence_number: 1,
        item_id: 'msg_partial',
        output_index: 0,
        content_index: 0,
        delta: 'partial',
        logprobs: []
      })
    );
    return;
  }
  if (userText.includes('failed-response')) {
    const failed = {
      ...completedResponse(model, []),
      status: 'failed',
      error: { code: 'server_error', message: 'fixture failure' },
      usage: null
    };
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(sseEvent({ type: 'response.failed', sequence_number: 1, response: failed }));
    response.end('data: [DONE]\n\n');
    return;
  }
  if (userText.includes('stream-error-rate-limit')) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(sseEvent({ type: 'error', sequence_number: 1, code: 'rate_limit_exceeded' }));
    response.end('data: [DONE]\n\n');
    return;
  }
  if (userText.includes('stream-mismatch')) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(
      sseEvent({ type: 'response.output_text.delta', sequence_number: 1, delta: 'STREAMED' })
    );
    response.write(
      sseEvent({
        type: 'response.completed',
        sequence_number: 2,
        response: completedResponse(model, [responseMessage('FINAL')], 'FINAL')
      })
    );
    response.end('data: [DONE]\n\n');
    return;
  }
  if (userText.includes('stream-final-only')) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(
      sseEvent({
        type: 'response.completed',
        sequence_number: 1,
        response: completedResponse(model, [responseMessage('FINAL_ONLY')], 'FINAL_ONLY')
      })
    );
    response.end('data: [DONE]\n\n');
    return;
  }
  if (userText.includes('reasoning-refusal')) {
    const refusal = {
      ...responseMessage(''),
      content: [{ type: 'refusal', refusal: 'REFUSED' }]
    };
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(
      sseEvent({
        type: 'response.reasoning_summary_text.delta',
        sequence_number: 1,
        delta: 'PRIVATE_REASONING'
      })
    );
    response.write(
      sseEvent({ type: 'response.refusal.delta', sequence_number: 2, delta: 'REFUSED' })
    );
    response.write(
      sseEvent({
        type: 'response.completed',
        sequence_number: 3,
        response: completedResponse(model, [refusal])
      })
    );
    response.end('data: [DONE]\n\n');
    return;
  }
  if (input.some((item) => item?.type === 'function_call_output')) {
    writeResponsesText(response, model, 'TOOL_RESULT_ACCEPTED');
    return;
  }
  if (userText.includes('tool-contract')) {
    writeResponsesTool(response, model);
    return;
  }
  writeResponsesText(response, model);
}

function handleAnthropic(body, response) {
  const userText = Array.isArray(body.messages)
    ? body.messages
        .flatMap((message) =>
          typeof message.content === 'string' ? [message.content] : (message.content ?? [])
        )
        .map((block) =>
          typeof block === 'string' ? block : block?.type === 'text' ? block.text : ''
        )
        .join(' ')
    : '';
  const toolRequest = userText.includes('tool-contract');
  if (userText.includes('anthropic-error-401')) {
    json(response, 401, {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'fixture authentication failed'
      }
    });
    return;
  }
  const message = {
    id: 'msg_contract',
    type: 'message',
    role: 'assistant',
    model: typeof body.model === 'string' ? body.model : 'claude-contract',
    content: toolRequest
      ? [
          {
            type: 'tool_use',
            id: 'toolu_contract',
            name: 'Read',
            input: { path: 'README.md' }
          }
        ]
      : [{ type: 'text', text: 'ANTHROPIC_OK' }],
    stop_reason: toolRequest ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 9,
      output_tokens: 4
    }
  };
  const headers = { 'request-id': 'request-anthropic-contract' };
  if (body.stream) writeAnthropicSse(response, message, headers);
  else json(response, 200, message, headers);
}

export async function startProviderFixture(profile) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readJson(request);
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body
      });
      if (profile === 'anthropic-messages') {
        handleAnthropic(body, response);
      } else if (profile === 'openai-responses') {
        handleResponses(body, response);
      } else {
        handleOpenAI(profile, body, response, requests.length);
      }
    } catch (error) {
      json(response, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'fixture_error'
        }
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Provider fixture did not bind a TCP port');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    openAIBaseURL: `${origin}/v1`,
    requests,
    async close() {
      const closing = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await closing;
    }
  };
}
