import { relative } from 'node:path';
import { z } from 'zod';
import type { ToolResult } from '../types.js';
import { isAbortError, throwIfAborted } from './abort.js';
import {
  applyApprovedFileChange,
  createApprovedFileChange,
  createFileDiff,
  hashContent,
  parseApprovedFileChange,
  readOptionalFileSnapshot
} from './file-changes.js';
import { limitUtf8Head } from './output-limits.js';
import { defineTool } from './runtime.js';
import { resolveWorkspacePath } from './workspace.js';

const MAX_PATH_CHARACTERS = 4_096;
const MAX_PATCH_TEXT_CHARACTERS = 2_000_000;
const MAX_PATCH_OPERATIONS = 20;
const MAX_FILE_CHANGE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 40 * 1024;

interface ResolvedPatchOperation {
  start: number;
  end: number;
  oldText: string;
  newText: string;
}

function createPatchError(error: unknown): ToolResult {
  if (isAbortError(error)) {
    throw error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return {
    content: `Patch failed: ${reason}`,
    isError: true,
    metadata: {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    }
  };
}

function normalizeHash(value: string): string {
  return value.toLowerCase().replace(/^sha256:/, '');
}

function countOccurrences(content: string, searchText: string): number {
  let count = 0;
  let position = 0;
  while (position <= content.length - searchText.length) {
    const matchIndex = content.indexOf(searchText, position);
    if (matchIndex === -1) {
      break;
    }
    count += 1;
    position = matchIndex + searchText.length;
  }
  return count;
}

function detectConsistentLineEnding(content: string): '\n' | '\r\n' | undefined {
  const withoutCrLf = content.replaceAll('\r\n', '');
  const hasCrLf = content.includes('\r\n');
  const hasLf = withoutCrLf.includes('\n');
  if (hasCrLf && !hasLf) {
    return '\r\n';
  }
  if (hasLf && !hasCrLf) {
    return '\n';
  }
  return undefined;
}

function normalizeLineEndings(value: string, lineEnding: '\n' | '\r\n'): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\n', lineEnding);
}

function resolveOperations(
  content: string,
  operations: ReadonlyArray<{ oldText: string; newText: string }>
): ResolvedPatchOperation[] {
  const lineEnding = detectConsistentLineEnding(content);
  const resolved = operations.map((operation, operationIndex) => {
    let oldText = operation.oldText;
    let occurrenceCount = countOccurrences(content, oldText);

    if (occurrenceCount === 0 && lineEnding) {
      const normalizedOldText = normalizeLineEndings(oldText, lineEnding);
      if (normalizedOldText !== oldText) {
        oldText = normalizedOldText;
        occurrenceCount = countOccurrences(content, oldText);
      }
    }

    if (occurrenceCount !== 1) {
      throw new Error(
        `operations[${operationIndex}].oldText must occur exactly once; found ${occurrenceCount} matches`
      );
    }

    const newText = lineEnding
      ? normalizeLineEndings(operation.newText, lineEnding)
      : operation.newText;
    if (oldText === newText) {
      throw new Error(`operations[${operationIndex}] would not change the file`);
    }

    const start = content.indexOf(oldText);
    return {
      start,
      end: start + oldText.length,
      oldText,
      newText
    };
  });

  const ordered = [...resolved].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new Error('Patch operations overlap in the original file');
    }
  }
  return ordered;
}

function applyResolvedOperations(
  content: string,
  operations: readonly ResolvedPatchOperation[]
): string {
  let proposedContent = content;
  const descending = [...operations].sort((left, right) => right.start - left.start);
  for (const operation of descending) {
    proposedContent =
      proposedContent.slice(0, operation.start) +
      operation.newText +
      proposedContent.slice(operation.end);
  }
  return proposedContent;
}

const patchInputSchema = z.object({
  path: z.string()
    .trim()
    .min(1, 'Path cannot be empty')
    .max(MAX_PATH_CHARACTERS, 'Path is too long')
    .describe('Existing UTF-8 file inside the workspace'),
  expectedHash: z.string()
    .trim()
    .regex(
      /^(?:sha256:)?[a-fA-F0-9]{64}$/,
      'expectedHash must be a SHA-256 hash returned by Read'
    )
    .describe('SHA-256 version returned by the latest Read'),
  operations: z.array(z.object({
    oldText: z.string()
      .min(1, 'oldText cannot be empty')
      .max(MAX_PATCH_TEXT_CHARACTERS, 'oldText is too large')
      .describe('Exact, uniquely matching text from the original file'),
    newText: z.string()
      .max(MAX_PATCH_TEXT_CHARACTERS, 'newText is too large')
      .describe('Replacement text')
  }).strict())
    .min(1)
    .max(MAX_PATCH_OPERATIONS)
}).strict();

export const patchTool = defineTool({
  name: 'Patch',
  description:
    'Apply one or more exact, non-overlapping edits to the version returned by Read. Rejects stale or ambiguous context.',
  inputSchema: patchInputSchema,
  risk: 'write',
  approval: 'always',
  async prepareApproval(input, context) {
    throwIfAborted(context.signal);
    const targetPath = await resolveWorkspacePath(
      input.path,
      context.workspaceRoot,
      'write'
    );
    const currentFile = await readOptionalFileSnapshot(
      targetPath,
      MAX_FILE_CHANGE_BYTES,
      context.signal
    );
    if (!currentFile) {
      throw new Error(`Cannot patch a file that does not exist: ${input.path}`);
    }

    const currentHash = hashContent(currentFile.content);
    if (currentHash !== normalizeHash(input.expectedHash)) {
      throw new Error(
        `The file changed after it was read; read ${input.path} again before patching`
      );
    }

    const resolvedOperations = resolveOperations(currentFile.content, input.operations);
    const proposedContent = applyResolvedOperations(
      currentFile.content,
      resolvedOperations
    );
    const displayPath = relative(context.workspaceRoot, targetPath)
      .replaceAll('\\', '/') || input.path;
    const limitedDiff = limitUtf8Head(
      createFileDiff(displayPath, currentFile.content, proposedContent),
      MAX_DIFF_BYTES,
      '\n\n[Diff truncated]'
    );
    const approvedChange = {
      ...createApprovedFileChange(targetPath, currentFile, proposedContent),
      displayPath,
      approvedDiff: limitedDiff.text,
      changeCount: resolvedOperations.length
    };

    return {
      description: `Patch ${displayPath} (${resolvedOperations.length} operation${resolvedOperations.length === 1 ? '' : 's'})`,
      preview: limitedDiff.text,
      executionData: approvedChange
    };
  },
  async execute(_input, context) {
    try {
      throwIfAborted(context.signal);
      const approvedChange = parseApprovedFileChange(context.approvalData);
      if (!approvedChange) {
        return {
          content: 'Patch failed: approved file change metadata is missing',
          isError: true
        };
      }

      const applyResult = await applyApprovedFileChange(
        approvedChange,
        context.signal,
        async () => {
          const verifiedTargetPath = await resolveWorkspacePath(
            approvedChange.targetPath,
            context.workspaceRoot,
            'write'
          );
          if (verifiedTargetPath !== approvedChange.targetPath) {
            throw new Error('Approved target path changed before execution');
          }
        }
      );
      if (applyResult === 'changed') {
        return {
          content:
            'Patch failed: the file changed after approval; read it again and review a new diff',
          isError: true
        };
      }

      const newHash = hashContent(approvedChange.proposedContent);
      const displayPath = approvedChange.displayPath ??
        relative(context.workspaceRoot, approvedChange.targetPath).replaceAll('\\', '/');
      const content = [
        `Successfully patched ${displayPath}`,
        `Version: sha256:${newHash}`,
        `Operations: ${approvedChange.changeCount ?? 1}`,
        '',
        approvedChange.approvedDiff ?? '(diff unavailable)'
      ].join('\n');
      const limited = limitUtf8Head(content, MAX_DIFF_BYTES);
      return {
        content: limited.text,
        metadata: {
          versionHash: newHash,
          changeCount: approvedChange.changeCount ?? 1,
          diffTruncated: limited.truncated
        }
      };
    } catch (error) {
      return createPatchError(error);
    }
  }
});
