import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import React from 'react';
import { render as renderInk, Text, useApp } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { InteractivePhase8Spike, Phase8SpikeView, SPIKE_SUGGESTIONS } from './app.mjs';
import { resolveUiMode } from './ui-mode.mjs';

const h = React.createElement;
const wait = (milliseconds = 20) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const transcript = [
  { role: 'user', text: '分析中文路径和 terminal resize。' },
  { role: 'assistant', text: '正在流式返回结果，布局不应污染 shell scrollback。' }
];

class TtyInput extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(enabled) {
    this.isRaw = enabled;
    return this;
  }

  ref() {}

  unref() {}
}

function ttyOutput(columns = 80, rows = 24) {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  stream.getColorDepth = () => 8;
  stream.hasColors = () => true;
  return stream;
}

test('UI mode selection keeps TUI explicit and falls back safely', () => {
  const interactive = {
    stdinTTY: true,
    stdoutTTY: true,
    nonInteractive: false,
    screenReader: false
  };
  assert.equal(resolveUiMode('auto', interactive), 'tui');
  assert.equal(resolveUiMode('inline', interactive), 'inline');
  assert.equal(resolveUiMode('auto', { ...interactive, stdoutTTY: false }), 'inline');
  assert.equal(resolveUiMode('auto', { ...interactive, screenReader: true }), 'inline');
  assert.throws(
    () => resolveUiMode('tui', { ...interactive, stdinTTY: false }),
    /requires an interactive TTY/
  );
});

test('fullscreen view preserves Chinese content across wide and narrow layouts', () => {
  const view = render(
    h(Phase8SpikeView, {
      composer: '$phase71-demo 检查 @src/runtime-engine.ts',
      suggestions: SPIKE_SUGGESTIONS.filter((item) => item.trigger === '$'),
      transcript,
      viewport: { columns: 80, rows: 24 }
    })
  );
  assert.match(view.lastFrame(), /分析中文路径/);
  assert.match(view.lastFrame(), /\$phase71-demo/);
  assert.ok(
    view
      .lastFrame()
      .split('\n')
      .every((line) => stringWidth(line) <= 80)
  );

  view.rerender(
    h(Phase8SpikeView, {
      composer: '$phase71-demo 检查 @src/runtime-engine.ts',
      suggestions: SPIKE_SUGGESTIONS.filter((item) => item.trigger === '$'),
      transcript,
      viewport: { columns: 42, rows: 18 }
    })
  );
  assert.match(view.lastFrame(), /Syzzz · Phase 8/);
  assert.match(view.lastFrame(), /\$phase71-demo 检查/);
  assert.ok(
    view
      .lastFrame()
      .split('\n')
      .every((line) => stringWidth(line) <= 42)
  );
  view.unmount();
});

test('slash, context, and Skill suggestions reuse one stable interaction region', async () => {
  const view = render(
    h(InteractivePhase8Spike, {
      transcript,
      viewport: { columns: 72, rows: 22 }
    })
  );
  view.stdin.write('$');
  await wait();
  assert.match(view.lastFrame(), /\$phase71-demo/);
  const skillRows = view.lastFrame().split('\n').length;

  view.stdin.write('\u001B');
  view.stdin.write('\b');
  view.stdin.write('/');
  await wait();
  assert.match(view.lastFrame(), /\/model/);
  assert.equal(view.lastFrame().split('\n').length, skillRows);

  view.stdin.write('p');
  await wait();
  view.stdin.write('\t');
  await wait();
  assert.match(view.lastFrame(), /\/permissions/);
  view.unmount();
});

test('structured approval and Ctrl+C produce decisions without entering composer history', async () => {
  const actions = [];
  const view = render(
    h(InteractivePhase8Spike, {
      interaction: {
        tool: 'Write',
        description: 'Create phase8.txt',
        preview: '+PHASE8'
      },
      onAction: (action) => actions.push(action),
      transcript,
      viewport: { columns: 72, rows: 22 }
    })
  );
  assert.match(view.lastFrame(), /Approval · Write/);
  view.stdin.write('y');
  await wait();
  assert.deepEqual(actions.shift(), { type: 'approval', choice: 'allow-once' });
  view.stdin.write('\u0003');
  await wait();
  assert.deepEqual(actions.shift(), { type: 'cancel' });
  assert.doesNotMatch(view.lastFrame(), /You \[code\|safe\] y/);
  view.unmount();
});

test('bracketed paste preserves multiline Unicode as one composer operation', async () => {
  const view = render(
    h(InteractivePhase8Spike, {
      transcript,
      viewport: { columns: 72, rows: 22 }
    })
  );
  view.stdin.write('\u001B[200~第一行\n第二行 @src/index.ts\u001B[201~');
  await wait(40);
  assert.match(view.lastFrame(), /第一行/);
  assert.match(view.lastFrame(), /第二行 @src\/index\.ts/);
  view.unmount();
});

test('high-frequency transcript rerenders remain bounded and retain the final delta', () => {
  const view = render(
    h(Phase8SpikeView, {
      transcript,
      viewport: { columns: 80, rows: 24 }
    })
  );
  const startedAt = performance.now();
  let streamed = '';
  for (let index = 0; index < 1000; index += 1) {
    streamed += index % 10;
    view.rerender(
      h(Phase8SpikeView, {
        transcript: [...transcript, { role: 'assistant', text: streamed }],
        viewport: { columns: 80, rows: 24 }
      })
    );
  }
  const durationMs = performance.now() - startedAt;
  assert.match(view.lastFrame(), /0123456789/);
  assert.ok(durationMs < 10_000, `1000 rerenders took ${durationMs.toFixed(1)}ms`);
  view.unmount();
});

test('alternate screen and raw mode are restored after unmount', async () => {
  const stdin = new TtyInput();
  const stdout = ttyOutput();
  const stderr = ttyOutput();
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  const instance = renderInk(
    h(InteractivePhase8Spike, {
      transcript
    }),
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
      stderr,
      stdin,
      stdout
    }
  );
  await instance.waitUntilRenderFlush();
  await wait();
  assert.equal(stdin.isRaw, true);
  stdout.columns = 42;
  stdout.rows = 18;
  stdout.emit('resize');
  await wait();
  await instance.waitUntilRenderFlush();
  assert.match(output, /Syzzz · Phase 8/);
  instance.unmount();
  await instance.waitUntilExit();
  assert.match(output, /\u001B\[\?1049h/u);
  assert.match(output, /\u001B\[\?1049l/u);
  assert.equal(stdin.isRaw, false);
});

test('terminal suspension releases and reacquires fullscreen state around a child task', async () => {
  const stdin = new TtyInput();
  const stdout = ttyOutput();
  const stderr = ttyOutput();
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  let resolveProbe;
  const probe = new Promise((resolve) => {
    resolveProbe = resolve;
  });

  function SuspensionProbe() {
    const { suspendTerminal } = useApp();
    React.useEffect(() => {
      void suspendTerminal(async () => {
        resolveProbe(stdin.isRaw);
      });
    }, [suspendTerminal]);
    return h(Text, null, 'suspension-probe');
  }

  const instance = renderInk(h(SuspensionProbe), {
    alternateScreen: true,
    interactive: true,
    patchConsole: false,
    stderr,
    stdin,
    stdout
  });
  assert.equal(await probe, false, 'child task must receive a non-raw terminal');
  await wait();
  assert.equal(stdin.isRaw, false, 'no input hook requested raw mode after resume');
  instance.unmount();
  await instance.waitUntilExit();
  assert.ok(output.split('\u001B[?1049h').length - 1 >= 2, 'alternate screen must re-enter');
  assert.ok(output.split('\u001B[?1049l').length - 1 >= 2, 'alternate screen must exit twice');
});
