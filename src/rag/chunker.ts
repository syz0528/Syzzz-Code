import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { RagChunk } from './types.js';

const TARGET_CHUNK_CHARACTERS = 2_400;
const MAX_CHUNK_CHARACTERS = 4_800;
const OVERLAP_LINES = 3;

export interface ChunkSource {
  collectionId: string;
  virtualPath: string;
  content: string;
  sourceHash: string;
  sourceBytes: number;
  sourceMtimeMs: number;
  revision: string;
  embeddingModel?: string;
}

interface ChunkBoundary {
  start: number;
  end: number;
  heading?: string;
  symbol?: string;
}

export function hashRagContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function languageForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.md':
    case '.mdx':
      return 'markdown';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    default:
      return 'text';
  }
}

function markdownBoundaries(lines: string[]): ChunkBoundary[] {
  const sections: ChunkBoundary[] = [];
  const headings: string[] = [];
  let start = 0;
  let currentHeading: string | undefined;

  const push = (end: number) => {
    if (end > start) {
      sections.push({ start, end, ...(currentHeading ? { heading: currentHeading } : {}) });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    push(index);
    const depth = match[1].length;
    headings.length = depth - 1;
    headings[depth - 1] = match[2].trim();
    currentHeading = headings.filter(Boolean).join(' > ');
    start = index;
  }
  push(lines.length);
  return sections.length > 0 ? sections : [{ start: 0, end: lines.length }];
}

function codeBoundaries(lines: string[], language: string): ChunkBoundary[] {
  const symbolPattern =
    language === 'python'
      ? /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/
      : /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|function|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  const starts: Array<{ line: number; symbol: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = symbolPattern.exec(lines[index]);
    if (match && lines[index].length - lines[index].trimStart().length === 0) {
      starts.push({ line: index, symbol: match[1] });
    }
  }
  if (starts.length === 0) return [{ start: 0, end: lines.length }];
  const boundaries: ChunkBoundary[] = [];
  if (starts[0].line > 0) boundaries.push({ start: 0, end: starts[0].line });
  for (let index = 0; index < starts.length; index += 1) {
    boundaries.push({
      start: starts[index].line,
      end: starts[index + 1]?.line ?? lines.length,
      symbol: starts[index].symbol
    });
  }
  return boundaries;
}

function splitBoundary(lines: string[], boundary: ChunkBoundary): ChunkBoundary[] {
  const chunks: ChunkBoundary[] = [];
  let start = boundary.start;
  while (start < boundary.end) {
    let end = start;
    let characters = 0;
    while (end < boundary.end) {
      const next = lines[end].length + 1;
      if (end > start && characters + next > TARGET_CHUNK_CHARACTERS) break;
      characters += next;
      end += 1;
      if (characters >= MAX_CHUNK_CHARACTERS) break;
    }
    if (end === start) end += 1;
    chunks.push({
      start,
      end,
      ...(boundary.heading ? { heading: boundary.heading } : {}),
      ...(boundary.symbol ? { symbol: boundary.symbol } : {})
    });
    if (end >= boundary.end) break;
    start = Math.max(start + 1, end - OVERLAP_LINES);
  }
  return chunks;
}

export function chunkRagSource(source: ChunkSource): RagChunk[] {
  const content = source.content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = content.split('\n');
  const language = languageForPath(source.virtualPath);
  const boundaries =
    language === 'markdown'
      ? markdownBoundaries(lines)
      : language === 'typescript' || language === 'javascript' || language === 'python'
        ? codeBoundaries(lines, language)
        : [{ start: 0, end: lines.length }];

  return boundaries.flatMap((boundary) =>
    splitBoundary(lines, boundary)
      .map((part) => {
        const text = lines.slice(part.start, part.end).join('\n').trimEnd();
        if (!text.trim()) return undefined;
        const identity = [
          source.collectionId,
          source.virtualPath,
          source.sourceHash,
          part.start + 1,
          part.end,
          part.heading ?? '',
          part.symbol ?? ''
        ].join('\0');
        return {
          id: hashRagContent(identity).slice(0, 32),
          collectionId: source.collectionId,
          virtualPath: source.virtualPath,
          lineStart: part.start + 1,
          lineEnd: part.end,
          ...(part.heading ? { heading: part.heading } : {}),
          ...(part.symbol ? { symbol: part.symbol } : {}),
          language,
          text,
          sourceHash: source.sourceHash,
          sourceBytes: source.sourceBytes,
          sourceMtimeMs: source.sourceMtimeMs,
          revision: source.revision,
          ...(source.embeddingModel ? { embeddingModel: source.embeddingModel } : {})
        } satisfies RagChunk;
      })
      .filter((chunk): chunk is RagChunk => chunk !== undefined)
  );
}
