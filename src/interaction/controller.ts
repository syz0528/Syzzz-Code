import type { QueryEngine } from '../engine.js';
import type { AgentEvent, TurnResult } from '../events.js';
import {
  consumeInteractiveTurn,
  createInteractiveCommandRuntime,
  type InteractiveCommandRuntime,
  type InteractiveSessionOptions,
  type InteractiveTerminalReader
} from '../interactive.js';
import { isAbortError, OperationAbortedError } from '../tools/abort.js';
import type {
  ToolApprovalChoice,
  ToolApprovalRequest,
  UserInputAnswers,
  UserInputRequest
} from '../types.js';
import { WorkspaceInputHistory } from './history.js';
import {
  activityElapsedMs,
  pauseActivity,
  resumeActivity,
  toolTimelineCategory,
  type ConversationBlock,
  type ToolTimelineItem,
  type TurnActivityState
} from './conversation.js';
import type {
  ConfirmRequest,
  InteractionNotice,
  InteractionPort,
  InteractionState,
  SelectRequest,
  TextInputRequest
} from './types.js';
import { resolveUiLanguage, type ResolvedUiLanguage } from '../ui-language.js';

const MAX_VIEW_ENTRIES = 2_000;
const MAX_VIEW_BYTES = 4 * 1024 * 1024;
const TEXT_FLUSH_MS = 33;

export type { ConversationBlock } from './conversation.js';

export type PendingInteraction =
  | { id: string; type: 'confirm'; request: ConfirmRequest; value: string }
  | { id: string; type: 'select'; request: SelectRequest; selected: number }
  | { id: string; type: 'text'; request: TextInputRequest; value: string }
  | { id: string; type: 'approval'; request: ToolApprovalRequest; scroll: number; value: string }
  | { id: string; type: 'question'; request: UserInputRequest; answers: UserInputAnswers };

export interface InteractionStats {
  tools: number;
  failedTools: number;
  retries: number;
  compactions: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface InteractionViewState {
  revision: number;
  state: InteractionState;
  transcript: readonly ConversationBlock[];
  activity?: TurnActivityState | string;
  phase?: string;
  pending?: PendingInteraction;
  status: ReturnType<QueryEngine['getStatus']>;
  stats: InteractionStats;
  historyEnabled: boolean;
  language: ResolvedUiLanguage;
  session?: ReturnType<NonNullable<InteractiveSessionOptions['session']>['getStatus']>;
  exitReason?: string;
}

type Listener = () => void;
type PendingResolver = {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

export interface InteractionControllerOptions {
  engine: QueryEngine;
  sessionOptions: InteractiveSessionOptions;
  history: WorkspaceInputHistory;
  streamOutput: boolean;
  textFrameIntervalMs?: number;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}

function entryBytes(entry: ConversationBlock): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

function terminalResult(value: string | undefined) {
  return value === undefined
    ? ({ type: 'interrupt' } as const)
    : ({ type: 'line', value } as const);
}

export class InteractionController implements InteractionPort {
  private readonly listeners = new Set<Listener>();
  private readonly commandRuntime: InteractiveCommandRuntime;
  private readonly history: WorkspaceInputHistory;
  private revision = 0;
  private interactionState: InteractionState = 'idle';
  private transcript: ConversationBlock[] = [];
  private activity?: TurnActivityState | string;
  private phase?: string;
  private pending?: PendingInteraction;
  private pendingResolver?: PendingResolver;
  private activeAbort?: AbortController;
  private exitReason?: string;
  private stats: InteractionStats = {
    tools: 0,
    failedTools: 0,
    retries: 0,
    compactions: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  };
  private nextId = 0;
  private activeAssistantId?: string;
  private activeTurnId?: string;
  private activeTurnStats?: { tools: number; failedTools: number; retries: number };
  private bufferedText = '';
  private textTimer?: NodeJS.Timeout;
  private readonly textFrameIntervalMs: number;
  private lastTextFlushAt = 0;
  private snapshotCache?: InteractionViewState;

  private constructor(options: InteractionControllerOptions) {
    this.history = options.history;
    this.textFrameIntervalMs = Math.max(0, options.textFrameIntervalMs ?? TEXT_FLUSH_MS);
    const terminal: InteractiveTerminalReader = {
      readLine: async (request) =>
        terminalResult(
          await this.textInput(
            {
              title: stripAnsi(request.prompt).trim() || 'Input',
              maximumCharacters: 4 * 1024
            },
            request.signal ?? new AbortController().signal
          )
        )
    };
    this.commandRuntime = createInteractiveCommandRuntime(
      options.engine,
      { ...options.sessionOptions, streamOutput: options.streamOutput },
      terminal,
      this,
      true
    );
    this.loadConversationSnapshot(options.engine);
  }

  private loadConversationSnapshot(engine: QueryEngine, trailing: ConversationBlock[] = []): void {
    const restored: ConversationBlock[] = [];
    const snapshot = engine.getConversationDisplaySnapshot();
    if (snapshot.omitted > 0) {
      restored.push({
        id: this.id('omitted'),
        kind: 'omitted',
        text: `${snapshot.omitted} earlier conversation entries omitted`
      });
    }
    let restoredTurnId: string | undefined;
    for (const message of snapshot.messages) {
      if (message.role === 'user' || !restoredTurnId) {
        restoredTurnId = this.id('restored-turn');
      }
      restored.push(
        message.role === 'user'
          ? {
              id: this.id('user'),
              turnId: restoredTurnId,
              kind: 'user',
              text: message.content,
              submittedAt: 0
            }
          : {
              id: this.id('assistant'),
              turnId: restoredTurnId,
              kind: 'assistant',
              markdown: message.content,
              status: 'completed'
            }
      );
    }
    this.transcript = [...restored, ...trailing];
  }

  static async create(
    options: Omit<InteractionControllerOptions, 'history'> & {
      persistentHistory: boolean;
      historyBaseDirectory?: string;
    }
  ): Promise<InteractionController> {
    const warnings: string[] = [];
    const history = await WorkspaceInputHistory.create({
      workspaceRoot: options.engine.getStatus().workspaceRoot,
      enabled: options.persistentHistory,
      baseDirectory: options.historyBaseDirectory,
      onWarning: (message) => warnings.push(message)
    });
    const controller = new InteractionController({ ...options, history });
    for (const warning of warnings) {
      controller.notice({ tone: 'warning', text: warning });
    }
    return controller;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot = (): InteractionViewState => {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        revision: this.revision,
        state: this.interactionState,
        transcript: this.transcript,
        ...(this.activity ? { activity: this.activity } : {}),
        ...(this.phase ? { phase: this.phase } : {}),
        ...(this.pending ? { pending: this.pending } : {}),
        status: this.commandRuntime.context.engine.getStatus(),
        stats: this.stats,
        historyEnabled: this.history.isEnabled,
        language: resolveUiLanguage(this.commandRuntime.context.uiLanguage),
        ...(this.commandRuntime.context.session
          ? { session: this.commandRuntime.context.session.getStatus() }
          : {}),
        ...(this.exitReason ? { exitReason: this.exitReason } : {})
      };
    }
    return this.snapshotCache;
  };

  get suggestions(): InteractiveCommandRuntime['suggestionProviders'] {
    return this.commandRuntime.suggestionProviders;
  }

  get inputHistory(): readonly string[] {
    return this.history.list();
  }

  async promptSessionStartup(signal: AbortSignal): Promise<void> {
    const session = this.commandRuntime.context.session;
    if (!session) return;
    const sessions = (await session.list()).filter(
      (candidate) =>
        candidate.available &&
        candidate.sessionId !== this.commandRuntime.context.engine.getSessionId()
    );
    const latest = sessions[0];
    if (!latest) return;
    const chinese = this.getSnapshot().language === 'zh-CN';
    const choice = await this.select(
      {
        title: chinese ? '打开会话' : 'Open session',
        message: chinese
          ? `当前工作区有 ${sessions.length} 个可恢复会话。`
          : `${sessions.length} saved conversation(s) are available for this workspace.`,
        choices: [
          ...sessions.map((candidate, index) => ({
            value: candidate.sessionId,
            label: `${index === 0 ? (chinese ? '继续 ' : 'Continue ') : ''}${candidate.title}`,
            description: `${candidate.updatedAt} | ${candidate.sessionId.slice(0, 8)}`
          })),
          {
            value: 'new',
            label: chinese ? '新建对话' : 'Start new',
            description: chinese
              ? '保留所有已保存会话并开始空白会话'
              : 'Keep every saved conversation and start empty'
          }
        ],
        initialValue: latest.sessionId
      },
      signal
    );
    if (!choice || choice === 'new') return;
    const result = await session.resume(choice);
    this.commandRuntime.context.engine = session.engine;
    this.commandRuntime.context.availableModels = this.commandRuntime.context.modelsForProvider?.(
      session.providerId
    ) ?? [session.engine.getProviderInfo().model];
    this.loadConversationSnapshot(session.engine);
    this.notice({
      tone: 'success',
      text: chinese
        ? `已继续 ${result.title} [${result.sessionId.slice(0, 8)}]。`
        : `Resumed ${result.title} [${result.sessionId.slice(0, 8)}].`
    });
  }

  private emit(): void {
    this.revision += 1;
    this.snapshotCache = undefined;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}-${this.nextId}`;
  }

  private push(entry: ConversationBlock): void {
    this.transcript = [...this.transcript, entry];
    let bytes = this.transcript.reduce((total, item) => total + entryBytes(item), 0);
    let omitted = 0;
    while (this.transcript.length > MAX_VIEW_ENTRIES || bytes > MAX_VIEW_BYTES) {
      const removed = this.transcript.shift();
      if (!removed) {
        break;
      }
      bytes -= entryBytes(removed);
      omitted += 1;
    }
    if (omitted > 0) {
      const first = this.transcript[0];
      if (first?.kind === 'omitted') {
        const current = Number.parseInt(first.text, 10) || 0;
        first.text = `${current + omitted} older display entries omitted`;
      } else {
        this.transcript.unshift({
          id: this.id('omitted'),
          kind: 'omitted',
          text: `${omitted} older display entries omitted`
        });
      }
    }
    this.emit();
  }

  notice(notice: InteractionNotice): void {
    if (notice.transient) {
      if (this.activity && typeof this.activity !== 'string') {
        this.activity = { ...this.activity, detail: stripAnsi(notice.text) };
      } else {
        this.activity = stripAnsi(notice.text);
      }
      this.emit();
      return;
    }
    this.push({
      id: this.id('notice'),
      kind: 'notice',
      tone: notice.tone,
      text: stripAnsi(notice.text).trim()
    });
  }

  async submit(input: string): Promise<void> {
    if (this.interactionState !== 'idle') {
      throw new Error('Another interaction is already active');
    }
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }
    await this.history.record(input);
    if (trimmed.toLowerCase() === 'exit') {
      this.requestExit('user');
      return;
    }

    let message = trimmed.startsWith('//') ? trimmed.slice(1) : trimmed;
    const controller = new AbortController();
    this.activeAbort = controller;
    try {
      if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        this.interactionState = 'command';
        this.emit();
        const previousEngine = this.commandRuntime.context.engine;
        const commandEntryStart = this.transcript.length;
        const commandResult = await this.commandRuntime.execute(trimmed, controller.signal);
        if (this.commandRuntime.context.engine !== previousEngine) {
          this.loadConversationSnapshot(
            this.commandRuntime.context.engine,
            this.transcript.slice(commandEntryStart)
          );
          this.emit();
        }
        if (commandResult.notice) {
          this.notice(commandResult.notice);
        }
        if (commandResult.type === 'exit') {
          this.requestExit('command');
          return;
        }
        if (commandResult.type !== 'submit') {
          return;
        }
        message = commandResult.message;
      }
      await this.runTurn(message, controller);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        this.notice({ tone: 'warning', text: 'Current operation cancelled.' });
      } else {
        this.notice({
          tone: 'error',
          text: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      if (this.activeAbort === controller) {
        this.activeAbort = undefined;
      }
      if (!this.exitReason) {
        this.interactionState = 'idle';
      }
      this.activity = undefined;
      this.phase = undefined;
      this.pending = undefined;
      this.emit();
    }
  }

  private async runTurn(message: string, controller: AbortController): Promise<void> {
    this.interactionState = 'turn';
    const turnId = this.id('turn');
    this.activeTurnId = turnId;
    this.activeTurnStats = { tools: 0, failedTools: 0, retries: 0 };
    const startedAt = Date.now();
    this.activity = {
      turnId,
      phase: 'starting',
      startedAt,
      activeSince: startedAt,
      accumulatedActiveMs: 0,
      waitingForInput: false
    };
    this.push({ id: this.id('user'), turnId, kind: 'user', text: message, submittedAt: startedAt });
    this.activeAssistantId = this.id('assistant');
    this.push({
      id: this.activeAssistantId,
      turnId,
      kind: 'assistant',
      markdown: '',
      status: 'streaming',
      live: this.commandRuntime.context.streamOutput
    });
    const result = await consumeInteractiveTurn(
      this.commandRuntime.context.engine,
      message,
      {
        signal: controller.signal,
        requestApproval: (request, signal) => this.requestApproval(request, signal),
        requestUserInput: (request, signal) => this.requestUserInput(request, signal)
      },
      (event) => this.handleAgentEvent(event)
    );
    this.flushText();
    await this.commandRuntime.context.session?.recordTurn(message, result);
    this.finishTurn(result);
  }

  private handleAgentEvent(event: AgentEvent): void {
    const chinese = resolveUiLanguage(this.commandRuntime.context.uiLanguage) === 'zh-CN';
    if (event.type !== 'text_delta' && this.commandRuntime.context.streamOutput) {
      this.flushText();
    }
    switch (event.type) {
      case 'phase_changed':
        this.phase = event.phase;
        if (this.activity && typeof this.activity !== 'string' && event.phase !== 'completed') {
          this.activity = { ...this.activity, phase: event.phase, detail: undefined };
        }
        break;
      case 'reasoning_status':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: event.status === 'started' ? 'reasoning' : this.activity.phase,
            detail: event.status === 'started' ? (chinese ? '推理中' : 'Reasoning') : undefined
          };
        }
        break;
      case 'text_delta':
        this.bufferedText += event.delta;
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'responding',
            detail: chinese ? '生成回答' : 'Responding'
          };
        }
        if (this.commandRuntime.context.streamOutput) {
          this.scheduleTextFlush();
        }
        return;
      case 'skill_activated':
        this.notice({
          tone: 'success',
          text: chinese
            ? `Skill ${event.skill} 已激活（${event.activation}）。`
            : `Skill ${event.skill} activated (${event.activation}).`
        });
        return;
      case 'skill_failed':
        this.notice({
          tone: 'error',
          text: chinese
            ? `Skill ${event.skill} 激活失败（${event.code}）。`
            : `Skill ${event.skill} failed (${event.code}).`
        });
        return;
      case 'rag_index_started':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'rag',
            detail: chinese ? `正在索引 ${event.collection}` : `Indexing ${event.collection}`
          };
        }
        break;
      case 'rag_index_progress':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'rag',
            detail: `${event.collection}: ${event.stage} ${event.completed}${event.total === undefined ? '' : `/${event.total}`}`
          };
        }
        break;
      case 'rag_retrieval_started':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'rag',
            detail: chinese ? '检索索引证据' : 'Retrieving indexed evidence'
          };
        }
        break;
      case 'rag_retrieval_completed':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            detail: chinese
              ? `找到 ${event.resultCount} 条证据`
              : `${event.resultCount} evidence results`
          };
        }
        break;
      case 'rag_verification_started':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'rag',
            detail: chinese ? '校验 RAG 引用' : 'Verifying RAG citations'
          };
        }
        break;
      case 'rag_verification_completed':
        if (event.invalidCitationCount > 0 || event.outcome === 'unsupported') {
          this.notice({
            tone: 'warning',
            text: chinese
              ? `RAG 引用警告：${event.invalidCitationCount} 个无效引用，结论 ${event.outcome}`
              : `RAG citation warning: ${event.invalidCitationCount} invalid, ${event.outcome}`
          });
          return;
        }
        break;
      case 'rag_index_failed':
      case 'rag_retrieval_failed':
      case 'rag_verification_failed':
        this.notice({
          tone: 'warning',
          text: `RAG ${event.type.replace(/^rag_|_failed$/g, '').replaceAll('_', ' ')} failed (${event.code})`
        });
        return;
      case 'retry_scheduled':
        this.stats.retries += 1;
        if (this.activeTurnStats) this.activeTurnStats.retries += 1;
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'retrying',
            detail: chinese
              ? `${event.delayMs}ms 后重试（${event.reason}）`
              : `Retrying in ${event.delayMs}ms (${event.reason})`
          };
        }
        break;
      case 'compaction_started':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'compaction',
            detail: chinese ? '压缩上下文' : 'Compacting context'
          };
        }
        break;
      case 'compaction_completed':
        this.stats.compactions += 1;
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = { ...this.activity, detail: undefined };
        }
        break;
      case 'usage_updated':
        this.stats.usage = { ...event.cumulativeUsage };
        break;
      case 'tool_requested':
        this.stats.tools += 1;
        if (this.activeTurnStats) this.activeTurnStats.tools += 1;
        this.addTool(event.toolCallId, event.toolName);
        return;
      case 'tool_started':
        this.updateTool(event.toolCallId, { status: 'running' });
        return;
      case 'tool_completed':
        if (event.outcome !== 'success') {
          this.stats.failedTools += 1;
          if (this.activeTurnStats) this.activeTurnStats.failedTools += 1;
        }
        this.updateTool(event.toolCallId, {
          status: event.outcome,
          durationMs: event.durationMs,
          summary: event.result?.split(/\r?\n/u, 1)[0]?.slice(0, 240),
          ...(event.result
            ? {
                detail: event.result.slice(0, 40 * 1024),
                expanded: event.outcome !== 'success'
              }
            : {})
        });
        return;
      case 'hook_started':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'hook',
            detail: `Hook ${event.hook} (${event.event})`
          };
        }
        break;
      case 'mcp_server_status':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'mcp',
            detail: `MCP ${event.server}: ${event.state}`
          };
        }
        break;
      case 'subagent_started':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'subagent',
            detail: `Subagent ${event.role}`
          };
        }
        break;
      case 'subagent_progress':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = {
            ...this.activity,
            phase: 'subagent',
            detail: `Subagent ${event.role}: ${event.toolName ?? event.phase}`
          };
        }
        break;
      case 'turn_failed':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = { ...this.activity, phase: 'failed', detail: event.error.message };
        }
        break;
      case 'turn_cancelled':
        if (this.activity && typeof this.activity !== 'string') {
          this.activity = { ...this.activity, phase: 'cancelled', detail: 'Cancelled' };
        }
        break;
      default:
        break;
    }
    this.emit();
  }

  private addTool(toolCallId: string, name: string): void {
    const turnId = this.activeTurnId ?? this.id('turn');
    const category = toolTimelineCategory(name);
    const item: ToolTimelineItem = {
      id: this.id('tool'),
      toolCallId,
      name,
      status: 'requested'
    };
    const activeAssistant = this.transcript.at(-1);
    if (
      activeAssistant?.kind === 'assistant' &&
      activeAssistant.id === this.activeAssistantId &&
      activeAssistant.markdown.length === 0
    ) {
      this.transcript = this.transcript.slice(0, -1);
    } else if (
      activeAssistant?.kind === 'assistant' &&
      activeAssistant.id === this.activeAssistantId
    ) {
      this.transcript = [
        ...this.transcript.slice(0, -1),
        { ...activeAssistant, status: 'completed' }
      ];
    }
    this.activeAssistantId = undefined;
    const previous = this.transcript.at(-1);
    if (category === 'read' && previous?.kind === 'tool-group' && previous.category === 'read') {
      this.transcript = [
        ...this.transcript.slice(0, -1),
        { ...previous, items: [...previous.items, item] }
      ];
      this.emit();
      return;
    }
    this.push({
      id: this.id('tool-group'),
      turnId,
      kind: 'tool-group',
      category,
      items: [item]
    });
  }

  private updateTool(toolCallId: string, update: Partial<ToolTimelineItem>): void {
    this.transcript = this.transcript.map((entry) =>
      entry.kind === 'tool-group' && entry.items.some((item) => item.toolCallId === toolCallId)
        ? {
            ...entry,
            items: entry.items.map((item) =>
              item.toolCallId === toolCallId ? { ...item, ...update } : item
            )
          }
        : entry
    );
    this.emit();
  }

  toggleLatestToolDetail(): boolean {
    let index = -1;
    for (
      let candidateIndex = this.transcript.length - 1;
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      const candidate = this.transcript[candidateIndex];
      if (
        candidate?.kind === 'tool-group' &&
        candidate.items.some((item) => Boolean(item.detail))
      ) {
        index = candidateIndex;
        break;
      }
    }
    const entry = this.transcript[index];
    if (index < 0 || entry?.kind !== 'tool-group') {
      return false;
    }
    let toggled = false;
    this.transcript = this.transcript.map((candidate, candidateIndex) =>
      candidateIndex === index && candidate.kind === 'tool-group'
        ? {
            ...candidate,
            items: candidate.items.map((item, itemIndex) => {
              const laterDetail = candidate.items
                .slice(itemIndex + 1)
                .some((laterItem) => Boolean(laterItem.detail));
              if (toggled || !item.detail || laterDetail) return item;
              toggled = true;
              return { ...item, expanded: !item.expanded };
            })
          }
        : candidate
    );
    this.emit();
    return true;
  }

  private scheduleTextFlush(): void {
    if (this.textTimer) {
      return;
    }
    const elapsed = Date.now() - this.lastTextFlushAt;
    if (this.lastTextFlushAt === 0 || elapsed >= this.textFrameIntervalMs) {
      this.flushText();
      return;
    }
    this.textTimer = setTimeout(
      () => {
        this.textTimer = undefined;
        this.flushText();
      },
      Math.max(0, this.textFrameIntervalMs - elapsed)
    );
    this.textTimer.unref?.();
  }

  private ensureAssistantBlock(): string | undefined {
    if (!this.activeTurnId) return undefined;
    const current = this.transcript.at(-1);
    if (
      this.activeAssistantId &&
      current?.kind === 'assistant' &&
      current.id === this.activeAssistantId
    ) {
      return this.activeAssistantId;
    }
    this.activeAssistantId = this.id('assistant');
    this.push({
      id: this.activeAssistantId,
      turnId: this.activeTurnId,
      kind: 'assistant',
      markdown: '',
      status: 'streaming',
      live: this.commandRuntime.context.streamOutput
    });
    return this.activeAssistantId;
  }

  private flushText(): void {
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = undefined;
    }
    if (!this.bufferedText) {
      return;
    }
    const assistantId = this.ensureAssistantBlock();
    if (!assistantId) return;
    const delta = this.bufferedText;
    this.bufferedText = '';
    this.transcript = this.transcript.map((entry) =>
      entry.id === assistantId && entry.kind === 'assistant'
        ? { ...entry, markdown: entry.markdown + delta }
        : entry
    );
    this.lastTextFlushAt = Date.now();
    this.emit();
  }

  private finishTurn(result: TurnResult): void {
    if (!this.activeAssistantId) this.ensureAssistantBlock();
    this.flushText();
    const activeStats = this.activeTurnStats ?? { tools: 0, failedTools: 0, retries: 0 };
    const workingDurationMs =
      this.activity && typeof this.activity !== 'string'
        ? activityElapsedMs(pauseActivity(this.activity) ?? this.activity)
        : result.durationMs;
    if (this.activeAssistantId) {
      this.transcript = this.transcript.map((entry) =>
        entry.id === this.activeAssistantId && entry.kind === 'assistant'
          ? {
              ...entry,
              ...(result.status === 'completed' && !this.commandRuntime.context.streamOutput
                ? { markdown: result.response }
                : {}),
              status: result.status,
              live: this.commandRuntime.context.streamOutput,
              summary: {
                durationMs: result.durationMs,
                workingDurationMs,
                tools: activeStats.tools,
                failedTools: activeStats.failedTools,
                retries: activeStats.retries,
                ...(result.status === 'completed' && result.usage?.inputTokens !== undefined
                  ? { inputTokens: result.usage.inputTokens }
                  : {}),
                ...(result.status === 'completed' && result.usage?.outputTokens !== undefined
                  ? { outputTokens: result.usage.outputTokens }
                  : {}),
                ...(result.status === 'completed' && result.finishReason !== undefined
                  ? { finishReason: result.finishReason }
                  : {})
              }
            }
          : entry
      );
    }
    if (result.status === 'failed') {
      this.notice({ tone: 'error', text: result.error.message });
    } else if (result.status === 'cancelled') {
      this.notice({ tone: 'warning', text: result.reason });
    }
    this.activeAssistantId = undefined;
    this.activeTurnId = undefined;
    this.activeTurnStats = undefined;
    this.lastTextFlushAt = 0;
    this.activity = undefined;
    this.emit();
  }

  abortCurrent(): boolean {
    if (this.pendingResolver) {
      this.pendingResolver.reject(new OperationAbortedError());
      return true;
    }
    if (this.activeAbort && !this.activeAbort.signal.aborted) {
      this.activeAbort.abort(new OperationAbortedError());
      return true;
    }
    return false;
  }

  requestExit(reason: string): void {
    this.abortCurrent();
    this.interactionState = 'exiting';
    this.exitReason = reason;
    this.emit();
  }

  resolvePending(value: unknown): void {
    this.pendingResolver?.resolve(value);
  }

  rejectPending(): void {
    this.pendingResolver?.reject(new OperationAbortedError());
  }

  updatePending(update: Partial<PendingInteraction>): void {
    if (!this.pending) {
      return;
    }
    this.pending = { ...this.pending, ...update } as PendingInteraction;
    this.emit();
  }

  private waitForInteraction<T>(
    pending: PendingInteraction,
    signal: AbortSignal,
    state: InteractionState
  ): Promise<T> {
    if (this.pendingResolver) {
      return Promise.reject(new Error('Another blocking interaction is already active'));
    }
    const previousState = this.interactionState;
    this.interactionState = state;
    this.pending = pending;
    if (this.activity && typeof this.activity !== 'string') {
      this.activity = pauseActivity(this.activity);
    }
    this.emit();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        if (this.pendingResolver?.id === pending.id) {
          this.pendingResolver = undefined;
          this.pending = undefined;
          if (this.interactionState !== 'exiting') {
            this.interactionState = previousState;
          }
          if (this.activity && typeof this.activity !== 'string') {
            this.activity = resumeActivity(this.activity);
          }
          this.emit();
        }
      };
      const rejectPending = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const resolvePending = (value: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value as T);
      };
      const onAbort = () => rejectPending(new OperationAbortedError());
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingResolver = {
        id: pending.id,
        resolve: resolvePending,
        reject: rejectPending,
        cleanup
      };
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  confirm(request: ConfirmRequest, signal: AbortSignal): Promise<boolean> {
    return this.waitForInteraction<boolean>(
      { id: this.id('confirm'), type: 'confirm', request, value: '' },
      signal,
      'approval'
    );
  }

  async select(request: SelectRequest, signal: AbortSignal): Promise<string | undefined> {
    const selected = Math.max(
      0,
      request.choices.findIndex((choice) => choice.value === request.initialValue)
    );
    return this.waitForInteraction<string | undefined>(
      { id: this.id('select'), type: 'select', request, selected },
      signal,
      'command'
    );
  }

  textInput(request: TextInputRequest, signal: AbortSignal): Promise<string | undefined> {
    return this.waitForInteraction<string | undefined>(
      { id: this.id('text'), type: 'text', request, value: '' },
      signal,
      'command'
    );
  }

  requestApproval(request: ToolApprovalRequest, signal: AbortSignal): Promise<ToolApprovalChoice> {
    return this.waitForInteraction<ToolApprovalChoice>(
      { id: this.id('approval'), type: 'approval', request, scroll: 0, value: '' },
      signal,
      'approval'
    );
  }

  requestUserInput(request: UserInputRequest, signal: AbortSignal): Promise<UserInputAnswers> {
    return this.waitForInteraction<UserInputAnswers>(
      { id: this.id('question'), type: 'question', request, answers: {} },
      signal,
      'question'
    );
  }

  async suspendTerminal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw new OperationAbortedError();
    }
    return operation();
  }

  async setHistoryEnabled(enabled: boolean): Promise<void> {
    await this.history.setEnabled(enabled);
    this.emit();
  }

  async clearHistory(): Promise<void> {
    await this.history.clear();
    this.emit();
  }

  historyStatus(): { enabled: boolean; entries: number; path: string } {
    return {
      enabled: this.history.isEnabled,
      entries: this.history.list().length,
      path: this.history.path
    };
  }

  async close(): Promise<void> {
    this.abortCurrent();
    if (this.textTimer) {
      clearTimeout(this.textTimer);
    }
    await this.commandRuntime.context.session?.close();
  }
}
