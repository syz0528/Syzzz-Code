import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type WorkspaceAccess = 'read' | 'write';

export class WorkspacePathError extends Error {
  constructor(
    message: string,
    readonly code: 'OUTSIDE_WORKSPACE' | 'SENSITIVE_PATH' | 'INVALID_PATH'
  ) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);

export function validateWorkspacePathSyntax(
  inputPath: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (inputPath.includes('\0')) {
    throw new WorkspacePathError('File path cannot contain a null byte', 'INVALID_PATH');
  }

  if (platform !== 'win32') {
    return;
  }

  const windowsPath = inputPath.replace(/\//g, '\\');
  if (windowsPath.startsWith('\\\\?\\') || windowsPath.startsWith('\\\\.\\')) {
    throw new WorkspacePathError(
      `Windows device paths are not allowed: ${inputPath}`,
      'INVALID_PATH'
    );
  }

  const withoutDrive = /^[a-z]:/i.test(windowsPath) ? windowsPath.slice(2) : windowsPath;
  if (withoutDrive.includes(':')) {
    throw new WorkspacePathError(
      `Windows alternate data streams are not allowed: ${inputPath}`,
      'INVALID_PATH'
    );
  }

  for (const segment of withoutDrive.split('\\').filter(Boolean)) {
    if (segment === '.' || segment === '..') {
      continue;
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new WorkspacePathError(
        `Windows paths cannot contain trailing dots or spaces: ${inputPath}`,
        'INVALID_PATH'
      );
    }

    const baseName = segment.split('.', 1)[0].toLowerCase();
    if (WINDOWS_RESERVED_DEVICE_NAMES.has(baseName)) {
      throw new WorkspacePathError(
        `Windows reserved device names are not allowed: ${inputPath}`,
        'INVALID_PATH'
      );
    }
  }
}

function isWithinDirectory(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function findNearestExistingAncestor(candidatePath: string): Promise<string> {
  let currentPath = candidatePath;

  while (true) {
    try {
      await lstat(currentPath);
      return currentPath;
    } catch (error) {
      const errorCode =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      if (errorCode !== 'ENOENT') {
        throw error;
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      throw new WorkspacePathError(
        `No existing parent directory was found for ${candidatePath}`,
        'INVALID_PATH'
      );
    }
    currentPath = parentPath;
  }
}

function isProjectMemoryStoragePath(path: string): boolean {
  const segments = path.split(/[\\/]+/u).map((segment) => segment.toLowerCase());
  return segments.some(
    (segment, index) => segment === '.syzzz-code' && segments[index + 1] === 'memory'
  );
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const pathSegments = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  if (
    pathSegments.some((segment) => segment === '.git' || segment === '.ssh') ||
    isProjectMemoryStoragePath(relativePath)
  ) {
    return true;
  }

  const fileName = basename(relativePath).toLowerCase();
  if (fileName === '.env.example') {
    return false;
  }

  return (
    fileName === '.env' ||
    fileName.startsWith('.env.') ||
    fileName === '.npmrc' ||
    fileName === '.pypirc' ||
    fileName === 'credentials' ||
    fileName === 'credentials.json' ||
    fileName === 'id_rsa' ||
    fileName === 'id_ed25519' ||
    fileName.endsWith('.pem') ||
    fileName.endsWith('.key')
  );
}

export async function resolveWorkspacePath(
  inputPath: string,
  workspaceRoot: string,
  access: WorkspaceAccess
): Promise<string> {
  if (!inputPath.trim()) {
    throw new WorkspacePathError('File path cannot be empty', 'INVALID_PATH');
  }

  validateWorkspacePathSyntax(inputPath);

  const lexicalWorkspaceRoot = resolve(workspaceRoot);
  const realWorkspaceRoot = await realpath(lexicalWorkspaceRoot);
  const candidatePath = resolve(lexicalWorkspaceRoot, inputPath);
  const lexicallyWithinWorkspace =
    isWithinDirectory(lexicalWorkspaceRoot, candidatePath) ||
    isWithinDirectory(realWorkspaceRoot, candidatePath);
  const relativePath = relative(lexicalWorkspaceRoot, candidatePath);
  if (lexicallyWithinWorkspace && isSensitiveRelativePath(relativePath)) {
    throw new WorkspacePathError(
      `Access to sensitive path is blocked: ${inputPath}`,
      'SENSITIVE_PATH'
    );
  }

  const existingAncestor = await findNearestExistingAncestor(candidatePath);
  const resolvedAncestor = await realpath(existingAncestor);
  const unresolvedSuffix = relative(existingAncestor, candidatePath);
  const resolvedSecurityTarget = resolve(resolvedAncestor, unresolvedSuffix);

  if (!isWithinDirectory(realWorkspaceRoot, resolvedSecurityTarget)) {
    throw new WorkspacePathError(
      lexicallyWithinWorkspace
        ? `Path escapes the workspace through a symbolic link or junction: ${inputPath}`
        : `Path is outside the workspace: ${inputPath}`,
      'OUTSIDE_WORKSPACE'
    );
  }

  const resolvedRelativePath = relative(realWorkspaceRoot, resolvedSecurityTarget);
  if (
    isSensitiveRelativePath(resolvedRelativePath) ||
    isProjectMemoryStoragePath(resolvedSecurityTarget)
  ) {
    throw new WorkspacePathError(
      `Access to sensitive path through a symbolic link or junction is blocked: ${inputPath}`,
      'SENSITIVE_PATH'
    );
  }

  if (access === 'read') {
    await realpath(candidatePath);
  }

  return candidatePath;
}
