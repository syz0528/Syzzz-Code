import type { RagChunk } from './types.js';

export interface RagReadBudget {
  maxChunks: number;
  maxBytes: number;
}

export function formatRagChunk(chunk: RagChunk): string {
  return (
    `[[rag:${chunk.id}]]\n` +
    `${chunk.virtualPath}:L${chunk.lineStart}-L${chunk.lineEnd}\n` +
    `source-sha256=${chunk.sourceHash} revision=${chunk.revision}\n${chunk.text}`
  );
}

// Never shorten a chunk while retaining a citation for its complete source range.
export function selectEvidencePackage(
  chunks: readonly RagChunk[],
  requestedIds: readonly string[],
  budget: RagReadBudget
): { chunks: RagChunk[]; deferredChunkIds: string[] } {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const selected: RagChunk[] = [];
  const deferredChunkIds: string[] = [];
  let bytes = 0;
  for (const id of new Set(requestedIds)) {
    const chunk = byId.get(id);
    if (!chunk) continue;
    const size = Buffer.byteLength(formatRagChunk(chunk), 'utf8') + (selected.length ? 7 : 0);
    if (selected.length >= budget.maxChunks || bytes + size > budget.maxBytes) {
      deferredChunkIds.push(id);
      continue;
    }
    selected.push(chunk);
    bytes += size;
  }
  return { chunks: selected, deferredChunkIds };
}
