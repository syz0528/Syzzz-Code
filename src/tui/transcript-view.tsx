import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type {
  ConversationBlock,
  ToolTimelineItem,
  TranscriptAnchor
} from '../interaction/conversation.js';
import type { ResolvedUiLanguage } from '../ui-language.js';
import { renderMarkdown, wrapStyledLines, type StyledLine, type StyledSpan } from './markdown.js';
import { STREAM_TICK_MS, StreamingTextPresenter } from './streaming-presenter.js';

export interface TranscriptRow {
  key: string;
  blockId: string;
  turnId?: string;
  sourceRow: number;
  kind: ConversationBlock['kind'];
  spans: readonly StyledSpan[];
  backgroundColor?: string;
}

export interface TranscriptLayout {
  rows: readonly TranscriptRow[];
  userBlocks: ReadonlyMap<string, Extract<ConversationBlock, { kind: 'user' }>>;
  pendingPresentationRows: number;
}

export interface TranscriptSelectionPoint {
  row: number;
  column: number;
}

export interface TranscriptSelection {
  start: TranscriptSelectionPoint;
  end: TranscriptSelectionPoint;
}

export interface TranscriptViewport {
  rows: readonly TranscriptRow[];
  stickyRows: number;
  start: number;
  visibleHeight: number;
  maximumStart: number;
  thumbStart: number;
  thumbSize: number;
}

function duration(value: number | undefined): string {
  if (value === undefined) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function plainLine(text: string, style: Omit<StyledSpan, 'text'> = {}): StyledLine {
  return { spans: [{ text, ...style }] };
}

function prefixed(lines: readonly StyledLine[], first: string, rest = '  '): StyledLine[] {
  const source = lines.length > 0 ? lines : [{ spans: [] }];
  return source.map((line, index) => ({
    spans: [{ text: index === 0 ? first : rest, dim: true }, ...line.spans]
  }));
}

function failedTool(item: ToolTimelineItem): boolean {
  return !['requested', 'running', 'success'].includes(item.status);
}

function toolRows(
  block: Extract<ConversationBlock, { kind: 'tool-group' }>,
  width: number,
  language: ResolvedUiLanguage
): StyledLine[] {
  const zh = language === 'zh-CN';
  if (
    block.category === 'read' &&
    block.items.length > 1 &&
    block.items.every((item) => item.status === 'success' && !item.expanded)
  ) {
    const totalDuration = block.items.reduce((total, item) => total + (item.durationMs ?? 0), 0);
    return [
      plainLine(
        `  ${block.items.length} ${zh ? '个只读工具' : 'read tools'}${totalDuration ? ` · ${duration(totalDuration)}` : ''}`,
        { dim: true }
      )
    ];
  }
  const rows: StyledLine[] = [];
  for (const item of block.items) {
    const failure = failedTool(item);
    const status = zh
      ? ({
          requested: '已请求',
          running: '执行中',
          success: '成功',
          error: '错误',
          denied: '已拒绝',
          cancelled: '已取消'
        }[item.status] ?? item.status)
      : item.status;
    rows.push(
      plainLine(
        `  ${item.name} ${status}${item.durationMs === undefined ? '' : ` (${duration(item.durationMs)})`}${item.summary ? `: ${item.summary}` : ''}`,
        { dim: !failure, color: failure ? 'yellow' : undefined }
      )
    );
    if (item.expanded && item.detail) {
      rows.push(
        ...wrapStyledLines(
          item.detail.split('\n').map((text) => plainLine(`    ${text}`, { dim: !failure })),
          width
        )
      );
    }
  }
  return rows;
}

function summaryLine(
  block: Extract<ConversationBlock, { kind: 'assistant' }>,
  language: ResolvedUiLanguage
): StyledLine | undefined {
  if (!block.summary) return undefined;
  const fields = [
    duration(block.summary.workingDurationMs),
    block.summary.inputTokens === undefined || block.summary.outputTokens === undefined
      ? undefined
      : `${block.summary.inputTokens} in / ${block.summary.outputTokens} out`,
    block.summary.tools
      ? language === 'zh-CN'
        ? `${block.summary.tools} 次工具`
        : `${block.summary.tools} tool${block.summary.tools === 1 ? '' : 's'}`
      : undefined,
    block.summary.retries
      ? language === 'zh-CN'
        ? `${block.summary.retries} 次重试`
        : `${block.summary.retries} retr${block.summary.retries === 1 ? 'y' : 'ies'}`
      : undefined,
    block.summary.finishReason
      ? `${language === 'zh-CN' ? '结束' : 'finish'}: ${block.summary.finishReason}`
      : undefined
  ].filter(Boolean);
  return fields.length > 0 ? plainLine(`  ${fields.join(' · ')}`, { dim: true }) : undefined;
}

const staticBlockCache = new WeakMap<object, Map<string, readonly StyledLine[]>>();
const MAX_CACHED_LAYOUTS_PER_BLOCK = 4;

function cachedStaticLines(
  block: ConversationBlock,
  width: number,
  language: ResolvedUiLanguage
): readonly StyledLine[] {
  const key = `${width}:${language}:${process.env.NO_COLOR ? 'plain' : 'color'}`;
  let entries = staticBlockCache.get(block);
  const cached = entries?.get(key);
  if (cached) return cached;

  let lines: readonly StyledLine[];
  if (block.kind === 'user') {
    lines = prefixed(renderMarkdown(block.text, Math.max(1, width - 2)), '> ');
  } else if (block.kind === 'assistant') {
    lines = prefixed(renderMarkdown(block.markdown, Math.max(1, width - 2)), '· ');
  } else if (block.kind === 'tool-group') {
    lines = toolRows(block, width, language);
  } else if (block.kind === 'notice') {
    const color =
      block.tone === 'error'
        ? 'red'
        : block.tone === 'warning'
          ? 'yellow'
          : block.tone === 'success'
            ? 'green'
            : 'cyan';
    lines = prefixed(renderMarkdown(block.text, Math.max(1, width - 2)), '· ').map((line) => ({
      spans: line.spans.map((item) => ({ ...item, color: item.color ?? color }))
    }));
  } else {
    lines = [plainLine(`  [${block.text}]`, { dim: true })];
  }
  entries ??= new Map();
  if (entries.size >= MAX_CACHED_LAYOUTS_PER_BLOCK) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, lines);
  staticBlockCache.set(block, entries);
  return lines;
}

function appendRows(
  target: TranscriptRow[],
  block: ConversationBlock,
  lines: readonly StyledLine[],
  backgroundColor?: string,
  sourceRowOffset = 0
): void {
  lines.forEach((line, sourceRow) => {
    target.push({
      key: `${block.id}:${sourceRowOffset + sourceRow}`,
      blockId: block.id,
      ...('turnId' in block ? { turnId: block.turnId } : {}),
      sourceRow: sourceRowOffset + sourceRow,
      kind: block.kind,
      spans: line.spans,
      ...(backgroundColor ? { backgroundColor } : {})
    });
  });
}

export function useTranscriptLayout(
  blocks: readonly ConversationBlock[],
  width: number,
  language: ResolvedUiLanguage = 'en'
): TranscriptLayout {
  const presenters = useRef(new Map<string, StreamingTextPresenter>());
  const presentedSources = useRef(new Map<string, string>());
  const [streamRevision, setStreamRevision] = useState(0);
  const activeIds = new Set<string>();
  const retainedIds = new Set<string>();

  for (const block of blocks) {
    if (block.kind !== 'assistant') continue;
    retainedIds.add(block.id);
    if (block.status !== 'streaming' && presentedSources.current.get(block.id) === block.markdown) {
      continue;
    }
    presentedSources.current.delete(block.id);
    let presenter = presenters.current.get(block.id);
    if (!presenter && block.status !== 'streaming' && block.live !== true) continue;
    if (!presenter) {
      presenter = new StreamingTextPresenter();
      presenters.current.set(block.id, presenter);
    }
    activeIds.add(block.id);
    presenter.sync(
      block.markdown,
      Math.max(1, width - 2),
      block.status !== 'streaming',
      Date.now(),
      block.live === true
    );
    if (block.status !== 'streaming' && presenter.snapshot().queueDepth === 0) {
      // Live marks provenance, not unfinished presentation. Do not animate the same answer again.
      presentedSources.current.set(block.id, block.markdown);
      presenters.current.delete(block.id);
      activeIds.delete(block.id);
    }
  }
  for (const id of presenters.current.keys()) {
    if (!activeIds.has(id)) presenters.current.delete(id);
  }
  for (const id of presentedSources.current.keys()) {
    if (!retainedIds.has(id)) presentedSources.current.delete(id);
  }

  const hasPendingRows = [...presenters.current.values()].some(
    (presenter) => presenter.snapshot().queueDepth > 0
  );
  useEffect(() => {
    if (!hasPendingRows) return;
    const timer = setTimeout(() => {
      let changed = false;
      for (const presenter of presenters.current.values()) changed = presenter.drain() || changed;
      if (changed) setStreamRevision((value) => value + 1);
    }, STREAM_TICK_MS);
    return () => clearTimeout(timer);
  }, [hasPendingRows, streamRevision]);

  return useMemo(() => {
    const rows: TranscriptRow[] = [];
    const userBlocks = new Map<string, Extract<ConversationBlock, { kind: 'user' }>>();
    for (const block of blocks) {
      if (block.kind === 'user') {
        userBlocks.set(block.turnId, block);
        appendRows(
          rows,
          block,
          cachedStaticLines(block, width, language),
          process.env.NO_COLOR ? undefined : '#1f2937'
        );
        continue;
      }
      if (block.kind === 'assistant') {
        const presenter = presenters.current.get(block.id);
        const body = presenter?.visibleRows();
        const bodyLines = body ? prefixed(body, '· ') : cachedStaticLines(block, width, language);
        appendRows(rows, block, bodyLines);
        const summary = summaryLine(block, language);
        if (summary && (presenter?.snapshot().queueDepth ?? 0) === 0) {
          appendRows(rows, block, [summary], undefined, bodyLines.length);
        }
        continue;
      }
      if (block.kind === 'tool-group') {
        appendRows(rows, block, cachedStaticLines(block, width, language));
        continue;
      }
      if (block.kind === 'notice') {
        appendRows(rows, block, cachedStaticLines(block, width, language));
        continue;
      }
      appendRows(rows, block, cachedStaticLines(block, width, language));
    }
    return {
      rows,
      userBlocks,
      pendingPresentationRows: [...presenters.current.values()].reduce(
        (total, presenter) => total + presenter.snapshot().queueDepth,
        0
      )
    };
  }, [blocks, language, streamRevision, width]);
}

export function resolveAnchor(
  layout: TranscriptLayout,
  anchor: TranscriptAnchor | undefined,
  height: number
): number {
  if (!anchor) return Math.max(0, layout.rows.length - Math.max(1, height));
  const index = layout.rows.findIndex(
    (row) => row.blockId === anchor.blockId && row.sourceRow === anchor.sourceRow
  );
  return Math.max(0, (index < 0 ? 0 : index) - anchor.viewportOffset);
}

export function anchorAt(layout: TranscriptLayout, start: number): TranscriptAnchor | undefined {
  const row = layout.rows[start];
  return row ? { blockId: row.blockId, sourceRow: row.sourceRow, viewportOffset: 0 } : undefined;
}

export function scrollAnchor(
  layout: TranscriptLayout,
  anchor: TranscriptAnchor | undefined,
  height: number,
  rows: number
): TranscriptAnchor | undefined {
  const latestStart = Math.max(0, layout.rows.length - Math.max(1, height));
  const current = resolveAnchor(layout, anchor, height);
  const next = Math.max(0, Math.min(latestStart, current + rows));
  return next >= latestStart ? undefined : anchorAt(layout, next);
}

export function anchorAtFraction(
  layout: TranscriptLayout,
  height: number,
  fraction: number
): TranscriptAnchor | undefined {
  const maximumStart = Math.max(0, layout.rows.length - Math.max(1, height));
  if (maximumStart === 0) return undefined;
  const start = Math.max(0, Math.min(maximumStart, Math.round(maximumStart * fraction)));
  return start === maximumStart ? undefined : anchorAt(layout, start);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function normalizedSelection(selection: TranscriptSelection): {
  first: TranscriptSelectionPoint;
  last: TranscriptSelectionPoint;
} {
  const forward =
    selection.start.row < selection.end.row ||
    (selection.start.row === selection.end.row && selection.start.column <= selection.end.column);
  return forward
    ? { first: selection.start, last: selection.end }
    : { first: selection.end, last: selection.start };
}

function selectionRangeForRow(
  selection: TranscriptSelection | undefined,
  row: number
): { start: number; end: number } | undefined {
  if (!selection) return undefined;
  const { first, last } = normalizedSelection(selection);
  if (row < first.row || row > last.row) return undefined;
  return {
    start: row === first.row ? first.column : 0,
    end: row === last.row ? last.column : Number.POSITIVE_INFINITY
  };
}

function selectedSpanParts(
  span: StyledSpan,
  column: number,
  range: { start: number; end: number } | undefined
): Array<{ text: string; selected: boolean }> {
  if (!range) return [{ text: span.text, selected: false }];
  const parts: Array<{ text: string; selected: boolean }> = [];
  let current = '';
  let selected: boolean | undefined;
  let offset = column;
  for (const grapheme of graphemeSegmenter.segment(span.text)) {
    const width = Math.max(1, stringWidth(grapheme.segment));
    const nextSelected = offset < range.end && offset + width > range.start;
    if (selected !== undefined && nextSelected !== selected) {
      parts.push({ text: current, selected });
      current = '';
    }
    selected = nextSelected;
    current += grapheme.segment;
    offset += width;
  }
  if (current) parts.push({ text: current, selected: selected ?? false });
  return parts;
}

function rowText(row: TranscriptRow): string {
  return row.spans.map((span) => span.text).join('');
}

function sliceTextColumns(text: string, start: number, end: number): string {
  let result = '';
  let column = 0;
  for (const grapheme of graphemeSegmenter.segment(text)) {
    const width = Math.max(1, stringWidth(grapheme.segment));
    if (column < end && column + width > start) result += grapheme.segment;
    column += width;
  }
  return result;
}

export function selectedTranscriptText(
  viewport: TranscriptViewport,
  selection: TranscriptSelection
): string {
  const { first, last } = normalizedSelection(selection);
  const lines: string[] = [];
  for (let row = first.row; row <= last.row && row < viewport.rows.length; row += 1) {
    const text = rowText(viewport.rows[row]!);
    lines.push(
      sliceTextColumns(
        text,
        row === first.row ? first.column : 0,
        row === last.row ? last.column : Number.POSITIVE_INFINITY
      ).replace(/\s+$/u, '')
    );
  }
  return lines.join('\n').trimEnd();
}

function Row({
  row,
  width,
  selection
}: {
  row: TranscriptRow;
  width: number;
  selection?: { start: number; end: number };
}) {
  const used = row.spans.reduce((total, item) => total + stringWidth(item.text), 0);
  const padding = row.backgroundColor ? ' '.repeat(Math.max(0, width - used)) : '';
  let column = 0;
  return (
    <Text backgroundColor={row.backgroundColor} wrap="truncate-end">
      {row.spans.flatMap((item, index) => {
        const start = column;
        column += stringWidth(item.text);
        return selectedSpanParts(item, start, selection).map((part, partIndex) => (
          <Text
            key={`${row.key}:span:${index}:${partIndex}`}
            bold={item.bold}
            italic={item.italic}
            dimColor={part.selected ? false : item.dim}
            underline={item.underline}
            inverse={part.selected}
            color={process.env.NO_COLOR ? undefined : item.color}
            backgroundColor={row.backgroundColor}
          >
            {part.text}
          </Text>
        ));
      })}
      {padding}
    </Text>
  );
}

export function transcriptViewport(
  layout: TranscriptLayout,
  width: number,
  height: number,
  anchor: TranscriptAnchor | undefined,
  stickyExpanded = false,
  language: ResolvedUiLanguage = 'en'
): TranscriptViewport {
  let start = resolveAnchor(layout, anchor, height);
  const first = layout.rows[start];
  const user = first?.turnId ? layout.userBlocks.get(first.turnId) : undefined;
  const userVisible = user
    ? layout.rows.slice(start, start + height).some((row) => row.blockId === user.id)
    : false;
  const stickyRows: TranscriptRow[] = [];
  if (user && !userVisible) {
    const backgroundColor = process.env.NO_COLOR ? undefined : '#26364d';
    const allContent = prefixed(renderMarkdown(user.text, Math.max(1, width - 2)), '> ');
    const contentLimit = stickyExpanded ? Math.max(3, height - 2) : 3;
    const truncated = allContent.length > contentLimit;
    const content = allContent.slice(0, contentLimit).map((line, index): TranscriptRow => ({
      key: `sticky:${user.id}:${index}`,
      blockId: user.id,
      turnId: user.turnId,
      sourceRow: index,
      kind: 'user',
      spans: line.spans.map((item) => ({ ...item, bold: true })),
      ...(backgroundColor ? { backgroundColor } : {})
    }));
    if (allContent.length > 3 && content.length > 0) {
      const last = content.at(-1);
      if (last) {
        last.spans = [
          ...last.spans,
          {
            text: truncated
              ? stickyExpanded
                ? ` ... [${allContent.length - content.length} ${language === 'zh-CN' ? '行未显示' : 'more lines'}]`
                : language === 'zh-CN'
                  ? ' ... [单击展开]'
                  : ' ... [click to expand]'
              : language === 'zh-CN'
                ? '  [单击收起]'
                : '  [click to collapse]',
            dim: true
          }
        ];
      }
    }
    stickyRows.push(...content, {
      key: `sticky:${user.id}:padding`,
      blockId: user.id,
      turnId: user.turnId,
      sourceRow: content.length,
      kind: 'user',
      spans: [],
      ...(backgroundColor ? { backgroundColor } : {})
    });
  }
  const visibleHeight = Math.max(1, height - stickyRows.length);
  if (stickyRows.length > 0) start = resolveAnchor(layout, anchor, visibleHeight);
  const visible = layout.rows.slice(start, start + visibleHeight);
  const maximumStart = Math.max(0, layout.rows.length - visibleHeight);
  const thumbSize =
    maximumStart === 0
      ? height
      : Math.max(1, Math.min(height, Math.round((height * visibleHeight) / layout.rows.length)));
  const thumbStart =
    maximumStart === 0
      ? 0
      : Math.round(((height - thumbSize) * Math.min(start, maximumStart)) / maximumStart);
  return {
    rows: [...stickyRows, ...visible],
    stickyRows: stickyRows.length,
    start,
    visibleHeight,
    maximumStart,
    thumbStart,
    thumbSize
  };
}

export const TranscriptView = memo(function TranscriptView({
  layout,
  width,
  height,
  anchor,
  stickyExpanded = false,
  selection,
  language = 'en'
}: {
  layout: TranscriptLayout;
  width: number;
  height: number;
  anchor?: TranscriptAnchor;
  stickyExpanded?: boolean;
  selection?: TranscriptSelection;
  language?: ResolvedUiLanguage;
}) {
  const viewport = transcriptViewport(layout, width, height, anchor, stickyExpanded, language);
  return (
    <Box aria-label="Conversation transcript" flexDirection="row" height={height} overflow="hidden">
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        {viewport.rows.map((row, index) => (
          <Row
            key={row.key}
            row={row}
            width={width}
            selection={selectionRangeForRow(selection, index)}
          />
        ))}
      </Box>
      <Box aria-label="Transcript scrollbar" flexDirection="column" width={1} height={height}>
        {Array.from({ length: height }, (_, index) => (
          <Text
            key={index}
            dimColor={
              index < viewport.thumbStart || index >= viewport.thumbStart + viewport.thumbSize
            }
          >
            {index >= viewport.thumbStart && index < viewport.thumbStart + viewport.thumbSize
              ? '█'
              : '│'}
          </Text>
        ))}
      </Box>
    </Box>
  );
});

export function transcriptLayoutForTest(
  blocks: readonly ConversationBlock[],
  width: number
): TranscriptLayout {
  const rows: TranscriptRow[] = [];
  const userBlocks = new Map<string, Extract<ConversationBlock, { kind: 'user' }>>();
  for (const block of blocks) {
    if (block.kind === 'user') {
      userBlocks.set(block.turnId, block);
      appendRows(rows, block, prefixed(renderMarkdown(block.text, Math.max(1, width - 2)), '> '));
    } else if (block.kind === 'assistant') {
      appendRows(
        rows,
        block,
        prefixed(renderMarkdown(block.markdown, Math.max(1, width - 2)), '· ')
      );
    }
  }
  return { rows, userBlocks, pendingPresentationRows: 0 };
}
