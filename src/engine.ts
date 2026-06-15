import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import type { Message, Tool, ContentBlock } from './types.js';
import { getApiKey, loadConfig } from './config.js';
import { allTools } from './tools/index.js';

export class QueryEngine {
  private client: Anthropic | null = null;
  private useClaudeCode: boolean = false;
  private messages: Message[] = [];
  private tools: Tool[];

  constructor() {
    const apiKey = getApiKey();
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    
    // 如果没有 API Key，尝试使用 Claude Code
    if (!apiKey) {
      try {
        const result = execSync('claude auth status', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
        const authStatus = JSON.parse(result);
        if (authStatus.loggedIn) {
          this.useClaudeCode = true;
          console.log('✓ Using Claude Code authentication (fallback mode)');
        } else {
          throw new Error('No API key found and Claude Code not logged in');
        }
      } catch {
        throw new Error('No API key found. Set ANTHROPIC_API_KEY or run: syzzz config set apiKey YOUR_KEY');
      }
    } else {
      const options: any = { apiKey };
      if (baseURL) {
        options.baseURL = baseURL;
        console.log(`✓ Using Syzzz Code with custom API: ${baseURL}`);
      }
      this.client = new Anthropic(options);
    }
    
    this.tools = allTools;
  }

  async chat(userMessage: string, interactive: boolean = false): Promise<string> {
    // 如果使用 Claude Code 且是交互模式，提示用户使用单次命令
    if (this.useClaudeCode && interactive) {
      throw new Error('Interactive mode with Claude Code auth not supported. Use: node dist/index.js chat -m "your message"');
    }
    
    // 单次消息模式可以使用 Claude Code
    if (this.useClaudeCode && !interactive) {
      return this.chatViaClaudeCode(userMessage);
    }
    
    if (!this.client) {
      throw new Error('API client not initialized');
    }
    
    this.messages.push({
      role: 'user',
      content: userMessage
    });

    let response = '';
    const config = loadConfig();

    while (true) {
      const result = await this.client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        messages: this.messages as any,
        tools: this.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema
        })),
        system: this.getSystemPrompt()
      });

      const assistantMessage: Message = {
        role: 'assistant',
        content: result.content as any
      };
      this.messages.push(assistantMessage);

      let hasToolUse = false;
      const toolResults: ContentBlock[] = [];

      for (const block of result.content) {
        if (block.type === 'text') {
          response += block.text;
        } else if (block.type === 'tool_use') {
          hasToolUse = true;
          const tool = this.tools.find(t => t.name === block.name);
          if (tool) {
            console.log(`\n[Tool: ${block.name}]`);
            const result = await tool.execute(block.input);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result
            });
          }
        }
      }

      if (hasToolUse && toolResults.length > 0) {
        this.messages.push({
          role: 'user',
          content: toolResults
        });
        continue;
      }

      if (result.stop_reason === 'end_turn' || result.stop_reason === 'stop_sequence') {
        break;
      }
    }

    return response;
  }

  private chatViaClaudeCode(userMessage: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        // 调用 Claude Code 作为后端引擎
        const result = execSync(`echo "${userMessage.replace(/"/g, '\\"')}" | claude chat --bare --permission-mode=auto`, {
          encoding: 'utf-8',
          cwd: process.cwd(),
          maxBuffer: 10 * 1024 * 1024
        });
        resolve(result.trim());
      } catch (error: any) {
        reject(error);
      }
    });
  }

  private getSystemPrompt(): string {
    return `You are Syzzz Code, an AI programming assistant.

You help developers write, debug, and understand code. You have access to tools for:
- Shell: Execute commands
- Read: Read files
- Write: Create/overwrite files
- Edit: Modify existing files

Be concise and direct. When making code changes:
1. Read files before editing
2. Use Edit for modifications, Write for new files
3. Execute tests/builds to verify changes

Current directory: ${process.cwd()}`;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  clearMessages(): void {
    this.messages = [];
  }
}
