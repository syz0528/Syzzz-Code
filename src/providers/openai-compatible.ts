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
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: convertMessagesToOpenAI(request.messages, request.systemPrompt) as any,
        tools: convertToolsToOpenAI(request.tools) as any
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error('Provider returned no completion choices');
      }

      const message = choice.message;
      const content = message.content || '';

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
        throw new Error(`Provider returned an empty response (finish reason: ${choice.finish_reason ?? 'unknown'})`);
      }

      return {
        message: {
          role: 'assistant',
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        },
        finishReason: choice.finish_reason,
        usage: response.usage ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens
        } : undefined
      };
    } catch (error: any) {
      throw new Error(`${this.providerName} API Error: ${error.message}`);
    }
  }

  getInfo() {
    return {
      name: this.providerName,
      type: 'openai-compatible'
    };
  }
}
