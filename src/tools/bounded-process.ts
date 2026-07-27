import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { OperationAbortedError, throwIfAborted } from './abort.js';

export interface BoundedProcessOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
}

export interface BoundedProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function appendBounded(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  maximumBytes: number
): { bytes: number; truncated: boolean } {
  const remainingBytes = Math.max(0, maximumBytes - currentBytes);
  if (remainingBytes > 0) {
    chunks.push(chunk.subarray(0, remainingBytes));
  }
  return {
    bytes: currentBytes + Math.min(chunk.byteLength, remainingBytes),
    truncated: chunk.byteLength > remainingBytes
  };
}

function terminateProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // The close/error handlers below remain the source of truth.
  }
}

export async function runBoundedProcess(
  executable: string,
  arguments_: readonly string[],
  options: BoundedProcessOptions
): Promise<BoundedProcessResult> {
  throwIfAborted(options.signal);
  const startedAt = Date.now();

  return await new Promise<BoundedProcessResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...arguments_], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', handleAbort);
    };
    const finishWithError = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => {
      aborted = true;
      terminateProcess(child);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, options.timeoutMs);
    timeout.unref?.();

    options.signal.addEventListener('abort', handleAbort, { once: true });
    child.stdin.end(options.stdin);

    child.stdout.on('data', (chunk: Buffer) => {
      const appended = appendBounded(
        stdoutChunks,
        stdoutBytes,
        chunk,
        options.maxStdoutBytes
      );
      stdoutBytes = appended.bytes;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const appended = appendBounded(
        stderrChunks,
        stderrBytes,
        chunk,
        options.maxStderrBytes
      );
      stderrBytes = appended.bytes;
      stderrTruncated ||= appended.truncated;
    });
    child.once('error', finishWithError);
    child.once('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      if (aborted || options.signal.aborted) {
        reject(new OperationAbortedError());
        return;
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode,
        signal,
        durationMs: Math.max(0, Date.now() - startedAt),
        timedOut,
        stdoutTruncated,
        stderrTruncated
      });
    });

    if (options.signal.aborted) {
      handleAbort();
    }
  });
}
