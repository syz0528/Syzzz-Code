import { partitionMarkdownSource, renderMarkdown, type StyledLine } from './markdown.js';

export const STREAM_TICK_MS = 40;
export const CATCH_UP_DEPTH = 8;
export const CATCH_UP_AGE_MS = 120;
export const SEVERE_DEPTH = 64;
export const SEVERE_AGE_MS = 300;

interface QueuedLine {
  line: StyledLine;
  enqueuedAt: number;
}

export interface StreamingPresentationState {
  source: string;
  stableRows: readonly StyledLine[];
  pendingRows: readonly StyledLine[];
  mutableRows: readonly StyledLine[];
  queueDepth: number;
  oldestQueuedAt?: number;
}

function sameLine(left: StyledLine, right: StyledLine): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commonPrefixLength(left: readonly StyledLine[], right: readonly StyledLine[]): number {
  let index = 0;
  while (index < left.length && index < right.length) {
    const leftLine = left[index];
    const rightLine = right[index];
    if (!leftLine || !rightLine || !sameLine(leftLine, rightLine)) break;
    index += 1;
  }
  return index;
}

export class StreamingTextPresenter {
  private source = '';
  private width = 0;
  private completed = false;
  private animateCompleted = false;
  private stableRows: StyledLine[] = [];
  private mutableRows: StyledLine[] = [];
  private queue: QueuedLine[] = [];

  sync(
    source: string,
    width: number,
    completed: boolean,
    now = Date.now(),
    animateCompleted = false
  ): void {
    const normalizedWidth = Math.max(1, width);
    if (
      this.source === source &&
      this.width === normalizedWidth &&
      this.completed === completed &&
      this.animateCompleted === animateCompleted
    ) {
      return;
    }
    const resized = this.width !== 0 && this.width !== normalizedWidth;
    this.source = source;
    this.width = normalizedWidth;
    this.completed = completed;
    this.animateCompleted = animateCompleted;
    const partition = partitionMarkdownSource(source, completed);
    const nextStable = renderMarkdown(partition.stable, normalizedWidth);
    const nextMutable = renderMarkdown(partition.mutable, normalizedWidth);

    if (resized || (completed && !animateCompleted)) {
      this.stableRows = nextStable;
      this.queue = [];
      this.mutableRows = nextMutable;
      return;
    }

    if (completed) {
      const visible = [...this.stableRows, ...this.mutableRows];
      const prefix = commonPrefixLength(visible, nextStable);
      this.stableRows = nextStable.slice(0, prefix);
      this.queue = nextStable.slice(prefix).map((line) => ({ line, enqueuedAt: now }));
      this.mutableRows = [];
      if (this.stableRows.length === 0) {
        const first = this.queue.shift();
        if (first) this.stableRows.push(first.line);
      }
      return;
    }

    {
      const represented = [...this.stableRows, ...this.queue.map((item) => item.line)];
      const prefix = commonPrefixLength(represented, nextStable);
      if (prefix < this.stableRows.length) {
        this.stableRows = nextStable;
        this.queue = [];
      } else {
        this.queue = this.queue.slice(0, Math.max(0, prefix - this.stableRows.length));
        for (const line of nextStable.slice(prefix)) this.queue.push({ line, enqueuedAt: now });
      }
    }
    this.mutableRows = nextMutable;
  }

  drain(now = Date.now()): boolean {
    const oldest = this.queue[0];
    if (!oldest) return false;
    const age = Math.max(0, now - oldest.enqueuedAt);
    const catchUp = this.queue.length >= CATCH_UP_DEPTH || age >= CATCH_UP_AGE_MS;
    const severe = this.queue.length >= SEVERE_DEPTH || age >= SEVERE_AGE_MS;
    const count = severe
      ? Math.min(this.queue.length, 12)
      : catchUp
        ? Math.min(this.queue.length, 3)
        : 1;
    this.stableRows.push(...this.queue.splice(0, count).map((item) => item.line));
    return true;
  }

  flush(): boolean {
    if (this.queue.length === 0) return false;
    this.stableRows.push(...this.queue.splice(0).map((item) => item.line));
    return true;
  }

  reset(): void {
    this.source = '';
    this.width = 0;
    this.completed = false;
    this.animateCompleted = false;
    this.stableRows = [];
    this.mutableRows = [];
    this.queue = [];
  }

  snapshot(): StreamingPresentationState {
    return {
      source: this.source,
      stableRows: this.stableRows,
      pendingRows: this.queue.map((item) => item.line),
      mutableRows: this.mutableRows,
      queueDepth: this.queue.length,
      ...(this.queue[0] ? { oldestQueuedAt: this.queue[0].enqueuedAt } : {})
    };
  }

  visibleRows(): readonly StyledLine[] {
    return [...this.stableRows, ...this.mutableRows];
  }
}
