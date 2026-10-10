import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { TerminalInputController } from '../dist/terminal-input.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createFakeTty() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
  };
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;

  let transcript = '';
  const chunks = [];
  output.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    chunks.push(text);
    transcript += text;
  });
  return { input, output, transcript: () => transcript, chunks: () => chunks };
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
      return value.startsWith('/') && cursor === value.length ? { query: value.slice(1) } : null;
    },
    suggest() {
      return [suggestion('help', '/help', '/help'), suggestion('model', '/model', '/model')];
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
      return value.startsWith('/') && cursor === value.length ? { query: value.slice(1) } : null;
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

test('Enter submits a complete context token instead of repeatedly accepting the same suggestion', async () => {
  const tty = createFakeTty();
  const terminal = new TerminalInputController(tty.input, tty.output);
  const value = '$phase7-demo 检查 @src/evidence.ts';
  const replaceStart = value.indexOf('@');
  const provider = {
    trigger: '@',
    match(currentValue, cursor) {
      return currentValue === value && cursor === currentValue.length ? { query: '' } : null;
    },
    suggest() {
      return [
        {
          id: 'context:src/evidence.ts',
          label: '@src/evidence.ts',
          description: 'Workspace file context',
          insertText: '@src/evidence.ts',
          replaceStart,
          replaceEnd: value.length
        }
      ];
    }
  };

  const reading = terminal.readLine({
    prompt: 'You: ',
    suggestionProviders: [provider]
  });
  tty.input.write(value);
  await delay(15);
  assert.match(tty.transcript(), /> @src\/evidence\.ts/);
  tty.input.write('\r');

  assert.deepEqual(await reading, { type: 'line', value });
  terminal.close();
});

test('suggestion redraws normalize multiline descriptions and reuse reserved rows', async () => {
  const tty = createFakeTty();
  tty.output.rows = 4;
  const terminal = new TerminalInputController(tty.input, tty.output);
  const provider = {
    trigger: '$',
    match(value, cursor) {
      return value === '$' && cursor === value.length ? { query: '' } : null;
    },
    suggest() {
      return [
        {
          ...suggestion('profile', '$profile ', '$profile'),
          description: 'Identity and profile management\nfor every workspace'
        }
      ];
    }
  };

  const reading = terminal.readLine({
    prompt: 'You: ',
    suggestionProviders: [provider]
  });
  tty.input.write('$');
  await delay(15);
  assert.match(tty.transcript(), /Identity and profile management for every workspace/);
  assert.equal(tty.chunks().filter((chunk) => chunk === '\n').length, 1);

  tty.input.write('\x03');
  tty.input.write('$');
  await delay(15);
  assert.equal(tty.chunks().filter((chunk) => chunk === '\n').length, 1);

  tty.input.write('\x03');
  tty.input.write('\x03');
  assert.deepEqual(await reading, { type: 'interrupt' });
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

  assert.deepEqual(await terminal.readLine({ prompt: 'You: ', history: true }), {
    type: 'line',
    value: 'first line'
  });
  input.end();
  assert.deepEqual(await terminal.readLine({ prompt: 'You: ' }), { type: 'eof' });
  terminal.close();
});

test('non-TTY input drains buffered lines even after the stream reaches EOF', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalInputController(input, output);
  input.end('first\nsecond\nthird\n');
  await delay(10);
  for (const value of ['first', 'second', 'third']) {
    assert.deepEqual(await terminal.readLine({ prompt: '> ' }), { type: 'line', value });
  }
  assert.deepEqual(await terminal.readLine({ prompt: '> ' }), { type: 'eof' });
  terminal.close();
});

test('enhanced input restores its paused stream after submit, interrupt, EOF and abort', async (t) => {
  for (const outcome of ['submit', 'interrupt', 'eof', 'abort']) {
    await t.test(outcome, async () => {
      const tty = createFakeTty();
      tty.input.pause();
      const terminal = new TerminalInputController(tty.input, tty.output);
      const abort = new AbortController();
      const reading = terminal.readLine({ prompt: '> ', signal: abort.signal });
      assert.equal(tty.input.readableFlowing, true);
      if (outcome === 'abort') {
        const rejected = assert.rejects(reading, /abort|cancel/i);
        abort.abort();
        await rejected;
      } else {
        tty.input.write(
          outcome === 'submit' ? 'done\r' : outcome === 'interrupt' ? '\x03' : '\x04'
        );
        assert.equal((await reading).type, outcome === 'submit' ? 'line' : outcome);
      }
      assert.equal(tty.input.readableFlowing, false);
      assert.equal(tty.input.isRaw, false);
      assert.equal(tty.input.listenerCount('keypress'), 0);
      assert.equal(tty.output.listenerCount('resize'), 0);
      assert.ok(tty.transcript().endsWith('\u001b[?2004l'));
      terminal.close();
    });
  }
});

test('enhanced input preserves caller-owned flowing and raw states', async () => {
  const tty = createFakeTty();
  tty.input.resume();
  tty.input.isRaw = true;
  const terminal = new TerminalInputController(tty.input, tty.output);
  const reading = terminal.readLine({ prompt: '> ' });
  tty.input.write('done\r');
  assert.deepEqual(await reading, { type: 'line', value: 'done' });
  terminal.close();
  terminal.close();
  assert.equal(tty.input.readableFlowing, true);
  assert.equal(tty.input.isRaw, true);
  tty.input.pause();
});

test('a deferred pause from the previous read cannot stop the next enhanced read', async () => {
  const tty = createFakeTty();
  tty.input.pause();
  const terminal = new TerminalInputController(tty.input, tty.output);
  const first = terminal.readLine({ prompt: '> ' });
  tty.input.write('first\r');
  const second = terminal.readLine({ prompt: '> ' });
  await delay(10);
  assert.equal(tty.input.readableFlowing, true);
  assert.equal(tty.input.isRaw, true);
  tty.input.write('second\r');
  assert.deepEqual(await first, { type: 'line', value: 'first' });
  assert.deepEqual(await second, { type: 'line', value: 'second' });
  assert.equal(tty.input.readableFlowing, false);
  terminal.close();
});

test('close settles an active enhanced read and leaves future reads at EOF', async () => {
  const tty = createFakeTty();
  tty.input.pause();
  const terminal = new TerminalInputController(tty.input, tty.output);
  const reading = terminal.readLine({ prompt: '> ' });
  terminal.close();
  terminal.close();
  assert.deepEqual(await reading, { type: 'eof' });
  assert.equal(tty.input.readableFlowing, false);
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.listenerCount('keypress'), 0);
  const before = tty.transcript();
  assert.deepEqual(await terminal.readLine({ prompt: '> ' }), { type: 'eof' });
  assert.equal(tty.transcript(), before);
});

test('enhanced input subprocess exits naturally while its parent keeps stdin open', async (t) => {
  const moduleUrl = new URL('../dist/terminal-input.js', import.meta.url).href;
  for (const outcome of ['submit', 'interrupt', 'eof', 'abort', 'close']) {
    await t.test(outcome, async () => {
      const source = `
        import { PassThrough } from 'node:stream';
        import { TerminalInputController } from ${JSON.stringify(moduleUrl)};
        process.stdin.isTTY = true;
        process.stdin.isRaw = false;
        process.stdin.setRawMode = (enabled) => { process.stdin.isRaw = enabled; };
        const output = new PassThrough();
        output.isTTY = true;
        output.columns = 80;
        output.rows = 24;
        output.resume();
        const terminal = new TerminalInputController(process.stdin, output);
        const abort = new AbortController();
        const reading = terminal.readLine({ prompt: '> ', signal: abort.signal });
        console.log('READY');
        if (${JSON.stringify(outcome)} === 'abort') setTimeout(() => abort.abort(), 10);
        if (${JSON.stringify(outcome)} === 'close') setTimeout(() => terminal.close(), 10);
        let result;
        try { result = (await reading).type; } catch { result = 'aborted'; }
        terminal.close();
        console.log(JSON.stringify({ result, flowing: process.stdin.readableFlowing, raw: process.stdin.isRaw }));
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let output = '';
      let error = '';
      let sent = false;
      let timedOut = false;
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (!sent && output.includes('READY')) {
          sent = true;
          if (outcome === 'submit') child.stdin.write('done\r');
          else if (outcome === 'interrupt') child.stdin.write('\x03');
          else if (outcome === 'eof') child.stdin.write('\x04');
        }
      });
      child.stderr.on('data', (chunk) => {
        error += chunk;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 5000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
      } finally {
        clearTimeout(timer);
        child.stdin.destroy();
      }
      assert.equal(timedOut, false, `Child retained open stdin: ${output}\n${error}`);
      assert.equal(code, 0, error);
      const receipt = JSON.parse(output.trim().split(/\r?\n/).at(-1));
      assert.equal(receipt.flowing, false);
      assert.equal(receipt.raw, false);
      assert.equal(
        receipt.result,
        outcome === 'submit'
          ? 'line'
          : outcome === 'close'
            ? 'eof'
            : outcome === 'abort'
              ? 'aborted'
              : outcome
      );
    });
  }
});
