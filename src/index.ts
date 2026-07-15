#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline/promises';
import type { Interface as ReadlineInterface } from 'readline/promises';
import { QueryEngine } from './engine.js';
import { loadConfig, saveConfig, getCurrentProviderConfig } from './config.js';
import { runInteractiveSession } from './interactive.js';

const program = new Command();

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
      const engine = new QueryEngine();
      await runInteractiveSession(engine);
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
  .action(async (options) => {
    try {
      const engine = new QueryEngine();

      if (options.message) {
        const response = await engine.chat(options.message);
        console.log(chalk.green('\nAssistant:\n') + response + '\n');
        return;
      }

      await runInteractiveSession(engine);
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
