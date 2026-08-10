import { join } from 'node:path';

interface LanceQueryRow {
  chunkId?: unknown;
  _distance?: unknown;
}

export interface VectorSearchHit {
  chunkId: string;
  score: number;
}

export async function buildLanceVectorStore(
  directory: string,
  vectors: ReadonlyArray<{ chunkId: string; vector: number[] }>
): Promise<void> {
  if (vectors.length === 0) return;
  const lance = await import('@lancedb/lancedb');
  const database = await lance.connect(join(directory, 'lance'));
  await database.createTable(
    'chunks',
    vectors.map((entry) => ({ chunkId: entry.chunkId, vector: entry.vector })),
    { mode: 'overwrite' }
  );
}

export async function searchLanceVectorStore(
  directory: string,
  queryVector: number[],
  limit: number
): Promise<VectorSearchHit[]> {
  const lance = await import('@lancedb/lancedb');
  const database = await lance.connect(join(directory, 'lance'));
  const table = await database.openTable('chunks');
  const rows = (await table.vectorSearch(queryVector).limit(limit).toArray()) as LanceQueryRow[];
  return rows
    .map((row) => {
      const chunkId = typeof row.chunkId === 'string' ? row.chunkId : undefined;
      const distance = typeof row._distance === 'number' ? row._distance : undefined;
      return chunkId && distance !== undefined
        ? { chunkId, score: 1 / (1 + Math.max(0, distance)) }
        : undefined;
    })
    .filter((entry): entry is VectorSearchHit => Boolean(entry));
}

export async function probeLanceVectorStore(baseDirectory: string): Promise<void> {
  const directory = join(baseDirectory, `.probe-${process.pid}-${Date.now()}`);
  const { rm } = await import('node:fs/promises');
  try {
    await buildLanceVectorStore(directory, [
      { chunkId: 'a', vector: [1, 0, 0] },
      { chunkId: 'b', vector: [0, 1, 0] }
    ]);
    const result = await searchLanceVectorStore(directory, [1, 0, 0], 1);
    if (result[0]?.chunkId !== 'a') throw new Error('LanceDB probe returned an unexpected result');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
