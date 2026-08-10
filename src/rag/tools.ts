import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../types.js';
import { isAbortError } from '../tools/abort.js';
import { limitUtf8Head } from '../tools/output-limits.js';
import { defineTool } from '../tools/runtime.js';
import type { RagRuntime } from './runtime.js';
import type { RagPreparedWrite } from './types.js';

const MAX_RESULT_BYTES = 40 * 1024;

function errorResult(action: string, error: unknown): ToolResult {
  if (isAbortError(error)) throw error;
  return {
    content: `${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    isError: true,
    metadata: {
      errorCode:
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'rag_error'
    }
  };
}

export function createRagTools(runtime: RagRuntime, includeVerify: boolean): ToolDefinition[] {
  const search = defineTool({
    name: 'RagSearch',
    description:
      'Search ready workspace and mounted knowledge indexes. Returns bounded evidence summaries and chunk IDs; use RagRead before citing evidence.',
    inputSchema: z
      .object({
        query: z.string().min(1).max(8_192).optional(),
        queries: z.array(z.string().min(1).max(8_192)).max(4).optional(),
        collections: z.array(z.string().min(1).max(64)).max(16).optional(),
        path: z.string().min(1).max(4_096).optional(),
        limit: z.number().int().min(1).max(50).optional()
      })
      .strict()
      .refine((input) => Boolean(input.query || input.queries?.length), {
        message: 'query or queries is required'
      }),
    risk: 'read',
    approval: 'never',
    modeAccess: 'all-modes',
    async execute(input, context) {
      try {
        const results = await runtime.search({
          ...input,
          signal: context.signal,
          emitEvent: context.emitEvent
        });
        const body = results.length
          ? results
              .map(
                (hit) =>
                  `${hit.rank}. ${hit.chunkId} ${hit.virtualPath}:L${hit.lineStart}-L${hit.lineEnd}\n` +
                  `   channels=${hit.channels.join('+')} revision=${hit.revision}\n` +
                  `   ${hit.summary}`
              )
              .join('\n')
          : '(no RAG evidence matched)';
        const limited = limitUtf8Head(`RAG search results:\n${body}`, MAX_RESULT_BYTES);
        return {
          content: limited.text,
          metadata: {
            resultCount: results.length,
            truncated: limited.truncated,
            channels: [...new Set(results.flatMap((result) => result.channels))]
          }
        };
      } catch (error) {
        return errorResult('RagSearch', error);
      }
    }
  });

  const read = defineTool({
    name: 'RagRead',
    description:
      'Read up to 10 RAG chunks returned by RagSearch. Each chunk includes an exact citation token that may be used in the answer.',
    inputSchema: z
      .object({
        chunkIds: z
          .array(z.string().regex(/^[a-f0-9]{16,64}$/))
          .min(1)
          .max(10)
      })
      .strict(),
    risk: 'read',
    approval: 'never',
    modeAccess: 'all-modes',
    async execute(input, context) {
      try {
        const result = await runtime.readChunks(input.chunkIds, context.turnId, context.signal);
        const missing = input.chunkIds.filter(
          (id) => !result.chunks.some((chunk) => chunk.id === id)
        );
        const body = result.chunks
          .map(
            (chunk) =>
              `[[rag:${chunk.id}]]\n` +
              `${chunk.virtualPath}:L${chunk.lineStart}-L${chunk.lineEnd}\n` +
              `source-sha256=${chunk.sourceHash} revision=${chunk.revision}\n` +
              `${chunk.text}`
          )
          .join('\n\n---\n\n');
        const limited = limitUtf8Head(
          `${body || '(no chunks found)'}${missing.length ? `\n\nMissing chunk IDs: ${missing.join(', ')}` : ''}`,
          MAX_RESULT_BYTES
        );
        return {
          content: limited.text,
          isError: result.chunks.length === 0,
          metadata: {
            requestedCount: input.chunkIds.length,
            readCount: result.chunks.length,
            missingCount: missing.length,
            truncated: limited.truncated
          }
        };
      } catch (error) {
        return errorResult('RagRead', error);
      }
    }
  });

  const saveKnowledge = defineTool({
    name: 'SaveKnowledge',
    description:
      'Save a reviewed Markdown knowledge note into the managed personal RAG library. Use only when the user explicitly asks to remember, save, or update durable knowledge. Never use it merely because information seems useful.',
    inputSchema: z
      .object({
        title: z.string().min(1).max(200),
        content: z
          .string()
          .min(1)
          .max(128 * 1024),
        filename: z.string().min(1).max(128).optional(),
        sourceChunkIds: z
          .array(z.string().regex(/^[a-f0-9]{16,64}$/))
          .max(20)
          .optional()
      })
      .strict(),
    risk: 'write',
    approval: 'always',
    async prepareApproval(input, context) {
      const prepared = await runtime.prepareKnowledgeSave(input, context.turnId, context.signal);
      return {
        description: `${prepared.operation === 'update' ? 'Update' : 'Save'} managed RAG knowledge ${prepared.virtualPath}`,
        preview: runtime.describePreparedWrite(prepared),
        executionData: prepared
      };
    },
    async execute(_input, context) {
      try {
        const prepared = context.approvalData as RagPreparedWrite | undefined;
        if (!prepared) throw new Error('SaveKnowledge requires an approved write snapshot');
        const saved = await runtime.applyPreparedWrite(prepared, context.signal);
        const refresh = await runtime.refreshManagedLibrary(context.signal, context.emitEvent);
        const result = { ...saved, ...refresh };
        return {
          content: [
            `${prepared.operation === 'unchanged' ? 'Knowledge already matches' : 'Knowledge saved'}: ${prepared.virtualPath}`,
            `sha256=${prepared.sourceHash}`,
            refresh.indexStatus === 'refreshed'
              ? `RAG index refreshed at revision ${refresh.revision}.`
              : (refresh.warning ?? 'RAG index refresh is pending.')
          ].join('\n'),
          data: result,
          metadata: {
            collection: prepared.collectionName,
            virtualPath: prepared.virtualPath,
            operation: prepared.operation,
            versionHash: prepared.sourceHash,
            indexStatus: refresh.indexStatus,
            ...(refresh.revision ? { revision: refresh.revision } : {}),
            persistentSideEffect: prepared.operation !== 'unchanged'
          }
        };
      } catch (error) {
        return errorResult('SaveKnowledge', error);
      }
    }
  });

  const tools: ToolDefinition[] = [search, read, saveKnowledge];
  if (includeVerify) {
    tools.push(
      defineTool({
        name: 'RagVerify',
        description:
          'Verify a draft against RAG chunks read in this turn. Use at most once when claim-level evidence support is uncertain.',
        inputSchema: z
          .object({
            draft: z
              .string()
              .min(1)
              .max(20 * 1024)
          })
          .strict(),
        risk: 'read',
        approval: 'never',
        modeAccess: 'all-modes',
        async execute(input, context) {
          const startedAt = Date.now();
          context.emitEvent?.({
            type: 'rag_verification_started',
            citationCount: [...input.draft.matchAll(/\[\[rag:/g)].length
          });
          try {
            const result = await runtime.verify(
              input.draft,
              context.turnId,
              context.signal,
              context.emitEvent
            );
            const invalid = result.deterministic.filter((entry) => entry.status !== 'valid');
            context.emitEvent?.({
              type: 'rag_verification_completed',
              outcome: result.outcome,
              citationCount: result.deterministic.length,
              invalidCitationCount: invalid.length,
              durationMs: Date.now() - startedAt
            });
            return {
              content: JSON.stringify(result, null, 2),
              metadata: {
                outcome: result.outcome,
                citationCount: result.deterministic.length,
                invalidCitationCount: invalid.length
              }
            };
          } catch (error) {
            context.emitEvent?.({
              type: 'rag_verification_failed',
              code:
                error && typeof error === 'object' && 'code' in error
                  ? String(error.code)
                  : 'rag_error',
              durationMs: Date.now() - startedAt
            });
            return errorResult('RagVerify', error);
          }
        }
      })
    );
  }
  return tools;
}
