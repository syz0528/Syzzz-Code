import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';
import type { ToolResult } from '../types.js';
import { throwIfAborted } from './abort.js';
import { runBoundedProcess } from './bounded-process.js';
import { limitUtf8Head } from './output-limits.js';
import { defineTool } from './runtime.js';
import {
  isSensitiveRelativePath,
  resolveWorkspacePath
} from './workspace.js';

const require = createRequire(import.meta.url);
const MAX_PATH_CHARACTERS = 4_096;
const MAX_PATTERN_CHARACTERS = 10_000;
const MAX_GLOB_RESULTS = 1_000;
const DEFAULT_GLOB_RESULTS = 200;
const DEFAULT_CONTENT_RESULTS = 200;
const MAX_CONTENT_RESULTS = 2_000;
const DEFAULT_FILE_RESULTS = 500;
const MAX_FILE_RESULTS = 10_000;
const MAX_RESULT_BYTES = 40 * 1024;
const MAX_RIPGREP_STDOUT_BYTES = 5 * 1024 * 1024;
const MAX_RESULT_LINE_CHARACTERS = 1_000;
const SEARCH_TIMEOUT_MS = 20_000;

const SENSITIVE_IGNORE_RULES = [
  '.git/',
  '.ssh/',
  '.env',
  '.env.*',
  '!.env.example',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
  '*.pem',
  '*.key',
  ''
].join('\n');

const pathSchema = z.string()
  .trim()
  .min(1, 'Path cannot be empty')
  .max(MAX_PATH_CHARACTERS, 'Path is too long');

const patternSchema = z.string()
  .min(1, 'Pattern cannot be empty')
  .max(MAX_PATTERN_CHARACTERS, 'Pattern is too long');

function createSearchError(action: string, error: unknown): ToolResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    content: `${action} failed: ${reason}`,
    isError: true,
    metadata: {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    }
  };
}

let cachedRipgrepPath: string | undefined;

function getRipgrepPath(): string {
  if (!cachedRipgrepPath) {
    const ripgrepPackage = require('@vscode/ripgrep') as { rgPath?: unknown };
    if (typeof ripgrepPackage.rgPath !== 'string' || !ripgrepPackage.rgPath) {
      throw new Error('The bundled ripgrep executable is unavailable on this platform');
    }
    cachedRipgrepPath = ripgrepPackage.rgPath;
  }
  return cachedRipgrepPath;
}

async function runRipgrep(
  arguments_: readonly string[],
  cwd: string,
  signal: AbortSignal
) {
  const result = await runBoundedProcess(getRipgrepPath(), arguments_, {
    cwd,
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxStdoutBytes: MAX_RIPGREP_STDOUT_BYTES,
    maxStderrBytes: MAX_RESULT_BYTES,
    stdin: SENSITIVE_IGNORE_RULES
  });

  if (result.timedOut) {
    throw new Error(`Search exceeded the ${SEARCH_TIMEOUT_MS} ms timeout`);
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const stderr = result.stderr.toString('utf8').trim();
    throw new Error(stderr || `ripgrep exited with code ${result.exitCode ?? 'unknown'}`);
  }
  return result;
}

function relativeWorkspacePath(
  workspaceRoot: string,
  searchRoot: string,
  ripgrepPath: string
): string | undefined {
  const workspaceRelativePath = relative(
    workspaceRoot,
    join(searchRoot, ripgrepPath)
  ).replaceAll('\\', '/');
  return isSensitiveRelativePath(workspaceRelativePath)
    ? undefined
    : workspaceRelativePath || '.';
}

export interface WorkspaceFileList {
  paths: string[];
  sourceTruncated: boolean;
  durationMs: number;
}

export async function listWorkspaceFiles(
  workspaceRoot: string,
  requestedPath: string,
  pattern: string,
  signal: AbortSignal
): Promise<WorkspaceFileList> {
  throwIfAborted(signal);
  const searchRoot = await resolveWorkspacePath(
    requestedPath.trim() || '.',
    workspaceRoot,
    'read'
  );
  const searchStats = await stat(searchRoot);
  if (!searchStats.isDirectory()) {
    throw new Error(`Search path must be a directory: ${requestedPath}`);
  }
  const searchPath = relative(workspaceRoot, searchRoot)
    .replaceAll('\\', '/') || '.';
  const result = await runRipgrep([
    '--files',
    '--hidden',
    '--no-require-git',
    '--color',
    'never',
    '--ignore-file',
    '-',
    '--',
    searchPath
  ], workspaceRoot, signal);
  throwIfAborted(signal);

  const matchesPattern = picomatch(pattern, { dot: true });
  return {
    paths: result.stdout
      .toString('utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(path => relativeWorkspacePath(workspaceRoot, workspaceRoot, path))
      .filter((path): path is string => Boolean(path))
      .filter(path => matchesPattern(path))
      .sort((left, right) => left.localeCompare(right)),
    sourceTruncated: result.stdoutTruncated,
    durationMs: result.durationMs
  };
}

const globInputSchema = z.object({
  pattern: patternSchema.describe('A ripgrep-compatible file glob'),
  path: pathSchema
    .optional()
    .describe('Directory inside the workspace; defaults to the workspace root'),
  offset: z.number()
    .int()
    .min(0)
    .max(100_000)
    .optional()
    .describe('Number of sorted results to skip'),
  limit: z.number()
    .int()
    .min(1)
    .max(MAX_GLOB_RESULTS)
    .optional()
    .describe(`Maximum results to return; defaults to ${DEFAULT_GLOB_RESULTS}`)
}).strict();

export const globTool = defineTool({
  name: 'Glob',
  description:
    'Find workspace files by glob pattern. Results are relative, sorted, bounded, and respect ignore and sensitive-path rules.',
  inputSchema: globInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      const result = await listWorkspaceFiles(
        context.workspaceRoot,
        input.path?.trim() || '.',
        input.pattern,
        context.signal
      );
      const paths = result.paths;
      const offset = input.offset ?? 0;
      const limit = input.limit ?? DEFAULT_GLOB_RESULTS;
      const visiblePaths = paths.slice(offset, offset + limit);
      const sourceTruncated = result.sourceTruncated;
      const truncated = sourceTruncated || paths.length > offset + visiblePaths.length;
      const body = visiblePaths.length > 0
        ? visiblePaths.join('\n')
        : '(no matching files)';
      const totalDescription = sourceTruncated
        ? `at least ${paths.length}`
        : String(paths.length);
      const footer = truncated
        ? `\n\n[Truncated: showing ${visiblePaths.length} results from offset ${offset}; use a narrower pattern or a later offset]`
        : '';
      const limited = limitUtf8Head(
        `Glob: ${input.pattern}\nMatches: ${totalDescription}\n${body}${footer}`,
        MAX_RESULT_BYTES
      );

      return {
        content: limited.text,
        metadata: {
          matchCount: paths.length,
          shownCount: visiblePaths.length,
          offset,
          limit,
          truncated: truncated || limited.truncated,
          totalKnown: !sourceTruncated,
          durationMs: result.durationMs
        }
      };
    } catch (error) {
      return createSearchError('Glob', error);
    }
  }
});

type GrepOutputMode = 'content' | 'files' | 'count';

interface RipgrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: unknown[];
  };
}

interface GrepContentLine {
  path: string;
  lineNumber: number;
  content: string;
  matched: boolean;
}

function parseRipgrepJson(
  stdout: Buffer,
  workspaceRoot: string,
  searchRoot: string,
  matchesGlob?: (path: string) => boolean
): {
  contentLines: GrepContentLine[];
  matchingFiles: Map<string, number>;
  malformedTail: boolean;
} {
  const rawLines = stdout.toString('utf8').split(/\r?\n/);
  const contentLines: GrepContentLine[] = [];
  const matchingFiles = new Map<string, number>();
  let malformedTail = false;

  for (const rawLine of rawLines) {
    if (!rawLine) {
      continue;
    }

    let event: RipgrepJsonEvent;
    try {
      event = JSON.parse(rawLine) as RipgrepJsonEvent;
    } catch {
      malformedTail = true;
      continue;
    }
    if (event.type !== 'match' && event.type !== 'context') {
      continue;
    }

    const rawPath = event.data?.path?.text;
    const rawContent = event.data?.lines?.text;
    const lineNumber = event.data?.line_number;
    if (
      typeof rawPath !== 'string' ||
      typeof rawContent !== 'string' ||
      typeof lineNumber !== 'number'
    ) {
      continue;
    }

    const path = relativeWorkspacePath(workspaceRoot, searchRoot, rawPath);
    if (!path || (matchesGlob && !matchesGlob(path))) {
      continue;
    }
    if (event.type === 'match') {
      matchingFiles.set(path, (matchingFiles.get(path) ?? 0) + 1);
    }

    const physicalLines = rawContent.replace(/\r?\n$/, '').split(/\r?\n/);
    for (let lineOffset = 0; lineOffset < physicalLines.length; lineOffset++) {
      const rawPhysicalLine = physicalLines[lineOffset];
      const characters = Array.from(rawPhysicalLine);
      const content = characters.length > MAX_RESULT_LINE_CHARACTERS
        ? `${characters.slice(0, MAX_RESULT_LINE_CHARACTERS).join('')} [line truncated]`
        : rawPhysicalLine;
      contentLines.push({
        path,
        lineNumber: lineNumber + lineOffset,
        content,
        matched: event.type === 'match'
      });
    }
  }

  return { contentLines, matchingFiles, malformedTail };
}

const grepInputSchema = z.object({
  pattern: patternSchema.describe('Regular expression or literal text to search for'),
  path: pathSchema
    .optional()
    .describe('File or directory inside the workspace; defaults to the workspace root'),
  glob: patternSchema
    .optional()
    .describe('Optional file glob filter'),
  outputMode: z.enum(['content', 'files', 'count'])
    .optional()
    .describe('content, files, or per-file matching-line counts; defaults to content'),
  literal: z.boolean()
    .optional()
    .describe('Treat pattern as literal text instead of a regular expression'),
  ignoreCase: z.boolean()
    .optional()
    .describe('Use case-insensitive matching'),
  context: z.number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Context lines before and after each content match'),
  offset: z.number()
    .int()
    .min(0)
    .max(100_000)
    .optional()
    .describe('Number of result lines or entries to skip'),
  limit: z.number()
    .int()
    .min(1)
    .max(MAX_FILE_RESULTS)
    .optional()
    .describe('Maximum result lines or entries')
}).strict();

export const grepTool = defineTool({
  name: 'Grep',
  description:
    'Search UTF-8 workspace files with bounded ripgrep regex or literal matching. Prefer this before reading whole files.',
  inputSchema: grepInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      throwIfAborted(context.signal);
      const searchRoot = await resolveWorkspacePath(
        input.path?.trim() || '.',
        context.workspaceRoot,
        'read'
      );
      const searchPath = relative(context.workspaceRoot, searchRoot)
        .replaceAll('\\', '/') || '.';
      const outputMode: GrepOutputMode = input.outputMode ?? 'content';
      const hardLimit = outputMode === 'content'
        ? MAX_CONTENT_RESULTS
        : MAX_FILE_RESULTS;
      const defaultLimit = outputMode === 'content'
        ? DEFAULT_CONTENT_RESULTS
        : DEFAULT_FILE_RESULTS;
      const limit = Math.min(input.limit ?? defaultLimit, hardLimit);
      const offset = input.offset ?? 0;
      const arguments_ = [
        '--json',
        '--hidden',
        '--no-require-git',
        '--color',
        'never',
        '--no-messages',
        '--ignore-file',
        '-'
      ];
      if (input.literal) {
        arguments_.push('--fixed-strings');
      }
      if (input.ignoreCase) {
        arguments_.push('--ignore-case');
      }
      if (outputMode === 'content' && (input.context ?? 0) > 0) {
        arguments_.push('--context', String(input.context));
      }
      arguments_.push('--', input.pattern, searchPath);

      const result = await runRipgrep(
        arguments_,
        context.workspaceRoot,
        context.signal
      );
      const parsed = parseRipgrepJson(
        result.stdout,
        context.workspaceRoot,
        context.workspaceRoot,
        input.glob ? picomatch(input.glob, { dot: true }) : undefined
      );
      throwIfAborted(context.signal);

      let allEntries: string[];
      let matchCount: number;
      if (outputMode === 'content') {
        allEntries = parsed.contentLines.map(line =>
          `${line.path}${line.matched ? ':' : '-'}${line.lineNumber}${line.matched ? ':' : '-'}${line.content}`
        );
        matchCount = parsed.contentLines.filter(line => line.matched).length;
      } else {
        const sortedFiles = [...parsed.matchingFiles.keys()]
          .sort((left, right) => left.localeCompare(right));
        allEntries = outputMode === 'files'
          ? sortedFiles
          : sortedFiles.map(path => `${path}:${parsed.matchingFiles.get(path) ?? 0}`);
        matchCount = [...parsed.matchingFiles.values()]
          .reduce((total, count) => total + count, 0);
      }

      const visibleEntries = allEntries.slice(offset, offset + limit);
      const sourceTruncated = result.stdoutTruncated || parsed.malformedTail;
      const truncated = sourceTruncated ||
        allEntries.length > offset + visibleEntries.length;
      const body = visibleEntries.length > 0
        ? visibleEntries.join('\n')
        : '(no matches)';
      const footer = truncated
        ? `\n\n[Truncated: showing ${visibleEntries.length} ${outputMode} results from offset ${offset}]`
        : '';
      const limited = limitUtf8Head(
        `Grep: ${input.pattern}\nMode: ${outputMode}\nMatching lines: ${sourceTruncated ? 'at least ' : ''}${matchCount}\n${body}${footer}`,
        MAX_RESULT_BYTES
      );

      return {
        content: limited.text,
        metadata: {
          outputMode,
          matchCount,
          matchingFileCount: parsed.matchingFiles.size,
          shownCount: visibleEntries.length,
          offset,
          limit,
          truncated: truncated || limited.truncated,
          totalKnown: !sourceTruncated,
          durationMs: result.durationMs
        }
      };
    } catch (error) {
      return createSearchError('Grep', error);
    }
  }
});
