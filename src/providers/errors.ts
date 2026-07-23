import { isAbortError } from '../tools/abort.js';

export type ProviderErrorCode =
  | 'authentication'
  | 'permission'
  | 'model_not_found'
  | 'not_found'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'context_exceeded'
  | 'malformed_response'
  | 'unsupported_feature'
  | 'provider_internal'
  | 'unknown';

export interface PublicProviderError {
  code: ProviderErrorCode;
  message: string;
  provider: string;
  status?: number;
  requestId?: string;
}

export interface ProviderErrorOptions {
  provider: string;
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
  feature?: string;
  recovery?: 'reasoning-only';
  cause?: unknown;
  message?: string;
}

const SAFE_ERROR_MESSAGES: Record<ProviderErrorCode, string> = {
  authentication: 'authentication failed',
  permission: 'permission denied',
  model_not_found: 'configured model was not found',
  not_found: 'requested API resource was not found',
  rate_limit: 'rate limit exceeded',
  timeout: 'request timed out',
  network: 'network failure',
  context_exceeded: 'model context limit exceeded',
  malformed_response: 'provider returned a malformed response',
  unsupported_feature: 'provider does not support a requested feature',
  provider_internal: 'provider returned an internal error',
  unknown: 'provider request failed'
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly feature?: string;
  readonly recovery?: 'reasoning-only';

  constructor(code: ProviderErrorCode, options: ProviderErrorOptions) {
    const message = options.message ??
      `${options.provider}: ${SAFE_ERROR_MESSAGES[code]}`;
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.feature = options.feature;
    this.recovery = options.recovery;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function getNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  const headerRecord = asRecord(headers);
  const getter = headerRecord?.get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }

  if (!headerRecord) {
    return undefined;
  }

  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headerRecord)) {
    if (key.toLowerCase() === normalizedName && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function parseRetryAfter(headers: unknown, now: number): number | undefined {
  const rawValue = readHeader(headers, 'retry-after');
  if (!rawValue) {
    return undefined;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const date = Date.parse(rawValue);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return undefined;
}

function classifyError(
  status: number | undefined,
  sdkCode: string | undefined,
  name: string,
  message: string
): { code: ProviderErrorCode; feature?: string } {
  const searchable = `${sdkCode ?? ''} ${name} ${message}`.toLowerCase();

  if (status === 401 || searchable.includes('authenticationerror')) {
    return { code: 'authentication' };
  }
  if (status === 403 || searchable.includes('permissiondenied')) {
    return { code: 'permission' };
  }
  if (
    searchable.includes('context_length_exceeded') ||
    searchable.includes('context window') ||
    searchable.includes('prompt is too long') ||
    searchable.includes('maximum context')
  ) {
    return { code: 'context_exceeded' };
  }
  if (
    sdkCode?.toLowerCase() === 'model_not_found' ||
    searchable.includes('model_not_found')
  ) {
    return { code: 'model_not_found' };
  }
  if (
    /stream[_ -]?options|include[_ -]?usage/.test(searchable) &&
    (status === 400 || status === 422 || searchable.includes('unsupported'))
  ) {
    return { code: 'unsupported_feature', feature: 'stream_options' };
  }
  if (
    searchable.includes('unsupported_parameter') ||
    searchable.includes('unsupported feature')
  ) {
    return { code: 'unsupported_feature' };
  }
  if (status === 404) {
    return /model|deployment/.test(searchable)
      ? { code: 'model_not_found' }
      : { code: 'not_found' };
  }
  if (status === 429 || searchable.includes('ratelimiterror')) {
    return { code: 'rate_limit' };
  }
  if (status !== undefined && status >= 500) {
    return { code: 'provider_internal' };
  }
  if (
    status === 408 ||
    searchable.includes('timeout') ||
    searchable.includes('timed out')
  ) {
    return { code: 'timeout' };
  }
  if (
    searchable.includes('apiconnectionerror') ||
    searchable.includes('fetcherror') ||
    searchable.includes('econnreset') ||
    searchable.includes('econnrefused') ||
    searchable.includes('enotfound') ||
    searchable.includes('network failure') ||
    searchable.includes('network request failed')
  ) {
    return { code: 'network' };
  }
  return { code: 'unknown' };
}

export function normalizeProviderError(
  error: unknown,
  provider: string,
  now: number = Date.now()
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  const record = asRecord(error);
  const status = getNumber(record, 'status');
  const sdkCode = getString(record, 'code');
  const requestId = getString(record, 'requestID', 'request_id');
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const classification = classifyError(status, sdkCode, name, message);

  return new ProviderError(classification.code, {
    provider,
    status,
    requestId,
    retryAfterMs: parseRetryAfter(record?.headers, now),
    feature: classification.feature,
    cause: error
  });
}

export function toPublicProviderError(error: ProviderError): PublicProviderError {
  return {
    code: error.code,
    message: error.message,
    provider: error.provider,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.requestId ? { requestId: error.requestId } : {})
  };
}

export function isRetryableProviderError(error: ProviderError): boolean {
  if (error.code === 'rate_limit' || error.code === 'timeout' || error.code === 'network') {
    return true;
  }

  return error.code === 'provider_internal' &&
    error.status !== undefined &&
    [500, 502, 503, 504].includes(error.status);
}

export function isProviderAbort(error: unknown): boolean {
  return isAbortError(error) || (
    error instanceof Error &&
    (error.name === 'APIUserAbortError' || error.name === 'AbortError')
  );
}
