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
  inspectConfig,
  loadConfig,
  repairConfig,
  resolveProviderCredential,
  saveConfig,
  type Config,
  type ProviderConfigItem,
  type UiFrameRate,
  type UiLanguage,
  type UiMode
} from './config.js';
import { TaskCompositionRuntime } from './composition/runtime.js';
import { SkillInstaller, type SkillInstallPreview } from './composition/skill-installer.js';
import {
  createSkill,
  validateSkillDescriptors,
  validateSkillPath
} from './composition/skill-authoring.js';
import { runSkillActivationEval } from './composition/skill-eval.js';
import { runDoctor } from './doctor.js';
import { QueryEngine } from './engine.js';
import { ExtensionRuntime } from './extensions/runtime.js';
import { manageHooks, manageMcp } from './extensions/management.js';
import { runInteractiveSession, type InteractiveProviderOption } from './interactive.js';
import { parseAgentMode, type AgentMode } from './modes.js';
import { PermissionGrantStore } from './permissions/grant-store.js';
import { createProvider } from './providers/factory.js';
import { readHiddenInput } from './secret-input.js';
import {
  SessionController,
  type SessionEngineRequest,
  type SessionEngineResult
} from './session-controller.js';
import { PACKAGE_VERSION } from './version.js';
import { SessionStore } from './session-store.js';
import { isAbortError, OperationAbortedError } from './tools/abort.js';
import { detectUiCapabilities, resolveUiMode } from './ui-mode.js';
import { RagRuntime } from './rag/runtime.js';
import { createProviderRagQueryRewriter } from './rag/query-rewriter.js';
import { createProviderRagAnswerRepairer, createProviderRagVerifier } from './rag/verifier.js';
import { manageRag } from './rag/management.js';

const program = new Command();

type OutputFormat = 'text' | 'stream-json';
type StreamDisplayMode = 'on' | 'off';

interface InteractiveStartupOptions {
  continue?: boolean;
  resume?: string;
  streamOutput?: boolean;
  ui?: UiMode;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function formatSkillInstallPreview(preview: SkillInstallPreview): string {
  const lines = [
    `${preview.action.toUpperCase()} Skill ${preview.name}`,
    ...(preview.sourceUrl ? [`Source: ${preview.sourceUrl}`] : []),
    ...(preview.previousCommit ? [`Previous commit: ${preview.previousCommit}`] : []),
    ...(preview.resolvedCommit ? [`Commit: ${preview.resolvedCommit}`] : []),
    `Target: ${preview.targetPath}`,
    `Files: ${preview.fileCount}; bytes: ${preview.totalBytes}; scripts: ${preview.scriptCount}`
  ];
  if (preview.files.length > 0) {
    lines.push('File list:', ...preview.files.map((path) => `  ${path}`));
  }
  lines.push(
    'Installing a Skill does not execute its scripts or change permissions/workspace trust.'
  );
  return lines.join('\n');
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

function parseUiMode(value: string): UiMode {
  if (value === 'auto' || value === 'tui' || value === 'inline') {
    return value;
  }
  throw new Error('UI mode must be "auto", "tui", or "inline"');
}

function providerWithModel(provider: ProviderConfigItem, model: string): ProviderConfigItem {
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
      [
        ...Object.values(config.providers).map((provider) => provider.env.API_KEY_ENV),
        config.rag.embedding?.env.API_KEY_ENV,
        config.rag.reranker?.env.API_KEY_ENV,
        config.rag.service?.apiKeyEnv
      ].filter((name): name is string => Boolean(name))
    )
  ];
}

function configuredProviderCredentialEnvironmentNames(): string[] {
  const inspection = inspectConfig();
  return inspection.status === 'valid' ? providerCredentialEnvironmentNames(inspection.config) : [];
}

async function createConfiguredEngine(request: SessionEngineRequest): Promise<SessionEngineResult> {
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
      warnings.push(`Saved model "${request.model}" is unavailable; using "${model}".`);
    }
  }
  const provider = createProvider(providerWithModel(selected.provider, model));
  const extensions = new ExtensionRuntime({
    workspaceRoot: process.cwd(),
    subagentsEnabled: config.subagents.enabled,
    subagentsAvailable: Boolean(provider.fork),
    forbiddenEnvironmentNames: providerCredentialEnvironmentNames(config)
  });
  const composition = await TaskCompositionRuntime.create({
    workspaceRoot: process.cwd()
  });
  const audit = new LocalAuditLogger({
    config: config.audit,
    sessionId: request.sessionId,
    workspaceRoot: process.cwd()
  });
  const rag = new RagRuntime({
    workspaceRoot: process.cwd(),
    config: config.rag,
    queryRewriter: createProviderRagQueryRewriter(provider),
    semanticVerifier: createProviderRagVerifier(provider),
    answerRepairer: createProviderRagAnswerRepairer(provider)
  });
  await rag.getStatus();
  const engine = new QueryEngine({
    provider,
    sessionId: request.sessionId,
    mode: request.mode,
    workspaceRoot: process.cwd(),
    context: config.context,
    audit,
    extensions,
    composition,
    rag
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

function createInteractiveOptions(controller: SessionController, streamOutput?: boolean) {
  const config = loadConfig();
  const provider = config.providers[controller.providerId];
  return {
    streamOutput: streamOutput ?? config.ui.streamOutput,
    persistentHistory: config.ui.persistentHistory,
    uiLanguage: config.ui.language,
    uiFrameRate: config.ui.frameRate,
    ragAutoRetrieve: config.rag.autoRetrieve,
    contextWindowTokens: config.context.defaultWindowTokens,
    availableModels: provider?.models ?? [controller.engine.getProviderInfo().model],
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
    persistHistoryEnabled(enabled: boolean) {
      const latest = loadConfig();
      latest.ui.persistentHistory = enabled;
      saveConfig(latest);
    },
    persistContextWindow(tokens: number) {
      const latest = loadConfig();
      latest.context.defaultWindowTokens = tokens;
      saveConfig(latest);
    },
    persistUiLanguage(language: UiLanguage) {
      const latest = loadConfig();
      latest.ui.language = language;
      saveConfig(latest);
    },
    persistUiFrameRate(frameRate: UiFrameRate) {
      const latest = loadConfig();
      latest.ui.frameRate = frameRate;
      saveConfig(latest);
    },
    persistRagAutoRetrieve(mode: Config['rag']['autoRetrieve']) {
      const latest = loadConfig();
      latest.rag.autoRetrieve = mode;
      saveConfig(latest);
    },
    persistModel(model: string, providerId: string) {
      const latest = loadConfig();
      const resolvedProviderId = providerId || latest.currentProvider;
      const latestProvider = latest.providers[resolvedProviderId];
      if (!latestProvider) {
        throw new Error(`Provider ${resolvedProviderId} no longer exists in configuration`);
      }
      if (!latestProvider.models.includes(model)) {
        throw new Error(`Model ${model} is not configured for Provider ${resolvedProviderId}`);
      }
      latestProvider.model = model;
      saveConfig(latest);
    },
    getProviderOptions: providerOptions,
    modelsForProvider(providerId: string) {
      return loadConfig().providers[providerId]?.models ?? [];
    },
    createSkillEvalProvider() {
      const latest = loadConfig();
      const selected = usableProvider(latest, controller.providerId);
      if (!selected) {
        throw new Error(`Current Provider ${controller.providerId} is unavailable`);
      }
      const model = controller.engine.getProviderInfo().model;
      return createProvider(providerWithModel(selected.provider, model));
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

async function startInteractive(options: InteractiveStartupOptions = {}): Promise<void> {
  if (options.continue && options.resume) {
    throw new Error('--continue and --resume cannot be used together');
  }
  const config = loadConfig();
  const store = await SessionStore.create({
    workspaceRoot: process.cwd()
  });
  const initial = await createConfiguredEngine({
    sessionId: randomUUID(),
    mode: 'code'
  });
  const controller = await SessionController.create({
    store,
    engine: initial.engine,
    providerId: initial.providerId,
    autoSave: config.sessions.autoSave,
    engineFactory: createConfiguredEngine,
    permissionGrants: new PermissionGrantStore()
  });

  try {
    const requestedUi = options.ui ?? config.ui.mode;
    const selectedUi = resolveUiMode(requestedUi, detectUiCapabilities());
    let resumed;
    if (options.resume) {
      resumed = await controller.resume(options.resume);
    } else if (options.continue) {
      resumed = await controller.continueLatest();
    } else if (config.sessions.startup === 'continue') {
      const latest = (await controller.list()).find((session) => session.available);
      if (latest) resumed = await controller.resume(latest.sessionId);
    }
    if (resumed?.warning) {
      console.warn(chalk.yellow(resumed.warning));
    }
    const interactiveOptions = createInteractiveOptions(controller, options.streamOutput);
    if (selectedUi === 'tui') {
      let runTuiSession: typeof import('./tui/runner.js').runTuiSession;
      try {
        ({ runTuiSession } = await import('./tui/runner.js'));
      } catch (error) {
        if (requestedUi !== 'auto') {
          throw error;
        }
        console.warn(
          chalk.yellow(
            `TUI initialization is unavailable; falling back to inline mode: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        await runInteractiveSession(controller.engine, interactiveOptions);
        return;
      }
      let summary;
      try {
        summary = await runTuiSession(controller.engine, {
          ...interactiveOptions,
          persistentHistory: config.ui.persistentHistory,
          promptSessionStartup:
            !options.resume && !options.continue && config.sessions.startup === 'ask' && !resumed
        });
      } catch (error) {
        const sessionId = controller.getStatus().sessionId;
        console.error(
          chalk.red(
            `TUI exited unexpectedly. Terminal state was restored; resume with: syzzz --resume ${sessionId}`
          )
        );
        throw error;
      }
      console.log(
        chalk.gray(
          `Session ${summary.sessionId.slice(0, 8)} | persistence ${summary.persistence} | exit ${summary.reason}`
        )
      );
      return;
    }
    await runInteractiveSession(controller.engine, interactiveOptions);
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
      (event) => {
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
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= optionCount) {
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
  .version(PACKAGE_VERSION)
  .option('-c, --continue', 'Resume the latest session in this workspace')
  .option('-r, --resume <id>', 'Resume a session by ID or unique prefix')
  .option('--ui <mode>', 'Interactive UI: auto, tui, or inline')
  .action(async (options) => {
    try {
      await startInteractive({
        continue: options.continue,
        resume: options.resume,
        ...(options.ui ? { ui: parseUiMode(options.ui) } : {})
      });
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
        console.log(`TUI FPS:     ${config.ui.frameRate}`);
        console.log(`Autosave:    ${config.sessions.autoSave ? 'on' : 'off'}`);
        console.log(
          `API Key:     ${
            credential.source === 'missing' ? 'not configured' : `configured (${credential.source})`
          }\n`
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
        console.log(
          chalk.green(`\nAPI key configuration updated for ${config.currentProvider}.\n`)
        );
        return;
      }

      if (action === 'set' && key === 'sessions.autoSave' && value) {
        const normalized = value.toLowerCase();
        if (!['on', 'off', 'true', 'false'].includes(normalized)) {
          throw new Error('sessions.autoSave must be on or off');
        }
        config.sessions.autoSave = normalized === 'on' || normalized === 'true';
        saveConfig(config);
        console.log(
          chalk.green(
            `\nSession autosave set to ` + `${config.sessions.autoSave ? 'on' : 'off'}.\n`
          )
        );
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
      const defaultModelIndex = Math.max(0, selected.models.indexOf(selected.model));
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
      console.log(chalk.green(`\nSwitched to ${selected.name} (${selected.model})\n`));
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
        if (!options.yes && !(await confirmAction(`Delete session ${id}?`))) {
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
          !(await confirmAction(`Delete unlocked sessions older than ${days} days?`))
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
  .command('rag')
  .description('Index and search trusted workspace knowledge')
  .argument(
    '<action>',
    'Action: status, doctor, add, index, refresh, search, inspect, clear, collections, mount, unmount'
  )
  .argument('[target]', 'Collection, chunk ID, subaction, or first query word')
  .argument('[rest...]', 'Additional query words or collection arguments')
  .option('--path <directory>', 'External collection directory')
  .option('--name <filename>', 'Target filename for rag add')
  .option('--collection <name>', 'Target collection for rag add (currently library)')
  .option('-y, --yes', 'Skip an explicit destructive or remote-ingestion confirmation')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (action, target, rest, options) => {
    const abortController = new AbortController();
    const handleInterrupt = () => abortController.abort(new OperationAbortedError());
    process.once('SIGINT', handleInterrupt);
    const runtime = new RagRuntime({ workspaceRoot: process.cwd(), config: loadConfig().rag });
    try {
      const result = await manageRag({
        runtime,
        action,
        target,
        rest,
        path: options.path,
        name: options.name,
        collection: options.collection,
        yes: Boolean(options.yes),
        json: Boolean(options.json),
        signal: abortController.signal,
        confirm: async ({ title, message, preview }) =>
          confirmAction(`${title}\n${message}${preview ? `\n\n${preview}` : ''}`)
      });
      console.log(options.json ? JSON.stringify(result.json) : result.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nRAG command failed:'), `${reason}\n`);
      process.exitCode = isAbortError(error) ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', handleInterrupt);
    }
  });

program
  .command('extensions')
  .description('Inspect extension trust and configuration without connecting')
  .argument('<action>', 'Action: status')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (action, options) => {
    if (String(action).toLowerCase() !== 'status') {
      console.error(chalk.red('\nExtensions command failed: action must be status\n'));
      process.exitCode = 1;
      return;
    }
    const runtime = new ExtensionRuntime({
      workspaceRoot: process.cwd(),
      subagentsEnabled: loadConfig().subagents.enabled,
      subagentsAvailable: false,
      forbiddenEnvironmentNames: configuredProviderCredentialEnvironmentNames()
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
        `Hooks: ${status.hooks.enabled} enabled / ` + `${status.hooks.configured} configured`,
        `Subagents: ${status.subagents.enabled ? 'enabled' : 'disabled'}`
      ];
      for (const server of status.mcp.servers) {
        lines.push(
          `  MCP ${server.name}: ${server.state}, ` + `${server.protocolMode} [${server.source}]`
        );
      }
      for (const hook of status.hooks.entries) {
        lines.push(
          `  Hook ${hook.name}: ${hook.event}, ` +
            `${hook.enabled ? 'enabled' : 'disabled'} [${hook.source}]`
        );
      }
      if (status.warnings.length > 0) {
        lines.push('Warnings:', ...status.warnings.map((warning) => `  ${warning}`));
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
  .argument('<action>', 'Action: list, add, remove, enable, disable, policy, doctor')
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
        forbiddenEnvironmentNames: configuredProviderCredentialEnvironmentNames()
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
  .command('skills')
  .description('Discover, inspect, validate, or manage Agent Skills')
  .argument(
    '<action>',
    'Action: list, inspect, doctor, create, validate, test, install, update, rollback, remove'
  )
  .argument('[target]', 'Skill name or public HTTPS Git URL')
  .option('--ref <ref>', 'Git ref to resolve and pin')
  .option('--skill <name>', 'Select one Skill from a multi-Skill repository')
  .option('--scope <scope>', 'Installation scope: user or project', 'user')
  .option('--description <text>', 'Description for a newly created Skill')
  .option('--body-file <path>', 'Markdown body for a newly created Skill')
  .option('-y, --yes', 'Skip confirmation')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (action, target, options) => {
    const normalizedAction = String(action).toLowerCase();
    const scope = String(options.scope).toLowerCase();
    if (scope !== 'user' && scope !== 'project') {
      console.error(chalk.red('\nSkills command failed: scope must be user or project\n'));
      process.exitCode = 1;
      return;
    }
    const abortController = new AbortController();
    const handleInterrupt = () => abortController.abort(new OperationAbortedError());
    process.once('SIGINT', handleInterrupt);
    try {
      const runtime = await TaskCompositionRuntime.create({
        workspaceRoot: process.cwd()
      });
      if (normalizedAction === 'list') {
        const skills = runtime.listSkills();
        if (options.json) {
          console.log(JSON.stringify(skills));
        } else if (skills.length === 0) {
          console.log('No Skills discovered.');
        } else {
          for (const skill of skills) {
            console.log(
              `${skill.name}  ${skill.enabled ? 'enabled' : 'disabled'}  ` +
                `${skill.source}  ` +
                `${skill.policy.allowImplicitInvocation ? 'implicit' : 'explicit-only'}` +
                `${skill.shadowed ? '  shadowed' : ''}`
            );
          }
        }
        return;
      }
      if (normalizedAction === 'inspect') {
        if (!target) {
          throw new Error('skills inspect requires a Skill name');
        }
        const skill = runtime.inspectSkill(target);
        if (!skill) {
          throw new Error(`Unknown Skill: ${target}`);
        }
        console.log(options.json ? JSON.stringify(skill) : JSON.stringify(skill, null, 2));
        return;
      }
      if (normalizedAction === 'doctor') {
        const status = runtime.getStatus();
        const result = {
          ok: status.skills.invalid === 0,
          skills: status.skills,
          warnings: status.warnings
        };
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `Skills: ${status.skills.available} available, ` +
              `${status.skills.disabled} disabled, ${status.skills.invalid} invalid`
          );
          status.warnings.forEach((warning) => console.log(`WARN: ${warning}`));
        }
        process.exitCode = result.ok ? 0 : 1;
        return;
      }
      if (normalizedAction === 'create') {
        if (!target || !options.description) {
          throw new Error('skills create requires a name and --description <text>');
        }
        const result = await createSkill({
          name: target,
          description: options.description,
          scope,
          bodyFile: options.bodyFile,
          workspaceRoot: process.cwd()
        });
        console.log(
          options.json
            ? JSON.stringify(result)
            : `Created explicit-only Skill ${result.name} at ${result.rootPath}.`
        );
        return;
      }
      if (normalizedAction === 'validate') {
        let results;
        if (!target) {
          results = await validateSkillDescriptors(runtime.listSkills());
        } else {
          const descriptor = runtime.inspectSkill(target);
          results = [await validateSkillPath(descriptor?.rootPath ?? target)];
        }
        const ok = results.every((result) => result.ok);
        if (options.json) {
          console.log(JSON.stringify({ ok, results }));
        } else {
          for (const result of results) {
            console.log(
              `${result.ok ? 'OK' : 'ERROR'} ${result.name ?? '(unknown)'} ${result.path}`
            );
            result.warnings.forEach((warning) => console.log(`  WARN: ${warning}`));
            result.errors.forEach((error) => console.log(`  ERROR: ${error}`));
          }
        }
        process.exitCode = ok ? 0 : 1;
        return;
      }
      if (normalizedAction === 'test') {
        if (!target) {
          throw new Error('skills test requires a Skill name');
        }
        const descriptor = runtime.inspectSkill(target);
        if (!descriptor) {
          throw new Error(`Unknown Skill: ${target}`);
        }
        const config = loadConfig();
        const selected = usableProvider(config, config.currentProvider);
        if (!selected) {
          throw new Error(`No usable Provider is configured for Skill activation testing`);
        }
        const providerFactory = () => createProvider(structuredClone(selected.provider));
        const report = await runSkillActivationEval({
          descriptor,
          workspaceRoot: process.cwd(),
          providerFactory,
          signal: abortController.signal
        });
        if (options.json) {
          console.log(JSON.stringify(report));
        } else {
          for (const result of report.cases) {
            console.log(
              `${result.passed ? 'PASS' : 'FAIL'} ${result.id}: ` +
                `expected ${result.expected}, actual ${result.actual}, ${result.durationMs}ms` +
                `${result.infrastructureError ? `, infrastructure ${result.infrastructureError}` : ''}`
            );
          }
          console.log(
            `Skill activation eval: ${report.passed} passed, ${report.failed} failed, ` +
              `${report.infrastructureFailures} infrastructure failures`
          );
        }
        process.exitCode = report.failed > 0 || report.infrastructureFailures > 0 ? 1 : 0;
        return;
      }
      if (!target) {
        throw new Error(`skills ${normalizedAction} requires a target`);
      }
      const installer = new SkillInstaller({ workspaceRoot: process.cwd() });
      const confirm = options.yes
        ? async () => true
        : async (preview: SkillInstallPreview) => {
            console.log(`\n${formatSkillInstallPreview(preview)}\n`);
            return await confirmAction(`Proceed with Skill ${preview.action}?`);
          };
      if (normalizedAction === 'install') {
        const record = await installer.install(target, {
          ref: options.ref,
          skill: options.skill,
          scope,
          signal: abortController.signal,
          confirm
        });
        console.log(options.json ? JSON.stringify(record) : `Installed ${record.name}.`);
        return;
      }
      if (normalizedAction === 'update') {
        const record = await installer.update(target, {
          scope,
          signal: abortController.signal,
          confirm
        });
        console.log(options.json ? JSON.stringify(record) : `Updated ${record.name}.`);
        return;
      }
      if (normalizedAction === 'rollback') {
        const record = await installer.rollback(target, {
          scope,
          signal: abortController.signal,
          confirm
        });
        console.log(options.json ? JSON.stringify(record) : `Rolled back ${record.name}.`);
        return;
      }
      if (normalizedAction === 'remove') {
        await installer.remove(target, {
          scope,
          signal: abortController.signal,
          confirm
        });
        console.log(
          options.json ? JSON.stringify({ removed: target, scope }) : `Removed ${target}.`
        );
        return;
      }
      throw new Error(
        'skills action must be list, inspect, doctor, create, validate, test, install, update, rollback, or remove'
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nSkills command failed:'), `${reason}\n`);
      process.exitCode = isAbortError(error) ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', handleInterrupt);
    }
  });

program
  .command('doctor')
  .description('Run offline configuration and runtime diagnostics')
  .option('--repair-config', 'Back up and reset a damaged configuration')
  .option('-y, --yes', 'Skip repair confirmation')
  .action(async (options) => {
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
          (await confirmAction(
            inspection.status === 'valid' && inspection.legacy
              ? 'Back up and migrate the legacy configuration?'
              : 'Back up and reset the configuration?'
          ))
        ) {
          const repaired = repairConfig();
          if (repaired.action === 'migrated') {
            console.log(`Configuration migrated to schema v1. Backup: ` + `${repaired.backupPath}`);
          } else if (repaired.action === 'repaired') {
            console.log(`Configuration reset. Backup: ${repaired.backupPath}`);
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
        const marker =
          item.status === 'ok' ? '[OK]' : item.status === 'warning' ? '[WARN]' : '[ERROR]';
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
  .option('--ui <mode>', 'Interactive UI: auto, tui, or inline')
  .action(async (options, command) => {
    try {
      const parentOptions = command.parent?.opts() ?? {};
      const requestedUi = options.ui ?? parentOptions.ui;
      const continueSession = options.continue ?? parentOptions.continue;
      const resumeSession = options.resume ?? parentOptions.resume;
      const outputFormat = parseOutputFormat(options.outputFormat);
      if (outputFormat === 'stream-json' && options.stream !== undefined) {
        throw new Error('--stream cannot be used with --output-format stream-json');
      }
      const config = loadConfig();
      const streamOutput =
        options.stream === undefined
          ? config.ui.streamOutput
          : parseStreamDisplayMode(options.stream) === 'on';
      if (options.message) {
        if (requestedUi !== undefined) {
          throw new Error('--ui is available only for interactive sessions without --message');
        }
        if (continueSession || resumeSession) {
          throw new Error('--continue and --resume are available only for interactive sessions');
        }
        const created = await createConfiguredEngine({
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
        continue: continueSession,
        resume: resumeSession,
        streamOutput,
        ...(requestedUi ? { ui: parseUiMode(requestedUi) } : {})
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
