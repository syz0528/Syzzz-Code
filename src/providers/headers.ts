import { validateHeaderName, validateHeaderValue } from 'node:http';
import { normalizeProviderError, ProviderError } from './errors.js';

const RESERVED = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'accept',
  'accept-encoding',
  'connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'expect',
  'anthropic-version',
  'anthropic-beta'
]);

export function validateProviderHeaders(
  value: unknown,
  field = 'headers'
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object or null`);
  }
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error(`${field} must contain at most 64 entries`);
  const result: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  let bytes = 0;
  for (const [name, raw] of entries) {
    try {
      validateHeaderName(name);
    } catch {
      throw new Error(`${field} contains an invalid header name`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`${field}.${key} is duplicated (case-insensitive)`);
    seen.add(key);
    if (typeof raw !== 'string') throw new Error(`${field}.${key} must be a string`);
    // Reject controls before trimming: a trailing newline is not an empty value.
    if (/[\x00-\x1f\x7f-\x9f]/.test(raw)) {
      throw new Error(`${field}.${key} contains a control character`);
    }
    try {
      validateHeaderValue(name, raw);
    } catch {
      throw new Error(`${field}.${key} contains an invalid header value`);
    }
    const text = raw.trim();
    if (!text) continue;
    if (RESERVED.has(key) || key.startsWith('x-stainless-')) {
      throw new Error(`${field}.${key} is managed by the HTTP client or provider credentials`);
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(text) + 4;
    if (bytes > 16_384) throw new Error(`${field} exceeds the 16 KiB limit`);
    result[key] = text;
  }
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}

function redact(text: string, headers: Readonly<Record<string, string>>): string {
  for (const value of Object.values(headers).sort((a, b) => b.length - a.length)) {
    text = text.split(value).join('[REDACTED]');
  }
  return text;
}

// Inject at the transport boundary; keep custom credentials out of SDK request options.
// Custom credentials must never follow even a same-origin redirect implicitly.
export function providerHeaderFetch(headers: Readonly<Record<string, string>>): typeof fetch {
  return async (input, init) => {
    const outgoing = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => outgoing.set(name, value));
    for (const [name, value] of Object.entries(headers)) outgoing.set(name, value);
    const response = await globalThis.fetch(input, {
      ...init,
      headers: outgoing,
      redirect: 'error'
    });
    const incoming = new Headers(response.headers);
    for (const name of ['request-id', 'x-request-id']) {
      const value = incoming.get(name);
      if (value) incoming.set(name, redact(value, headers));
    }
    if (response.ok) {
      return new Response(response.body, { status: response.status, headers: incoming });
    }
    // Some gateways echo credentials in failures; sanitize before SDK error/debug handling.
    const text = await response.text();
    let body: string;
    try {
      body = JSON.stringify(JSON.parse(text), (_key, value: unknown) =>
        typeof value === 'string' ? redact(value, headers) : value
      );
    } catch {
      body = redact(text, headers);
    }
    incoming.forEach((value, name) => incoming.set(name, redact(value, headers)));
    incoming.delete('content-length');
    incoming.delete('content-encoding');
    return new Response(body, { status: response.status, headers: incoming });
  };
}

export function normalizeHeaderProviderError(
  error: unknown,
  provider: string,
  headers?: Readonly<Record<string, string>>
): ProviderError {
  const normalized = normalizeProviderError(error, provider);
  if (!headers) return normalized;
  // Do not retain SDK causes carrying raw requests or response bodies.
  return new ProviderError(normalized.code, {
    provider,
    message: redact(normalized.message, headers),
    status: normalized.status,
    requestId: normalized.requestId ? redact(normalized.requestId, headers) : undefined,
    retryAfterMs: normalized.retryAfterMs,
    feature: normalized.feature,
    recovery: normalized.recovery
  });
}
