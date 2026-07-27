import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { relative } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import type { ToolResult } from '../types.js';
import { throwIfAborted } from './abort.js';
import { FileContentError } from './file-changes.js';
import { limitUtf8Head } from './output-limits.js';
import { defineTool } from './runtime.js';
import { resolveWorkspacePath } from './workspace.js';

const MAX_PATH_CHARACTERS = 4_096;
const DEFAULT_READ_LINES = 500;
const MAX_READ_LINES = 2_000;
const MAX_UNRANGED_FILE_BYTES = 1024 * 1024;
const MAX_RANGED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_RESULT_BYTES = 40 * 1024;
const MAX_READ_BODY_BYTES = 38 * 1024;
const MAX_READ_LINE_CHARACTERS = 20_000;
const READ_BUFFER_BYTES = 64 * 1024;

export type FileLineEnding = 'LF' | 'CRLF' | 'mixed' | 'none';

export interface ReadRangeSnapshot {
  content: string;
  metadata: {
    sizeBytes: number;
    totalLines: number;
    startLine: number;
    endLine: number;
    shownLines: number;
    nextOffset?: number;
    versionHash: string;
    lineEnding: FileLineEnding;
    truncated: boolean;
    longLinesTruncated: number;
  };
}

function createReadError(error: unknown): ToolResult {
  const reason = error instanceof Error ? error.message : String(error);
  const errorCode = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
  return {
    content: `Read failed: ${reason}`,
    isError: true,
    metadata: {
      ...(errorCode ? { errorCode } : {}),
      errorName: error instanceof Error ? error.name : 'UnknownError'
    }
  };
}

function classifyLineEnding(lfCount: number, crlfCount: number): FileLineEnding {
  if (lfCount > 0 && crlfCount > 0) {
    return 'mixed';
  }
  if (crlfCount > 0) {
    return 'CRLF';
  }
  if (lfCount > 0) {
    return 'LF';
  }
  return 'none';
}

async function readUtf8Range(
  targetPath: string,
  displayPath: string,
  offset: number,
  limit: number,
  explicitRange: boolean,
  signal: AbortSignal
): Promise<ReadRangeSnapshot> {
  throwIfAborted(signal);
  const fileHandle = await open(targetPath, 'r');

  try {
    const initialStats = await fileHandle.stat();
    if (!initialStats.isFile()) {
      throw new FileContentError(
        `Only regular files can be read: ${displayPath}`,
        'NOT_REGULAR_FILE'
      );
    }
    const maximumBytes = explicitRange
      ? MAX_RANGED_FILE_BYTES
      : MAX_UNRANGED_FILE_BYTES;
    if (initialStats.size > maximumBytes) {
      const guidance = explicitRange
        ? 'Use Grep to locate relevant content in larger files.'
        : 'Provide offset or limit to perform an explicit bounded range read.';
      throw new FileContentError(
        `File is ${initialStats.size} bytes; the limit is ${maximumBytes} bytes. ${guidance}`,
        'FILE_TOO_LARGE'
      );
    }

    const decoder = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true
    });
    const contentHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    const selectedLines: Array<{ number: number; content: string }> = [];
    let selectedBodyBytes = 0;
    let firstUnshownLine: number | undefined;
    let pendingText = '';
    let filePosition = 0;
    let totalLines = 0;
    let lfCount = 0;
    let crlfCount = 0;
    let longLinesTruncated = 0;

    const processLine = (rawLine: string, hadCrLf: boolean) => {
      totalLines += 1;
      if (hadCrLf) {
        crlfCount += 1;
      } else {
        lfCount += 1;
      }
      if (totalLines < offset || totalLines >= offset + limit) {
        return;
      }
      if (firstUnshownLine !== undefined) {
        return;
      }

      const characters = Array.from(rawLine);
      const content = characters.length > MAX_READ_LINE_CHARACTERS
        ? `${characters.slice(0, MAX_READ_LINE_CHARACTERS).join('')} [line truncated]`
        : rawLine;
      if (content !== rawLine) {
        longLinesTruncated += 1;
      }
      const estimatedLineBytes = Buffer.byteLength(
        `${totalLines}| ${content}\n`,
        'utf8'
      );
      if (selectedBodyBytes + estimatedLineBytes > MAX_READ_BODY_BYTES) {
        firstUnshownLine = totalLines;
        return;
      }
      selectedBodyBytes += estimatedLineBytes;
      selectedLines.push({ number: totalLines, content });
    };

    const consumeDecodedText = (decodedText: string) => {
      contentHash.update(decodedText, 'utf8');
      pendingText += decodedText;
      while (true) {
        const newlineIndex = pendingText.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }
        const hadCrLf = newlineIndex > 0 && pendingText[newlineIndex - 1] === '\r';
        const line = hadCrLf
          ? pendingText.slice(0, newlineIndex - 1)
          : pendingText.slice(0, newlineIndex);
        pendingText = pendingText.slice(newlineIndex + 1);
        processLine(line, hadCrLf);
      }
    };

    try {
      while (filePosition < initialStats.size) {
        throwIfAborted(signal);
        const readResult = await fileHandle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, initialStats.size - filePosition),
          filePosition
        );
        if (readResult.bytesRead === 0) {
          break;
        }
        filePosition += readResult.bytesRead;
        consumeDecodedText(
          decoder.decode(buffer.subarray(0, readResult.bytesRead), { stream: true })
        );
      }
      consumeDecodedText(decoder.decode());
    } catch (error) {
      if (error instanceof FileContentError) {
        throw error;
      }
      if (error instanceof TypeError) {
        throw new FileContentError(
          `File is not valid UTF-8: ${displayPath}`,
          'INVALID_UTF8'
        );
      }
      throw error;
    }

    if (pendingText.length > 0) {
      totalLines += 1;
      if (totalLines >= offset && totalLines < offset + limit) {
        const characters = Array.from(pendingText);
        const content = characters.length > MAX_READ_LINE_CHARACTERS
          ? `${characters.slice(0, MAX_READ_LINE_CHARACTERS).join('')} [line truncated]`
          : pendingText;
        if (content !== pendingText) {
          longLinesTruncated += 1;
        }
        const estimatedLineBytes = Buffer.byteLength(
          `${totalLines}| ${content}\n`,
          'utf8'
        );
        if (
          firstUnshownLine === undefined &&
          selectedBodyBytes + estimatedLineBytes <= MAX_READ_BODY_BYTES
        ) {
          selectedLines.push({ number: totalLines, content });
        } else if (firstUnshownLine === undefined) {
          firstUnshownLine = totalLines;
        }
      }
    }

    const finalStats = await fileHandle.stat();
    if (
      filePosition !== initialStats.size ||
      finalStats.size !== initialStats.size ||
      finalStats.mtimeMs !== initialStats.mtimeMs
    ) {
      throw new FileContentError(
        `File changed while it was being read: ${displayPath}`,
        'FILE_CHANGED_DURING_READ'
      );
    }
    throwIfAborted(signal);

    const rangeLimitOffset = offset + limit;
    if (firstUnshownLine === undefined && rangeLimitOffset <= totalLines) {
      firstUnshownLine = rangeLimitOffset;
    }
    const width = Math.max(1, String(Math.max(totalLines, offset)).length);
    const body = selectedLines.length > 0
      ? selectedLines
        .map(line => `${String(line.number).padStart(width)}| ${line.content}`)
        .join('\n')
      : '(no lines in this range)';
    const startLine = selectedLines[0]?.number ?? offset;
    const endLine = selectedLines.at(-1)?.number ?? Math.min(offset - 1, totalLines);
    const versionHash = contentHash.digest('hex');
    const lineEnding = classifyLineEnding(lfCount, crlfCount);
    const continuation = firstUnshownLine !== undefined
      ? `\n\n[More content available: continue with offset ${firstUnshownLine}]`
      : '';
    const header = [
      `File: ${displayPath}`,
      `Version: sha256:${versionHash}`,
      `Lines: ${startLine}-${Math.max(startLine - 1, endLine)} of ${totalLines}`,
      `Line ending: ${lineEnding}`
    ].join('\n');
    const limited = limitUtf8Head(
      `${header}\n\n${body}${continuation}`,
      MAX_READ_RESULT_BYTES
    );

    return {
      content: limited.text,
      metadata: {
        sizeBytes: initialStats.size,
        totalLines,
        startLine,
        endLine,
        shownLines: selectedLines.length,
        ...(firstUnshownLine === undefined ? {} : { nextOffset: firstUnshownLine }),
        versionHash,
        lineEnding,
        truncated: firstUnshownLine !== undefined || limited.truncated,
        longLinesTruncated
      }
    };
  } finally {
    await fileHandle.close();
  }
}

const readInputSchema = z.object({
  path: z.string()
    .trim()
    .min(1, 'Path cannot be empty')
    .max(MAX_PATH_CHARACTERS, 'Path is too long')
    .describe('A UTF-8 file inside the workspace'),
  offset: z.number()
    .int()
    .min(1)
    .optional()
    .describe('One-based first line; defaults to 1'),
  limit: z.number()
    .int()
    .min(1)
    .max(MAX_READ_LINES)
    .optional()
    .describe(`Maximum lines; defaults to ${DEFAULT_READ_LINES}`)
}).strict();

export const readRangeTool = defineTool({
  name: 'Read',
  description:
    'Read a bounded, line-numbered UTF-8 file range with a SHA-256 version. Use Grep first for unfamiliar or large files.',
  inputSchema: readInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      const targetPath = await resolveWorkspacePath(
        input.path,
        context.workspaceRoot,
        'read'
      );
      const displayPath = relative(context.workspaceRoot, targetPath)
        .replaceAll('\\', '/') || input.path;
      const snapshot = await readUtf8Range(
        targetPath,
        displayPath,
        input.offset ?? 1,
        input.limit ?? DEFAULT_READ_LINES,
        input.offset !== undefined || input.limit !== undefined,
        context.signal
      );
      return snapshot;
    } catch (error) {
      return createReadError(error);
    }
  }
});
