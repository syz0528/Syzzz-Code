#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import { QueryEngine } from './engine.js';
import { loadConfig, saveConfig } from './config.js';

const program = new Command();

program
  .name('syzzz')
  .description('Syzzz Code - AI Programming Assistant')
  .version('1.0.0');

// 模型选择命令
program
  .command('model')
  .description('Select AI model')
  .action(() => {
    const config = loadConfig();
    console.log(chalk.cyan('\n🤖 Syzzz Code - Model Selection\n'));
    console.log(chalk.gray('Available models:\n'));
    console.log(chalk.white('1. deepseek-v4-pro') + chalk.gray('     - Most powerful, best quality'));
    console.log(chalk.white('2. deepseek-v4-flash') + chalk.gray('   - Fast and economical\n'));
    console.log(chalk.yellow(`Current model: ${config.model}\n`));
    
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question(chalk.blue('Select model (1 or 2): '), (answer) => {
      const models = ['deepseek-v4-pro', 'deepseek-v4-flash'];
      const choice = parseInt(answer.trim());
      
      if (choice === 1 || choice === 2) {
        const selectedModel = models[choice - 1];
        saveConfig({ model: selectedModel });
        console.log(chalk.green(`\n✓ Model set to: ${selectedModel}`));
      } else {
        console.log(chalk.red('\n✗ Invalid choice'));
      }
      
      rl.close();
    });
  });

program
  .command('chat')
  .description('Start interactive chat session')
  .option('-m, --message <text>', 'Send a single message')
  .option('--model <name>', 'Choose model: deepseek-v4-pro or deepseek-v4-flash')
  .action(async (options) => {
    // 如果指定了模型，临时保存配置
    if (options.model) {
      saveConfig({ model: options.model });
      console.log(chalk.cyan(`✓ Using model: ${options.model}\n`));
    }
    
    const engine = new QueryEngine();

    if (options.message) {
      const spinner = ora('Thinking...').start();
      try {
        const response = await engine.chat(options.message);
        spinner.stop();
        console.log(chalk.green('\nAssistant:\n') + response);
      } catch (error: any) {
        spinner.stop();
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
      return;
    }

    console.log(chalk.cyan('Syzzz Code - Interactive Mode'));
    console.log(chalk.gray('Type your message and press Enter. Type "exit" to quit.\n'));

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.blue('You: ')
    });

    rl.prompt();

    rl.on('line', async (input) => {
      const message = input.trim();

      if (message.toLowerCase() === 'exit') {
        console.log(chalk.yellow('\nGoodbye!'));
        rl.close();
        process.exit(0);
      }

      if (!message) {
        rl.prompt();
        return;
      }

      rl.pause(); // 暂停输入
      const spinner = ora('Thinking...').start();
      try {
        const response = await engine.chat(message, true);
        spinner.stop();
        console.log(chalk.green('\nAssistant:\n') + response + '\n');
      } catch (error: any) {
        spinner.stop();
        console.error(chalk.red('\nError:'), error.message + '\n');
      }

      rl.resume(); // 恢复输入
      rl.prompt();
    });
  });

program
  .command('config')
  .description('Manage configuration')
  .argument('<action>', 'Action: get, set, list')
  .argument('[key]', 'Config key')
  .argument('[value]', 'Config value')
  .action((action, key, value) => {
    const config = loadConfig();

    if (action === 'list') {
      console.log(chalk.cyan('Current Configuration:'));
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    if (action === 'get' && key) {
      console.log(config[key as keyof typeof config]);
      return;
    }

    if (action === 'set' && key && value) {
      saveConfig({ [key]: value });
      console.log(chalk.green(`✓ Set ${key} = ${value}`));
      return;
    }

    console.error(chalk.red('Invalid config command'));
    process.exit(1);
  });

program
  .command('init')
  .description('Initialize Syzzz Code')
  .action(() => {
    const config = loadConfig();
    console.log(chalk.cyan.bold('\n🚀 Syzzz Code Initialization\n'));
    console.log(chalk.green('✓ Syzzz Code initialized'));
    console.log(chalk.gray('Configuration file:'), chalk.cyan('~/.syzzz-code/config.json'));
    console.log(chalk.gray('Current model:'), chalk.yellow(config.model));
    
    if (!config.apiKey && !process.env.ANTHROPIC_API_KEY) {
      console.log(chalk.yellow('\n⚠ No API key found'));
      console.log(chalk.gray('Set your API key with:'));
      console.log(chalk.cyan('  syzzz config set apiKey YOUR_API_KEY'));
      console.log(chalk.gray('Or set in .env file:'));
      console.log(chalk.cyan('  ANTHROPIC_API_KEY=YOUR_API_KEY'));
    } else {
      console.log(chalk.green('\n✓ API key configured'));
    }
    
    console.log(chalk.cyan('\n📚 Quick Start:'));
    console.log(chalk.white('  syzzz model') + chalk.gray('           - Select AI model'));
    console.log(chalk.white('  syzzz chat') + chalk.gray('            - Start interactive mode'));
    console.log(chalk.white('  syzzz chat -m "msg"') + chalk.gray('   - Single message'));
    console.log(chalk.white('  syzzz config list') + chalk.gray('     - View configuration\n'));
  });

program.parse();
