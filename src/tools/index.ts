import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../types.js';
import { diagnosticsTool, repoMapTool } from './analysis-tools.js';
import { isAbortError, OperationAbortedError, throwIfAborted } from './abort.js';
import {
  applyApprovedFileChange,
  createApprovedFileChange,
  createFileDiff,
  hashContent,
  parseApprovedFileChange,
  readOptionalFileSnapshot
} from './file-changes.js';
import { gitDiffTool, gitStatusTool } from './git-tools.js';
import { limitUtf8Head } from './output-limits.js';
import { patchTool } from './patch-tool.js';
import { readRangeTool } from './read-range.js';
import { defineTool } from './runtime.js';
import { globTool, grepTool } from './search-tools.js';
import { runShellCommand, type ShellRunResult } from './shell-runner.js';
import { resolveWorkspacePath } from './workspace.js';
import type { McpManager } from '../extensions/mcp-manager.js';
import { createMcpTools } from '../extensions/mcp-tools.js';

const MAX_PATH_CHARACTERS = 4_096;
const MAX_FILE_CONTENT_CHARACTERS = 2_000_000;
const MAX_FILE_CHANGE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 40 * 1024;
const MAX_SHELL_COMMAND_CHARACTERS = 20_000;
const MAX_SHELL_TIMEOUT_MS = 120_000;
const MAX_LIST_DIRECTORY_ENTRIES = 500;

function createToolError(action: string, error: unknown): ToolResult {
  if (isAbortError(error)) {
    throw error;
  }

  const reason = error instanceof Error ? error.message : String(error);
  const errorCode =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

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

const pathSchema = z
  .string()
  .trim()
  .min(1, 'Path cannot be empty')
  .max(MAX_PATH_CHARACTERS, 'Path is too long');

const shellInputSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1, 'Command cannot be empty')
      .max(MAX_SHELL_COMMAND_CHARACTERS, 'Command is too long')
      .describe('The shell command to execute'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(MAX_SHELL_TIMEOUT_MS)
      .optional()
      .describe('Optional timeout in milliseconds')
  })
  .strict();

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

const listDirectoryInputSchema = z
  .object({
    path: pathSchema
      .optional()
      .describe('Directory path inside the workspace; defaults to the workspace root')
  })
  .strict();

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
      const targetPath = await resolveWorkspacePath(requestedPath, context.workspaceRoot, 'read');
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

      const formattedLines = visibleEntries.map((entry) => {
        const kind = entry.isDirectory()
          ? 'dir'
          : entry.isSymbolicLink()
            ? 'link'
            : entry.isFile()
              ? 'file'
              : 'other';
        const displayPath = relative(context.workspaceRoot, join(targetPath, entry.name));
        return `${kind.padEnd(4)} ${displayPath || entry.name}`;
      });

      const header = `Directory: ${relative(context.workspaceRoot, targetPath) || '.'}`;
      const body = formattedLines.length > 0 ? formattedLines.join('\n') : '(empty directory)';
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

export const readTool = readRangeTool;

const writeInputSchema = z
  .object({
    path: pathSchema.describe('A path inside the current workspace'),
    contents: z
      .string()
      .max(MAX_FILE_CONTENT_CHARACTERS, 'File contents are too large')
      .describe('The complete UTF-8 file contents')
  })
  .strict();

export const writeTool = defineTool({
  name: 'Write',
  description: 'Create or replace a UTF-8 text file inside the current workspace.',
  inputSchema: writeInputSchema,
  risk: 'write',
  approval: 'always',
  async prepareApproval(input, context) {
    const targetPath = await resolveWorkspacePath(input.path, context.workspaceRoot, 'write');
    const currentFile = await readOptionalFileSnapshot(
      targetPath,
      MAX_FILE_CHANGE_BYTES,
      context.signal
    );
    const currentContent = currentFile?.content ?? null;
    const displayPath =
      relative(context.workspaceRoot, targetPath).replaceAll('\\', '/') || input.path;
    const limitedDiff = limitUtf8Head(
      createFileDiff(displayPath, currentContent, input.contents),
      MAX_DIFF_BYTES,
      '\n\n[Diff truncated]'
    );
    const approvedChange = {
      ...createApprovedFileChange(targetPath, currentFile, input.contents),
      displayPath,
      approvedDiff: limitedDiff.text,
      changeCount: 1
    };

    return {
      description: `${currentContent === null ? 'Create' : 'Replace'} ${displayPath}`,
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
          content: 'Write failed: approved file change metadata is missing',
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
            'Write failed: the file changed after approval; review a new diff before retrying',
          isError: true
        };
      }
      const newHash = hashContent(approvedChange.proposedContent);
      const displayPath =
        approvedChange.displayPath ??
        relative(context.workspaceRoot, approvedChange.targetPath).replaceAll('\\', '/');
      const limited = limitUtf8Head(
        [
          `Successfully wrote to ${displayPath}`,
          `Version: sha256:${newHash}`,
          '',
          approvedChange.approvedDiff ?? '(diff unavailable)'
        ].join('\n'),
        MAX_DIFF_BYTES
      );
      return {
        content: limited.text,
        metadata: {
          versionHash: newHash,
          changeCount: 1,
          diffTruncated: limited.truncated
        }
      };
    } catch (error) {
      return createToolError('Write', error);
    }
  }
});

const editInputSchema = z
  .object({
    path: pathSchema.describe('A path inside the current workspace'),
    old_string: z
      .string()
      .min(1, 'old_string cannot be empty')
      .max(MAX_FILE_CONTENT_CHARACTERS, 'old_string is too large')
      .describe('The exact text to replace; it must occur exactly once'),
    new_string: z
      .string()
      .max(MAX_FILE_CONTENT_CHARACTERS, 'new_string is too large')
      .describe('The replacement text'),
    expectedHash: z
      .string()
      .trim()
      .regex(
        /^(?:sha256:)?[a-fA-F0-9]{64}$/,
        'expectedHash must be a SHA-256 hash returned by Read'
      )
      .optional()
      .describe('Optional SHA-256 version returned by Read')
  })
  .strict();

export const editTool = defineTool({
  name: 'Edit',
  description: 'Replace one unique text occurrence in a workspace file.',
  inputSchema: editInputSchema,
  risk: 'write',
  approval: 'always',
  async prepareApproval(input, context) {
    const targetPath = await resolveWorkspacePath(input.path, context.workspaceRoot, 'write');
    const currentFile = await readOptionalFileSnapshot(
      targetPath,
      MAX_FILE_CHANGE_BYTES,
      context.signal
    );
    if (currentFile === null) {
      throw new Error(`Cannot edit a file that does not exist: ${input.path}`);
    }
    const currentContent = currentFile.content;
    if (
      input.expectedHash &&
      hashContent(currentContent) !== input.expectedHash.toLowerCase().replace(/^sha256:/, '')
    ) {
      throw new Error(
        `The file changed after it was read; read ${input.path} again before editing`
      );
    }

    const occurrenceCount = countOccurrences(currentContent, input.old_string);
    if (occurrenceCount !== 1) {
      throw new Error(
        `old_string must occur exactly once in ${input.path}; found ${occurrenceCount} matches`
      );
    }

    const proposedContent = currentContent.replace(input.old_string, input.new_string);
    const displayPath =
      relative(context.workspaceRoot, targetPath).replaceAll('\\', '/') || input.path;
    const limitedDiff = limitUtf8Head(
      createFileDiff(displayPath, currentContent, proposedContent),
      MAX_DIFF_BYTES,
      '\n\n[Diff truncated]'
    );
    return {
      description: `Edit ${displayPath}`,
      preview: limitedDiff.text,
      executionData: {
        ...createApprovedFileChange(targetPath, currentFile, proposedContent),
        displayPath,
        approvedDiff: limitedDiff.text,
        changeCount: 1
      }
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
            'Edit failed: the file changed after approval; review a new diff before retrying',
          isError: true
        };
      }

      const newHash = hashContent(approvedChange.proposedContent);
      const displayPath =
        approvedChange.displayPath ??
        relative(context.workspaceRoot, approvedChange.targetPath).replaceAll('\\', '/');
      const limited = limitUtf8Head(
        [
          `Successfully edited ${displayPath}`,
          `Version: sha256:${newHash}`,
          '',
          approvedChange.approvedDiff ?? '(diff unavailable)'
        ].join('\n'),
        MAX_DIFF_BYTES
      );
      return {
        content: limited.text,
        metadata: {
          versionHash: newHash,
          changeCount: 1,
          diffTruncated: limited.truncated
        }
      };
    } catch (error) {
      return createToolError('Edit', error);
    }
  }
});

const coreTools: ToolDefinition[] = [
  globTool,
  grepTool,
  repoMapTool,
  listDirectoryTool,
  readRangeTool,
  diagnosticsTool,
  patchTool,
  editTool,
  writeTool,
  gitStatusTool,
  gitDiffTool,
  shellTool
];

export interface ToolRuntimeServices {
  mcpManager?: McpManager;
  delegateTool?: ToolDefinition;
}

export function createToolSet(services: ToolRuntimeServices = {}): ToolDefinition[] {
  return [
    ...coreTools,
    ...(services.mcpManager ? createMcpTools(services.mcpManager) : []),
    ...(services.delegateTool ? [services.delegateTool] : [])
  ];
}

export const allTools: ToolDefinition[] = createToolSet();

export {
  diagnosticsTool,
  gitDiffTool,
  gitStatusTool,
  globTool,
  grepTool,
  patchTool,
  readRangeTool,
  repoMapTool
};
