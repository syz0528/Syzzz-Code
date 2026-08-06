import chalk from 'chalk';
import type { TerminalInputController } from '../terminal-input.js';
import { OperationAbortedError } from '../tools/abort.js';
import type {
  ToolApprovalChoice,
  ToolApprovalRequest,
  UserInputAnswers,
  UserInputRequest
} from '../types.js';
import type {
  ConfirmRequest,
  InteractionNotice,
  InteractionPort,
  SelectRequest,
  TextInputRequest
} from './types.js';
import type { WorkspaceInputHistory } from './history.js';

function paint(notice: InteractionNotice): string {
  switch (notice.tone) {
    case 'success':
      return chalk.green(notice.text);
    case 'warning':
      return chalk.yellow(notice.text);
    case 'error':
      return chalk.red(notice.text);
    case 'muted':
      return chalk.gray(notice.text);
    default:
      return chalk.cyan(notice.text);
  }
}

export class InlineInteractionPort implements InteractionPort {
  constructor(
    private readonly terminal: TerminalInputController,
    private readonly history?: WorkspaceInputHistory
  ) {}

  notice(notice: InteractionNotice): void {
    console.log(paint(notice));
  }

  async confirm(request: ConfirmRequest, signal: AbortSignal): Promise<boolean> {
    this.notice({ tone: 'warning', text: `\n${request.title}\n${request.message}` });
    if (request.preview) {
      this.notice({ tone: 'muted', text: request.preview });
    }
    const answer = await this.terminal.readLine({
      prompt: chalk.yellow(`Confirm [${request.confirmToken}/N]: `),
      signal
    });
    if (answer.type === 'interrupt') {
      this.notice({ tone: 'warning', text: '\nCancelling the current operation...' });
      throw new OperationAbortedError(`${request.title} cancelled`);
    }
    return (
      answer.type === 'line' &&
      (answer.value === request.confirmToken ||
        (request.confirmToken === 'y' && answer.value === 'Y'))
    );
  }

  async select(request: SelectRequest, signal: AbortSignal): Promise<string | undefined> {
    this.notice({ tone: 'info', text: `\n${request.title}` });
    if (request.message) {
      this.notice({ tone: 'muted', text: request.message });
    }
    request.choices.forEach((choice, index) => {
      const current = choice.current ? ' *' : '';
      this.notice({
        tone: 'info',
        text: `  ${index + 1}. ${choice.label}${current}${choice.description ? ` - ${choice.description}` : ''}`
      });
    });
    const initialIndex = Math.max(
      0,
      request.choices.findIndex((choice) => choice.value === request.initialValue)
    );
    const answer = await this.terminal.readLine({
      prompt: `Select [${initialIndex + 1}]: `,
      signal
    });
    if (answer.type === 'interrupt') {
      throw new OperationAbortedError(`${request.title} cancelled`);
    }
    if (answer.type !== 'line') {
      return undefined;
    }
    const value = answer.value.trim();
    const index = value ? Number.parseInt(value, 10) - 1 : initialIndex;
    return Number.isInteger(index) && index >= 0 && index < request.choices.length
      ? request.choices[index]?.value
      : undefined;
  }

  async textInput(request: TextInputRequest, signal: AbortSignal): Promise<string | undefined> {
    if (request.hidden) {
      throw new Error('Hidden input is unavailable through the standard inline interaction port');
    }
    const answer = await this.terminal.readLine({
      prompt: `${request.title}${request.message ? ` - ${request.message}` : ''}: `,
      signal
    });
    if (answer.type === 'interrupt') {
      throw new OperationAbortedError(`${request.title} cancelled`);
    }
    if (answer.type !== 'line') {
      return undefined;
    }
    if (
      request.maximumCharacters !== undefined &&
      answer.value.length > request.maximumCharacters
    ) {
      throw new Error(`Input exceeds ${request.maximumCharacters} characters`);
    }
    return answer.value;
  }

  async requestApproval(
    request: ToolApprovalRequest,
    signal: AbortSignal
  ): Promise<ToolApprovalChoice> {
    const allowsEditSession = request.choices.includes('allow-edits-session');
    const preview = [
      `Approval required: ${request.toolName} (${request.risk})`,
      request.description,
      ...(request.preview ? ['', request.preview] : [])
    ].join('\n');
    this.notice({ tone: 'warning', text: `\n${preview}` });
    const answer = await this.terminal.readLine({
      prompt: chalk.yellow(
        allowsEditSession
          ? 'Approve? [y] once / [a] all edits this session / [N] deny: '
          : 'Approve this operation? [y/N]: '
      ),
      signal
    });
    if (answer.type === 'interrupt') {
      throw new OperationAbortedError('Approval cancelled');
    }
    const normalized = answer.type === 'line' ? answer.value.trim().toLowerCase() : '';
    if (normalized === 'y') {
      return 'allow-once';
    }
    if (allowsEditSession && normalized === 'a') {
      return 'allow-edits-session';
    }
    return 'deny';
  }

  async requestUserInput(
    request: UserInputRequest,
    signal: AbortSignal
  ): Promise<UserInputAnswers> {
    const answers: UserInputAnswers = {};
    for (const question of request.questions) {
      if (question.kind === 'text') {
        const answer = await this.textInput(
          {
            title: question.header,
            message: question.prompt,
            maximumCharacters: 4 * 1024
          },
          signal
        );
        if (answer === undefined) {
          throw new OperationAbortedError('Question cancelled');
        }
        answers[question.id] = answer;
        continue;
      }
      if (question.kind === 'single') {
        const answer = await this.select(
          {
            title: question.header,
            message: question.prompt,
            choices: (question.options ?? []).map((option) => ({ ...option }))
          },
          signal
        );
        if (answer === undefined) {
          throw new OperationAbortedError('Question cancelled');
        }
        answers[question.id] = answer;
        continue;
      }

      this.notice({ tone: 'info', text: `\n${question.header}\n${question.prompt}` });
      for (const option of question.options ?? []) {
        this.notice({
          tone: 'info',
          text: `  ${option.value}: ${option.label}${option.description ? ` - ${option.description}` : ''}`
        });
      }
      const answer = await this.textInput(
        {
          title: 'Select one or more comma-separated values',
          maximumCharacters: 4 * 1024
        },
        signal
      );
      if (answer === undefined) {
        throw new OperationAbortedError('Question cancelled');
      }
      answers[question.id] = answer
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    return answers;
  }

  async suspendTerminal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw new OperationAbortedError();
    }
    return operation();
  }

  historyStatus(): { enabled: boolean; entries: number; path: string } {
    return {
      enabled: this.history?.isEnabled ?? false,
      entries: this.history?.list().length ?? 0,
      path: this.history?.path ?? '(not configured)'
    };
  }

  async setHistoryEnabled(enabled: boolean): Promise<void> {
    await this.history?.setEnabled(enabled);
  }

  async clearHistory(): Promise<void> {
    await this.history?.clear();
    this.terminal.replaceHistory([]);
  }
}
