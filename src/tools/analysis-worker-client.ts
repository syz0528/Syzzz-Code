import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { OperationAbortedError, throwIfAborted } from './abort.js';

const ANALYSIS_TIMEOUT_MS = 60_000;
const ANALYSIS_MEMORY_LIMIT_MB = 512;

export interface RepoMapWorkerRequest {
  operation: 'repo-map';
  workspaceRoot: string;
  files: string[];
  query?: string;
  focusPath?: string;
  modifiedPaths: string[];
  maxFiles: number;
}

export interface RepoMapFile {
  path: string;
  imports: string[];
  importedBy: string[];
  symbols: string[];
  score: number;
  modified: boolean;
}

export interface RepoMapWorkerResult {
  files: RepoMapFile[];
  candidateCount: number;
  cacheHits: number;
  parseErrors: number;
}

export interface DiagnosticsWorkerRequest {
  operation: 'diagnostics';
  workspaceRoot: string;
  files: string[];
  configPath?: string;
  reportFiles?: string[];
  limit: number;
}

export interface DiagnosticEntry {
  code: number;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface DiagnosticsWorkerResult {
  diagnostics: DiagnosticEntry[];
  total: number;
  truncated: boolean;
  configPath?: string;
  fileCount: number;
}

export type AnalysisWorkerRequest = RepoMapWorkerRequest | DiagnosticsWorkerRequest;

export type AnalysisWorkerResult = RepoMapWorkerResult | DiagnosticsWorkerResult;

interface WorkerRequestEnvelope {
  id: string;
  request: AnalysisWorkerRequest;
}

interface WorkerResponseEnvelope {
  id: string;
  ok: boolean;
  result?: AnalysisWorkerResult;
  error?: {
    name: string;
    message: string;
  };
}

interface PendingRequest {
  resolve: (result: AnalysisWorkerResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal: AbortSignal;
  handleAbort: () => void;
}

interface WorkerHandle {
  workspaceRoot: string;
  worker: Worker;
  pending: Map<string, PendingRequest>;
  terminated: boolean;
}

const workerHandles = new Map<string, WorkerHandle>();

function cleanupPending(handle: WorkerHandle, id: string): PendingRequest | undefined {
  const pending = handle.pending.get(id);
  if (!pending) {
    return undefined;
  }
  handle.pending.delete(id);
  clearTimeout(pending.timeout);
  pending.signal.removeEventListener('abort', pending.handleAbort);
  if (handle.pending.size === 0 && !handle.terminated) {
    handle.worker.unref();
  }
  return pending;
}

function terminateHandle(handle: WorkerHandle, error: Error): void {
  if (handle.terminated) {
    return;
  }
  handle.terminated = true;
  workerHandles.delete(handle.workspaceRoot);
  for (const [id] of handle.pending) {
    cleanupPending(handle, id)?.reject(error);
  }
  void handle.worker.terminate();
}

function createWorkerHandle(workspaceRoot: string): WorkerHandle {
  const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), {
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: ANALYSIS_MEMORY_LIMIT_MB
    }
  });
  const handle: WorkerHandle = {
    workspaceRoot,
    worker,
    pending: new Map(),
    terminated: false
  };
  worker.unref();

  worker.on('message', (message: WorkerResponseEnvelope) => {
    const pending = cleanupPending(handle, message.id);
    if (!pending) {
      return;
    }
    if (message.ok && message.result) {
      pending.resolve(message.result);
      return;
    }
    const error = new Error(message.error?.message ?? 'TypeScript analysis worker failed');
    error.name = message.error?.name ?? 'AnalysisWorkerError';
    pending.reject(error);
  });
  worker.on('error', (error) => {
    terminateHandle(handle, error);
  });
  worker.on('exit', (code) => {
    if (!handle.terminated && handle.pending.size > 0) {
      terminateHandle(handle, new Error(`TypeScript analysis worker exited with code ${code}`));
      return;
    }
    if (!handle.terminated) {
      handle.terminated = true;
      workerHandles.delete(handle.workspaceRoot);
    }
  });

  workerHandles.set(workspaceRoot, handle);
  return handle;
}

function getWorkerHandle(workspaceRoot: string): WorkerHandle {
  const existing = workerHandles.get(workspaceRoot);
  return existing && !existing.terminated ? existing : createWorkerHandle(workspaceRoot);
}

export function runAnalysisWorker(
  request: RepoMapWorkerRequest,
  signal: AbortSignal
): Promise<RepoMapWorkerResult>;
export function runAnalysisWorker(
  request: DiagnosticsWorkerRequest,
  signal: AbortSignal
): Promise<DiagnosticsWorkerResult>;
export function runAnalysisWorker(
  request: AnalysisWorkerRequest,
  signal: AbortSignal
): Promise<AnalysisWorkerResult> {
  throwIfAborted(signal);
  const handle = getWorkerHandle(request.workspaceRoot);
  const id = randomUUID();

  return new Promise<AnalysisWorkerResult>((resolve, reject) => {
    const handleAbort = () => {
      terminateHandle(
        handle,
        signal.reason instanceof Error ? signal.reason : new OperationAbortedError()
      );
    };
    const timeout = setTimeout(() => {
      terminateHandle(
        handle,
        new Error(`TypeScript analysis exceeded the ${ANALYSIS_TIMEOUT_MS} ms timeout`)
      );
    }, ANALYSIS_TIMEOUT_MS);
    const pending: PendingRequest = {
      resolve,
      reject,
      timeout,
      signal,
      handleAbort
    };
    handle.pending.set(id, pending);
    signal.addEventListener('abort', handleAbort, { once: true });
    handle.worker.ref();
    handle.worker.postMessage({
      id,
      request
    } satisfies WorkerRequestEnvelope);
  });
}
