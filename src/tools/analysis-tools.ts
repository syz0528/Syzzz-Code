import { stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolResult } from '../types.js';
import { isAbortError, throwIfAborted } from './abort.js';
import {
  runAnalysisWorker,
  type DiagnosticEntry,
  type RepoMapFile
} from './analysis-worker-client.js';
import { runBoundedProcess } from './bounded-process.js';
import { limitUtf8Head } from './output-limits.js';
import { defineTool } from './runtime.js';
import { listWorkspaceFiles } from './search-tools.js';
import {
  isSensitiveRelativePath,
  resolveWorkspacePath
} from './workspace.js';

const MAX_PATH_CHARACTERS = 4_096;
const MAX_QUERY_CHARACTERS = 2_000;
const DEFAULT_REPO_MAP_FILES = 50;
const MAX_REPO_MAP_FILES = 100;
const DEFAULT_DIAGNOSTICS = 100;
const MAX_DIAGNOSTICS = 200;
const MAX_ANALYSIS_CANDIDATES = 10_000;
const MAX_OUTPUT_BYTES = 40 * 1024;
const GIT_STATUS_TIMEOUT_MS = 10_000;
const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]);

const pathSchema = z.string()
  .trim()
  .min(1, 'Path cannot be empty')
  .max(MAX_PATH_CHARACTERS, 'Path is too long');

function createAnalysisError(action: string, error: unknown): ToolResult {
  if (isAbortError(error)) {
    throw error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return {
    content: `${action} failed: ${reason}`,
    isError: true,
    metadata: {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    }
  };
}

async function modifiedWorkspacePaths(
  workspaceRoot: string,
  signal: AbortSignal
): Promise<string[]> {
  try {
    const result = await runBoundedProcess('git', [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all'
    ], {
      cwd: workspaceRoot,
      signal,
      timeoutMs: GIT_STATUS_TIMEOUT_MS,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 16 * 1024
    });
    if (result.exitCode !== 0 || result.timedOut) {
      return [];
    }
    const entries = result.stdout.toString('utf8').split('\0');
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.length < 4) {
        continue;
      }
      const statusCode = entry.slice(0, 2);
      const path = entry.slice(3).replaceAll('\\', '/');
      if (!isSensitiveRelativePath(path)) {
        paths.push(path);
      }
      if (/[RC]/.test(statusCode)) {
        index += 1;
      }
    }
    return paths;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return [];
  }
}

function formatRepoMapFile(file: RepoMapFile): string {
  const heading = `${file.modified ? '[modified] ' : ''}${file.path} (score ${file.score})`;
  const lines = [heading];
  if (file.imports.length > 0) {
    lines.push(`  imports: ${file.imports.join(', ')}`);
  }
  if (file.importedBy.length > 0) {
    lines.push(`  imported by: ${file.importedBy.join(', ')}`);
  }
  if (file.symbols.length > 0) {
    lines.push('  symbols:');
    lines.push(...file.symbols.map(symbol => `    - ${symbol}`));
  }
  return lines.join('\n');
}

const repoMapInputSchema = z.object({
  path: pathSchema
    .optional()
    .describe(
      'Directory or TypeScript/JavaScript file inside the workspace; defaults to the workspace root'
    ),
  query: z.string()
    .trim()
    .max(MAX_QUERY_CHARACTERS, 'Query is too long')
    .optional()
    .describe('Optional symbol, file, or architectural topic used for ranking'),
  maxFiles: z.number()
    .int()
    .min(1)
    .max(MAX_REPO_MAP_FILES)
    .optional()
    .describe(`Maximum mapped files; defaults to ${DEFAULT_REPO_MAP_FILES}`)
}).strict();

interface RepoMapScope {
  searchPath: string;
  focusPath?: string;
}

async function resolveRepoMapScope(
  workspaceRoot: string,
  requestedPath: string
): Promise<RepoMapScope> {
  const resolvedPath = await resolveWorkspacePath(
    requestedPath,
    workspaceRoot,
    'read'
  );
  const pathStats = await stat(resolvedPath);
  if (pathStats.isDirectory()) {
    return {
      searchPath: relative(workspaceRoot, resolvedPath).replaceAll('\\', '/') || '.'
    };
  }
  if (!pathStats.isFile()) {
    throw new Error(`RepoMap path must be a directory or source file: ${requestedPath}`);
  }
  if (!SOURCE_EXTENSIONS.has(extname(resolvedPath).toLowerCase())) {
    throw new Error(`RepoMap file must be TypeScript or JavaScript: ${requestedPath}`);
  }

  return {
    searchPath:
      relative(workspaceRoot, dirname(resolvedPath)).replaceAll('\\', '/') || '.',
    focusPath: relative(workspaceRoot, resolvedPath).replaceAll('\\', '/')
  };
}

export const repoMapTool = defineTool({
  name: 'RepoMap',
  description:
    'Build an on-demand TypeScript/JavaScript import and top-level symbol map without creating a disk index.',
  inputSchema: repoMapInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      throwIfAborted(context.signal);
      const scope = await resolveRepoMapScope(
        context.workspaceRoot,
        input.path?.trim() || '.'
      );
      const filesResult = await listWorkspaceFiles(
        context.workspaceRoot,
        scope.searchPath,
        SOURCE_GLOB,
        context.signal
      );
      if (scope.focusPath && !filesResult.paths.includes(scope.focusPath)) {
        throw new Error(
          `RepoMap file is ignored or excluded from analysis: ${input.path}`
        );
      }
      const candidateTruncated =
        filesResult.sourceTruncated ||
        filesResult.paths.length > MAX_ANALYSIS_CANDIDATES;
      const orderedPaths = scope.focusPath
        ? [
          scope.focusPath,
          ...filesResult.paths.filter(path => path !== scope.focusPath)
        ]
        : filesResult.paths;
      const files = orderedPaths.slice(0, MAX_ANALYSIS_CANDIDATES);
      const modifiedPaths = await modifiedWorkspacePaths(
        context.workspaceRoot,
        context.signal
      );
      const result = await runAnalysisWorker({
        operation: 'repo-map',
        workspaceRoot: context.workspaceRoot,
        files,
        query: input.query,
        focusPath: scope.focusPath,
        modifiedPaths,
        maxFiles: input.maxFiles ?? DEFAULT_REPO_MAP_FILES
      }, context.signal);
      throwIfAborted(context.signal);

      const body = result.files.length > 0
        ? result.files.map(formatRepoMapFile).join('\n\n')
        : '(no TypeScript or JavaScript source files found)';
      const limited = limitUtf8Head([
        'RepoMap',
        `Candidates: ${candidateTruncated ? 'at least ' : ''}${result.candidateCount}`,
        `Selected: ${result.files.length}`,
        `Cache hits: ${result.cacheHits}`,
        '',
        body
      ].join('\n'), MAX_OUTPUT_BYTES);
      return {
        content: limited.text,
        metadata: {
          candidateCount: result.candidateCount,
          selectedCount: result.files.length,
          cacheHits: result.cacheHits,
          parseErrors: result.parseErrors,
          truncated: candidateTruncated || limited.truncated
        }
      };
    } catch (error) {
      return createAnalysisError('RepoMap', error);
    }
  }
});

function formatDiagnostic(diagnostic: DiagnosticEntry): string {
  const location = diagnostic.path
    ? `${diagnostic.path}` +
      `${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}` +
      `${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`
    : '(project)';
  return `${location} - TS${diagnostic.code} ${diagnostic.category}: ` +
    diagnostic.message.replace(/\s+/g, ' ').trim();
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path)).isFile();
}

async function findDiagnosticsInputs(
  workspaceRoot: string,
  requestedPath: string,
  signal: AbortSignal
): Promise<{
  files: string[];
  configPath?: string;
  reportFiles?: string[];
  candidateTruncated: boolean;
}> {
  const listConfigSources = async (configPath: string) => {
    const configDirectory = dirname(
      await resolveWorkspacePath(configPath, workspaceRoot, 'read')
    );
    const directoryPath = relative(workspaceRoot, configDirectory)
      .replaceAll('\\', '/') || '.';
    const listed = await listWorkspaceFiles(
      workspaceRoot,
      directoryPath,
      SOURCE_GLOB,
      signal
    );
    return {
      files: listed.paths.slice(0, MAX_ANALYSIS_CANDIDATES),
      configPath,
      candidateTruncated:
        listed.sourceTruncated ||
        listed.paths.length > MAX_ANALYSIS_CANDIDATES
    };
  };
  const findNearestConfig = async (
    startDirectory: string
  ): Promise<string | undefined> => {
    const root = resolve(workspaceRoot);
    let directory = resolve(startDirectory);
    while (true) {
      throwIfAborted(signal);
      const candidate = join(directory, 'tsconfig.json');
      try {
        const relativeCandidate = relative(root, candidate).replaceAll('\\', '/');
        const resolvedCandidate = await resolveWorkspacePath(
          relativeCandidate,
          workspaceRoot,
          'read'
        );
        if (await isFile(resolvedCandidate)) {
          return relativeCandidate;
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
      }
      if (directory === root) {
        return undefined;
      }
      const parent = dirname(directory);
      if (parent === directory || relative(root, parent).startsWith('..')) {
        return undefined;
      }
      directory = parent;
    }
  };

  const target = await resolveWorkspacePath(requestedPath, workspaceRoot, 'read');
  const targetStats = await stat(target);
  if (targetStats.isFile()) {
    const relativePath = relative(workspaceRoot, target).replaceAll('\\', '/');
    if (relativePath.endsWith('tsconfig.json')) {
      return listConfigSources(relativePath);
    }
    if (!SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
      throw new Error('Diagnostics path must be a source file, directory, or tsconfig.json');
    }
    const nearestConfig = await findNearestConfig(dirname(target));
    if (nearestConfig) {
      return {
        ...await listConfigSources(nearestConfig),
        reportFiles: [relativePath]
      };
    }
    return {
      files: [relativePath],
      reportFiles: [relativePath],
      candidateTruncated: false
    };
  }
  if (!targetStats.isDirectory()) {
    throw new Error('Diagnostics path must be a regular file or directory');
  }

  const relativeDirectory = relative(workspaceRoot, target)
    .replaceAll('\\', '/') || '.';
  const listed = await listWorkspaceFiles(
    workspaceRoot,
    relativeDirectory,
    SOURCE_GLOB,
    signal
  );
  const potentialConfig = relativeDirectory === '.'
    ? 'tsconfig.json'
    : `${relativeDirectory}/tsconfig.json`;
  let configPath: string | undefined;
  try {
    const resolvedConfig = await resolveWorkspacePath(
      potentialConfig,
      workspaceRoot,
      'read'
    );
    if (await isFile(resolvedConfig)) {
      configPath = potentialConfig;
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    configPath = undefined;
  }
  return {
    files: listed.paths.slice(0, MAX_ANALYSIS_CANDIDATES),
    ...(configPath ? { configPath } : {}),
    candidateTruncated:
      listed.sourceTruncated ||
      listed.paths.length > MAX_ANALYSIS_CANDIDATES
  };
}

const diagnosticsInputSchema = z.object({
  path: pathSchema
    .optional()
    .describe('Source file, directory, or tsconfig.json inside the workspace'),
  limit: z.number()
    .int()
    .min(1)
    .max(MAX_DIAGNOSTICS)
    .optional()
    .describe(`Maximum diagnostics; defaults to ${DEFAULT_DIAGNOSTICS}`)
}).strict();

export const diagnosticsTool = defineTool({
  name: 'Diagnostics',
  description:
    'Run bounded TypeScript Compiler API noEmit diagnostics without executing project scripts, plugins, lint, or builds.',
  inputSchema: diagnosticsInputSchema,
  risk: 'read',
  approval: 'never',
  async execute(input, context) {
    try {
      throwIfAborted(context.signal);
      const analysisInput = await findDiagnosticsInputs(
        context.workspaceRoot,
        input.path?.trim() || '.',
        context.signal
      );
      const result = await runAnalysisWorker({
        operation: 'diagnostics',
        workspaceRoot: context.workspaceRoot,
        files: analysisInput.files,
        configPath: analysisInput.configPath,
        reportFiles: analysisInput.reportFiles,
        limit: input.limit ?? DEFAULT_DIAGNOSTICS
      }, context.signal);
      throwIfAborted(context.signal);

      const body = result.diagnostics.length > 0
        ? result.diagnostics.map(formatDiagnostic).join('\n')
        : 'No TypeScript or JavaScript diagnostics.';
      const limited = limitUtf8Head([
        'Diagnostics',
        `Files: ${result.fileCount}`,
        `Configuration: ${result.configPath ?? '(compiler defaults)'}`,
        `Total: ${result.total}`,
        '',
        body
      ].join('\n'), MAX_OUTPUT_BYTES);
      return {
        content: limited.text,
        metadata: {
          fileCount: result.fileCount,
          diagnosticCount: result.total,
          shownCount: result.diagnostics.length,
          configPath: result.configPath,
          truncated:
            result.truncated ||
            analysisInput.candidateTruncated ||
            limited.truncated
        }
      };
    } catch (error) {
      return createAnalysisError('Diagnostics', error);
    }
  }
});
