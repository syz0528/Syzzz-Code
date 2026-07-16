import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import { throwIfAborted } from './abort.js';

export interface ApprovedFileChange {
  targetPath: string;
  expectedContentHash: string | null;
  proposedContent: string;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function readOptionalFile(
  targetPath: string,
  signal: AbortSignal
): Promise<string | null> {
  throwIfAborted(signal);

  try {
    return await readFile(targetPath, { encoding: 'utf8', signal });
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : undefined;
    if (errorCode === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function createApprovedFileChange(
  targetPath: string,
  currentContent: string | null,
  proposedContent: string
): ApprovedFileChange {
  return {
    targetPath,
    expectedContentHash: currentContent === null ? null : hashContent(currentContent),
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
    typeof candidate.proposedContent !== 'string'
  ) {
    return null;
  }

  return {
    targetPath: candidate.targetPath,
    expectedContentHash: candidate.expectedContentHash,
    proposedContent: candidate.proposedContent
  };
}

export async function hasFileChangedSinceApproval(
  approvedChange: ApprovedFileChange,
  signal: AbortSignal
): Promise<boolean> {
  const currentContent = await readOptionalFile(approvedChange.targetPath, signal);
  const currentHash = currentContent === null ? null : hashContent(currentContent);
  return currentHash !== approvedChange.expectedContentHash;
}
