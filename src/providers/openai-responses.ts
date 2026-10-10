import OpenAI from 'openai';
import type {
  AIProvider,
  ConversationMessage,
  ProviderAttemptOptions,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderDelta,
  ProviderTool,
  ProviderUsage,
  ToolCall
} from './base.js';
import { isProviderAbort, ProviderError } from './errors.js';
import {
  validateProviderHeaders,
  providerHeaderFetch,
  normalizeHeaderProviderError
} from './headers.js';

const PRIVATE_OUTPUT_PREFIX = 'openai-responses-output-v1:';
const MAX_PRIVATE_OUTPUT_BYTES = 256 * 1024;

interface FunctionCallAccumulator {
  callId: string;
  name: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeResponsesBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/u, '').replace(/\/responses$/u, '');
}

function parseToolArguments(providerName: string, toolName: string, rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments);
  } catch (error) {
    throw new ProviderError('malformed_response', {
      provider: providerName,
      cause: error,
      message: `${providerName} API Error: Tool ${toolName} returned invalid JSON arguments`
    });
  }
}

function toUsage(usage: unknown): ProviderUsage | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens = usage.total_tokens;
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    typeof totalTokens !== 'number'
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function sanitizeOutputItem(item: unknown): Record<string, unknown> | undefined {
  if (!isRecord(item) || typeof item.type !== 'string') {
    return undefined;
  }

  if (
    item.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.arguments === 'string'
  ) {
    return {
      type: 'function_call',
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      ...(typeof item.status === 'string' ? { status: item.status } : {})
    };
  }

  if (item.type === 'reasoning' && typeof item.id === 'string') {
    if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) {
      return undefined;
    }
    return {
      type: 'reasoning',
      id: item.id,
      summary: [],
      encrypted_content: item.encrypted_content,
      ...(typeof item.status === 'string' ? { status: item.status } : {})
    };
  }

  if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
    const content: Array<Record<string, unknown>> = [];
    for (const part of item.content) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.type === 'output_text' && typeof part.text === 'string') {
        content.push({ type: 'output_text', text: part.text, annotations: [] });
      }
      if (part.type === 'refusal' && typeof part.refusal === 'string') {
        content.push({ type: 'refusal', refusal: part.refusal });
      }
    }
    return {
      type: 'message',
      role: 'assistant',
      content,
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      ...(typeof item.status === 'string' ? { status: item.status } : {}),
      ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {})
    };
  }

  return undefined;
}

function serializePrivateOutput(output: unknown): string | undefined {
  if (!Array.isArray(output)) {
    return undefined;
  }
  const items = output.flatMap((item) => {
    const sanitized = sanitizeOutputItem(item);
    return sanitized ? [sanitized] : [];
  });
  if (!items.some((item) => item.type === 'function_call')) {
    return undefined;
  }
  const serialized = `${PRIVATE_OUTPUT_PREFIX}${JSON.stringify(items)}`;
  return Buffer.byteLength(serialized, 'utf8') <= MAX_PRIVATE_OUTPUT_BYTES ? serialized : undefined;
}

function parsePrivateOutput(value: string | undefined): Array<Record<string, unknown>> | undefined {
  if (!value?.startsWith(PRIVATE_OUTPUT_PREFIX)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value.slice(PRIVATE_OUTPUT_PREFIX.length));
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const items = parsed.flatMap((item) => {
      const sanitized = sanitizeOutputItem(item);
      return sanitized ? [sanitized] : [];
    });
    return items.some((item) => item.type === 'function_call') ? items : undefined;
  } catch {
    return undefined;
  }
}

export function convertMessagesToResponses(
  messages: ConversationMessage[]
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'user') {
      input.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const privateOutput = parsePrivateOutput(message.reasoningContent);
      if (privateOutput) {
        input.push(...privateOutput);
        continue;
      }
      if (message.content) {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input)
        });
      }
      continue;
    }

    input.push({
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content
    });
  }
  return input;
}

export function convertToolsToResponses(tools: ProviderTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false
  }));
}

function responseText(response: unknown): string {
  if (!isRecord(response)) {
    return '';
  }
  if (typeof response.output_text === 'string' && response.output_text) {
    return response.output_text;
  }
  if (!Array.isArray(response.output)) {
    return '';
  }
  const parts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text);
      } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
        parts.push(part.refusal);
      }
    }
  }
  return parts.join('');
}

function responseToolCalls(providerName: string, response: unknown): ToolCall[] {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return [];
  }
  return response.output.flatMap((item) => {
    if (
      !isRecord(item) ||
      item.type !== 'function_call' ||
      typeof item.call_id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.arguments !== 'string'
    ) {
      return [];
    }
    return [
      {
        id: item.call_id,
        name: item.name,
        input: parseToolArguments(providerName, item.name, item.arguments)
      }
    ];
  });
}

function responseErrorCode(
  errorCode: unknown
): 'rate_limit' | 'context_exceeded' | 'provider_internal' {
  const normalized = typeof errorCode === 'string' ? errorCode.toLowerCase() : '';
  if (normalized.includes('rate_limit')) {
    return 'rate_limit';
  }
  if (normalized.includes('context') || normalized.includes('prompt')) {
    return 'context_exceeded';
  }
  return 'provider_internal';
}

export class OpenAIResponsesProvider implements AIProvider {
  private readonly client: OpenAI;
  private model: string;
  private readonly providerName: string;
  private readonly modelContextWindows: Readonly<Record<string, number>>;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly headers?: Readonly<Record<string, string>>;

  constructor(
    apiKey: string,
    baseURL: string,
    model: string,
    providerName: string = 'OpenAI Responses',
    modelContextWindows: Readonly<Record<string, number>> = {},
    headers?: Readonly<Record<string, string>>
  ) {
    this.apiKey = apiKey;
    this.headers = validateProviderHeaders(headers);
    this.baseURL = normalizeResponsesBaseURL(baseURL);
    this.client = new OpenAI({
      apiKey,
      ...(this.headers ? { fetch: providerHeaderFetch(this.headers) } : {}),
      baseURL: this.baseURL,
      maxRetries: 0,
      logLevel: 'off'
    });
    this.model = model;
    this.providerName = providerName;
    this.modelContextWindows = modelContextWindows;
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    try {
      const created = await this.createResponse(this.requestBody(request), request.signal);
      return this.parseCompletedResponse(created.response, created.requestId);
    } catch (error: unknown) {
      if (request.signal?.aborted || isProviderAbort(error)) {
        throw error;
      }
      throw normalizeHeaderProviderError(error, this.providerName, this.headers);
    }
  }

  async *chatStream(
    request: ProviderChatRequest,
    attemptOptions: ProviderAttemptOptions
  ): AsyncGenerator<ProviderDelta, ProviderChatResponse> {
    try {
      const requestPromise = this.client.responses.create(
        { ...this.requestBody(request), stream: true } as any,
        { signal: attemptOptions.signal }
      ) as any;
      let stream: AsyncIterable<any>;
      let requestId: string | undefined;
      if (typeof requestPromise?.withResponse === 'function') {
        const result = await requestPromise.withResponse();
        stream = result.data;
        requestId = result.request_id ?? undefined;
      } else {
        stream = await requestPromise;
      }

      let streamedText = '';
      let completedResponse: unknown;
      let usage: ProviderUsage | undefined;
      const calls = new Map<number, FunctionCallAccumulator>();

      for await (const event of stream) {
        if (!isRecord(event) || typeof event.type !== 'string') {
          continue;
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          streamedText += event.delta;
          yield { type: 'text_delta', text: event.delta };
          continue;
        }
        if (event.type === 'response.refusal.delta' && typeof event.delta === 'string') {
          streamedText += event.delta;
          yield { type: 'text_delta', text: event.delta };
          continue;
        }
        if (
          (event.type === 'response.reasoning_summary_text.delta' ||
            event.type === 'response.reasoning_text.delta') &&
          typeof event.delta === 'string'
        ) {
          yield { type: 'reasoning_delta', text: event.delta };
          continue;
        }
        if (event.type === 'response.output_item.added' && isRecord(event.item)) {
          const index = typeof event.output_index === 'number' ? event.output_index : 0;
          if (event.item.type === 'function_call') {
            const callId = typeof event.item.call_id === 'string' ? event.item.call_id : '';
            const name = typeof event.item.name === 'string' ? event.item.name : '';
            calls.set(index, { callId, name, arguments: '' });
            yield {
              type: 'tool_call_delta',
              index,
              ...(callId ? { id: callId } : {}),
              ...(name ? { name } : {})
            };
          }
          continue;
        }
        if (
          event.type === 'response.function_call_arguments.delta' &&
          typeof event.delta === 'string'
        ) {
          const index = typeof event.output_index === 'number' ? event.output_index : 0;
          const call = calls.get(index) ?? { callId: '', name: '', arguments: '' };
          call.arguments += event.delta;
          calls.set(index, call);
          yield { type: 'tool_call_delta', index, arguments: event.delta };
          continue;
        }
        if (event.type === 'response.function_call_arguments.done') {
          const index = typeof event.output_index === 'number' ? event.output_index : 0;
          const call = calls.get(index) ?? { callId: '', name: '', arguments: '' };
          if (typeof event.name === 'string') {
            call.name = event.name;
          }
          if (typeof event.arguments === 'string') {
            call.arguments = event.arguments;
          }
          calls.set(index, call);
          continue;
        }
        if (event.type === 'response.output_item.done' && isRecord(event.item)) {
          const index = typeof event.output_index === 'number' ? event.output_index : 0;
          if (event.item.type === 'function_call') {
            calls.set(index, {
              callId: typeof event.item.call_id === 'string' ? event.item.call_id : '',
              name: typeof event.item.name === 'string' ? event.item.name : '',
              arguments: typeof event.item.arguments === 'string' ? event.item.arguments : ''
            });
          }
          continue;
        }
        if (event.type === 'response.completed') {
          completedResponse = event.response;
          const completedUsage = toUsage(
            isRecord(event.response) ? event.response.usage : undefined
          );
          if (completedUsage) {
            usage = completedUsage;
            yield { type: 'usage', usage: completedUsage };
          }
          continue;
        }
        if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          throw this.responseFailure(event.response, event.type);
        }
        if (event.type === 'error') {
          throw new ProviderError(responseErrorCode(event.code), {
            provider: this.providerName,
            message: `${this.providerName} API Error: Responses stream reported ${String(event.code ?? 'unknown')}`
          });
        }
      }

      if (!completedResponse) {
        throw this.malformed('Provider stream ended before response.completed');
      }
      const parsed = this.parseCompletedResponse(completedResponse, requestId);
      const finalText = parsed.message.content;
      if (streamedText && finalText && streamedText !== finalText) {
        throw this.malformed('Streamed text did not match the completed response');
      }
      if (!streamedText && finalText) {
        yield { type: 'text_delta', text: finalText };
      }
      if (usage && !parsed.usage) {
        parsed.usage = usage;
      }
      return parsed;
    } catch (error: unknown) {
      if (attemptOptions.signal.aborted || isProviderAbort(error)) {
        throw error;
      }
      throw normalizeHeaderProviderError(error, this.providerName, this.headers);
    }
  }

  getInfo() {
    return {
      name: this.providerName,
      type: 'openai-responses',
      model: this.model,
      ...(this.modelContextWindows[this.model] === undefined
        ? {}
        : { contextWindowTokens: this.modelContextWindows[this.model] }),
      capabilities: { streaming: true, reasoningToggle: false }
    };
  }

  setModel(model: string): void {
    if (!model.trim()) {
      throw new Error('model must be a non-empty string');
    }
    this.model = model;
  }

  fork(): AIProvider {
    return new OpenAIResponsesProvider(
      this.apiKey,
      this.baseURL,
      this.model,
      this.providerName,
      this.modelContextWindows,
      this.headers
    );
  }

  private requestBody(request: ProviderChatRequest): Record<string, unknown> {
    return {
      model: this.model,
      instructions: request.systemPrompt,
      input: convertMessagesToResponses(request.messages),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      ...(request.tools.length ? { tools: convertToolsToResponses(request.tools) } : {}),
      ...(request.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
      include: ['reasoning.encrypted_content'],
      store: false
    };
  }

  private async createResponse(
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ response: unknown; requestId?: string }> {
    const requestPromise = this.client.responses.create(body as any, { signal }) as any;
    if (typeof requestPromise?.withResponse === 'function') {
      const result = await requestPromise.withResponse();
      return {
        response: result.data,
        ...(result.request_id ? { requestId: result.request_id } : {})
      };
    }
    const response = await requestPromise;
    return {
      response,
      ...(typeof response?._request_id === 'string' ? { requestId: response._request_id } : {})
    };
  }

  private parseCompletedResponse(response: unknown, requestId?: string): ProviderChatResponse {
    if (!isRecord(response)) {
      throw this.malformed('Provider returned an invalid response object');
    }
    if (response.status !== 'completed') {
      throw this.responseFailure(response, `response.${String(response.status ?? 'unknown')}`);
    }
    const content = responseText(response);
    const toolCalls = responseToolCalls(this.providerName, response);
    if (!content.trim() && toolCalls.length === 0) {
      throw this.malformed('Provider returned a completed response without text or tool calls');
    }
    const reasoningContent = toolCalls.length ? serializePrivateOutput(response.output) : undefined;
    return {
      message: {
        role: 'assistant',
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(reasoningContent ? { reasoningContent } : {})
      },
      finishReason: 'completed',
      usage: toUsage(response.usage),
      ...(requestId ? { requestId } : {}),
      ...(typeof response.model === 'string' ? { reportedModel: response.model } : {})
    };
  }

  private responseFailure(response: unknown, eventType: string): ProviderError {
    const record = isRecord(response) ? response : undefined;
    const error = isRecord(record?.error) ? record.error : undefined;
    const incomplete = isRecord(record?.incomplete_details) ? record.incomplete_details : undefined;
    const reason = error?.code ?? incomplete?.reason;
    return new ProviderError(responseErrorCode(reason), {
      provider: this.providerName,
      message: `${this.providerName} API Error: ${eventType} (${String(reason ?? 'unknown')})`
    });
  }

  private malformed(message: string): ProviderError {
    return new ProviderError('malformed_response', {
      provider: this.providerName,
      message: `${this.providerName} API Error: ${message}`
    });
  }
}
