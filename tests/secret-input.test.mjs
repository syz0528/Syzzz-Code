import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readHiddenInput } from '../dist/secret-input.js';

function fakeTerminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks = [];
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
    return input;
  };
  output.isTTY = true;
  output.on('data', (chunk) => outputChunks.push(chunk));
  return {
    input,
    output,
    text: () => Buffer.concat(outputChunks).toString('utf8')
  };
}

test('hidden secret input never echoes characters and restores raw mode', async () => {
  const terminal = fakeTerminal();
  const secret = readHiddenInput({
    prompt: 'API Key: ',
    input: terminal.input,
    output: terminal.output
  });

  terminal.input.emit('keypress', 's', { name: 's' });
  terminal.input.emit('keypress', 'e', { name: 'e' });
  terminal.input.emit('keypress', 'x', { name: 'x' });
  terminal.input.emit('keypress', '', { name: 'backspace' });
  terminal.input.emit('keypress', 'c', { name: 'c' });
  terminal.input.emit('keypress', '\r', { name: 'return' });

  assert.equal(await secret, 'sec');
  assert.equal(terminal.text(), 'API Key: \n');
  assert.equal(terminal.input.isRaw, false);
});

test('hidden secret input fails cleanly on EOF and abort', async () => {
  const eofTerminal = fakeTerminal();
  const eofResult = readHiddenInput({
    prompt: 'Secret: ',
    input: eofTerminal.input,
    output: eofTerminal.output
  });
  eofTerminal.input.end();
  await assert.rejects(eofResult, /Input closed/);
  assert.equal(eofTerminal.input.isRaw, false);

  const abortTerminal = fakeTerminal();
  const controller = new AbortController();
  const aborted = readHiddenInput({
    prompt: 'Secret: ',
    signal: controller.signal,
    input: abortTerminal.input,
    output: abortTerminal.output
  });
  controller.abort();
  await assert.rejects(aborted, /cancelled/);
  assert.equal(abortTerminal.input.isRaw, false);
});
