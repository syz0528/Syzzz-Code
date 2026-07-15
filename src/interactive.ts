import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import type { QueryEngine } from './engine.js';

const DOUBLE_INTERRUPT_WINDOW_MS = 2_000;

export async function runInteractiveSession(engine: QueryEngine): Promise<void> {
  console.log(chalk.cyan('\nSyzzz Code - Interactive Mode'));
  console.log(chalk.gray('Type your message and press Enter. Press Ctrl+C twice to exit.\n'));

  const readlineInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('You: ')
  });

  let lastInterruptAt = 0;
  let isClosed = false;

  readlineInterface.on('SIGINT', () => {
    const now = Date.now();
    if (now - lastInterruptAt <= DOUBLE_INTERRUPT_WINDOW_MS) {
      isClosed = true;
      readlineInterface.close();
      return;
    }

    lastInterruptAt = now;
    console.log(chalk.yellow('\nPress Ctrl+C again within two seconds to exit.'));
    readlineInterface.prompt();
  });

  readlineInterface.on('close', () => {
    isClosed = true;
  });

  readlineInterface.prompt();

  for await (const input of readlineInterface) {
    const message = input.trim();
    lastInterruptAt = 0;

    if (!message) {
      if (!isClosed) {
        readlineInterface.prompt();
      }
      continue;
    }

    if (message.toLowerCase() === 'exit') {
      readlineInterface.close();
      break;
    }

    const spinner = ora({
      text: 'Thinking...',
      discardStdin: false
    }).start();

    try {
      const response = await engine.chat(message);
      spinner.stop();
      console.log(chalk.green('\nAssistant:\n') + response + '\n');
    } catch (error) {
      spinner.stop();
      const reason = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nError:'), reason + '\n');
    }

    if (!isClosed) {
      readlineInterface.prompt();
    }
  }

  console.log(chalk.yellow('\nGoodbye!\n'));
}
