#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'node:readline/promises';
import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { LocalAuditLogger } from './audit.js';
import {
  consumeAgentTurn,
  HumanEventRenderer,
  serializeAgentEvent,
  turnResultExitCode
} from './cli-renderer.js';
import {
  getCurrentProviderConfig,
  inspectConfig,
  loadConfig,
  repairConfig,
  resolveProviderCredential,
  saveConfig,
  type Config,
  type ProviderConfigItem
} from './config.js';
import { runDoctor } from './doctor.js';
import { QueryEngine } from './engine.js';
import { ExtensionRuntime } from './extensions/runtime.js';
import {
  manageHooks,
  manageMcp
} from './extensions/management.js';
import {
  runInteractiveSession,
  type InteractiveProviderOption
} from './interactive.js';
import {
  parseAgentMode,
  type AgentMode
} from './modes.js';
import { createProvider } from './providers/factory.js';
import { readHiddenInput } from './secret-input.js';
import {
  SessionController,
  type SessionEngineRequest,
  type SessionEngineResult
} from './session-controller.js';
import { SessionStore } from './session-store.js';
import { isAbortError, OperationAbortedError } from './tools/abort.js';

const program = new Command();

type OutputFormat = 'text' | 'stream-json';
type StreamDisplayMode = 'on' | 'off';

interface InteractiveStartupOptions {
  continue?: boolean;
  resume?: string;
  streamOutput?: boolean;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseOutputFormat(value: string): OutputFormat {
  if (value === 'text' || value === 'stream-json') {
    return value;
  }
  throw new Error('output format must be "text" or "stream-json"');
}

function parseStreamDisplayMode(value: string): StreamDisplayMode {
  if (value === 'on' || value === 'off') {
    return value;
  }
  throw new Error('stream display mode must be "on" or "off"');
}

function parseMode(value: string): AgentMode {
  const mode = parseAgentMode(value);
  if (!mode) {
    throw new Error('mode must be "ask", "plan", or "code"');
  }
  return mode;
}

function providerWithModel(
  provider: ProviderConfigItem,
  model: string
): ProviderConfigItem {
  return {
    ...provider,
    model,
    models: [...provider.models],
    ...(provider.modelContextWindows
      ? { modelContextWindows: { ...provider.modelContextWindows } }
      : {}),
    env: { ...provider.env }
  };
}

function usableProvider(
  config: Config,
  providerId: string | undefined
): { id: string; provider: ProviderConfigItem } | undefined {
  if (!providerId) {
    return undefined;
  }
  const provider = config.providers[providerId];
  return provider && resolveProviderCredential(provider).value
    ? { id: providerId, provider }
    : undefined;
}

function providerCredentialEnvironmentNames(config: Config): string[] {
  return [
    ...new Set(
      Object.values(config.providers)
        .map(provider => provider.env.API_KEY_ENV)
        .filter((name): name is string => Boolean(name))
    )
  ];
}

function configuredProviderCredentialEnvironmentNames(): string[] {
  const inspection = inspectConfig();
  return inspection.status === 'valid'
    ? providerCredentialEnvironmentNames(inspection.config)
    : [];
}

function createConfiguredEngine(
  request: SessionEngineRequest
): SessionEngineResult {
  const config = loadConfig();
  const warnings: string[] = [];
  let selected = usableProvider(config, request.providerId);
  if (!selected) {
    selected = usableProvider(config, config.currentProvider);
    if (request.providerId && request.providerId !== config.currentProvider) {
      warnings.push(
        `Saved Provider "${request.providerId}" is unavailable; ` +
        `using "${config.currentProvider}".`
      );
    }
  }
  if (!selected) {
    throw new Error(
      `No API key found for Provider "${config.currentProvider}". ` +
      'Run "syzzz config set apiKey" or configure API_KEY_ENV.'
    );
  }

  let model = selected.provider.model;
  if (request.model) {
    if (selected.provider.models.includes(request.model)) {
      model = request.model;
    } else {
      warnings.push(
        `Saved model "${request.model}" is unavailable; using "${model}".`
      );
    }
  }
  const provider = createProvider(providerWithModel(selected.provider, model));
  const extensions = new ExtensionRuntime({
    workspaceRoot: process.cwd(),
    subagentsEnabled: config.subagents.enabled,
    subagentsAvailable: Boolean(provider.fork),
    forbiddenEnvironmentNames: providerCredentialEnvironmentNames(config)
  });
  const audit = new LocalAuditLogger({
    config: config.audit,
    sessionId: request.sessionId,
    workspaceRoot: process.cwd()
  });
  const engine = new QueryEngine({
    provider,
    sessionId: request.sessionId,
    mode: request.mode,
    workspaceRoot: process.cwd(),
    context: config.context,
    audit,
    extensions
  });
  return {
    engine,
    providerId: selected.id,
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
  };
}

function providerOptions(): InteractiveProviderOption[] {
  const config = loadConfig();
  return Object.entries(config.providers).map(([id, provider]) => {
    const credential = resolveProviderCredential(provider);
    return {
      id,
      name: provider.name,
      model: provider.model,
      models: provider.models,
      available: credential.source !== 'missing',
      ...(credential.source === 'missing'
        ? {
            unavailableReason: credential.environmentVariable
              ? `${credential.environmentVariable} is unset and no stored key exists`
              : 'No API key is configured'
          }
        : {})
    };
  });
}

function createInteractiveOptions(
  controller: SessionController,
  streamOutput?: boolean
) {
  const config = loadConfig();
  const provider = config.providers[controller.providerId];
  return {
    streamOutput: streamOutput ?? config.ui.streamOutput,
    availableModels: provider?.models ??
      [controller.engine.getProviderInfo().model],
    session: controller,
    persistStreamOutput(enabled: boolean) {
      const latest = loadConfig();
      latest.ui.streamOutput = enabled;
      saveConfig(latest);
    },
    persistSubagentsEnabled(enabled: boolean) {
      const latest = loadConfig();
      latest.subagents.enabled = enabled;
      saveConfig(latest);
    },
    persistModel(model: string, providerId: string) {
      const latest = loadConfig();
      const resolvedProviderId = providerId || latest.currentProvider;
      const latestProvider = latest.providers[resolvedProviderId];
      if (!latestProvider) {
        throw new Error(
          `Provider ${resolvedProviderId} no longer exists in configuration`
        );
      }
      if (!latestProvider.models.includes(model)) {
        throw new Error(
          `Model ${model} is not configured for Provider ${resolvedProviderId}`
        );
      }
      latestProvider.model = model;
      saveConfig(latest);
    },
    getProviderOptions: providerOptions,
    modelsForProvider(providerId: string) {
      return loadConfig().providers[providerId]?.models ?? [];
    },
    async activateProvider(providerId: string, engine: QueryEngine) {
      const latest = loadConfig();
      const nextConfig = latest.providers[providerId];
      if (!nextConfig) {
        throw new Error(`Unknown Provider: ${providerId}`);
      }
      if (!resolveProviderCredential(nextConfig).value) {
        throw new Error(`Provider ${providerId} has no usable credentials`);
      }

      const nextProvider = createProvider(nextConfig);
      latest.currentProvider = providerId;
      saveConfig(latest);
      engine.setProvider(nextProvider);
      return {
        providerId,
        models: nextConfig.models
      };
    }
  };
}

async function startInteractive(
  options: InteractiveStartupOptions = {}
): Promise<void> {
  if (options.continue && options.resume) {
    throw new Error('--continue and --resume cannot be used together');
  }
  const config = loadConfig();
  const store = await SessionStore.create({
    workspaceRoot: process.cwd()
  });
  const initial = createConfiguredEngine({
    sessionId: randomUUID(),
    mode: 'code'
  });
  const controller = await SessionController.create({
    store,
    engine: initial.engine,
    providerId: initial.providerId,
    autoSave: config.sessions.autoSave,
    engineFactory: createConfiguredEngine
  });

  try {
    let resumed;
    if (options.resume) {
      resumed = await controller.resume(options.resume);
    } else if (options.continue) {
      resumed = await controller.continueLatest();
    }
    if (resumed?.warning) {
      console.warn(chalk.yellow(resumed.warning));
    }
    await runInteractiveSession(
      controller.engine,
      createInteractiveOptions(controller, options.streamOutput)
    );
  } catch (error) {
    await controller.close();
    throw error;
  }
}

async function runSingleMessage(
  engine: QueryEngine,
  message: string,
  outputFormat: OutputFormat,
  streamOutput: boolean
): Promise<number> {
  const abortController = new AbortController();
  const handleInterrupt = () => {
    abortController.abort(new OperationAbortedError());
  };
  process.once('SIGINT', handleInterrupt);
  let renderer: HumanEventRenderer | undefined;

  try {
    if (outputFormat === 'text') {
      const info = engine.getProviderInfo();
      console.log(chalk.green(`Using ${info.name} (${info.model})`));
      renderer = new HumanEventRenderer({
        streamOutput,
        spinner: ora({ text: 'Thinking...', discardStdin: false }).start()
      });
    }
    const result = await consumeAgentTurn(
      engine.runTurn(message, { signal: abortController.signal }),
      event => {
        if (outputFormat === 'stream-json') {
          process.stdout.write(`${serializeAgentEvent(event)}\n`);
        } else {
          renderer?.handle(event);
        }
      }
    );
    if (outputFormat === 'text') {
      renderer?.finish(result);
      if (result.status === 'cancelled') {
        console.error(chalk.yellow('Operation cancelled.'));
      } else if (result.status === 'failed') {
        console.error(chalk.red('Chat failed:'), result.error.message);
      }
    }
    return turnResultExitCode(result);
  } finally {
    renderer?.stop();
    process.removeListener('SIGINT', handleInterrupt);
    await engine.close();
  }
}

async function selectFromList(
  inputLines: AsyncIterator<string>,
  prompt: string,
  optionCount: number,
  defaultIndex: number
): Promise<number> {
  process.stdout.write(`${prompt} [${defaultIndex + 1}]: `);
  const nextLine = await inputLines.next();
  if (nextLine.done) {
    throw new Error('Input closed before selection was completed');
  }
  if (!nextLine.value.trim()) {
    return defaultIndex;
  }
  const selectedIndex = Number.parseInt(nextLine.value.trim(), 10) - 1;
  if (
    !Number.isInteger(selectedIndex) ||
    selectedIndex < 0 ||
    selectedIndex >= optionCount
  ) {
    throw new Error(`Please enter a number between 1 and ${optionCount}`);
  }
  return selectedIndex;
}

async function readStdinValue(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (value.length > 16_384) {
      throw new Error('Input exceeds 16384 characters');
    }
  }
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) {
    throw new Error('No value was received on stdin');
  }
  return firstLine;
}

async function confirmAction(prompt: string): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await terminal.question(`${prompt} [y/N]: `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    terminal.close();
  }
}

program
  .name('syzzz')
  .description('Syzzz Code - AI Programming Assistant')
  .version('1.0.0')
  .option('-c, --continue', 'Resume the latest session in this workspace')
  .option('-r, --resume <id>', 'Resume a session by ID or unique prefix')
  .action(async options => {
    try {
      await startInteractive(options);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nFailed to initialize:'), `${reason}\n`);
      process.exitCode = 1;
    }
  });

const configCommand = program
  .command('config')
  .description('Manage configuration')
  .argument('<action>', 'Action: list, set, unset')
  .argument('[key]', 'Configuration key')
  .argument('[value]', 'Value for non-secret settings')
  .option('--stdin', 'Read a secret from stdin')
  .option('--from-env <name>', 'Resolve the API key from an environment variable')
  .action(async (action, key, value, options) => {
    try {
      const config = loadConfig();
      const current = config.providers[config.currentProvider];
      if (action === 'list') {
        const credential = resolveProviderCredential(current);
        console.log(chalk.cyan('\nCurrent configuration\n'));
        console.log(`Schema:      v${config.schemaVersion}`);
        console.log(`Provider:    ${config.currentProvider} (${current.name})`);
        console.log(`Type:        ${current.type}`);
        console.log(`Model:       ${current.model}`);
        console.log(`Base URL:    ${current.env.BASE_URL}`);
        console.log(`Streaming:   ${config.ui.streamOutput ? 'on' : 'off'}`);
        console.log(`Autosave:    ${config.sessions.autoSave ? 'on' : 'off'}`);
        console.log(
          `API Key:     ${credential.source === 'missing'
            ? 'not configured'
            : `configured (${credential.source})`}\n`
        );
        return;
      }

      if (action === 'set' && key === 'apiKey') {
        if (value) {
          throw new Error(
            'API keys are not accepted as command-line values; ' +
            'use hidden input, --stdin, or --from-env'
          );
        }
        if (options.stdin && options.fromEnv) {
          throw new Error('--stdin and --from-env cannot be used together');
        }
        if (options.fromEnv) {
          current.env.API_KEY = '';
          current.env.API_KEY_ENV = options.fromEnv;
        } else {
          const apiKey = options.stdin
            ? await readStdinValue()
            : await readHiddenInput({ prompt: 'API Key: ' });
          if (!apiKey) {
            throw new Error('API key cannot be empty');
          }
          current.env.API_KEY = apiKey;
          delete current.env.API_KEY_ENV;
        }
        saveConfig(config);
        console.log(chalk.green(
          `\nAPI key configuration updated for ${config.currentProvider}.\n`
        ));
        return;
      }

      if (
        action === 'set' &&
        key === 'sessions.autoSave' &&
        value
      ) {
        const normalized = value.toLowerCase();
        if (!['on', 'off', 'true', 'false'].includes(normalized)) {
          throw new Error('sessions.autoSave must be on or off');
        }
        config.sessions.autoSave =
          normalized === 'on' || normalized === 'true';
        saveConfig(config);
        console.log(chalk.green(
          `\nSession autosave set to ` +
          `${config.sessions.autoSave ? 'on' : 'off'}.\n`
        ));
        return;
      }

      if (action === 'unset' && key === 'apiKey') {
        current.env.API_KEY = '';
        delete current.env.API_KEY_ENV;
        saveConfig(config);
        console.log(chalk.green('\nAPI key configuration removed.\n'));
        return;
      }

      throw new Error(
        'Usage: syzzz config list | syzzz config set apiKey ' +
        '[--stdin|--from-env NAME] | ' +
        'syzzz config set sessions.autoSave on|off'
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nConfiguration failed:'), `${reason}\n`);
      process.exitCode = 1;
    }
  });
void configCommand;

program
  .command('switch')
  .description('Interactively select a configured Provider and model')
  .action(async () => {
    let readlineInterface: ReadlineInterface | undefined;
    try {
      const config = loadConfig();
      const providerEntries = Object.entries(config.providers);
      const defaultProviderIndex = Math.max(
        0,
        providerEntries.findIndex(([id]) => id === config.currentProvider)
      );
      console.log(chalk.cyan('\nAvailable Providers:\n'));
      providerEntries.forEach(([id, provider], index) => {
        const marker = id === config.currentProvider ? ' (current)' : '';
        console.log(`  ${index + 1}. ${provider.name} [${id}]${marker}`);
      });
      readlineInterface = createInterface({
        input: process.stdin,
        output: process.stdout
      });
      const inputLines = readlineInterface[Symbol.asyncIterator]();
      const providerIndex = await selectFromList(
        inputLines,
        '\nSelect Provider',
        providerEntries.length,
        defaultProviderIndex
      );
      const [selectedId, selected] = providerEntries[providerIndex];
      const defaultModelIndex = Math.max(
        0,
        selected.models.indexOf(selected.model)
      );
      console.log(chalk.cyan(`\nAvailable models for ${selected.name}:\n`));
      selected.models.forEach((model, index) => {
        const marker = model === selected.model ? ' (current)' : '';
        console.log(`  ${index + 1}. ${model}${marker}`);
      });
      const modelIndex = await selectFromList(
        inputLines,
        '\nSelect model',
        selected.models.length,
        defaultModelIndex
      );
      selected.model = selected.models[modelIndex];
      config.currentProvider = selectedId;
      saveConfig(config);
      console.log(chalk.green(
        `\nSwitched to ${selected.name} (${selected.model})\n`
      ));
      if (!resolveProviderCredential(selected).value) {
        console.log(chalk.yellow('This Provider has no usable API key.'));
        console.log(chalk.gray('Run: syzzz config set apiKey\n'));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nSwitch failed:'), `${reason}\n`);
      process.exitCode = 1;
    } finally {
      readlineInterface?.close();
    }
  });

program
  .command('sessions')
  .description('List, delete, or prune saved sessions')
  .argument('<action>', 'Action: list, delete, prune')
  .argument('[id]', 'Session ID or unique prefix')
  .option('--older-than <days>', 'Prune sessions older than this many days')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (action, id, options) => {
    try {
      const store = await SessionStore.create({
        workspaceRoot: process.cwd()
      });
      if (action === 'list') {
        const sessions = await store.list();
        if (sessions.length === 0) {
          console.log('No saved sessions for this workspace.');
          return;
        }
        for (const session of sessions) {
          console.log(
            `${session.sessionId}  ${session.updatedAt}  ` +
            `${session.mode.padEnd(4)}  ${session.title}` +
            `${session.available ? '' : ' [unavailable]'}`
          );
        }
        return;
      }
      if (action === 'delete') {
        if (!id) {
          throw new Error('sessions delete requires an ID or unique prefix');
        }
        if (
          !options.yes &&
          !await confirmAction(`Delete session ${id}?`)
        ) {
          console.log('Session was not deleted.');
          return;
        }
        const deleted = await store.delete(id);
        console.log(`Deleted session ${deleted}.`);
        return;
      }
      if (action === 'prune') {
        const days = Number.parseInt(options.olderThan, 10);
        if (!Number.isInteger(days) || days < 0) {
          throw new Error('sessions prune requires --older-than <days>');
        }
        if (
          !options.yes &&
          !await confirmAction(`Delete unlocked sessions older than ${days} days?`)
        ) {
          console.log('Sessions were not pruned.');
          return;
        }
        const removed = await store.prune(days);
        console.log(`Pruned ${removed.length} session(s).`);
        return;
      }
      throw new Error('sessions action must be list, delete, or prune');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nSession command failed:'), `${reason}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('extensions')
  .description('Inspect extension trust and configuration without connecting')
  .argument('<action>', 'Action: status')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (action, options) => {
    if (String(action).toLowerCase() !== 'status') {
      console.error(chalk.red(
        '\nExtensions command failed: action must be status\n'
      ));
      process.exitCode = 1;
      return;
    }
    const runtime = new ExtensionRuntime({
      workspaceRoot: process.cwd(),
      subagentsEnabled: loadConfig().subagents.enabled,
      subagentsAvailable: false,
      forbiddenEnvironmentNames:
        configuredProviderCredentialEnvironmentNames()
    });
    try {
      const status = runtime.getStatus();
      if (options.json) {
        console.log(JSON.stringify(status));
        return;
      }
      const lines = [
        `Trust: ${status.trustState}`,
        `MCP: ${status.mcp.configured} configured, ` +
          `${status.mcp.disconnected} disconnected, ${status.mcp.error} error`,
        `Hooks: ${status.hooks.enabled} enabled / ` +
          `${status.hooks.configured} configured`,
        `Subagents: ${status.subagents.enabled ? 'enabled' : 'disabled'}`
      ];
      for (const server of status.mcp.servers) {
        lines.push(
          `  MCP ${server.name}: ${server.state}, ` +
          `${server.protocolMode} [${server.source}]`
        );
      }
      for (const hook of status.hooks.entries) {
        lines.push(
          `  Hook ${hook.name}: ${hook.event}, ` +
          `${hook.enabled ? 'enabled' : 'disabled'} [${hook.source}]`
        );
      }
      if (status.warnings.length > 0) {
        lines.push(
          'Warnings:',
          ...status.warnings.map(warning => `  ${warning}`)
        );
      }
      console.log(lines.join('\n'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nExtensions command failed:'), `${reason}\n`);
      process.exitCode = 1;
    } finally {
      await runtime.close();
    }
  });

program
  .command('mcp')
  .description('Manage and diagnose MCP servers')
  .argument(
    '<action>',
    'Action: list, add, remove, enable, disable, policy, doctor'
  )
  .argument('[name]', 'MCP server name')
  .argument('[command...]', 'stdio command and arguments after the server name')
  .option('--scope <scope>', 'Configuration scope: user or project', 'user')
  .option('--url <url>', 'Configure a Streamable HTTP endpoint')
  .option(
    '--header <name=value>',
    'Add an HTTP header template; repeat for multiple headers',
    collectOption,
    []
  )
  .option(
    '--env <name=value>',
    'Add a stdio environment template; repeat for multiple variables',
    collectOption,
    []
  )
  .option('--protocol-mode <mode>', 'MCP protocol mode: legacy or modern')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (action, name, command, options) => {
    const abortController = new AbortController();
    const handleInterrupt = () => {
      abortController.abort(new OperationAbortedError());
    };
    process.once('SIGINT', handleInterrupt);
    try {
      const result = await manageMcp({
        action,
        name,
        command,
        scope: options.scope,
        url: options.url,
        headers: options.header,
        environment: options.env,
        protocolMode: options.protocolMode,
        json: options.json,
        workspaceRoot: process.cwd(),
        signal: abortController.signal,
        forbiddenEnvironmentNames:
          configuredProviderCredentialEnvironmentNames()
      });
      console.log(options.json ? JSON.stringify(result.json) : result.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nMCP command failed:'), `${reason}\n`);
      process.exitCode = isAbortError(error) ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', handleInterrupt);
    }
  });

program
  .command('hooks')
  .description('Manage and validate local command Hooks')
  .argument('<action>', 'Action: list, add, remove, enable, disable, doctor')
  .argument('[name]', 'Hook name')
  .argument('[command...]', 'Hook command and arguments after the name')
  .option('--scope <scope>', 'Configuration scope: user or project', 'user')
  .option('--event <event>', 'Hook lifecycle event')
  .option('--matcher <glob>', 'Tool matcher glob')
  .option('--timeout-ms <milliseconds>', 'Hook timeout')
  .option('--on-error <policy>', 'Failure policy: continue or deny')
  .option(
    '--env <name=value>',
    'Add a Hook environment template; repeat for multiple variables',
    collectOption,
    []
  )
  .option('--json', 'Emit machine-readable JSON')
  .action(async (action, name, command, options) => {
    try {
      const result = await manageHooks({
        action,
        name,
        command,
        scope: options.scope,
        event: options.event,
        matcher: options.matcher,
        timeoutMs: options.timeoutMs,
        onError: options.onError,
        environment: options.env,
        json: options.json,
        workspaceRoot: process.cwd()
      });
      console.log(options.json ? JSON.stringify(result.json) : result.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nHooks command failed:'), `${reason}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Run offline configuration and runtime diagnostics')
  .option('--repair-config', 'Back up and reset a damaged configuration')
  .option('-y, --yes', 'Skip repair confirmation')
  .action(async options => {
    try {
      if (options.repairConfig) {
        const inspection = inspectConfig();
        if (inspection.status === 'valid' && !inspection.legacy) {
          console.log('Configuration is already valid; no repair was applied.');
        } else if (inspection.status === 'unsupported') {
          throw new Error(
            `Configuration schemaVersion ${inspection.version} cannot be ` +
            'repaired by this build; upgrade Syzzz Code instead'
          );
        } else if (
          options.yes ||
          await confirmAction(
            inspection.status === 'valid' && inspection.legacy
              ? 'Back up and migrate the legacy configuration?'
              : 'Back up and reset the configuration?'
          )
        ) {
          const repaired = repairConfig();
          if (repaired.action === 'migrated') {
            console.log(
              `Configuration migrated to schema v1. Backup: ` +
              `${repaired.backupPath}`
            );
          } else if (repaired.action === 'repaired') {
            console.log(
              `Configuration reset. Backup: ${repaired.backupPath}`
            );
          } else if (repaired.action === 'initialized') {
            console.log('Configuration initialized.');
          }
        } else {
          console.log('Configuration repair cancelled.');
        }
      }
      const result = await runDoctor();
      console.log(chalk.cyan('\nSyzzz doctor\n'));
      for (const item of result.checks) {
        const marker = item.status === 'ok'
          ? '[OK]'
          : item.status === 'warning'
            ? '[WARN]'
            : '[ERROR]';
        console.log(`${marker.padEnd(7)} ${item.name}: ${item.message}`);
      }
      console.log('');
      process.exitCode = result.hasErrors ? 1 : 0;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nDoctor failed:'), `${reason}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('chat')
  .description('Start a chat session')
  .option('-m, --message <text>', 'Send a single message')
  .option('--output-format <format>', 'Output format: text or stream-json', 'text')
  .option('--stream <mode>', 'Text display streaming: on or off')
  .option('--mode <mode>', 'Work mode: ask, plan, or code', 'code')
  .option('-c, --continue', 'Resume the latest interactive session')
  .option('-r, --resume <id>', 'Resume an interactive session by ID or prefix')
  .action(async options => {
    try {
      const outputFormat = parseOutputFormat(options.outputFormat);
      if (outputFormat === 'stream-json' && options.stream !== undefined) {
        throw new Error(
          '--stream cannot be used with --output-format stream-json'
        );
      }
      const config = loadConfig();
      const streamOutput = options.stream === undefined
        ? config.ui.streamOutput
        : parseStreamDisplayMode(options.stream) === 'on';
      if (options.message) {
        if (options.continue || options.resume) {
          throw new Error(
            '--continue and --resume are available only for interactive sessions'
          );
        }
        const created = createConfiguredEngine({
          sessionId: randomUUID(),
          mode: parseMode(options.mode)
        });
        process.exitCode = await runSingleMessage(
          created.engine,
          options.message,
          outputFormat,
          streamOutput
        );
        return;
      }
      if (outputFormat !== 'text') {
        throw new Error('--output-format stream-json requires --message');
      }
      await startInteractive({
        continue: options.continue,
        resume: options.resume,
        streamOutput
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nChat failed:'), `${reason}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Initialize configuration')
  .action(() => {
    const config = loadConfig();
    console.log(chalk.green('\nConfiguration initialized'));
    console.log(chalk.cyan(`\nDefault Provider: ${config.currentProvider}\n`));
    console.log(chalk.yellow('Set your API key with hidden input:'));
    console.log(chalk.white('  syzzz config set apiKey\n'));
  });

await program.parseAsync(process.argv);
