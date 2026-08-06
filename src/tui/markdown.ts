import { marked, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';

export interface StyledSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  color?: string;
  backgroundColor?: string;
}

export interface StyledLine {
  spans: readonly StyledSpan[];
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function sanitizeTerminalText(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '');
}

function span(text: string, style: Omit<StyledSpan, 'text'> = {}): StyledSpan {
  return { text: sanitizeTerminalText(text), ...style };
}

function mergeStyle(base: StyledSpan, patch: Omit<StyledSpan, 'text'>): StyledSpan {
  return { ...base, ...patch };
}

function inlineSpans(tokens: readonly Token[], style: Omit<StyledSpan, 'text'> = {}): StyledSpan[] {
  const spans: StyledSpan[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens?.length) {
          spans.push(...inlineSpans(textToken.tokens, style));
        } else {
          spans.push(span(textToken.text, style));
        }
        break;
      }
      case 'escape':
        spans.push(span((token as Tokens.Escape).text, style));
        break;
      case 'strong':
        spans.push(...inlineSpans((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        spans.push(...inlineSpans((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        spans.push(...inlineSpans((token as Tokens.Del).tokens, { ...style, dim: true }));
        break;
      case 'codespan':
        spans.push(span((token as Tokens.Codespan).text, { ...style, color: 'cyan' }));
        break;
      case 'link': {
        const link = token as Tokens.Link;
        spans.push(...inlineSpans(link.tokens, { ...style, underline: true }));
        break;
      }
      case 'image':
        spans.push(
          span(`[image: ${(token as Tokens.Image).text || 'attachment'}]`, { ...style, dim: true })
        );
        break;
      case 'br':
        spans.push(span('\n', style));
        break;
      case 'html':
        spans.push(span((token as Tokens.HTML).text, style));
        break;
      default: {
        const nested = 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : undefined;
        spans.push(...(nested ? inlineSpans(nested, style) : [span(token.raw, style)]));
      }
    }
  }
  return spans;
}

function splitSpanLines(spans: readonly StyledSpan[]): StyledLine[] {
  const lines: StyledSpan[][] = [[]];
  for (const current of spans) {
    const parts = current.text.split('\n');
    for (const [index, part] of parts.entries()) {
      if (part) lines.at(-1)?.push({ ...current, text: part });
      if (index < parts.length - 1) lines.push([]);
    }
  }
  return lines.map((line) => ({ spans: line }));
}

function renderList(token: Tokens.List): StyledLine[] {
  const lines: StyledLine[] = [];
  for (const [index, item] of token.items.entries()) {
    const marker = token.ordered ? `${Number(token.start || 1) + index}. ` : '- ';
    const itemLines = renderTokens(item.tokens);
    if (itemLines.length === 0) itemLines.push({ spans: [] });
    itemLines.forEach((line, lineIndex) => {
      lines.push({
        spans: [
          span(lineIndex === 0 ? marker : ' '.repeat(stringWidth(marker)), { dim: true }),
          ...line.spans
        ]
      });
    });
  }
  return lines;
}

function plainInline(tokens: readonly Token[]): string {
  return inlineSpans(tokens)
    .map((item) => item.text)
    .join('');
}

function renderTable(token: Tokens.Table): StyledLine[] {
  const rows = [token.header, ...token.rows].map((row) =>
    row.map((cell) => plainInline(cell.tokens))
  );
  const widths = token.header.map((_, column) =>
    Math.min(32, Math.max(3, ...rows.map((row) => stringWidth(row[column] ?? ''))))
  );
  const formatRow = (row: readonly string[], header = false): StyledLine => ({
    spans: row
      .flatMap((value, column) => {
        const cellWidth = widths[column] ?? 3;
        const clipped =
          stringWidth(value) > cellWidth
            ? `${takeGrapheme(value, Math.max(1, cellWidth - 1)).head}…`
            : value;
        const padding = ' '.repeat(Math.max(0, cellWidth - stringWidth(clipped)));
        return [
          span(column === 0 ? '| ' : ' | ', { dim: true }),
          span(`${clipped}${padding}`, header ? { bold: true } : {})
        ];
      })
      .concat(span(' |', { dim: true }))
  });
  return rows.map((row, index) => formatRow(row, index === 0));
}

function renderTokens(tokens: readonly Token[]): StyledLine[] {
  const lines: StyledLine[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        if (lines.length > 0 && lines.at(-1)?.spans.length) lines.push({ spans: [] });
        break;
      case 'heading': {
        const heading = token as Tokens.Heading;
        lines.push({ spans: inlineSpans(heading.tokens, { bold: true, color: 'cyan' }) });
        lines.push({ spans: [] });
        break;
      }
      case 'paragraph':
        lines.push(...splitSpanLines(inlineSpans((token as Tokens.Paragraph).tokens)));
        lines.push({ spans: [] });
        break;
      case 'text':
        lines.push(...splitSpanLines(inlineSpans([token])));
        break;
      case 'code': {
        const code = token as Tokens.Code;
        lines.push({ spans: [span(`  ${code.lang ? `${code.lang} ` : ''}`, { dim: true })] });
        for (const line of sanitizeTerminalText(code.text).split('\n')) {
          lines.push({ spans: [span(`  ${line}`, { color: 'cyan' })] });
        }
        lines.push({ spans: [] });
        break;
      }
      case 'blockquote': {
        for (const line of renderTokens((token as Tokens.Blockquote).tokens)) {
          lines.push({
            spans: [
              span('│ ', { dim: true }),
              ...line.spans.map((item) => mergeStyle(item, { dim: true }))
            ]
          });
        }
        break;
      }
      case 'list':
        lines.push(...renderList(token as Tokens.List), { spans: [] });
        break;
      case 'table':
        lines.push(...renderTable(token as Tokens.Table), { spans: [] });
        break;
      case 'hr':
        lines.push({ spans: [span('─'.repeat(24), { dim: true })] });
        break;
      case 'html':
        lines.push(...splitSpanLines([span((token as Tokens.HTML).text)]), { spans: [] });
        break;
      default:
        lines.push(...splitSpanLines(inlineSpans([token])));
    }
  }
  while (lines.length > 0 && lines.at(-1)?.spans.length === 0) lines.pop();
  return lines;
}

function takeGrapheme(value: string, maximumWidth: number): { head: string; tail: string } {
  let width = 0;
  let boundary = 0;
  for (const item of segmenter.segment(value)) {
    const itemWidth = stringWidth(item.segment);
    if (boundary > 0 && width + itemWidth > maximumWidth) break;
    width += itemWidth;
    boundary = item.index + item.segment.length;
  }
  return { head: value.slice(0, boundary), tail: value.slice(boundary) };
}

export function wrapStyledLines(lines: readonly StyledLine[], maximumWidth: number): StyledLine[] {
  const width = Math.max(1, maximumWidth);
  const wrapped: StyledLine[] = [];
  for (const logical of lines) {
    if (logical.spans.length === 0) {
      wrapped.push({ spans: [] });
      continue;
    }
    let current: StyledSpan[] = [];
    let currentWidth = 0;
    const flush = () => {
      wrapped.push({ spans: current });
      current = [];
      currentWidth = 0;
    };
    for (const original of logical.spans) {
      let remaining = original.text;
      while (remaining) {
        const room = Math.max(1, width - currentWidth);
        const { head, tail } = takeGrapheme(remaining, room);
        if (!head && current.length > 0) {
          flush();
          continue;
        }
        current.push({ ...original, text: head || remaining });
        currentWidth += stringWidth(head || remaining);
        remaining = head ? tail : '';
        if (remaining || currentWidth >= width) flush();
      }
    }
    if (current.length > 0) flush();
  }
  return wrapped;
}

export function renderMarkdown(markdown: string, width: number): StyledLine[] {
  const source = sanitizeTerminalText(markdown);
  if (!source) return [];
  try {
    return wrapStyledLines(renderTokens(marked.lexer(source, { gfm: true, breaks: false })), width);
  } catch {
    return wrapStyledLines(
      source.split('\n').map((text) => ({ spans: text ? [span(text)] : [] })),
      width
    );
  }
}

export function partitionMarkdownSource(
  markdown: string,
  completed: boolean
): { stable: string; mutable: string } {
  if (completed || !markdown) return { stable: markdown, mutable: '' };
  try {
    const tokens = marked.lexer(sanitizeTerminalText(markdown), { gfm: true, breaks: false });
    if (tokens.length === 0) return { stable: '', mutable: markdown };
    if (/\n[\t ]*\n$/u.test(markdown) || tokens.at(-1)?.type === 'space') {
      return { stable: markdown, mutable: '' };
    }
    const mutableLength = tokens.at(-1)?.raw.length ?? markdown.length;
    const boundary = Math.max(0, markdown.length - mutableLength);
    return { stable: markdown.slice(0, boundary), mutable: markdown.slice(boundary) };
  } catch {
    return { stable: '', mutable: markdown };
  }
}
