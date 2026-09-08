import { z } from 'zod';
import type { RagServiceConfig } from '../config.js';
import { OperationAbortedError, throwIfAborted } from '../tools/abort.js';
import type { RagContextReceipt, RagRetrievalHit } from './types.js';

const id = z.string().regex(/^[a-f0-9]{16,64}$/);
const bounded = z.string().max(4096);
const location = z
  .string()
  .max(4096)
  .regex(/^rag:\/\/[A-Za-z][A-Za-z0-9_-]{0,63}\/.+/);
const chunkSchema = z
  .object({
    id,
    collectionId: bounded,
    virtualPath: location,
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    text: z.string().max(40 * 1024),
    heading: bounded.optional(),
    symbol: bounded.optional(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceBytes: z.number().int().nonnegative(),
    sourceMtimeMs: z.number().nonnegative(),
    revision: bounded,
    language: bounded
  })
  .refine((chunk) => chunk.lineEnd >= chunk.lineStart);
const hitSchema = z.object({
  chunkId: id,
  collection: bounded,
  virtualPath: location,
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  heading: bounded.optional(),
  symbol: bounded.optional(),
  summary: bounded,
  score: z.number().finite(),
  rank: z.number().int().positive(),
  channels: z.array(z.enum(['lexical', 'vector', 'rerank'])).max(3),
  revision: bounded
});
const checkSchema = z.object({
  token: bounded,
  chunkId: id,
  status: z.enum(['valid', 'not-read', 'missing-revision', 'stale-source', 'unknown-chunk'])
});
const statusSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string().min(1).max(128),
  lexicalAvailable: z.boolean(),
  vectorAvailable: z.boolean(),
  warnings: z.array(bounded).max(100),
  collections: z
    .array(
      z.object({
        id: bounded,
        name: bounded,
        kind: z.literal('external'),
        mounted: z.boolean(),
        health: z.enum(['missing', 'fresh', 'stale', 'degraded', 'building', 'error']),
        revision: bounded.optional(),
        fileCount: z.number().int().nonnegative(),
        chunkCount: z.number().int().nonnegative(),
        vectorState: z.enum(['ready', 'unconfigured', 'unavailable', 'error']).optional(),
        warnings: z.array(bounded).max(100)
      })
    )
    .max(100)
});

export class RagServiceError extends Error {
  readonly code = 'rag_service_error';
}

export class RagServiceClient {
  constructor(private readonly config: RagServiceConfig) {}

  private collections(requested?: readonly string[]): string[] {
    const names = requested ? [...requested] : this.config.collections;
    if (!names.length || names.some((name) => !this.config.collections.includes(name))) {
      throw new RagServiceError(
        'RAG collection is not enabled in the remote service configuration'
      );
    }
    return names;
  }

  private async request(
    path: string,
    body: unknown,
    schema: z.ZodTypeAny,
    signal: AbortSignal,
    maxBytes = 256 * 1024
  ): Promise<unknown> {
    throwIfAborted(signal);
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv]?.trim() : undefined;
    if (this.config.apiKeyEnv && !key)
      throw new RagServiceError('Remote RAG API key environment variable is missing');
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/knowledge/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, timeout]),
        redirect: 'error'
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RagServiceError(
          `Remote RAG ${path} failed (HTTP ${response.status}); check service status, collection scope and source freshness`
        );
      }
      if (!response.body) throw new RagServiceError('Remote RAG returned an empty response');
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes)
            throw new RagServiceError('Remote RAG response exceeded its byte budget');
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const parsed = schema.safeParse(JSON.parse(Buffer.concat(parts).toString('utf8')));
      if (!parsed.success)
        throw new RagServiceError('Remote RAG response did not match the protocol');
      return parsed.data as unknown;
    } catch (error) {
      if (signal.aborted) throw new OperationAbortedError();
      if (timeout.aborted) throw new RagServiceError('Remote RAG request timed out');
      if (error instanceof RagServiceError) throw error;
      throw new RagServiceError(
        'Remote RAG unavailable or returned invalid JSON; no local fallback was used'
      );
    }
  }

  async status(signal: AbortSignal = new AbortController().signal) {
    const payload = statusSchema.parse(
      await this.request('status', undefined, statusSchema, signal)
    );
    const collections = payload.collections.filter((c) => this.config.collections.includes(c.name));
    if (this.config.collections.some((name) => !collections.some((c) => c.name === name))) {
      throw new RagServiceError('Configured remote RAG collection is missing on the server');
    }
    return { ...payload, collections };
  }

  async search(options: {
    query?: string;
    queries?: string[];
    collections?: string[];
    path?: string;
    limit?: number;
    signal: AbortSignal;
  }): Promise<RagRetrievalHit[]> {
    const { signal, ...input } = options;
    const schema = z.object({ schemaVersion: z.literal(1), hits: z.array(hitSchema).max(50) });
    const names = this.collections(options.collections);
    const payload = schema.parse(
      await this.request('search', { ...input, collections: names }, schema, signal)
    );
    if (
      payload.hits.some(
        (hit) =>
          !names.includes(hit.collection) || !hit.virtualPath.startsWith(`rag://${hit.collection}/`)
      )
    ) {
      throw new RagServiceError('Remote RAG returned a result outside requested collections');
    }
    return payload.hits;
  }

  async read(chunkIds: readonly string[], signal: AbortSignal) {
    const schema = z.object({
      schemaVersion: z.literal(1),
      serviceId: z.string().min(1).max(128),
      chunks: z.array(chunkSchema).max(10),
      omittedChunkIds: z.array(id).max(10)
    });
    const names = this.collections();
    const payload = schema.parse(
      await this.request('read', { collections: names, chunkIds }, schema, signal, 40 * 1024)
    );
    if (
      new Set(payload.chunks.map((c) => c.id)).size !== payload.chunks.length ||
      payload.chunks.some(
        (c) =>
          !chunkIds.includes(c.id) ||
          !names.some((name) => c.virtualPath.startsWith(`rag://${name}/`))
      )
    ) {
      throw new RagServiceError('Remote RAG returned unexpected evidence');
    }
    return payload;
  }

  async verify(receipts: readonly RagContextReceipt[], signal: AbortSignal) {
    if (!receipts.length) return [];
    const schema = z.object({ schemaVersion: z.literal(1), checks: z.array(checkSchema).max(100) });
    const result = schema.parse(
      await this.request('verify', { collections: this.collections(), receipts }, schema, signal)
    );
    if (
      result.checks.length !== receipts.length ||
      result.checks.some(
        (check, index) =>
          check.chunkId !== receipts[index].chunkId || check.token !== `[[rag:${check.chunkId}]]`
      )
    ) {
      throw new RagServiceError('Remote RAG returned incomplete citation checks');
    }
    return result.checks;
  }
}
