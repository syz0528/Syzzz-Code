import type { Tool } from './types.js';
import { getCurrentProviderConfig } from './config.js';
import { createProvider } from './providers/factory.js';
import type {
  AIProvider,
  ConversationMessage,
  ProviderTool,
  ToolResultMessage
} from './providers/base.js';
import { allTools } from './tools/index.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_RESULT_CHARACTERS = 100_000;

export interface QueryEngineOptions {
  provider?: AIProvider;
  tools?: Tool[];
  announceProvider?: boolean;
}

export class QueryEngine {
  private provider: AIProvider;
  private messages: ConversationMessage[] = [];
  private tools: Tool[];
  private isProcessing = false;

  constructor(options: QueryEngineOptions = {}) {
    this.tools = options.tools ?? allTools;

    if (options.provider) {
      this.provider = options.provider;
      return;
    }

    const providerConfig = getCurrentProviderConfig();
    
    // 检查 API Key
    if (!providerConfig.env.API_KEY) {
      throw new Error(
        `No API key found for provider: ${providerConfig.name}\n\n` +
        `Set your API key:\n` +
        `  syzzz config set apiKey YOUR_KEY\n`
      );
    }
    
    // 创建 Provider
    try {
      this.provider = createProvider(providerConfig);
      if (options.announceProvider !== false) {
        console.log(`✓ Using ${providerConfig.name} (${providerConfig.model})`);
      }
    } catch (error: any) {
      throw new Error(`Failed to initialize provider: ${error.message}`);
    }
    
  }

  async chat(userMessage: string): Promise<string> {
    if (this.isProcessing) {
      throw new Error('Another message is still being processed');
    }

    this.isProcessing = true;
    const workingMessages: ConversationMessage[] = [
      ...this.messages,
      {
      role: 'user',
      content: userMessage
      }
    ];

    const responseParts: string[] = [];
    const providerTools: ProviderTool[] = this.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema
    }));

    try {
      for (let toolRound = 0; toolRound <= MAX_TOOL_ROUNDS; toolRound++) {
        const response = await this.provider.chat({
          messages: workingMessages,
          tools: providerTools,
          systemPrompt: this.getSystemPrompt()
        });

        workingMessages.push(response.message);
        if (response.message.content.trim()) {
          responseParts.push(response.message.content.trim());
        }

        const toolCalls = response.message.toolCalls ?? [];
        if (toolCalls.length === 0) {
          this.messages = workingMessages;
          return responseParts.join('\n\n');
        }

        if (toolRound === MAX_TOOL_ROUNDS) {
          throw new Error(`Tool call limit exceeded (${MAX_TOOL_ROUNDS} rounds)`);
        }

        for (const toolCall of toolCalls) {
          workingMessages.push(await this.executeToolCall(toolCall.id, toolCall.name, toolCall.input));
        }
      }

      throw new Error('Chat ended without a final response');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Chat error: ${reason}`);
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeToolCall(toolCallId: string, toolName: string, input: unknown): Promise<ToolResultMessage> {
    const tool = this.tools.find(candidate => candidate.name === toolName);
    if (!tool) {
      return {
        role: 'tool',
        toolCallId,
        toolName,
        content: `Unknown tool: ${toolName}`,
        isError: true
      };
    }

    console.log(`\n[Tool: ${toolName}]`);

    try {
      const rawResult = await tool.execute(input);
      return {
        role: 'tool',
        toolCallId,
        toolName,
        content: this.truncateToolResult(rawResult)
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        role: 'tool',
        toolCallId,
        toolName,
        content: reason,
        isError: true
      };
    }
  }

  private truncateToolResult(result: string): string {
    if (result.length <= MAX_TOOL_RESULT_CHARACTERS) {
      return result;
    }

    return `${result.slice(0, MAX_TOOL_RESULT_CHARACTERS)}\n\n[Output truncated]`;
  }

  private getSystemPrompt(): string {
    return `You are Syzzz Code, an AI programming assistant.

Help developers write, debug, and understand code. Use the available tools when needed.

Rules:
1. Read existing files before editing them.
2. Prefer precise edits over replacing entire files.
3. Run relevant checks after making changes.
4. Never claim a tool succeeded unless its result confirms success.

Current working directory: ${process.cwd()}`;
  }

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  clearMessages(): void {
    this.messages = [];
  }
}
