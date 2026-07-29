import Anthropic from '@anthropic-ai/sdk';
import type {
  AIProvider,
  ConversationMessage,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderTool,
  ToolCall
} from './base.js';
import {
  isProviderAbort,
  normalizeProviderError,
  ProviderError
} from './errors.js';

export function convertMessagesToAnthropic(
  messages: ConversationMessage[]
): Array<Record<string, unknown>> {
  const convertedMessages: Array<Record<string, unknown>> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

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

    const contentBlocks: Array<Record<string, unknown>> = [];
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

export function convertToolsToAnthropic(tools: ProviderTool[]): Array<Record<string, unknown>> {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private readonly modelContextWindows: Readonly<Record<string, number>>;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(
    apiKey: string,
    baseURL: string,
    model: string,
    modelContextWindows: Readonly<Record<string, number>> = {}
  ) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.client = new Anthropic({
      apiKey,
      baseURL,
      maxRetries: 0
    });
    this.model = model;
    this.modelContextWindows = modelContextWindows;
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    try {
      const requestPromise = this.client.messages.create(
        {
          model: this.model,
          max_tokens: 8192,
          system: request.systemPrompt,
          messages: convertMessagesToAnthropic(request.messages) as any,
          tools: convertToolsToAnthropic(request.tools) as any
        },
        { signal: request.signal }
      );
      let response;
      let requestId: string | undefined;
      if (typeof requestPromise.withResponse === 'function') {
        const result = await requestPromise.withResponse();
        response = result.data;
        requestId = result.response.headers.get('request-id') ??
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
        usage: response.usage ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens
        } : undefined,
        ...(requestId ? { requestId } : {}),
        ...(typeof response.model === 'string' ? { reportedModel: response.model } : {})
      };
    } catch (error: unknown) {
      if (request.signal?.aborted || isProviderAbort(error)) {
        throw error;
      }
      throw normalizeProviderError(error, 'Anthropic Claude');
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
        streaming: false,
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
      this.modelContextWindows
    );
  }
}
