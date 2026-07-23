import chalk from 'chalk';
import ora from 'ora';
import type { QueryEngine, ChatOptions } from './engine.js';
import type { AgentEvent, TurnResult } from './events.js';
import {
  consumeAgentTurn,
  HumanEventRenderer
} from './cli-renderer.js';
import {
  CommandRegistry,
  createSlashSuggestionProvider,
  parseSlashCommand,
  type CommandChoice,
  type CommandDefinition,
  type CommandExecutionResult
} from './interactive-commands.js';
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
import type { ToolApprovalRequest } from './types.js';
import { isAbortError, OperationAbortedError } from './tools/abort.js';

const DOUBLE_INTERRUPT_WINDOW_MS = 2_000;
const MAX_APPROVAL_PREVIEW_CHARACTERS = 20_000;

export type StreamDisplayMode = 'on' | 'off';

export interface InteractiveSessionOptions {
  streamOutput?: boolean;
  availableModels?: readonly string[];
  persistStreamOutput?: (enabled: boolean) => void | Promise<void>;
  persistModel?: (model: string) => void | Promise<void>;
}

interface InteractiveCommandContext {
  engine: QueryEngine;
  terminal: TerminalInputController;
  streamOutput: boolean;
  availableModels: readonly string[];
  persistStreamOutput?: (enabled: boolean) => void | Promise<void>;
  persistModel?: (model: string) => void | Promise<void>;
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

function buildPrompt(mode: PermissionMode): string {
  return chalk.blue(`You [${mode}]: `);
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

function findConfiguredModel(
  models: readonly string[],
  requested: string
): string | undefined {
  const normalized = requested.trim().toLowerCase();
  return models.find(model => model.toLowerCase() === normalized);
}

function formatCommandsHelp(
  registry: CommandRegistry<InteractiveCommandContext>,
  context: InteractiveCommandContext
): string {
  const lines = ['Available commands:'];
  for (const command of registry.list(context)) {
    const aliases = command.aliases?.length
      ? ` (aliases: ${command.aliases.map(alias => `/${alias}`).join(', ')})`
      : '';
    const hint = command.argumentHint ? ` ${command.argumentHint}` : '';
    lines.push(`  /${command.name}${hint}${aliases}`);
    lines.push(`    ${command.description}`);
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

  register({
    name: 'stream',
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
        await commandContext.persistModel?.(nextModel);
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
    description: 'Show available interactive commands.',
    execute(_argument, commandContext) {
      console.log(chalk.cyan(`\n${formatCommandsHelp(registry, commandContext)}\n`));
      return 'continue';
    }
  });

  register({
    name: 'exit',
    aliases: ['quit'],
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
    persistModel: options.persistModel
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
        prompt: buildPrompt(getEnginePermissionMode(engine)),
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
        } catch (error) {
          if (isAbortError(error)) {
            const reason = error instanceof Error ? error.message : 'Command cancelled';
            console.log(chalk.yellow(`\n${reason}\n`));
          } else {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(chalk.red('\nCommand failed:'), reason + '\n');
          }
        } finally {
          if (activeOperationAbortController === commandController) {
            activeOperationAbortController = undefined;
          }
        }
        continue;
      }

      const message = trimmedInput.startsWith('//')
        ? trimmedInput.slice(1)
        : trimmedInput;
      const spinner = ora({ text: 'Thinking...', discardStdin: false }).start();
      const renderer = new HumanEventRenderer({
        streamOutput: commandContext.streamOutput,
        spinner
      });
      const turnAbortController = new AbortController();
      activeOperationAbortController = turnAbortController;

      try {
        const result = await consumeInteractiveTurn(
          engine,
          message,
          {
            signal: turnAbortController.signal,
            requestApproval: (request, signal) =>
              requestApproval(request, signal, terminal)
          },
          event => renderer.handle(event)
        );

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
  }

  console.log(chalk.yellow('\nGoodbye!\n'));
}
