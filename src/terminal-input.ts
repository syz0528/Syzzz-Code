import {
  clearScreenDown,
  createInterface,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
  type Interface as ReadlineInterface
} from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import stringWidth from 'string-width';
import { OperationAbortedError } from './tools/abort.js';

const MAX_HISTORY_ENTRIES = 100;
const DEFAULT_MAX_SUGGESTIONS = 8;
const ENABLE_BRACKETED_PASTE = '\u001b[?2004h';
const DISABLE_BRACKETED_PASTE = '\u001b[?2004l';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface SuggestionItem {
  id: string;
  label: string;
  description?: string;
  insertText: string;
  replaceStart: number;
  replaceEnd: number;
  submitOnAccept?: boolean;
}

export interface SuggestionRequest {
  query: string;
}

export interface SuggestionProvider {
  trigger: string;
  match(value: string, cursor: number): SuggestionRequest | null;
  suggest(
    request: SuggestionRequest,
    signal: AbortSignal
  ): readonly SuggestionItem[] | Promise<readonly SuggestionItem[]>;
}

export type TerminalReadResult =
  { type: 'line'; value: string } | { type: 'interrupt' } | { type: 'eof' };

export interface TerminalReadOptions {
  prompt: string;
  signal?: AbortSignal;
  suggestionProviders?: readonly SuggestionProvider[];
  history?: boolean;
  maxSuggestions?: number;
}

interface KeyDescriptor {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

interface TtyReadable extends Readable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
}

interface TtyWritable extends Writable {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

interface ActiveSuggestions {
  items: readonly SuggestionItem[];
  selected: number;
}

function graphemeBoundaries(value: string): number[] {
  const boundaries = [0];
  for (const part of segmenter.segment(value)) {
    const end = part.index + part.segment.length;
    if (end > boundaries[boundaries.length - 1]) {
      boundaries.push(end);
    }
  }
  return boundaries;
}

function previousBoundary(value: string, cursor: number): number {
  const boundaries = graphemeBoundaries(value);
  let previous = 0;
  for (const boundary of boundaries) {
    if (boundary >= cursor) {
      break;
    }
    previous = boundary;
  }
  return previous;
}

function nextBoundary(value: string, cursor: number): number {
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > cursor) {
      return boundary;
    }
  }
  return value.length;
}

function truncateToWidth(value: string, maximumWidth: number): string {
  if (maximumWidth <= 0) {
    return '';
  }
  if (stringWidth(value) <= maximumWidth) {
    return value;
  }

  const ellipsis = maximumWidth >= 3 ? '...' : '';
  const contentWidth = maximumWidth - stringWidth(ellipsis);
  let result = '';
  for (const part of segmenter.segment(value)) {
    if (stringWidth(result + part.segment) > contentWidth) {
      break;
    }
    result += part.segment;
  }
  return result + ellipsis;
}

function normalizeSuggestionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export class TerminalInputController {
  private readonly input: TtyReadable;
  private readonly output: TtyWritable;
  private readonly enhanced: boolean;
  private readonly history: string[] = [];
  private fallback?: ReadlineInterface;
  private fallbackResults: TerminalReadResult[] = [];
  private fallbackReaders: Array<(result: TerminalReadResult) => void> = [];
  private closeEnhancedRead?: () => void;
  private pendingInputPause?: () => void;
  private closed = false;

  constructor(input: TtyReadable = process.stdin, output: TtyWritable = process.stdout) {
    this.input = input;
    this.output = output;
    this.enhanced = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');

    if (this.enhanced) {
      emitKeypressEvents(this.input);
      return;
    }

    this.fallback = createInterface({
      input: this.input,
      output: this.output,
      terminal: Boolean(this.input.isTTY && this.output.isTTY)
    });
    const deliver = (result: TerminalReadResult) => {
      const reader = this.fallbackReaders.shift();
      if (reader) {
        reader(result);
      } else {
        this.fallbackResults.push(result);
      }
    };
    this.fallback.on('line', (line) => {
      deliver({ type: 'line', value: line });
    });
    this.fallback.on('SIGINT', () => deliver({ type: 'interrupt' }));
    this.fallback.on('close', () => {
      this.closed = true;
      for (const reader of this.fallbackReaders.splice(0)) {
        reader({ type: 'eof' });
      }
    });
  }

  get supportsSuggestions(): boolean {
    return this.enhanced;
  }

  replaceHistory(entries: readonly string[]): void {
    this.history.splice(0, this.history.length, ...entries.slice(-MAX_HISTORY_ENTRIES));
  }

  async readLine(options: TerminalReadOptions): Promise<TerminalReadResult> {
    if (options.signal?.aborted) {
      throw new OperationAbortedError();
    }
    if (this.closed && this.enhanced) {
      return { type: 'eof' };
    }
    return this.enhanced ? this.readEnhanced(options) : this.readFallback(options);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeEnhancedRead?.();
    this.fallback?.close();
    if (!this.enhanced && this.input.isRaw) {
      this.input.setRawMode?.(false);
    }
  }

  private async readFallback(options: TerminalReadOptions): Promise<TerminalReadResult> {
    this.output.write(options.prompt);
    const queued = this.fallbackResults.shift();
    if (queued) {
      if (queued.type === 'line') {
        this.recordHistory(queued.value, options.history);
      }
      return queued;
    }
    if (this.closed) {
      return { type: 'eof' };
    }

    return new Promise<TerminalReadResult>((resolve, reject) => {
      let settled = false;
      const finish = (result: TerminalReadResult) => {
        if (settled) {
          return;
        }
        settled = true;
        options.signal?.removeEventListener('abort', handleAbort);
        if (result.type === 'line') {
          this.recordHistory(result.value, options.history);
        }
        resolve(result);
      };
      const handleAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        const index = this.fallbackReaders.indexOf(finish);
        if (index !== -1) {
          this.fallbackReaders.splice(index, 1);
        }
        options.signal?.removeEventListener('abort', handleAbort);
        reject(new OperationAbortedError());
      };

      this.fallbackReaders.push(finish);
      options.signal?.addEventListener('abort', handleAbort, { once: true });
    });
  }

  private readEnhanced(options: TerminalReadOptions): Promise<TerminalReadResult> {
    this.pendingInputPause?.();
    return new Promise<TerminalReadResult>((resolve, reject) => {
      let value = '';
      let cursor = 0;
      let historyIndex = this.history.length;
      let historyDraft = '';
      let suggestions: ActiveSuggestions | undefined;
      let suggestionsGeneration = 0;
      let suggestionsController: AbortController | undefined;
      let dismissedValue: string | undefined;
      let cursorRowFromTop = 0;
      let reservedRows = 0;
      let settled = false;
      let isPasting = false;
      let pasteBuffer = '';
      const wasRaw = Boolean(this.input.isRaw);
      const wasFlowing = this.input.readableFlowing === true;

      const cleanup = () => {
        suggestionsController?.abort();
        options.signal?.removeEventListener('abort', handleAbort);
        this.output.removeListener('resize', handleResize);
        this.input.removeListener('keypress', handleKeypress);
        this.closeEnhancedRead = undefined;
        // Pause after the keypress callback, before handing control back to the caller.
        if (!wasFlowing) {
          const pauseInput = () => {
            if (this.pendingInputPause !== pauseInput) return;
            this.pendingInputPause = undefined;
            this.input.pause();
          };
          this.pendingInputPause = pauseInput;
          queueMicrotask(pauseInput);
        }
        this.output.write(DISABLE_BRACKETED_PASTE);
        if (!wasRaw) {
          this.input.setRawMode?.(false);
        }
      };
      const clearRendered = () => {
        cursorTo(this.output, 0);
        if (cursorRowFromTop > 0) {
          moveCursor(this.output, 0, -cursorRowFromTop);
        }
        clearScreenDown(this.output);
        cursorRowFromTop = 0;
      };
      const visibleItems = (): readonly SuggestionItem[] => {
        if (!suggestions?.items.length) {
          return [];
        }
        const configuredMaximum = options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
        const terminalMaximum = Math.max(1, (this.output.rows ?? 12) - 3);
        const maximum = Math.min(configuredMaximum, terminalMaximum);
        const selected = Math.min(suggestions.selected, suggestions.items.length - 1);
        const start = Math.max(
          0,
          Math.min(selected - Math.floor(maximum / 2), suggestions.items.length - maximum)
        );
        return suggestions.items.slice(start, start + maximum);
      };
      const reserveRenderedRows = (rows: number) => {
        if (rows <= reservedRows) {
          return;
        }
        this.output.write('\n'.repeat(rows));
        moveCursor(this.output, 0, -rows);
        cursorTo(this.output, 0);
        reservedRows = rows;
      };
      const render = () => {
        clearRendered();
        const columns = Math.max(20, this.output.columns ?? 80);
        const promptAndValue = options.prompt + value;
        const items = visibleItems();
        const inputRows = Math.floor(stringWidth(promptAndValue) / columns) + 1;
        const finalRow = inputRows - 1 + items.length;
        reserveRenderedRows(finalRow);
        this.output.write(promptAndValue);

        const selectedItem = suggestions?.items[suggestions.selected];
        for (const item of items) {
          const marker = item === selectedItem ? '> ' : '  ';
          const label = marker + normalizeSuggestionText(item.label);
          const normalizedDescription = item.description
            ? normalizeSuggestionText(item.description)
            : '';
          const description = normalizedDescription ? `  ${normalizedDescription}` : '';
          this.output.write(`\n${truncateToWidth(label + description, columns - 1)}`);
        }

        const beforeCursor = options.prompt + value.slice(0, cursor);
        const targetWidth = stringWidth(beforeCursor);
        const targetRow = Math.floor(targetWidth / columns);
        const targetColumn = targetWidth % columns;
        cursorTo(this.output, targetColumn);
        if (finalRow !== targetRow) {
          moveCursor(this.output, 0, targetRow - finalRow);
        }
        cursorRowFromTop = targetRow;
      };
      const finish = (result: TerminalReadResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearRendered();
        if (result.type === 'line') {
          this.output.write(`${options.prompt}${result.value}\n`);
          this.recordHistory(result.value, options.history);
        } else if (result.type === 'eof') {
          this.output.write('\n');
        }
        cleanup();
        resolve(result);
      };
      const handleAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearRendered();
        cleanup();
        reject(new OperationAbortedError());
      };
      const refreshSuggestions = () => {
        dismissedValue = dismissedValue === value ? dismissedValue : undefined;
        suggestionsController?.abort();
        suggestions = undefined;
        if (dismissedValue === value) {
          render();
          return;
        }

        const provider = options.suggestionProviders?.find(
          (candidate) => candidate.match(value, cursor) !== null
        );
        const request = provider?.match(value, cursor);
        if (!provider || !request) {
          render();
          return;
        }

        const generation = ++suggestionsGeneration;
        const controller = new AbortController();
        suggestionsController = controller;
        Promise.resolve(provider.suggest(request, controller.signal))
          .then((items) => {
            if (settled || controller.signal.aborted || generation !== suggestionsGeneration) {
              return;
            }
            suggestions = items.length > 0 ? { items, selected: 0 } : undefined;
            render();
          })
          .catch((error) => {
            if (!controller.signal.aborted && !settled) {
              suggestions = undefined;
              render();
            }
            void error;
          });
        render();
      };
      const replaceWithSuggestion = (item: SuggestionItem): boolean => {
        const replacedValue =
          value.slice(0, item.replaceStart) + item.insertText + value.slice(item.replaceEnd);
        const unchanged = replacedValue === value;
        value = replacedValue;
        cursor = item.replaceStart + item.insertText.length;
        historyIndex = this.history.length;
        dismissedValue = undefined;
        return unchanged;
      };
      const acceptSuggestion = (submit: boolean): boolean => {
        const item = suggestions?.items[suggestions.selected];
        if (!item) {
          return false;
        }
        const unchanged = replaceWithSuggestion(item);
        if (submit && (item.submitOnAccept || unchanged)) {
          finish({ type: 'line', value });
        } else if (submit || unchanged) {
          dismissedValue = value;
          refreshSuggestions();
        } else {
          refreshSuggestions();
        }
        return true;
      };
      const setHistoryValue = (nextIndex: number) => {
        if (this.history.length === 0) {
          return;
        }
        if (historyIndex === this.history.length) {
          historyDraft = value;
        }
        historyIndex = Math.max(0, Math.min(nextIndex, this.history.length));
        value = historyIndex === this.history.length ? historyDraft : this.history[historyIndex];
        cursor = value.length;
        dismissedValue = undefined;
        refreshSuggestions();
      };
      const insertText = (text: string) => {
        const normalized = text.replace(/[\r\n]+/g, ' ');
        value = value.slice(0, cursor) + normalized + value.slice(cursor);
        cursor += normalized.length;
        historyIndex = this.history.length;
        dismissedValue = undefined;
        refreshSuggestions();
      };
      const handleKeypress = (text: string, key: KeyDescriptor) => {
        if (settled) {
          return;
        }
        if (key.name === 'paste-start') {
          isPasting = true;
          pasteBuffer = '';
          return;
        }
        if (isPasting) {
          if (key.name === 'paste-end') {
            isPasting = false;
            insertText(pasteBuffer);
            pasteBuffer = '';
          } else {
            pasteBuffer += text ?? '';
          }
          return;
        }
        if (key.ctrl && key.name === 'c') {
          if (value || suggestions) {
            value = '';
            cursor = 0;
            suggestions = undefined;
            dismissedValue = undefined;
            historyIndex = this.history.length;
            refreshSuggestions();
          } else {
            finish({ type: 'interrupt' });
          }
          return;
        }
        if (key.ctrl && key.name === 'd' && !value) {
          finish({ type: 'eof' });
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          if (!acceptSuggestion(true)) {
            finish({ type: 'line', value });
          }
          return;
        }
        if (key.name === 'tab') {
          acceptSuggestion(false);
          return;
        }
        if (key.name === 'escape') {
          if (suggestions) {
            suggestions = undefined;
            dismissedValue = value;
            render();
          }
          return;
        }
        if (key.name === 'up') {
          if (suggestions?.items.length) {
            suggestions.selected =
              (suggestions.selected - 1 + suggestions.items.length) % suggestions.items.length;
            render();
          } else {
            setHistoryValue(historyIndex - 1);
          }
          return;
        }
        if (key.name === 'down') {
          if (suggestions?.items.length) {
            suggestions.selected = (suggestions.selected + 1) % suggestions.items.length;
            render();
          } else {
            setHistoryValue(historyIndex + 1);
          }
          return;
        }
        if (key.name === 'left' || (key.ctrl && key.name === 'b')) {
          cursor = previousBoundary(value, cursor);
          refreshSuggestions();
          return;
        }
        if (key.name === 'right' || (key.ctrl && key.name === 'f')) {
          cursor = nextBoundary(value, cursor);
          refreshSuggestions();
          return;
        }
        if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
          cursor = 0;
          refreshSuggestions();
          return;
        }
        if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
          cursor = value.length;
          refreshSuggestions();
          return;
        }
        if (key.name === 'backspace') {
          const start = previousBoundary(value, cursor);
          value = value.slice(0, start) + value.slice(cursor);
          cursor = start;
          dismissedValue = undefined;
          refreshSuggestions();
          return;
        }
        if (key.name === 'delete') {
          const end = nextBoundary(value, cursor);
          value = value.slice(0, cursor) + value.slice(end);
          dismissedValue = undefined;
          refreshSuggestions();
          return;
        }
        if (key.ctrl && key.name === 'u') {
          value = value.slice(cursor);
          cursor = 0;
          dismissedValue = undefined;
          refreshSuggestions();
          return;
        }
        if (key.ctrl && key.name === 'k') {
          value = value.slice(0, cursor);
          dismissedValue = undefined;
          refreshSuggestions();
          return;
        }
        if (key.ctrl && key.name === 'p') {
          setHistoryValue(historyIndex - 1);
          return;
        }
        if (key.ctrl && key.name === 'n') {
          setHistoryValue(historyIndex + 1);
          return;
        }
        if (!key.ctrl && !key.meta && text && key.name !== 'undefined') {
          insertText(text);
        }
      };
      const handleResize = () => {
        reservedRows = 0;
        render();
      };

      options.signal?.addEventListener('abort', handleAbort, { once: true });
      this.closeEnhancedRead = () => finish({ type: 'eof' });
      this.output.on('resize', handleResize);
      this.input.on('keypress', handleKeypress);
      this.input.setRawMode?.(true);
      this.input.resume();
      this.output.write(ENABLE_BRACKETED_PASTE);
      render();
      refreshSuggestions();
    });
  }

  private recordHistory(value: string, enabled: boolean | undefined): void {
    if (!enabled || !value.trim()) {
      return;
    }
    const existing = this.history.indexOf(value);
    if (existing !== -1) {
      this.history.splice(existing, 1);
    }
    this.history.push(value);
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.shift();
    }
  }
}
