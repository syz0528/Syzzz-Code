import { relative } from 'node:path';
import { z } from 'zod';
import type { ToolResult } from '../types.js';
import { throwIfAborted } from './abort.js';
import { runBoundedProcess } from './bounded-process.js';
import { limitUtf8Head } from './output-limits.js';
import { defineTool } from './runtime.js';
import { isSensitiveRelativePath, resolveWorkspacePath } from './workspace.js';

const MAX_PATH_CHARACTERS = 4_096;
const MAX_GIT_OUTPUT_BYTES = 40 * 1024;
const MAX_GIT_CAPTURE_BYTES = 5 * 1024 * 1024;
const MAX_DIFF_PATHS = 500;
const MAX_DIFF_PATH_ARGUMENT_CHARACTERS = 16_000;
const GIT_TIMEOUT_MS = 20_000;

function createGitError(action: string, error: unknown): ToolResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    content: `${action} failed: ${reason}`,
    isError: true,
    metadata: {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    }
  };
}

async function runGit(arguments_: readonly string[], workspaceRoot: string, signal: AbortSignal) {
  const result = await runBoundedProcess('git', arguments_, {
    cwd: workspaceRoot,
    signal,
    timeoutMs: GIT_TIMEOUT_MS,
    maxStdoutBytes: MAX_GIT_CAPTURE_BYTES,
    maxStderrBytes: MAX_GIT_OUTPUT_BYTES
  });
  if (result.timedOut) {
    throw new Error(`Git operation exceeded the ${GIT_TIMEOUT_MS} ms timeout`);
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString('utf8').trim();
    throw new Error(stderr || `git exited with code ${result.exitCode ?? 'unknown'}`);
  }
  return result;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function statusLinePaths(line: string): string[] {
  const pathText = line.slice(3).trim();
  return pathText.includes(' -> ')
    ? pathText.split(' -> ').map((path) => path.replace(/^"|"$/g, ''))
    : [pathText.replace(/^"|"$/g, '')];
}

function isSafeStatusLine(line: string): boolean {
  return statusLinePaths(line).every(
    (path) => path.length > 0 && !isSensitiveRelativePath(normalizeRelativePath(path))
  );
}

async function resolveGitPath(
  inputPath: string | undefined,
  workspaceRoot: string
): Promise<string> {
  if (!inputPath) {
    return '.';
  }
  const targetPath = await resolveWorkspacePath(inputPath, workspaceRoot, 'read');
  return normalizeRelativePath(relative(workspaceRoot, targetPath)) || '.';
}

const optionalGitPathSchema = z
  .string()
  .trim()
  .min(1, 'Path cannot be empty')
  .max(MAX_PATH_CHARACTERS, 'Path is too long')
  .optional()
  .describe('Optional file or directory inside the workspace');

const gitStatusInputSchema = z
  .object({
    path: optionalGitPathSchema
  })
  .strict();

export const gitStatusTool = defineTool({
  name: 'GitStatus',
  description:
    'Inspect bounded Git working-tree status without executing hooks or arbitrary Git commands.',
  inputSchema: gitStatusInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      throwIfAborted(context.signal);
      const path = await resolveGitPath(input.path, context.workspaceRoot);
      const result = await runGit(
        ['-c', 'core.quotepath=false', 'status', '--short', '--untracked-files=normal', '--', path],
        context.workspaceRoot,
        context.signal
      );
      const lines = result.stdout
        .toString('utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .filter(isSafeStatusLine);
      const body =
        lines.length > 0 ? lines.join('\n') : 'Working tree is clean for the selected path.';
      const limited = limitUtf8Head(`Git status:\n${body}`, MAX_GIT_OUTPUT_BYTES);
      return {
        content: limited.text,
        metadata: {
          entryCount: lines.length,
          truncated: result.stdoutTruncated || limited.truncated,
          durationMs: result.durationMs
        }
      };
    } catch (error) {
      return createGitError('GitStatus', error);
    }
  }
});
const gitDiffInputSchema = z
  .object({
    scope: z
      .enum(['unstaged', 'staged'])
      .optional()
      .describe('Diff unstaged or staged changes; defaults to unstaged'),
    path: optionalGitPathSchema
  })
  .strict();

function boundedSafePaths(paths: readonly string[]): {
  paths: string[];
  truncated: boolean;
} {
  const selected: string[] = [];
  let argumentCharacters = 0;
  for (const rawPath of paths) {
    const path = normalizeRelativePath(rawPath);
    if (!path || isSensitiveRelativePath(path)) {
      continue;
    }
    if (
      selected.length >= MAX_DIFF_PATHS ||
      argumentCharacters + path.length > MAX_DIFF_PATH_ARGUMENT_CHARACTERS
    ) {
      return { paths: selected, truncated: true };
    }
    selected.push(path);
    argumentCharacters += path.length;
  }
  return { paths: selected, truncated: false };
}

export const gitDiffTool = defineTool({
  name: 'GitDiff',
  description:
    'Inspect a bounded unstaged or staged workspace diff with external diff and text conversion disabled.',
  inputSchema: gitDiffInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      throwIfAborted(context.signal);
      const path = await resolveGitPath(input.path, context.workspaceRoot);
      const staged = input.scope === 'staged';
      const commonArguments = [
        '-c',
        'core.quotepath=false',
        'diff',
        '--no-ext-diff',
        '--no-textconv'
      ];
      if (staged) {
        commonArguments.push('--cached');
      }

      const namesResult = await runGit(
        [...commonArguments, '--name-only', '-z', '--', path],
        context.workspaceRoot,
        context.signal
      );
      const rawPaths = namesResult.stdout.toString('utf8').split('\0').filter(Boolean);
      const selected = boundedSafePaths(rawPaths);
      if (selected.paths.length === 0) {
        return {
          content: `No ${staged ? 'staged' : 'unstaged'} non-sensitive changes.`,
          metadata: {
            fileCount: 0,
            truncated: namesResult.stdoutTruncated || selected.truncated,
            durationMs: namesResult.durationMs
          }
        };
      }

      const diffResult = await runGit(
        [...commonArguments, '--unified=3', '--', ...selected.paths],
        context.workspaceRoot,
        context.signal
      );
      const diff = diffResult.stdout.toString('utf8');
      const limited = limitUtf8Head(
        diff || '(Git reported changed paths but produced no textual diff.)',
        MAX_GIT_OUTPUT_BYTES,
        '\n\n[Diff truncated]'
      );
      return {
        content: limited.text,
        metadata: {
          scope: staged ? 'staged' : 'unstaged',
          fileCount: selected.paths.length,
          truncated:
            namesResult.stdoutTruncated ||
            diffResult.stdoutTruncated ||
            selected.truncated ||
            limited.truncated,
          durationMs: namesResult.durationMs + diffResult.durationMs
        }
      };
    } catch (error) {
      return createGitError('GitDiff', error);
    }
  }
});
