import { lstat, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path';

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

function isWithinDirectory(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function findNearestExistingAncestor(candidatePath: string): Promise<string> {
  let currentPath = candidatePath;

  while (true) {
    try {
      await lstat(currentPath);
      return currentPath;
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : undefined;
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

function isSensitiveRelativePath(relativePath: string): boolean {
  const pathSegments = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(segment => segment.toLowerCase());

  if (pathSegments.some(segment => segment === '.git' || segment === '.ssh')) {
    return true;
  }

  const fileName = basename(relativePath).toLowerCase();
  if (fileName === '.env.example') {
    return false;
  }

  return fileName === '.env' ||
    fileName.startsWith('.env.') ||
    fileName === '.npmrc' ||
    fileName === '.pypirc' ||
    fileName === 'credentials' ||
    fileName === 'credentials.json' ||
    fileName === 'id_rsa' ||
    fileName === 'id_ed25519' ||
    fileName.endsWith('.pem') ||
    fileName.endsWith('.key');
}

export async function resolveWorkspacePath(
  inputPath: string,
  workspaceRoot: string,
  access: WorkspaceAccess
): Promise<string> {
  if (!inputPath.trim()) {
    throw new WorkspacePathError('File path cannot be empty', 'INVALID_PATH');
  }

  const realWorkspaceRoot = await realpath(resolve(workspaceRoot));
  const candidatePath = resolve(realWorkspaceRoot, inputPath);

  if (!isWithinDirectory(realWorkspaceRoot, candidatePath)) {
    throw new WorkspacePathError(
      `Path is outside the workspace: ${inputPath}`,
      'OUTSIDE_WORKSPACE'
    );
  }

  const relativePath = relative(realWorkspaceRoot, candidatePath);
  if (isSensitiveRelativePath(relativePath)) {
    throw new WorkspacePathError(
      `Access to sensitive path is blocked: ${inputPath}`,
      'SENSITIVE_PATH'
    );
  }

  let resolvedSecurityTarget: string;
  try {
    resolvedSecurityTarget = await realpath(candidatePath);
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : undefined;
    if (errorCode !== 'ENOENT' || access === 'read') {
      throw error;
    }

    const existingAncestor = await findNearestExistingAncestor(candidatePath);
    resolvedSecurityTarget = await realpath(existingAncestor);
  }

  if (!isWithinDirectory(realWorkspaceRoot, resolvedSecurityTarget)) {
    throw new WorkspacePathError(
      `Path escapes the workspace through a symbolic link or junction: ${inputPath}`,
      'OUTSIDE_WORKSPACE'
    );
  }

  const resolvedRelativePath = relative(realWorkspaceRoot, resolvedSecurityTarget);
  if (isSensitiveRelativePath(resolvedRelativePath)) {
    throw new WorkspacePathError(
      `Access to sensitive path through a symbolic link or junction is blocked: ${inputPath}`,
      'SENSITIVE_PATH'
    );
  }

  return candidatePath;
}
