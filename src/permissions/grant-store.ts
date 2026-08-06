import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PERMISSION_GRANT_SCHEMA_VERSION = 1 as const;
const MAX_PERMISSION_STORE_BYTES = 1024 * 1024;

export type PermissionGrantScope = 'none' | 'session' | 'workspace';

interface StoredGrant {
  mode: 'acceptEdits';
  workspaceId: string;
  updatedAt: string;
}

interface PermissionGrantFileV1 {
  schemaVersion: typeof PERMISSION_GRANT_SCHEMA_VERSION;
  sessions: Record<string, StoredGrant>;
  workspaces: Record<string, StoredGrant>;
}

export interface ResolvedPermissionGrant {
  mode: 'safe' | 'acceptEdits';
  scope: PermissionGrantScope;
}

function emptyStore(): PermissionGrantFileV1 {
  return { schemaVersion: PERMISSION_GRANT_SCHEMA_VERSION, sessions: {}, workspaces: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGrant(value: unknown, expectedWorkspaceId?: string): StoredGrant | undefined {
  if (!isRecord(value) || value.mode !== 'acceptEdits' || typeof value.workspaceId !== 'string') {
    return undefined;
  }
  if (expectedWorkspaceId && value.workspaceId !== expectedWorkspaceId) {
    return undefined;
  }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    return undefined;
  }
  return {
    mode: 'acceptEdits',
    workspaceId: value.workspaceId,
    updatedAt: value.updatedAt
  };
}

function parseStore(value: unknown): PermissionGrantFileV1 {
  if (!isRecord(value) || value.schemaVersion !== PERMISSION_GRANT_SCHEMA_VERSION) {
    throw new Error('Unsupported permission grant store schema');
  }
  if (!isRecord(value.sessions) || !isRecord(value.workspaces)) {
    throw new Error('Permission grant store must contain session and workspace maps');
  }
  const parsed = emptyStore();
  for (const [id, grant] of Object.entries(value.sessions)) {
    const accepted = parseGrant(grant);
    if (accepted) parsed.sessions[id] = accepted;
  }
  for (const [id, grant] of Object.entries(value.workspaces)) {
    const accepted = parseGrant(grant, id);
    if (accepted) parsed.workspaces[id] = accepted;
  }
  return parsed;
}

function privateMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows ACLs are reported by doctor; POSIX mode is best effort here.
  }
}

export class PermissionGrantStore {
  readonly path: string;

  constructor(baseDirectory = join(homedir(), '.syzzz-code')) {
    this.path = join(baseDirectory, 'permission-grants.json');
  }

  resolve(workspaceId: string, sessionId: string): ResolvedPermissionGrant {
    const store = this.read();
    if (store.sessions[sessionId]?.workspaceId === workspaceId) {
      return { mode: 'acceptEdits', scope: 'session' };
    }
    if (store.workspaces[workspaceId]) {
      return { mode: 'acceptEdits', scope: 'workspace' };
    }
    return { mode: 'safe', scope: 'none' };
  }

  setAcceptEdits(
    workspaceId: string,
    sessionId: string,
    scope: Exclude<PermissionGrantScope, 'none'>
  ): void {
    const store = this.read();
    const grant: StoredGrant = {
      mode: 'acceptEdits',
      workspaceId,
      updatedAt: new Date().toISOString()
    };
    if (scope === 'workspace') {
      store.workspaces[workspaceId] = grant;
      delete store.sessions[sessionId];
    } else {
      store.sessions[sessionId] = grant;
      delete store.workspaces[workspaceId];
    }
    this.write(store);
  }

  clear(workspaceId: string, sessionId: string): void {
    const store = this.read();
    delete store.sessions[sessionId];
    delete store.workspaces[workspaceId];
    this.write(store);
  }

  private read(): PermissionGrantFileV1 {
    if (!existsSync(this.path)) return emptyStore();
    const raw = readFileSync(this.path);
    if (raw.byteLength > MAX_PERMISSION_STORE_BYTES) {
      throw new Error('Permission grant store exceeds 1 MiB');
    }
    try {
      return parseStore(JSON.parse(raw.toString('utf8')));
    } catch (error) {
      throw new Error(
        `Cannot read permission grants without explicit review: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private write(store: PermissionGrantFileV1): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateMode(directory, 0o700);
    const temporary = join(directory, `.permission-grants.${process.pid}.${randomUUID()}.tmp`);
    const handle = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    try {
      renameSync(temporary, this.path);
      privateMode(this.path, 0o600);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }
}
