import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { throwIfAborted } from '../tools/abort.js';
import { runBoundedProcess } from '../tools/bounded-process.js';
import { parseSkillDocument } from './runtime.js';
import type { SkillInstallRecordV1 } from './types.js';

const MAX_REPOSITORY_FILES = 500;
const MAX_REPOSITORY_BYTES = 20 * 1024 * 1024;
const MAX_REPOSITORY_FILE_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_BYTES = 64 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface SkillInstallPreview {
  action: 'install' | 'update' | 'rollback' | 'remove';
  name: string;
  sourceUrl?: string;
  previousCommit?: string;
  resolvedCommit?: string;
  targetPath: string;
  files: string[];
  fileCount: number;
  totalBytes: number;
  scriptCount: number;
}

export interface SkillInstallOptions {
  ref?: string;
  skill?: string;
  scope?: 'user' | 'project';
  signal: AbortSignal;
  confirm?: (preview: SkillInstallPreview) => boolean | Promise<boolean>;
}

export interface SkillManagementOptions {
  scope?: 'user' | 'project';
  signal: AbortSignal;
  confirm?: (preview: SkillInstallPreview) => boolean | Promise<boolean>;
}

interface RollbackRecord {
  record: SkillInstallRecordV1;
  path: string;
}

interface ManagedSkillRecord extends SkillInstallRecordV1 {
  targetPath: string;
  rollback?: RollbackRecord;
}

interface SkillInstallStoreV1 {
  schemaVersion: 1;
  installs: Record<string, ManagedSkillRecord>;
}

interface FileTreeInspection {
  files: string[];
  totalBytes: number;
  scriptCount: number;
}

interface PreparedSkill {
  name: string;
  repositoryPath: string;
  selectedRoot: string;
  sourceSkillPath: string;
  resolvedCommit: string;
  inspection: FileTreeInspection;
  cleanup(): Promise<void>;
}

function publicInstallRecord(record: ManagedSkillRecord): SkillInstallRecordV1 {
  return {
    schemaVersion: 1,
    name: record.name,
    sourceUrl: record.sourceUrl,
    ...(record.requestedRef ? { requestedRef: record.requestedRef } : {}),
    resolvedCommit: record.resolvedCommit,
    sourceSkillPath: record.sourceSkillPath,
    scope: record.scope,
    installedAt: record.installedAt,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes
  };
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith('/'))
  );
}

function portablePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateInstallRecordValue(
  value: unknown,
  expectedName: string,
  expectedScope: 'user' | 'project'
): asserts value is SkillInstallRecordV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.name !== expectedName ||
    !SKILL_NAME_PATTERN.test(expectedName) ||
    value.scope !== expectedScope ||
    typeof value.sourceUrl !== 'string' ||
    typeof value.resolvedCommit !== 'string' ||
    !FULL_COMMIT_PATTERN.test(value.resolvedCommit) ||
    typeof value.sourceSkillPath !== 'string' ||
    typeof value.installedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.installedAt)) ||
    typeof value.fileCount !== 'number' ||
    !Number.isInteger(value.fileCount) ||
    value.fileCount < 1 ||
    value.fileCount > MAX_REPOSITORY_FILES ||
    typeof value.totalBytes !== 'number' ||
    !Number.isInteger(value.totalBytes) ||
    value.totalBytes < 0 ||
    value.totalBytes > MAX_REPOSITORY_BYTES
  ) {
    throw new Error(`Skill install lock record is invalid: ${expectedName}`);
  }
  validateSkillSourceUrl(value.sourceUrl);
  if (value.requestedRef !== undefined) {
    if (typeof value.requestedRef !== 'string') {
      throw new Error(`Skill install lock record is invalid: ${expectedName}`);
    }
    validateRef(value.requestedRef);
  }
  const supportedSourcePaths = new Set([
    '.',
    `skills/${expectedName}`,
    `.agents/skills/${expectedName}`
  ]);
  if (!supportedSourcePaths.has(portablePath(value.sourceSkillPath))) {
    throw new Error(`Skill install lock record has an unsafe source path: ${expectedName}`);
  }
}

export function validateSkillSourceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Skill source must be a valid public HTTPS Git URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only public HTTPS Git URLs are supported');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Skill URLs must not contain credentials');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('localhost Skill sources are not allowed');
  }
  const addressType = isIP(hostname);
  if (addressType === 4 && isPrivateIpv4(hostname)) {
    throw new Error('Private IPv4 Skill sources are not allowed');
  }
  if (addressType === 6 && isPrivateIpv6(hostname)) {
    throw new Error('Private IPv6 Skill sources are not allowed');
  }
  return parsed.toString();
}

function isPrivateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

function validateRef(value: string | undefined): string {
  const ref = value?.trim() || 'HEAD';
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(ref) ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.endsWith('.') ||
    ref.endsWith('/')
  ) {
    throw new Error('Git ref contains unsafe characters');
  }
  return ref;
}

function sanitizedGitEnvironment(homePath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const blocked = /(?:api[_-]?key|token|secret|password|credential)/i;
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !blocked.test(name)) {
      environment[name] = value;
    }
  }
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    ...environment,
    HOME: homePath,
    USERPROFILE: homePath,
    GIT_CONFIG_GLOBAL: nullConfig,
    GIT_CONFIG_SYSTEM: nullConfig,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: ''
  };
}

async function runGit(
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  command: { executable: string; argumentsPrefix: readonly string[] }
): Promise<string> {
  const nullHooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = await runBoundedProcess(
    command.executable,
    [
      ...command.argumentsPrefix,
      '-c',
      `core.hooksPath=${nullHooks}`,
      '-c',
      'credential.helper=',
      '-c',
      'submodule.recurse=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'protocol.file.allow=never',
      '-c',
      'http.followRedirects=false',
      ...arguments_
    ],
    {
      cwd,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxStdoutBytes: GIT_OUTPUT_BYTES,
      maxStderrBytes: GIT_OUTPUT_BYTES,
      env: environment
    }
  );
  if (result.timedOut) {
    throw new Error('Git operation timed out');
  }
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error('Git output exceeded the safety limit');
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString('utf8').trim() ||
        `Git exited with code ${result.exitCode ?? 'unknown'}`
    );
  }
  return result.stdout.toString('utf8').trim();
}

async function inspectTree(rootPath: string): Promise<FileTreeInspection> {
  const root = resolve(rootPath);
  const files: string[] = [];
  let totalBytes = 0;
  let scriptCount = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git' && current === root) {
        continue;
      }
      const path = join(current, entry.name);
      const relativePath = portablePath(relative(root, path));
      if (!isWithin(root, path) || relativePath.split('/').includes('..')) {
        throw new Error('Skill repository contains path traversal');
      }
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`Skill repository contains a symbolic link: ${relativePath}`);
      }
      if (info.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(`Skill repository contains a non-regular file: ${relativePath}`);
      }
      if (info.nlink > 1) {
        throw new Error(`Skill repository contains a hardlink: ${relativePath}`);
      }
      if (info.size > MAX_REPOSITORY_FILE_BYTES) {
        throw new Error(`Skill file exceeds 5 MiB: ${relativePath}`);
      }
      files.push(relativePath);
      totalBytes += info.size;
      if (
        /(?:^|\/)scripts?(?:\/|$)/i.test(relativePath) ||
        /\.(?:sh|bash|cmd|bat|ps1|py|js|mjs|cjs|ts)$/i.test(relativePath)
      ) {
        scriptCount += 1;
      }
      if (files.length > MAX_REPOSITORY_FILES) {
        throw new Error('Skill repository exceeds 500 files');
      }
      if (totalBytes > MAX_REPOSITORY_BYTES) {
        throw new Error('Skill repository exceeds 20 MiB');
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return { files, totalBytes, scriptCount };
}

async function discoverSkillRoots(repositoryPath: string): Promise<
  Array<{
    name: string;
    root: string;
    sourcePath: string;
  }>
> {
  const roots: Array<{ name: string; root: string; sourcePath: string }> = [];
  const candidates = [
    { root: repositoryPath, expectedName: undefined as string | undefined },
    ...(await childDirectories(join(repositoryPath, 'skills'))).map((root) => ({
      root,
      expectedName: basename(root)
    })),
    ...(await childDirectories(join(repositoryPath, '.agents', 'skills'))).map((root) => ({
      root,
      expectedName: basename(root)
    }))
  ];
  for (const candidate of candidates) {
    const skillFile = join(candidate.root, 'SKILL.md');
    try {
      const info = await lstat(skillFile);
      if (!info.isFile() || info.isSymbolicLink()) {
        continue;
      }
      const bytes = await readFile(skillFile);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed = parseSkillDocument(content, candidate.expectedName);
      roots.push({
        name: parsed.name,
        root: candidate.root,
        sourcePath: portablePath(relative(repositoryPath, candidate.root)) || '.'
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return roots;
}

async function childDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(path, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readStore(path: string): Promise<SkillInstallStoreV1> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !(parsed as { installs?: unknown }).installs ||
      typeof (parsed as { installs?: unknown }).installs !== 'object' ||
      Array.isArray((parsed as { installs?: unknown }).installs)
    ) {
      throw new Error('Skill install lock file is invalid');
    }
    return parsed as SkillInstallStoreV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, installs: {} };
    }
    throw error;
  }
}

export interface SkillInstallerOptions {
  workspaceRoot: string;
  userRoot?: string;
  gitCommand?: { executable: string; argumentsPrefix?: readonly string[] };
}

export class SkillInstaller {
  private readonly workspaceRoot: string;
  private readonly userRoot: string;
  private readonly gitCommand: { executable: string; argumentsPrefix: readonly string[] };

  constructor(options: SkillInstallerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.userRoot = resolve(options.userRoot ?? join(homedir(), '.syzzz-code'));
    this.gitCommand = {
      executable: options.gitCommand?.executable ?? 'git',
      argumentsPrefix: options.gitCommand?.argumentsPrefix ?? []
    };
  }

  async install(url: string, options: SkillInstallOptions): Promise<SkillInstallRecordV1> {
    const sourceUrl = validateSkillSourceUrl(url);
    const ref = validateRef(options.ref);
    const scope = options.scope ?? 'user';
    const prepared = await this.prepare(sourceUrl, ref, options.skill, options.signal);
    try {
      const targetPath = this.targetPath(scope, prepared.name);
      const store = await this.readManagedStore(scope);
      const existing = store.installs[prepared.name];
      try {
        await lstat(targetPath);
        if (!existing) {
          throw new Error(
            `Refusing to overwrite manually managed Skill ${prepared.name}; no install record exists`
          );
        }
        throw new Error(`Skill ${prepared.name} is already installed; use update`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      const preview = this.preview('install', prepared, targetPath, sourceUrl);
      await this.requireConfirmation(preview, options.confirm);
      const record = await this.applyPrepared(prepared, scope, sourceUrl, ref);
      return record;
    } finally {
      await prepared.cleanup();
    }
  }

  async update(name: string, options: SkillManagementOptions): Promise<SkillInstallRecordV1> {
    const scope = options.scope ?? 'user';
    const store = await this.readManagedStore(scope);
    const current = store.installs[name];
    if (!current) {
      throw new Error(`Skill ${name} is not managed in ${scope} scope`);
    }
    const prepared = await this.prepare(
      current.sourceUrl,
      validateRef(current.requestedRef),
      current.name,
      options.signal,
      current.sourceSkillPath
    );
    try {
      if (prepared.name !== current.name) {
        throw new Error(
          `Managed Skill name changed from ${current.name} to ${prepared.name}; remove and install explicitly`
        );
      }
      const preview = this.preview(
        'update',
        prepared,
        current.targetPath,
        current.sourceUrl,
        current.resolvedCommit
      );
      await this.requireConfirmation(preview, options.confirm);
      return await this.applyPrepared(
        prepared,
        scope,
        current.sourceUrl,
        current.requestedRef ?? 'HEAD'
      );
    } finally {
      await prepared.cleanup();
    }
  }

  async rollback(name: string, options: SkillManagementOptions): Promise<SkillInstallRecordV1> {
    const scope = options.scope ?? 'user';
    const storePath = this.storePath(scope);
    const store = await this.readManagedStore(scope);
    const current = store.installs[name];
    if (!current?.rollback) {
      throw new Error(`Skill ${name} has no rollback version`);
    }
    const preview: SkillInstallPreview = {
      action: 'rollback',
      name,
      targetPath: current.targetPath,
      files: [],
      fileCount: current.rollback.record.fileCount,
      totalBytes: current.rollback.record.totalBytes,
      scriptCount: 0,
      sourceUrl: current.rollback.record.sourceUrl,
      resolvedCommit: current.rollback.record.resolvedCommit
    };
    await this.requireConfirmation(preview, options.confirm);
    throwIfAborted(options.signal);
    const swapPath = `${current.targetPath}.swap-${randomUUID()}`;
    await rename(current.targetPath, swapPath);
    try {
      await rename(current.rollback.path, current.targetPath);
      await rename(swapPath, current.rollback.path);
    } catch (error) {
      await rename(swapPath, current.targetPath).catch(() => undefined);
      throw error;
    }
    const previousRecord = publicInstallRecord(current);
    const restored: ManagedSkillRecord = {
      ...current.rollback.record,
      targetPath: current.targetPath,
      rollback: { record: previousRecord, path: current.rollback.path }
    };
    store.installs[name] = restored;
    await writeJsonAtomic(storePath, store);
    return restored;
  }

  async remove(name: string, options: SkillManagementOptions): Promise<void> {
    const scope = options.scope ?? 'user';
    const storePath = this.storePath(scope);
    const store = await this.readManagedStore(scope);
    const current = store.installs[name];
    if (!current) {
      throw new Error(
        `Skill ${name} is not managed in ${scope} scope; manual Skills are never removed`
      );
    }
    await this.requireConfirmation(
      {
        action: 'remove',
        name,
        targetPath: current.targetPath,
        files: [],
        fileCount: current.fileCount,
        totalBytes: current.totalBytes,
        scriptCount: 0,
        sourceUrl: current.sourceUrl,
        resolvedCommit: current.resolvedCommit
      },
      options.confirm
    );
    throwIfAborted(options.signal);
    await rm(current.targetPath, { recursive: true, force: true });
    if (current.rollback) {
      await rm(current.rollback.path, { recursive: true, force: true });
    }
    delete store.installs[name];
    await writeJsonAtomic(storePath, store);
  }

  private async prepare(
    sourceUrl: string,
    ref: string,
    selectedSkill: string | undefined,
    signal: AbortSignal,
    selectedSourcePath?: string
  ): Promise<PreparedSkill> {
    throwIfAborted(signal);
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'syzzz-skill-'));
    const gitHome = join(temporaryRoot, 'git-home');
    const repositoryPath = join(temporaryRoot, 'repository');
    await mkdir(gitHome, { recursive: true, mode: 0o700 });
    const environment = sanitizedGitEnvironment(gitHome);
    const cleanup = async () => {
      await rm(temporaryRoot, { recursive: true, force: true });
    };
    try {
      await mkdir(repositoryPath, { recursive: true });
      await runGit(['init', '--quiet'], repositoryPath, environment, signal, this.gitCommand);
      await runGit(
        ['remote', 'add', 'origin', sourceUrl],
        repositoryPath,
        environment,
        signal,
        this.gitCommand
      );
      await runGit(
        ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', ref],
        repositoryPath,
        environment,
        signal,
        this.gitCommand
      );
      await runGit(
        ['checkout', '--quiet', '--detach', 'FETCH_HEAD'],
        repositoryPath,
        environment,
        signal,
        this.gitCommand
      );
      const resolvedCommit = await runGit(
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        repositoryPath,
        environment,
        signal,
        this.gitCommand
      );
      if (!FULL_COMMIT_PATTERN.test(resolvedCommit)) {
        throw new Error('Git did not resolve the requested ref to a full commit ID');
      }
      await inspectTree(repositoryPath);
      const roots = await discoverSkillRoots(repositoryPath);
      const selected = selectedSourcePath
        ? roots.find((root) => root.sourcePath === selectedSourcePath)
        : selectedSkill
          ? roots.find((root) => root.name === selectedSkill)
          : roots.length === 1
            ? roots[0]
            : undefined;
      if (!selected) {
        const names = roots.map((root) => root.name).join(', ');
        throw new Error(
          roots.length === 0
            ? 'No valid SKILL.md was found in the supported repository locations'
            : `Repository contains multiple Skills; select one with --skill (${names})`
        );
      }
      const inspection = await inspectTree(selected.root);
      return {
        name: selected.name,
        repositoryPath,
        selectedRoot: selected.root,
        sourceSkillPath: selected.sourcePath,
        resolvedCommit,
        inspection,
        cleanup
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private preview(
    action: 'install' | 'update',
    prepared: PreparedSkill,
    targetPath: string,
    sourceUrl: string,
    previousCommit?: string
  ): SkillInstallPreview {
    return {
      action,
      name: prepared.name,
      sourceUrl,
      ...(previousCommit ? { previousCommit } : {}),
      resolvedCommit: prepared.resolvedCommit,
      targetPath,
      files: prepared.inspection.files,
      fileCount: prepared.inspection.files.length,
      totalBytes: prepared.inspection.totalBytes,
      scriptCount: prepared.inspection.scriptCount
    };
  }

  private async requireConfirmation(
    preview: SkillInstallPreview,
    confirm: SkillInstallOptions['confirm']
  ): Promise<void> {
    if (!confirm || !(await confirm(preview))) {
      throw new Error(`Skill ${preview.action} cancelled`);
    }
  }

  private async applyPrepared(
    prepared: PreparedSkill,
    scope: 'user' | 'project',
    sourceUrl: string,
    requestedRef: string
  ): Promise<SkillInstallRecordV1> {
    const targetPath = this.targetPath(scope, prepared.name);
    const storePath = this.storePath(scope);
    const store = await this.readManagedStore(scope);
    const existing = store.installs[prepared.name];
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    const stagingPath = join(dirname(targetPath), `.${prepared.name}.install-${randomUUID()}`);
    await cp(prepared.selectedRoot, stagingPath, {
      recursive: true,
      errorOnExist: true,
      filter: (source) => basename(source) !== '.git'
    });
    const backupPath = this.rollbackPath(scope, prepared.name);
    await rm(backupPath, { recursive: true, force: true });
    if (existing) {
      await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
      await rename(targetPath, backupPath);
    }
    try {
      await rename(stagingPath, targetPath);
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      if (existing) {
        await rename(backupPath, targetPath).catch(() => undefined);
      }
      throw error;
    }
    const record: SkillInstallRecordV1 = {
      schemaVersion: 1,
      name: prepared.name,
      sourceUrl,
      ...(requestedRef === 'HEAD' ? {} : { requestedRef }),
      resolvedCommit: prepared.resolvedCommit,
      sourceSkillPath: prepared.sourceSkillPath,
      scope,
      installedAt: new Date().toISOString(),
      fileCount: prepared.inspection.files.length,
      totalBytes: prepared.inspection.totalBytes
    };
    store.installs[prepared.name] = {
      ...record,
      targetPath,
      ...(existing
        ? {
            rollback: {
              record: publicInstallRecord(existing),
              path: backupPath
            }
          }
        : {})
    };
    try {
      await writeJsonAtomic(storePath, store);
    } catch (error) {
      await rm(targetPath, { recursive: true, force: true });
      if (existing) {
        await rename(backupPath, targetPath).catch(() => undefined);
      }
      throw error;
    }
    return record;
  }

  private targetPath(scope: 'user' | 'project', name: string): string {
    return scope === 'user'
      ? join(this.userRoot, 'skills', name)
      : join(this.workspaceRoot, '.agents', 'skills', name);
  }

  private storePath(scope: 'user' | 'project'): string {
    return scope === 'user'
      ? join(this.userRoot, 'skill-installs.json')
      : join(this.workspaceRoot, '.syzzz-code', 'skill-installs.json');
  }

  private rollbackPath(scope: 'user' | 'project', name: string): string {
    return scope === 'user'
      ? join(this.userRoot, 'skill-rollbacks', name)
      : join(this.workspaceRoot, '.syzzz-code', 'skill-rollbacks', name);
  }

  private async readManagedStore(scope: 'user' | 'project'): Promise<SkillInstallStoreV1> {
    const store = await readStore(this.storePath(scope));
    for (const [name, rawRecord] of Object.entries(store.installs)) {
      validateInstallRecordValue(rawRecord, name, scope);
      const record = rawRecord as ManagedSkillRecord;
      if (
        typeof record.targetPath !== 'string' ||
        !pathsEqual(record.targetPath, this.targetPath(scope, name))
      ) {
        throw new Error(`Skill install lock record has an unsafe target path: ${name}`);
      }
      if (record.rollback !== undefined) {
        if (
          !isRecord(record.rollback) ||
          typeof record.rollback.path !== 'string' ||
          !pathsEqual(record.rollback.path, this.rollbackPath(scope, name))
        ) {
          throw new Error(`Skill install lock record has an unsafe rollback path: ${name}`);
        }
        validateInstallRecordValue(record.rollback.record, name, scope);
      }
    }
    return store;
  }
}

export const skillInstallLimits = Object.freeze({
  files: MAX_REPOSITORY_FILES,
  totalBytes: MAX_REPOSITORY_BYTES,
  fileBytes: MAX_REPOSITORY_FILE_BYTES
});
