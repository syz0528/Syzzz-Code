import chalk from 'chalk';
import ora from 'ora';
import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import type { QueryEngine, ChatOptions } from './engine.js';
import type { AgentEvent, TurnResult } from './events.js';
import { consumeAgentTurn, HumanEventRenderer } from './cli-renderer.js';
import {
  COMMAND_CATEGORIES,
  COMMAND_CATEGORY_LABELS,
  CommandRegistry,
  createSlashSuggestionProvider,
  normalizeCommandExecutionResult,
  parseSlashCommand,
  type CommandChoice,
  type CommandDefinition,
  type CommandExecutionResult as StructuredCommandExecutionResult,
  type CommandHandlerResult as CommandExecutionResult
} from './interactive-commands.js';
import { AGENT_MODES, DEFAULT_AGENT_MODE, agentModeDescription, type AgentMode } from './modes.js';
import {
  DEFAULT_PERMISSION_MODE,
  formatPermissionModesHelp,
  parsePermissionMode,
  permissionModeDescription,
  permissionModeTitle,
  type PermissionMode
} from './permissions/mode.js';
import { TerminalInputController, type SuggestionProvider } from './terminal-input.js';
import { InlineInteractionPort } from './interaction/inline-port.js';
import type { InteractionPort } from './interaction/types.js';
import { WorkspaceInputHistory } from './interaction/history.js';
import {
  createContextSuggestionProvider,
  createSkillSuggestionProvider
} from './composition/suggestions.js';
import { SkillInstaller, type SkillInstallPreview } from './composition/skill-installer.js';
import {
  createSkill,
  validateSkillDescriptors,
  validateSkillPath
} from './composition/skill-authoring.js';
import { runSkillActivationEval } from './composition/skill-eval.js';
import type { UiFrameRate, UiLanguage } from './config.js';
import type { AIProvider } from './providers/base.js';
import type { SessionController } from './session-controller.js';
import { isAbortError, OperationAbortedError } from './tools/abort.js';
import {
  localizeCommandDescription,
  localizeCommandCategory,
  localizeSuggestionDescription,
  resolveUiLanguage
} from './ui-language.js';
import { inspectTerminalKeyboard, installTerminalShiftEnter } from './tui/terminal-keyboard.js';

const DOUBLE_INTERRUPT_WINDOW_MS = 2_000;
const COMMAND_PRIORITIES = {
  ask: 10,
  plan: 20,
  code: 30,
  status: 40,
  permissions: 50,
  model: 60,
  provider: 70,
  stream: 80,
  context: 81,
  skills: 82,
  language: 83,
  extensions: 84,
  mcp: 85,
  hooks: 86,
  agents: 87,
  trust: 88,
  untrust: 89,
  new: 90,
  resume: 100,
  save: 110,
  compact: 120,
  rename: 130,
  history: 135,
  terminalSetup: 137,
  ui: 138,
  setting: 139,
  help: 140,
  exit: 150
} as const;

export type StreamDisplayMode = 'on' | 'off';

const CONTEXT_WINDOW_PRESETS = [65_536, 131_072, 200_000] as const;

function parseContextWindowPreset(value: string): number | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, '');
  const aliases: Record<string, number> = {
    '64k': 65_536,
    '65536': 65_536,
    '128k': 131_072,
    '131072': 131_072,
    '200k': 200_000,
    '200000': 200_000
  };
  return aliases[normalized];
}

function formatTokenWindow(tokens: number): string {
  if (tokens === 65_536) return '64K';
  if (tokens === 131_072) return '128K';
  if (tokens === 200_000) return '200K';
  return `${Math.round(tokens / 1000)}K`;
}

export interface InteractiveProviderOption {
  id: string;
  name: string;
  model: string;
  models: readonly string[];
  available: boolean;
  unavailableReason?: string;
}

export interface InteractiveSessionOptions {
  streamOutput?: boolean;
  availableModels?: readonly string[];
  persistStreamOutput?: (enabled: boolean) => void | Promise<void>;
  persistSubagentsEnabled?: (enabled: boolean) => void | Promise<void>;
  persistModel?: (model: string, providerId: string) => void | Promise<void>;
  session?: SessionController;
  getProviderOptions?: () => readonly InteractiveProviderOption[];
  activateProvider?: (
    providerId: string,
    engine: QueryEngine
  ) => Promise<{ providerId: string; models: readonly string[] }>;
  modelsForProvider?: (providerId: string) => readonly string[];
  createSkillEvalProvider?: () => AIProvider;
  persistentHistory?: boolean;
  persistHistoryEnabled?: (enabled: boolean) => void | Promise<void>;
  contextWindowTokens?: number;
  persistContextWindow?: (tokens: number) => void | Promise<void>;
  uiLanguage?: UiLanguage;
  persistUiLanguage?: (language: UiLanguage) => void | Promise<void>;
  uiFrameRate?: UiFrameRate;
  persistUiFrameRate?: (frameRate: UiFrameRate) => void | Promise<void>;
  uiDiagnostics?: () => string;
}

export interface InteractiveTerminalReader {
  readLine(
    options: Parameters<TerminalInputController['readLine']>[0]
  ): ReturnType<TerminalInputController['readLine']>;
}

export interface InteractiveCommandContext {
  engine: QueryEngine;
  terminal: InteractiveTerminalReader;
  interaction: InteractionPort;
  structuredSelections: boolean;
  streamOutput: boolean;
  availableModels: readonly string[];
  persistStreamOutput?: (enabled: boolean) => void | Promise<void>;
  persistSubagentsEnabled?: (enabled: boolean) => void | Promise<void>;
  persistModel?: (model: string, providerId: string) => void | Promise<void>;
  session?: SessionController;
  getProviderOptions?: () => readonly InteractiveProviderOption[];
  activateProvider?: InteractiveSessionOptions['activateProvider'];
  modelsForProvider?: (providerId: string) => readonly string[];
  createSkillEvalProvider?: () => AIProvider;
  persistHistoryEnabled?: (enabled: boolean) => void | Promise<void>;
  contextWindowTokens: number;
  persistContextWindow?: (tokens: number) => void | Promise<void>;
  uiLanguage: UiLanguage;
  persistUiLanguage?: (language: UiLanguage) => void | Promise<void>;
  uiFrameRate: UiFrameRate;
  persistUiFrameRate?: (frameRate: UiFrameRate) => void | Promise<void>;
  uiDiagnostics?: () => string;
}

export interface InteractiveCommandRuntime {
  readonly context: InteractiveCommandContext;
  readonly registry: CommandRegistry<InteractiveCommandContext>;
  readonly suggestionProviders: readonly SuggestionProvider[];
  execute(input: string, signal: AbortSignal): Promise<StructuredCommandExecutionResult>;
}

const nativeConsole = globalThis.console;
const activeInteraction = new AsyncLocalStorage<InteractionPort>();
const console = {
  log(...values: unknown[]): void {
    const interaction = activeInteraction.getStore();
    if (interaction) {
      interaction.notice({ tone: 'info', text: format(...values) });
      return;
    }
    nativeConsole.log(...values);
  },
  error(...values: unknown[]): void {
    const interaction = activeInteraction.getStore();
    if (interaction) {
      interaction.notice({ tone: 'error', text: format(...values) });
      return;
    }
    nativeConsole.error(...values);
  },
  warn(...values: unknown[]): void {
    const interaction = activeInteraction.getStore();
    if (interaction) {
      interaction.notice({ tone: 'warning', text: format(...values) });
      return;
    }
    nativeConsole.warn(...values);
  }
};

function requireSession(commandContext: InteractiveCommandContext): SessionController {
  const session = commandContext.session;
  if (!session) {
    throw new Error('Session commands are unavailable in the current process');
  }
  return session;
}

function getEnginePermissionMode(engine: QueryEngine): PermissionMode {
  return typeof engine.getPermissionMode === 'function'
    ? engine.getPermissionMode()
    : DEFAULT_PERMISSION_MODE;
}

function setEnginePermissionMode(engine: QueryEngine, mode: PermissionMode): void {
  if (typeof engine.setPermissionMode === 'function') {
    engine.setPermissionMode(mode);
  }
}

function getProviderInfo(engine: QueryEngine) {
  return typeof engine.getProviderInfo === 'function' ? engine.getProviderInfo() : undefined;
}

function buildPrompt(agentMode: AgentMode, permissionMode: PermissionMode): string {
  return chalk.blue(`You [${agentMode}|${permissionMode}]: `);
}

interface ParsedInteractiveSkillManagement {
  target: string;
  scope: 'user' | 'project';
  ref?: string;
  skill?: string;
}

function parseInteractiveSkillManagement(
  tokens: readonly string[]
): ParsedInteractiveSkillManagement {
  const target = tokens[0];
  if (!target) {
    throw new Error('A Skill name or public HTTPS Git URL is required');
  }
  let scope: 'user' | 'project' = 'user';
  let ref: string | undefined;
  let skill: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!value || !['--scope', '--ref', '--skill'].includes(option)) {
      throw new Error(`Unknown or incomplete Skill option: ${option}`);
    }
    if (option === '--scope') {
      if (value !== 'user' && value !== 'project') {
        throw new Error('Skill scope must be user or project');
      }
      scope = value;
    } else if (option === '--ref') {
      ref = value;
    } else {
      skill = value;
    }
    index += 1;
  }
  return { target, scope, ...(ref ? { ref } : {}), ...(skill ? { skill } : {}) };
}

function formatInteractiveSkillPreview(preview: SkillInstallPreview): string {
  return [
    `${preview.action.toUpperCase()} Skill ${preview.name}`,
    ...(preview.sourceUrl ? [`Source: ${preview.sourceUrl}`] : []),
    ...(preview.previousCommit ? [`Previous commit: ${preview.previousCommit}`] : []),
    ...(preview.resolvedCommit ? [`Commit: ${preview.resolvedCommit}`] : []),
    `Target: ${preview.targetPath}`,
    `Files: ${preview.fileCount}; bytes: ${preview.totalBytes}; scripts: ${preview.scriptCount}`,
    ...(preview.files.length > 0
      ? ['File list:', ...preview.files.map((path) => `  ${path}`)]
      : []),
    'Skill installation does not execute scripts or change permissions/workspace trust.'
  ].join('\n');
}

function getEngineMode(engine: QueryEngine): AgentMode {
  return typeof engine.getMode === 'function' ? engine.getMode() : DEFAULT_AGENT_MODE;
}

function setEngineMode(engine: QueryEngine, mode: AgentMode): void {
  if (typeof engine.setMode !== 'function') {
    throw new Error('The current engine does not support work modes');
  }
  engine.setMode(mode);
}

function localText(context: InteractiveCommandContext, english: string, chinese: string): string {
  return resolveUiLanguage(context.uiLanguage) === 'zh-CN' ? chinese : english;
}

function permissionChoices(context: InteractiveCommandContext): readonly CommandChoice[] {
  const currentMode = getEnginePermissionMode(context.engine);
  const scope = context.session?.getStatus().permissionScope ?? 'none';
  return [
    {
      value: 'safe',
      label: localText(context, 'Safe', '安全模式'),
      description: localText(
        context,
        'Require approval and clear persisted edit grants for this workspace',
        '恢复逐次审批，并清除当前会话和工作区的编辑授权'
      ),
      current: currentMode === 'safe'
    },
    {
      value: 'acceptEdits',
      label: localText(context, 'Allow edits for this conversation', '本会话允许编辑'),
      description: localText(
        context,
        'Persist file edit approval only for this saved session; Shell still asks',
        '仅随当前已保存会话持久化；Shell 仍逐次审批'
      ),
      current: currentMode === 'acceptEdits' && scope === 'session'
    },
    {
      value: 'workspace',
      label: localText(context, 'Allow edits for this workspace', '本工作区允许编辑'),
      description: localText(
        context,
        'Persist file edit approval for sessions in this folder; Shell still asks',
        '对当前文件夹中的会话持久化；Shell 仍逐次审批'
      ),
      current: currentMode === 'acceptEdits' && scope === 'workspace'
    },
    {
      value: 'fullAccess',
      label: localText(context, permissionModeTitle('fullAccess'), '完全访问'),
      description: localText(
        context,
        `${permissionModeDescription('fullAccess')} Never persisted.`,
        '取消本会话审批提示；风险较高且永不持久化'
      ),
      current: currentMode === 'fullAccess'
    }
  ];
}

async function handlePermissionsCommand(
  context: InteractiveCommandContext,
  argument: string | undefined,
  signal: AbortSignal
): Promise<void> {
  const engine = context.engine;
  const currentMode = getEnginePermissionMode(engine);
  if (!argument) {
    console.log(chalk.cyan(`\n${formatPermissionModesHelp(currentMode)}\n`));
    console.log(
      chalk.gray(
        '  workspace    Allow file edits across sessions in this folder; Shell still asks\n'
      )
    );
    return;
  }

  const normalizedArgument = argument.trim().toLowerCase();
  const nextMode =
    normalizedArgument === 'workspace' ? 'acceptEdits' : parsePermissionMode(argument);
  const persistenceScope = normalizedArgument === 'workspace' ? 'workspace' : 'session';
  if (!nextMode) {
    console.log(chalk.red(`\nUnknown permission mode: ${argument}`));
    console.log(chalk.gray('Use: /permissions safe | acceptEdits | workspace | fullAccess\n'));
    return;
  }
  const currentScope = context.session?.getStatus().permissionScope ?? 'none';
  if (
    nextMode === currentMode &&
    (nextMode !== 'acceptEdits' || currentScope === persistenceScope)
  ) {
    console.log(
      chalk.green(`\nPermission mode is already ${permissionModeTitle(nextMode)} (${nextMode}).\n`)
    );
    return;
  }

  if (nextMode === 'fullAccess') {
    console.log(chalk.red('\nWARNING: Full Access disables approval prompts for this session.'));
    console.log(
      chalk.yellow(
        'File tools remain workspace-bound, but Shell can still affect the whole account.'
      )
    );
    console.log(chalk.yellow('Type y to confirm. Any other input cancels.'));
    let confirmed: boolean;
    try {
      confirmed = await context.interaction.confirm(
        {
          title: 'Enable Full Access for this session?',
          message:
            'Full Access disables approval prompts for this session. File tools remain workspace-bound, but Shell can still affect the whole account.',
          confirmToken: 'y'
        },
        signal
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw new OperationAbortedError('Permission command cancelled');
      }
      throw error;
    }
    if (!confirmed) {
      console.log(chalk.yellow('\nFull Access not enabled. Permission mode unchanged.\n'));
      return;
    }
  }

  if (context.session) {
    await context.session.setPermissionMode(nextMode, persistenceScope);
  } else {
    setEnginePermissionMode(engine, nextMode);
  }
  console.log(
    chalk.green(`\nPermission mode set to ${permissionModeTitle(nextMode)} (${nextMode}).`)
  );
  console.log(
    chalk.gray(
      nextMode === 'fullAccess'
        ? 'Full Access applies only to this process and is never persisted.\n'
        : nextMode === 'safe'
          ? 'Persisted edit grants for this conversation and workspace were cleared.\n'
          : `Edit approval follows this ${persistenceScope === 'workspace' ? 'workspace' : 'conversation'}; Shell still requires approval.\n`
    )
  );
}

export async function consumeInteractiveTurn(
  engine: QueryEngine,
  message: string,
  options: ChatOptions,
  onEvent: (event: AgentEvent) => void
): Promise<TurnResult> {
  if (typeof engine.runTurn === 'function') {
    return consumeAgentTurn(engine.runTurn(message, options), onEvent);
  }

  const response = await engine.chat(message, options);
  return {
    status: 'completed',
    response,
    durationMs: 0
  };
}

function streamChoices(context: InteractiveCommandContext): readonly CommandChoice[] {
  return [
    {
      value: 'on',
      label: localText(context, 'On', '开启'),
      description: localText(
        context,
        'Show assistant text as it arrives.',
        '逐步显示到达的回答正文。'
      ),
      current: context.streamOutput
    },
    {
      value: 'off',
      label: localText(context, 'Off', '关闭'),
      description: localText(
        context,
        'Buffer assistant text until the turn completes.',
        '等待当前回合完成后一次显示正文。'
      ),
      current: !context.streamOutput
    }
  ];
}

type SettingSection = 'language' | 'stream' | 'fps' | 'history' | 'context';

function settingSectionChoices(context: InteractiveCommandContext): readonly CommandChoice[] {
  return [
    {
      value: 'language',
      label: localText(context, 'Language', '界面语言'),
      description: localText(
        context,
        'Local command and interface descriptions',
        '本地命令与界面说明语言'
      )
    },
    {
      value: 'stream',
      label: localText(context, 'Streaming display', '流式展示'),
      description: localText(
        context,
        'Progressive assistant text in the terminal',
        '在终端中渐进显示回答正文'
      )
    },
    {
      value: 'fps',
      label: localText(context, 'TUI frame rate', 'TUI 帧率'),
      description: localText(context, 'Automatic, 30 FPS, or 60 FPS', '自动、30 FPS 或 60 FPS')
    },
    {
      value: 'history',
      label: localText(context, 'Input history', '输入历史'),
      description: localText(
        context,
        'Workspace-scoped submitted input history',
        '按工作区保存主动提交的输入'
      )
    },
    {
      value: 'context',
      label: localText(context, 'Context window', '上下文窗口'),
      description: localText(
        context,
        'Fallback budget for models without an override',
        '未单独配置模型的默认上下文预算'
      )
    }
  ];
}

function settingValueChoices(
  section: SettingSection,
  context: InteractiveCommandContext
): readonly CommandChoice[] {
  if (section === 'language') {
    return [
      {
        value: 'auto',
        label: localText(context, 'Auto', '自动'),
        current: context.uiLanguage === 'auto'
      },
      { value: 'zh-CN', label: '中文', current: context.uiLanguage === 'zh-CN' },
      { value: 'en', label: 'English', current: context.uiLanguage === 'en' }
    ];
  }
  if (section === 'stream') return streamChoices(context);
  if (section === 'fps') {
    return [
      {
        value: 'auto',
        label: localText(context, 'Auto', '自动'),
        description: localText(
          context,
          'Adapt to the detected terminal host',
          '根据检测到的终端环境自动调整'
        ),
        current: context.uiFrameRate === 'auto'
      },
      { value: '30', label: '30 FPS', current: context.uiFrameRate === 30 },
      { value: '60', label: '60 FPS', current: context.uiFrameRate === 60 }
    ];
  }
  if (section === 'history') {
    const enabled = context.interaction.historyStatus().enabled;
    return [
      { value: 'on', label: localText(context, 'On', '开启'), current: enabled },
      { value: 'off', label: localText(context, 'Off', '关闭'), current: !enabled }
    ];
  }
  return CONTEXT_WINDOW_PRESETS.map((tokens) => ({
    value: formatTokenWindow(tokens).toLowerCase(),
    label: formatTokenWindow(tokens),
    current: context.contextWindowTokens === tokens
  }));
}

function modelChoices(context: InteractiveCommandContext): readonly CommandChoice[] {
  const currentModel = getProviderInfo(context.engine)?.model;
  return context.availableModels.map((model) => ({
    value: model,
    description:
      model === currentModel ? localText(context, 'Current model', '当前模型') : undefined,
    current: model === currentModel
  }));
}

function formatStatus(context: InteractiveCommandContext): string {
  const status = context.engine.getStatus();
  const sessionStatus = context.session?.getStatus();
  const extensions = (status as { extensions?: typeof status.extensions }).extensions;
  const composition = (status as { composition?: typeof status.composition }).composition;
  const contextPercent =
    status.context.contextWindowTokens > 0
      ? Math.min(
          100,
          Math.round(
            (status.context.estimatedInputTokens / status.context.contextWindowTokens) * 100
          )
        )
      : 0;
  const lines = [
    'Session status',
    `  Session:      ${status.sessionId}`,
    `  Workspace:    ${status.workspaceRoot}`,
    `  Provider:     ${status.provider.name} (${status.provider.type})`,
    `  Model:        ${status.provider.model}`,
    ...(status.lastReportedModel ? [`  Reported:     ${status.lastReportedModel}`] : []),
    `  Work mode:    ${status.mode}`,
    `  Permissions:  ${status.permissionMode}` +
      `${sessionStatus ? ` (${sessionStatus.permissionScope})` : ''}`,
    `  Context:      ${status.context.estimatedInputTokens} / ` +
      `${status.context.contextWindowTokens} tokens (${contextPercent}%)`,
    `  Compactions:  ${status.context.compactions}`,
    `  Usage:        ${status.totalUsage.inputTokens} in / ` +
      `${status.totalUsage.outputTokens} out`,
    `  Messages:     ${status.messageCount}`,
    ...(composition
      ? [
          `  AGENTS:       ${composition.instructions.loaded} loaded`,
          `  References:   ${composition.context.lastReferenceCount} last turn`,
          `  Skills:       ${composition.skills.available} available / ` +
            `${composition.skills.disabled} disabled`
        ]
      : []),
    ...(extensions
      ? [
          `  MCP:          ${extensions.mcp.ready} ready / ` +
            `${extensions.mcp.configured} configured` +
            (extensions.inactiveProject?.mcpServers
              ? ` / ${extensions.inactiveProject.mcpServers} project inactive`
              : ''),
          `  Hooks:        ${extensions.hooks.enabled} enabled / ` +
            `${extensions.hooks.configured} configured` +
            (extensions.inactiveProject?.hooks
              ? ` / ${extensions.inactiveProject.hooks} project inactive`
              : ''),
          `  Subagents:    ${
            !extensions.subagents.enabled
              ? 'off'
              : extensions.subagents.available
                ? 'available'
                : 'Provider unsupported'
          }`,
          `  Trust:        ${
            extensions.trustState === 'trusted'
              ? 'workspace definition trusted'
              : extensions.trustState === 'review-required'
                ? 'review required'
                : extensions.projectConfigurationPresent
                  ? 'project extensions inactive'
                  : 'no project extensions'
          }`
        ]
      : []),
    ...(sessionStatus
      ? [
          `  Title:        ${sessionStatus.title}`,
          `  Autosave:     ${sessionStatus.autoSave ? 'on' : 'off'}`,
          `  Persistence:  ${status.persistence.state}` +
            `${status.persistence.dirty ? ' (unsaved)' : ''}`
        ]
      : [
          `  Persistence:  ${status.persistence.state}` +
            `${status.persistence.dirty ? ' (unsaved)' : ''}`
        ])
  ];
  if (status.context.compactionCircuitOpen) {
    lines.push('  Context:      compaction circuit open');
  }
  if (resolveUiLanguage(context.uiLanguage) !== 'zh-CN') return lines.join('\n');
  const labels = new Map([
    ['Session', '会话'],
    ['Workspace', '工作区'],
    ['Provider', '提供商'],
    ['Model', '模型'],
    ['Reported', '服务端报告'],
    ['Work mode', '工作模式'],
    ['Permissions', '权限'],
    ['Context', '上下文'],
    ['Compactions', '压缩次数'],
    ['Usage', '用量'],
    ['Messages', '消息'],
    ['References', '引用'],
    ['Skills', '技能'],
    ['Hooks', 'Hooks'],
    ['Subagents', '子智能体'],
    ['Trust', '信任'],
    ['Title', '标题'],
    ['Autosave', '自动保存'],
    ['Persistence', '持久化']
  ]);
  return lines
    .map((line, index) => {
      if (index === 0) return '会话状态';
      for (const [english, chinese] of labels) {
        const prefix = `  ${english}:`;
        if (line.startsWith(prefix))
          return `  ${chinese}：${line.slice(prefix.length).trimStart()}`;
      }
      return line;
    })
    .join('\n');
}

function formatExtensionReload(
  result: Awaited<ReturnType<NonNullable<ReturnType<QueryEngine['getExtensionRuntime']>>['reload']>>
): string {
  const lines = [
    `Trust: ${result.trustState}`,
    `MCP: ${result.mcp.configured} configured, ${result.mcp.ready} ready, ` +
      `${result.mcp.error} error, ${result.mcp.disconnected} disconnected`,
    `Hooks: ${result.hooks.enabled} enabled / ` +
      `${result.hooks.configured} configured, ${result.hooks.error} error`
  ];
  if (result.warnings.length > 0) {
    lines.push('Warnings:', ...result.warnings.map((warning) => `  ${warning}`));
  }
  return lines.join('\n');
}

function formatExtensionDetails(
  status: ReturnType<NonNullable<ReturnType<QueryEngine['getExtensionRuntime']>>['getStatus']>
): string {
  const lines = [
    'Extensions',
    `  Trust: ${status.trustState}`,
    `  MCP: ${status.mcp.ready} ready / ${status.mcp.configured} configured`
  ];
  for (const server of status.mcp.servers) {
    lines.push(
      `    ${server.name}: ${server.state}, ${server.toolCount} tools, ` +
        `${server.protocolMode}` +
        `${
          server.negotiatedProtocolVersion ? ` -> ${server.negotiatedProtocolVersion}` : ''
        } [${server.source}]` +
        `${server.errorCode ? ` (${server.errorCode})` : ''}`
    );
  }
  lines.push(
    `  Hooks: ${status.hooks.enabled} enabled / ` + `${status.hooks.configured} configured`
  );
  for (const hook of status.hooks.entries) {
    lines.push(
      `    ${hook.name}: ${hook.event}, ` +
        `${hook.enabled ? 'enabled' : 'disabled'} [${hook.source}]` +
        `${hook.lastOutcome ? `, last ${hook.lastOutcome}` : ''}` +
        `${hook.lastDurationMs === undefined ? '' : ` in ${Math.round(hook.lastDurationMs)}ms`}` +
        `${hook.lastErrorCode ? ` (${hook.lastErrorCode})` : ''}`
    );
  }
  const budgets = status.subagents.budgets;
  lines.push(
    `  Subagents: ${status.subagents.enabled ? 'on' : 'off'}, ` +
      `${status.subagents.available ? 'Provider supported' : 'Provider unsupported'}`,
    `    per turn ${budgets.maxPerTurn}, rounds ${budgets.maxToolRounds}, ` +
      `tools ${budgets.maxToolCalls}, Provider calls ${budgets.maxProviderCalls}`,
    `    ${budgets.softTokenBudget}/${budgets.hardTokenBudget} tokens, ` +
      `${budgets.softTimeoutMs / 1000}/${budgets.hardTimeoutMs / 1000}s`,
    ...(budgets.lastStopReason ? [`    last stop: ${budgets.lastStopReason}`] : [])
  );
  if (status.warnings.length > 0) {
    lines.push('  Warnings:', ...status.warnings.map((warning) => `    ${warning}`));
  }
  return lines.join('\n');
}

function syncSessionContext(context: InteractiveCommandContext): void {
  if (!context.session) {
    return;
  }
  context.engine = context.session.engine;
  context.availableModels = context.modelsForProvider?.(context.session.providerId) ?? [
    context.engine.getProviderInfo().model
  ];
}

async function confirmDiscardIfNeeded(
  context: InteractiveCommandContext,
  signal: AbortSignal
): Promise<boolean> {
  if (
    !context.session ||
    context.session.getStatus().autoSave ||
    !context.session.hasUnsavedChanges()
  ) {
    return true;
  }
  return context.interaction.confirm(
    {
      title: 'Discard unsaved session changes?',
      message: 'The current session has unsaved changes.',
      confirmToken: 'y'
    },
    signal
  );
}

function findConfiguredModel(models: readonly string[], requested: string): string | undefined {
  const normalized = requested.trim().toLowerCase();
  return models.find((model) => model.toLowerCase() === normalized);
}

function providerChoices(context: InteractiveCommandContext): readonly CommandChoice[] {
  const currentProviderId = context.session?.providerId;
  return (context.getProviderOptions?.() ?? []).map((provider) => ({
    value: provider.id,
    label: provider.name,
    description: provider.available
      ? `${provider.model}${provider.id === currentProviderId ? localText(context, ' (current)', '（当前）') : ''}`
      : (provider.unavailableReason ??
        localText(context, 'Credentials are not configured', '尚未配置凭证')),
    current: provider.id === currentProviderId
  }));
}

async function chooseFromNumberedList<T>(
  values: readonly T[],
  format: (value: T, index: number) => string,
  prompt: string,
  terminal: InteractiveTerminalReader,
  signal: AbortSignal
): Promise<T | undefined> {
  values.forEach((value, index) => {
    console.log(format(value, index));
  });
  const answer = await terminal.readLine({
    prompt,
    signal
  });
  if (answer.type === 'interrupt') {
    throw new OperationAbortedError('Selection cancelled');
  }
  if (answer.type !== 'line') {
    return undefined;
  }
  const normalized = answer.value.trim();
  const selectedIndex = normalized ? Number.parseInt(normalized, 10) - 1 : 0;
  return Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < values.length
    ? values[selectedIndex]
    : undefined;
}

function formatCommandsHelp(
  registry: CommandRegistry<InteractiveCommandContext>,
  context: InteractiveCommandContext
): string {
  const language = resolveUiLanguage(context.uiLanguage);
  const chinese = language === 'zh-CN';
  const lines = [chinese ? '可用命令：' : 'Available commands:'];
  const commands = registry.search('', context);
  for (const category of COMMAND_CATEGORIES) {
    const categoryCommands = commands.filter((command) => command.category === category);
    if (categoryCommands.length === 0) {
      continue;
    }
    lines.push(
      '',
      `${localizeCommandCategory(category, COMMAND_CATEGORY_LABELS[category], language)}${chinese ? '：' : ':'}`
    );
    for (const command of categoryCommands) {
      const aliases = command.aliases?.length
        ? ` (${chinese ? '别名' : 'aliases'}: ${command.aliases.map((alias) => `/${alias}`).join(', ')})`
        : '';
      const hint = command.argumentHint ? ` ${command.argumentHint}` : '';
      lines.push(`  /${command.name}${hint}${aliases}`);
      lines.push(`    ${localizeCommandDescription(command.name, command.description, language)}`);
    }
  }
  lines.push(
    '',
    chinese
      ? '在消息开头输入 // 可发送字面量斜杠。'
      : 'Type // at the start to send a literal slash message.'
  );
  return lines.join('\n');
}

export function createCommandRegistry(): CommandRegistry<InteractiveCommandContext> {
  const registry = new CommandRegistry<InteractiveCommandContext>();
  const register = (command: CommandDefinition<InteractiveCommandContext>) =>
    registry.register(command);

  for (const mode of AGENT_MODES) {
    register({
      name: mode,
      category: 'work',
      priority: COMMAND_PRIORITIES[mode],
      description: agentModeDescription(mode),
      argumentHint: '[message]',
      async execute(argument, commandContext): Promise<CommandExecutionResult> {
        setEngineMode(commandContext.engine, mode);
        await commandContext.session?.stateChanged();
        console.log(chalk.green(`\nWork mode set to ${mode}.\n`));
        return argument ? { submitMessage: argument } : 'continue';
      }
    });
  }

  register({
    name: 'status',
    category: 'session',
    priority: COMMAND_PRIORITIES.status,
    description: 'Show session, provider, mode, token, and context status.',
    execute(_argument, commandContext) {
      console.log(chalk.cyan(`\n${formatStatus(commandContext)}\n`));
      return 'continue';
    }
  });

  register({
    name: 'new',
    aliases: ['clear'],
    category: 'session',
    priority: COMMAND_PRIORITIES.new,
    description: 'Start a new session while preserving the current saved session.',
    argumentHint: '[title]',
    isEnabled: (commandContext) => Boolean(commandContext.session),
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      if (!(await confirmDiscardIfNeeded(commandContext, signal))) {
        console.log(chalk.yellow('\nNew session cancelled.\n'));
        return 'continue';
      }
      const result = await requireSession(commandContext).newSession(argument);
      syncSessionContext(commandContext);
      console.log(
        chalk.green(`\nStarted session ${result.sessionId.slice(0, 8)} (${result.title}).\n`)
      );
      if (result.warning) {
        console.log(chalk.yellow(`${result.warning}\n`));
      }
      return 'continue';
    }
  });

  register({
    name: 'resume',
    category: 'session',
    priority: COMMAND_PRIORITIES.resume,
    description: 'Resume a saved session in the current workspace.',
    argumentHint: '[id-or-prefix]',
    isEnabled: (commandContext) => Boolean(commandContext.session),
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      let selection = argument;
      if (!selection) {
        const sessions = (await requireSession(commandContext).list()).filter(
          (session) => session.available
        );
        if (sessions.length === 0) {
          console.log(chalk.yellow('\nNo saved sessions for this workspace.\n'));
          return 'continue';
        }
        const selectedId = await commandContext.interaction.select(
          {
            title: 'Resume session',
            choices: sessions.map((session) => ({
              value: session.sessionId,
              label: `${session.title} [${session.sessionId.slice(0, 8)}]`,
              description: session.updatedAt
            })),
            initialValue: sessions[0]?.sessionId
          },
          signal
        );
        if (!selectedId) {
          console.log(chalk.yellow('\nInvalid selection.\n'));
          return 'continue';
        }
        selection = selectedId;
      }
      if (!(await confirmDiscardIfNeeded(commandContext, signal))) {
        console.log(chalk.yellow('\nResume cancelled.\n'));
        return 'continue';
      }
      const result = await requireSession(commandContext).resume(selection);
      syncSessionContext(commandContext);
      console.log(chalk.green(`\nResumed ${result.title} [${result.sessionId.slice(0, 8)}].`));
      console.log(chalk.gray('Permission mode reset to safe.\n'));
      if (result.warning) {
        console.log(chalk.yellow(`${result.warning}\n`));
      }
      return 'continue';
    }
  });

  register({
    name: 'rename',
    category: 'session',
    priority: COMMAND_PRIORITIES.rename,
    description: 'Rename the current session.',
    argumentHint: '<title>',
    isEnabled: (commandContext) => Boolean(commandContext.session),
    async execute(argument, commandContext): Promise<CommandExecutionResult> {
      if (!argument) {
        console.log(chalk.red('\nUse: /rename <title>\n'));
        return 'continue';
      }
      await requireSession(commandContext).rename(argument);
      console.log(chalk.green(`\nSession renamed to ${argument.trim()}.\n`));
      return 'continue';
    }
  });

  register({
    name: 'save',
    category: 'session',
    priority: COMMAND_PRIORITIES.save,
    description: 'Persist the current session immediately.',
    isEnabled: (commandContext) => Boolean(commandContext.session),
    async execute(_argument, commandContext): Promise<CommandExecutionResult> {
      const metadata = await requireSession(commandContext).save();
      console.log(chalk.green(`\nSaved ${metadata.title} [${metadata.sessionId.slice(0, 8)}].\n`));
      return 'continue';
    }
  });

  register({
    name: 'compact',
    category: 'session',
    priority: COMMAND_PRIORITIES.compact,
    description: 'Compact the current conversation context now.',
    async execute(_argument, commandContext, signal): Promise<CommandExecutionResult> {
      if (typeof commandContext.engine.compactContext !== 'function') {
        throw new Error('The current engine does not support manual compaction');
      }
      const spinner = commandContext.structuredSelections
        ? undefined
        : ora({
            text: 'Compacting context...',
            discardStdin: false
          }).start();
      if (!spinner) {
        commandContext.interaction.notice({
          tone: 'info',
          text: 'Compacting context...',
          transient: true
        });
      }
      const renderer = new HumanEventRenderer({
        streamOutput: false,
        spinner
      });
      const operation = commandContext.engine.compactContext({ signal });
      let result;
      try {
        while (true) {
          const next = await operation.next();
          if (next.done) {
            result = next.value;
            break;
          }
          renderer.handle(next.value);
        }
      } finally {
        renderer.stop();
      }
      if (result.status === 'completed') {
        await commandContext.session?.stateChanged();
        console.log(
          chalk.green(
            `\nContext compacted ${result.beforeTokens} -> ` +
              `${result.afterTokens} tokens (${result.compactions} pass(es)).\n`
          )
        );
      } else if (result.status === 'skipped') {
        console.log(
          chalk.yellow(`\nContext compaction skipped: ${result.reason.replaceAll('_', ' ')}.\n`)
        );
      } else if (result.status === 'cancelled') {
        throw new OperationAbortedError(result.reason);
      } else {
        throw new Error(result.error.message);
      }
      return 'continue';
    }
  });

  register({
    name: 'provider',
    category: 'runtime',
    priority: COMMAND_PRIORITIES.provider,
    description: 'Switch to another configured Provider.',
    argumentHint: '[provider]',
    choices: providerChoices,
    isEnabled: (commandContext) => Boolean(commandContext.activateProvider),
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      let providerId = argument?.trim();
      const providers = commandContext.getProviderOptions?.() ?? [];
      if (!providerId) {
        console.log(chalk.cyan('\nConfigured providers:\n'));
        const selected = await chooseFromNumberedList(
          providers,
          (provider, index) =>
            `  ${index + 1}. ${provider.name} [${provider.id}] ` +
            `${provider.available ? provider.model : '(unavailable)'}`,
          '\nSelect provider [1]: ',
          commandContext.terminal,
          signal
        );
        if (!selected) {
          console.log(chalk.yellow('\nInvalid selection.\n'));
          return 'continue';
        }
        providerId = selected.id;
      }
      if (!providerId) {
        throw new Error('Provider selection did not return a provider identifier');
      }
      const configured = providers.find(
        (provider) => provider.id.toLowerCase() === providerId.toLowerCase()
      );
      if (!configured) {
        console.log(chalk.red(`\nUnknown provider: ${providerId}\n`));
        return 'continue';
      }
      if (!configured.available) {
        console.log(
          chalk.red(
            `\nProvider is unavailable: ` +
              `${configured.unavailableReason ?? 'credentials are missing'}\n`
          )
        );
        return 'continue';
      }
      const activateProvider = commandContext.activateProvider;
      if (!activateProvider) {
        throw new Error('Provider switching is unavailable in the current process');
      }
      const activated = await activateProvider(configured.id, commandContext.engine);
      await commandContext.session?.setProviderReference(activated.providerId);
      commandContext.availableModels = activated.models;
      console.log(
        chalk.green(
          `\nProvider switched to ${configured.name} ` +
            `(${commandContext.engine.getProviderInfo().model}).\n`
        )
      );
      return 'continue';
    }
  });

  register({
    name: 'stream',
    category: 'runtime',
    priority: COMMAND_PRIORITIES.stream,
    description: 'Control live assistant text display.',
    argumentHint: '[on|off]',
    choices: streamChoices,
    async execute(argument, commandContext): Promise<CommandExecutionResult> {
      if (!argument) {
        console.log(
          chalk.cyan(
            localText(
              commandContext,
              `\nStream display is ${commandContext.streamOutput ? 'on' : 'off'}.`,
              `\n流式展示当前为${commandContext.streamOutput ? '开启' : '关闭'}。`
            )
          )
        );
        console.log(
          chalk.gray(
            localText(
              commandContext,
              'Use: /stream on | /stream off\n',
              '用法：/stream on | /stream off\n'
            )
          )
        );
        return 'continue';
      }
      const normalized = argument.trim().toLowerCase();
      if (normalized !== 'on' && normalized !== 'off') {
        console.log(
          chalk.red(
            localText(
              commandContext,
              `\nUnknown stream display mode: ${argument}`,
              `\n未知流式展示模式：${argument}`
            )
          )
        );
        console.log(
          chalk.gray(
            localText(
              commandContext,
              'Use: /stream on | /stream off\n',
              '用法：/stream on | /stream off\n'
            )
          )
        );
        return 'continue';
      }
      const enabled = normalized === 'on';
      if (enabled === commandContext.streamOutput) {
        console.log(
          chalk.green(
            localText(
              commandContext,
              `\nStream display is already ${normalized}.\n`,
              `\n流式展示已经${enabled ? '开启' : '关闭'}。\n`
            )
          )
        );
        return 'continue';
      }

      await commandContext.persistStreamOutput?.(enabled);
      commandContext.streamOutput = enabled;
      console.log(
        chalk.green(
          localText(
            commandContext,
            `\nStream display set to ${normalized}.`,
            `\n流式展示已${enabled ? '开启' : '关闭'}。`
          )
        )
      );
      console.log(
        chalk.gray(
          localText(
            commandContext,
            'Provider streaming and AgentEvent delivery remain enabled.\n',
            'Provider 流式传输与 AgentEvent 事件投递仍保持开启。\n'
          )
        )
      );
      return 'continue';
    }
  });

  register({
    name: 'context',
    category: 'runtime',
    priority: COMMAND_PRIORITIES.context,
    description: 'Show context usage, reload instructions, or select a context window budget.',
    argumentHint: '[reload|64k|128k|200k]',
    choices: (commandContext) => [
      ...CONTEXT_WINDOW_PRESETS.map((tokens) => ({
        value: formatTokenWindow(tokens).toLowerCase(),
        label: `${formatTokenWindow(tokens)} ${localText(commandContext, 'context', '上下文')}`,
        description: localText(
          commandContext,
          'Persist this fallback context budget for configured models without an override',
          '为未单独配置窗口的模型持久化此 fallback 上下文预算'
        ),
        current: commandContext.contextWindowTokens === tokens
      })),
      {
        value: 'reload',
        description: localText(
          commandContext,
          'Reload AGENTS.md and Skill metadata',
          '重新加载 AGENTS.md 与 Skill 元数据'
        )
      }
    ],
    async execute(argument, commandContext): Promise<CommandExecutionResult> {
      const runtime = commandContext.engine.getCompositionRuntime?.();
      const normalized = argument?.trim().toLowerCase();
      if (normalized === 'reload') {
        if (!runtime) {
          console.log(chalk.yellow('\nTask composition is unavailable.\n'));
          return 'continue';
        }
        await runtime.reload();
        console.log(chalk.green('\nContext and Skill metadata reloaded.\n'));
      } else if (normalized) {
        const tokens = parseContextWindowPreset(normalized);
        if (!tokens) {
          console.log(chalk.red('\nUse: /context reload | 64k | 128k | 200k\n'));
          return 'continue';
        }
        await commandContext.persistContextWindow?.(tokens);
        commandContext.engine.setDefaultContextWindowTokens(tokens);
        commandContext.contextWindowTokens = tokens;
        console.log(chalk.green(`\nContext fallback budget set to ${formatTokenWindow(tokens)}.`));
        console.log(
          chalk.gray('A model-specific Provider context override remains authoritative when set.\n')
        );
      }
      const engineStatus = commandContext.engine.getStatus();
      console.log(chalk.cyan('\nTask context\n'));
      console.log(
        `  Usage: ${engineStatus.context.estimatedInputTokens} / ` +
          `${engineStatus.context.contextWindowTokens} tokens`
      );
      console.log(`  Fallback: ${formatTokenWindow(commandContext.contextWindowTokens)}`);
      if (runtime) {
        const status = runtime.getStatus();
        console.log(`  AGENTS.md: ${status.instructions.loaded} loaded`);
        for (const source of status.instructions.sources) {
          console.log(
            `    ${source.source}: ${source.path} (${source.byteCount} bytes)` +
              `${source.truncated ? ' [truncated]' : ''}`
          );
        }
        console.log(
          `  References: max ${status.context.maximumReferencesPerTurn} / ` +
            `${status.context.maximumFileBytes} bytes each / ` +
            `${status.context.maximumTotalBytes} bytes total`
        );
        for (const warning of status.warnings) {
          console.log(chalk.yellow(`  Warning: ${warning}`));
        }
      }
      console.log('');
      return 'continue';
    }
  });

  register({
    name: 'language',
    category: 'runtime',
    priority: COMMAND_PRIORITIES.language,
    description: 'Choose Chinese or English descriptions for local interactive commands.',
    argumentHint: '[auto|zh-CN|en]',
    choices: (commandContext) =>
      (
        [
          {
            value: 'auto',
            label: localText(commandContext, 'Auto', '自动'),
            description: localText(commandContext, 'Follow the terminal locale', '跟随终端区域设置')
          },
          { value: 'zh-CN', label: '中文', description: '使用中文本地描述' },
          {
            value: 'en',
            label: 'English',
            description: localText(
              commandContext,
              'Use English local descriptions',
              '使用英文本地描述'
            )
          }
        ] as const
      ).map((choice) => ({
        ...choice,
        current: commandContext.uiLanguage === choice.value
      })),
    async execute(argument, commandContext): Promise<CommandExecutionResult> {
      const language = argument?.trim();
      if (language !== 'auto' && language !== 'zh-CN' && language !== 'en') {
        console.log(
          chalk.red(
            localText(
              commandContext,
              '\nUse: /language auto | zh-CN | en\n',
              '\n用法：/language auto | zh-CN | en\n'
            )
          )
        );
        return 'continue';
      }
      await commandContext.persistUiLanguage?.(language);
      commandContext.uiLanguage = language;
      console.log(
        chalk.green(
          localText(
            commandContext,
            `\nLocal description language set to ${language === 'zh-CN' ? 'Chinese' : language === 'en' ? 'English' : 'Auto'}.\n`,
            `\n本地界面说明语言已设置为${language === 'zh-CN' ? '中文' : language === 'en' ? '英文' : '自动'}。\n`
          )
        )
      );
      return 'continue';
    }
  });

  register({
    name: 'skills',
    category: 'extensions',
    priority: COMMAND_PRIORITIES.skills,
    description: 'Discover or safely manage Agent Skills.',
    argumentHint:
      '[list|inspect|reload|doctor|create|validate|test|enable|disable|install|update|rollback|remove] [target]',
    isEnabled: (commandContext) => Boolean(commandContext.engine.getCompositionRuntime?.()),
    choices: (commandContext) => {
      const runtime = commandContext.engine.getCompositionRuntime?.();
      const skills = runtime?.listSkills().filter((skill) => !skill.shadowed) ?? [];
      return [
        {
          value: 'list',
          label: localText(commandContext, 'List', '列出'),
          description: localText(commandContext, 'List discovered Skills', '列出已发现的 Skills')
        },
        {
          value: 'reload',
          label: localText(commandContext, 'Reload', '重新加载'),
          description: localText(commandContext, 'Reload Skill metadata', '重新加载 Skill 元数据')
        },
        {
          value: 'doctor',
          label: localText(commandContext, 'Doctor', '诊断'),
          description: localText(commandContext, 'Show Skill diagnostics', '查看 Skill 诊断信息')
        },
        {
          value: 'create',
          label: localText(commandContext, 'Create', '新建'),
          description: localText(
            commandContext,
            'Create an explicit-only Skill',
            '新建仅显式调用的 Skill'
          )
        },
        {
          value: 'validate',
          label: localText(commandContext, 'Validate', '验证'),
          description: localText(
            commandContext,
            'Validate discovered Skills',
            '验证已发现的 Skills'
          )
        },
        ...skills.map((skill) => ({
          value: `inspect ${skill.name}`,
          description: skill.interface.shortDescription
        }))
      ];
    },
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      const runtime = commandContext.engine.getCompositionRuntime?.();
      if (!runtime) {
        console.log(chalk.yellow('\nSkills are unavailable.\n'));
        return 'continue';
      }
      const [rawAction = 'list', ...rest] = (argument?.trim() || 'list').split(/\s+/);
      const action = rawAction.toLowerCase();
      const name = rest[0]?.toLowerCase() ?? '';
      if (action === 'reload') {
        await runtime.reload();
        console.log(chalk.green('\nSkills reloaded.\n'));
        return 'continue';
      }
      if (action === 'inspect') {
        const skill = runtime.inspectSkill(name);
        if (!skill) {
          console.log(chalk.red(`\nUnknown Skill: ${name || '(missing)'}\n`));
          return 'continue';
        }
        console.log(chalk.cyan(`\nSkill ${skill.name}\n`));
        console.log(`  Display:     ${skill.interface.displayName}`);
        console.log(`  Description: ${skill.description}`);
        console.log(`  Short:       ${skill.interface.shortDescription}`);
        console.log(`  Source:      ${skill.source}`);
        console.log(`  Location:    ${skill.rootPath}`);
        console.log(`  Canonical:   ${skill.canonicalRootPath}`);
        console.log(`  Enabled:     ${skill.enabled ? 'yes' : 'no'}`);
        console.log(
          `  Invocation:  explicit ${skill.policy.allowImplicitInvocation ? '+ implicit' : 'only'}`
        );
        console.log(
          `  Resources:   ${skill.resourceManifest.totalEntries} ` +
            `(${skill.resourceManifest.omittedEntries} omitted from activation manifest)`
        );
        console.log(
          `  Dependencies: ${skill.dependencies.length > 0 ? skill.dependencies.map((item) => item.raw).join(', ') : 'none'}`
        );
        console.log(
          `  Validation:  ${skill.validationWarnings.length === 0 ? 'valid' : 'warnings'}`
        );
        if (skill.shadowed) {
          console.log(chalk.yellow('  Shadowed:    yes'));
        }
        if (skill.metadataError) {
          console.log(chalk.yellow(`  Metadata:    ${skill.metadataError}`));
        }
        if (skill.unsupportedFields.length > 0) {
          console.log(
            chalk.yellow(
              `  Unsupported: ${skill.unsupportedFields.join(', ')} (no authorization granted)`
            )
          );
        }
        console.log('');
        return 'continue';
      }
      if (action === 'doctor') {
        const status = runtime.getStatus();
        console.log(chalk.cyan('\nSkills doctor\n'));
        console.log(
          `  Catalog: ${status.skills.catalogIncluded} included / ` +
            `${status.skills.catalogOmitted} omitted / ${status.skills.catalogCharacters} chars`
        );
        console.log(
          `  Auto refresh: ${status.skills.autoRefresh.reloadCount} reload(s)` +
            `${status.skills.autoRefresh.lastCheckedAt ? `; checked ${status.skills.autoRefresh.lastCheckedAt}` : ''}`
        );
        console.log(`  Dependency warnings: ${status.skills.dependencyWarnings}`);
        for (const warning of status.warnings) {
          console.log(chalk.yellow(`  Warning: ${warning}`));
        }
        console.log('');
        return 'continue';
      }
      if (action === 'create') {
        const skillName = rest[0]?.toLowerCase();
        if (!skillName) {
          console.log(chalk.red('\nUse: /skills create <name> [--scope user|project]\n'));
          return 'continue';
        }
        const scopeIndex = rest.indexOf('--scope');
        const scopeValue = scopeIndex >= 0 ? rest[scopeIndex + 1] : 'user';
        if (scopeValue !== 'user' && scopeValue !== 'project') {
          throw new Error('Skill scope must be user or project');
        }
        const descriptionIndex = rest.indexOf('--description');
        let description = descriptionIndex >= 0 ? rest[descriptionIndex + 1] : undefined;
        if (!description) {
          description =
            (await commandContext.interaction.textInput(
              {
                title: 'Skill description',
                maximumCharacters: 1024
              },
              signal
            )) ?? '';
        }
        const bodyIndex = rest.indexOf('--body-file');
        const bodyFile = bodyIndex >= 0 ? rest[bodyIndex + 1] : undefined;
        const result = await createSkill({
          name: skillName,
          description,
          scope: scopeValue,
          ...(bodyFile ? { bodyFile } : {}),
          workspaceRoot: runtime.workspaceRoot
        });
        await runtime.reload();
        console.log(chalk.green(`\nCreated explicit-only Skill ${result.name}.`));
        console.log(chalk.gray(`${result.rootPath}\n`));
        return 'continue';
      }
      if (action === 'validate') {
        const target = rest[0];
        const descriptor = target ? runtime.inspectSkill(target) : undefined;
        const results = target
          ? [await validateSkillPath(descriptor?.rootPath ?? target)]
          : await validateSkillDescriptors(runtime.listSkills());
        console.log(chalk.cyan('\nSkill validation\n'));
        for (const result of results) {
          console.log(
            `${result.ok ? '  OK' : '  ERROR'} ${result.name ?? '(unknown)'} ${result.path}`
          );
          result.warnings.forEach((warning) => console.log(chalk.yellow(`    WARN: ${warning}`)));
          result.errors.forEach((error) => console.log(chalk.red(`    ERROR: ${error}`)));
        }
        console.log('');
        return 'continue';
      }
      if (action === 'test') {
        const target = rest[0]?.toLowerCase();
        const descriptor = target ? runtime.inspectSkill(target) : undefined;
        if (!descriptor) {
          throw new Error(`Unknown Skill: ${target || '(missing)'}`);
        }
        if (!commandContext.createSkillEvalProvider) {
          throw new Error('Live Skill activation evaluation is unavailable');
        }
        const report = await runSkillActivationEval({
          descriptor,
          workspaceRoot: runtime.workspaceRoot,
          providerFactory: commandContext.createSkillEvalProvider,
          signal
        });
        console.log(chalk.cyan(`\nSkill activation eval: ${descriptor.name}\n`));
        for (const result of report.cases) {
          console.log(
            `  ${result.passed ? 'PASS' : 'FAIL'} ${result.id}: ` +
              `${result.expected} -> ${result.actual} (${result.durationMs}ms)` +
              `${result.infrastructureError ? ` [${result.infrastructureError}]` : ''}`
          );
        }
        console.log(
          `\n  ${report.passed} passed, ${report.failed} failed, ` +
            `${report.infrastructureFailures} infrastructure failures\n`
        );
        return 'continue';
      }
      if (action === 'enable' || action === 'disable') {
        if (!name) {
          console.log(chalk.red(`\nUse: /skills ${action} <name>\n`));
          return 'continue';
        }
        runtime.setSkillEnabled(name, action === 'enable');
        await runtime.reload();
        console.log(chalk.green(`\nSkill ${name} ${action}d.\n`));
        return 'continue';
      }
      if (['install', 'update', 'rollback', 'remove'].includes(action)) {
        const parsed = parseInteractiveSkillManagement(rest);
        const installer = new SkillInstaller({ workspaceRoot: runtime.workspaceRoot });
        const confirm = async (preview: SkillInstallPreview) => {
          return commandContext.interaction.confirm(
            {
              title: `Proceed with Skill ${preview.action}?`,
              message:
                'Installing a Skill does not execute its scripts or change permissions or workspace trust.',
              preview: formatInteractiveSkillPreview(preview),
              confirmToken: 'y'
            },
            signal
          );
        };
        if (action === 'install') {
          const record = await installer.install(parsed.target, {
            scope: parsed.scope,
            ref: parsed.ref,
            skill: parsed.skill,
            signal,
            confirm
          });
          await runtime.reload();
          console.log(chalk.green(`\nInstalled Skill ${record.name}.\n`));
          return 'continue';
        }
        if (action === 'update') {
          const record = await installer.update(parsed.target, {
            scope: parsed.scope,
            signal,
            confirm
          });
          await runtime.reload();
          console.log(chalk.green(`\nUpdated Skill ${record.name}.\n`));
          return 'continue';
        }
        if (action === 'rollback') {
          const record = await installer.rollback(parsed.target, {
            scope: parsed.scope,
            signal,
            confirm
          });
          await runtime.reload();
          console.log(chalk.green(`\nRolled back Skill ${record.name}.\n`));
          return 'continue';
        }
        await installer.remove(parsed.target, {
          scope: parsed.scope,
          signal,
          confirm
        });
        await runtime.reload();
        console.log(chalk.green(`\nRemoved Skill ${parsed.target}.\n`));
        return 'continue';
      }
      if (action !== 'list') {
        console.log(chalk.red(`\nUnknown Skills action: ${action}\n`));
        return 'continue';
      }
      const skills = runtime.listSkills();
      console.log(chalk.cyan('\nAgent Skills\n'));
      if (skills.length === 0) {
        console.log(chalk.gray('  No Skills discovered.\n'));
        return 'continue';
      }
      for (const skill of skills) {
        console.log(
          `  ${skill.interface.displayName.padEnd(24)} ${skill.enabled ? 'enabled ' : 'disabled'} ` +
            `[${skill.source}] ${skill.policy.allowImplicitInvocation ? 'implicit' : 'explicit-only'}` +
            `${skill.shadowed ? ' [shadowed]' : ''}`
        );
      }
      console.log('');
      return 'continue';
    }
  });

  register({
    name: 'permissions',
    category: 'runtime',
    priority: COMMAND_PRIORITIES.permissions,
    description: 'View or change the session permission mode.',
    argumentHint: '[safe|acceptEdits|workspace|fullAccess]',
    choices: (commandContext) => permissionChoices(commandContext),
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      await handlePermissionsCommand(commandContext, argument, signal);
      return 'continue';
    }
  });

  register({
    name: 'extensions',
    category: 'extensions',
    priority: COMMAND_PRIORITIES.extensions,
    description: 'Show or reload the complete extension runtime.',
    argumentHint: '[reload]',
    isEnabled: (commandContext) =>
      typeof commandContext.engine.getExtensionRuntime === 'function' &&
      Boolean(commandContext.engine.getExtensionRuntime()),
    choices: (commandContext) => [
      {
        value: 'reload',
        label: localText(commandContext, 'Reload', '重新加载'),
        description: localText(
          commandContext,
          'Re-evaluate trust and reload MCP and Hooks',
          '重新评估信任并加载 MCP 与 Hooks'
        )
      }
    ],
    async execute(argument, commandContext): Promise<CommandExecutionResult> {
      const runtime = commandContext.engine.getExtensionRuntime?.();
      if (!runtime) {
        console.log(chalk.yellow('\nExtension runtime is unavailable.\n'));
        return 'continue';
      }
      const normalized = argument?.trim().toLowerCase();
      if (normalized === 'reload') {
        const result = await runtime.reload();
        console.log(chalk.cyan('\nExtension reload\n'));
        console.log(`${formatExtensionReload(result)}\n`);
        return 'continue';
      }
      if (normalized) {
        console.log(chalk.red('\nUse: /extensions [reload]\n'));
        return 'continue';
      }
      console.log(chalk.cyan('\n' + formatExtensionDetails(runtime.getStatus()) + '\n'));
      return 'continue';
    }
  });

  register({
    name: 'mcp',
    category: 'extensions',
    priority: COMMAND_PRIORITIES.mcp,
    description: 'Show, reload, or reconnect configured MCP servers.',
    argumentHint: '[reload|reconnect <server>|inspect <server>]',
    isEnabled: (commandContext) =>
      typeof commandContext.engine.getExtensionRuntime === 'function' &&
      Boolean(commandContext.engine.getExtensionRuntime()),
    choices: (commandContext) => {
      const runtime = commandContext.engine.getExtensionRuntime?.();
      const servers = runtime?.mcp.getStatuses() ?? [];
      return [
        {
          value: 'reload',
          label: localText(commandContext, 'Reload', '重新加载'),
          description: localText(
            commandContext,
            'Reload extension configuration',
            '重新加载扩展配置'
          )
        },
        ...servers.map((server) => ({
          value: `inspect ${server.name}`,
          label: `${localText(commandContext, 'Inspect', '检查')} ${server.name}`,
          description: localText(
            commandContext,
            'Show effective MCP tool risks and policies',
            '查看 MCP 工具的实际风险与策略'
          )
        })),
        ...servers.map((server) => ({
          value: `reconnect ${server.name}`,
          label: `${localText(commandContext, 'Reconnect', '重新连接')} ${server.name}`,
          description: localText(
            commandContext,
            `${server.state}; ${server.toolCount} tools`,
            `${server.state}；${server.toolCount} 个工具`
          )
        }))
      ];
    },
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      const runtime = commandContext.engine.getExtensionRuntime?.();
      if (!runtime) {
        console.log(chalk.yellow('\nExtension runtime is unavailable.\n'));
        return 'continue';
      }
      const normalized = argument?.trim();
      if (normalized === 'reload') {
        const result = await runtime.reload();
        console.log(chalk.cyan('\nExtension reload\n'));
        console.log(`${formatExtensionReload(result)}\n`);
        return 'continue';
      }
      if (normalized?.toLowerCase().startsWith('inspect ')) {
        const name = normalized.slice('inspect '.length).trim();
        if (!name) {
          console.log(chalk.red('\nUse: /mcp inspect <server>\n'));
          return 'continue';
        }
        const inspection = await runtime.mcp.inspectServer(name, signal);
        console.log(chalk.cyan(`\nMCP ${name}\n`));
        console.log(
          `  State: ${inspection.status.state}\n` +
            `  Protocol: ${inspection.status.protocolMode}` +
            `${
              inspection.status.negotiatedProtocolVersion
                ? ` -> ${inspection.status.negotiatedProtocolVersion}`
                : ''
            }\n`
        );
        if (inspection.tools.length === 0) {
          console.log(chalk.gray('  No enabled tools.\n'));
          return 'continue';
        }
        for (const tool of inspection.tools) {
          console.log(
            `  ${tool.qualifiedName}: ${tool.risk} ` +
              `(${tool.riskSource})` +
              `${tool.policy ? ` policy=${tool.policy}` : ''}` +
              `${tool.policySources ? ` [${tool.policySources.join('+')}]` : ''}`
          );
          if (tool.annotationWarning) {
            console.log(chalk.yellow(`    ${tool.annotationWarning}`));
          }
        }
        console.log('');
        return 'continue';
      }
      if (normalized?.toLowerCase().startsWith('reconnect ')) {
        const name = normalized.slice('reconnect '.length).trim();
        if (!name) {
          console.log(chalk.red('\nUse: /mcp reconnect <server>\n'));
          return 'continue';
        }
        await runtime.mcp.reconnect(name, signal);
        console.log(chalk.green(`\nMCP server ${name} reconnected.\n`));
        return 'continue';
      }
      if (normalized) {
        console.log(chalk.red(`\nUnknown MCP action: ${normalized}\n`));
        return 'continue';
      }
      const statuses = runtime.mcp.getStatuses();
      console.log(chalk.cyan('\nMCP servers\n'));
      if (statuses.length === 0) {
        console.log(chalk.gray('  No MCP servers are configured.\n'));
        return 'continue';
      }
      for (const status of statuses) {
        console.log(
          `  ${status.name.padEnd(20)} ${status.state.padEnd(12)} ` +
            `${status.transport.padEnd(5)} ${status.toolCount} tools ` +
            `[${status.source}]`
        );
      }
      console.log('');
      return 'continue';
    }
  });

  register({
    name: 'hooks',
    category: 'extensions',
    priority: COMMAND_PRIORITIES.hooks,
    description: 'Show or reload configured command Hooks.',
    argumentHint: '[reload]',
    isEnabled: (commandContext) =>
      typeof commandContext.engine.getExtensionRuntime === 'function' &&
      Boolean(commandContext.engine.getExtensionRuntime()),
    choices: (commandContext) => [
      {
        value: 'reload',
        label: localText(commandContext, 'Reload', '重新加载'),
        description: localText(
          commandContext,
          'Reload MCP and Hook configuration',
          '重新加载 MCP 与 Hook 配置'
        )
      }
    ],
    async execute(argument, commandContext): Promise<CommandExecutionResult> {
      const runtime = commandContext.engine.getExtensionRuntime?.();
      if (!runtime) {
        console.log(chalk.yellow('\nExtension runtime is unavailable.\n'));
        return 'continue';
      }
      const normalized = argument?.trim().toLowerCase();
      if (normalized === 'reload') {
        const result = await runtime.reload();
        console.log(chalk.cyan('\nExtension reload\n'));
        console.log(`${formatExtensionReload(result)}\n`);
        return 'continue';
      }
      if (normalized) {
        console.log(chalk.red(`\nUnknown Hooks action: ${argument}\n`));
        return 'continue';
      }
      const status = runtime.getStatus().hooks;
      console.log(chalk.cyan('\nCommand Hooks\n'));
      console.log(`  Configured: ${status.configured}`);
      console.log(`  Enabled:    ${status.enabled}`);
      if (status.lastErrorCode) {
        console.log(chalk.yellow(`  Last error: ${status.lastErrorCode}`));
      }
      for (const hook of status.entries) {
        console.log(
          `  ${hook.name}: ${hook.event}, ` +
            `${hook.enabled ? 'enabled' : 'disabled'} [${hook.source}]` +
            `${hook.lastOutcome ? `, last ${hook.lastOutcome}` : ''}`
        );
      }
      console.log('');
      return 'continue';
    }
  });

  register({
    name: 'agents',
    category: 'extensions',
    priority: COMMAND_PRIORITIES.agents,
    description: 'Show or toggle bounded read-only subagents.',
    argumentHint: '[on|off]',
    isEnabled: (commandContext) =>
      typeof commandContext.engine.getExtensionRuntime === 'function' &&
      Boolean(commandContext.engine.getExtensionRuntime()),
    choices: (commandContext) => {
      const status = commandContext.engine.getExtensionRuntime?.()?.getStatus().subagents;
      return [
        {
          value: 'on',
          label: localText(commandContext, 'On', '开启'),
          description: localText(
            commandContext,
            'Expose Delegate when the Provider supports isolated forks',
            'Provider 支持隔离 fork 时提供 Delegate'
          ),
          current: status?.enabled === true
        },
        {
          value: 'off',
          label: localText(commandContext, 'Off', '关闭'),
          description: localText(
            commandContext,
            'Hide Delegate from subsequent turns',
            '后续回合不再提供 Delegate'
          ),
          current: status?.enabled === false
        }
      ];
    },
    async execute(argument, commandContext): Promise<CommandExecutionResult> {
      const runtime = commandContext.engine.getExtensionRuntime?.();
      if (!runtime) {
        console.log(chalk.yellow('\nExtension runtime is unavailable.\n'));
        return 'continue';
      }
      const normalized = argument?.trim().toLowerCase();
      if (!normalized) {
        const status = runtime.getStatus().subagents;
        console.log(chalk.cyan('\nRead-only subagents\n'));
        console.log(`  Configured: ${status.enabled ? 'on' : 'off'}`);
        console.log(
          `  Current Provider: ${runtime.supportsSubagents() ? 'supported' : 'unsupported'}\n`
        );
        const budgets = status.budgets;
        console.log(
          `  Budget: ${budgets.maxToolRounds} rounds / ` +
            `${budgets.maxToolCalls} tools / ` +
            `${budgets.maxProviderCalls} Provider calls`
        );
        console.log(
          `  Tokens: ${budgets.softTokenBudget} soft / ` + `${budgets.hardTokenBudget} hard`
        );
        console.log(
          `  Time:   ${budgets.softTimeoutMs / 1000}s soft / ` +
            `${budgets.hardTimeoutMs / 1000}s hard`
        );
        if (budgets.lastStopReason) {
          console.log(`  Last stop: ${budgets.lastStopReason}`);
        }
        console.log('');
        return 'continue';
      }
      if (normalized !== 'on' && normalized !== 'off') {
        console.log(chalk.red('\nUse: /agents on|off\n'));
        return 'continue';
      }
      const enabled = normalized === 'on';
      await commandContext.persistSubagentsEnabled?.(enabled);
      runtime.setSubagentsEnabled(enabled);
      console.log(chalk.green(`\nRead-only subagents ${enabled ? 'enabled' : 'disabled'}.\n`));
      return 'continue';
    }
  });

  register({
    name: 'trust',
    category: 'extensions',
    priority: COMMAND_PRIORITIES.trust,
    description: 'Trust project MCP servers and Hooks for this workspace path.',
    isEnabled: (commandContext) =>
      typeof commandContext.engine.getExtensionRuntime === 'function' &&
      Boolean(commandContext.engine.getExtensionRuntime()),
    async execute(_argument, commandContext, signal): Promise<CommandExecutionResult> {
      const runtime = commandContext.engine.getExtensionRuntime?.();
      if (!runtime) {
        return 'continue';
      }
      const status = runtime.getStatus();
      let preview = runtime.getTrustPreview();
      if (status.workspaceTrusted) {
        const loadedDigest = runtime.getConfiguration().projectDigest;
        if (preview.digest === loadedDigest) {
          console.log(chalk.green('\nThis workspace extension definition is already trusted.\n'));
          return 'continue';
        }
        await runtime.reload();
        preview = runtime.getTrustPreview();
      }
      if (!preview.valid || preview.warnings.length > 0 || !preview.digest) {
        console.log(chalk.red('\nProject extension configuration is invalid:'));
        preview.warnings.forEach((warning) => console.log(`  ${warning}`));
        console.log(chalk.gray('\nFix the configuration before trusting it.\n'));
        return 'continue';
      }
      if (preview.lines.length === 0) {
        console.log(chalk.yellow('\nNo project MCP or Hooks configuration was found.\n'));
        return 'continue';
      }
      console.log(chalk.yellow('\nWARNING: Trusting project extensions'));
      console.log(
        'The following local commands or remote endpoints can run with your ' +
          'user account privileges:'
      );
      preview.lines.forEach((line) => console.log(`  ${line}`));
      console.log(`  Review digest: ${preview.digest.slice(0, 12)}`);
      console.log('');
      console.log(
        'Trust is bound to this canonical workspace path and reviewed extension ' +
          'definition. A configuration change requires another review.'
      );
      console.log(
        'Referenced programs can still change independently. This does not change ' +
          'Agent mode or permission mode, and it is not an OS sandbox.'
      );
      const confirmed = await commandContext.interaction.confirm(
        {
          title: 'Trust project extensions for this workspace?',
          message:
            'Trust is bound to this workspace and reviewed extension definition. This is not an OS sandbox.',
          preview: [...preview.lines, `Review digest: ${preview.digest.slice(0, 12)}`].join('\n'),
          confirmToken: 'y'
        },
        signal
      );
      if (!confirmed) {
        console.log(chalk.yellow('\nWorkspace trust cancelled.\n'));
        return 'continue';
      }
      await runtime.trustWorkspace(preview.digest);
      console.log(chalk.green('\nProject extensions are now trusted.\n'));
      return 'continue';
    }
  });

  register({
    name: 'untrust',
    category: 'extensions',
    priority: COMMAND_PRIORITIES.untrust,
    description: 'Disable project extensions and remove workspace trust.',
    isEnabled: (commandContext) =>
      typeof commandContext.engine.getExtensionRuntime === 'function' &&
      Boolean(commandContext.engine.getExtensionRuntime()),
    async execute(_argument, commandContext): Promise<CommandExecutionResult> {
      const runtime = commandContext.engine.getExtensionRuntime?.();
      await runtime?.untrustWorkspace();
      console.log(chalk.green('\nProject MCP servers disconnected and project Hooks disabled.\n'));
      return 'continue';
    }
  });

  register({
    name: 'model',
    category: 'runtime',
    priority: COMMAND_PRIORITIES.model,
    description: 'Switch models within the current provider.',
    argumentHint: '[model]',
    choices: modelChoices,
    async execute(argument, commandContext): Promise<CommandExecutionResult> {
      const providerInfo = getProviderInfo(commandContext.engine);
      if (!argument) {
        console.log(
          chalk.cyan(
            localText(
              commandContext,
              `\nCurrent model: ${providerInfo?.model ?? 'unknown'}`,
              `\n当前模型：${providerInfo?.model ?? '未知'}`
            )
          )
        );
        if (commandContext.availableModels.length > 0) {
          console.log(
            chalk.gray(
              localText(
                commandContext,
                `Configured models: ${commandContext.availableModels.join(', ')}`,
                `已配置模型：${commandContext.availableModels.join('、')}`
              )
            )
          );
        }
        console.log(
          chalk.gray(
            localText(
              commandContext,
              'Use: /model <configured-model>\n',
              '用法：/model <已配置模型>\n'
            )
          )
        );
        return 'continue';
      }

      const nextModel = findConfiguredModel(commandContext.availableModels, argument);
      if (!nextModel) {
        console.log(
          chalk.red(
            localText(
              commandContext,
              `\nModel is not configured for this provider: ${argument}`,
              `\n当前 Provider 未配置此模型：${argument}`
            )
          )
        );
        console.log(
          chalk.gray(
            localText(
              commandContext,
              `Available: ${commandContext.availableModels.join(', ') || 'none'}\n`,
              `可用模型：${commandContext.availableModels.join('、') || '无'}\n`
            )
          )
        );
        return 'continue';
      }
      const previousModel = providerInfo?.model;
      if (nextModel === previousModel) {
        console.log(
          chalk.green(
            localText(
              commandContext,
              `\nModel is already ${nextModel}.\n`,
              `\n当前模型已经是 ${nextModel}。\n`
            )
          )
        );
        return 'continue';
      }
      if (typeof commandContext.engine.setModel !== 'function') {
        throw new Error('The current engine does not support runtime model switching');
      }

      commandContext.engine.setModel(nextModel);
      try {
        await commandContext.persistModel?.(nextModel, commandContext.session?.providerId ?? '');
        await commandContext.session?.stateChanged();
      } catch (error) {
        if (previousModel) {
          commandContext.engine.setModel(previousModel);
        }
        throw error;
      }
      console.log(
        chalk.green(
          localText(
            commandContext,
            `\nModel switched to ${nextModel}.\n`,
            `\n模型已切换为 ${nextModel}。\n`
          )
        )
      );
      return 'continue';
    }
  });

  register({
    name: 'history',
    category: 'session',
    priority: COMMAND_PRIORITIES.history,
    description: 'Inspect or control workspace input history.',
    argumentHint: '[status|on|off|clear]',
    choices: (commandContext) => {
      const enabled = commandContext.interaction.historyStatus().enabled;
      return [
        {
          value: 'status',
          label: localText(commandContext, 'Status', '状态'),
          description: localText(
            commandContext,
            'Show workspace history status',
            '查看工作区输入历史状态'
          )
        },
        {
          value: 'on',
          label: localText(commandContext, 'On', '开启'),
          description: localText(
            commandContext,
            'Persist submitted input for this workspace',
            '保存当前工作区主动提交的输入'
          ),
          current: enabled
        },
        {
          value: 'off',
          label: localText(commandContext, 'Off', '关闭'),
          description: localText(
            commandContext,
            'Stop persisting workspace input',
            '停止保存当前工作区输入'
          ),
          current: !enabled
        },
        {
          value: 'clear',
          label: localText(commandContext, 'Clear', '清除'),
          description: localText(
            commandContext,
            'Clear only this workspace history',
            '仅清除当前工作区输入历史'
          )
        }
      ];
    },
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      const action = argument?.trim().toLowerCase() || 'status';
      if (action === 'status') {
        const status = commandContext.interaction.historyStatus();
        console.log(
          chalk.cyan(
            localText(
              commandContext,
              `\nInput history: ${status.enabled ? 'on' : 'off'} | ${status.entries} entries\n${status.path}\n`,
              `\n输入历史：${status.enabled ? '开启' : '关闭'} | ${status.entries} 条\n${status.path}\n`
            )
          )
        );
        return 'continue';
      }
      if (action === 'on' || action === 'off') {
        const enabled = action === 'on';
        await commandContext.interaction.setHistoryEnabled(enabled);
        await commandContext.persistHistoryEnabled?.(enabled);
        console.log(
          chalk.green(
            localText(
              commandContext,
              `\nWorkspace input history ${enabled ? 'enabled' : 'disabled'}.\n`,
              `\n工作区输入历史已${enabled ? '开启' : '关闭'}。\n`
            )
          )
        );
        return 'continue';
      }
      if (action === 'clear') {
        const confirmed = await commandContext.interaction.confirm(
          {
            title: 'Clear workspace input history?',
            message: 'Only the current workspace history file will be cleared.',
            confirmToken: 'y'
          },
          signal
        );
        if (confirmed) {
          await commandContext.interaction.clearHistory();
          console.log(
            chalk.green(
              localText(
                commandContext,
                '\nWorkspace input history cleared.\n',
                '\n工作区输入历史已清除。\n'
              )
            )
          );
        } else {
          console.log(
            chalk.yellow(
              localText(commandContext, '\nHistory clear cancelled.\n', '\n已取消清除输入历史。\n')
            )
          );
        }
        return 'continue';
      }
      console.log(chalk.red('\nUse: /history status|on|off|clear\n'));
      return 'continue';
    }
  });

  register({
    name: 'terminal-setup',
    category: 'general',
    priority: COMMAND_PRIORITIES.terminalSetup,
    description: 'Inspect or install a safe Shift+Enter terminal mapping.',
    argumentHint: '[status|install]',
    choices: (commandContext) => [
      { value: 'status', label: localText(commandContext, 'Status', '状态') },
      {
        value: 'install',
        label: localText(commandContext, 'Install Shift+Enter mapping', '安装 Shift+Enter 映射')
      }
    ],
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      const action = argument?.trim().toLowerCase() || 'status';
      const status = await inspectTerminalKeyboard();
      if (action === 'status') {
        const state = status.setupInstalled
          ? localText(commandContext, 'installed', '已安装')
          : status.setupAvailable
            ? localText(commandContext, 'not installed', '未安装')
            : localText(
                commandContext,
                'not available for this terminal',
                '当前终端不支持自动设置'
              );
        console.log(
          chalk.cyan(
            `\nShift+Enter mapping: ${state}\n` +
              `Terminal: ${status.host}\n` +
              (status.configurationPath ? `Configuration: ${status.configurationPath}\n` : '')
          )
        );
        if (status.conflict) console.log(chalk.yellow(`${status.conflict}\n`));
        if (!status.setupInstalled) {
          console.log(
            chalk.gray(
              status.setupAvailable
                ? 'Use /terminal-setup install. Ctrl+J remains the no-configuration newline shortcut.\n'
                : 'Use Ctrl+J to insert a newline in this terminal.\n'
            )
          );
        }
        return 'continue';
      }
      if (action !== 'install') {
        console.log(chalk.red('\nUse: /terminal-setup status|install\n'));
        return 'continue';
      }
      if (status.setupInstalled) {
        console.log(chalk.green('\nShift+Enter terminal mapping is already installed.\n'));
        return 'continue';
      }
      if (!status.setupAvailable || !status.configurationPath) {
        console.log(
          chalk.yellow(
            '\nAutomatic Shift+Enter setup is unavailable for this terminal. Use Ctrl+J for newline.\n'
          )
        );
        return 'continue';
      }
      if (status.conflict) {
        console.log(chalk.yellow(`\n${status.conflict}\n`));
        return 'continue';
      }
      const confirmed = await commandContext.interaction.confirm(
        {
          title: 'Install Shift+Enter terminal mapping?',
          message:
            'Syzzz will back up the terminal configuration, then map Shift+Enter to an escape-prefixed Enter sequence.',
          preview: status.configurationPath,
          confirmToken: 'y'
        },
        signal
      );
      if (!confirmed) {
        console.log(chalk.yellow('\nTerminal setup cancelled.\n'));
        return 'continue';
      }
      const result = await installTerminalShiftEnter();
      console.log(
        chalk.green(
          result.changed
            ? '\nShift+Enter mapping installed. Restart the terminal if it does not take effect immediately.\n'
            : '\nShift+Enter mapping is already installed.\n'
        )
      );
      if (result.backupPath) {
        console.log(chalk.gray(`Backup: ${result.backupPath}\n`));
      }
      return 'continue';
    }
  });

  register({
    name: 'ui',
    category: 'general',
    priority: COMMAND_PRIORITIES.ui,
    description: 'Show terminal capabilities and the active TUI renderer profile.',
    argumentHint: '[status]',
    choices: (commandContext) => [
      { value: 'status', label: localText(commandContext, 'Status', '状态') }
    ],
    execute(argument, commandContext): CommandExecutionResult {
      const action = argument?.trim().toLowerCase() || 'status';
      if (action !== 'status') {
        console.log(chalk.red('\nUse: /ui status\n'));
        return 'continue';
      }
      console.log(
        chalk.cyan(
          `\n${commandContext.uiDiagnostics?.() ?? 'TUI diagnostics are only available in fullscreen mode.'}\n`
        )
      );
      return 'continue';
    }
  });

  register({
    name: 'setting',
    aliases: ['settings'],
    category: 'runtime',
    priority: COMMAND_PRIORITIES.setting,
    description: 'Configure local interface and terminal preferences.',
    argumentHint: '[language|stream|fps|history|context] [value]',
    choices: settingSectionChoices,
    async execute(argument, commandContext, signal): Promise<CommandExecutionResult> {
      const [rawSection, rawValue] = argument?.trim().split(/\s+/, 2) ?? [];
      const section = rawSection?.toLowerCase() as SettingSection | undefined;
      if (!section) {
        const historyEnabled = commandContext.interaction.historyStatus().enabled;
        console.log(
          chalk.cyan(localText(commandContext, '\nInterface settings\n', '\n界面设置\n'))
        );
        console.log(
          localText(
            commandContext,
            `  Language: ${commandContext.uiLanguage}\n  Streaming: ${commandContext.streamOutput ? 'on' : 'off'}\n  Frame rate: ${commandContext.uiFrameRate}\n  History: ${historyEnabled ? 'on' : 'off'}\n  Context: ${formatTokenWindow(commandContext.contextWindowTokens)}\n`,
            `  语言：${commandContext.uiLanguage}\n  流式展示：${commandContext.streamOutput ? '开启' : '关闭'}\n  帧率：${commandContext.uiFrameRate === 'auto' ? '自动' : `${commandContext.uiFrameRate} FPS`}\n  输入历史：${historyEnabled ? '开启' : '关闭'}\n  上下文：${formatTokenWindow(commandContext.contextWindowTokens)}\n`
          )
        );
        return 'continue';
      }
      if (!['language', 'stream', 'fps', 'history', 'context'].includes(section)) {
        console.log(
          chalk.red(
            localText(
              commandContext,
              '\nUse: /setting language|stream|fps|history|context [value]\n',
              '\n用法：/setting language|stream|fps|history|context [值]\n'
            )
          )
        );
        return 'continue';
      }

      let value: string | undefined = rawValue;
      if (!value) {
        const choices = settingValueChoices(section, commandContext);
        value = await commandContext.interaction.select(
          {
            title: localText(commandContext, 'Choose a setting', '选择设置'),
            message: settingSectionChoices(commandContext).find(
              (choice) => choice.value === section
            )?.description,
            choices: choices.map((choice) => ({
              value: choice.value,
              label: choice.label ?? choice.value,
              ...(choice.description ? { description: choice.description } : {}),
              ...(choice.current ? { current: true } : {})
            })),
            initialValue: choices.find((choice) => choice.current)?.value
          },
          signal
        );
        if (!value) return 'continue';
      }

      if (section === 'language') {
        if (value !== 'auto' && value !== 'zh-CN' && value !== 'en') {
          console.log(chalk.red('\nUse: /setting language auto|zh-CN|en\n'));
          return 'continue';
        }
        await commandContext.persistUiLanguage?.(value);
        commandContext.uiLanguage = value;
        console.log(
          chalk.green(
            localText(
              commandContext,
              `\nInterface language set to ${value}.\n`,
              `\n界面语言已设置为${value === 'zh-CN' ? '中文' : value === 'en' ? '英文' : '自动'}。\n`
            )
          )
        );
        return 'continue';
      }
      if (section === 'stream') {
        const normalized = value.toLowerCase();
        if (normalized !== 'on' && normalized !== 'off') {
          console.log(chalk.red('\nUse: /setting stream on|off\n'));
          return 'continue';
        }
        const enabled = normalized === 'on';
        await commandContext.persistStreamOutput?.(enabled);
        commandContext.streamOutput = enabled;
        console.log(
          chalk.green(
            localText(
              commandContext,
              `\nStreaming display ${enabled ? 'enabled' : 'disabled'}.\n`,
              `\n流式展示已${enabled ? '开启' : '关闭'}。\n`
            )
          )
        );
        return 'continue';
      }
      if (section === 'fps') {
        const frameRate: UiFrameRate =
          value === 'auto'
            ? 'auto'
            : Number(value) === 30
              ? 30
              : Number(value) === 60
                ? 60
                : 'auto';
        if (value !== 'auto' && value !== '30' && value !== '60') {
          console.log(chalk.red('\nUse: /setting fps auto|30|60\n'));
          return 'continue';
        }
        await commandContext.persistUiFrameRate?.(frameRate);
        commandContext.uiFrameRate = frameRate;
        console.log(
          chalk.green(
            localText(
              commandContext,
              `\nTUI frame rate set to ${frameRate === 'auto' ? 'auto' : `${frameRate} FPS`}; it takes effect on the next launch.\n`,
              `\nTUI 帧率已设置为${frameRate === 'auto' ? '自动' : `${frameRate} FPS`}；下次启动生效。\n`
            )
          )
        );
        return 'continue';
      }
      if (section === 'history') {
        const normalized = value.toLowerCase();
        if (normalized !== 'on' && normalized !== 'off') {
          console.log(chalk.red('\nUse: /setting history on|off\n'));
          return 'continue';
        }
        const enabled = normalized === 'on';
        await commandContext.interaction.setHistoryEnabled(enabled);
        await commandContext.persistHistoryEnabled?.(enabled);
        console.log(
          chalk.green(
            localText(
              commandContext,
              `\nWorkspace input history ${enabled ? 'enabled' : 'disabled'}.\n`,
              `\n工作区输入历史已${enabled ? '开启' : '关闭'}。\n`
            )
          )
        );
        return 'continue';
      }

      const tokens = parseContextWindowPreset(value);
      if (!tokens) {
        console.log(chalk.red('\nUse: /setting context 64k|128k|200k\n'));
        return 'continue';
      }
      await commandContext.persistContextWindow?.(tokens);
      commandContext.engine.setDefaultContextWindowTokens(tokens);
      commandContext.contextWindowTokens = tokens;
      console.log(
        chalk.green(
          localText(
            commandContext,
            `\nContext fallback set to ${formatTokenWindow(tokens)}.\n`,
            `\n默认上下文窗口已设置为 ${formatTokenWindow(tokens)}。\n`
          )
        )
      );
      return 'continue';
    }
  });

  register({
    name: 'help',
    aliases: ['?'],
    category: 'general',
    priority: COMMAND_PRIORITIES.help,
    description: 'Show available interactive commands.',
    execute(_argument, commandContext) {
      console.log(chalk.cyan(`\n${formatCommandsHelp(registry, commandContext)}\n`));
      return 'continue';
    }
  });

  register({
    name: 'exit',
    aliases: ['quit'],
    category: 'general',
    priority: COMMAND_PRIORITIES.exit,
    description: 'Exit the interactive session.',
    execute() {
      return 'exit';
    }
  });

  return registry;
}

export async function executeSlashCommand(
  input: string,
  registry: CommandRegistry<InteractiveCommandContext>,
  context: InteractiveCommandContext,
  signal: AbortSignal
): Promise<StructuredCommandExecutionResult> {
  const parsed = parseSlashCommand(input);
  if (!parsed) {
    return { type: 'continue' };
  }
  const command = registry.resolve(parsed.name, context);
  if (!command) {
    const suggestions = registry.closest(parsed.name, context);
    context.interaction.notice({
      tone: 'error',
      text: localText(context, `Unknown command: /${parsed.name}`, `未知命令：/${parsed.name}`)
    });
    if (suggestions.length > 0) {
      context.interaction.notice({
        tone: 'muted',
        text: localText(
          context,
          `Did you mean: ${suggestions.map((name) => `/${name}`).join(', ')}?`,
          `你是否想输入：${suggestions.map((name) => `/${name}`).join('、')}？`
        )
      });
    }
    return { type: 'continue' };
  }
  let argument = parsed.argument;
  if (!argument && context.structuredSelections) {
    const choices = command.choices?.(context) ?? [];
    if (choices.length > 0) {
      argument = await context.interaction.select(
        {
          title: `/${command.name}`,
          message: localizeCommandDescription(
            command.name,
            command.description,
            resolveUiLanguage(context.uiLanguage)
          ),
          choices: choices.map((choice) => ({
            value: choice.value,
            label: choice.label ?? choice.value,
            ...(choice.description ? { description: choice.description } : {}),
            ...(choice.current ? { current: true } : {})
          })),
          initialValue: choices.find((choice) => choice.current)?.value
        },
        signal
      );
      if (!argument) {
        return { type: 'continue' };
      }
    }
  }
  return normalizeCommandExecutionResult(
    await activeInteraction.run(context.interaction, () =>
      command.execute(argument, context, signal)
    )
  );
}

export function createInteractiveCommandRuntime(
  engine: QueryEngine,
  options: InteractiveSessionOptions,
  terminal: InteractiveTerminalReader,
  interaction: InteractionPort,
  structuredSelections: boolean
): InteractiveCommandRuntime {
  const providerInfo = getProviderInfo(engine);
  const context: InteractiveCommandContext = {
    engine,
    terminal,
    interaction,
    structuredSelections,
    streamOutput: options.streamOutput ?? true,
    availableModels: options.availableModels ?? (providerInfo?.model ? [providerInfo.model] : []),
    persistStreamOutput: options.persistStreamOutput,
    persistSubagentsEnabled: options.persistSubagentsEnabled,
    persistModel: options.persistModel,
    session: options.session,
    getProviderOptions: options.getProviderOptions,
    activateProvider: options.activateProvider,
    modelsForProvider: options.modelsForProvider,
    createSkillEvalProvider: options.createSkillEvalProvider,
    persistHistoryEnabled: options.persistHistoryEnabled,
    contextWindowTokens: options.contextWindowTokens ?? 65_536,
    persistContextWindow: options.persistContextWindow,
    uiLanguage: options.uiLanguage ?? 'auto',
    persistUiLanguage: options.persistUiLanguage,
    uiFrameRate: options.uiFrameRate ?? 'auto',
    persistUiFrameRate: options.persistUiFrameRate,
    uiDiagnostics: options.uiDiagnostics
  };
  const registry = createCommandRegistry();
  const slashSuggestions = createSlashSuggestionProvider(
    registry,
    () => context,
    () => resolveUiLanguage(context.uiLanguage)
  );
  const dynamicCompositionSuggestion = (
    createProvider: typeof createContextSuggestionProvider
  ): SuggestionProvider => ({
    trigger: createProvider === createContextSuggestionProvider ? '@' : '$',
    match(value, cursor) {
      const composition = context.engine.getCompositionRuntime?.();
      return composition ? createProvider(composition).match(value, cursor) : null;
    },
    async suggest(request, signal) {
      const composition = context.engine.getCompositionRuntime?.();
      const items = composition ? await createProvider(composition).suggest(request, signal) : [];
      const language = resolveUiLanguage(context.uiLanguage);
      return items.map((item) => ({
        ...item,
        description: localizeSuggestionDescription(item.id, item.description, language)
      }));
    }
  });
  const suggestionProviders: SuggestionProvider[] = [
    slashSuggestions,
    dynamicCompositionSuggestion(createContextSuggestionProvider),
    dynamicCompositionSuggestion(createSkillSuggestionProvider)
  ];
  return {
    context,
    registry,
    suggestionProviders,
    execute: (input, signal) => executeSlashCommand(input, registry, context, signal)
  };
}

export async function runInteractiveSession(
  engine: QueryEngine,
  options: InteractiveSessionOptions = {}
): Promise<void> {
  const providerInfo = getProviderInfo(engine);
  if (providerInfo) {
    console.log(chalk.green(`Using ${providerInfo.name} (${providerInfo.model})`));
  }
  if (options.session) {
    const sessionStatus = options.session.getStatus();
    console.log(
      chalk.gray(
        `Session ${sessionStatus.sessionId.slice(0, 8)} | ` +
          `autosave ${sessionStatus.autoSave ? 'on' : 'off'}`
      )
    );
    console.log(
      chalk.gray(
        `Session saves are stored locally in ` +
          `${options.session.sessionStore.workspaceDirectory}`
      )
    );
  }
  console.log(chalk.cyan('\nSyzzz Code - Interactive Mode'));
  console.log(chalk.gray('Type your message and press Enter. Press Ctrl+C twice to exit.'));
  console.log(chalk.gray('Type / to browse interactive commands.\n'));

  const terminal = new TerminalInputController();
  const history = await WorkspaceInputHistory.create({
    workspaceRoot:
      typeof engine.getStatus === 'function' ? engine.getStatus().workspaceRoot : process.cwd(),
    enabled: options.persistentHistory ?? true,
    onWarning: (message) => console.warn(chalk.yellow(message))
  });
  terminal.replaceHistory(history.list());
  const interaction = new InlineInteractionPort(terminal, history);
  const commandRuntime = createInteractiveCommandRuntime(
    engine,
    options,
    terminal,
    interaction,
    false
  );
  const commandContext = commandRuntime.context;

  let lastInterruptAt = 0;
  let isClosed = false;
  let activeOperationAbortController: AbortController | undefined;

  const handleIdleInterrupt = () => {
    const now = Date.now();
    if (now - lastInterruptAt <= DOUBLE_INTERRUPT_WINDOW_MS) {
      isClosed = true;
      terminal.close();
      return;
    }
    lastInterruptAt = now;
    console.log(chalk.yellow('\nPress Ctrl+C again within two seconds to exit.'));
  };
  const handleProcessInterrupt = () => {
    if (activeOperationAbortController && !activeOperationAbortController.signal.aborted) {
      console.log(chalk.yellow('\nCancelling the current operation...'));
      activeOperationAbortController.abort(new OperationAbortedError());
      return;
    }
    handleIdleInterrupt();
  };
  process.on('SIGINT', handleProcessInterrupt);

  try {
    while (!isClosed) {
      const input = await terminal.readLine({
        prompt: buildPrompt(
          getEngineMode(commandContext.engine),
          getEnginePermissionMode(commandContext.engine)
        ),
        suggestionProviders: commandRuntime.suggestionProviders,
        history: true
      });
      if (input.type === 'eof') {
        break;
      }
      if (input.type === 'interrupt') {
        handleIdleInterrupt();
        continue;
      }

      await history.record(input.value);

      const trimmedInput = input.value.trim();
      lastInterruptAt = 0;
      if (!trimmedInput) {
        continue;
      }
      if (trimmedInput.toLowerCase() === 'exit') {
        break;
      }

      let message: string;
      if (trimmedInput.startsWith('/') && !trimmedInput.startsWith('//')) {
        const commandController = new AbortController();
        activeOperationAbortController = commandController;
        try {
          const result = await commandRuntime.execute(trimmedInput, commandController.signal);
          if (result.type === 'exit') {
            break;
          }
          if (result.notice) {
            interaction.notice(result.notice);
          }
          if (result.type !== 'submit') {
            continue;
          }
          message = result.message;
        } catch (error) {
          if (isAbortError(error)) {
            const reason = error instanceof Error ? error.message : 'Command cancelled';
            console.log(chalk.yellow(`\n${reason}\n`));
          } else {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(chalk.red('\nCommand failed:'), reason + '\n');
          }
          continue;
        } finally {
          if (activeOperationAbortController === commandController) {
            activeOperationAbortController = undefined;
          }
        }
      } else {
        message = trimmedInput.startsWith('//') ? trimmedInput.slice(1) : trimmedInput;
      }

      const spinner = ora({ text: 'Thinking...', discardStdin: false }).start();
      const renderer = new HumanEventRenderer({
        streamOutput: commandContext.streamOutput,
        spinner
      });
      const turnAbortController = new AbortController();
      activeOperationAbortController = turnAbortController;

      try {
        const result = await consumeInteractiveTurn(
          commandContext.engine,
          message,
          {
            signal: turnAbortController.signal,
            requestApproval: (request, signal) => interaction.requestApproval(request, signal),
            requestUserInput: (request, signal) => interaction.requestUserInput(request, signal)
          },
          (event) => renderer.handle(event)
        );

        await commandContext.session?.recordTurn(message, result);
        renderer.finish(result);
        if (result.status === 'cancelled') {
          console.log(chalk.yellow('Current operation cancelled.\n'));
        } else if (result.status === 'failed') {
          console.error(chalk.red('Error:'), result.error.message + '\n');
        }
      } catch (error) {
        renderer.stop();
        if (isAbortError(error)) {
          console.log(chalk.yellow('\nCurrent operation cancelled.\n'));
        } else {
          const reason = error instanceof Error ? error.message : String(error);
          console.error(chalk.red('\nError:'), reason + '\n');
        }
      } finally {
        renderer.stop();
        if (activeOperationAbortController === turnAbortController) {
          activeOperationAbortController = undefined;
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', handleProcessInterrupt);
    terminal.close();
    await commandContext.session?.close();
  }

  console.log(chalk.yellow('\nGoodbye!\n'));
}
