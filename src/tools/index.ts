import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../types.js';
import { isAbortError, OperationAbortedError, throwIfAborted } from './abort.js';
import {
  createApprovedFileChange,
  createFileDiff,
  hasFileChangedSinceApproval,
  parseApprovedFileChange,
  readOptionalFile
} from './file-changes.js';
import { defineTool } from './runtime.js';
import { runShellCommand, type ShellRunResult } from './shell-runner.js';
import { resolveWorkspacePath } from './workspace.js';

const MAX_PATH_CHARACTERS = 4_096;
const MAX_FILE_CONTENT_CHARACTERS = 2_000_000;
const MAX_SHELL_COMMAND_CHARACTERS = 20_000;
const MAX_SHELL_TIMEOUT_MS = 120_000;
const MAX_LIST_DIRECTORY_ENTRIES = 500;

function createToolError(action: string, error: unknown): ToolResult {
  if (isAbortError(error)) {
    throw error;
  }

  const reason = error instanceof Error ? error.message : String(error);
  const errorCode = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;

  return {
    content: `${action} failed: ${reason}`,
    isError: true,
    metadata: {
      ...(errorCode ? { errorCode } : {}),
      errorName: error instanceof Error ? error.name : 'UnknownError'
    }
  };
}

function countOccurrences(content: string, searchText: string): number {
  let occurrenceCount = 0;
  let searchIndex = 0;

  while (true) {
    const matchIndex = content.indexOf(searchText, searchIndex);
    if (matchIndex === -1) {
      return occurrenceCount;
    }

    occurrenceCount += 1;
    searchIndex = matchIndex + searchText.length;
  }
}

function formatShellResult(result: ShellRunResult): string {
  const summaryLines = [
    `Completion reason: ${result.completionReason}`,
    `Exit code: ${result.exitCode ?? 'none'}`,
    `Duration: ${result.durationMs} ms`
  ];

  if (result.stdout) {
    summaryLines.push('', 'STDOUT:', result.stdout);
  }
  if (result.stderr) {
    summaryLines.push('', 'STDERR:', result.stderr);
  }
  if (!result.stdout && !result.stderr && result.ok) {
    summaryLines.push('', 'Command completed successfully with no output.');
  }
  if (result.stdoutTruncated || result.stderrTruncated) {
    summaryLines.push('', '[Output truncated because the configured byte limit was exceeded]');
  }
  if (result.termination?.error) {
    summaryLines.push('', `Process cleanup warning: ${result.termination.error}`);
  }

  return summaryLines.join('\n');
}

const pathSchema = z.string()
  .trim()
  .min(1, 'Path cannot be empty')
  .max(MAX_PATH_CHARACTERS, 'Path is too long');

const shellInputSchema = z.object({
  command: z.string()
    .trim()
    .min(1, 'Command cannot be empty')
    .max(MAX_SHELL_COMMAND_CHARACTERS, 'Command is too long')
    .describe('The shell command to execute'),
  timeoutMs: z.number()
    .int()
    .min(100)
    .max(MAX_SHELL_TIMEOUT_MS)
    .optional()
    .describe('Optional timeout in milliseconds')
}).strict();

export const shellTool = defineTool({
  name: 'Shell',
  description: 'Execute a non-interactive shell command in the current workspace.',
  inputSchema: shellInputSchema,
  risk: 'execute',
  approval: 'always',
  async prepareApproval(input) {
    return {
      description: `Execute a shell command with a timeout of ${input.timeoutMs ?? 30_000} ms`,
      preview: input.command
    };
  },
  async execute(input, context) {
    throwIfAborted(context.signal);
    const result = await runShellCommand(input.command, {
      cwd: context.workingDirectory,
      signal: context.signal,
      timeoutMs: input.timeoutMs
    });

    if (result.completionReason === 'aborted') {
      throw new OperationAbortedError();
    }

    return {
      content: formatShellResult(result),
      isError: !result.ok,
      metadata: {
        completionReason: result.completionReason,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutBytesSeen: result.stdoutBytesSeen,
        stderrBytesSeen: result.stderrBytesSeen,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated
      }
    };
  }
});

const listDirectoryInputSchema = z.object({
  path: pathSchema
    .optional()
    .describe('Directory path inside the workspace; defaults to the workspace root')
}).strict();

export const listDirectoryTool = defineTool({
  name: 'ListDirectory',
  description:
    'List files and directories inside the current workspace. Prefer this over Shell for exploring project structure.',
  inputSchema: listDirectoryInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      throwIfAborted(context.signal);
      const requestedPath = input.path?.trim() || '.';
      const targetPath = await resolveWorkspacePath(
        requestedPath,
        context.workspaceRoot,
        'read'
      );
      const directoryEntries = await readdir(targetPath, {
        withFileTypes: true
      });
      throwIfAborted(context.signal);

      const sortedEntries = [...directoryEntries].sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      const truncated = sortedEntries.length > MAX_LIST_DIRECTORY_ENTRIES;
      const visibleEntries = truncated
        ? sortedEntries.slice(0, MAX_LIST_DIRECTORY_ENTRIES)
        : sortedEntries;

      const formattedLines = visibleEntries.map(entry => {
        const kind = entry.isDirectory()
          ? 'dir'
          : entry.isSymbolicLink()
            ? 'link'
            : entry.isFile()
              ? 'file'
              : 'other';
        const displayPath = relative(
          context.workspaceRoot,
          join(targetPath, entry.name)
        );
        return `${kind.padEnd(4)} ${displayPath || entry.name}`;
      });

      const header = `Directory: ${relative(context.workspaceRoot, targetPath) || '.'}`;
      const body = formattedLines.length > 0
        ? formattedLines.join('\n')
        : '(empty directory)';
      const footer = truncated
        ? `\n\n[Truncated: showing ${MAX_LIST_DIRECTORY_ENTRIES} of ${sortedEntries.length} entries]`
        : '';

      return {
        content: `${header}\n${body}${footer}`,
        metadata: {
          entryCount: sortedEntries.length,
          shownCount: visibleEntries.length,
          truncated
        }
      };
    } catch (error) {
      return createToolError('ListDirectory', error);
    }
  }
});

const readInputSchema = z.object({
  path: pathSchema.describe('A path inside the current workspace')
}).strict();

export const readTool = defineTool({
  name: 'Read',
  description: 'Read a UTF-8 text file inside the current workspace.',
  inputSchema: readInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      throwIfAborted(context.signal);
      const targetPath = await resolveWorkspacePath(
        input.path,
        context.workspaceRoot,
        'read'
      );
      const content = await readFile(targetPath, {
        encoding: 'utf8',
        signal: context.signal
      });
      return { content };
    } catch (error) {
      return createToolError('Read', error);
    }
  }
});

const writeInputSchema = z.object({
  path: pathSchema.describe('A path inside the current workspace'),
  contents: z.string()
    .max(MAX_FILE_CONTENT_CHARACTERS, 'File contents are too large')
    .describe('The complete UTF-8 file contents')
}).strict();

export const writeTool = defineTool({
  name: 'Write',
  description: 'Create or replace a UTF-8 text file inside the current workspace.',
  inputSchema: writeInputSchema,
  risk: 'write',
  approval: 'always',
  async prepareApproval(input, context) {
    const targetPath = await resolveWorkspacePath(
      input.path,
      context.workspaceRoot,
      'write'
    );
    const currentContent = await readOptionalFile(targetPath, context.signal);
    const approvedChange = createApprovedFileChange(
      targetPath,
      currentContent,
      input.contents
    );

    return {
      description: `${currentContent === null ? 'Create' : 'Replace'} ${relative(context.workspaceRoot, targetPath)}`,
      preview: createFileDiff(input.path, currentContent, input.contents),
      executionData: approvedChange
    };
  },
  async execute(_input, context) {
    try {
      throwIfAborted(context.signal);
      const approvedChange = parseApprovedFileChange(context.approvalData);
      if (!approvedChange) {
        return {
          content: 'Write failed: approved file change metadata is missing',
          isError: true
        };
      }

      const verifiedTargetPath = await resolveWorkspacePath(
        approvedChange.targetPath,
        context.workspaceRoot,
        'write'
      );
      if (verifiedTargetPath !== approvedChange.targetPath) {
        return {
          content: 'Write failed: approved target path changed before execution',
          isError: true
        };
      }
      if (await hasFileChangedSinceApproval(approvedChange, context.signal)) {
        return {
          content: 'Write failed: the file changed after approval; review a new diff before retrying',
          isError: true
        };
      }

      throwIfAborted(context.signal);
      await writeFile(approvedChange.targetPath, approvedChange.proposedContent, {
        encoding: 'utf8',
        signal: context.signal
      });
      return {
        content: `Successfully wrote to ${relative(context.workspaceRoot, approvedChange.targetPath)}`
      };
    } catch (error) {
      return createToolError('Write', error);
    }
  }
});

const editInputSchema = z.object({
  path: pathSchema.describe('A path inside the current workspace'),
  old_string: z.string()
    .min(1, 'old_string cannot be empty')
    .max(MAX_FILE_CONTENT_CHARACTERS, 'old_string is too large')
    .describe('The exact text to replace; it must occur exactly once'),
  new_string: z.string()
    .max(MAX_FILE_CONTENT_CHARACTERS, 'new_string is too large')
    .describe('The replacement text')
}).strict();

export const editTool = defineTool({
  name: 'Edit',
  description: 'Replace one unique text occurrence in a workspace file.',
  inputSchema: editInputSchema,
  risk: 'write',
  approval: 'always',
  async prepareApproval(input, context) {
    const targetPath = await resolveWorkspacePath(
      input.path,
      context.workspaceRoot,
      'write'
    );
    const currentContent = await readOptionalFile(targetPath, context.signal);
    if (currentContent === null) {
      throw new Error(`Cannot edit a file that does not exist: ${input.path}`);
    }

    const occurrenceCount = countOccurrences(currentContent, input.old_string);
    if (occurrenceCount !== 1) {
      throw new Error(
        `old_string must occur exactly once in ${input.path}; found ${occurrenceCount} matches`
      );
    }

    const proposedContent = currentContent.replace(input.old_string, input.new_string);
    return {
      description: `Edit ${relative(context.workspaceRoot, targetPath)}`,
      preview: createFileDiff(input.path, currentContent, proposedContent),
      executionData: createApprovedFileChange(
        targetPath,
        currentContent,
        proposedContent
      )
    };
  },
  async execute(_input, context) {
    try {
      throwIfAborted(context.signal);
      const approvedChange = parseApprovedFileChange(context.approvalData);
      if (!approvedChange) {
        return {
          content: 'Edit failed: approved file change metadata is missing',
          isError: true
        };
      }

      const verifiedTargetPath = await resolveWorkspacePath(
        approvedChange.targetPath,
        context.workspaceRoot,
        'write'
      );
      if (verifiedTargetPath !== approvedChange.targetPath) {
        return {
          content: 'Edit failed: approved target path changed before execution',
          isError: true
        };
      }
      if (await hasFileChangedSinceApproval(approvedChange, context.signal)) {
        return {
          content: 'Edit failed: the file changed after approval; review a new diff before retrying',
          isError: true
        };
      }

      throwIfAborted(context.signal);
      await writeFile(approvedChange.targetPath, approvedChange.proposedContent, {
        encoding: 'utf8',
        signal: context.signal
      });
      return {
        content: `Successfully edited ${relative(context.workspaceRoot, approvedChange.targetPath)}`
      };
    } catch (error) {
      return createToolError('Edit', error);
    }
  }
});

export const allTools: ToolDefinition[] = [
  listDirectoryTool,
  readTool,
  editTool,
  writeTool,
  shellTool
];
