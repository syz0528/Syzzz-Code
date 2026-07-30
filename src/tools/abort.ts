export class OperationAbortedError extends Error {
  constructor(message: string = 'Operation cancelled by the user') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof OperationAbortedError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  const reason = signal.reason;
  if (isAbortError(reason)) {
    throw reason;
  }

  if (reason instanceof Error && reason.message) {
    throw new OperationAbortedError(reason.message);
  }

  throw new OperationAbortedError();
}
