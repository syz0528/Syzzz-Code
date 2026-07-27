import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import { throwIfAborted } from './abort.js';

export class FileContentError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'FILE_TOO_LARGE'
      | 'NOT_REGULAR_FILE'
      | 'FILE_CHANGED_DURING_READ'
      | 'INVALID_UTF8'
  ) {
    super(message);
    this.name = 'FileContentError';
  }
}

export interface FileContentSnapshot {
  content: string;
  mode: number;
  sizeBytes: number;
}

export interface ApprovedFileChange {
  targetPath: string;
  expectedContentHash: string | null;
  expectedSizeBytes: number | null;
  targetMode: number | null;
  proposedContent: string;
  displayPath?: string;
  approvedDiff?: string;
  changeCount?: number;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

export async function readBoundedUtf8File(
  targetPath: string,
  maximumBytes: number,
  signal: AbortSignal
): Promise<FileContentSnapshot> {
  throwIfAborted(signal);
  const fileHandle = await open(targetPath, 'r');

  try {
    const initialStats = await fileHandle.stat();
    if (!initialStats.isFile()) {
      throw new FileContentError(
        `Only regular files can be read: ${targetPath}`,
        'NOT_REGULAR_FILE'
      );
    }
    if (initialStats.size > maximumBytes) {
      throw new FileContentError(
        `File is ${initialStats.size} bytes; the limit is ${maximumBytes} bytes`,
        'FILE_TOO_LARGE'
      );
    }

    const expectedSize = initialStats.size;
    const contents = Buffer.alloc(expectedSize);
    let bytesRead = 0;
    while (bytesRead < expectedSize) {
      throwIfAborted(signal);
      const readResult = await fileHandle.read(
        contents,
        bytesRead,
        expectedSize - bytesRead,
        bytesRead
      );
      if (readResult.bytesRead === 0) {
        break;
      }
      bytesRead += readResult.bytesRead;
    }

    const finalStats = await fileHandle.stat();
    if (
      bytesRead !== expectedSize ||
      finalStats.size !== expectedSize ||
      finalStats.mtimeMs !== initialStats.mtimeMs
    ) {
      throw new FileContentError(
        `File changed while it was being read: ${targetPath}`,
        'FILE_CHANGED_DURING_READ'
      );
    }

    throwIfAborted(signal);
    let content: string;
    try {
      content = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true
      }).decode(contents);
    } catch {
      throw new FileContentError(
        `File is not valid UTF-8: ${targetPath}`,
        'INVALID_UTF8'
      );
    }

    return {
      content,
      mode: initialStats.mode & 0o777,
      sizeBytes: expectedSize
    };
  } finally {
    await fileHandle.close();
  }
}

export async function readOptionalFileSnapshot(
  targetPath: string,
  maximumBytes: number,
  signal: AbortSignal
): Promise<FileContentSnapshot | null> {
  try {
    return await readBoundedUtf8File(targetPath, maximumBytes, signal);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function createApprovedFileChange(
  targetPath: string,
  currentFile: FileContentSnapshot | null,
  proposedContent: string
): ApprovedFileChange {
  return {
    targetPath,
    expectedContentHash: currentFile === null ? null : hashContent(currentFile.content),
    expectedSizeBytes: currentFile?.sizeBytes ?? null,
    targetMode: currentFile?.mode ?? null,
    proposedContent
  };
}

export function createFileDiff(
  displayPath: string,
  currentContent: string | null,
  proposedContent: string
): string {
  return createTwoFilesPatch(
    currentContent === null ? '/dev/null' : displayPath,
    displayPath,
    currentContent ?? '',
    proposedContent,
    currentContent === null ? 'new file' : 'before',
    'after',
    { context: 3 }
  );
}

export function parseApprovedFileChange(value: unknown): ApprovedFileChange | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.targetPath !== 'string' ||
    (candidate.expectedContentHash !== null &&
      typeof candidate.expectedContentHash !== 'string') ||
    (candidate.expectedSizeBytes !== null &&
      (!Number.isSafeInteger(candidate.expectedSizeBytes) ||
        Number(candidate.expectedSizeBytes) < 0)) ||
    (candidate.targetMode !== null &&
      (!Number.isInteger(candidate.targetMode) || Number(candidate.targetMode) < 0)) ||
    typeof candidate.proposedContent !== 'string'
  ) {
    return null;
  }

  return {
    targetPath: candidate.targetPath,
    expectedContentHash: candidate.expectedContentHash,
    expectedSizeBytes: candidate.expectedSizeBytes as number | null,
    targetMode: candidate.targetMode as number | null,
    proposedContent: candidate.proposedContent,
    ...(typeof candidate.displayPath === 'string'
      ? { displayPath: candidate.displayPath }
      : {}),
    ...(typeof candidate.approvedDiff === 'string'
      ? { approvedDiff: candidate.approvedDiff }
      : {}),
    ...(typeof candidate.changeCount === 'number'
      ? { changeCount: candidate.changeCount }
      : {})
  };
}

export async function hasFileChangedSinceApproval(
  approvedChange: ApprovedFileChange,
  signal: AbortSignal
): Promise<boolean> {
  let currentFile: FileContentSnapshot | null;
  try {
    currentFile = await readOptionalFileSnapshot(
      approvedChange.targetPath,
      approvedChange.expectedSizeBytes ?? 0,
      signal
    );
  } catch (error) {
    if (error instanceof FileContentError) {
      return true;
    }
    throw error;
  }

  if (currentFile === null) {
    return approvedChange.expectedContentHash !== null;
  }
  if (
    approvedChange.expectedContentHash === null ||
    currentFile.sizeBytes !== approvedChange.expectedSizeBytes ||
    currentFile.mode !== approvedChange.targetMode
  ) {
    return true;
  }

  return hashContent(currentFile.content) !== approvedChange.expectedContentHash;
}

export async function applyApprovedFileChange(
  approvedChange: ApprovedFileChange,
  signal: AbortSignal,
  revalidateTarget: () => Promise<void>
): Promise<'applied' | 'changed'> {
  await revalidateTarget();
  if (await hasFileChangedSinceApproval(approvedChange, signal)) {
    return 'changed';
  }

  const temporaryPath = join(
    dirname(approvedChange.targetPath),
    `.${basename(approvedChange.targetPath)}.syzzz-${process.pid}-${randomUUID()}.tmp`
  );
  let temporaryHandle: FileHandle | undefined;
  let applied = false;

  try {
    temporaryHandle = await open(
      temporaryPath,
      'wx',
      approvedChange.targetMode ?? 0o666
    );
    await temporaryHandle.writeFile(approvedChange.proposedContent, {
      encoding: 'utf8',
      signal
    });
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    throwIfAborted(signal);
    await revalidateTarget();
    if (await hasFileChangedSinceApproval(approvedChange, signal)) {
      return 'changed';
    }

    throwIfAborted(signal);
    await rename(temporaryPath, approvedChange.targetPath);
    applied = true;
    return 'applied';
  } finally {
    if (temporaryHandle) {
      await temporaryHandle.close().catch(() => undefined);
    }
    if (!applied) {
      await unlink(temporaryPath).catch(error => {
        if (errorCode(error) !== 'ENOENT') {
          throw error;
        }
      });
    }
  }
}
