import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const MAX_COMPOSER_BYTES = 256 * 1024;

export interface ComposerViewport {
  lines: string[];
  cursorX: number;
  cursorRow: number;
  firstLogicalLine: number;
  totalLogicalLines: number;
}

function boundaries(value: string): number[] {
  const result = [0];
  for (const part of segmenter.segment(value)) {
    result.push(part.index + part.segment.length);
  }
  return result;
}

function previousBoundary(value: string, cursor: number): number {
  let previous = 0;
  for (const boundary of boundaries(value)) {
    if (boundary >= cursor) {
      break;
    }
    previous = boundary;
  }
  return previous;
}

function nextBoundary(value: string, cursor: number): number {
  return boundaries(value).find((boundary) => boundary > cursor) ?? value.length;
}

export function splitAtGraphemeCursor(
  value: string,
  cursor: number
): { before: string; current: string; after: string } {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const end = nextBoundary(value, safeCursor);
  return {
    before: value.slice(0, safeCursor),
    current: value.slice(safeCursor, end),
    after: value.slice(end)
  };
}

function lineBounds(value: string, cursor: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
  const newline = value.indexOf('\n', cursor);
  return { start, end: newline < 0 ? value.length : newline };
}

function graphemeColumn(value: string, lineStart: number, cursor: number): number {
  return [...segmenter.segment(value.slice(lineStart, cursor))].length;
}

function offsetForColumn(value: string, start: number, end: number, column: number): number {
  const parts = [...segmenter.segment(value.slice(start, end))];
  if (column >= parts.length) {
    return end;
  }
  return start + (parts[column]?.index ?? 0);
}

function clipLine(value: string, maximumWidth: number): string {
  let result = '';
  let width = 0;
  for (const part of segmenter.segment(value)) {
    const nextWidth = stringWidth(part.segment);
    if (width + nextWidth > maximumWidth) {
      break;
    }
    result += part.segment;
    width += nextWidth;
  }
  return result;
}

function activeLineViewport(
  value: string,
  cursor: number,
  maximumWidth: number
): { text: string; cursorX: number } {
  const parts = [...segmenter.segment(value)];
  const cursorPart = parts.findIndex((part) => part.index + part.segment.length > cursor);
  const cursorIndex = cursorPart < 0 ? parts.length : cursorPart;
  const widths = parts.map((part) => stringWidth(part.segment));
  const cumulative = [0];
  for (const width of widths) {
    cumulative.push((cumulative.at(-1) ?? 0) + width);
  }

  let start = 0;
  while (
    start < cursorIndex &&
    (cumulative[cursorIndex] ?? 0) - (cumulative[start] ?? 0) > maximumWidth - 1
  ) {
    start += 1;
  }
  let end = start;
  while (
    end < parts.length &&
    (cumulative[end + 1] ?? 0) - (cumulative[start] ?? 0) <= maximumWidth
  ) {
    end += 1;
  }
  return {
    text: parts
      .slice(start, end)
      .map((part) => part.segment)
      .join(''),
    cursorX: Math.min(
      maximumWidth - 1,
      Math.max(0, (cumulative[cursorIndex] ?? 0) - (cumulative[start] ?? 0))
    )
  };
}

export function createComposerViewport(
  value: string,
  cursor: number,
  maximumWidth: number,
  maximumRows: number
): ComposerViewport {
  const width = Math.max(1, maximumWidth);
  const rows = Math.max(1, maximumRows);
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const logicalLines = value.split('\n');
  const beforeCursor = value.slice(0, safeCursor);
  const cursorLogicalLine = beforeCursor.split('\n').length - 1;
  const cursorLineStart = beforeCursor.lastIndexOf('\n') + 1;
  const cursorInLine = safeCursor - cursorLineStart;
  const maximumStart = Math.max(0, logicalLines.length - rows);
  const firstLogicalLine = Math.min(
    maximumStart,
    Math.max(0, cursorLogicalLine - Math.floor(rows / 2))
  );
  const visibleLines = logicalLines.slice(firstLogicalLine, firstLogicalLine + rows);
  const cursorRow = cursorLogicalLine - firstLogicalLine;
  let cursorX = 0;
  const lines = visibleLines.map((line, index) => {
    if (index !== cursorRow) {
      return clipLine(line, width);
    }
    const active = activeLineViewport(line, cursorInLine, width);
    cursorX = active.cursorX;
    return active.text;
  });
  return {
    lines: lines.length > 0 ? lines : [''],
    cursorX,
    cursorRow: Math.max(0, Math.min(cursorRow, lines.length - 1)),
    firstLogicalLine,
    totalLogicalLines: logicalLines.length
  };
}

export class ComposerBuffer {
  private content = '';
  private offset = 0;
  private preferredColumn?: number;

  constructor(initialValue = '') {
    if (Buffer.byteLength(initialValue, 'utf8') > MAX_COMPOSER_BYTES) {
      throw new Error(`Composer content exceeds ${MAX_COMPOSER_BYTES} bytes`);
    }
    this.content = initialValue.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    this.offset = this.content.length;
  }

  get value(): string {
    return this.content;
  }

  get cursor(): number {
    return this.offset;
  }

  get empty(): boolean {
    return this.content.length === 0;
  }

  set(value: string, cursor = value.length): void {
    const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    if (Buffer.byteLength(normalized, 'utf8') > MAX_COMPOSER_BYTES) {
      throw new Error(`Composer content exceeds ${MAX_COMPOSER_BYTES} bytes`);
    }
    this.content = normalized;
    this.offset = Math.max(0, Math.min(cursor, normalized.length));
    this.preferredColumn = undefined;
  }

  clear(): void {
    this.content = '';
    this.offset = 0;
    this.preferredColumn = undefined;
  }

  insert(text: string): boolean {
    const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const next = this.content.slice(0, this.offset) + normalized + this.content.slice(this.offset);
    if (Buffer.byteLength(next, 'utf8') > MAX_COMPOSER_BYTES) {
      return false;
    }
    this.content = next;
    this.offset += normalized.length;
    this.preferredColumn = undefined;
    return true;
  }

  backspace(): boolean {
    if (this.offset === 0) {
      return false;
    }
    const start = previousBoundary(this.content, this.offset);
    this.content = this.content.slice(0, start) + this.content.slice(this.offset);
    this.offset = start;
    this.preferredColumn = undefined;
    return true;
  }

  delete(): boolean {
    if (this.offset >= this.content.length) {
      return false;
    }
    const end = nextBoundary(this.content, this.offset);
    this.content = this.content.slice(0, this.offset) + this.content.slice(end);
    this.preferredColumn = undefined;
    return true;
  }

  moveLeft(): void {
    this.offset = previousBoundary(this.content, this.offset);
    this.preferredColumn = undefined;
  }

  moveRight(): void {
    this.offset = nextBoundary(this.content, this.offset);
    this.preferredColumn = undefined;
  }

  moveHome(): void {
    this.offset = lineBounds(this.content, this.offset).start;
    this.preferredColumn = undefined;
  }

  moveEnd(): void {
    this.offset = lineBounds(this.content, this.offset).end;
    this.preferredColumn = undefined;
  }

  moveVertical(direction: -1 | 1): void {
    const current = lineBounds(this.content, this.offset);
    const column = this.preferredColumn ?? graphemeColumn(this.content, current.start, this.offset);
    this.preferredColumn = column;
    if (direction < 0) {
      if (current.start === 0) {
        this.offset = 0;
        return;
      }
      const previousEnd = current.start - 1;
      const previousStart = this.content.lastIndexOf('\n', Math.max(0, previousEnd - 1)) + 1;
      this.offset = offsetForColumn(this.content, previousStart, previousEnd, column);
      return;
    }
    if (current.end === this.content.length) {
      this.offset = this.content.length;
      return;
    }
    const nextStart = current.end + 1;
    const nextNewline = this.content.indexOf('\n', nextStart);
    const nextEnd = nextNewline < 0 ? this.content.length : nextNewline;
    this.offset = offsetForColumn(this.content, nextStart, nextEnd, column);
  }
}
