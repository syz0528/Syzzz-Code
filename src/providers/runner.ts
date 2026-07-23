import { randomUUID } from 'node:crypto';
import type {
  AIProvider,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderDelta,
  ProviderInfo,
  ProviderUsage
} from './base.js';
import {
  isProviderAbort,
  isRetryableProviderError,
  normalizeProviderError,
  ProviderError,
  toPublicProviderError,
  type PublicProviderError
} from './errors.js';
import { OperationAbortedError, throwIfAborted } from '../tools/abort.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

export interface ProviderRunnerOptions {
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  random?: () => number;
  now?: () => number;
  idFactory?: () => string;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export type ProviderRunEvent =
  | {
      type: 'request_started';
      provider: string;
      model: string;
      attempt: number;
      attemptId: string;
    }
  | {
      type: 'request_failed';
      provider: string;
      model: string;
      attempt: number;
      attemptId: string;
      durationMs: number;
      willRetry: boolean;
      error: PublicProviderError;
    }
  | {
      type: 'request_completed';
      provider: string;
      model: string;
      attempt: number;
      attemptId: string;
      durationMs: number;
      response: ProviderChatResponse;
    }
  | {
      type: 'reasoning_status';
      status: 'started' | 'completed';
      attempt: number;
      attemptId: string;
      durationMs?: number;
      characterCount?: number;
    }
  | {
      type: 'text_delta';
      attempt: number;
      attemptId: string;
      delta: string;
    }
  | {
      type: 'tool_call_delta';
      attempt: number;
      attemptId: string;
      delta: Extract<ProviderDelta, { type: 'tool_call_delta' }>;
    }
  | {
      type: 'usage';
      attempt: number;
      attemptId: string;
      usage: ProviderUsage;
    }
  | {
      type: 'retry_scheduled';
      attempt: number;
      nextAttempt: number;
      delayMs: number;
      reason: ProviderError['code'];
    };

interface ResolvedRunnerOptions {
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  random: () => number;
  now: () => number;
  idFactory: () => string;
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  disableReasoning?: boolean;
  disableStreamUsage?: boolean;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function resolveOptions(options: ProviderRunnerOptions): ResolvedRunnerOptions {
  return {
    maxAttempts: positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    attemptTimeoutMs: positiveInteger(
      options.attemptTimeoutMs,
      DEFAULT_ATTEMPT_TIMEOUT_MS
    ),
    totalTimeoutMs: positiveInteger(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS),
    baseDelayMs: positiveInteger(options.baseDelayMs, DEFAULT_BASE_DELAY_MS),
    maxDelayMs: positiveInteger(options.maxDelayMs, DEFAULT_MAX_DELAY_MS),
    maxRetryAfterMs: positiveInteger(
      options.maxRetryAfterMs,
      DEFAULT_MAX_RETRY_AFTER_MS
    ),
    random: options.random ?? Math.random,
    now: options.now ?? Date.now,
    idFactory: options.idFactory ?? randomUUID,
    sleep: options.sleep ?? abortableSleep
  };
}

function normalizeProviderInfo(provider: AIProvider): ProviderInfo {
  const rawInfo = provider.getInfo() as Partial<ProviderInfo> & {
    name: string;
    type: string;
  };
  return {
    name: rawInfo.name,
    type: rawInfo.type,
    model: rawInfo.model ?? 'unknown',
    capabilities: rawInfo.capabilities ?? {
      streaming: typeof provider.chatStream === 'function',
      reasoningToggle: false
    }
  };
}

export function getNormalizedProviderInfo(provider: AIProvider): ProviderInfo {
  return normalizeProviderInfo(provider);
}

export function calculateBackoffDelay(
  attempt: number,
  options: Pick<ResolvedRunnerOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'>
): number {
  const exponentialDelay = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * (2 ** Math.max(0, attempt - 1))
  );
  const jitterMultiplier = 0.8 + (Math.min(1, Math.max(0, options.random())) * 0.4);
  return Math.round(exponentialDelay * jitterMultiplier);
}

async function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', handleAbort);
      reject(new OperationAbortedError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function waitForOperation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new OperationAbortedError()
    );
  }

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      signal.removeEventListener('abort', handleAbort);
      reject(signal.reason instanceof Error ? signal.reason : new OperationAbortedError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });

    Promise.resolve(operation).then(
      value => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      }
    );
  });
}

function sameUsage(left: ProviderUsage | undefined, right: ProviderUsage): boolean {
  return left !== undefined &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens;
}

function createAttemptController(
  parentSignal: AbortSignal,
  timeoutMs: number
): {
  controller: AbortController;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const handleParentAbort = () => {
    controller.abort(parentSignal.reason);
  };
  parentSignal.addEventListener('abort', handleParentAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Provider attempt timed out'));
  }, timeoutMs);

  if (parentSignal.aborted) {
    handleParentAbort();
  }

  return {
    controller,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', handleParentAbort);
    }
  };
}

function decideRetry(
  error: ProviderError,
  attempt: number,
  hasVisibleText: boolean,
  hasToolCallDelta: boolean,
  includeUsage: boolean,
  disableReasoning: boolean,
  providerInfo: ProviderInfo,
  elapsedMs: number,
  options: ResolvedRunnerOptions
): RetryDecision {
  if (
    attempt >= options.maxAttempts ||
    hasVisibleText ||
    hasToolCallDelta
  ) {
    return { shouldRetry: false, delayMs: 0 };
  }

  let delayMs: number;
  let disableStreamUsage = false;
  let shouldDisableReasoning = false;

  if (
    error.code === 'unsupported_feature' &&
    error.feature === 'stream_options' &&
    includeUsage
  ) {
    delayMs = 0;
    disableStreamUsage = true;
  } else if (
    error.recovery === 'reasoning-only' &&
    providerInfo.capabilities.reasoningToggle &&
    !disableReasoning
  ) {
    delayMs = 0;
    shouldDisableReasoning = true;
  } else if (isRetryableProviderError(error)) {
    if (error.retryAfterMs !== undefined) {
      if (error.retryAfterMs > options.maxRetryAfterMs) {
        return { shouldRetry: false, delayMs: 0 };
      }
      delayMs = error.retryAfterMs;
    } else {
      delayMs = calculateBackoffDelay(attempt, options);
    }
  } else {
    return { shouldRetry: false, delayMs: 0 };
  }

  const remainingBudgetMs = options.totalTimeoutMs - elapsedMs;
  if (remainingBudgetMs <= 0 || delayMs >= remainingBudgetMs) {
    return { shouldRetry: false, delayMs: 0 };
  }

  return {
    shouldRetry: true,
    delayMs,
    ...(shouldDisableReasoning ? { disableReasoning: true } : {}),
    ...(disableStreamUsage ? { disableStreamUsage: true } : {})
  };
}

export async function* runProviderRequest(
  provider: AIProvider,
  request: ProviderChatRequest,
  options: ProviderRunnerOptions = {}
): AsyncGenerator<ProviderRunEvent, ProviderChatResponse> {
  const resolvedOptions = resolveOptions(options);
  const providerInfo = normalizeProviderInfo(provider);
  const parentSignal = request.signal ?? new AbortController().signal;
  const startedAt = resolvedOptions.now();
  let includeUsage = true;
  let disableReasoning = false;

  for (let attempt = 1; attempt <= resolvedOptions.maxAttempts; attempt++) {
    throwIfAborted(parentSignal);
    const elapsedBeforeAttempt = resolvedOptions.now() - startedAt;
    const remainingBudgetMs = resolvedOptions.totalTimeoutMs - elapsedBeforeAttempt;
    if (remainingBudgetMs <= 0) {
      throw new ProviderError('timeout', { provider: providerInfo.name });
    }

    const attemptId = resolvedOptions.idFactory();
    const attemptStartedAt = resolvedOptions.now();
    const attemptController = createAttemptController(
      parentSignal,
      Math.min(resolvedOptions.attemptTimeoutMs, remainingBudgetMs)
    );
    let hasVisibleText = false;
    let hasToolCallDelta = false;
    let reasoningStartedAt: number | undefined;
    let reasoningCharacterCount = 0;
    let lastUsage: ProviderUsage | undefined;

    try {
      yield {
        type: 'request_started',
        provider: providerInfo.name,
        model: providerInfo.model,
        attempt,
        attemptId
      };

      const attemptRequest: ProviderChatRequest = {
        ...request,
        signal: attemptController.controller.signal
      };
      let response: ProviderChatResponse;

      if (providerInfo.capabilities.streaming && provider.chatStream) {
        const stream = provider.chatStream(attemptRequest, {
          signal: attemptController.controller.signal,
          attempt,
          attemptId,
          includeUsage,
          disableReasoning
        });
        let streamCompleted = false;

        try {
          while (true) {
            const next = await waitForOperation(
              stream.next(),
              attemptController.controller.signal
            );
            if (next.done) {
              streamCompleted = true;
              response = next.value;
              break;
            }

            const delta = next.value;
            if (delta.type === 'text_delta') {
              if (delta.text) {
                hasVisibleText = true;
                yield {
                  type: 'text_delta',
                  attempt,
                  attemptId,
                  delta: delta.text
                };
              }
              continue;
            }

            if (delta.type === 'reasoning_delta') {
              if (reasoningStartedAt === undefined) {
                reasoningStartedAt = resolvedOptions.now();
                yield {
                  type: 'reasoning_status',
                  status: 'started',
                  attempt,
                  attemptId
                };
              }
              reasoningCharacterCount += delta.text.length;
              continue;
            }

            if (delta.type === 'tool_call_delta') {
              hasToolCallDelta = true;
              yield {
                type: 'tool_call_delta',
                attempt,
                attemptId,
                delta
              };
              continue;
            }

            lastUsage = delta.usage;
            yield {
              type: 'usage',
              attempt,
              attemptId,
              usage: delta.usage
            };
          }
        } finally {
          if (!streamCompleted) {
            const close = stream.return(undefined as never);
            if (attemptController.controller.signal.aborted) {
              void close.catch(() => {});
            } else {
              await close;
            }
          }
        }
      } else {
        response = await waitForOperation(
          provider.chat(attemptRequest),
          attemptController.controller.signal
        );
        if (!response.message.content.trim() && !response.message.toolCalls?.length) {
          throw new ProviderError('malformed_response', {
            provider: providerInfo.name
          });
        }
        if (response.message.content) {
          hasVisibleText = true;
          yield {
            type: 'text_delta',
            attempt,
            attemptId,
            delta: response.message.content
          };
        }
        if (response.usage) {
          lastUsage = response.usage;
          yield {
            type: 'usage',
            attempt,
            attemptId,
            usage: response.usage
          };
        }
      }

      if (attemptController.controller.signal.aborted) {
        throw new Error('Provider attempt aborted');
      }

      if (reasoningStartedAt !== undefined) {
        yield {
          type: 'reasoning_status',
          status: 'completed',
          attempt,
          attemptId,
          durationMs: Math.max(0, resolvedOptions.now() - reasoningStartedAt),
          characterCount: reasoningCharacterCount
        };
        reasoningStartedAt = undefined;
      }

      if (
        !response.message.content.trim() &&
        !response.message.toolCalls?.length &&
        response.message.reasoningContent
      ) {
        throw new ProviderError('malformed_response', {
          provider: providerInfo.name,
          recovery: 'reasoning-only',
          message: `${providerInfo.name}: provider returned only reasoning content`
        });
      }
      if (!response.message.content.trim() && !response.message.toolCalls?.length) {
        throw new ProviderError('malformed_response', {
          provider: providerInfo.name
        });
      }

      if (response.usage && !sameUsage(lastUsage, response.usage)) {
        yield {
          type: 'usage',
          attempt,
          attemptId,
          usage: response.usage
        };
      }

      const {
        reasoningContent,
        ...messageWithoutReasoning
      } = response.message;
      const committedResponse: ProviderChatResponse = {
        ...response,
        message: response.message.toolCalls?.length && reasoningContent
          ? { ...messageWithoutReasoning, reasoningContent }
          : messageWithoutReasoning
      };
      yield {
        type: 'request_completed',
        provider: providerInfo.name,
        model: providerInfo.model,
        attempt,
        attemptId,
        durationMs: Math.max(0, resolvedOptions.now() - attemptStartedAt),
        response: committedResponse
      };
      return committedResponse;
    } catch (rawError) {
      if (reasoningStartedAt !== undefined) {
        yield {
          type: 'reasoning_status',
          status: 'completed',
          attempt,
          attemptId,
          durationMs: Math.max(0, resolvedOptions.now() - reasoningStartedAt),
          characterCount: reasoningCharacterCount
        };
      }

      if (parentSignal.aborted) {
        throw new OperationAbortedError();
      }

      let error: ProviderError;
      if (attemptController.didTimeout()) {
        error = new ProviderError('timeout', {
          provider: providerInfo.name,
          cause: rawError
        });
      } else if (isProviderAbort(rawError)) {
        error = new ProviderError('unknown', {
          provider: providerInfo.name,
          cause: rawError
        });
      } else {
        error = normalizeProviderError(
          rawError,
          providerInfo.name,
          resolvedOptions.now()
        );
      }

      const elapsedMs = resolvedOptions.now() - startedAt;
      const retry = decideRetry(
        error,
        attempt,
        hasVisibleText,
        hasToolCallDelta,
        includeUsage,
        disableReasoning,
        providerInfo,
        elapsedMs,
        resolvedOptions
      );
      yield {
        type: 'request_failed',
        provider: providerInfo.name,
        model: providerInfo.model,
        attempt,
        attemptId,
        durationMs: Math.max(0, resolvedOptions.now() - attemptStartedAt),
        willRetry: retry.shouldRetry,
        error: toPublicProviderError(error)
      };

      if (!retry.shouldRetry) {
        throw error;
      }

      if (retry.disableReasoning) {
        disableReasoning = true;
      }
      if (retry.disableStreamUsage) {
        includeUsage = false;
      }

      yield {
        type: 'retry_scheduled',
        attempt,
        nextAttempt: attempt + 1,
        delayMs: retry.delayMs,
        reason: error.code
      };
      await resolvedOptions.sleep(retry.delayMs, parentSignal);
    } finally {
      attemptController.cleanup();
    }
  }

  throw new ProviderError('unknown', { provider: providerInfo.name });
}
