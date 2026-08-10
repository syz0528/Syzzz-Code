export type MouseInputEvent =
  | { type: 'wheel'; direction: -1 | 1 }
  | { type: 'press' | 'move' | 'release'; x: number; y: number }
  | { type: 'other' };

export interface NormalizedTerminalInput {
  text: string;
  mouseEvents: MouseInputEvent[];
}

const COMPLETE_SGR_MOUSE_REPORT = /^(?:\u001B)?\[<(\d+);(\d+);(\d+)([Mm])/u;
const COMPLETE_URXVT_MOUSE_REPORT = /^(?:\u001B)?\[(\d+);(\d+);(\d+)([Mm])/u;
const COMPLETE_X10_MOUSE_REPORT = /^(?:\u001B)?\[M([\s\S])([\s\S])([\s\S])/u;
const POSSIBLE_SGR_MOUSE_REPORT = /^(?:\u001B)?\[<[\d;]*$/u;
const POSSIBLE_URXVT_MOUSE_REPORT = /^(?:\u001B)?\[\d+;\d+;\d*$/u;
const POSSIBLE_X10_MOUSE_REPORT = /^(?:\u001B)?\[M[\s\S]{0,2}$/u;
const MAX_PENDING_SEQUENCE = 64;

function mouseReportStart(value: string, offset: number): number {
  const starts = [
    value.indexOf('\u001B[<', offset),
    value.indexOf('[<', offset),
    value.indexOf('\u001B[M', offset),
    value.indexOf('[M', offset)
  ].filter((candidate) => candidate >= 0);
  const numeric = value.slice(offset).match(/(?:\u001B)?\[\d+;\d+;\d+[Mm]/u);
  if (numeric?.index !== undefined) starts.push(offset + numeric.index);
  return starts.length === 0 ? -1 : Math.min(...starts);
}

function decodeMouseReport(
  buttonValue: string,
  xValue: string,
  yValue: string,
  terminator: string
): MouseInputEvent {
  let button = Number.parseInt(buttonValue, 10);
  if (!Number.isFinite(button)) return { type: 'other' };
  // URXVT wheel values are 32 above SGR. Preserve 32-65 because embedded
  // terminals have also been observed dropping only SGR's '<'.
  if (button >= 96) button -= 32;
  if ((button & 64) !== 0) {
    return { type: 'wheel', direction: (button & 1) === 0 ? -1 : 1 };
  }
  const x = Number.parseInt(xValue, 10);
  const y = Number.parseInt(yValue, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { type: 'other' };
  if (terminator === 'm' || (button & 3) === 3) return { type: 'release', x, y };
  if ((button & 3) === 0 && (button & 32) !== 0) return { type: 'move', x, y };
  if ((button & 3) === 0) return { type: 'press', x, y };
  return { type: 'other' };
}

function parseMouseReport(value: string): { event: MouseInputEvent; length: number } | undefined {
  const sgr = value.match(COMPLETE_SGR_MOUSE_REPORT);
  if (sgr) {
    return {
      event: decodeMouseReport(sgr[1] ?? '', sgr[2] ?? '', sgr[3] ?? '', sgr[4] ?? ''),
      length: sgr[0].length
    };
  }
  const urxvt = value.match(COMPLETE_URXVT_MOUSE_REPORT);
  if (urxvt) {
    return {
      event: decodeMouseReport(urxvt[1] ?? '', urxvt[2] ?? '', urxvt[3] ?? '', urxvt[4] ?? ''),
      length: urxvt[0].length
    };
  }
  const x10 = value.match(COMPLETE_X10_MOUSE_REPORT);
  if (!x10) return undefined;
  return {
    event: decodeMouseReport(
      String((x10[1]?.charCodeAt(0) ?? 32) - 32),
      String((x10[2]?.charCodeAt(0) ?? 32) - 32),
      String((x10[3]?.charCodeAt(0) ?? 32) - 32),
      'M'
    ),
    length: x10[0].length
  };
}

function isPossibleMouseReport(value: string): boolean {
  return (
    value.length <= MAX_PENDING_SEQUENCE &&
    (POSSIBLE_SGR_MOUSE_REPORT.test(value) ||
      POSSIBLE_URXVT_MOUSE_REPORT.test(value) ||
      POSSIBLE_X10_MOUSE_REPORT.test(value))
  );
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
      const report = parseMouseReport(candidate);
      if (report) {
        mouseEvents.push(report.event);
        offset = start + report.length;
        continue;
      }
      if (isPossibleMouseReport(candidate)) {
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
