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
import type {
  ExtensionTrustState,
  WorkspaceTrustRecordV1,
  WorkspaceTrustRecordV2
} from './types.js';

interface WorkspaceTrustStoreV2 {
  schemaVersion: 2;
  workspaces: WorkspaceTrustRecordV2[];
}

export interface WorkspaceTrustInspection {
  canonicalWorkspaceRoot: string;
  trustState: ExtensionTrustState;
  trusted: boolean;
  reviewedDigest?: string;
  currentDigest?: string;
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

function readTrustStore(): WorkspaceTrustStoreV2 {
  if (!existsSync(TRUST_STORE_PATH)) {
    return { schemaVersion: 2, workspaces: [] };
  }
  const raw = JSON.parse(readFileSync(TRUST_STORE_PATH, 'utf8')) as unknown;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    !Array.isArray((raw as { workspaces?: unknown }).workspaces)
  ) {
    throw new Error('trusted-workspaces.json must contain workspaces[]');
  }
  const schemaVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error('trusted-workspaces.json uses an unsupported schemaVersion');
  }
  const records: WorkspaceTrustRecordV2[] = [];
  for (const value of (raw as { workspaces: unknown[] }).workspaces) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new Error('trusted-workspaces.json contains an invalid record');
    }
    if (schemaVersion === 1) {
      const legacy = value as Partial<WorkspaceTrustRecordV1>;
      if (
        legacy.schemaVersion !== 1 ||
        typeof legacy.canonicalWorkspaceRoot !== 'string' ||
        typeof legacy.trustedAt !== 'string'
      ) {
        throw new Error('trusted-workspaces.json contains an invalid v1 record');
      }
      records.push({
        schemaVersion: 2,
        canonicalWorkspaceRoot: legacy.canonicalWorkspaceRoot,
        reviewedAt: legacy.trustedAt
      });
      continue;
    }
    const record = value as Partial<WorkspaceTrustRecordV2>;
    if (
      record.schemaVersion !== 2 ||
      typeof record.canonicalWorkspaceRoot !== 'string' ||
      (
        record.reviewedDigest !== undefined &&
        (
          typeof record.reviewedDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(record.reviewedDigest)
        )
      ) ||
      (
        record.reviewedAt !== undefined &&
        typeof record.reviewedAt !== 'string'
      )
    ) {
      throw new Error('trusted-workspaces.json contains an invalid v2 record');
    }
    records.push(record as WorkspaceTrustRecordV2);
  }
  return { schemaVersion: 2, workspaces: records };
}

function writeTrustStore(store: WorkspaceTrustStoreV2): void {
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
  workspaceRoot: string,
  currentDigest?: string
): WorkspaceTrustInspection {
  const canonicalWorkspaceRoot = canonicalWorkspacePath(workspaceRoot);
  try {
    const store = readTrustStore();
    const record = store.workspaces.find(
      candidate => candidate.canonicalWorkspaceRoot === canonicalWorkspaceRoot
    );
    const trustState: ExtensionTrustState = !record
      ? 'untrusted'
      : !record.reviewedDigest ||
          !currentDigest ||
          record.reviewedDigest !== currentDigest
        ? 'review-required'
        : 'trusted';
    return {
      canonicalWorkspaceRoot,
      trustState,
      trusted: trustState === 'trusted',
      ...(record?.reviewedDigest
        ? { reviewedDigest: record.reviewedDigest }
        : {}),
      ...(currentDigest ? { currentDigest } : {}),
      warnings: []
    };
  } catch (error) {
    return {
      canonicalWorkspaceRoot,
      trustState: 'untrusted',
      trusted: false,
      ...(currentDigest ? { currentDigest } : {}),
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
  reviewedDigest?: string,
  now: () => Date = () => new Date()
): WorkspaceTrustRecordV2 | undefined {
  const canonicalWorkspaceRoot = canonicalWorkspacePath(workspaceRoot);
  const store = readTrustStore();
  const remaining = store.workspaces.filter(
    record => record.canonicalWorkspaceRoot !== canonicalWorkspaceRoot
  );
  if (!trusted) {
    writeTrustStore({ schemaVersion: 2, workspaces: remaining });
    return undefined;
  }
  if (!reviewedDigest || !/^[a-f0-9]{64}$/.test(reviewedDigest)) {
    throw new Error('A valid project extension digest is required for trust');
  }
  const record: WorkspaceTrustRecordV2 = {
    schemaVersion: 2,
    canonicalWorkspaceRoot,
    reviewedDigest,
    reviewedAt: now().toISOString()
  };
  writeTrustStore({
    schemaVersion: 2,
    workspaces: [...remaining, record]
  });
  return record;
}
