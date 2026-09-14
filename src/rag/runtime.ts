import { randomUUID } from 'node:crypto';
import { chmod, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import MiniSearch, { type SearchResult } from 'minisearch';
import type { AgentEventData } from '../events.js';
import {
  DEFAULT_RAG_CONFIG,
  loadConfig,
  type RagConfig,
  type RagEmbeddingConfig
} from '../config.js';
import type { AgentMode } from '../modes.js';
import { throwIfAborted } from '../tools/abort.js';
import { listWorkspaceFiles } from '../tools/search-tools.js';
import { isSensitiveRelativePath } from '../tools/workspace.js';
import {
  applyApprovedFileChange,
  createApprovedFileChange,
  createFileDiff,
  hashContent,
  readBoundedUtf8File,
  readOptionalFileSnapshot
} from '../tools/file-changes.js';
import { limitUtf8Head } from '../tools/output-limits.js';
import { chunkRagSource, hashRagContent } from './chunker.js';
import { createEmbeddings, rerankDocuments, resolveRagCredential } from './remote.js';
import { indexedFileFromChunks, RagStore, shortRagHash } from './store.js';
import { processRagTerm, tokenizeRagText } from './tokenizer.js';
import type {
  RagChunk,
  RagCitationCheck,
  RagCollection,
  RagCollectionStatus,
  RagContextReceipt,
  RagIngestionResult,
  RagIndexManifestV1,
  RagIndexProgress,
  RagIndexResult,
  RagRetrievalHit,
  RagKnowledgeSaveInput,
  RagPreparedWrite,
  RagStatus,
  RagVerificationClaim,
  RagVerificationResult
} from './types.js';
import { buildLanceVectorStore, searchLanceVectorStore } from './vector-store.js';
import type { ToolDefinition } from '../types.js';
import { createRagTools } from './tools.js';
import { ragCapabilityInstructions } from './instructions.js';
import type { RagQueryRewriter } from './query-rewriter.js';
import { RagServiceClient } from './service-client.js';

const MAX_FILES = 20_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_CHUNKS = 100_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_QUERIES = 4;
const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 50;
const MAX_RERANK_CANDIDATES = 20;
const RRF_K = 60;
const MIN_LEXICAL_QUERY_COVERAGE = 0.2;
const MIN_LEXICAL_MATCHED_TERMS = 2;
const EMBEDDING_BATCH_SIZE = 64;
const INGESTION_DIGEST = 'phase9-v1:extensions+gitignore+sensitive+2mib';
const MAX_KNOWLEDGE_BYTES = 128 * 1024;
const MAX_INGESTION_PREVIEW_BYTES = 40 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.json',
  '.yaml',
  '.yml',
  '.txt'
]);
const HARD_EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.ssh',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '__pycache__'
]);

function normalizeEvidenceCode(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function findUnsupportedCodeClaims(
  draft: string,
  chunks: readonly RagChunk[]
): RagVerificationClaim[] {
  const evidence = chunks.map((chunk) => normalizeEvidenceCode(chunk.text));
  const claims: RagVerificationClaim[] = [];
  for (const match of draft.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const code = normalizeEvidenceCode(match[1] ?? '');
    if (!code || evidence.some((text) => text.includes(code))) continue;
    claims.push({
      claim: 'Generated code block is not present verbatim in the supplied evidence.',
      outcome: 'unsupported',
      citations: []
    });
  }
  // Inline executable examples require evidence too; bare identifiers remain ordinary mentions.
  const prose = draft.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  for (const match of prose.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    const code = normalizeEvidenceCode(match[1]);
    const executable = /[\p{L}_][\p{L}\p{N}_.]*\s*\(|(?<![=<>!])=(?!=)/u.test(code);
    if (!executable || evidence.some((text) => text.includes(code))) continue;
    claims.push({
      claim: 'Generated inline code is not present verbatim in the supplied evidence.',
      outcome: 'unsupported',
      citations: []
    });
  }
  return claims;
}

interface LexicalDocument {
  id: string;
  path: string;
  heading: string;
  symbol: string;
  text: string;
}

export interface RagSemanticVerifierInput {
  draft: string;
  chunks: RagChunk[];
  signal: AbortSignal;
  emitEvent?: (event: AgentEventData) => void;
}

export type RagSemanticVerifier = (
  input: RagSemanticVerifierInput
) => Promise<RagVerificationResult['claims']>;

export interface RagGroundedAnswerRepairInput {
  question: string;
  chunks: RagChunk[];
  signal: AbortSignal;
  emitEvent?: (event: AgentEventData) => void;
}

export type RagGroundedAnswerRepairer = (input: RagGroundedAnswerRepairInput) => Promise<string>;

export interface RagRuntimeOptions {
  workspaceRoot: string;
  config?: RagConfig;
  store?: RagStore;
  now?: () => number;
  idFactory?: () => string;
  semanticVerifier?: RagSemanticVerifier;
  answerRepairer?: RagGroundedAnswerRepairer;
  queryRewriter?: RagQueryRewriter;
}

export interface RagIndexOptions {
  collection?: string;
  operation?: 'index' | 'refresh';
  signal: AbortSignal;
  confirmRemote?: (request: {
    purpose: 'embedding' | 'reranker';
    collection: RagCollection;
    endpoint: string;
    model: string;
    fileCount: number;
    sourceBytes: number;
  }) => Promise<boolean>;
  onProgress?: (progress: RagIndexProgress) => void;
  emitEvent?: (event: AgentEventData) => void;
}

export interface RagSearchOptions {
  query?: string;
  queries?: string[];
  collections?: string[];
  path?: string;
  limit?: number;
  signal: AbortSignal;
  emitEvent?: (event: AgentEventData) => void;
}

function lexicalOptions() {
  return {
    fields: ['path', 'heading', 'symbol', 'text'],
    storeFields: ['path', 'heading', 'symbol'],
    tokenize: tokenizeRagText,
    processTerm: processRagTerm,
    searchOptions: {
      boost: { path: 2.5, symbol: 2.25, heading: 1.75, text: 1 },
      prefix: true,
      fuzzy: 0.1
    }
  };
}

function meaningfulQueryTerms(query: string): Set<string> {
  return new Set(tokenizeRagText(query).filter((term) => Array.from(term).length >= 2));
}

function hasSufficientLexicalCoverage(query: string, result: SearchResult): boolean {
  const queryTerms = meaningfulQueryTerms(query);
  const matchedTerms = new Set(
    result.queryTerms.map((term) => term.normalize('NFKC').toLowerCase())
  );
  if (queryTerms.size <= 2) {
    return [...queryTerms].every((term) => matchedTerms.has(term));
  }
  const matchedCount = [...queryTerms].filter((term) => matchedTerms.has(term)).length;
  return (
    matchedCount >= MIN_LEXICAL_MATCHED_TERMS &&
    matchedCount / queryTerms.size >= MIN_LEXICAL_QUERY_COVERAGE
  );
}

function isExcludedPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  return (
    segments.some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment)) ||
    isSensitiveRelativePath(normalized) ||
    normalized.includes('/.syzzz-code/')
  );
}

function isSupportedPath(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase());
}

function normalizeManagedFilename(value: string): string {
  const filename = value.trim();
  if (
    !filename ||
    filename !== basename(filename) ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('\0') ||
    isSensitiveRelativePath(filename) ||
    !isSupportedPath(filename)
  ) {
    throw new Error('Managed RAG filenames must be a single supported, non-sensitive filename');
  }
  return filename;
}

function filenameFromTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return `${slug || `knowledge-${shortRagHash(title)}`}.md`;
}

function validatePreparedWrite(value: RagPreparedWrite): void {
  const normalizedFilename = normalizeManagedFilename(value.targetRelativePath);
  if (
    value.schemaVersion !== 1 ||
    value.collectionName !== 'library' ||
    typeof value.collectionId !== 'string' ||
    !value.collectionId ||
    typeof value.targetPath !== 'string' ||
    !value.targetPath ||
    value.virtualPath !== `rag://library/${normalizedFilename}` ||
    typeof value.proposedContent !== 'string' ||
    (value.expectedContentHash !== null && !/^[a-f0-9]{64}$/.test(value.expectedContentHash)) ||
    (value.expectedSizeBytes !== null &&
      (!Number.isSafeInteger(value.expectedSizeBytes) || value.expectedSizeBytes < 0)) ||
    (value.targetMode !== null && (!Number.isInteger(value.targetMode) || value.targetMode < 0)) ||
    !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
    value.sourceHash !== hashContent(value.proposedContent) ||
    !Number.isSafeInteger(value.sourceBytes) ||
    value.sourceBytes !== Buffer.byteLength(value.proposedContent, 'utf8') ||
    typeof value.preview !== 'string' ||
    !['create', 'update', 'unchanged'].includes(value.operation)
  ) {
    throw new Error('Invalid prepared RAG write');
  }
}

function ragErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code).toLowerCase()
    : error instanceof Error
      ? error.name.toLowerCase()
      : 'rag_error';
}

function summarizeChunk(chunk: RagChunk): string {
  const text = chunk.text.replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, 360).join('') + (Array.from(text).length > 360 ? '…' : '');
}

function normalizePathFilter(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:/iu.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('RAG path filter must be a relative path inside a collection');
  }
  return normalized;
}

function resolveSearchScope(
  collections: string[] | undefined,
  path: string | undefined
): { collections: string[] | undefined; path: string | undefined } {
  if (!path?.startsWith('rag://')) return { collections, path };
  const match = /^rag:\/\/([^/?#]+)(?:\/([^?#]*))?$/u.exec(path);
  if (!match) {
    throw new Error(
      'RAG virtual path must be rag://<collection>/<relative-path> without query or fragment'
    );
  }
  const collection = match[1];
  if (collections?.length && !collections.includes(collection)) {
    throw new Error('RAG virtual path collection must match the collections filter');
  }
  return {
    collections: collections?.length ? collections : [collection],
    path: match[2] || undefined
  };
}

function rrfMerge(
  rankings: Array<Array<{ id: string; score: number; channel: 'lexical' | 'vector' }>>
) {
  const merged = new Map<string, { score: number; channels: Set<'lexical' | 'vector'> }>();
  for (const ranking of rankings) {
    ranking.forEach((item, index) => {
      const current = merged.get(item.id) ?? { score: 0, channels: new Set() };
      current.score += 1 / (RRF_K + index + 1);
      current.channels.add(item.channel);
      merged.set(item.id, current);
    });
  }
  return [...merged.entries()]
    .map(([id, value]) => ({ id, score: value.score, channels: [...value.channels] }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

async function readUtf8File(
  path: string
): Promise<{ content: string; bytes: number; mtimeMs: number }> {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`RAG source is not a regular file: ${path}`);
    if (before.size > MAX_FILE_BYTES) throw new Error(`RAG source exceeds 2 MiB: ${path}`);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`RAG source changed while it was being read: ${path}`);
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    return { content, bytes: offset, mtimeMs: after.mtimeMs };
  } finally {
    await handle.close();
  }
}

export class RagRuntime {
  readonly store: RagStore;
  private readonly workspaceRoot: string;
  private config: RagConfig;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly receipts = new Map<string, Map<string, RagContextReceipt>>();
  private readonly searchedChunks = new Map<string, Set<string>>();
  private readonly verifiedTurns = new Set<string>();
  private readonly verificationResults = new Map<string, RagVerificationResult>();
  private semanticVerifier?: RagSemanticVerifier;
  private answerRepairer?: RagGroundedAnswerRepairer;
  private queryRewriter?: RagQueryRewriter;
  private vectorAvailable = true;
  private runtimeWarnings: string[] = [];
  private cachedStatus: RagStatus;
  private readonly service?: RagServiceClient;
  private readonly remoteChunks = new Map<string, Map<string, RagChunk>>();

  constructor(options: RagRuntimeOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.config = structuredClone(options.config ?? loadConfig().rag ?? DEFAULT_RAG_CONFIG);
    this.store = options.store ?? new RagStore();
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.semanticVerifier = options.semanticVerifier;
    this.answerRepairer = options.answerRepairer;
    this.queryRewriter = options.queryRewriter;
    this.service = this.config.service?.enabled
      ? new RagServiceClient(this.config.service)
      : undefined;
    this.cachedStatus = {
      enabled: this.config.enabled,
      backend: this.service ? 'remote' : 'local',
      autoRetrieve: this.config.autoRetrieve,
      autoRefresh: this.config.autoRefresh,
      lexicalAvailable: true,
      vectorAvailable: Boolean(this.config.embedding),
      rerankerConfigured: Boolean(this.config.reranker),
      collections: [],
      warnings: []
    };
  }

  getTools(): readonly ToolDefinition[] {
    return createRagTools(this, Boolean(this.semanticVerifier));
  }

  isRemote(): boolean {
    return Boolean(this.service);
  }

  private requireLocalManagement(): void {
    if (this.service)
      throw new Error('Remote RAG is read-only; update documents and indexes on the server');
  }

  setSemanticVerifier(verifier: RagSemanticVerifier | undefined): void {
    this.semanticVerifier = verifier;
  }

  setAnswerRepairer(repairer: RagGroundedAnswerRepairer | undefined): void {
    this.answerRepairer = repairer;
  }

  getSystemPromptSuffix(): string {
    return ragCapabilityInstructions(Boolean(this.service));
  }

  async listCollections(): Promise<RagCollection[]> {
    if (this.service) {
      const status = await this.service.status();
      return status.collections.map((entry) => ({
        id: entry.id,
        name: entry.name,
        kind: 'external',
        canonicalRoot: '',
        virtualRoot: `rag://${entry.name}`,
        createdAt: ''
      }));
    }
    return this.store.resolveAvailableCollections(this.workspaceRoot);
  }

  async registerCollection(name: string, root: string): Promise<RagCollection> {
    this.requireLocalManagement();
    return this.store.addExternalCollection(name, root);
  }

  async ensurePersonalLibrary(): Promise<RagCollection> {
    this.requireLocalManagement();
    return this.store.ensurePersonalLibrary(this.workspaceRoot);
  }

  async prepareDocumentImport(
    sourceInput: string,
    requestedFilename: string | undefined,
    signal: AbortSignal
  ): Promise<RagPreparedWrite> {
    this.requireLocalManagement();
    const normalizedInput = sourceInput
      .trim()
      .replace(/^@/, '')
      .replace(/^['"]|['"]$/g, '');
    if (!normalizedInput) throw new Error('RAG document path cannot be empty');
    if (isSensitiveRelativePath(normalizedInput)) {
      throw new Error('Sensitive files cannot be imported into a RAG collection');
    }
    const sourcePath = await realpath(resolve(this.workspaceRoot, normalizedInput));
    if (isSensitiveRelativePath(sourcePath) || !isSupportedPath(sourcePath)) {
      throw new Error('RAG document must be a supported, non-sensitive UTF-8 file');
    }
    const source = await readBoundedUtf8File(sourcePath, MAX_FILE_BYTES, signal);
    return this.prepareManagedWrite(
      source.content,
      requestedFilename ?? basename(sourcePath),
      signal
    );
  }

  async prepareKnowledgeSave(
    input: RagKnowledgeSaveInput,
    turnId: string,
    signal: AbortSignal
  ): Promise<RagPreparedWrite> {
    const title = input.title.replace(/\s+/g, ' ').trim();
    if (!title || title.length > 200) throw new Error('Knowledge title must use 1-200 characters');
    const content = input.content.trim();
    if (!content) throw new Error('Knowledge content cannot be empty');
    if (Buffer.byteLength(content, 'utf8') > MAX_KNOWLEDGE_BYTES) {
      throw new Error('Knowledge content exceeds 128 KiB');
    }
    const requestedReceipts = [...new Set(input.sourceChunkIds ?? [])];
    if (requestedReceipts.length > 20) throw new Error('At most 20 RAG source chunks are allowed');
    const turnReceipts = this.receipts.get(turnId) ?? new Map<string, RagContextReceipt>();
    const receipts = requestedReceipts.map((chunkId) => {
      const receipt = turnReceipts.get(chunkId);
      if (!receipt) throw new Error(`RAG source chunk was not read in this turn: ${chunkId}`);
      return receipt;
    });
    const checks = await this.validateContextReceipts(receipts, signal);
    const invalid = checks.find((check) => check.status !== 'valid');
    if (invalid) throw new Error(`RAG source receipt is no longer valid: ${invalid.chunkId}`);
    const evidence = receipts.length
      ? [
          '',
          '## Evidence receipts',
          '',
          ...receipts.map(
            (receipt) =>
              `- [[rag:${receipt.chunkId}]] ${receipt.virtualPath}:L${receipt.lineStart}-L${receipt.lineEnd}`
          )
        ]
      : [];
    const proposedContent = [
      `# ${title}`,
      '',
      '<!-- syzzz-managed-knowledge: generated; review before treating as authoritative -->',
      '',
      content,
      ...evidence,
      ''
    ].join('\n');
    return this.prepareManagedWrite(
      proposedContent,
      input.filename ?? filenameFromTitle(title),
      signal
    );
  }

  describePreparedWrite(prepared: RagPreparedWrite): string {
    validatePreparedWrite(prepared);
    return prepared.preview;
  }

  async applyPreparedWrite(
    prepared: RagPreparedWrite,
    signal: AbortSignal
  ): Promise<RagIngestionResult> {
    validatePreparedWrite(prepared);
    const collection = await this.ensurePersonalLibrary();
    if (collection.id !== prepared.collectionId || !collection.managed) {
      throw new Error('Managed RAG library identity changed after approval');
    }
    const filename = normalizeManagedFilename(prepared.targetRelativePath);
    const targetPath = resolve(collection.canonicalRoot, filename);
    if (targetPath !== prepared.targetPath) {
      throw new Error('Managed RAG target changed after approval');
    }
    if (prepared.operation !== 'unchanged') {
      const applied = await applyApprovedFileChange(
        {
          targetPath,
          expectedContentHash: prepared.expectedContentHash,
          expectedSizeBytes: prepared.expectedSizeBytes,
          targetMode: prepared.targetMode,
          proposedContent: prepared.proposedContent
        },
        signal,
        async () => {
          const currentRoot = await realpath(collection.canonicalRoot);
          const currentParent = await realpath(dirname(targetPath));
          if (currentRoot !== collection.canonicalRoot || currentParent !== currentRoot) {
            throw new Error('Managed RAG target escaped its approved collection');
          }
        }
      );
      if (applied === 'changed') {
        throw new Error('Managed RAG target changed after approval; no content was replaced');
      }
      if (process.platform !== 'win32') await chmod(targetPath, 0o600);
    }
    return {
      collection: collection.name,
      virtualPath: prepared.virtualPath,
      operation: prepared.operation,
      sourceHash: prepared.sourceHash,
      sourceBytes: prepared.sourceBytes,
      indexStatus: 'pending-consent'
    };
  }

  async refreshManagedLibrary(
    signal: AbortSignal,
    emitEvent?: (event: AgentEventData) => void
  ): Promise<Pick<RagIngestionResult, 'indexStatus' | 'revision' | 'warning'>> {
    const collection = await this.ensurePersonalLibrary();
    if (!(await this.hasRemoteConsentForCollection(collection))) {
      return {
        indexStatus: 'pending-consent',
        warning: 'Knowledge was saved locally. Run /rag refresh library to review remote ingestion.'
      };
    }
    try {
      const indexed = await this.index({
        collection: collection.name,
        operation: 'refresh',
        signal,
        emitEvent
      });
      return { indexStatus: 'refreshed', revision: indexed.revision };
    } catch (error) {
      return {
        indexStatus: 'failed',
        warning:
          'Knowledge was saved, but index refresh failed: ' +
          (error instanceof Error ? error.message : String(error))
      };
    }
  }

  getTurnReceipts(turnId: string): RagContextReceipt[] {
    return [...(this.receipts.get(turnId)?.values() ?? [])].map((receipt) => ({ ...receipt }));
  }

  async validateContextReceipts(
    receipts: readonly RagContextReceipt[],
    signal: AbortSignal
  ): Promise<RagCitationCheck[]> {
    if (this.service) return this.service.verify(receipts, signal);
    const checks: RagCitationCheck[] = [];
    const collections = await this.listCollections();
    for (const receipt of receipts) {
      throwIfAborted(signal);
      const token = `[[rag:${receipt.chunkId}]]`;
      if (receipt.serviceId) {
        checks.push({ token, chunkId: receipt.chunkId, status: 'unknown-chunk' });
        continue;
      }
      const revision = await this.store.loadRevision(receipt.collectionId, receipt.revision);
      if (!revision) {
        checks.push({ token, chunkId: receipt.chunkId, status: 'missing-revision' });
        continue;
      }
      const chunk = revision.chunks.find((entry) => entry.id === receipt.chunkId);
      if (!chunk) {
        checks.push({ token, chunkId: receipt.chunkId, status: 'unknown-chunk' });
        continue;
      }
      if (
        chunk.sourceHash !== receipt.sourceHash ||
        chunk.lineStart !== receipt.lineStart ||
        chunk.lineEnd !== receipt.lineEnd
      ) {
        checks.push({ token, chunkId: receipt.chunkId, status: 'stale-source' });
        continue;
      }
      const collection = collections.find((entry) => entry.id === receipt.collectionId);
      if (!collection) {
        checks.push({ token, chunkId: receipt.chunkId, status: 'stale-source' });
        continue;
      }
      try {
        const sourceRelativePath = chunk.virtualPath.slice(collection.virtualRoot.length + 1);
        const sourcePath = await realpath(resolve(collection.canonicalRoot, sourceRelativePath));
        const current = await readUtf8File(sourcePath);
        checks.push({
          token,
          chunkId: receipt.chunkId,
          status:
            hashRagContent(Buffer.from(current.content, 'utf8')) === receipt.sourceHash
              ? 'valid'
              : 'stale-source'
        });
      } catch {
        checks.push({ token, chunkId: receipt.chunkId, status: 'stale-source' });
      }
    }
    return checks;
  }

  private async prepareManagedWrite(
    content: string,
    requestedFilename: string,
    signal: AbortSignal
  ): Promise<RagPreparedWrite> {
    const collection = await this.ensurePersonalLibrary();
    const filename = normalizeManagedFilename(requestedFilename);
    const targetPath = resolve(collection.canonicalRoot, filename);
    const current = await readOptionalFileSnapshot(targetPath, MAX_FILE_BYTES, signal);
    const approved = createApprovedFileChange(targetPath, current, content);
    const sourceHash = hashContent(content);
    const operation =
      current === null
        ? 'create'
        : hashContent(current.content) === sourceHash
          ? 'unchanged'
          : 'update';
    const rawPreview =
      operation === 'unchanged'
        ? `No content change for ${collection.virtualRoot}/${filename}\nsha256=${sourceHash}`
        : createFileDiff(
            `${collection.virtualRoot}/${filename}`,
            current?.content ?? null,
            content
          );
    const limitedPreview = limitUtf8Head(rawPreview, MAX_INGESTION_PREVIEW_BYTES);
    return {
      schemaVersion: 1,
      collectionId: collection.id,
      collectionName: collection.name,
      targetPath,
      targetRelativePath: filename,
      virtualPath: `${collection.virtualRoot}/${filename}`,
      proposedContent: content,
      expectedContentHash: approved.expectedContentHash,
      expectedSizeBytes: approved.expectedSizeBytes,
      targetMode: approved.targetMode,
      sourceHash,
      sourceBytes: Buffer.byteLength(content, 'utf8'),
      operation,
      preview: `${limitedPreview.text}${limitedPreview.truncated ? '\n[preview truncated]' : ''}`
    };
  }

  private async hasRemoteConsentForCollection(collection: RagCollection): Promise<boolean> {
    const ingestionDigest = shortRagHash(INGESTION_DIGEST);
    const rootHash = shortRagHash(await realpath(collection.canonicalRoot));
    const remoteConfigs = [this.config.embedding, this.config.reranker].filter(
      (config): config is NonNullable<typeof config> => Boolean(config)
    );
    for (const config of remoteConfigs) {
      if (
        !(await this.store.hasConsent({
          collectionId: collection.id,
          rootHash,
          endpoint: config.env.BASE_URL,
          model: config.model,
          ingestionDigest
        }))
      ) {
        return false;
      }
    }
    return true;
  }

  async removeCollection(name: string): Promise<boolean> {
    this.requireLocalManagement();
    return this.store.removeExternalCollection(name);
  }

  async mount(name: string): Promise<void> {
    this.requireLocalManagement();
    const collection = (await this.store.listExternalCollections()).find(
      (entry) => entry.name === name
    );
    if (!collection) throw new Error(`Unknown RAG collection: ${name}`);
    await this.store.setMounted(this.workspaceRoot, collection.id, true);
  }

  async unmount(name: string): Promise<void> {
    this.requireLocalManagement();
    const collection = (await this.store.listExternalCollections()).find(
      (entry) => entry.name === name
    );
    if (!collection) throw new Error(`Unknown RAG collection: ${name}`);
    await this.store.setMounted(this.workspaceRoot, collection.id, false);
  }

  async getStatus(): Promise<RagStatus> {
    if (this.service) {
      try {
        const remote = this.config.enabled ? await this.service.status() : undefined;
        this.cachedStatus = {
          enabled: this.config.enabled,
          backend: 'remote',
          autoRetrieve: this.config.autoRetrieve,
          autoRefresh: false,
          lexicalAvailable: remote?.lexicalAvailable ?? false,
          vectorAvailable: remote?.vectorAvailable ?? false,
          rerankerConfigured: false,
          collections: remote?.collections ?? [],
          warnings: remote?.warnings ?? []
        };
      } catch (error) {
        this.cachedStatus = {
          ...this.cachedStatus,
          backend: 'remote',
          autoRefresh: false,
          lexicalAvailable: false,
          vectorAvailable: false,
          collections: this.cachedStatus.collections.map((c) => ({ ...c, health: 'error' })),
          warnings: [error instanceof Error ? error.message : 'Remote RAG unavailable']
        };
      }
      return structuredClone(this.cachedStatus);
    }
    const collections = await this.listCollections();
    const statuses: RagCollectionStatus[] = [];
    for (const collection of collections) {
      try {
        const revision = await this.store.loadRevision(collection.id);
        const changedFiles = revision
          ? await this.changedFileCount(collection, revision.manifest, AbortSignal.timeout(20_000))
          : 0;
        statuses.push({
          id: collection.id,
          name: collection.name,
          kind: collection.kind,
          mounted: true,
          health: revision
            ? changedFiles > 0
              ? 'stale'
              : revision.manifest.vectorState === 'error' ||
                  revision.manifest.vectorState === 'unavailable'
                ? 'degraded'
                : 'fresh'
            : 'missing',
          ...(revision ? { revision: revision.manifest.revision } : {}),
          fileCount: revision?.manifest.fileCount ?? 0,
          chunkCount: revision?.manifest.chunkCount ?? 0,
          ...(revision ? { vectorState: revision.manifest.vectorState } : {}),
          warnings: revision?.manifest.warnings ?? []
        });
      } catch (error) {
        statuses.push({
          id: collection.id,
          name: collection.name,
          kind: collection.kind,
          mounted: true,
          health: 'error',
          fileCount: 0,
          chunkCount: 0,
          warnings: [error instanceof Error ? error.message : String(error)]
        });
      }
    }
    this.cachedStatus = {
      enabled: this.config.enabled,
      autoRetrieve: this.config.autoRetrieve,
      autoRefresh: this.config.autoRefresh,
      lexicalAvailable: true,
      vectorAvailable: this.vectorAvailable && Boolean(this.config.embedding),
      rerankerConfigured: Boolean(this.config.reranker),
      collections: statuses,
      warnings: [...this.runtimeWarnings]
    };
    return structuredClone(this.cachedStatus);
  }

  getCachedStatus(): RagStatus {
    return structuredClone(this.cachedStatus);
  }

  async index(options: RagIndexOptions): Promise<RagIndexResult> {
    this.requireLocalManagement();
    if (!this.config.enabled) throw new Error('RAG is disabled');
    const collections = await this.listCollections();
    const collection = collections.find(
      (entry) => entry.name === (options.collection ?? 'workspace')
    );
    if (!collection) throw new Error(`RAG collection is not mounted: ${options.collection}`);
    const operation = options.operation ?? 'index';
    const startedAt = this.now();
    const revision = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${this.idFactory().slice(0, 8)}`;
    let buildingDirectory: string | undefined;
    const releaseLock = await this.store.acquireIndexLock(collection.id);
    const reportProgress = (progress: RagIndexProgress) => {
      options.onProgress?.(progress);
      options.emitEvent?.({ type: 'rag_index_progress', ...progress });
    };
    options.emitEvent?.({
      type: 'rag_index_started',
      collection: collection.name,
      operation
    });
    try {
      reportProgress({ collection: collection.name, stage: 'scan', completed: 0 });
      const files = await this.scanCollection(collection, options.signal);
      const sourceBytes = files.reduce((sum, file) => sum + file.bytes, 0);
      const rootHash = shortRagHash(await realpath(collection.canonicalRoot));
      const ingestionDigest = shortRagHash(INGESTION_DIGEST);
      if (this.config.embedding && files.length > 0) {
        const consentInput = {
          collectionId: collection.id,
          rootHash,
          endpoint: this.config.embedding.env.BASE_URL,
          model: this.config.embedding.model,
          ingestionDigest
        };
        if (!(await this.store.hasConsent(consentInput))) {
          const approved = await options.confirmRemote?.({
            purpose: 'embedding',
            collection,
            endpoint: this.config.embedding.env.BASE_URL,
            model: this.config.embedding.model,
            fileCount: files.length,
            sourceBytes
          });
          if (!approved) throw new Error('Remote RAG ingestion was not approved');
          await this.store.saveConsent(consentInput);
        }
      }
      if (this.config.reranker && files.length > 0) {
        const consentInput = {
          collectionId: collection.id,
          rootHash,
          endpoint: this.config.reranker.env.BASE_URL,
          model: this.config.reranker.model,
          ingestionDigest
        };
        if (!(await this.store.hasConsent(consentInput))) {
          const approved = await options.confirmRemote?.({
            purpose: 'reranker',
            collection,
            endpoint: this.config.reranker.env.BASE_URL,
            model: this.config.reranker.model,
            fileCount: files.length,
            sourceBytes
          });
          if (!approved) throw new Error('Remote RAG reranking was not approved');
          await this.store.saveConsent(consentInput);
        }
      }

      reportProgress({
        collection: collection.name,
        stage: 'chunk',
        completed: 0,
        total: files.length
      });
      const chunks: RagChunk[] = [];
      const indexedFiles = [];
      const previous = await this.store.loadRevision(collection.id);
      const previousFiles = new Map(
        (previous?.manifest.files ?? []).map((file) => [file.virtualPath, file])
      );
      const previousChunks = new Map((previous?.chunks ?? []).map((chunk) => [chunk.id, chunk]));
      for (let index = 0; index < files.length; index += 1) {
        throwIfAborted(options.signal);
        const file = files[index];
        const virtualPath = `${collection.virtualRoot}/${file.relativePath}`;
        const previousFile = previousFiles.get(virtualPath);
        const reusable =
          previousFile?.sourceHash === file.hash
            ? previousFile.chunkIds
                .map((id) => previousChunks.get(id))
                .filter((chunk): chunk is RagChunk => Boolean(chunk))
            : [];
        const fileChunks =
          reusable.length === previousFile?.chunkIds.length
            ? reusable.map((chunk) => ({
                ...chunk,
                revision,
                sourceMtimeMs: file.mtimeMs,
                ...(this.config.embedding
                  ? { embeddingModel: this.config.embedding.model }
                  : { embeddingModel: undefined })
              }))
            : chunkRagSource({
                collectionId: collection.id,
                virtualPath,
                content: file.content,
                sourceHash: file.hash,
                sourceBytes: file.bytes,
                sourceMtimeMs: file.mtimeMs,
                revision,
                ...(this.config.embedding ? { embeddingModel: this.config.embedding.model } : {})
              });
        chunks.push(...fileChunks);
        indexedFiles.push(
          indexedFileFromChunks(virtualPath, file.hash, file.bytes, file.mtimeMs, fileChunks)
        );
        if (chunks.length > MAX_CHUNKS)
          throw new Error(`RAG collection exceeds ${MAX_CHUNKS} chunks`);
        reportProgress({
          collection: collection.name,
          stage: 'chunk',
          completed: index + 1,
          total: files.length
        });
      }

      const miniSearch = new MiniSearch<LexicalDocument>(lexicalOptions());
      miniSearch.addAll(
        chunks.map((chunk) => ({
          id: chunk.id,
          path: chunk.virtualPath,
          heading: chunk.heading ?? '',
          symbol: chunk.symbol ?? '',
          text: chunk.text
        }))
      );

      let vectorState: RagIndexManifestV1['vectorState'] = 'unconfigured';
      let embeddingDimensions: number | undefined;
      let reusedEmbeddings = 0;
      const vectors: Record<string, number[]> = {};
      buildingDirectory = await this.store.createRevisionDirectory(collection.id, revision);
      if (this.config.embedding && chunks.length > 0) {
        reportProgress({
          collection: collection.name,
          stage: 'embed',
          completed: 0,
          total: chunks.length
        });
        const previousVectors = previous ? await this.store.readVectors(previous.directory) : {};
        for (const chunk of chunks) {
          const cached = previousVectors[chunk.id];
          if (cached && previous?.manifest.embeddingModel === this.config.embedding.model) {
            vectors[chunk.id] = cached;
            reusedEmbeddings += 1;
          }
        }
        try {
          const missing = chunks.filter((chunk) => !vectors[chunk.id]);
          for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
            throwIfAborted(options.signal);
            const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
            const embedded = await createEmbeddings(
              this.config.embedding,
              batch.map((chunk) => chunk.text),
              options.signal
            );
            batch.forEach((chunk, index) => {
              vectors[chunk.id] = embedded[index];
            });
            reportProgress({
              collection: collection.name,
              stage: 'embed',
              completed: reusedEmbeddings + Math.min(missing.length, offset + batch.length),
              total: chunks.length
            });
          }
          embeddingDimensions = Object.values(vectors)[0]?.length;
          await this.store.writeVectors(buildingDirectory, vectors);
          await buildLanceVectorStore(
            buildingDirectory,
            chunks.map((chunk) => ({ chunkId: chunk.id, vector: vectors[chunk.id] }))
          );
          vectorState = 'ready';
          this.vectorAvailable = true;
        } catch (error) {
          vectorState = ragErrorCode(error).includes('module') ? 'unavailable' : 'error';
          this.vectorAvailable = false;
          this.runtimeWarnings = [
            `Vector indexing degraded to lexical-only: ${error instanceof Error ? error.message : String(error)}`
          ];
        }
      }
      const warnings = [...this.runtimeWarnings];
      const manifest: RagIndexManifestV1 = {
        schemaVersion: 1,
        collectionId: collection.id,
        collectionName: collection.name,
        collectionKind: collection.kind,
        revision,
        createdAt: new Date(startedAt).toISOString(),
        rootHash,
        fileCount: files.length,
        sourceBytes,
        chunkCount: chunks.length,
        lexicalReady: true,
        vectorState,
        ...(this.config.embedding ? { embeddingModel: this.config.embedding.model } : {}),
        ...(embeddingDimensions ? { embeddingDimensions } : {}),
        files: indexedFiles,
        warnings
      };
      reportProgress({
        collection: collection.name,
        stage: 'persist',
        completed: 0,
        total: 1
      });
      await this.store.commitRevision(
        collection.id,
        revision,
        buildingDirectory,
        manifest,
        chunks,
        JSON.stringify(miniSearch)
      );
      buildingDirectory = undefined;
      reportProgress({
        collection: collection.name,
        stage: 'persist',
        completed: 1,
        total: 1
      });
      const result = {
        collection: collection.name,
        revision,
        fileCount: files.length,
        chunkCount: chunks.length,
        sourceBytes,
        vectorState,
        reusedEmbeddings,
        warnings
      };
      options.emitEvent?.({
        type: 'rag_index_completed',
        collection: collection.name,
        revision,
        fileCount: files.length,
        chunkCount: chunks.length,
        vectorState,
        durationMs: this.now() - startedAt
      });
      return result;
    } catch (error) {
      if (buildingDirectory) await this.store.removeBuildingDirectory(buildingDirectory);
      options.emitEvent?.({
        type: 'rag_index_failed',
        collection: collection.name,
        operation,
        code: ragErrorCode(error),
        durationMs: this.now() - startedAt
      });
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { operation });
    } finally {
      await releaseLock();
    }
  }

  async search(options: RagSearchOptions): Promise<RagRetrievalHit[]> {
    if (!this.config.enabled) throw new Error('RAG is disabled');
    throwIfAborted(options.signal);
    const initialQueries = [options.query, ...(options.queries ?? [])]
      .filter((query): query is string => typeof query === 'string' && Boolean(query.trim()))
      .map((query) => query.trim());
    if (initialQueries.length === 0) throw new Error('RagSearch requires at least one query');
    if (
      initialQueries.length > MAX_SEARCH_QUERIES ||
      initialQueries.some((q) => q.length > 8_192)
    ) {
      throw new Error('RagSearch accepts at most four queries of 8192 characters each');
    }
    const queries = [...new Set(initialQueries)];
    const first = await this.searchOnce({ ...options, query: undefined, queries });
    throwIfAborted(options.signal);
    // Recover one empty query, never successful retrieval or a failed backend request.
    // Multi-query searches remain intact rather than merging independent constraints.
    if (first.length || !this.queryRewriter || queries.length !== 1 || queries[0].length > 4_096) {
      return first;
    }
    let rewritten: string[];
    try {
      rewritten = await this.queryRewriter({
        query: queries[0],
        signal: options.signal,
        emitEvent: options.emitEvent
      });
    } catch {
      throwIfAborted(options.signal);
      const warning = 'Empty-search recovery failed; the original search returned no evidence.';
      this.runtimeWarnings = [...this.runtimeWarnings.filter((item) => item !== warning), warning];
      return first;
    }
    throwIfAborted(options.signal);
    if (
      !Array.isArray(rewritten) ||
      rewritten.length > 3 ||
      rewritten.some((query) => typeof query !== 'string' || !query.trim() || query.length > 512)
    )
      return first;
    const recovered = [...new Set([...queries, ...rewritten.map((query) => query.trim())])];
    if (recovered.length === queries.length) return first;
    return this.searchOnce({ ...options, query: undefined, queries: recovered });
  }

  private async searchOnce(options: RagSearchOptions): Promise<RagRetrievalHit[]> {
    throwIfAborted(options.signal);
    const startedAt = this.now();
    const queries = options.queries ?? [];
    const scope = resolveSearchScope(options.collections, options.path);
    const pathFilter = normalizePathFilter(scope.path);
    const limit = Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    if (this.service) {
      options.emitEvent?.({
        type: 'rag_retrieval_started',
        queryCount: queries.length,
        collectionCount: scope.collections?.length ?? this.config.service?.collections.length ?? 0
      });
      try {
        const results = await this.service.search({
          queries,
          collections: scope.collections,
          path: pathFilter,
          limit,
          signal: options.signal
        });
        options.emitEvent?.({
          type: 'rag_retrieval_completed',
          candidateCount: results.length,
          resultCount: results.length,
          channels: [...new Set(results.flatMap((r) => r.channels))],
          staleCollections: 0,
          durationMs: this.now() - startedAt
        });
        return results;
      } catch (error) {
        options.emitEvent?.({
          type: 'rag_retrieval_failed',
          code: 'rag_service_error',
          durationMs: this.now() - startedAt
        });
        throw error;
      }
    }
    const requestedCollections = scope.collections ? new Set(scope.collections) : undefined;
    const collections = (await this.listCollections()).filter(
      (collection) => !requestedCollections || requestedCollections.has(collection.name)
    );
    if (collections.length === 0) throw new Error('No requested RAG collections are mounted');
    if (requestedCollections && collections.length !== requestedCollections.size) {
      throw new Error('One or more requested RAG collections are not mounted');
    }
    options.emitEvent?.({
      type: 'rag_retrieval_started',
      queryCount: queries.length,
      collectionCount: collections.length
    });
    try {
      const rankings: Array<Array<{ id: string; score: number; channel: 'lexical' | 'vector' }>> =
        [];
      const chunksById = new Map<string, RagChunk>();
      const revisionsByChunk = new Map<string, string>();
      let staleCollections = 0;
      for (const collection of collections) {
        throwIfAborted(options.signal);
        let revision = await this.store.loadRevision(collection.id);
        if (!revision) continue;
        const changedFiles = await this.changedFileCount(
          collection,
          revision.manifest,
          options.signal
        );
        if (changedFiles > 0) {
          if (this.config.autoRefresh && changedFiles <= 500) {
            try {
              await this.index({
                collection: collection.name,
                operation: 'refresh',
                signal: options.signal,
                emitEvent: options.emitEvent
              });
              revision = await this.store.loadRevision(collection.id);
              if (!revision) continue;
            } catch (error) {
              staleCollections += 1;
              this.runtimeWarnings = [
                `RAG collection ${collection.name} is stale (${changedFiles} changed files): ${error instanceof Error ? error.message : String(error)}`
              ];
            }
          } else {
            staleCollections += 1;
            this.runtimeWarnings = [
              `RAG collection ${collection.name} is stale (${changedFiles} changed files); run an explicit refresh.`
            ];
          }
        }
        if (!revision) continue;
        revision.chunks.forEach((chunk) => {
          chunksById.set(chunk.id, chunk);
          revisionsByChunk.set(chunk.id, revision.manifest.revision);
        });
        const miniSearch = MiniSearch.loadJSON<LexicalDocument>(
          await (
            await import('node:fs/promises')
          ).readFile(`${revision.directory}/lexical.json`, 'utf8'),
          lexicalOptions()
        );
        for (const query of queries) {
          const lexical = miniSearch
            .search(query)
            .filter((result) => hasSufficientLexicalCoverage(query, result))
            .filter((result) => {
              const chunk = chunksById.get(String(result.id));
              return (
                !pathFilter ||
                chunk?.virtualPath.startsWith(`${collection.virtualRoot}/${pathFilter}`)
              );
            })
            .slice(0, Math.max(limit * 4, 50))
            .map((result: SearchResult) => ({
              id: String(result.id),
              score: result.score,
              channel: 'lexical' as const
            }));
          rankings.push(lexical);
          if (
            revision.manifest.vectorState === 'ready' &&
            this.config.embedding &&
            revision.manifest.embeddingModel === this.config.embedding.model
          ) {
            try {
              const [queryVector] = await createEmbeddings(
                this.config.embedding,
                [query],
                options.signal
              );
              const vector = (
                await searchLanceVectorStore(
                  revision.directory,
                  queryVector,
                  Math.max(limit * 4, 50)
                )
              ).map((result) => ({ ...result, id: result.chunkId, channel: 'vector' as const }));
              rankings.push(vector);
            } catch (error) {
              this.vectorAvailable = false;
              this.runtimeWarnings = [
                `Vector retrieval degraded to lexical-only: ${error instanceof Error ? error.message : String(error)}`
              ];
            }
          }
        }
        if (revision.manifest.warnings.some((warning) => warning.includes('stale')))
          staleCollections += 1;
      }

      let merged: Array<{
        id: string;
        score: number;
        channels: Array<'lexical' | 'vector' | 'rerank'>;
        rerank?: number;
      }> = rrfMerge(rankings).filter((entry) => {
        const chunk = chunksById.get(entry.id);
        if (!chunk) return false;
        if (!pathFilter) return true;
        const collection = collections.find((candidate) => candidate.id === chunk.collectionId);
        return Boolean(
          collection && chunk.virtualPath.startsWith(`${collection.virtualRoot}/${pathFilter}`)
        );
      });
      const channels = new Set<'lexical' | 'vector' | 'rerank'>(
        merged.flatMap((entry) => entry.channels)
      );
      if (this.config.reranker && merged.length > 0) {
        const candidates = merged.slice(0, MAX_RERANK_CANDIDATES);
        try {
          const candidateCollectionIds = new Set(
            candidates
              .map((entry) => chunksById.get(entry.id)?.collectionId)
              .filter((id): id is string => Boolean(id))
          );
          const ingestionDigest = shortRagHash(INGESTION_DIGEST);
          for (const collectionId of candidateCollectionIds) {
            const collection = collections.find((entry) => entry.id === collectionId);
            if (!collection) throw new Error('Reranker collection is unavailable');
            const approved = await this.store.hasConsent({
              collectionId,
              rootHash: shortRagHash(await realpath(collection.canonicalRoot)),
              endpoint: this.config.reranker.env.BASE_URL,
              model: this.config.reranker.model,
              ingestionDigest
            });
            if (!approved) {
              throw new Error(
                `Reranker consent is missing for ${collection.name}; run an explicit RAG refresh.`
              );
            }
          }
          const reranked = await rerankDocuments(
            this.config.reranker,
            queries.join('\n'),
            candidates.map((entry) => chunksById.get(entry.id)?.text ?? ''),
            options.signal
          );
          const byIndex = new Map(
            reranked.map((entry, index) => [entry.index, { ...entry, rank: index }])
          );
          merged = candidates
            .map((entry, index) => ({
              ...entry,
              score: byIndex.get(index)?.score ?? entry.score,
              rerank: byIndex.get(index)?.rank ?? Number.MAX_SAFE_INTEGER,
              channels: [...entry.channels, 'rerank' as const]
            }))
            .sort(
              (left, right) =>
                (left.rerank ?? Number.MAX_SAFE_INTEGER) -
                  (right.rerank ?? Number.MAX_SAFE_INTEGER) || right.score - left.score
            );
          channels.add('rerank');
        } catch (error) {
          this.runtimeWarnings = [
            ...this.runtimeWarnings.filter((warning) => !warning.startsWith('Rerank degraded')),
            `Rerank degraded to hybrid ordering: ${error instanceof Error ? error.message : String(error)}`
          ];
        }
      }
      const results = merged.slice(0, limit).map((entry, index): RagRetrievalHit => {
        const chunk = chunksById.get(entry.id);
        if (!chunk)
          throw new Error(`RAG candidate disappeared before result assembly: ${entry.id}`);
        return {
          chunkId: chunk.id,
          collection: collectionNameFromVirtualPath(chunk.virtualPath),
          virtualPath: chunk.virtualPath,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          ...(chunk.heading ? { heading: chunk.heading } : {}),
          ...(chunk.symbol ? { symbol: chunk.symbol } : {}),
          summary: summarizeChunk(chunk),
          score: entry.score,
          rank: index + 1,
          channels: entry.channels,
          revision: revisionsByChunk.get(chunk.id) ?? chunk.revision
        };
      });
      options.emitEvent?.({
        type: 'rag_retrieval_completed',
        candidateCount: merged.length,
        resultCount: results.length,
        channels: [...channels],
        staleCollections,
        durationMs: this.now() - startedAt
      });
      return results;
    } catch (error) {
      options.emitEvent?.({
        type: 'rag_retrieval_failed',
        code: ragErrorCode(error),
        durationMs: this.now() - startedAt
      });
      throw error;
    }
  }

  recordSearchResults(turnId: string, results: readonly RagRetrievalHit[]): void {
    const searched = this.searchedChunks.get(turnId) ?? new Set<string>();
    results.forEach((result) => searched.add(result.chunkId));
    this.searchedChunks.set(turnId, searched);
  }

  assertChunksWereSearched(turnId: string, chunkIds: readonly string[]): void {
    const searched = this.searchedChunks.get(turnId) ?? new Set<string>();
    const unavailable = chunkIds.filter((chunkId) => !searched.has(chunkId));
    if (unavailable.length > 0) {
      throw new Error(
        'RagRead accepts only chunk IDs returned by a RagSearch in the current turn.'
      );
    }
  }

  async readChunks(
    chunkIds: readonly string[],
    turnId: string,
    signal: AbortSignal
  ): Promise<{ chunks: RagChunk[]; receipts: RagContextReceipt[] }> {
    if (this.service) {
      if (!this.config.enabled) throw new Error('RAG is disabled');
      const result = await this.service.read(chunkIds, signal);
      const receipts = result.chunks.map((chunk): RagContextReceipt => ({
        turnId,
        serviceId: result.serviceId,
        chunkId: chunk.id,
        collectionId: chunk.collectionId,
        virtualPath: chunk.virtualPath,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        sourceHash: chunk.sourceHash,
        revision: chunk.revision
      }));
      const turnReceipts = this.receipts.get(turnId) ?? new Map<string, RagContextReceipt>();
      const turnChunks = this.remoteChunks.get(turnId) ?? new Map<string, RagChunk>();
      receipts.forEach((receipt) => turnReceipts.set(receipt.chunkId, receipt));
      result.chunks.forEach((chunk) => turnChunks.set(chunk.id, chunk));
      this.receipts.set(turnId, turnReceipts);
      this.remoteChunks.set(turnId, turnChunks);
      return { chunks: result.chunks, receipts };
    }
    const wanted = new Set(chunkIds.slice(0, 10));
    const found: RagChunk[] = [];
    const receipts: RagContextReceipt[] = [];
    for (const collection of await this.listCollections()) {
      throwIfAborted(signal);
      const revision = await this.store.loadRevision(collection.id);
      if (!revision) continue;
      for (const chunk of revision.chunks) {
        if (!wanted.has(chunk.id)) continue;
        found.push(chunk);
        receipts.push({
          turnId,
          chunkId: chunk.id,
          collectionId: collection.id,
          virtualPath: chunk.virtualPath,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          sourceHash: chunk.sourceHash,
          revision: revision.manifest.revision
        });
      }
    }
    const turnReceipts = this.receipts.get(turnId) ?? new Map<string, RagContextReceipt>();
    receipts.forEach((receipt) => turnReceipts.set(receipt.chunkId, receipt));
    this.receipts.set(turnId, turnReceipts);
    return { chunks: found, receipts };
  }

  async verify(
    draft: string,
    turnId: string,
    signal: AbortSignal,
    emitEvent?: (event: AgentEventData) => void
  ): Promise<RagVerificationResult> {
    if (this.verifiedTurns.has(turnId))
      throw new Error('RagVerify may be called only once per turn');
    this.verifiedTurns.add(turnId);
    return this.verifyDraft(draft, turnId, signal, emitEvent);
  }

  async verifyRepairedAnswer(
    draft: string,
    turnId: string,
    signal: AbortSignal,
    emitEvent?: (event: AgentEventData) => void
  ): Promise<RagVerificationResult> {
    return this.verifyDraft(draft, turnId, signal, emitEvent);
  }

  canRepairGroundedAnswer(): boolean {
    return Boolean(this.answerRepairer);
  }

  async repairGroundedAnswer(
    question: string,
    turnId: string,
    signal: AbortSignal,
    emitEvent?: (event: AgentEventData) => void
  ): Promise<string> {
    if (!this.answerRepairer) throw new Error('RAG answer repair is unavailable');
    const chunks = await this.loadTurnChunks(turnId, signal);
    if (chunks.length === 0) throw new Error('No RAG evidence is available for answer repair');
    return this.answerRepairer({
      question: question.slice(0, 8 * 1024),
      chunks,
      signal,
      emitEvent
    });
  }

  private async loadTurnChunks(turnId: string, signal: AbortSignal): Promise<RagChunk[]> {
    throwIfAborted(signal);
    if (this.service) return [...(this.remoteChunks.get(turnId)?.values() ?? [])];
    const chunks: RagChunk[] = [];
    const turnReceipts = this.receipts.get(turnId) ?? new Map();
    for (const receipt of turnReceipts.values()) {
      throwIfAborted(signal);
      const revision = await this.store.loadRevision(receipt.collectionId, receipt.revision);
      const chunk = revision?.chunks.find((entry) => entry.id === receipt.chunkId);
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }

  private async verifyDraft(
    draft: string,
    turnId: string,
    signal: AbortSignal,
    emitEvent?: (event: AgentEventData) => void
  ): Promise<RagVerificationResult> {
    const deterministic = await this.validateCitations(draft, turnId, signal);
    const validChunkIds = new Set(
      deterministic.filter((entry) => entry.status === 'valid').map((entry) => entry.chunkId)
    );
    const turnReceipts = this.receipts.get(turnId) ?? new Map();
    const evidenceChunkIds = validChunkIds.size > 0 ? validChunkIds : new Set(turnReceipts.keys());
    const chunks = (await this.loadTurnChunks(turnId, signal)).filter((chunk) =>
      evidenceChunkIds.has(chunk.id)
    );
    const invalid = deterministic.filter((entry) => entry.status !== 'valid');
    const verifierClaims = this.semanticVerifier
      ? await this.semanticVerifier({
          draft: draft.slice(0, 20 * 1024),
          chunks,
          signal,
          emitEvent
        })
      : undefined;
    const unsupportedCodeClaims = findUnsupportedCodeClaims(draft, chunks);
    const claims =
      verifierClaims || unsupportedCodeClaims.length > 0
        ? [...(verifierClaims ?? []), ...unsupportedCodeClaims]
        : undefined;
    const claimOutcomes = claims?.map((claim) => claim.outcome) ?? [];
    const availableChunkIds = new Set(chunks.map((chunk) => chunk.id));
    const semanticClaims = claims ?? [];
    const claimsHaveEvidence =
      semanticClaims.length > 0 &&
      semanticClaims.every(
        (claim) =>
          claim.outcome === 'unsupported' ||
          claim.outcome === 'unverifiable' ||
          validChunkIds.size > 0 ||
          claim.citations.some((citation) => availableChunkIds.has(citation))
      );
    const outcome: RagVerificationResult['outcome'] = claimOutcomes.includes('unsupported')
      ? 'unsupported'
      : claims && (!claimsHaveEvidence || claimOutcomes.includes('unverifiable'))
        ? 'unverifiable'
        : claimOutcomes.includes('partial')
          ? 'partial'
          : invalid.length > 0 || (deterministic.length === 0 && !claims)
            ? 'unverifiable'
            : 'supported';
    const result = { outcome, deterministic, ...(claims ? { claims } : {}) };
    this.verificationResults.set(turnId, structuredClone(result));
    return result;
  }

  canVerifySemantically(): boolean {
    return Boolean(this.semanticVerifier);
  }

  getTurnVerification(turnId: string): RagVerificationResult | undefined {
    const result = this.verificationResults.get(turnId);
    return result ? structuredClone(result) : undefined;
  }

  async validateCitations(
    draft: string,
    turnId: string,
    signal: AbortSignal
  ): Promise<RagCitationCheck[]> {
    const tokens = [...draft.matchAll(/\[\[rag:([a-f0-9]{16,64})\]\]/g)].map((match) => ({
      token: match[0],
      chunkId: match[1]
    }));
    const turnReceipts = this.receipts.get(turnId) ?? new Map();
    const deterministic: RagCitationCheck[] = [];
    if (this.service) {
      const receipts = tokens
        .map((token) => turnReceipts.get(token.chunkId))
        .filter((r): r is RagContextReceipt => Boolean(r));
      const checks = await this.service.verify(receipts, signal);
      let index = 0;
      return tokens.map((token) =>
        turnReceipts.has(token.chunkId) ? checks[index++] : { ...token, status: 'not-read' }
      );
    }
    for (const token of tokens) {
      throwIfAborted(signal);
      const receipt = turnReceipts.get(token.chunkId);
      if (!receipt) {
        deterministic.push({ ...token, status: 'not-read' });
        continue;
      }
      const revision = await this.store.loadRevision(receipt.collectionId, receipt.revision);
      if (!revision) {
        deterministic.push({ ...token, status: 'missing-revision' });
        continue;
      }
      const chunk = revision.chunks.find((entry) => entry.id === token.chunkId);
      if (!chunk) {
        deterministic.push({ ...token, status: 'unknown-chunk' });
        continue;
      }
      if (
        chunk.sourceHash !== receipt.sourceHash ||
        chunk.lineStart !== receipt.lineStart ||
        chunk.lineEnd !== receipt.lineEnd
      ) {
        deterministic.push({ ...token, status: 'stale-source' });
        continue;
      }
      const collection = (await this.listCollections()).find(
        (entry) => entry.id === receipt.collectionId
      );
      if (!collection) {
        deterministic.push({ ...token, status: 'stale-source' });
        continue;
      }
      const sourceRelativePath = chunk.virtualPath.slice(collection.virtualRoot.length + 1);
      try {
        const sourcePath = await realpath(resolve(collection.canonicalRoot, sourceRelativePath));
        const current = await readUtf8File(sourcePath);
        if (hashRagContent(Buffer.from(current.content, 'utf8')) !== receipt.sourceHash) {
          deterministic.push({ ...token, status: 'stale-source' });
          continue;
        }
      } catch {
        deterministic.push({ ...token, status: 'stale-source' });
        continue;
      }
      deterministic.push({ ...token, status: 'valid' });
    }
    return deterministic;
  }

  async inspectChunk(chunkId: string, signal: AbortSignal): Promise<RagChunk | undefined> {
    if (this.service) return (await this.service.read([chunkId], signal)).chunks[0];
    for (const collection of await this.listCollections()) {
      throwIfAborted(signal);
      const revision = await this.store.loadRevision(collection.id);
      const chunk = revision?.chunks.find((entry) => entry.id === chunkId);
      if (chunk) return chunk;
    }
    return undefined;
  }

  async clear(collectionName = 'workspace'): Promise<void> {
    this.requireLocalManagement();
    const collection = (await this.listCollections()).find(
      (entry) => entry.name === collectionName
    );
    if (!collection) throw new Error(`RAG collection is not mounted: ${collectionName}`);
    await this.store.clearCollection(collection.id);
    await this.getStatus();
  }

  shouldAutoRetrieve(mode: AgentMode): boolean {
    return (
      this.config.autoRetrieve === 'all' ||
      (this.config.autoRetrieve === 'ask-plan' && (mode === 'ask' || mode === 'plan'))
    );
  }

  setAutoRetrieve(mode: RagConfig['autoRetrieve']): void {
    this.config.autoRetrieve = mode;
    this.cachedStatus.autoRetrieve = mode;
  }

  clearTurn(turnId: string): void {
    this.remoteChunks.delete(turnId);
    this.receipts.delete(turnId);
    this.searchedChunks.delete(turnId);
    this.verifiedTurns.delete(turnId);
    this.verificationResults.delete(turnId);
  }

  private async changedFileCount(
    collection: RagCollection,
    manifest: RagIndexManifestV1,
    signal: AbortSignal
  ): Promise<number> {
    const listed = await listWorkspaceFiles(collection.canonicalRoot, '.', '**/*', signal);
    if (listed.sourceTruncated) return 501;
    const paths = listed.paths.filter((path) => !isExcludedPath(path) && isSupportedPath(path));
    const indexed = new Map(
      manifest.files.map((file) => [
        file.virtualPath.slice(collection.virtualRoot.length + 1),
        file
      ])
    );
    let changed = 0;
    const seen = new Set<string>();
    for (const path of paths) {
      throwIfAborted(signal);
      seen.add(path);
      const file = indexed.get(path);
      if (!file) {
        changed += 1;
      } else {
        try {
          const fileStats = await stat(resolve(collection.canonicalRoot, path));
          if (fileStats.size !== file.bytes || fileStats.mtimeMs !== file.mtimeMs) changed += 1;
        } catch {
          changed += 1;
        }
      }
      if (changed > 500) return changed;
    }
    for (const path of indexed.keys()) {
      if (!seen.has(path)) changed += 1;
      if (changed > 500) return changed;
    }
    return changed;
  }

  private async scanCollection(collection: RagCollection, signal: AbortSignal) {
    const listed = await listWorkspaceFiles(collection.canonicalRoot, '.', '**/*', signal);
    if (listed.sourceTruncated) throw new Error('RAG source file listing was truncated');
    const paths = listed.paths.filter((path) => !isExcludedPath(path) && isSupportedPath(path));
    if (paths.length > MAX_FILES) throw new Error(`RAG collection exceeds ${MAX_FILES} files`);
    const files: Array<{
      relativePath: string;
      content: string;
      hash: string;
      bytes: number;
      mtimeMs: number;
    }> = [];
    let totalBytes = 0;
    const canonicalRoot = await realpath(collection.canonicalRoot);
    for (const relativePath of paths) {
      throwIfAborted(signal);
      const candidate = await realpath(resolve(canonicalRoot, relativePath));
      const relativeCandidate = relative(canonicalRoot, candidate).replaceAll('\\', '/');
      if (relativeCandidate.startsWith('../') || relativeCandidate === '..') {
        throw new Error(`RAG source escapes its collection through a link: ${relativePath}`);
      }
      try {
        const file = await readUtf8File(candidate);
        totalBytes += file.bytes;
        if (totalBytes > MAX_SOURCE_BYTES) throw new Error('RAG collection exceeds 512 MiB');
        files.push({
          relativePath: relativeCandidate,
          content: file.content,
          hash: hashRagContent(Buffer.from(file.content, 'utf8')),
          bytes: file.bytes,
          mtimeMs: file.mtimeMs
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('valid encoded data') || message.includes('exceeds 2 MiB')) continue;
        throw error;
      }
    }
    return files;
  }
}

function collectionNameFromVirtualPath(path: string): string {
  return /^rag:\/\/([^/]+)/.exec(path)?.[1] ?? 'workspace';
}

export function ragEmbeddingConfigured(config: RagConfig): boolean {
  return Boolean(config.embedding && resolveRagCredential(config.embedding).value);
}

export type { RagEmbeddingConfig };
