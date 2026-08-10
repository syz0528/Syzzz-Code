export interface EvidenceReceipt {
  chunkId: string;
  revision: string;
  sourceHash: string;
}

export function createEvidenceReceipt(
  chunkId: string,
  revision: string,
  sourceHash: string
): EvidenceReceipt {
  return { chunkId, revision, sourceHash };
}
