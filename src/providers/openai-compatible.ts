import OpenAI from 'openai';
import type {
  AIProvider,
  ConversationMessage,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderTool,
  ToolCall
} from './base.js';

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
        ...(message.reasoningContent
          ? { reasoning_content: message.reasoningContent }
          : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map(toolCall => ({
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
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function parseToolArguments(toolName: string, rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Tool ${toolName} returned invalid JSON arguments: ${reason}`);
  }
}

function getReasoningContent(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const reasoningContent = (message as Record<string, unknown>).reasoning_content;
  return typeof reasoningContent === 'string' && reasoningContent.trim()
    ? reasoningContent
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private providerName: string;

  constructor(apiKey: string, baseURL: string, model: string, providerName: string = 'OpenAI') {
    this.client = new OpenAI({
      apiKey,
      baseURL
    });
    this.model = model;
    this.providerName = providerName;
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    try {
      const completionRequest: Record<string, unknown> = {
        model: this.model,
        messages: convertMessagesToOpenAI(request.messages, request.systemPrompt),
        tools: convertToolsToOpenAI(request.tools)
      };

      let response = await this.client.chat.completions.create(
        completionRequest as any,
        { signal: request.signal }
      );

      let choice = response.choices[0];
      if (!choice) {
        throw new Error('Provider returned no completion choices');
      }

      let message = choice.message;
      let content = message.content || '';
      let reasoningContent = getReasoningContent(message);

      if (!content.trim() && !message.tool_calls?.length) {
        const canRecover = choice.finish_reason === 'stop' && reasoningContent !== undefined;
        if (!canRecover) {
          throw new Error(
            `Provider returned an empty response (finish reason: ${choice.finish_reason ?? 'unknown'})`
          );
        }

        try {
          response = await this.client.chat.completions.create(
            {
              ...completionRequest,
              thinking: { type: 'disabled' }
            } as any,
            { signal: request.signal }
          );
        } catch (error) {
          if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            throw error;
          }
          throw new Error(
            `Provider returned only reasoning content, and recovery with thinking disabled failed: ${getErrorMessage(error)}`
          );
        }

        choice = response.choices[0];
        if (!choice) {
          throw new Error('Provider returned no completion choices after one recovery attempt');
        }

        message = choice.message;
        content = message.content || '';
        reasoningContent = getReasoningContent(message);
        if (!content.trim() && !message.tool_calls?.length) {
          throw new Error(
            `Provider returned an empty response after one recovery attempt (finish reason: ${choice.finish_reason ?? 'unknown'})`
          );
        }
      }

      const toolCalls: ToolCall[] = [];
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.type === 'function' && 'function' in toolCall) {
          toolCalls.push({
            id: toolCall.id,
            name: toolCall.function.name,
            input: parseToolArguments(toolCall.function.name, toolCall.function.arguments)
          });
        }
      }

      if (!content.trim() && toolCalls.length === 0) {
        throw new Error(
          `Provider returned no usable content or function tool calls (finish reason: ${choice.finish_reason ?? 'unknown'})`
        );
      }

      return {
        message: {
          role: 'assistant',
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoningContent: toolCalls.length > 0 ? reasoningContent : undefined
        },
        finishReason: choice.finish_reason,
        usage: response.usage ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens
        } : undefined
      };
    } catch (error: unknown) {
      if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      throw new Error(`${this.providerName} API Error: ${getErrorMessage(error)}`);
    }
  }

  getInfo() {
    return {
      name: this.providerName,
      type: 'openai-compatible'
    };
  }
}
