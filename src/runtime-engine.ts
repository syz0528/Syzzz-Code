import { randomUUID } from 'node:crypto';
import { LocalAuditLogger, type AgentEventSink } from './audit.js';
import { loadConfig } from './config.js';
import type {
  AgentErrorDetails,
  AgentEvent,
  AgentEventData,
  TurnResult
} from './events.js';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode
} from './permissions/mode.js';
import { requiresUserApproval } from './permissions/policy.js';
import { createProvider } from './providers/factory.js';
import type {
  AIProvider,
  ConversationMessage,
  ProviderChatResponse,
  ProviderTool,
  ProviderUsage,
  ToolResultMessage
} from './providers/base.js';
import { ProviderError } from './providers/errors.js';
import {
  getNormalizedProviderInfo,
  runProviderRequest,
  type ProviderRunnerOptions
} from './providers/runner.js';
import type {
  ToolApprovalChoice,
  ToolApprovalDetails,
  ToolApprovalHandler,
  ToolContext,
  ToolDefinition,
  ToolResult
} from './types.js';
import { isAbortError, OperationAbortedError, throwIfAborted } from './tools/abort.js';
import { allTools } from './tools/index.js';
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

function addUsage(total: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + next.outputTokens,
    totalTokens: (total?.totalTokens ?? 0) + next.totalTokens
  };
}

function toAgentError(error: unknown): AgentErrorDetails {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message,
      provider: error.provider,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.requestId ? { requestId: error.requestId } : {})
    };
  }

  return {
    code: 'runtime_error',
    message: error instanceof Error ? error.message : String(error)
  };
}

export interface QueryEngineOptions {
  provider?: AIProvider;
  tools?: ToolDefinition[];
  workspaceRoot?: string;
  permissionMode?: PermissionMode;
  providerRunner?: ProviderRunnerOptions;
  sessionId?: string;
  idFactory?: () => string;
  now?: () => number;
  audit?: AgentEventSink | false;
  auditDirectory?: string;
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
  private providerRunnerOptions: ProviderRunnerOptions;
  private sessionId: string;
  private idFactory: () => string;
  private now: () => number;
  private audit?: AgentEventSink;

  constructor(options: QueryEngineOptions = {}) {
    this.tools = options.tools ?? allTools;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.providerRunnerOptions = options.providerRunner ?? {};
    this.idFactory = options.idFactory ?? randomUUID;
    this.sessionId = options.sessionId ?? this.idFactory();
    this.now = options.now ?? Date.now;

    if (options.audit !== undefined && options.audit !== false) {
      this.audit = options.audit;
    }

    if (options.provider) {
      this.provider = options.provider;
      return;
    }

    const config = loadConfig();
    const providerConfig = config.providers[config.currentProvider];
    if (!providerConfig) {
      throw new Error('Provider ' + config.currentProvider + ' not found in config');
    }
    if (!providerConfig.env.API_KEY) {
      throw new Error(
        'No API key found for provider: ' + providerConfig.name + '\n\n' +
        'Set your API key:\n' +
        '  syzzz config set apiKey YOUR_KEY\n'
      );
    }

    try {
      this.provider = createProvider(providerConfig);
      if (options.audit !== false) {
        this.audit = new LocalAuditLogger({
          config: config.audit,
          sessionId: this.sessionId,
          workspaceRoot: this.workspaceRoot,
          baseDirectory: options.auditDirectory,
          now: this.now
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error('Failed to initialize provider: ' + reason);
    }
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  setModel(model: string): void {
    if (this.isProcessing) {
      throw new Error('Cannot switch models while a turn is processing');
    }
    if (!model.trim()) {
      throw new Error('model must be a non-empty string');
    }
    if (!this.provider.setModel) {
      throw new Error('The current provider does not support runtime model switching');
    }

    this.provider.setModel(model);
    this.messages = this.messages.map(message => {
      if (message.role !== 'assistant' || !('reasoningContent' in message)) {
        return message;
      }
      const { reasoningContent: _reasoningContent, ...portableMessage } = message;
      return portableMessage;
    });
  }

  getProviderInfo() {
    return getNormalizedProviderInfo(this.provider);
  }

  async *runTurn(
    userMessage: string,
    options: ChatOptions = {}
  ): AsyncGenerator<AgentEvent, TurnResult> {
    const externalSignal = options.signal;
    const turnController = new AbortController();
    const signal = turnController.signal;
    const turnId = this.idFactory();
    const turnStartedAt = this.now();
    let sequence = 0;
    let ownsProcessingLock = false;

    const event = (data: AgentEventData): AgentEvent => {
      const nextEvent = {
        schemaVersion: 1,
        sessionId: this.sessionId,
        turnId,
        sequence: ++sequence,
        timestamp: new Date(this.now()).toISOString(),
        ...data
      } as AgentEvent;
      this.audit?.record(nextEvent);
      return nextEvent;
    };

    const handleExternalAbort = () => {
      turnController.abort(externalSignal?.reason);
    };
    externalSignal?.addEventListener('abort', handleExternalAbort, { once: true });
    if (externalSignal?.aborted) {
      handleExternalAbort();
    }

    try {
      const turnWasAlreadyProcessing = this.isProcessing;
      if (!turnWasAlreadyProcessing) {
        this.isProcessing = true;
        ownsProcessingLock = true;
      }

      yield event({
        type: 'turn_started',
        provider: this.getProviderInfo()
      });

      if (turnWasAlreadyProcessing) {
        const result: TurnResult = {
          status: 'failed',
          durationMs: Math.max(0, this.now() - turnStartedAt),
          error: {
            code: 'turn_in_progress',
            message: 'Another message is still being processed'
          }
        };
        yield event({
          type: 'turn_failed',
          durationMs: result.durationMs,
          error: result.error
        });
        return result;
      }

      const workingMessages: ConversationMessage[] = [
        ...this.messages,
        { role: 'user', content: userMessage }
      ];
      const responseParts: string[] = [];
      const providerTools: ProviderTool[] = this.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: convertToolSchemaToJsonSchema(tool)
      }));
      let cumulativeUsage: ProviderUsage | undefined;
      let finalFinishReason: string | null | undefined;

      throwIfAborted(signal);
      for (let toolRound = 0; toolRound <= MAX_TOOL_ROUNDS; toolRound++) {
        throwIfAborted(signal);
        yield event({ type: 'phase_changed', phase: 'provider' });

        const providerRun = runProviderRequest(this.provider, {
          messages: workingMessages,
          tools: providerTools,
          systemPrompt: this.getSystemPrompt(),
          signal
        }, this.providerRunnerOptions);
        let providerRunCompleted = false;
        let providerRunFailed = false;
        let response: ProviderChatResponse;

        try {
          while (true) {
            const next = await providerRun.next();
            if (next.done) {
              providerRunCompleted = true;
              response = next.value;
              break;
            }

            const providerEvent = next.value;
            switch (providerEvent.type) {
              case 'request_started':
                yield event({
                  type: 'provider_request_started',
                  provider: providerEvent.provider,
                  model: providerEvent.model,
                  attempt: providerEvent.attempt,
                  attemptId: providerEvent.attemptId
                });
                break;
              case 'request_failed':
                yield event({
                  type: 'provider_request_failed',
                  provider: providerEvent.provider,
                  model: providerEvent.model,
                  attempt: providerEvent.attempt,
                  attemptId: providerEvent.attemptId,
                  durationMs: providerEvent.durationMs,
                  willRetry: providerEvent.willRetry,
                  error: providerEvent.error
                });
                break;
              case 'request_completed':
                finalFinishReason = providerEvent.response.finishReason;
                yield event({
                  type: 'provider_request_completed',
                  provider: providerEvent.provider,
                  model: providerEvent.model,
                  attempt: providerEvent.attempt,
                  attemptId: providerEvent.attemptId,
                  durationMs: providerEvent.durationMs,
                  finishReason: providerEvent.response.finishReason,
                  requestId: providerEvent.response.requestId,
                  reportedModel: providerEvent.response.reportedModel
                });
                break;
              case 'reasoning_status':
                yield event({
                  type: 'reasoning_status',
                  status: providerEvent.status,
                  attempt: providerEvent.attempt,
                  attemptId: providerEvent.attemptId,
                  durationMs: providerEvent.durationMs,
                  characterCount: providerEvent.characterCount
                });
                break;
              case 'text_delta':
                yield event({
                  type: 'text_delta',
                  attempt: providerEvent.attempt,
                  attemptId: providerEvent.attemptId,
                  delta: providerEvent.delta
                });
                break;
              case 'usage':
                cumulativeUsage = addUsage(cumulativeUsage, providerEvent.usage);
                yield event({
                  type: 'usage_updated',
                  attempt: providerEvent.attempt,
                  attemptId: providerEvent.attemptId,
                  usage: providerEvent.usage,
                  cumulativeUsage
                });
                break;
              case 'retry_scheduled':
                yield event({
                  type: 'retry_scheduled',
                  attempt: providerEvent.attempt,
                  nextAttempt: providerEvent.nextAttempt,
                  delayMs: providerEvent.delayMs,
                  reason: providerEvent.reason
                });
                break;
              case 'tool_call_delta':
                break;
            }
          }
        } catch (error) {
          providerRunFailed = true;
          throw error;
        } finally {
          if (!providerRunCompleted) {
            if (!providerRunFailed && !signal.aborted) {
              turnController.abort(new OperationAbortedError('Turn consumer closed'));
            }
            await providerRun.return(undefined as never);
          }
        }

        throwIfAborted(signal);
        workingMessages.push(response.message);
        if (response.message.content.trim()) {
          responseParts.push(response.message.content.trim());
        }

        const toolCalls = response.message.toolCalls ?? [];
        if (toolCalls.length === 0) {
          const result: TurnResult = {
            status: 'completed',
            response: responseParts.join('\n\n'),
            durationMs: Math.max(0, this.now() - turnStartedAt),
            finishReason: finalFinishReason,
            usage: cumulativeUsage
          };
          yield event({ type: 'phase_changed', phase: 'completed' });
          this.messages = workingMessages;
          yield event({
            type: 'turn_completed',
            durationMs: result.durationMs,
            finishReason: result.finishReason,
            usage: result.usage
          });
          return result;
        }

        if (toolRound === MAX_TOOL_ROUNDS) {
          throw new Error(
            'Tool call limit exceeded (' + MAX_TOOL_ROUNDS + ' rounds)'
          );
        }

        for (const toolCall of toolCalls) {
          const toolRun = this.executeToolCall(
            toolCall.id,
            toolCall.name,
            toolCall.input,
            signal,
            options.requestApproval
          );
          let toolRunCompleted = false;
          let toolRunFailed = false;

          try {
            while (true) {
              const next = await toolRun.next();
              if (next.done) {
                toolRunCompleted = true;
                workingMessages.push(next.value);
                break;
              }
              yield event(next.value);
            }
          } catch (error) {
            toolRunFailed = true;
            throw error;
          } finally {
            if (!toolRunCompleted) {
              if (!toolRunFailed && !signal.aborted) {
                turnController.abort(new OperationAbortedError('Turn consumer closed'));
              }
              await toolRun.return(undefined as never);
            }
          }
        }
      }

      throw new Error('Chat ended without a final response');
    } catch (error) {
      const durationMs = Math.max(0, this.now() - turnStartedAt);
      if (signal.aborted || isAbortError(error)) {
        const reason = 'Operation cancelled by the user';
        const result: TurnResult = {
          status: 'cancelled',
          durationMs,
          reason
        };
        yield event({ type: 'turn_cancelled', durationMs, reason });
        return result;
      }

      const result: TurnResult = {
        status: 'failed',
        durationMs,
        error: toAgentError(error)
      };
      yield event({
        type: 'turn_failed',
        durationMs,
        error: result.error
      });
      return result;
    } finally {
      externalSignal?.removeEventListener('abort', handleExternalAbort);
      if (!signal.aborted) {
        turnController.abort(new OperationAbortedError('Turn consumer closed'));
      }
      if (ownsProcessingLock) {
        this.isProcessing = false;
      }
      await this.audit?.flush();
    }
  }

  async chat(userMessage: string, options: ChatOptions = {}): Promise<string> {
    const turn = this.runTurn(userMessage, options);
    let result: TurnResult;
    while (true) {
      const next = await turn.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }

    if (result.status === 'completed') {
      return result.response;
    }
    if (result.status === 'cancelled') {
      throw new OperationAbortedError(result.reason);
    }
    throw new Error('Chat error: ' + result.error.message);
  }

  private async *executeToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
    requestApproval?: ToolApprovalHandler
  ): AsyncGenerator<AgentEventData, ToolResultMessage> {
    const startedAt = this.now();
    yield { type: 'tool_requested', toolCallId, toolName };

    const complete = (
      outcome: 'success' | 'error' | 'denied' | 'cancelled',
      result: string,
      metadata?: Record<string, unknown>
    ): AgentEventData => ({
      type: 'tool_completed',
      toolCallId,
      toolName,
      outcome,
      durationMs: Math.max(0, this.now() - startedAt),
      result,
      ...(metadata ? { metadata } : {})
    });
    const toolMessage = (
      content: string,
      isError: boolean = false
    ): ToolResultMessage => ({
      role: 'tool',
      toolCallId,
      toolName,
      content,
      ...(isError ? { isError: true } : {})
    });

    const tool = this.tools.find(candidate => candidate.name === toolName);
    if (!tool) {
      const content = 'Unknown tool: ' + toolName;
      yield complete('error', content);
      return toolMessage(content, true);
    }

    const validationResult = validateToolInput(tool, input);
    if (!validationResult.success) {
      yield complete('error', validationResult.message);
      return toolMessage(validationResult.message, true);
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
      const needsPreparation =
        tool.approval === 'always' || Boolean(tool.prepareApproval);

      if (needsPreparation) {
        let approvalDetails: ToolApprovalDetails = {
          description: 'Execute ' + tool.name
        };
        if (tool.prepareApproval) {
          approvalDetails = await tool.prepareApproval(
            validationResult.data,
            baseContext
          );
        }

        if (needsUserApproval) {
          const choices = approvalChoicesForTool(tool);
          yield { type: 'phase_changed', phase: 'approval' };
          yield {
            type: 'approval_requested',
            toolCallId,
            toolName,
            risk: tool.risk,
            choices
          };

          if (!requestApproval) {
            const content =
              'Tool execution denied: ' + tool.name +
              ' requires user approval, but no approval handler is available';
            yield {
              type: 'approval_resolved',
              toolCallId,
              toolName,
              choice: 'deny',
              resolution: 'handler-unavailable'
            };
            yield complete('denied', content);
            return toolMessage(content, true);
          }

          throwIfAborted(signal);
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
            const content =
              'Tool execution denied: invalid approval choice for ' + tool.name;
            yield {
              type: 'approval_resolved',
              toolCallId,
              toolName,
              choice: 'deny',
              resolution: 'invalid-choice'
            };
            yield complete('denied', content);
            return toolMessage(content, true);
          }

          yield {
            type: 'approval_resolved',
            toolCallId,
            toolName,
            choice: approvalChoice,
            resolution: 'user'
          };
          if (approvalChoice === 'deny') {
            const content =
              'Tool execution denied by the user: ' + approvalDetails.description;
            yield complete('denied', content);
            return toolMessage(content, true);
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

      yield { type: 'phase_changed', phase: 'tool' };
      yield { type: 'tool_started', toolCallId, toolName };
      const toolResult: ToolResult = await tool.execute(
        validationResult.data,
        executionContext
      );
      throwIfAborted(signal);

      const content = this.truncateToolResult(toolResult.content);
      yield complete(
        toolResult.isError ? 'error' : 'success',
        content,
        toolResult.metadata
      );
      return toolMessage(content, Boolean(toolResult.isError));
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        const reason = 'Operation cancelled by the user';
        yield complete('cancelled', reason);
        throw new OperationAbortedError(reason);
      }
      const reason = error instanceof Error ? error.message : String(error);
      yield complete('error', reason);
      return toolMessage(reason, true);
    }
  }

  private truncateToolResult(result: string): string {
    if (result.length <= MAX_TOOL_RESULT_CHARACTERS) {
      return result;
    }
    return result.slice(0, MAX_TOOL_RESULT_CHARACTERS) +
      '\n\n[Output truncated]';
  }

  private getSystemPrompt(): string {
    const shell = resolveShellInvocation(':', process.platform);
    const shellExecutor = shell.executable;
    const shellHints = shell.kind === 'cmd'
      ? [
          '- This session uses Windows cmd.exe syntax for Shell.',
          '- Prefer dir, type, and findstr over Unix-only commands.',
          '- Invoke PowerShell explicitly when needed.'
        ]
      : [
          '- This session uses ' + shellExecutor + ' for Shell.',
          '- Prefer portable POSIX shell syntax for Shell commands.'
        ];

    return [
      'You are Syzzz Code, an AI programming assistant.',
      '',
      'Help developers write, debug, and understand code. Use the available tools when needed.',
      '',
      'Rules:',
      '1. Read existing files before editing them.',
      '2. Prefer precise edits over replacing entire files.',
      '3. Run relevant checks after making changes.',
      '4. Never claim a tool succeeded unless its result confirms success.',
      '5. Prefer ListDirectory, Read, Edit, and Write over Shell for file work.',
      '6. Use Shell for builds, tests, and git, not for file API equivalents.',
      '7. Inspect project structure once, then read only files relevant to the task.',
      '8. Before requesting Shell approval, choose a command and output format likely to complete the task in one run.',
      '9. Do not rerun a successful tool only to reformat its output; summarize the existing result instead.',
      '10. Describe inspection scope accurately: verify exact counts, and do not call a sampled review complete or exhaustive.',
      '',
      'Environment:',
      '- Workspace root: ' + this.workspaceRoot,
      '- Platform: ' + process.platform,
      '- Shell executor: ' + shellExecutor,
      '- Permission mode: ' + this.permissionMode,
      ...shellHints
    ].join('\n');
  }

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  clearMessages(): void {
    this.messages = [];
  }
}
