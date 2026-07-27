import chalk from 'chalk';
import type { AgentEvent, TurnResult } from './events.js';

export interface SpinnerController {
  readonly isSpinning: boolean;
  text?: string;
  start?(): unknown;
  stop(): unknown;
}

interface RendererOutput {
  write(value: string): unknown;
}

export interface HumanTurnStats {
  toolCalls: number;
  toolFailures: number;
  retries: number;
  compactions: number;
}

export interface HumanEventRendererOptions {
  streamOutput: boolean;
  spinner?: SpinnerController;
  output?: RendererOutput;
}

const PERSISTENT_SUCCESS_TOOLS = new Set(['Write', 'Edit', 'Patch', 'Shell']);
const MAX_TOOL_ERROR_CHARACTERS = 300;

export function stopSpinnerIfActive(
  spinner: SpinnerController | undefined
): void {
  if (spinner?.isSpinning) {
    spinner.stop();
  }
}

export async function consumeAgentTurn(
  turn: AsyncGenerator<AgentEvent, TurnResult>,
  onEvent: (event: AgentEvent) => void | Promise<void>
): Promise<TurnResult> {
  while (true) {
    const next = await turn.next();
    if (next.done) {
      return next.value;
    }
    await onEvent(next.value);
  }
}

export function sanitizeAgentEventForStream(event: AgentEvent): AgentEvent {
  if (event.type !== 'tool_completed') {
    return event;
  }

  const { result: _result, metadata: _metadata, ...safeEvent } = event;
  return safeEvent as AgentEvent;
}

export function serializeAgentEvent(event: AgentEvent): string {
  return JSON.stringify(sanitizeAgentEventForStream(event)).replace(
    /[\u007f-\uffff]/g,
    character =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

export function formatTurnFooter(
  result: Extract<TurnResult, { status: 'completed' }>,
  stats?: Partial<HumanTurnStats>
): string {
  const fields: string[] = [];
  if (result.usage) {
    fields.push(
      `tokens ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`
    );
  }
  if (stats?.toolCalls) {
    fields.push(
      stats.toolFailures
        ? `tools ${stats.toolCalls} (${stats.toolFailures} failed)`
        : `tools ${stats.toolCalls}`
    );
  }
  if (stats?.retries) {
    fields.push(`retries ${stats.retries}`);
  }
  if (stats?.compactions) {
    fields.push(`compactions ${stats.compactions}`);
  }
  fields.push(`${(result.durationMs / 1_000).toFixed(1)}s`);
  if (result.finishReason) {
    fields.push(`finish: ${result.finishReason}`);
  }
  return fields.join(' | ');
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs}ms`
    : `${(durationMs / 1_000).toFixed(1)}s`;
}

function summarizeToolError(result: string | undefined): string | undefined {
  const summary = result
    ?.replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TOOL_ERROR_CHARACTERS);
  return summary || undefined;
}

function immediateRecoveryStatus(
  event: Extract<AgentEvent, { type: 'retry_scheduled' }>
): string | undefined {
  if (event.delayMs !== 0) {
    return undefined;
  }
  if (event.reason === 'malformed_response') {
    return 'Adjusting provider response mode...';
  }
  if (event.reason === 'unsupported_feature') {
    return 'Adjusting provider compatibility...';
  }
  return undefined;
}

export class HumanEventRenderer {
  private readonly streamOutput: boolean;
  private readonly spinner?: SpinnerController;
  private readonly output: RendererOutput;
  private assistantStarted = false;
  private openTextLine = false;
  private readonly stats: HumanTurnStats = {
    toolCalls: 0,
    toolFailures: 0,
    retries: 0,
    compactions: 0
  };

  constructor(options: HumanEventRendererOptions) {
    this.streamOutput = options.streamOutput;
    this.spinner = options.spinner;
    this.output = options.output ?? process.stdout;
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'phase_changed':
        if (event.phase === 'provider') {
          this.startSpinner('Thinking...');
        } else if (event.phase === 'compaction') {
          this.startSpinner('Compacting context...');
        }
        break;
      case 'compaction_started':
        this.stopForStatus();
        this.startSpinner('Compacting context...');
        break;
      case 'compaction_completed':
        this.stopForStatus();
        this.stats.compactions += 1;
        break;
      case 'compaction_failed':
        this.stopForStatus();
        this.writeLine(chalk.yellow(
          `Context compaction failed (${event.error.code})`
        ));
        break;
      case 'reasoning_status':
        this.setSpinnerText(
          event.status === 'started' ? 'Reasoning...' : 'Thinking...'
        );
        break;
      case 'text_delta':
        if (!this.streamOutput) {
          this.startSpinner('Responding...');
          break;
        }
        stopSpinnerIfActive(this.spinner);
        this.startAssistant();
        this.output.write(event.delta);
        this.openTextLine = !event.delta.endsWith('\n');
        break;
      case 'retry_scheduled':
        this.stopForStatus();
        this.stats.retries += 1;
        if (event.purpose === 'compaction') {
          this.startSpinner('Retrying context compaction...');
          break;
        }
        {
          const recoveryStatus = immediateRecoveryStatus(event);
          if (recoveryStatus) {
            this.startSpinner(recoveryStatus);
            break;
          }
        }
        this.writeLine(chalk.yellow(
          `Retrying attempt ${event.nextAttempt} in ${event.delayMs}ms (${event.reason})`
        ));
        this.startSpinner('Retrying...');
        break;
      case 'approval_requested':
        this.stopForStatus();
        break;
      case 'tool_started':
        this.stopForStatus();
        this.startSpinner(`Running ${event.toolName}...`);
        break;
      case 'tool_completed': {
        this.stopForStatus();
        this.stats.toolCalls += 1;
        if (event.outcome !== 'success') {
          this.stats.toolFailures += 1;
        }

        const shouldPersist = event.outcome !== 'success' ||
          PERSISTENT_SUCCESS_TOOLS.has(event.toolName);
        if (shouldPersist) {
          const summary = event.outcome === 'success'
            ? undefined
            : summarizeToolError(event.result);
          const line = `${event.toolName} ${event.outcome} ` +
            `(${formatDuration(event.durationMs)})` +
            (summary ? `: ${summary}` : '');
          this.writeLine(
            event.outcome === 'success'
              ? chalk.gray(line)
              : chalk.yellow(line)
          );
        }
        break;
      }
      case 'turn_completed':
      case 'turn_failed':
      case 'turn_cancelled':
        this.stopForStatus();
        break;
      default:
        break;
    }
  }

  finish(result: TurnResult): void {
    this.stopForStatus();
    if (result.status !== 'completed') {
      return;
    }
    if ((!this.streamOutput || !this.assistantStarted) && result.response) {
      this.startAssistant();
      this.output.write(result.response);
      this.openTextLine = !result.response.endsWith('\n');
      this.stopForStatus();
    }
    this.writeLine(chalk.gray(formatTurnFooter(result, this.stats)));
    this.output.write('\n');
  }

  stop(): void {
    this.stopForStatus();
  }

  getStats(): Readonly<HumanTurnStats> {
    return { ...this.stats };
  }

  private startAssistant(): void {
    if (this.assistantStarted) {
      return;
    }
    this.output.write(chalk.green('\nAssistant:\n'));
    this.assistantStarted = true;
  }

  private stopForStatus(): void {
    stopSpinnerIfActive(this.spinner);
    if (this.openTextLine) {
      this.output.write('\n');
      this.openTextLine = false;
    }
  }

  private startSpinner(text: string): void {
    this.setSpinnerText(text);
    if (this.spinner && !this.spinner.isSpinning) {
      this.spinner.start?.();
    }
  }

  private setSpinnerText(text: string): void {
    if (this.spinner) {
      this.spinner.text = text;
    }
  }

  private writeLine(value: string): void {
    this.output.write(`${value}\n`);
  }
}

export function turnResultExitCode(result: TurnResult): 0 | 1 | 130 {
  return result.status === 'completed'
    ? 0
    : result.status === 'cancelled'
      ? 130
      : 1;
}
