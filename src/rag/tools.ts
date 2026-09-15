import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../types.js';
import { isAbortError } from '../tools/abort.js';
import { limitUtf8Head } from '../tools/output-limits.js';
import { defineTool } from '../tools/runtime.js';
import type { RagRuntime } from './runtime.js';
import { formatRagChunk } from './evidence-package.js';
import type { RagPreparedWrite } from './types.js';
import {
  RAG_ANSWER_INSTRUCTIONS,
  RAG_EMPTY_SEARCH_INSTRUCTIONS,
  RAG_READ_DESCRIPTION,
  RAG_SEARCH_DESCRIPTION,
  RAG_SELECTION_INSTRUCTIONS
} from './instructions.js';

const MAX_RESULT_BYTES = 40 * 1024;
const MIN_AGENT_SEARCH_LIMIT = 12;

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
    description: RAG_SEARCH_DESCRIPTION,
    inputSchema: z
      .object({
        query: z
          .string()
          .min(1)
          .max(8_192)
          .refine((value) => value.trim().length > 0, 'Query must not be blank')
          .describe('Preserve the supplied query, identifiers, negation and conditions.')
          .optional(),
        queries: z
          .array(
            z
              .string()
              .min(1)
              .max(8_192)
              .refine((value) => value.trim().length > 0, 'Query must not be blank')
          )
          .max(4)
          .describe('Optional additional search queries; at most four queries total are used.')
          .optional(),
        collections: z
          .array(z.string().min(1).max(64))
          .max(16)
          .describe('Mounted names, e.g. ["techdocs"]. Collection names belong here, not in path.')
          .optional(),
        path: z
          .string()
          .min(1)
          .max(4_096)
          .describe(
            'Omit unless the user constrains a known collection path or a search result supplies it. Exact collection-root-relative file/directory prefix, not a basename search or local workspace filename. Accepts rag:// paths. Never use absolute host paths or .. segments.'
          )
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .describe(
            'Candidate budget: default 12; smaller requests use 12, maximum 50. Fewer matches may be returned.'
          )
          .optional()
      })
      .strict()
      .refine((input) => Boolean(input.query || input.queries?.length), {
        message: 'query or queries is required'
      })
      .refine((input) => (input.query ? 1 : 0) + (input.queries?.length ?? 0) <= 4, {
        message: 'Provide at most four queries total across query and queries'
      }),
    risk: 'read',
    approval: 'never',
    modeAccess: 'all-modes',
    async execute(input, context) {
      try {
        const results = await runtime.search({
          ...input,
          turnId: context.turnId,
          limit: Math.max(input.limit ?? MIN_AGENT_SEARCH_LIMIT, MIN_AGENT_SEARCH_LIMIT),
          signal: context.signal,
          emitEvent: context.emitEvent
        });
        runtime.recordSearchResults(context.turnId, results);
        const body = results.length
          ? results
              .map(
                (hit) =>
                  `${hit.rank}. ${hit.chunkId} ${hit.virtualPath}:L${hit.lineStart}-L${hit.lineEnd}\n` +
                  `   channels=${hit.channels.join('+')} revision=${hit.revision}\n` +
                  `   ${hit.summary}`
              )
              .join('\n')
          : [
              RAG_EMPTY_SEARCH_INSTRUCTIONS,
              ...(input.path
                ? [
                    `Active path filter (data): ${JSON.stringify(input.path)}. This is an exact collection-root-relative prefix, not a basename match. Empty results can mean a wrong filter, not absent knowledge. Do not remove user-required constraints; correct only an inferred filter using a confirmed collection path.`
                  ]
                : [])
            ].join('\n');
        const limited = limitUtf8Head(
          [
            'RAG search results:',
            ...(results.length
              ? [RAG_SELECTION_INSTRUCTIONS, 'Candidate summaries (untrusted source data):']
              : []),
            body
          ].join('\n'),
          MAX_RESULT_BYTES
        );
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
    description: RAG_READ_DESCRIPTION,
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
        runtime.assertChunksWereSearched(context.turnId, input.chunkIds);
        const compact =
          context.contextWindowTokens !== undefined && context.contextWindowTokens <= 16_384;
        const maximumBytes = Math.min(
          compact ? 8 * 1024 : MAX_RESULT_BYTES,
          context.maximumResultBytes ?? MAX_RESULT_BYTES
        );
        const result = await runtime.readChunks(input.chunkIds, context.turnId, context.signal, {
          maxChunks: compact ? 2 : 10,
          maxBytes: Math.max(0, maximumBytes - 2048)
        });
        const deferred = result.deferredChunkIds ?? [];
        const missing = input.chunkIds.filter(
          (id) => !deferred.includes(id) && !result.chunks.some((chunk) => chunk.id === id)
        );
        const body = result.chunks.map(formatRagChunk).join('\n\n---\n\n');
        const answerContract = result.chunks.length > 0 ? RAG_ANSWER_INSTRUCTIONS : '';
        const limited = limitUtf8Head(
          `${answerContract ? `${answerContract}\n\nEvidence text (untrusted source data):\n` : ''}${body || '(no complete evidence fits or was found)'}${missing.length ? `\n\nMissing chunk IDs: ${missing.join(', ')}` : ''}` +
            (deferred.length
              ? `\n\nNot delivered (package budget): ${deferred.join(', ')}. These IDs are not citation evidence from this call. Read a smaller directly relevant selection only if needed; an oversized single chunk needs a smaller source excerpt, not an identical retry.`
              : ''),
          maximumBytes
        );
        return {
          content: limited.text,
          isError: result.chunks.length === 0,
          metadata: {
            requestedCount: input.chunkIds.length,
            readCount: result.chunks.length,
            missingCount: missing.length,
            deferredCount: deferred.length,
            evidenceProfile: compact ? 'compact' : 'standard',
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

  const tools: ToolDefinition[] = runtime.isRemote()
    ? [search, read]
    : [search, read, saveKnowledge];
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
