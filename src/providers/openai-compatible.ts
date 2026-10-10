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

export function convertMessagesToOpenAI(
  messages: ConversationMessage[],
  systemPrompt: string
): Array<Record<string, unknown>> {
  const convertedMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt }
  ];

  for (const message of messages) {
    if (message.role === 'user') {
      convertedMessages.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      convertedMessages.push({
        role: 'assistant',
        content: message.content || null,
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.input)
                }
              }))
            }
          : {})
      });
      continue;
    }

    convertedMessages.push({
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
    });
  }

  return convertedMessages;
}

export function convertToolsToOpenAI(tools: ProviderTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function getReasoningContent(message: unknown, field = 'reasoning_content'): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const reasoningContent = (message as Record<string, unknown>)[field];
  return typeof reasoningContent === 'string' && reasoningContent ? reasoningContent : undefined;
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

function toUsage(
  usage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | null
    | undefined
): ProviderUsage | undefined {
  return usage
    ? {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      }
    : undefined;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

function supportsDeepSeekThinkingToggle(model: string): boolean {
  // A user-editable display name is not a protocol capability declaration.
  return model.toLowerCase().includes('deepseek');
}

function usesOpenCodeLingReasoning(baseURL: string, model: string): boolean {
  if (model !== 'ling-3.0-flash-fin-free') {
    return false;
  }
  try {
    const url = new URL(baseURL);
    return url.origin === 'https://opencode.ai' && url.pathname.replace(/\/+$/, '') === '/zen/v1';
  } catch {
    return false;
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private providerName: string;
  private supportsReasoningToggle: boolean;
  private reasoningToggleOverride: boolean | undefined;
  private readonly modelContextWindows: Readonly<Record<string, number>>;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly headers?: Readonly<Record<string, string>>;

  constructor(
    apiKey: string,
    baseURL: string,
    model: string,
    providerName: string = 'OpenAI',
    supportsReasoningToggle?: boolean,
    modelContextWindows: Readonly<Record<string, number>> = {},
    headers?: Readonly<Record<string, string>>
  ) {
    this.apiKey = apiKey;
    this.headers = validateProviderHeaders(headers);
    this.baseURL = baseURL;
    this.client = new OpenAI({
      apiKey,
      ...(this.headers ? { fetch: providerHeaderFetch(this.headers) } : {}),
      baseURL,
      maxRetries: 0,
      logLevel: 'off'
    });
    this.model = model;
    this.providerName = providerName;
    this.reasoningToggleOverride = supportsReasoningToggle;
    this.modelContextWindows = modelContextWindows;
    this.supportsReasoningToggle =
      supportsReasoningToggle ??
      (supportsDeepSeekThinkingToggle(model) || usesOpenCodeLingReasoning(baseURL, model));
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    try {
      const completionRequest: Record<string, unknown> = {
        model: this.model,
        messages: convertMessagesToOpenAI(request.messages, request.systemPrompt),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
        ...(request.tools.length > 0 ? { tools: convertToolsToOpenAI(request.tools) } : {}),
        ...(request.toolChoice === 'none' ? { tool_choice: 'none' } : {})
      };

      let completion = await this.createCompletion(completionRequest, request.signal);
      let response = completion.response;
      let requestId = completion.requestId;
      let choice = response.choices[0];
      if (!choice) {
        throw this.malformed('Provider returned no completion choices');
      }

      let message = choice.message;
      let content = message.content || '';
      let reasoningContent = getReasoningContent(message);

      // Keep the direct chat() compatibility contract. QueryEngine retries are
      // owned by Provider Runner and use chatStream() instead.
      if (!content.trim() && !message.tool_calls?.length) {
        const canRecover =
          this.supportsReasoningToggle &&
          choice.finish_reason === 'stop' &&
          (reasoningContent !== undefined ||
            (usesOpenCodeLingReasoning(this.baseURL, this.model) &&
              getReasoningContent(message, 'reasoning') !== undefined));
        if (!canRecover) {
          throw this.malformed(
            getReasoningContent(message, 'reasoning')
              ? `Provider returned only reasoning, without answer text or tool calls (model: ${this.model}; finish reason: ${choice.finish_reason ?? 'unknown'})`
              : `Provider returned an empty response (finish reason: ${choice.finish_reason ?? 'unknown'})`
          );
        }

        completion = await this.createCompletion(
          {
            ...completionRequest,
            ...this.disabledReasoningParameters()
          },
          request.signal
        );
        response = completion.response;
        requestId = completion.requestId;
        choice = response.choices[0];
        if (!choice) {
          throw this.malformed(
            'Provider returned no completion choices after one recovery attempt'
          );
        }

        message = choice.message;
        content = message.content || '';
        reasoningContent = getReasoningContent(message);
        if (!content.trim() && !message.tool_calls?.length) {
          throw this.malformed(
            `Provider returned an empty response after one recovery attempt (finish reason: ${choice.finish_reason ?? 'unknown'})`
          );
        }
      }

      const toolCalls = this.parseCompleteToolCalls(message.tool_calls ?? []);
      return {
        message: {
          role: 'assistant',
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoningContent: toolCalls.length > 0 ? reasoningContent : undefined
        },
        finishReason: choice.finish_reason,
        usage: toUsage(response.usage),
        ...(requestId ? { requestId } : {}),
        ...(typeof response.model === 'string' ? { reportedModel: response.model } : {})
      };
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
      const completionRequest: Record<string, unknown> = {
        model: this.model,
        messages: convertMessagesToOpenAI(request.messages, request.systemPrompt),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
        ...(request.tools.length > 0 ? { tools: convertToolsToOpenAI(request.tools) } : {}),
        ...(request.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
        stream: true,
        ...(attemptOptions.includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(attemptOptions.disableReasoning ? this.disabledReasoningParameters() : {})
      };

      const requestPromise = this.client.chat.completions.create(completionRequest as any, {
        signal: attemptOptions.signal
      }) as any;
      let stream: AsyncIterable<any>;
      let requestId: string | undefined;

      if (typeof requestPromise?.withResponse === 'function') {
        const result = await requestPromise.withResponse();
        stream = result.data;
        requestId = result.request_id ?? undefined;
      } else {
        stream = await requestPromise;
      }

      let content = '';
      let reasoningContent = '';
      let gatewayReasoningSeen = false;
      let finishReason: string | null | undefined;
      let usage: ProviderUsage | undefined;
      let reportedModel: string | undefined;
      const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

      for await (const chunk of stream) {
        if (!reportedModel && typeof chunk.model === 'string') {
          reportedModel = chunk.model;
        }

        const chunkUsage = toUsage(chunk.usage);
        if (chunkUsage) {
          usage = chunkUsage;
          yield { type: 'usage', usage: chunkUsage };
        }

        const choice = chunk.choices?.[0];
        if (!choice) {
          continue;
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta ?? {};
        const reasoningDelta = getReasoningContent(delta);
        if (reasoningDelta) {
          reasoningContent += reasoningDelta;
          yield { type: 'reasoning_delta', text: reasoningDelta };
        } else {
          const gatewayReasoning = getReasoningContent(delta, 'reasoning');
          if (gatewayReasoning) {
            gatewayReasoningSeen = true;
            // Activity only: do not expose as an answer or replay under a different wire field.
            yield { type: 'reasoning_delta', text: gatewayReasoning };
          }
        }

        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }

        for (const fragment of delta.tool_calls ?? []) {
          const index = typeof fragment.index === 'number' ? fragment.index : 0;
          const accumulator = toolCallAccumulators.get(index) ?? {
            id: '',
            name: '',
            arguments: ''
          };
          const id = typeof fragment.id === 'string' ? fragment.id : undefined;
          const name =
            typeof fragment.function?.name === 'string' ? fragment.function.name : undefined;
          const argumentsFragment =
            typeof fragment.function?.arguments === 'string'
              ? fragment.function.arguments
              : undefined;

          if (id) {
            accumulator.id += id;
          }
          if (name) {
            accumulator.name += name;
          }
          if (argumentsFragment) {
            accumulator.arguments += argumentsFragment;
          }
          toolCallAccumulators.set(index, accumulator);
          yield {
            type: 'tool_call_delta',
            index,
            ...(id ? { id } : {}),
            ...(name ? { name } : {}),
            ...(argumentsFragment ? { arguments: argumentsFragment } : {})
          };
        }
      }

      const toolCalls = [...toolCallAccumulators.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, toolCall]) => {
          if (!toolCall.id || !toolCall.name) {
            throw this.malformed('Provider returned an incomplete tool call');
          }
          return {
            id: toolCall.id,
            name: toolCall.name,
            input: parseToolArguments(this.providerName, toolCall.name, toolCall.arguments)
          };
        });

      if (!content.trim() && toolCalls.length === 0 && !reasoningContent) {
        throw this.malformed(
          gatewayReasoningSeen
            ? `Provider returned only reasoning, without answer text or tool calls (model: ${this.model}; finish reason: ${finishReason ?? 'unknown'})`
            : `Provider returned an empty stream (finish reason: ${finishReason ?? 'unknown'}; model: ${this.model})`,
          gatewayReasoningSeen &&
            finishReason === 'stop' &&
            this.supportsReasoningToggle &&
            !attemptOptions.disableReasoning &&
            usesOpenCodeLingReasoning(this.baseURL, this.model)
            ? 'reasoning-only'
            : undefined
        );
      }
      if (finishReason === undefined) {
        // Some OpenAI-compatible gateways end a successful stream after a
        // final usage packet without emitting finish_reason. Usage is strong
        // completion evidence; a clean EOF without it remains fail-closed.
        if (usage) {
          finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
        } else {
          throw this.malformed('Provider stream ended before a finish reason was received');
        }
      }

      return {
        message: {
          role: 'assistant',
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          ...(reasoningContent ? { reasoningContent } : {})
        },
        finishReason,
        usage,
        ...(requestId ? { requestId } : {}),
        ...(reportedModel ? { reportedModel } : {})
      };
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
      type: 'openai-compatible',
      model: this.model,
      ...(this.modelContextWindows[this.model] === undefined
        ? {}
        : { contextWindowTokens: this.modelContextWindows[this.model] }),
      capabilities: {
        streaming: true,
        reasoningToggle: this.supportsReasoningToggle
      }
    };
  }

  setModel(model: string): void {
    if (!model.trim()) {
      throw new Error('model must be a non-empty string');
    }
    this.model = model;
    this.supportsReasoningToggle =
      this.reasoningToggleOverride ??
      (supportsDeepSeekThinkingToggle(model) || usesOpenCodeLingReasoning(this.baseURL, model));
  }

  fork(): AIProvider {
    return new OpenAICompatibleProvider(
      this.apiKey,
      this.baseURL,
      this.model,
      this.providerName,
      this.reasoningToggleOverride,
      this.modelContextWindows,
      this.headers
    );
  }

  private async createCompletion(
    request: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ response: any; requestId?: string }> {
    const requestPromise = this.client.chat.completions.create(request as any, { signal }) as any;
    if (typeof requestPromise?.withResponse === 'function') {
      const result = await requestPromise.withResponse();
      return {
        response: result.data,
        ...(result.request_id ? { requestId: result.request_id } : {})
      };
    }

    const response = await requestPromise;
    const responseRequestId =
      typeof response?._request_id === 'string' ? response._request_id : undefined;
    return {
      response,
      ...(responseRequestId ? { requestId: responseRequestId } : {})
    };
  }

  private parseCompleteToolCalls(toolCalls: any[]): ToolCall[] {
    const parsedToolCalls: ToolCall[] = [];
    for (const toolCall of toolCalls) {
      if (toolCall.type === 'function' && toolCall.function) {
        parsedToolCalls.push({
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(
            this.providerName,
            toolCall.function.name,
            toolCall.function.arguments
          )
        });
      }
    }
    return parsedToolCalls;
  }

  private disabledReasoningParameters(): Record<string, unknown> {
    // Gateway-specific wire parameters are not interchangeable with DeepSeek's thinking field.
    return usesOpenCodeLingReasoning(this.baseURL, this.model)
      ? { reasoning: { enabled: false } }
      : { thinking: { type: 'disabled' } };
  }

  private malformed(message: string, recovery?: 'reasoning-only'): ProviderError {
    return new ProviderError('malformed_response', {
      provider: this.providerName,
      ...(recovery ? { recovery } : {}),
      message: `${this.providerName} API Error: ${message}`
    });
  }
}
