#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline/promises';
import type { Interface as ReadlineInterface } from 'readline/promises';
import { QueryEngine } from './engine.js';
import {
  consumeAgentTurn,
  HumanEventRenderer,
  serializeAgentEvent,
  turnResultExitCode
} from './cli-renderer.js';
import {
  loadConfig,
  saveConfig,
  getCurrentProviderConfig,
  type Config
} from './config.js';
import { runInteractiveSession } from './interactive.js';
import { OperationAbortedError } from './tools/abort.js';

const program = new Command();

type OutputFormat = 'text' | 'stream-json';
type StreamDisplayMode = 'on' | 'off';

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

function createInteractiveOptions(
  config: Config,
  streamOutput = config.ui.streamOutput
) {
  const providerId = config.currentProvider;
  const provider = config.providers[providerId];

  return {
    streamOutput,
    availableModels: provider.models,
    persistStreamOutput(enabled: boolean) {
      const latestConfig = loadConfig();
      latestConfig.ui.streamOutput = enabled;
      saveConfig(latestConfig);
    },
    persistModel(model: string) {
      const latestConfig = loadConfig();
      const latestProvider = latestConfig.providers[providerId];
      if (!latestProvider) {
        throw new Error(`Provider ${providerId} no longer exists in configuration`);
      }
      if (!latestProvider.models.includes(model)) {
        throw new Error(`Model ${model} is not configured for provider ${providerId}`);
      }
      latestProvider.model = model;
      saveConfig(latestConfig);
    }
  };
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

  const answer = nextLine.value;
  if (!answer.trim()) {
    return defaultIndex;
  }

  const selectedIndex = Number.parseInt(answer.trim(), 10) - 1;
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= optionCount) {
    throw new Error(`Please enter a number between 1 and ${optionCount}`);
  }

  return selectedIndex;
}

program
  .name('syzzz')
  .description('Syzzz Code - AI Programming Assistant')
  .version('1.0.0')
  .action(async () => {
    try {
      const config = loadConfig();
      const engine = new QueryEngine();
      await runInteractiveSession(engine, createInteractiveOptions(config));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nFailed to initialize:'), reason + '\n');
      process.exitCode = 1;
    }
  });

// 配置管理命令
program
  .command('config')
  .description('Manage configuration')
  .argument('<action>', 'Action: list, set')
  .argument('[key]', 'Config key (apiKey)')
  .argument('[value]', 'Config value')
  .action((action, key, value) => {
    const config = loadConfig();

    if (action === 'list') {
      const current = getCurrentProviderConfig();
      console.log(chalk.cyan('\n📊 Current Configuration\n'));
      console.log(chalk.white(`Provider:    ${config.currentProvider} (${current.name})`));
      console.log(chalk.white(`Type:        ${current.type}`));
      console.log(chalk.white(`Model:       ${current.model}`));
      console.log(chalk.white(`Base URL:    ${current.env.BASE_URL}`));
      console.log(chalk.white(`Streaming:   ${config.ui.streamOutput ? 'on' : 'off'}`));
      console.log(chalk.white(`API Key:     ${current.env.API_KEY ? '✓ Set' : '✗ Not set'}\n`));
      return;
    }

    if (action === 'set' && key === 'apiKey' && value) {
      // 设置当前 provider 的 API Key
      config.providers[config.currentProvider].env.API_KEY = value;
      saveConfig(config);
      console.log(chalk.green(`\n✓ API Key set for ${config.currentProvider}\n`));
      return;
    }

    console.error(chalk.red('\nUsage: syzzz config list | syzzz config set apiKey YOUR_KEY\n'));
  });

program
  .command('switch')
  .description('Interactively select a configured provider and model')
  .action(async () => {
    let readlineInterface: ReadlineInterface | undefined;

    try {
      const config = loadConfig();
      const providerEntries = Object.entries(config.providers);
      const defaultProviderIndex = Math.max(
        0,
        providerEntries.findIndex(([providerId]) => providerId === config.currentProvider)
      );

      console.log(chalk.cyan('\nAvailable providers:\n'));
      providerEntries.forEach(([providerId, provider], index) => {
        const currentMarker = providerId === config.currentProvider ? ' (current)' : '';
        console.log(`  ${index + 1}. ${provider.name} [${providerId}]${currentMarker}`);
      });

      readlineInterface = createInterface({
        input: process.stdin,
        output: process.stdout
      });
      const inputLines = readlineInterface[Symbol.asyncIterator]();

      const providerIndex = await selectFromList(
        inputLines,
        '\nSelect provider',
        providerEntries.length,
        defaultProviderIndex
      );
      const [selectedProviderId, selectedProvider] = providerEntries[providerIndex];
      const defaultModelIndex = Math.max(0, selectedProvider.models.indexOf(selectedProvider.model));

      console.log(chalk.cyan(`\nAvailable models for ${selectedProvider.name}:\n`));
      selectedProvider.models.forEach((model, index) => {
        const currentMarker = model === selectedProvider.model ? ' (current)' : '';
        console.log(`  ${index + 1}. ${model}${currentMarker}`);
      });

      const modelIndex = await selectFromList(
        inputLines,
        '\nSelect model',
        selectedProvider.models.length,
        defaultModelIndex
      );

      selectedProvider.model = selectedProvider.models[modelIndex];
      config.currentProvider = selectedProviderId;
      saveConfig(config);

      console.log(chalk.green(`\nSwitched to ${selectedProvider.name} (${selectedProvider.model})\n`));
      if (!selectedProvider.env.API_KEY) {
        console.log(chalk.yellow('This provider has no API key configured.'));
        console.log(chalk.gray('Set it with: syzzz config set apiKey YOUR_KEY\n'));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nSwitch failed:'), reason + '\n');
      process.exitCode = 1;
    } finally {
      readlineInterface?.close();
    }
  });

// 对话命令
program
  .command('chat')
  .description('Start chat session')
  .option('-m, --message <text>', 'Send a single message')
  .option('--output-format <format>', 'Output format: text or stream-json', 'text')
  .option('--stream <mode>', 'Text display streaming: on or off')
  .action(async (options) => {
    try {
      const outputFormat = parseOutputFormat(options.outputFormat);
      if (outputFormat === 'stream-json' && options.stream !== undefined) {
        throw new Error('--stream cannot be used with --output-format stream-json');
      }
      const config = loadConfig();
      const streamOutput = options.stream === undefined
        ? config.ui.streamOutput
        : parseStreamDisplayMode(options.stream) === 'on';
      const engine = new QueryEngine();

      if (options.message) {
        process.exitCode = await runSingleMessage(
          engine,
          options.message,
          outputFormat,
          streamOutput
        );
        return;
      }

      if (outputFormat !== 'text') {
        throw new Error('--output-format stream-json requires --message');
      }

      await runInteractiveSession(
        engine,
        createInteractiveOptions(config, streamOutput)
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nChat failed:'), reason + '\n');
      process.exitCode = 1;
    }
  });

// 初始化命令
program
  .command('init')
  .description('Initialize configuration')
  .action(() => {
    const config = loadConfig();
    console.log(chalk.green('\n✓ Configuration initialized'));
    console.log(chalk.cyan(`\nDefault provider: ${config.currentProvider}\n`));
    console.log(chalk.yellow('Set your API key:'));
    console.log(chalk.white('  syzzz config set apiKey YOUR_KEY\n'));
  });

await program.parseAsync(process.argv);
