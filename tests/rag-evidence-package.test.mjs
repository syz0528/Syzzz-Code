import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRagChunk, selectEvidencePackage } from '../dist/rag/evidence-package.js';

const chunk = (id, text = 'Complete source.') => ({
  id: id.repeat(32),
  virtualPath: 'rag://techdocs/doc.md',
  lineStart: 1,
  lineEnd: 1,
  sourceHash: 'a'.repeat(64),
  revision: 'r1',
  text
});

test('evidence package preserves requested order, deduplicates and never clips a source', () => {
  const a = chunk('a'),
    b = chunk('b'),
    c = chunk('c');
  const selected = selectEvidencePackage([a, b, c], [c.id, b.id, b.id, a.id, 'missing'], {
    maxChunks: 2,
    maxBytes: 6000
  });
  assert.deepEqual(selected.chunks, [c, b]);
  assert.deepEqual(selected.deferredChunkIds, [a.id]);
  const bytes = Buffer.byteLength(formatRagChunk(a));
  assert.equal(
    selectEvidencePackage([a], [a.id], { maxChunks: 2, maxBytes: bytes }).chunks.length,
    1
  );
  assert.equal(
    selectEvidencePackage([a], [a.id], { maxChunks: 2, maxBytes: bytes - 1 }).chunks.length,
    0
  );
});

test('evidence budgets count UTF-8 and separators; oversized evidence does not hide later small chunks', () => {
  const a = chunk('a', '中文'.repeat(2000)),
    b = chunk('b', 'small');
  const selected = selectEvidencePackage([a, b], [a.id, b.id], { maxChunks: 2, maxBytes: 6000 });
  assert.deepEqual(selected.chunks, [b]);
  assert.deepEqual(selected.deferredChunkIds, [a.id]);
  const c = chunk('c');
  const bytes = Buffer.byteLength(formatRagChunk(b)) + Buffer.byteLength(formatRagChunk(c));
  assert.equal(
    selectEvidencePackage([b, c], [b.id, c.id], { maxChunks: 2, maxBytes: bytes + 6 }).chunks
      .length,
    1
  );
  assert.equal(
    selectEvidencePackage([b, c], [b.id, c.id], { maxChunks: 2, maxBytes: bytes + 7 }).chunks
      .length,
    2
  );
});
