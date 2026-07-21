import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import type { QueryEngine } from './engine.js';
import {
  DEFAULT_PERMISSION_MODE,
  formatPermissionModesHelp,
  parsePermissionMode,
  permissionModeTitle,
  type PermissionMode
} from './permissions/mode.js';
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

function getEnginePermissionMode(engine: QueryEngine): PermissionMode {
  if (typeof engine.getPermissionMode === 'function') {
    return engine.getPermissionMode();
  }
  return DEFAULT_PERMISSION_MODE;
}

function setEnginePermissionMode(engine: QueryEngine, mode: PermissionMode): void {
  if (typeof engine.setPermissionMode === 'function') {
    engine.setPermissionMode(mode);
  }
}

function buildPrompt(mode: PermissionMode): string {
  return chalk.blue(`You [${mode}]: `);
}

async function handlePermissionsCommand(
  engine: QueryEngine,
  argument: string | undefined,
  lineQueue: TerminalLineQueue,
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
    console.log(chalk.yellow(
      'Type y to confirm. Any other input cancels.'
    ));
    process.stdout.write(chalk.red('Enable Full Access for this session? [y/N]: '));
    const confirmation = await lineQueue.read(signal);
    if (confirmation?.trim().toLowerCase() !== 'y') {
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

export async function runInteractiveSession(engine: QueryEngine): Promise<void> {
  console.log(chalk.cyan('\nSyzzz Code - Interactive Mode'));
  console.log(chalk.gray('Type your message and press Enter. Press Ctrl+C twice to exit.'));
  console.log(chalk.gray('Use /permissions to view or change the session permission mode.\n'));

  const readlineInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(getEnginePermissionMode(engine))
  });
  const lineQueue = new TerminalLineQueue();

  let lastInterruptAt = 0;
  let isClosed = false;
  let activeOperationAbortController: AbortController | undefined;

  const refreshPrompt = () => {
    readlineInterface.setPrompt(buildPrompt(getEnginePermissionMode(engine)));
  };

  readlineInterface.on('line', line => {
    lineQueue.push(line);
  });

  readlineInterface.on('SIGINT', () => {
    if (activeOperationAbortController && !activeOperationAbortController.signal.aborted) {
      console.log(chalk.yellow('\nCancelling the current operation...'));
      activeOperationAbortController.abort(new OperationAbortedError());
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
    refreshPrompt();
    readlineInterface.prompt();
  });

  readlineInterface.on('close', () => {
    isClosed = true;
    lineQueue.close();
  });

  while (!isClosed) {
    refreshPrompt();
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

    if (message === '/permissions' || message.startsWith('/permissions ')) {
      const argument = message === '/permissions'
        ? undefined
        : message.slice('/permissions'.length).trim();
      const permissionAbortController = new AbortController();
      activeOperationAbortController = permissionAbortController;
      try {
        await handlePermissionsCommand(
          engine,
          argument,
          lineQueue,
          permissionAbortController.signal
        );
      } catch (error) {
        if (isAbortError(error)) {
          console.log(chalk.yellow('\nPermission command cancelled.\n'));
        } else {
          const reason = error instanceof Error ? error.message : String(error);
          console.error(chalk.red('\nError:'), reason + '\n');
        }
      } finally {
        if (activeOperationAbortController === permissionAbortController) {
          activeOperationAbortController = undefined;
        }
      }
      continue;
    }

    const spinner = ora({
      text: 'Thinking...',
      discardStdin: false
    }).start();
    const turnAbortController = new AbortController();
    activeOperationAbortController = turnAbortController;

    try {
      const response = await engine.chat(message, {
        signal: turnAbortController.signal,
        requestApproval: async (request, signal) => {
          spinner.stop();
          console.log(formatApprovalRequest(request));
          const allowsEditSession = request.choices.includes('allow-edits-session');
          process.stdout.write(chalk.yellow(
            allowsEditSession
              ? 'Approve? [y] once / [a] all edits this session / [N] deny: '
              : 'Approve this operation? [y/N]: '
          ));
          const answer = await lineQueue.read(signal);
          const normalizedAnswer = answer?.trim().toLowerCase();
          const approvalChoice = normalizedAnswer === 'y' || normalizedAnswer === 'yes'
            ? 'allow-once'
            : allowsEditSession && normalizedAnswer === 'a'
              ? 'allow-edits-session'
              : 'deny';

          if (!signal.aborted) {
            spinner.start();
          }
          return approvalChoice;
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
      if (activeOperationAbortController === turnAbortController) {
        activeOperationAbortController = undefined;
      }
    }
  }

  console.log(chalk.yellow('\nGoodbye!\n'));
}
