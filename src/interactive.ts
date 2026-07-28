import chalk from 'chalk';
import ora from 'ora';
import type { QueryEngine, ChatOptions } from './engine.js';
import type { AgentEvent, TurnResult } from './events.js';
import {
  consumeAgentTurn,
  HumanEventRenderer
} from './cli-renderer.js';
import {
  COMMAND_CATEGORIES,
  COMMAND_CATEGORY_LABELS,
  CommandRegistry,
  createSlashSuggestionProvider,
  parseSlashCommand,
  type CommandChoice,
  type CommandDefinition,
  type CommandExecutionResult
} from './interactive-commands.js';
import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  agentModeDescription,
  type AgentMode
} from './modes.js';
import {
  DEFAULT_PERMISSION_MODE,
  formatPermissionModesHelp,
  parsePermissionMode,
  permissionModeDescription,
  permissionModeTitle,
  type PermissionMode
} from './permissions/mode.js';
import {
  TerminalInputController,
  type TerminalReadResult
} from './terminal-input.js';
import type { SessionController } from './session-controller.js';
import type { ToolApprovalRequest } from './types.js';
import { isAbortError, OperationAbortedError } from './tools/abort.js';

const DOUBLE_INTERRUPT_WINDOW_MS = 2_000;
const MAX_APPROVAL_PREVIEW_CHARACTERS = 20_000;
const COMMAND_PRIORITIES = {
  ask: 10,
  plan: 20,
  code: 30,
  status: 40,
  permissions: 50,
  model: 60,
  provider: 70,
  stream: 80,
  new: 90,
  resume: 100,
  save: 110,
  compact: 120,
  rename: 130,
  help: 140,
  exit: 150
} as const;

export type StreamDisplayMode = 'on' | 'off';

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
  persistModel?: (
    model: string,
    providerId: string
  ) => void | Promise<void>;
  session?: SessionController;
  getProviderOptions?: () => readonly InteractiveProviderOption[];
  activateProvider?: (
    providerId: string,
    engine: QueryEngine
  ) => Promise<{ providerId: string; models: readonly string[] }>;
  modelsForProvider?: (providerId: string) => readonly string[];
}

interface InteractiveCommandContext {
  engine: QueryEngine;
  terminal: TerminalInputController;
  streamOutput: boolean;
  availableModels: readonly string[];
  persistStreamOutput?: (enabled: boolean) => void | Promise<void>;
  persistModel?: (
    model: string,
    providerId: string
  ) => void | Promise<void>;
  session?: SessionController;
  getProviderOptions?: () => readonly InteractiveProviderOption[];
  activateProvider?: InteractiveSessionOptions['activateProvider'];
  modelsForProvider?: (providerId: string) => readonly string[];
}

function formatApprovalRequest(request: ToolApprovalRequest): string {
  const lines = [
    chalk.yellow(`\nApproval required: ${request.toolName} (${request.risk})`),
    request.description
  ];
  if (request.preview) {
    const preview = request.preview.length <= MAX_APPROVAL_PREVIEW_CHARACTERS
      ? request.preview
      : `${request.preview.slice(0, MAX_APPROVAL_PREVIEW_CHARACTERS)}\n[Preview truncated]`;
    lines.push('', preview);
  }
  return lines.join('\n');
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
  return typeof engine.getProviderInfo === 'function'
    ? engine.getProviderInfo()
    : undefined;
}

function buildPrompt(
  agentMode: AgentMode,
  permissionMode: PermissionMode
): string {
  return chalk.blue(`You [${agentMode}|${permissionMode}]: `);
}

function getEngineMode(engine: QueryEngine): AgentMode {
  return typeof engine.getMode === 'function'
    ? engine.getMode()
    : DEFAULT_AGENT_MODE;
}

function setEngineMode(engine: QueryEngine, mode: AgentMode): void {
  if (typeof engine.setMode !== 'function') {
    throw new Error('The current engine does not support work modes');
  }
  engine.setMode(mode);
}

function permissionChoices(engine: QueryEngine): readonly CommandChoice[] {
  const currentMode = getEnginePermissionMode(engine);
  return (['safe', 'acceptEdits', 'fullAccess'] as const).map(mode => ({
    value: mode,
    label: permissionModeTitle(mode),
    description: permissionModeDescription(mode),
    current: mode === currentMode
  }));
}

async function handlePermissionsCommand(
  engine: QueryEngine,
  argument: string | undefined,
  terminal: TerminalInputController,
  signal: AbortSignal
): Promise<void> {
  const currentMode = getEnginePermissionMode(engine);
  if (!argument) {
    console.log(chalk.cyan(`\n${formatPermissionModesHelp(currentMode)}\n`));
    return;
  }

  const nextMode = parsePermissionMode(argument);
  if (!nextMode) {
    console.log(chalk.red(`\nUnknown permission mode: ${argument}`));
    console.log(chalk.gray('Use: /permissions safe | acceptEdits | fullAccess\n'));
    return;
  }
  if (nextMode === currentMode) {
    console.log(chalk.green(
      `\nPermission mode is already ${permissionModeTitle(nextMode)} (${nextMode}).\n`
    ));
    return;
  }

  if (nextMode === 'fullAccess') {
    console.log(chalk.red('\nWARNING: Full Access disables approval prompts for this session.'));
    console.log(chalk.yellow(
      'File tools remain workspace-bound, but Shell can still affect the whole account.'
    ));
    console.log(chalk.yellow('Type y to confirm. Any other input cancels.'));
    const confirmation = await terminal.readLine({
      prompt: chalk.red('Enable Full Access for this session? [y/N]: '),
      signal
    });
    if (confirmation.type === 'interrupt') {
      console.log(chalk.yellow('\nCancelling the current operation...'));
      throw new OperationAbortedError('Permission command cancelled');
    }
    if (
      confirmation.type !== 'line' ||
      confirmation.value.trim().toLowerCase() !== 'y'
    ) {
      console.log(chalk.yellow('\nFull Access not enabled. Permission mode unchanged.\n'));
      return;
    }
  }

  setEnginePermissionMode(engine, nextMode);
  console.log(chalk.green(
    `\nPermission mode set to ${permissionModeTitle(nextMode)} (${nextMode}).`
  ));
  console.log(chalk.gray('This setting applies only to the current process session.\n'));
}

async function consumeInteractiveTurn(
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
      label: 'On',
      description: 'Show assistant text as it arrives.',
      current: context.streamOutput
    },
    {
      value: 'off',
      label: 'Off',
      description: 'Buffer assistant text until the turn completes.',
      current: !context.streamOutput
    }
  ];
}

function modelChoices(context: InteractiveCommandContext): readonly CommandChoice[] {
  const currentModel = getProviderInfo(context.engine)?.model;
  return context.availableModels.map(model => ({
    value: model,
    description: model === currentModel ? 'Current model' : undefined,
    current: model === currentModel
  }));
}

function formatStatus(context: InteractiveCommandContext): string {
  const status = context.engine.getStatus();
  const sessionStatus = context.session?.getStatus();
  const contextPercent = status.context.contextWindowTokens > 0
    ? Math.min(
      100,
      Math.round(
        status.context.estimatedInputTokens /
        status.context.contextWindowTokens *
        100
      )
    )
    : 0;
  const lines = [
    'Session status',
    `  Session:      ${status.sessionId}`,
    `  Workspace:    ${status.workspaceRoot}`,
    `  Provider:     ${status.provider.name} (${status.provider.type})`,
    `  Model:        ${status.provider.model}`,
    ...(status.lastReportedModel
      ? [`  Reported:     ${status.lastReportedModel}`]
      : []),
    `  Work mode:    ${status.mode}`,
    `  Permissions:  ${status.permissionMode}`,
    `  Context:      ${status.context.estimatedInputTokens} / ` +
      `${status.context.contextWindowTokens} tokens (${contextPercent}%)`,
    `  Compactions:  ${status.context.compactions}`,
    `  Usage:        ${status.totalUsage.inputTokens} in / ` +
      `${status.totalUsage.outputTokens} out`,
    `  Messages:     ${status.messageCount}`,
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
  return lines.join('\n');
}

function syncSessionContext(context: InteractiveCommandContext): void {
  if (!context.session) {
    return;
  }
  context.engine = context.session.engine;
  context.availableModels = context.modelsForProvider?.(
    context.session.providerId
  ) ?? [context.engine.getProviderInfo().model];
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
  const answer = await context.terminal.readLine({
    prompt: chalk.yellow(
      'Current session has unsaved changes. Discard them? [y/N]: '
    ),
    signal
  });
  if (answer.type === 'interrupt') {
    throw new OperationAbortedError('Session switch cancelled');
  }
  return answer.type === 'line' &&
    answer.value.trim().toLowerCase() === 'y';
}

function findConfiguredModel(
  models: readonly string[],
  requested: string
): string | undefined {
  const normalized = requested.trim().toLowerCase();
  return models.find(model => model.toLowerCase() === normalized);
}

function providerChoices(
  context: InteractiveCommandContext
): readonly CommandChoice[] {
  const currentProviderId = context.session?.providerId;
  return (context.getProviderOptions?.() ?? []).map(provider => ({
    value: provider.id,
    label: provider.name,
    description: provider.available
      ? `${provider.model}${provider.id === currentProviderId ? ' (current)' : ''}`
      : provider.unavailableReason ?? 'Credentials are not configured',
    current: provider.id === currentProviderId
  }));
}

async function chooseFromNumberedList<T>(
  values: readonly T[],
  format: (value: T, index: number) => string,
  prompt: string,
  terminal: TerminalInputController,
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
  const selectedIndex = normalized
    ? Number.parseInt(normalized, 10) - 1
    : 0;
  return Number.isInteger(selectedIndex) &&
    selectedIndex >= 0 &&
    selectedIndex < values.length
    ? values[selectedIndex]
    : undefined;
}

function formatCommandsHelp(
  registry: CommandRegistry<InteractiveCommandContext>,
  context: InteractiveCommandContext
): string {
  const lines = ['Available commands:'];
  const commands = registry.search('', context);
  for (const category of COMMAND_CATEGORIES) {
    const categoryCommands = commands.filter(
      command => command.category === category
    );
    if (categoryCommands.length === 0) {
      continue;
    }
    lines.push('', `${COMMAND_CATEGORY_LABELS[category]}:`);
    for (const command of categoryCommands) {
      const aliases = command.aliases?.length
        ? ` (aliases: ${command.aliases.map(alias => `/${alias}`).join(', ')})`
        : '';
      const hint = command.argumentHint ? ` ${command.argumentHint}` : '';
      lines.push(`  /${command.name}${hint}${aliases}`);
      lines.push(`    ${command.description}`);
    }
  }
  lines.push('', 'Type // at the start to send a literal slash message.');
  return lines.join('\n');
}

function createCommandRegistry(
  context: InteractiveCommandContext
): CommandRegistry<InteractiveCommandContext> {
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
        return argument
          ? { submitMessage: argument }
          : 'continue';
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
    isEnabled: commandContext => Boolean(commandContext.session),
    async execute(
      argument,
      commandContext,
      signal
    ): Promise<CommandExecutionResult> {
      if (!await confirmDiscardIfNeeded(commandContext, signal)) {
        console.log(chalk.yellow('\nNew session cancelled.\n'));
        return 'continue';
      }
      const result = await commandContext.session!.newSession(argument);
      syncSessionContext(commandContext);
      console.log(chalk.green(
        `\nStarted session ${result.sessionId.slice(0, 8)} (${result.title}).\n`
      ));
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
    isEnabled: commandContext => Boolean(commandContext.session),
    async execute(
      argument,
      commandContext,
      signal
    ): Promise<CommandExecutionResult> {
      let selection = argument;
      if (!selection) {
        const sessions = (await commandContext.session!.list())
          .filter(session => session.available);
        if (sessions.length === 0) {
          console.log(chalk.yellow('\nNo saved sessions for this workspace.\n'));
          return 'continue';
        }
        console.log(chalk.cyan('\nSaved sessions:\n'));
        const selected = await chooseFromNumberedList(
          sessions,
          (session, index) =>
            `  ${index + 1}. ${session.title} ` +
            `[${session.sessionId.slice(0, 8)}] ${session.updatedAt}`,
          '\nSelect session [1]: ',
          commandContext.terminal,
          signal
        );
        if (!selected) {
          console.log(chalk.yellow('\nInvalid selection.\n'));
          return 'continue';
        }
        selection = selected.sessionId;
      }
      if (!await confirmDiscardIfNeeded(commandContext, signal)) {
        console.log(chalk.yellow('\nResume cancelled.\n'));
        return 'continue';
      }
      const result = await commandContext.session!.resume(selection);
      syncSessionContext(commandContext);
      console.log(chalk.green(
        `\nResumed ${result.title} [${result.sessionId.slice(0, 8)}].`
      ));
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
    isEnabled: commandContext => Boolean(commandContext.session),
    async execute(
      argument,
      commandContext
    ): Promise<CommandExecutionResult> {
      if (!argument) {
        console.log(chalk.red('\nUse: /rename <title>\n'));
        return 'continue';
      }
      await commandContext.session!.rename(argument);
      console.log(chalk.green(`\nSession renamed to ${argument.trim()}.\n`));
      return 'continue';
    }
  });

  register({
    name: 'save',
    category: 'session',
    priority: COMMAND_PRIORITIES.save,
    description: 'Persist the current session immediately.',
    isEnabled: commandContext => Boolean(commandContext.session),
    async execute(
      _argument,
      commandContext
    ): Promise<CommandExecutionResult> {
      const metadata = await commandContext.session!.save();
      console.log(chalk.green(
        `\nSaved ${metadata.title} [${metadata.sessionId.slice(0, 8)}].\n`
      ));
      return 'continue';
    }
  });

  register({
    name: 'compact',
    category: 'session',
    priority: COMMAND_PRIORITIES.compact,
    description: 'Compact the current conversation context now.',
    async execute(
      _argument,
      commandContext,
      signal
    ): Promise<CommandExecutionResult> {
      if (typeof commandContext.engine.compactContext !== 'function') {
        throw new Error('The current engine does not support manual compaction');
      }
      const spinner = ora({
        text: 'Compacting context...',
        discardStdin: false
      }).start();
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
        console.log(chalk.green(
          `\nContext compacted ${result.beforeTokens} -> ` +
          `${result.afterTokens} tokens (${result.compactions} pass(es)).\n`
        ));
      } else if (result.status === 'skipped') {
        console.log(chalk.yellow(
          `\nContext compaction skipped: ${result.reason.replaceAll('_', ' ')}.\n`
        ));
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
    isEnabled: commandContext => Boolean(commandContext.activateProvider),
    async execute(
      argument,
      commandContext,
      signal
    ): Promise<CommandExecutionResult> {
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
      const configured = providers.find(
        provider => provider.id.toLowerCase() === providerId!.toLowerCase()
      );
      if (!configured) {
        console.log(chalk.red(`\nUnknown provider: ${providerId}\n`));
        return 'continue';
      }
      if (!configured.available) {
        console.log(chalk.red(
          `\nProvider is unavailable: ` +
          `${configured.unavailableReason ?? 'credentials are missing'}\n`
        ));
        return 'continue';
      }
      const activated = await commandContext.activateProvider!(
        configured.id,
        commandContext.engine
      );
      await commandContext.session?.setProviderReference(
        activated.providerId
      );
      commandContext.availableModels = activated.models;
      console.log(chalk.green(
        `\nProvider switched to ${configured.name} ` +
        `(${commandContext.engine.getProviderInfo().model}).\n`
      ));
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
        console.log(chalk.cyan(
          `\nStream display is ${commandContext.streamOutput ? 'on' : 'off'}.`
        ));
        console.log(chalk.gray('Use: /stream on | /stream off\n'));
        return 'continue';
      }
      const normalized = argument.trim().toLowerCase();
      if (normalized !== 'on' && normalized !== 'off') {
        console.log(chalk.red(`\nUnknown stream display mode: ${argument}`));
        console.log(chalk.gray('Use: /stream on | /stream off\n'));
        return 'continue';
      }
      const enabled = normalized === 'on';
      if (enabled === commandContext.streamOutput) {
        console.log(chalk.green(`\nStream display is already ${normalized}.\n`));
        return 'continue';
      }

      await commandContext.persistStreamOutput?.(enabled);
      commandContext.streamOutput = enabled;
      console.log(chalk.green(`\nStream display set to ${normalized}.`));
      console.log(chalk.gray(
        'Provider streaming and AgentEvent delivery remain enabled.\n'
      ));
      return 'continue';
    }
  });

  register({
    name: 'permissions',
    category: 'runtime',
    priority: COMMAND_PRIORITIES.permissions,
    description: 'View or change the session permission mode.',
    argumentHint: '[safe|acceptEdits|fullAccess]',
    choices: commandContext => permissionChoices(commandContext.engine),
    async execute(
      argument,
      commandContext,
      signal
    ): Promise<CommandExecutionResult> {
      await handlePermissionsCommand(
        commandContext.engine,
        argument,
        commandContext.terminal,
        signal
      );
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
        console.log(chalk.cyan(
          `\nCurrent model: ${providerInfo?.model ?? 'unknown'}`
        ));
        if (commandContext.availableModels.length > 0) {
          console.log(chalk.gray(
            `Configured models: ${commandContext.availableModels.join(', ')}`
          ));
        }
        console.log(chalk.gray('Use: /model <configured-model>\n'));
        return 'continue';
      }

      const nextModel = findConfiguredModel(commandContext.availableModels, argument);
      if (!nextModel) {
        console.log(chalk.red(`\nModel is not configured for this provider: ${argument}`));
        console.log(chalk.gray(
          `Available: ${commandContext.availableModels.join(', ') || 'none'}\n`
        ));
        return 'continue';
      }
      const previousModel = providerInfo?.model;
      if (nextModel === previousModel) {
        console.log(chalk.green(`\nModel is already ${nextModel}.\n`));
        return 'continue';
      }
      if (typeof commandContext.engine.setModel !== 'function') {
        throw new Error('The current engine does not support runtime model switching');
      }

      commandContext.engine.setModel(nextModel);
      try {
        await commandContext.persistModel?.(
          nextModel,
          commandContext.session?.providerId ?? ''
        );
        await commandContext.session?.stateChanged();
      } catch (error) {
        if (previousModel) {
          commandContext.engine.setModel(previousModel);
        }
        throw error;
      }
      console.log(chalk.green(`\nModel switched to ${nextModel}.\n`));
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

async function executeSlashCommand(
  input: string,
  registry: CommandRegistry<InteractiveCommandContext>,
  context: InteractiveCommandContext,
  signal: AbortSignal
): Promise<CommandExecutionResult> {
  const parsed = parseSlashCommand(input);
  if (!parsed) {
    return 'continue';
  }
  const command = registry.resolve(parsed.name, context);
  if (!command) {
    const suggestions = registry.closest(parsed.name, context);
    console.log(chalk.red(`\nUnknown command: /${parsed.name}`));
    if (suggestions.length > 0) {
      console.log(chalk.gray(
        `Did you mean: ${suggestions.map(name => `/${name}`).join(', ')}?\n`
      ));
    }
    return 'continue';
  }
  return command.execute(parsed.argument, context, signal);
}

async function requestApproval(
  request: ToolApprovalRequest,
  signal: AbortSignal,
  terminal: TerminalInputController
) {
  console.log(formatApprovalRequest(request));
  const allowsEditSession = request.choices.includes('allow-edits-session');
  const answer = await terminal.readLine({
    prompt: chalk.yellow(
      allowsEditSession
        ? 'Approve? [y] once / [a] all edits this session / [N] deny: '
        : 'Approve this operation? [y/N]: '
    ),
    signal
  });
  if (answer.type === 'interrupt') {
    console.log(chalk.yellow('\nCancelling the current operation...'));
    throw new OperationAbortedError('Approval cancelled');
  }
  const normalizedAnswer = answer.type === 'line'
    ? answer.value.trim().toLowerCase()
    : undefined;
  return normalizedAnswer === 'y'
    ? 'allow-once' as const
    : allowsEditSession && normalizedAnswer === 'a'
      ? 'allow-edits-session' as const
      : 'deny' as const;
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
    console.log(chalk.gray(
      `Session ${sessionStatus.sessionId.slice(0, 8)} | ` +
      `autosave ${sessionStatus.autoSave ? 'on' : 'off'}`
    ));
    console.log(chalk.gray(
      `Session saves are stored locally in ` +
      `${options.session.sessionStore.workspaceDirectory}`
    ));
  }
  console.log(chalk.cyan('\nSyzzz Code - Interactive Mode'));
  console.log(chalk.gray('Type your message and press Enter. Press Ctrl+C twice to exit.'));
  console.log(chalk.gray('Type / to browse interactive commands.\n'));

  const terminal = new TerminalInputController();
  const commandContext: InteractiveCommandContext = {
    engine,
    terminal,
    streamOutput: options.streamOutput ?? true,
    availableModels: options.availableModels ??
      (providerInfo?.model ? [providerInfo.model] : []),
    persistStreamOutput: options.persistStreamOutput,
    persistModel: options.persistModel,
    session: options.session,
    getProviderOptions: options.getProviderOptions,
    activateProvider: options.activateProvider,
    modelsForProvider: options.modelsForProvider
  };
  const commandRegistry = createCommandRegistry(commandContext);
  const slashSuggestions = createSlashSuggestionProvider(
    commandRegistry,
    () => commandContext
  );

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
        suggestionProviders: [slashSuggestions],
        history: true
      });
      if (input.type === 'eof') {
        break;
      }
      if (input.type === 'interrupt') {
        handleIdleInterrupt();
        continue;
      }

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
          const result = await executeSlashCommand(
            trimmedInput,
            commandRegistry,
            commandContext,
            commandController.signal
          );
          if (result === 'exit') {
            break;
          }
          if (typeof result === 'object') {
            message = result.submitMessage;
          } else {
            continue;
          }
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
        message = trimmedInput.startsWith('//')
          ? trimmedInput.slice(1)
          : trimmedInput;
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
            requestApproval: (request, signal) =>
              requestApproval(request, signal, terminal)
          },
          event => renderer.handle(event)
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
