import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentMode } from './modes.js';
import type { ProviderUsage } from './providers/base.js';
import type { QueryEngineStateV1 } from './runtime-engine.js';

export const SESSION_SCHEMA_VERSION = 1 as const;
export const MAX_SESSION_STATE_BYTES = 64 * 1024 * 1024;
const DEFAULT_STALE_LOCK_MS = 24 * 60 * 60 * 1_000;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown()
  })
  .strict();

const conversationMessageSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('user'),
      content: z.string(),
      kind: z.literal('compaction-summary').optional()
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string(),
      toolCalls: z.array(toolCallSchema).optional()
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      toolCallId: z.string().min(1),
      toolName: z.string().min(1),
      content: z.string(),
      isError: z.boolean().optional()
    })
    .strict()
]);

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative()
  })
  .strict();

const fileChangeReceiptSchema = z
  .object({
    path: z.string().min(1),
    versionHash: z.string().min(1).optional()
  })
  .strict();

const conversationDisplayMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })
  .strict();

const engineStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    messages: z.array(conversationMessageSchema),
    displayMessages: z.array(conversationDisplayMessageSchema).optional(),
    pendingFileChangeReceipts: z.array(fileChangeReceiptSchema),
    compactionCount: z.number().int().nonnegative(),
    totalUsage: usageSchema,
    lastReportedModel: z.string().min(1).optional()
  })
  .strict();

const sessionUsageSchema = usageSchema
  .extend({
    turns: z.number().int().nonnegative()
  })
  .strict();

const sessionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    revision: z.number().int().positive(),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    title: z.string().min(1).max(120),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    workspace: z
      .object({
        id: z.string().regex(/^[0-9a-f]{16}$/),
        root: z.string().min(1)
      })
      .strict(),
    provider: z
      .object({
        id: z.string().min(1),
        model: z.string().min(1),
        lastReportedModel: z.string().min(1).optional()
      })
      .strict(),
    mode: z.enum(['ask', 'plan', 'code']),
    engineState: engineStateSchema,
    usage: sessionUsageSchema,
    auditSessionId: z.string().regex(SESSION_ID_PATTERN)
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.auditSessionId !== snapshot.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['auditSessionId'],
        message: 'auditSessionId must match sessionId'
      });
    }
    const engineUsage = snapshot.engineState.totalUsage;
    if (
      snapshot.usage.inputTokens !== engineUsage.inputTokens ||
      snapshot.usage.outputTokens !== engineUsage.outputTokens ||
      snapshot.usage.totalTokens !== engineUsage.totalTokens
    ) {
      context.addIssue({
        code: 'custom',
        path: ['usage'],
        message: 'session usage must match engine usage'
      });
    }
    if (snapshot.provider.lastReportedModel !== snapshot.engineState.lastReportedModel) {
      context.addIssue({
        code: 'custom',
        path: ['provider', 'lastReportedModel'],
        message: 'reported model metadata is inconsistent'
      });
    }
  });

const sessionMetadataSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    revision: z.number().int().positive(),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    title: z.string().min(1).max(120),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    workspaceId: z.string().regex(/^[0-9a-f]{16}$/),
    providerId: z.string().min(1),
    model: z.string().min(1),
    mode: z.enum(['ask', 'plan', 'code']),
    messageCount: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative()
  })
  .strict();

const lockFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export interface SessionUsage extends ProviderUsage {
  turns: number;
}

export interface SessionSnapshotV1 {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  revision: number;
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace: {
    id: string;
    root: string;
  };
  provider: {
    id: string;
    model: string;
    lastReportedModel?: string;
  };
  mode: AgentMode;
  engineState: QueryEngineStateV1;
  usage: SessionUsage;
  auditSessionId: string;
}

export interface SessionMetadata {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  revision: number;
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
  providerId: string;
  model: string;
  mode: AgentMode;
  messageCount: number;
  turns: number;
  available: boolean;
  unavailableReason?: string;
}

export interface SessionStoreOptions {
  workspaceRoot: string;
  baseDirectory?: string;
  now?: () => number;
  pid?: number;
  hostname?: string;
  staleLockMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  warn?: (message: string) => void;
}

interface LockFile {
  schemaVersion: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export class SessionStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_ID'
      | 'NOT_FOUND'
      | 'AMBIGUOUS_ID'
      | 'LOCKED'
      | 'CORRUPT'
      | 'TOO_LARGE'
      | 'WORKSPACE_MISMATCH'
  ) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

export class SessionLease {
  private released = false;

  constructor(
    readonly sessionId: string,
    readonly token: string,
    private readonly releaseCallback: () => Promise<void>
  ) {}

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    await this.releaseCallback();
    this.released = true;
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function normalizeWorkspacePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function workspaceHash(path: string): string {
  return createHash('sha256').update(normalizeWorkspacePath(path)).digest('hex').slice(0, 16);
}

function validateSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new SessionStoreError(`Invalid session ID: ${value}`, 'INVALID_ID');
  }
  return value.toLowerCase();
}

function validateSessionPrefix(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(normalized)) {
    throw new SessionStoreError(`Invalid session ID or prefix: ${value}`, 'INVALID_ID');
  }
  return normalized;
}

function metadataFromSnapshot(snapshot: SessionSnapshotV1): SessionMetadata {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    revision: snapshot.revision,
    sessionId: snapshot.sessionId,
    title: snapshot.title,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    workspaceId: snapshot.workspace.id,
    providerId: snapshot.provider.id,
    model: snapshot.provider.model,
    mode: snapshot.mode,
    messageCount: snapshot.engineState.messages.length,
    turns: snapshot.usage.turns,
    available: true
  };
}

function persistedMetadata(metadata: SessionMetadata) {
  const { available: _available, unavailableReason: _unavailableReason, ...persisted } = metadata;
  return persisted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionStore {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly workspaceDirectory: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly host: string;
  private readonly staleLockMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly warn: (message: string) => void;

  constructor(options: SessionStoreOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.workspaceId = workspaceHash(this.workspaceRoot);
    const baseDirectory = options.baseDirectory ?? join(homedir(), '.syzzz-code', 'sessions');
    this.workspaceDirectory = join(baseDirectory, this.workspaceId);
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.host = options.hostname ?? hostname();
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  }

  static async create(options: SessionStoreOptions): Promise<SessionStore> {
    let canonicalRoot = resolve(options.workspaceRoot);
    try {
      canonicalRoot = await realpath(canonicalRoot);
    } catch {
      // The lexical path remains usable for diagnostics if the workspace moves.
    }
    const store = new SessionStore({
      ...options,
      workspaceRoot: canonicalRoot
    });
    await mkdir(store.workspaceDirectory, {
      recursive: true,
      mode: 0o700
    });
    await store.applyPrivateMode(store.workspaceDirectory, 0o700);
    return store;
  }

  async acquire(sessionId: string): Promise<SessionLease> {
    const normalizedId = validateSessionId(sessionId);
    const sessionDirectory = this.sessionDirectory(normalizedId);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await this.applyPrivateMode(sessionDirectory, 0o700);
    const lockPath = join(sessionDirectory, 'lock.json');

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      const lock: LockFile = {
        schemaVersion: 1,
        token,
        pid: this.pid,
        hostname: this.host,
        createdAt: new Date(this.now()).toISOString()
      };
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.applyPrivateMode(lockPath, 0o600);
        return new SessionLease(normalizedId, token, async () => {
          await this.releaseLock(normalizedId, token);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        if (attempt === 0 && (await this.removeStaleLock(normalizedId))) {
          continue;
        }
        throw new SessionStoreError(
          `Session ${normalizedId} is already active in another process`,
          'LOCKED'
        );
      }
    }

    throw new SessionStoreError(`Session ${normalizedId} could not be locked`, 'LOCKED');
  }

  async save(snapshot: SessionSnapshotV1, lease: SessionLease): Promise<SessionMetadata> {
    const parsed = sessionSnapshotSchema.parse(snapshot) as SessionSnapshotV1;
    const sessionId = validateSessionId(parsed.sessionId);
    if (lease.sessionId !== sessionId) {
      throw new SessionStoreError('The session lease does not match the saved session', 'LOCKED');
    }
    if (
      parsed.workspace.id !== this.workspaceId ||
      normalizeWorkspacePath(parsed.workspace.root) !== normalizeWorkspacePath(this.workspaceRoot)
    ) {
      throw new SessionStoreError(
        'The session belongs to a different workspace',
        'WORKSPACE_MISMATCH'
      );
    }
    await this.assertLease(lease);

    const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_SESSION_STATE_BYTES) {
      throw new SessionStoreError(
        `Session state exceeds ${MAX_SESSION_STATE_BYTES} bytes`,
        'TOO_LARGE'
      );
    }

    const sessionDirectory = this.sessionDirectory(sessionId);
    await this.writeAtomic(join(sessionDirectory, 'state.json'), serialized);
    const metadata = metadataFromSnapshot(parsed);
    try {
      await this.writeAtomic(
        join(sessionDirectory, 'meta.json'),
        `${JSON.stringify(persistedMetadata(metadata), null, 2)}\n`
      );
    } catch (error) {
      this.warn(
        `Session metadata update failed; state remains recoverable: ${errorMessage(error)}`
      );
    }
    return metadata;
  }

  async load(idOrPrefix: string): Promise<SessionSnapshotV1> {
    const sessionId = await this.resolveSessionId(idOrPrefix);
    const value = await this.readJson(
      join(this.sessionDirectory(sessionId), 'state.json'),
      MAX_SESSION_STATE_BYTES
    );
    const parsed = sessionSnapshotSchema.safeParse(value);
    if (!parsed.success) {
      throw new SessionStoreError(
        `Session ${sessionId} is corrupt: ${parsed.error.issues[0]?.message ?? 'invalid state'}`,
        'CORRUPT'
      );
    }
    const snapshot = parsed.data as SessionSnapshotV1;
    if (snapshot.sessionId !== sessionId) {
      throw new SessionStoreError(`Session ${sessionId} contains a mismatched identity`, 'CORRUPT');
    }
    if (
      snapshot.workspace.id !== this.workspaceId ||
      normalizeWorkspacePath(snapshot.workspace.root) !== normalizeWorkspacePath(this.workspaceRoot)
    ) {
      throw new SessionStoreError(
        `Session ${sessionId} belongs to a different workspace`,
        'WORKSPACE_MISMATCH'
      );
    }
    return snapshot;
  }

  async list(): Promise<SessionMetadata[]> {
    const entries = await this.sessionDirectories();
    const sessions: SessionMetadata[] = [];
    for (const sessionId of entries) {
      const sessionDirectory = this.sessionDirectory(sessionId);
      try {
        const value = await this.readJson(join(sessionDirectory, 'meta.json'), 256 * 1024);
        const parsed = sessionMetadataSchema.safeParse(value);
        if (
          parsed.success &&
          parsed.data.sessionId === sessionId &&
          parsed.data.workspaceId === this.workspaceId &&
          (await this.metadataIsFresh(sessionDirectory))
        ) {
          sessions.push({
            ...(parsed.data as Omit<SessionMetadata, 'available'>),
            available: true
          });
          continue;
        }
      } catch {
        // State is the source of truth and can rebuild missing metadata.
      }

      try {
        const snapshot = await this.load(sessionId);
        const metadata = metadataFromSnapshot(snapshot);
        sessions.push(metadata);
        try {
          await this.writeAtomic(
            join(sessionDirectory, 'meta.json'),
            `${JSON.stringify(persistedMetadata(metadata), null, 2)}\n`
          );
        } catch {
          // Listing remains useful even when the derived cache cannot be repaired.
        }
      } catch (error) {
        if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') {
          continue;
        }
        sessions.push({
          schemaVersion: SESSION_SCHEMA_VERSION,
          revision: 1,
          sessionId,
          title: 'Unavailable session',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          workspaceId: this.workspaceId,
          providerId: 'unknown',
          model: 'unknown',
          mode: 'code',
          messageCount: 0,
          turns: 0,
          available: false,
          unavailableReason: errorMessage(error)
        });
      }
    }

    return sessions.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.sessionId.localeCompare(right.sessionId)
    );
  }

  async resolveSessionId(idOrPrefix: string): Promise<string> {
    const prefix = validateSessionPrefix(idOrPrefix);
    const entries = await this.sessionDirectories();
    if (entries.includes(prefix)) {
      return prefix;
    }
    const matches = entries.filter((sessionId) => sessionId.startsWith(prefix));
    if (matches.length === 0) {
      throw new SessionStoreError(
        `No session in the current workspace matches ${idOrPrefix}`,
        'NOT_FOUND'
      );
    }
    if (matches.length > 1) {
      throw new SessionStoreError(`Session prefix ${idOrPrefix} is ambiguous`, 'AMBIGUOUS_ID');
    }
    return matches[0];
  }

  async delete(idOrPrefix: string): Promise<string> {
    const sessionId = await this.resolveSessionId(idOrPrefix);
    let lease: SessionLease;
    try {
      lease = await this.acquire(sessionId);
    } catch (error) {
      if (error instanceof SessionStoreError && error.code === 'LOCKED') {
        throw new SessionStoreError(
          `Session ${sessionId} is active and cannot be deleted`,
          'LOCKED'
        );
      }
      throw error;
    }
    try {
      await rm(this.sessionDirectory(sessionId), {
        recursive: true,
        force: true
      });
    } finally {
      await lease.release();
    }
    return sessionId;
  }

  async prune(olderThanDays: number): Promise<string[]> {
    if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
      throw new Error('olderThanDays must be a non-negative integer');
    }
    const cutoff = this.now() - olderThanDays * 24 * 60 * 60 * 1_000;
    const removed: string[] = [];
    for (const metadata of await this.list()) {
      const updatedAt = Date.parse(metadata.updatedAt);
      if (!metadata.available || !Number.isFinite(updatedAt) || updatedAt > cutoff) {
        continue;
      }
      try {
        removed.push(await this.delete(metadata.sessionId));
      } catch (error) {
        if (!(error instanceof SessionStoreError) || error.code !== 'LOCKED') {
          throw error;
        }
      }
    }
    return removed;
  }

  private sessionDirectory(sessionId: string): string {
    return join(this.workspaceDirectory, validateSessionId(sessionId));
  }

  private async sessionDirectories(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.workspaceDirectory, {
        withFileTypes: true
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name.toLowerCase());
  }

  private async readJson(path: string, maximumBytes: number): Promise<unknown> {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SessionStoreError('Session state was not found', 'NOT_FOUND');
      }
      throw error;
    }
    try {
      const fileStats = await handle.stat();
      if (!fileStats.isFile()) {
        throw new SessionStoreError('Session state is not a regular file', 'CORRUPT');
      }
      if (fileStats.size > maximumBytes) {
        throw new SessionStoreError(`Session state exceeds ${maximumBytes} bytes`, 'TOO_LARGE');
      }
      const content = await handle.readFile('utf8');
      try {
        return JSON.parse(content);
      } catch (error) {
        throw new SessionStoreError(`Session JSON is invalid: ${errorMessage(error)}`, 'CORRUPT');
      }
    } finally {
      await handle.close();
    }
  }

  private async metadataIsFresh(sessionDirectory: string): Promise<boolean> {
    try {
      const [stateStats, metadataStats] = await Promise.all([
        lstat(join(sessionDirectory, 'state.json')),
        lstat(join(sessionDirectory, 'meta.json'))
      ]);
      return (
        stateStats.isFile() &&
        metadataStats.isFile() &&
        stateStats.size <= MAX_SESSION_STATE_BYTES &&
        metadataStats.mtimeMs >= stateStats.mtimeMs
      );
    } catch {
      return false;
    }
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    const temporaryPath = `${path}.${this.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
      await this.applyPrivateMode(path, 0o600);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  private async applyPrivateMode(path: string, mode: number): Promise<void> {
    try {
      await chmod(path, mode);
    } catch (error) {
      this.warn(`Could not apply private permissions to ${path}: ${errorMessage(error)}`);
    }
  }

  private async assertLease(lease: SessionLease): Promise<void> {
    const lock = await this.readLock(lease.sessionId);
    if (!lock || lock.token !== lease.token) {
      throw new SessionStoreError(
        `Session ${lease.sessionId} is not held by this process`,
        'LOCKED'
      );
    }
  }

  private async readLock(sessionId: string): Promise<LockFile | undefined> {
    const lockPath = join(this.sessionDirectory(sessionId), 'lock.json');
    try {
      const value = await this.readJson(lockPath, 64 * 1024);
      const parsed = lockFileSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  private async removeStaleLock(sessionId: string): Promise<boolean> {
    const lockPath = join(this.sessionDirectory(sessionId), 'lock.json');
    let lockStats;
    try {
      lockStats = await lstat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }

    let lock: LockFile | undefined;
    try {
      lock = await this.readLock(sessionId);
    } catch {
      // A recent unreadable lock fails closed; an old one can be recovered.
    }
    const createdAt = lock ? Date.parse(lock.createdAt) : lockStats.mtimeMs;
    const oldEnough = this.now() - createdAt >= this.staleLockMs;
    const sameHost = lock?.hostname === this.host;
    const localOwnerAlive = Boolean(lock && sameHost && this.isProcessAlive(lock.pid));
    if (localOwnerAlive) {
      return false;
    }
    const ownerDead = Boolean(lock && sameHost && !localOwnerAlive);
    if (!ownerDead && !oldEnough) {
      return false;
    }

    await rm(lockPath, { force: true });
    return true;
  }

  private async releaseLock(sessionId: string, token: string): Promise<void> {
    const sessionDirectory = this.sessionDirectory(sessionId);
    const lock = await this.readLock(sessionId);
    if (lock?.token === token) {
      await rm(join(sessionDirectory, 'lock.json'), { force: true });
    }
    try {
      await rmdir(sessionDirectory);
    } catch {
      // Persisted sessions and non-empty directories remain.
    }
  }
}
