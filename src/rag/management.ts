import type { RagRuntime } from './runtime.js';
import { probeLanceVectorStore } from './vector-store.js';

export interface RagManagementRequest {
  runtime: RagRuntime;
  action: string;
  target?: string;
  rest?: string[];
  path?: string;
  name?: string;
  collection?: string;
  json?: boolean;
  yes?: boolean;
  signal: AbortSignal;
  confirm?: (request: { title: string; message: string; preview?: string }) => Promise<boolean>;
}

export interface RagManagementResult {
  text: string;
  json: unknown;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function manageRag(request: RagManagementRequest): Promise<RagManagementResult> {
  const action = request.action.toLowerCase();
  const confirmRemote = async ({
    purpose,
    collection,
    endpoint,
    model,
    fileCount,
    sourceBytes
  }: {
    purpose: string;
    collection: { name: string };
    endpoint: string;
    model: string;
    fileCount: number;
    sourceBytes: number;
  }): Promise<boolean> => {
    if (request.yes) return true;
    return (
      (await request.confirm?.({
        title: `Send ${collection.name} to remote ${purpose} endpoint?`,
        message:
          'Source chunks will leave this machine. Approval is bound to this collection root, endpoint, model, and ingestion rules.',
        preview: `Endpoint: ${endpoint}\nModel: ${model}\nFiles: ${fileCount}\nBytes: ${formatBytes(sourceBytes)}`
      })) ?? false
    );
  };
  if (action === 'status') {
    const status = await request.runtime.getStatus();
    const lines = [
      `RAG: ${status.enabled ? 'enabled' : 'disabled'}`,
      `Auto retrieve: ${status.autoRetrieve}; auto refresh: ${status.autoRefresh ? 'on' : 'off'}`,
      `Retrieval: lexical ready; vector ${status.vectorAvailable ? 'ready' : 'unavailable'}; reranker ${status.rerankerConfigured ? 'configured' : 'off'}`
    ];
    for (const collection of status.collections) {
      lines.push(
        `  ${collection.name}: ${collection.health}; ${collection.fileCount} files; ` +
          `${collection.chunkCount} chunks${collection.revision ? `; ${collection.revision}` : ''}`
      );
      collection.warnings.forEach((warning) => lines.push(`    Warning: ${warning}`));
    }
    status.warnings.forEach((warning) => lines.push(`Warning: ${warning}`));
    return { text: lines.join('\n'), json: status };
  }

  if (action === 'doctor') {
    const status = await request.runtime.getStatus();
    let lance: { ok: boolean; error?: string } = { ok: true };
    try {
      await probeLanceVectorStore(request.runtime.store.baseDirectory);
    } catch (error) {
      lance = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const report = { status, lance };
    return {
      text: [
        'RAG doctor',
        '  MiniSearch: ready',
        `  LanceDB: ${lance.ok ? 'ready' : `degraded (${lance.error})`}`,
        `  Collections: ${status.collections.length} mounted`,
        `  Remote embedding: ${status.vectorAvailable ? 'configured' : 'not configured or unavailable'}`,
        `  Reranker: ${status.rerankerConfigured ? 'configured' : 'not configured'}`
      ].join('\n'),
      json: report
    };
  }

  if (action === 'add') {
    if (!request.target) throw new Error('rag add requires a document path');
    const collection = request.collection ?? 'library';
    if (collection !== 'library') {
      throw new Error('rag add currently writes only to the managed library collection');
    }
    const prepared = await request.runtime.prepareDocumentImport(
      request.target,
      request.name,
      request.signal
    );
    if (prepared.operation !== 'unchanged' && !request.yes) {
      const approved = await request.confirm?.({
        title: `${prepared.operation === 'update' ? 'Update' : 'Add'} ${prepared.virtualPath}?`,
        message:
          'The document will be copied into the managed local knowledge library. The original file is not modified.',
        preview: request.runtime.describePreparedWrite(prepared)
      });
      if (!approved) {
        return {
          text: 'RAG document import cancelled.',
          json: { saved: false, collection, virtualPath: prepared.virtualPath }
        };
      }
    }
    const saved = await request.runtime.applyPreparedWrite(prepared, request.signal);
    let indexed;
    try {
      indexed = await request.runtime.index({
        collection,
        operation: 'refresh',
        signal: request.signal,
        confirmRemote
      });
    } catch (error) {
      throw new Error(
        `Document was saved as ${saved.virtualPath}, but the RAG index was not refreshed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const result = {
      ...saved,
      indexStatus: 'refreshed' as const,
      revision: indexed.revision
    };
    return {
      text: [
        `${prepared.operation === 'unchanged' ? 'Document already present' : 'Document imported'}: ${saved.virtualPath}`,
        `RAG library refreshed: ${indexed.fileCount} files, ${indexed.chunkCount} chunks, revision=${indexed.revision}.`
      ].join('\n'),
      json: result
    };
  }

  if (action === 'collections') {
    const subaction = request.target?.toLowerCase() ?? 'list';
    const [name, root] = request.rest ?? [];
    if (subaction === 'add') {
      const collectionRoot = root ?? request.path;
      if (!name || !collectionRoot)
        throw new Error('rag collections add requires <name> --path <directory>');
      const collection = await request.runtime.registerCollection(name, collectionRoot);
      return { text: `Registered RAG collection ${collection.name}.`, json: collection };
    }
    if (subaction === 'remove') {
      if (!name) throw new Error('rag collections remove requires <name>');
      const removed = await request.runtime.removeCollection(name);
      return {
        text: removed ? `Removed RAG collection ${name}.` : `No collection named ${name}.`,
        json: { removed }
      };
    }
    if (subaction !== 'list')
      throw new Error('rag collections action must be list, add, or remove');
    const collections = await request.runtime.store.listExternalCollections();
    return {
      text: collections.length
        ? collections.map((entry) => `${entry.name}  ${entry.canonicalRoot}`).join('\n')
        : 'No external RAG collections are registered.',
      json: collections
    };
  }

  if (action === 'mount' || action === 'unmount') {
    if (!request.target) throw new Error(`rag ${action} requires a collection name`);
    await request.runtime[action](request.target);
    return {
      text: `${action === 'mount' ? 'Mounted' : 'Unmounted'} RAG collection ${request.target}.`,
      json: { collection: request.target, mounted: action === 'mount' }
    };
  }

  if (action === 'index' || action === 'refresh') {
    const result = await request.runtime.index({
      collection: request.target || 'workspace',
      operation: action,
      signal: request.signal,
      confirmRemote
    });
    return {
      text:
        `${action === 'index' ? 'Indexed' : 'Refreshed'} ${result.collection}: ` +
        `${result.fileCount} files, ${result.chunkCount} chunks, ${formatBytes(result.sourceBytes)}, ` +
        `vector=${result.vectorState}, revision=${result.revision}.`,
      json: result
    };
  }

  if (action === 'search') {
    const query = [request.target, ...(request.rest ?? [])].filter(Boolean).join(' ');
    if (!query) throw new Error('rag search requires a query');
    const hits = await request.runtime.search({ query, signal: request.signal });
    return {
      text: hits.length
        ? hits
            .map(
              (hit) =>
                `${hit.rank}. ${hit.chunkId} ${hit.virtualPath}:L${hit.lineStart}-L${hit.lineEnd}\n   ${hit.summary}`
            )
            .join('\n')
        : 'No RAG evidence matched.',
      json: hits
    };
  }

  if (action === 'inspect') {
    if (!request.target) throw new Error('rag inspect requires a chunk ID');
    const chunk = await request.runtime.inspectChunk(request.target, request.signal);
    if (!chunk) throw new Error(`Unknown RAG chunk: ${request.target}`);
    return {
      text: `[[rag:${chunk.id}]]\n${chunk.virtualPath}:L${chunk.lineStart}-L${chunk.lineEnd}\nsha256=${chunk.sourceHash}\n\n${chunk.text}`,
      json: chunk
    };
  }

  if (action === 'clear') {
    const collection = request.target || 'workspace';
    if (!request.yes) {
      const approved = await request.confirm?.({
        title: `Clear RAG index ${collection}?`,
        message: 'This removes local index revisions only. Source files are not modified.'
      });
      if (!approved) return { text: 'RAG index clear cancelled.', json: { cleared: false } };
    }
    await request.runtime.clear(collection);
    return { text: `Cleared RAG index ${collection}.`, json: { cleared: true, collection } };
  }

  throw new Error(
    'rag action must be status, doctor, add, index, refresh, search, inspect, clear, collections, mount, or unmount'
  );
}
