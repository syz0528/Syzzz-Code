export type MouseInputEvent =
  | { type: 'wheel'; direction: -1 | 1 }
  | { type: 'press' | 'move' | 'release'; x: number; y: number }
  | { type: 'other' };

export interface NormalizedTerminalInput {
  text: string;
  mouseEvents: MouseInputEvent[];
}

const COMPLETE_MOUSE_REPORT = /^(?:\u001B)?\[<(\d+);(\d+);(\d+)([Mm])/u;
const POSSIBLE_MOUSE_REPORT = /^(?:\u001B)?\[<[\d;]*$/u;
const MAX_PENDING_SEQUENCE = 64;

function mouseReportStart(value: string, offset: number): number {
  const escaped = value.indexOf('\u001B[<', offset);
  const bare = value.indexOf('[<', offset);
  if (escaped < 0) return bare;
  if (bare < 0) return escaped;
  return Math.min(escaped, bare);
}

function decodeMouseReport(match: RegExpMatchArray): MouseInputEvent {
  const button = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(button)) return { type: 'other' };
  if ((button & 64) !== 0) {
    return { type: 'wheel', direction: (button & 1) === 0 ? -1 : 1 };
  }
  const x = Number.parseInt(match[2] ?? '', 10);
  const y = Number.parseInt(match[3] ?? '', 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { type: 'other' };
  if (match[4] === 'm') return { type: 'release', x, y };
  if ((button & 3) === 0 && (button & 32) !== 0) return { type: 'move', x, y };
  if ((button & 3) === 0) return { type: 'press', x, y };
  return { type: 'other' };
}

/**
 * Separates SGR mouse reports from text even when terminal reads split or
 * coalesce escape sequences. Other escape sequences remain untouched for Ink's
 * key decoder and the Composer newline policy.
 */
export class TerminalInputDecoder {
  private pending = '';

  push(input: string): NormalizedTerminalInput {
    const value = this.pending + input;
    this.pending = '';
    const mouseEvents: MouseInputEvent[] = [];
    let text = '';
    let offset = 0;

    while (offset < value.length) {
      const start = mouseReportStart(value, offset);
      if (start < 0) {
        text += value.slice(offset);
        break;
      }
      text += value.slice(offset, start);
      const candidate = value.slice(start);
      const match = candidate.match(COMPLETE_MOUSE_REPORT);
      if (match) {
        mouseEvents.push(decodeMouseReport(match));
        offset = start + match[0].length;
        continue;
      }
      if (candidate.length <= MAX_PENDING_SEQUENCE && POSSIBLE_MOUSE_REPORT.test(candidate)) {
        this.pending = candidate;
        break;
      }
      text += value[start];
      offset = start + 1;
    }

    return { text, mouseEvents };
  }

  flush(): string {
    const pending = this.pending;
    this.pending = '';
    return pending;
  }

  reset(): void {
    this.pending = '';
  }
}

export function normalizeTerminalInput(input: string): NormalizedTerminalInput {
  const decoder = new TerminalInputDecoder();
  const normalized = decoder.push(input);
  return { ...normalized, text: normalized.text + decoder.flush() };
}

export function parseMouseInput(input: string): MouseInputEvent | undefined {
  const normalized = normalizeTerminalInput(input);
  return normalized.text.length === 0 && normalized.mouseEvents.length === 1
    ? normalized.mouseEvents[0]
    : undefined;
}
