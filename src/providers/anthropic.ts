import Anthropic from '@anthropic-ai/sdk';
import type {
  AIProvider,
  ConversationMessage,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderAttemptOptions,
  ProviderDelta,
  ProviderTool,
  ToolCall
} from './base.js';
import { isProviderAbort, ProviderError } from './errors.js';
import {
  validateProviderHeaders,
  providerHeaderFetch,
  normalizeHeaderProviderError
} from './headers.js';
import { throwIfAborted } from '../tools/abort.js';

interface StreamBlock {
  type: string;
  closed: boolean;
  id?: string;
  name?: string;
  input?: unknown;
  json: string;
}

export function convertMessagesToAnthropic(
  messages: ConversationMessage[]
): Anthropic.MessageParam[] {
  const convertedMessages: Anthropic.MessageParam[] = [];
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) {
      return;
    }

    convertedMessages.push({
      role: 'user',
      content: pendingToolResults
    });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {})
      });
      continue;
    }

    flushToolResults();

    if (message.role === 'user') {
      convertedMessages.push({ role: 'user', content: message.content });
      continue;
    }

    const contentBlocks: Anthropic.ContentBlockParam[] = [];
    if (message.content) {
      contentBlocks.push({ type: 'text', text: message.content });
    }
    for (const toolCall of message.toolCalls ?? []) {
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input
      });
    }

    convertedMessages.push({ role: 'assistant', content: contentBlocks });
  }

  flushToolResults();
  return convertedMessages;
}

export function convertToolsToAnthropic(tools: ProviderTool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

function normalizeAnthropicBaseURL(baseURL: string): string {
  const url = new URL(baseURL);
  // The Anthropic SDK appends /v1/messages, unlike OpenAI SDK base paths.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/messages)?$/, '');
  return url.toString().replace(/\/$/, '');
}

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private readonly modelContextWindows: Readonly<Record<string, number>>;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly headers?: Readonly<Record<string, string>>;

  constructor(
    apiKey: string,
    baseURL: string,
    model: string,
    modelContextWindows: Readonly<Record<string, number>> = {},
    headers?: Readonly<Record<string, string>>
  ) {
    this.apiKey = apiKey;
    this.headers = validateProviderHeaders(headers);
    this.baseURL = normalizeAnthropicBaseURL(baseURL);
    this.client = new Anthropic({
      apiKey,
      ...(this.headers ? { fetch: providerHeaderFetch(this.headers) } : {}),
      baseURL: this.baseURL,
      maxRetries: 0,
      // SDK debug logs can contain prompts, tool arguments and custom credentials.
      logLevel: 'off'
    });
    this.model = model;
    this.modelContextWindows = modelContextWindows;
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    try {
      const requestPromise = this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens ?? 8192,
          system: request.systemPrompt,
          messages: convertMessagesToAnthropic(request.messages),
          ...(request.stopSequences?.length ? { stop_sequences: request.stopSequences } : {}),
          ...(request.tools.length ? { tools: convertToolsToAnthropic(request.tools) } : {})
        },
        { signal: request.signal }
      );
      let response;
      let requestId: string | undefined;
      if (typeof requestPromise.withResponse === 'function') {
        const result = await requestPromise.withResponse();
        response = result.data;
        requestId =
          result.response.headers.get('request-id') ??
          result.response.headers.get('x-request-id') ??
          undefined;
      } else {
        response = await requestPromise;
      }

      let content = '';
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input
          });
        }
      }

      if (!content.trim() && toolCalls.length === 0) {
        throw new ProviderError('malformed_response', {
          provider: 'Anthropic Claude',
          message: `Anthropic API Error: Provider returned an empty response (stop reason: ${response.stop_reason ?? 'unknown'})`
        });
      }

      return {
        message: {
          role: 'assistant',
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        },
        finishReason: response.stop_reason,
        usage: response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.input_tokens + response.usage.output_tokens
            }
          : undefined,
        ...(requestId ? { requestId } : {}),
        ...(typeof response.model === 'string' ? { reportedModel: response.model } : {})
      };
    } catch (error: unknown) {
      if (request.signal?.aborted || isProviderAbort(error)) {
        throw error;
      }
      throw normalizeHeaderProviderError(error, 'Anthropic Claude', this.headers);
    }
  }

  async *chatStream(
    request: ProviderChatRequest,
    attemptOptions: ProviderAttemptOptions
  ): AsyncGenerator<ProviderDelta, ProviderChatResponse> {
    const signal = attemptOptions.signal;
    const malformed = (detail: string) =>
      new ProviderError('malformed_response', {
        provider: 'Anthropic Claude',
        message: `Anthropic API Error: ${detail}`
      });
    let closeStream: (() => void) | undefined;
    try {
      throwIfAborted(signal);
      const result = await this.client.messages
        .create(
          {
            model: this.model,
            max_tokens: request.maxOutputTokens ?? 8192,
            system: request.systemPrompt,
            messages: convertMessagesToAnthropic(request.messages),
            ...(request.tools.length ? { tools: convertToolsToAnthropic(request.tools) } : {}),
            ...(request.stopSequences?.length ? { stop_sequences: request.stopSequences } : {}),
            stream: true
          },
          { signal }
        )
        .withResponse();
      closeStream = () => result.data.controller.abort();
      const requestId =
        result.response.headers.get('request-id') ??
        result.response.headers.get('x-request-id') ??
        undefined;
      let started = false;
      let stopped = false;
      let finishReason: string | null = null;
      let reportedModel: string | undefined;
      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      const blocks = new Map<number, StreamBlock>();
      const toolIds = new Set<string>();
      const toolCalls: ToolCall[] = [];
      for await (const event of result.data) {
        throwIfAborted(signal);
        if (event.type === 'message_start') {
          if (started) throw malformed('Duplicate message_start');
          started = true;
          reportedModel = event.message.model;
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens;
          continue;
        }
        if (!started) throw malformed('Stream event preceded message_start');
        switch (event.type) {
          case 'content_block_start': {
            if (
              !Number.isInteger(event.index) ||
              event.index < 0 ||
              blocks.has(event.index) ||
              finishReason
            ) {
              throw malformed('Invalid content block start');
            }
            const block = event.content_block;
            const state: StreamBlock = { type: block.type, closed: false, json: '' };
            blocks.set(event.index, state);
            if (block.type === 'tool_use') {
              if (!block.id || !block.name || toolIds.has(block.id))
                throw malformed('Invalid tool identity');
              toolIds.add(block.id);
              Object.assign(state, { id: block.id, name: block.name, input: block.input });
              yield { type: 'tool_call_delta', index: event.index, id: block.id, name: block.name };
            } else if (block.type === 'text' && block.text) {
              content += block.text;
              yield { type: 'text_delta', text: block.text };
            }
            break;
          }
          case 'content_block_delta': {
            const block = blocks.get(event.index);
            if (!block || block.closed)
              throw malformed('Delta for missing or closed content block');
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              if (block.type !== 'text') throw malformed('Text delta has incompatible block type');
              content += delta.text;
              if (delta.text) yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'input_json_delta') {
              if (block.type !== 'tool_use')
                throw malformed('Tool delta has incompatible block type');
              block.json += delta.partial_json;
              yield { type: 'tool_call_delta', index: event.index, arguments: delta.partial_json };
            } else if (delta.type === 'thinking_delta') {
              // Runtime exposes only activity/counts, never raw reasoning in display or audit.
              if (delta.thinking) yield { type: 'reasoning_delta', text: delta.thinking };
            }
            break;
          }
          case 'content_block_stop': {
            const block = blocks.get(event.index);
            if (!block || block.closed) throw malformed('Stop for missing or closed content block');
            block.closed = true;
            if (block.type === 'tool_use') {
              let input: unknown;
              try {
                input = block.json ? JSON.parse(block.json) : block.input;
              } catch {
                throw malformed('Invalid tool argument JSON');
              }
              if (!input || typeof input !== 'object' || Array.isArray(input))
                throw malformed('Tool arguments must be an object');
              if (!block.id || !block.name) throw malformed('Missing tool identity');
              toolCalls.push({ id: block.id, name: block.name, input });
            }
            break;
          }
          case 'message_delta':
            finishReason = event.delta.stop_reason ?? finishReason;
            // Anthropic message_delta usage is cumulative, not an increment.
            inputTokens = event.usage.input_tokens ?? inputTokens;
            outputTokens = event.usage.output_tokens ?? outputTokens;
            break;
          case 'message_stop':
            stopped = true;
            break;
        }
        if (stopped) break;
      }
      throwIfAborted(signal);
      if (!stopped || !finishReason || [...blocks.values()].some((block) => !block.closed)) {
        throw malformed('Stream ended without a complete message_stop and finish reason');
      }
      if (!content.trim() && !toolCalls.length)
        throw malformed('Stream returned no answer text or tool calls');
      const hasToolCalls = toolCalls.length > 0;
      if (hasToolCalls !== (finishReason === 'tool_use'))
        throw malformed('Tool calls do not match finish reason');
      if (
        ![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
      ) {
        throw malformed('Invalid token usage');
      }
      const usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
      yield { type: 'usage', usage };
      return {
        message: { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) },
        finishReason,
        usage,
        ...(requestId ? { requestId } : {}),
        ...(reportedModel ? { reportedModel } : {})
      };
    } catch (error) {
      if (signal.aborted || isProviderAbort(error)) throw error;
      throw normalizeHeaderProviderError(error, 'Anthropic Claude', this.headers);
    } finally {
      // Also releases the HTTP body when the consumer closes the generator early.
      closeStream?.();
    }
  }

  getInfo() {
    return {
      name: 'Anthropic Claude',
      type: 'anthropic',
      model: this.model,
      ...(this.modelContextWindows[this.model] === undefined
        ? {}
        : { contextWindowTokens: this.modelContextWindows[this.model] }),
      capabilities: {
        streaming: true,
        reasoningToggle: false
      }
    };
  }

  setModel(model: string): void {
    if (!model.trim()) {
      throw new Error('model must be a non-empty string');
    }
    this.model = model;
  }

  fork(): AIProvider {
    return new AnthropicProvider(
      this.apiKey,
      this.baseURL,
      this.model,
      this.modelContextWindows,
      this.headers
    );
  }
}
