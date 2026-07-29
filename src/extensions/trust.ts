import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { WorkspaceTrustRecordV1 } from './types.js';

interface WorkspaceTrustStoreV1 {
  schemaVersion: 1;
  workspaces: WorkspaceTrustRecordV1[];
}

export interface WorkspaceTrustInspection {
  canonicalWorkspaceRoot: string;
  trusted: boolean;
  warnings: string[];
}

const TRUST_STORE_PATH = join(
  homedir(),
  '.syzzz-code',
  'trusted-workspaces.json'
);

function canonicalWorkspacePath(workspaceRoot: string): string {
  let canonical = resolve(workspaceRoot);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // A disappearing workspace is still identified by its resolved lexical path.
  }
  canonical = canonical.replaceAll('\\', '/');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function readTrustStore(): WorkspaceTrustStoreV1 {
  if (!existsSync(TRUST_STORE_PATH)) {
    return { schemaVersion: 1, workspaces: [] };
  }
  const raw = JSON.parse(readFileSync(TRUST_STORE_PATH, 'utf8')) as unknown;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((raw as { workspaces?: unknown }).workspaces)
  ) {
    throw new Error('trusted-workspaces.json must use schemaVersion 1');
  }
  const records: WorkspaceTrustRecordV1[] = [];
  for (const value of (raw as { workspaces: unknown[] }).workspaces) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      typeof (value as { canonicalWorkspaceRoot?: unknown })
        .canonicalWorkspaceRoot !== 'string' ||
      typeof (value as { trustedAt?: unknown }).trustedAt !== 'string'
    ) {
      throw new Error('trusted-workspaces.json contains an invalid record');
    }
    records.push(value as WorkspaceTrustRecordV1);
  }
  return { schemaVersion: 1, workspaces: records };
}

function writeTrustStore(store: WorkspaceTrustStoreV1): void {
  mkdirSync(dirname(TRUST_STORE_PATH), { recursive: true, mode: 0o700 });
  const temporaryFile =
    `${TRUST_STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryFile, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryFile, TRUST_STORE_PATH);
    try {
      chmodSync(TRUST_STORE_PATH, 0o600);
    } catch {
      // Windows ACL checks are reported separately by doctor.
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporaryFile);
    } catch {
      // The path no longer exists after a successful rename.
    }
  }
}

export function getTrustStorePath(): string {
  return TRUST_STORE_PATH;
}

export function inspectWorkspaceTrust(
  workspaceRoot: string
): WorkspaceTrustInspection {
  const canonicalWorkspaceRoot = canonicalWorkspacePath(workspaceRoot);
  try {
    const store = readTrustStore();
    return {
      canonicalWorkspaceRoot,
      trusted: store.workspaces.some(
        record => record.canonicalWorkspaceRoot === canonicalWorkspaceRoot
      ),
      warnings: []
    };
  } catch (error) {
    return {
      canonicalWorkspaceRoot,
      trusted: false,
      warnings: [
        'Workspace project extensions are disabled because the trust store is invalid: ' +
        (error instanceof Error ? error.message : String(error))
      ]
    };
  }
}

export function setWorkspaceTrusted(
  workspaceRoot: string,
  trusted: boolean,
  now: () => Date = () => new Date()
): WorkspaceTrustRecordV1 | undefined {
  const canonicalWorkspaceRoot = canonicalWorkspacePath(workspaceRoot);
  const store = readTrustStore();
  const remaining = store.workspaces.filter(
    record => record.canonicalWorkspaceRoot !== canonicalWorkspaceRoot
  );
  if (!trusted) {
    writeTrustStore({ schemaVersion: 1, workspaces: remaining });
    return undefined;
  }
  const record: WorkspaceTrustRecordV1 = {
    schemaVersion: 1,
    canonicalWorkspaceRoot,
    trustedAt: now().toISOString()
  };
  writeTrustStore({
    schemaVersion: 1,
    workspaces: [...remaining, record]
  });
  return record;
}

