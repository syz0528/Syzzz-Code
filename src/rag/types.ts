import type { RagAutoRetrieve } from '../config.js';

export const RAG_INDEX_SCHEMA_VERSION = 1 as const;

export type RagCollectionKind = 'workspace' | 'external';
export type RagIndexHealth = 'missing' | 'fresh' | 'stale' | 'degraded' | 'building' | 'error';

export interface RagCollection {
  id: string;
  name: string;
  kind: RagCollectionKind;
  canonicalRoot: string;
  virtualRoot: string;
  createdAt: string;
  managed?: boolean;
}

export interface RagChunk {
  id: string;
  collectionId: string;
  virtualPath: string;
  lineStart: number;
  lineEnd: number;
  heading?: string;
  symbol?: string;
  language: string;
  text: string;
  sourceHash: string;
  sourceBytes: number;
  sourceMtimeMs: number;
  revision: string;
  embeddingModel?: string;
}

export interface RagIndexedFile {
  virtualPath: string;
  sourceHash: string;
  bytes: number;
  mtimeMs: number;
  chunkIds: string[];
}

export interface RagIndexManifestV1 {
  schemaVersion: typeof RAG_INDEX_SCHEMA_VERSION;
  collectionId: string;
  collectionName: string;
  collectionKind: RagCollectionKind;
  revision: string;
  createdAt: string;
  rootHash: string;
  fileCount: number;
  sourceBytes: number;
  chunkCount: number;
  lexicalReady: boolean;
  vectorState: 'ready' | 'unconfigured' | 'unavailable' | 'error';
  embeddingModel?: string;
  embeddingDimensions?: number;
  files: RagIndexedFile[];
  warnings: string[];
}

export type RagRetrievalChannel = 'lexical' | 'vector' | 'hybrid' | 'rerank';

export interface RagRetrievalHit {
  chunkId: string;
  collection: string;
  virtualPath: string;
  lineStart: number;
  lineEnd: number;
  heading?: string;
  symbol?: string;
  summary: string;
  score: number;
  rank: number;
  channels: Array<'lexical' | 'vector' | 'rerank'>;
  revision: string;
}

export interface RagContextReceipt {
  turnId: string;
  chunkId: string;
  collectionId: string;
  virtualPath: string;
  lineStart: number;
  lineEnd: number;
  sourceHash: string;
  revision: string;
}

export interface RagCitationCheck {
  token: string;
  chunkId: string;
  status: 'valid' | 'not-read' | 'missing-revision' | 'stale-source' | 'unknown-chunk';
}

export interface RagVerificationClaim {
  claim: string;
  outcome: 'supported' | 'partial' | 'unsupported' | 'unverifiable';
  citations: string[];
}

export interface RagVerificationResult {
  outcome: 'supported' | 'partial' | 'unsupported' | 'unverifiable';
  deterministic: RagCitationCheck[];
  claims?: RagVerificationClaim[];
}

export interface RagCollectionStatus {
  id: string;
  name: string;
  kind: RagCollectionKind;
  mounted: boolean;
  health: RagIndexHealth;
  revision?: string;
  fileCount: number;
  chunkCount: number;
  vectorState?: RagIndexManifestV1['vectorState'];
  warnings: string[];
}

export interface RagStatus {
  enabled: boolean;
  autoRetrieve: RagAutoRetrieve;
  autoRefresh: boolean;
  lexicalAvailable: boolean;
  vectorAvailable: boolean;
  rerankerConfigured: boolean;
  collections: RagCollectionStatus[];
  warnings: string[];
}

export interface RagIndexProgress {
  collection: string;
  stage: 'scan' | 'chunk' | 'embed' | 'persist';
  completed: number;
  total?: number;
}

export interface RagIndexResult {
  collection: string;
  revision: string;
  fileCount: number;
  chunkCount: number;
  sourceBytes: number;
  vectorState: RagIndexManifestV1['vectorState'];
  reusedEmbeddings: number;
  warnings: string[];
}

export interface RagKnowledgeSaveInput {
  title: string;
  content: string;
  filename?: string;
  sourceChunkIds?: string[];
}

export interface RagPreparedWrite {
  schemaVersion: 1;
  collectionId: string;
  collectionName: string;
  targetPath: string;
  targetRelativePath: string;
  virtualPath: string;
  proposedContent: string;
  expectedContentHash: string | null;
  expectedSizeBytes: number | null;
  targetMode: number | null;
  sourceHash: string;
  sourceBytes: number;
  operation: 'create' | 'update' | 'unchanged';
  preview: string;
}

export interface RagIngestionResult {
  collection: string;
  virtualPath: string;
  operation: RagPreparedWrite['operation'];
  sourceHash: string;
  sourceBytes: number;
  indexStatus: 'refreshed' | 'pending-consent' | 'failed';
  revision?: string;
  warning?: string;
}
