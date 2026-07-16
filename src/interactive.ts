import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import type { QueryEngine } from './engine.js';
import type { ToolApprovalRequest } from './types.js';
import { isAbortError, OperationAbortedError } from './tools/abort.js';

const DOUBLE_INTERRUPT_WINDOW_MS = 2_000;
const MAX_APPROVAL_PREVIEW_CHARACTERS = 20_000;

interface PendingLineReader {
  resolve: (line: string | null) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  handleAbort?: () => void;
}

class TerminalLineQueue {
  private lines: string[] = [];
  private readers: PendingLineReader[] = [];
  private isClosed = false;

  push(line: string): void {
    const reader = this.readers.shift();
    if (!reader) {
      this.lines.push(line);
      return;
    }

    this.detachAbortListener(reader);
    reader.resolve(line);
  }

  close(): void {
    this.isClosed = true;
    for (const reader of this.readers.splice(0)) {
      this.detachAbortListener(reader);
      reader.resolve(null);
    }
  }

  read(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) {
      return Promise.reject(new OperationAbortedError());
    }

    const queuedLine = this.lines.shift();
    if (queuedLine !== undefined) {
      return Promise.resolve(queuedLine);
    }
    if (this.isClosed) {
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      const reader: PendingLineReader = { resolve, reject, signal };
      if (signal) {
        reader.handleAbort = () => {
          const readerIndex = this.readers.indexOf(reader);
          if (readerIndex !== -1) {
            this.readers.splice(readerIndex, 1);
          }
          this.detachAbortListener(reader);
          reject(new OperationAbortedError());
        };
        signal.addEventListener('abort', reader.handleAbort, { once: true });
      }

      this.readers.push(reader);
      if (signal?.aborted) {
        reader.handleAbort?.();
      }
    });
  }

  private detachAbortListener(reader: PendingLineReader): void {
    if (reader.signal && reader.handleAbort) {
      reader.signal.removeEventListener('abort', reader.handleAbort);
    }
  }
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

export async function runInteractiveSession(engine: QueryEngine): Promise<void> {
  console.log(chalk.cyan('\nSyzzz Code - Interactive Mode'));
  console.log(chalk.gray('Type your message and press Enter. Press Ctrl+C twice to exit.\n'));

  const readlineInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('You: ')
  });
  const lineQueue = new TerminalLineQueue();

  let lastInterruptAt = 0;
  let isClosed = false;
  let activeTurnAbortController: AbortController | undefined;

  readlineInterface.on('line', line => {
    lineQueue.push(line);
  });

  readlineInterface.on('SIGINT', () => {
    if (activeTurnAbortController && !activeTurnAbortController.signal.aborted) {
      console.log(chalk.yellow('\nCancelling the current operation...'));
      activeTurnAbortController.abort(new OperationAbortedError());
      return;
    }

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
    lineQueue.close();
  });

  while (!isClosed) {
    readlineInterface.prompt();
    const input = await lineQueue.read();
    if (input === null) {
      break;
    }

    const message = input.trim();
    lastInterruptAt = 0;

    if (!message) {
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
    const turnAbortController = new AbortController();
    activeTurnAbortController = turnAbortController;

    try {
      const response = await engine.chat(message, {
        signal: turnAbortController.signal,
        requestApproval: async (request, signal) => {
          spinner.stop();
          console.log(formatApprovalRequest(request));
          process.stdout.write(chalk.yellow('Approve this operation? [y/N]: '));
          const answer = await lineQueue.read(signal);
          const isApproved = answer?.trim().toLowerCase() === 'y' ||
            answer?.trim().toLowerCase() === 'yes';

          if (!signal.aborted) {
            spinner.start();
          }
          return isApproved;
        }
      });
      console.log(chalk.green('\nAssistant:\n') + response + '\n');
    } catch (error) {
      if (isAbortError(error)) {
        console.log(chalk.yellow('\nCurrent operation cancelled.\n'));
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(chalk.red('\nError:'), reason + '\n');
      }
    } finally {
      spinner.stop();
      if (activeTurnAbortController === turnAbortController) {
        activeTurnAbortController = undefined;
      }
    }
  }

  console.log(chalk.yellow('\nGoodbye!\n'));
}
