import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getConfigDirectory } from '../config.js';
import type { RagChunk, RagCollection, RagIndexManifestV1, RagIndexedFile } from './types.js';

interface CollectionRegistryV1 {
  schemaVersion: 1;
  collections: RagCollection[];
}

interface MountRegistryV1 {
  schemaVersion: 1;
  workspaces: Record<string, string[]>;
}

interface ConsentRecordV1 {
  schemaVersion: 1;
  collectionId: string;
  rootHash: string;
  endpoint: string;
  model: string;
  ingestionDigest: string;
  reviewedAt: string;
}

interface ConsentRegistryV1 {
  schemaVersion: 1;
  records: ConsentRecordV1[];
}

export interface RagRevisionData {
  directory: string;
  manifest: RagIndexManifestV1;
  chunks: RagChunk[];
}

const EMPTY_COLLECTIONS: CollectionRegistryV1 = { schemaVersion: 1, collections: [] };
const EMPTY_MOUNTS: MountRegistryV1 = { schemaVersion: 1, workspaces: {} };
const EMPTY_CONSENTS: ConsentRegistryV1 = { schemaVersion: 1, records: [] };

export function shortRagHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function workspaceRagId(workspaceRoot: string): string {
  return `workspace-${shortRagHash(resolve(workspaceRoot).toLowerCase())}`;
}

function parseJsonObject<T>(raw: string, path: string): T {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('root is not an object');
    }
    return value as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid RAG metadata ${path}: ${reason}`);
  }
}

async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    return parseJsonObject<T>(await readFile(path, 'utf8'), path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return structuredClone(fallback);
    }
    throw error;
  }
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

function validateCollectionName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(normalized)) {
    throw new Error(
      'Collection name must use 1-64 lowercase letters, digits, dots, dashes or underscores'
    );
  }
  if (normalized === 'workspace') {
    throw new Error('workspace is reserved for the current workspace collection');
  }
  return normalized;
}

function validateCollections(value: CollectionRegistryV1): CollectionRegistryV1 {
  if (value.schemaVersion !== 1 || !Array.isArray(value.collections)) {
    throw new Error('Invalid RAG collection registry schema');
  }
  const seen = new Set<string>();
  for (const collection of value.collections) {
    if (
      !collection ||
      typeof collection.id !== 'string' ||
      typeof collection.name !== 'string' ||
      collection.kind !== 'external' ||
      typeof collection.canonicalRoot !== 'string' ||
      (collection.managed !== undefined && typeof collection.managed !== 'boolean')
    ) {
      throw new Error('Invalid external RAG collection entry');
    }
    if (seen.has(collection.name)) throw new Error(`Duplicate RAG collection: ${collection.name}`);
    seen.add(collection.name);
  }
  return value;
}

export class RagStore {
  readonly baseDirectory: string;
  private readonly indexesDirectory: string;
  private readonly collectionsPath: string;
  private readonly mountsPath: string;
  private readonly consentsPath: string;
  private readonly managedKnowledgeDirectory: string;

  constructor(baseDirectory = join(getConfigDirectory(), 'rag')) {
    this.baseDirectory = baseDirectory;
    this.indexesDirectory = join(baseDirectory, 'indexes');
    this.collectionsPath = join(baseDirectory, 'collections.json');
    this.mountsPath = join(baseDirectory, 'mounts.json');
    this.consentsPath = join(baseDirectory, 'consents.json');
    this.managedKnowledgeDirectory = join(dirname(baseDirectory), 'knowledge');
  }

  async workspaceCollection(workspaceRoot: string): Promise<RagCollection> {
    const canonicalRoot = await realpath(resolve(workspaceRoot));
    return {
      id: workspaceRagId(canonicalRoot),
      name: 'workspace',
      kind: 'workspace',
      canonicalRoot,
      virtualRoot: 'rag://workspace',
      createdAt: new Date(0).toISOString()
    };
  }

  async listExternalCollections(): Promise<RagCollection[]> {
    const registry = validateCollections(
      await readJsonOrDefault(this.collectionsPath, EMPTY_COLLECTIONS)
    );
    return registry.collections.map((collection) => ({ ...collection }));
  }

  async addExternalCollection(name: string, root: string): Promise<RagCollection> {
    const normalizedName = validateCollectionName(name);
    if (normalizedName === 'library') {
      throw new Error('The reserved RAG collection name library is managed by Syzzz Code');
    }
    const canonicalRoot = await realpath(resolve(root));
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new Error(`RAG collection root is not a directory: ${root}`);
    }
    const registry = validateCollections(
      await readJsonOrDefault(this.collectionsPath, EMPTY_COLLECTIONS)
    );
    if (registry.collections.some((entry) => entry.name === normalizedName)) {
      throw new Error(`RAG collection already exists: ${normalizedName}`);
    }
    if (registry.collections.some((entry) => entry.canonicalRoot === canonicalRoot)) {
      throw new Error('This directory is already registered as a RAG collection');
    }
    const collection: RagCollection = {
      id: `external-${shortRagHash(`${normalizedName}\0${canonicalRoot.toLowerCase()}`)}`,
      name: normalizedName,
      kind: 'external',
      canonicalRoot,
      virtualRoot: `rag://${normalizedName}`,
      createdAt: new Date().toISOString()
    };
    registry.collections.push(collection);
    registry.collections.sort((left, right) => left.name.localeCompare(right.name));
    await atomicWrite(this.collectionsPath, `${JSON.stringify(registry, null, 2)}\n`);
    return collection;
  }

  async ensurePersonalLibrary(workspaceRoot: string): Promise<RagCollection> {
    const libraryRoot = join(this.managedKnowledgeDirectory, 'library');
    await mkdir(libraryRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(libraryRoot);
    const registry = validateCollections(
      await readJsonOrDefault(this.collectionsPath, EMPTY_COLLECTIONS)
    );
    let collection = registry.collections.find((entry) => entry.name === 'library');
    if (collection) {
      if (!collection.managed || collection.canonicalRoot !== canonicalRoot) {
        throw new Error(
          'The reserved RAG collection name library is already used by an unmanaged directory'
        );
      }
    } else {
      const conflictingRoot = registry.collections.find(
        (entry) => entry.canonicalRoot === canonicalRoot
      );
      if (conflictingRoot) {
        throw new Error(
          `Managed RAG library directory is already registered as ${conflictingRoot.name}`
        );
      }
      collection = {
        id: `external-${shortRagHash(`library\0${canonicalRoot.toLowerCase()}`)}`,
        name: 'library',
        kind: 'external',
        canonicalRoot,
        virtualRoot: 'rag://library',
        createdAt: new Date().toISOString(),
        managed: true
      };
      registry.collections.push(collection);
      registry.collections.sort((left, right) => left.name.localeCompare(right.name));
      await atomicWrite(this.collectionsPath, `${JSON.stringify(registry, null, 2)}\n`);
    }
    await this.setMounted(workspaceRoot, collection.id, true);
    return { ...collection };
  }

  async removeExternalCollection(name: string): Promise<boolean> {
    const registry = validateCollections(
      await readJsonOrDefault(this.collectionsPath, EMPTY_COLLECTIONS)
    );
    const collection = registry.collections.find((entry) => entry.name === name);
    if (!collection) return false;
    if (collection.managed) {
      throw new Error('The managed RAG library cannot be removed as an external collection');
    }
    registry.collections = registry.collections.filter((entry) => entry.id !== collection.id);
    await atomicWrite(this.collectionsPath, `${JSON.stringify(registry, null, 2)}\n`);
    const mounts = await readJsonOrDefault(this.mountsPath, EMPTY_MOUNTS);
    for (const [workspace, ids] of Object.entries(mounts.workspaces)) {
      mounts.workspaces[workspace] = ids.filter((id) => id !== collection.id);
    }
    await atomicWrite(this.mountsPath, `${JSON.stringify(mounts, null, 2)}\n`);
    return true;
  }

  async mountedCollectionIds(workspaceRoot: string): Promise<string[]> {
    const mounts = await readJsonOrDefault(this.mountsPath, EMPTY_MOUNTS);
    if (mounts.schemaVersion !== 1 || typeof mounts.workspaces !== 'object') {
      throw new Error('Invalid RAG mount registry schema');
    }
    return [...(mounts.workspaces[workspaceRagId(workspaceRoot)] ?? [])];
  }

  async setMounted(workspaceRoot: string, collectionId: string, mounted: boolean): Promise<void> {
    const mounts = await readJsonOrDefault(this.mountsPath, EMPTY_MOUNTS);
    const workspaceId = workspaceRagId(workspaceRoot);
    const ids = new Set(mounts.workspaces[workspaceId] ?? []);
    if (mounted) ids.add(collectionId);
    else ids.delete(collectionId);
    mounts.workspaces[workspaceId] = [...ids].sort();
    await atomicWrite(this.mountsPath, `${JSON.stringify(mounts, null, 2)}\n`);
  }

  async resolveAvailableCollections(workspaceRoot: string): Promise<RagCollection[]> {
    const workspace = await this.workspaceCollection(workspaceRoot);
    const mounted = new Set(await this.mountedCollectionIds(workspaceRoot));
    const external = (await this.listExternalCollections()).filter((entry) =>
      mounted.has(entry.id)
    );
    return [workspace, ...external];
  }

  revisionRoot(collectionId: string): string {
    return join(this.indexesDirectory, collectionId);
  }

  revisionDirectory(collectionId: string, revision: string): string {
    return join(this.revisionRoot(collectionId), revision);
  }

  async currentRevision(collectionId: string): Promise<string | undefined> {
    try {
      const revision = (
        await readFile(join(this.revisionRoot(collectionId), 'CURRENT'), 'utf8')
      ).trim();
      return /^[a-zA-Z0-9._-]+$/.test(revision) ? revision : undefined;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async loadRevision(
    collectionId: string,
    revision?: string
  ): Promise<RagRevisionData | undefined> {
    const selected = revision ?? (await this.currentRevision(collectionId));
    if (!selected) return undefined;
    const directory = this.revisionDirectory(collectionId, selected);
    try {
      const manifest = parseJsonObject<RagIndexManifestV1>(
        await readFile(join(directory, 'manifest.json'), 'utf8'),
        join(directory, 'manifest.json')
      );
      if (
        manifest.schemaVersion !== 1 ||
        manifest.collectionId !== collectionId ||
        manifest.revision !== selected
      ) {
        throw new Error('RAG manifest identity does not match its revision');
      }
      const rawChunks = await readFile(join(directory, 'chunks.jsonl'), 'utf8');
      const chunks = rawChunks
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RagChunk);
      return { directory, manifest, chunks };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async createRevisionDirectory(collectionId: string, revision: string): Promise<string> {
    const directory = this.revisionDirectory(collectionId, `.building-${revision}-${randomUUID()}`);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    return directory;
  }

  async acquireIndexLock(collectionId: string): Promise<() => Promise<void>> {
    const root = this.revisionRoot(collectionId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lockPath = join(root, 'index.lock');
    const attempt = async () => {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        'utf8'
      );
      await handle.sync();
      await handle.close();
    };
    try {
      await attempt();
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
      let reclaim = false;
      try {
        const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as {
          pid?: unknown;
          createdAt?: unknown;
        };
        const pid = Number(parsed.pid);
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (killError) {
            reclaim =
              Boolean(killError && typeof killError === 'object' && 'code' in killError) &&
              (killError as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }
        const createdAt = typeof parsed.createdAt === 'string' ? Date.parse(parsed.createdAt) : NaN;
        if (Number.isFinite(createdAt) && Date.now() - createdAt > 24 * 60 * 60 * 1000)
          reclaim = true;
      } catch {
        reclaim = true;
      }
      if (!reclaim) throw new Error(`RAG index build is already active for ${collectionId}`);
      await unlink(lockPath).catch(() => undefined);
      await attempt();
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await unlink(lockPath).catch(() => undefined);
    };
  }

  async commitRevision(
    collectionId: string,
    revision: string,
    buildingDirectory: string,
    manifest: RagIndexManifestV1,
    chunks: readonly RagChunk[],
    lexicalJson: string
  ): Promise<string> {
    await writeFile(
      join(buildingDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      }
    );
    await writeFile(
      join(buildingDirectory, 'chunks.jsonl'),
      chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + (chunks.length ? '\n' : ''),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    await writeFile(join(buildingDirectory, 'lexical.json'), lexicalJson, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    const finalDirectory = this.revisionDirectory(collectionId, revision);
    await rename(buildingDirectory, finalDirectory);
    await atomicWrite(join(this.revisionRoot(collectionId), 'CURRENT'), `${revision}\n`);
    await this.pruneRevisions(collectionId, new Set([revision]));
    return finalDirectory;
  }

  async writeVectors(buildingDirectory: string, vectors: Record<string, number[]>): Promise<void> {
    await writeFile(join(buildingDirectory, 'vectors.json'), JSON.stringify(vectors), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
  }

  async readVectors(directory: string): Promise<Record<string, number[]>> {
    try {
      return parseJsonObject<Record<string, number[]>>(
        await readFile(join(directory, 'vectors.json'), 'utf8'),
        join(directory, 'vectors.json')
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return {};
      throw error;
    }
  }

  async removeBuildingDirectory(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
  }

  async clearCollection(collectionId: string): Promise<void> {
    await rm(this.revisionRoot(collectionId), { recursive: true, force: true });
  }

  async hasConsent(input: Omit<ConsentRecordV1, 'schemaVersion' | 'reviewedAt'>): Promise<boolean> {
    const registry = await readJsonOrDefault(this.consentsPath, EMPTY_CONSENTS);
    return registry.records.some(
      (record) =>
        record.collectionId === input.collectionId &&
        record.rootHash === input.rootHash &&
        record.endpoint === input.endpoint &&
        record.model === input.model &&
        record.ingestionDigest === input.ingestionDigest
    );
  }

  async saveConsent(input: Omit<ConsentRecordV1, 'schemaVersion' | 'reviewedAt'>): Promise<void> {
    const registry = await readJsonOrDefault(this.consentsPath, EMPTY_CONSENTS);
    registry.records = registry.records.filter(
      (record) =>
        record.collectionId !== input.collectionId ||
        record.endpoint !== input.endpoint ||
        record.model !== input.model
    );
    registry.records.push({ schemaVersion: 1, ...input, reviewedAt: new Date().toISOString() });
    await atomicWrite(this.consentsPath, `${JSON.stringify(registry, null, 2)}\n`);
  }

  private async pruneRevisions(
    collectionId: string,
    protectedRevisions: Set<string>
  ): Promise<void> {
    const root = this.revisionRoot(collectionId);
    const entries = await readdir(root, { withFileTypes: true });
    const revisions = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.building-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const revision of revisions.slice(2)) {
      if (!protectedRevisions.has(revision)) {
        await rm(join(root, revision), { recursive: true, force: true });
      }
    }
    for (const entry of entries.filter(
      (candidate) => candidate.isDirectory() && candidate.name.startsWith('.building-')
    )) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

export function indexedFileFromChunks(
  virtualPath: string,
  sourceHash: string,
  bytes: number,
  mtimeMs: number,
  chunks: readonly RagChunk[]
): RagIndexedFile {
  return { virtualPath, sourceHash, bytes, mtimeMs, chunkIds: chunks.map((chunk) => chunk.id) };
}
