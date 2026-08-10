import type { RagEmbeddingConfig, RagRerankerConfig } from '../config.js';
import { OperationAbortedError, throwIfAborted } from '../tools/abort.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export class RagRemoteError extends Error {
  readonly code: string;
  constructor(
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'RagRemoteError';
    this.code =
      status === 401
        ? 'authentication'
        : status === 403
          ? 'permission'
          : status === 429
            ? 'rate_limit'
            : status !== undefined && status >= 500
              ? 'provider_internal'
              : 'remote_error';
  }
}

export interface RagRemoteCredential {
  value: string;
  source: 'environment' | 'stored' | 'missing';
}

export function resolveRagCredential(
  config: Pick<RagEmbeddingConfig | RagRerankerConfig, 'env'>,
  environment: NodeJS.ProcessEnv = process.env
): RagRemoteCredential {
  const environmentValue = config.env.API_KEY_ENV
    ? environment[config.env.API_KEY_ENV]?.trim()
    : undefined;
  if (environmentValue) return { value: environmentValue, source: 'environment' };
  if (config.env.API_KEY.trim()) return { value: config.env.API_KEY.trim(), source: 'stored' };
  return { value: '', source: 'missing' };
}

function endpoint(baseUrl: string, suffix: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return Math.min(10_000, 500 * 2 ** (attempt - 1));
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new OperationAbortedError());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
        redirect: 'error'
      });
      if (response.ok) return (await response.json()) as unknown;
      const requestId = response.headers.get('x-request-id');
      const error = new RagRemoteError(
        `RAG remote request failed with HTTP ${response.status}${requestId ? ` (${requestId})` : ''}`,
        response.status,
        requestId ?? undefined,
        response.status === 429 || response.status >= 500
      );
      if (!error.retryable) throw error;
      lastError = error;
    } catch (error) {
      if (signal.aborted) throw new OperationAbortedError();
      if (error instanceof RagRemoteError && !error.retryable) throw error;
      lastError = error;
      if (attempt >= MAX_ATTEMPTS) break;
    }
    if (attempt < MAX_ATTEMPTS) await wait(retryDelay(response, attempt), signal);
  }
  throw lastError instanceof Error ? lastError : new Error('RAG remote request failed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function createEmbeddings(
  config: RagEmbeddingConfig,
  inputs: readonly string[],
  signal: AbortSignal
): Promise<number[][]> {
  const credential = resolveRagCredential(config);
  if (!credential.value) throw new Error('RAG embedding credentials are not configured');
  const payload = await postJson(
    endpoint(config.env.BASE_URL, '/embeddings'),
    credential.value,
    {
      model: config.model,
      input: inputs,
      ...(config.dimensions ? { dimensions: config.dimensions } : {})
    },
    signal
  );
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('Embedding endpoint returned a malformed response');
  }
  const rows = payload.data
    .map((item) => {
      if (!isRecord(item) || !Array.isArray(item.embedding)) return undefined;
      const index = typeof item.index === 'number' ? item.index : -1;
      const vector = item.embedding.map(Number);
      return index >= 0 && vector.every(Number.isFinite) ? { index, vector } : undefined;
    })
    .filter((item): item is { index: number; vector: number[] } => Boolean(item))
    .sort((left, right) => left.index - right.index);
  if (rows.length !== inputs.length || rows.some((row, index) => row.index !== index)) {
    throw new Error('Embedding endpoint returned an incomplete or reordered response');
  }
  const dimensions = rows[0]?.vector.length ?? 0;
  if (!dimensions || rows.some((row) => row.vector.length !== dimensions)) {
    throw new Error('Embedding endpoint returned inconsistent vector dimensions');
  }
  return rows.map((row) => row.vector);
}

export async function rerankDocuments(
  config: RagRerankerConfig,
  query: string,
  documents: readonly string[],
  signal: AbortSignal
): Promise<Array<{ index: number; score: number }>> {
  const credential = resolveRagCredential(config);
  if (!credential.value) throw new Error('RAG reranker credentials are not configured');
  const payload = await postJson(
    endpoint(config.env.BASE_URL, '/rerank'),
    credential.value,
    { model: config.model, query, documents, top_n: documents.length },
    signal
  );
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error('Reranker endpoint returned a malformed response');
  }
  return payload.results
    .map((result) => {
      if (!isRecord(result)) return undefined;
      const index = Number(result.index);
      const score = Number(result.relevance_score ?? result.score);
      return Number.isSafeInteger(index) && Number.isFinite(score) ? { index, score } : undefined;
    })
    .filter((entry): entry is { index: number; score: number } => Boolean(entry));
}
