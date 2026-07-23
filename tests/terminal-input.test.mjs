import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TerminalInputController } from '../dist/terminal-input.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function createFakeTty() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = mode => {
    input.isRaw = mode;
  };
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;

  let transcript = '';
  output.on('data', chunk => {
    transcript += chunk.toString('utf8');
  });
  return { input, output, transcript: () => transcript };
}

function suggestion(id, insertText, label = insertText) {
  return {
    id,
    label,
    insertText,
    replaceStart: 0,
    replaceEnd: 1,
    submitOnAccept: true
  };
}

test('enhanced input renders, navigates and accepts slash suggestions', async () => {
  const tty = createFakeTty();
  const terminal = new TerminalInputController(tty.input, tty.output);
  const provider = {
    trigger: '/',
    match(value, cursor) {
      return value.startsWith('/') && cursor === value.length
        ? { query: value.slice(1) }
        : null;
    },
    suggest() {
      return [
        suggestion('help', '/help', '/help'),
        suggestion('model', '/model', '/model')
      ];
    }
  };

  const reading = terminal.readLine({
    prompt: 'You: ',
    suggestionProviders: [provider],
    history: true
  });
  tty.input.write('/');
  await delay(15);
  assert.match(tty.transcript(), /> \/help/);
  assert.match(tty.transcript(), /  \/model/);

  tty.input.write('\x1b[B');
  tty.input.write('\r');
  assert.deepEqual(await reading, { type: 'line', value: '/model' });
  assert.equal(tty.input.isRaw, false);
  terminal.close();
});

test('enhanced input keeps history and handles Chinese text across resize', async () => {
  const tty = createFakeTty();
  const terminal = new TerminalInputController(tty.input, tty.output);

  const first = terminal.readLine({ prompt: 'You: ', history: true });
  tty.input.write('中文输入');
  tty.output.columns = 24;
  tty.output.emit('resize');
  tty.input.write('\r');
  assert.deepEqual(await first, { type: 'line', value: '中文输入' });

  const second = terminal.readLine({ prompt: 'You: ', history: true });
  tty.input.write('\x1b[A');
  tty.input.write('\r');
  assert.deepEqual(await second, { type: 'line', value: '中文输入' });
  terminal.close();
});

test('enhanced input normalizes pasted newlines without submitting early', async () => {
  const tty = createFakeTty();
  const terminal = new TerminalInputController(tty.input, tty.output);
  const reading = terminal.readLine({ prompt: 'You: ' });
  let settled = false;
  void reading.then(() => {
    settled = true;
  });

  tty.input.write('\u001b[200~first\nsecond\u001b[201~');
  await delay(10);
  assert.equal(settled, false);
  tty.input.write('\r');
  assert.deepEqual(await reading, {
    type: 'line',
    value: 'first second'
  });
  terminal.close();
});

test('suggestion menus show at most eight rows and scroll with selection', async () => {
  const tty = createFakeTty();
  const terminal = new TerminalInputController(tty.input, tty.output);
  const items = Array.from({ length: 12 }, (_, index) => ({
    ...suggestion(`item-${index + 1}`, `/item-${index + 1}`),
    label: `/item-${index + 1}`
  }));
  const provider = {
    trigger: '/',
    match(value) {
      return value === '/' ? { query: '' } : null;
    },
    suggest() {
      return items;
    }
  };
  const reading = terminal.readLine({
    prompt: 'You: ',
    suggestionProviders: [provider]
  });
  tty.input.write('/');
  await delay(10);

  let lastFrame = tty.transcript().split('\u001b[0J').at(-1);
  assert.equal((lastFrame.match(/\/item-/g) ?? []).length, 8);
  for (let index = 0; index < 9; index++) {
    tty.input.write('\x1b[B');
  }
  lastFrame = tty.transcript().split('\u001b[0J').at(-1);
  assert.match(lastFrame, /\/item-10/);
  assert.doesNotMatch(lastFrame, /\/item-1(?:\D|$)/);

  tty.input.write('\x03');
  tty.input.write('\x03');
  assert.deepEqual(await reading, { type: 'interrupt' });
  terminal.close();
});

test('enhanced input discards stale asynchronous suggestions', async () => {
  const tty = createFakeTty();
  const terminal = new TerminalInputController(tty.input, tty.output);
  const provider = {
    trigger: '/',
    match(value, cursor) {
      return value.startsWith('/') && cursor === value.length
        ? { query: value.slice(1) }
        : null;
    },
    async suggest(request, signal) {
      await delay(request.query ? 5 : 30);
      if (signal.aborted) {
        return [];
      }
      return request.query
        ? [{ ...suggestion('help', '/help'), replaceEnd: 2 }]
        : [suggestion('exit', '/exit')];
    }
  };

  const reading = terminal.readLine({
    prompt: 'You: ',
    suggestionProviders: [provider]
  });
  tty.input.write('/h');
  await delay(45);
  tty.input.write('\r');

  assert.deepEqual(await reading, { type: 'line', value: '/help' });
  terminal.close();
});

test('escape dismisses suggestions and Ctrl+C interrupts an empty line', async () => {
  const tty = createFakeTty();
  const terminal = new TerminalInputController(tty.input, tty.output);
  const provider = {
    trigger: '/',
    match(value) {
      return value === '/' ? { query: '' } : null;
    },
    suggest() {
      return [suggestion('help', '/help')];
    }
  };

  const escaped = terminal.readLine({
    prompt: 'You: ',
    suggestionProviders: [provider]
  });
  tty.input.write('/');
  await delay(10);
  tty.input.emit('keypress', '', { name: 'escape' });
  tty.input.write('\r');
  assert.deepEqual(await escaped, { type: 'line', value: '/' });

  const interrupted = terminal.readLine({ prompt: 'You: ' });
  tty.input.write('\x03');
  assert.deepEqual(await interrupted, { type: 'interrupt' });
  terminal.close();
});

test('non-TTY input falls back to complete line processing', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalInputController(input, output);
  input.write('first line\n');

  assert.deepEqual(
    await terminal.readLine({ prompt: 'You: ', history: true }),
    { type: 'line', value: 'first line' }
  );
  input.end();
  assert.deepEqual(await terminal.readLine({ prompt: 'You: ' }), { type: 'eof' });
  terminal.close();
});
