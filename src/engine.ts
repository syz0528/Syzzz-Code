import type {
  ToolApprovalDetails,
  ToolApprovalChoice,
  ToolApprovalHandler,
  ToolContext,
  ToolDefinition
} from './types.js';
import { getCurrentProviderConfig } from './config.js';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode
} from './permissions/mode.js';
import { requiresUserApproval } from './permissions/policy.js';
import { createProvider } from './providers/factory.js';
import type {
  AIProvider,
  ConversationMessage,
  ProviderTool,
  ToolResultMessage
} from './providers/base.js';
import { allTools } from './tools/index.js';
import { isAbortError, OperationAbortedError, throwIfAborted } from './tools/abort.js';
import {
  convertToolSchemaToJsonSchema,
  validateToolInput
} from './tools/runtime.js';
import { resolveShellInvocation } from './tools/shell-runner.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_RESULT_CHARACTERS = 100_000;

const BASIC_APPROVAL_CHOICES: readonly ToolApprovalChoice[] = Object.freeze([
  'allow-once',
  'deny'
]);
const WRITE_APPROVAL_CHOICES: readonly ToolApprovalChoice[] = Object.freeze([
  'allow-once',
  'allow-edits-session',
  'deny'
]);

function approvalChoicesForTool(
  tool: Pick<ToolDefinition, 'name' | 'risk'>
): readonly ToolApprovalChoice[] {
  return tool.risk === 'write' && (tool.name === 'Write' || tool.name === 'Edit')
    ? WRITE_APPROVAL_CHOICES
    : BASIC_APPROVAL_CHOICES;
}

function isOfferedApprovalChoice(
  value: unknown,
  choices: readonly ToolApprovalChoice[]
): value is ToolApprovalChoice {
  return typeof value === 'string' && choices.includes(value as ToolApprovalChoice);
}

export interface QueryEngineOptions {
  provider?: AIProvider;
  tools?: ToolDefinition[];
  workspaceRoot?: string;
  announceProvider?: boolean;
  permissionMode?: PermissionMode;
}

export interface ChatOptions {
  signal?: AbortSignal;
  requestApproval?: ToolApprovalHandler;
}

export class QueryEngine {
  private provider: AIProvider;
  private messages: ConversationMessage[] = [];
  private tools: ToolDefinition[];
  private workspaceRoot: string;
  private isProcessing = false;
  private permissionMode: PermissionMode;

  constructor(options: QueryEngineOptions = {}) {
    this.tools = options.tools ?? allTools;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;

    if (options.provider) {
      this.provider = options.provider;
      return;
    }

    const providerConfig = getCurrentProviderConfig();

    if (!providerConfig.env.API_KEY) {
      throw new Error(
        `No API key found for provider: ${providerConfig.name}\n\n` +
        `Set your API key:\n` +
        `  syzzz config set apiKey YOUR_KEY\n`
      );
    }

    try {
      this.provider = createProvider(providerConfig);
      if (options.announceProvider !== false) {
        console.log(`✓ Using ${providerConfig.name} (${providerConfig.model})`);
      }
    } catch (error: any) {
      throw new Error(`Failed to initialize provider: ${error.message}`);
    }
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  async chat(userMessage: string, options: ChatOptions = {}): Promise<string> {
    const signal = options.signal ?? new AbortController().signal;
    throwIfAborted(signal);

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
      inputSchema: convertToolSchemaToJsonSchema(tool)
    }));

    try {
      for (let toolRound = 0; toolRound <= MAX_TOOL_ROUNDS; toolRound++) {
        throwIfAborted(signal);
        const response = await this.provider.chat({
          messages: workingMessages,
          tools: providerTools,
          systemPrompt: this.getSystemPrompt(),
          signal
        });
        throwIfAborted(signal);

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
          throwIfAborted(signal);
          workingMessages.push(await this.executeToolCall(
            toolCall.id,
            toolCall.name,
            toolCall.input,
            signal,
            options.requestApproval
          ));
        }
      }

      throw new Error('Chat ended without a final response');
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw isAbortError(error) ? error : new OperationAbortedError();
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Chat error: ${reason}`);
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
    requestApproval?: ToolApprovalHandler
  ): Promise<ToolResultMessage> {
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

    const validationResult = validateToolInput(tool, input);
    if (!validationResult.success) {
      return {
        role: 'tool',
        toolCallId,
        toolName,
        content: validationResult.message,
        isError: true
      };
    }

    const baseContext: ToolContext = {
      toolCallId,
      workspaceRoot: this.workspaceRoot,
      workingDirectory: this.workspaceRoot,
      signal
    };

    try {
      throwIfAborted(signal);
      let executionContext = baseContext;
      const needsUserApproval = requiresUserApproval(this.permissionMode, tool);

      // Tools that declare approval metadata may still need prepareApproval for
      // executionData (Write/Edit hash), even when the mode auto-approves.
      const needsPreparation =
        tool.approval === 'always' || Boolean(tool.prepareApproval);

      if (needsPreparation) {
        let approvalDetails: ToolApprovalDetails = {
          description: `Execute ${tool.name}`
        };

        if (tool.prepareApproval) {
          approvalDetails = await tool.prepareApproval(
            validationResult.data,
            baseContext
          );
        }

        if (needsUserApproval) {
          if (!requestApproval) {
            return {
              role: 'tool',
              toolCallId,
              toolName,
              content: `Tool execution denied: ${tool.name} requires user approval, but no approval handler is available`,
              isError: true
            };
          }

          throwIfAborted(signal);
          const choices = approvalChoicesForTool(tool);
          const approvalChoice = await requestApproval({
            toolCallId,
            toolName,
            risk: tool.risk,
            input: validationResult.data,
            description: approvalDetails.description,
            preview: approvalDetails.preview,
            choices
          }, signal);
          throwIfAborted(signal);

          if (!isOfferedApprovalChoice(approvalChoice, choices)) {
            return {
              role: 'tool',
              toolCallId,
              toolName,
              content: `Tool execution denied: invalid approval choice for ${tool.name}`,
              isError: true
            };
          }

          if (approvalChoice === 'deny') {
            return {
              role: 'tool',
              toolCallId,
              toolName,
              content: `Tool execution denied by the user: ${approvalDetails.description}`,
              isError: true
            };
          }

          if (approvalChoice === 'allow-edits-session') {
            this.permissionMode = 'acceptEdits';
          }
        }

        executionContext = {
          ...baseContext,
          approvalData: approvalDetails.executionData
        };
      }

      console.log(`\n[Tool: ${toolName}]`);
      const toolResult = await tool.execute(
        validationResult.data,
        executionContext
      );
      throwIfAborted(signal);

      return {
        role: 'tool',
        toolCallId,
        toolName,
        content: this.truncateToolResult(toolResult.content),
        ...(toolResult.isError ? { isError: true } : {})
      };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw isAbortError(error) ? error : new OperationAbortedError();
      }
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
    const shell = resolveShellInvocation(':', process.platform);
    const shellExecutor = shell.executable;
    const shellHints = shell.kind === 'cmd'
      ? [
          '- This session uses Windows cmd.exe syntax for Shell.',
          '- Prefer `dir`, `type`, and `findstr` over Unix-only commands like `ls -la`.',
          '- Invoke PowerShell explicitly when needed: powershell -Command "..."'
        ]
      : [
          `- This session uses ${shellExecutor} for Shell.`,
          '- Prefer portable POSIX shell syntax for Shell commands.'
        ];

    return `You are Syzzz Code, an AI programming assistant.

Help developers write, debug, and understand code. Use the available tools when needed.

Rules:
1. Read existing files before editing them.
2. Prefer precise edits over replacing entire files.
3. Run relevant checks after making changes.
4. Never claim a tool succeeded unless its result confirms success.
5. Prefer ListDirectory, Read, Edit, and Write over Shell for exploring and changing files.
6. Use Shell for real system commands such as builds, tests, and git — not for cat/ls equivalents.

Environment:
- Workspace root: ${this.workspaceRoot}
- Platform: ${process.platform}
- Shell executor: ${shellExecutor}
- Permission mode: ${this.permissionMode}
${shellHints.join('\n')}`;
  }

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  clearMessages(): void {
    this.messages = [];
  }
}
