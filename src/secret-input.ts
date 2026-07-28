import { emitKeypressEvents } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { OperationAbortedError } from './tools/abort.js';

const MAX_SECRET_CHARACTERS = 16_384;

interface KeyDescriptor {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

export interface HiddenInputOptions {
  prompt: string;
  signal?: AbortSignal;
  input?: ReadStream;
  output?: WriteStream;
}

export async function readHiddenInput(
  options: HiddenInputOptions
): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error(
      'Hidden input requires an interactive terminal; use --stdin or --from-env'
    );
  }

  options.signal?.throwIfAborted();
  output.write(options.prompt);
  emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);

  return new Promise<string>((resolve, reject) => {
    let value = '';
    let settled = false;

    const cleanup = () => {
      input.removeListener('keypress', handleKeypress);
      input.removeListener('end', handleEnd);
      input.removeListener('error', handleError);
      options.signal?.removeEventListener('abort', handleAbort);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // The terminal may already be closed; the secret still must settle.
      }
    };
    const finish = (
      callback: (value: string | Error) => void,
      result: string | Error
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      output.write('\n');
      callback(result);
    };
    const handleAbort = () => {
      finish(
        error => reject(error),
        new OperationAbortedError('Secret input cancelled')
      );
    };
    const handleEnd = () => {
      finish(
        error => reject(error),
        new Error('Input closed before the secret was submitted')
      );
    };
    const handleError = (error: Error) => {
      finish(reason => reject(reason), error);
    };
    const handleKeypress = (text: string, key: KeyDescriptor = {}) => {
      if (key.ctrl && key.name === 'c') {
        handleAbort();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish(result => resolve(String(result)), value);
        return;
      }
      if (key.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
        return;
      }
      if (
        !key.ctrl &&
        !key.meta &&
        text &&
        !/[\u0000-\u001f\u007f]/.test(text) &&
        value.length + text.length <= MAX_SECRET_CHARACTERS
      ) {
        value += text;
      }
    };

    input.on('keypress', handleKeypress);
    input.once('end', handleEnd);
    input.once('error', handleError);
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    input.resume();
  });
}
