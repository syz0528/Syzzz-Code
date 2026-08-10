import { Writable } from 'node:stream';

const BEGIN_SYNCHRONIZED_UPDATE = '\u001B[?2026h';
const END_SYNCHRONIZED_UPDATE = '\u001B[?2026l';
const HIDE_CURSOR = '\u001B[?25l';
const CURSOR_COLUMN_ONE = '\u001B[1G';

function cursorVertical(delta: number): string {
  if (delta === 0) return '';
  return delta > 0 ? `\u001B[${delta}B` : `\u001B[${-delta}A`;
}

/**
 * Ink's changed-line renderer returns to the first row and walks every unchanged
 * row before reaching the composer. Some embedded Windows terminals visibly
 * paint that cursor traversal. Collapse the traversal to one relative jump.
 */
export function compactConservativeTerminalOutput(value: string): string {
  const traversal = /\u001B\[\?25l(?:\u001B\[(\d+)B)?\u001B\[1G\u001B\[(\d+)A((?:\u001B\[E)+)/gu;
  return value
    .replace(
      traversal,
      (_match, downText: string | undefined, upText: string, nextLines: string) => {
        const down = downText ? Number.parseInt(downText, 10) : 0;
        const up = Number.parseInt(upText, 10);
        const next = nextLines.match(/\u001B\[E/gu)?.length ?? 0;
        return `${HIDE_CURSOR}${cursorVertical(down - up + next)}${CURSOR_COLUMN_ONE}`;
      }
    )
    .replace(/(?:\u001B\[E){2,}/gu, (run) => {
      const count = run.match(/\u001B\[E/gu)?.length ?? 1;
      return `\u001B[${count}E`;
    });
}

class SynchronizedFrameCoalescer {
  private pending: string | undefined;

  push(value: string): string {
    let remaining = value;
    let output = '';
    while (remaining.length > 0) {
      if (this.pending === undefined) {
        const begin = remaining.indexOf(BEGIN_SYNCHRONIZED_UPDATE);
        if (begin === -1) {
          output += compactConservativeTerminalOutput(remaining);
          break;
        }
        output += compactConservativeTerminalOutput(remaining.slice(0, begin));
        this.pending = BEGIN_SYNCHRONIZED_UPDATE;
        remaining = remaining.slice(begin + BEGIN_SYNCHRONIZED_UPDATE.length);
        continue;
      }

      const end = remaining.indexOf(END_SYNCHRONIZED_UPDATE);
      if (end === -1) {
        this.pending += remaining;
        break;
      }
      this.pending += remaining.slice(0, end) + END_SYNCHRONIZED_UPDATE;
      output += compactConservativeTerminalOutput(this.pending);
      this.pending = undefined;
      remaining = remaining.slice(end + END_SYNCHRONIZED_UPDATE.length);
    }
    return output;
  }

  flush(): string {
    const output = this.pending ? compactConservativeTerminalOutput(this.pending) : '';
    this.pending = undefined;
    return output;
  }
}

/**
 * Coalesces Ink's three synchronized-frame writes into one physical write for
 * embedded terminals that expose intermediate DEC synchronized-update frames.
 */
export class ConservativeTuiOutput extends Writable {
  readonly isTTY = true;
  private readonly coalescer = new SynchronizedFrameCoalescer();
  private readonly forwardResize = () => this.emit('resize');

  constructor(private readonly target: NodeJS.WriteStream) {
    super({ decodeStrings: false });
    target.on('resize', this.forwardResize);
  }

  get columns(): number {
    return this.target.columns ?? 80;
  }

  get rows(): number {
    return this.target.rows ?? 24;
  }

  getColorDepth(environment?: Record<string, string | undefined>): number {
    return this.target.getColorDepth(environment);
  }

  hasColors(count?: number, environment?: Record<string, string | undefined>): boolean {
    return count === undefined
      ? this.target.hasColors()
      : this.target.hasColors(count, environment);
  }

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const value = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
    const output = this.coalescer.push(value);
    if (output.length === 0) {
      callback();
      return;
    }
    this.target.write(output, callback);
  }

  dispose(): void {
    this.target.off('resize', this.forwardResize);
    const pending = this.coalescer.flush();
    if (pending.length > 0) this.target.write(pending);
  }
}
