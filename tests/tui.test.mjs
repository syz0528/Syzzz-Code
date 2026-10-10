import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import React from 'react';
import xtermHeadless from '@xterm/headless';
import { render as renderInk, Text, useStdout } from 'ink';
import { render as renderTestLibrary } from 'ink-testing-library';
import stringWidth from 'string-width';
import {
  isExplicitNewlineInput,
  normalizeTerminalInput,
  parseMouseInput,
  TuiApp
} from '../dist/tui/app.js';
import { encodeOsc52Clipboard, MAX_CLIPBOARD_CHARACTERS } from '../dist/tui/clipboard.js';
import { TerminalInputDecoder } from '../dist/tui/input-decoder.js';
import {
  compactConservativeTerminalOutput,
  ConservativeTuiOutput
} from '../dist/tui/output-adapter.js';
import {
  TranscriptView,
  transcriptLayoutForTest,
  useTranscriptLayout
} from '../dist/tui/transcript-view.js';
import {
  detectTerminalHost,
  inspectTerminalKeyboard,
  installTerminalShiftEnter,
  probeKittyKeyboardSupport,
  terminalKeyboardPresentation
} from '../dist/tui/terminal-keyboard.js';
import {
  createTerminalCapabilityProfile,
  formatTerminalCapabilityProfile
} from '../dist/tui/terminal-profile.js';
import { localizeSuggestionDescription, localizeTuiActivity } from '../dist/ui-language.js';

const wait = (milliseconds = 25) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function TestWindow({ children }) {
  const { stdout } = useStdout();
  // The testing library supplies columns, but not rows; do not inherit host terminal geometry.
  stdout.rows = 24;
  return children;
}

function render(tree) {
  const wrap = (content) => React.createElement(TestWindow, null, content);
  const view = renderTestLibrary(wrap(tree));
  return { ...view, rerender: (content) => view.rerender(wrap(content)) };
}

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

function writeTerminal(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function terminalScreen(terminal) {
  return Array.from(
    { length: terminal.rows },
    (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? ''
  ).join('\n');
}

function status() {
  return {
    sessionId: 'phase8-session',
    workspaceRoot: 'C:\\workspace',
    mode: 'code',
    permissionMode: 'safe',
    provider: {
      name: 'Provider',
      type: 'test',
      model: 'model',
      capabilities: { streaming: true, reasoningToggle: false }
    },
    messageCount: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    persistence: { state: 'healthy', dirty: false },
    extensions: {},
    composition: {},
    context: {
      estimatedInputTokens: 100,
      contextWindowTokens: 1000,
      triggerTokens: 850,
      compactions: 0,
      compactionCircuitOpen: false
    }
  };
}

class FakeController {
  listeners = new Set();
  submitted = [];
  resolved = [];
  snapshot = {
    revision: 0,
    state: 'idle',
    transcript: [
      {
        id: 'user-1',
        turnId: 'turn-1',
        kind: 'user',
        text: '检查中文界面',
        submittedAt: 0
      },
      {
        id: 'assistant-1',
        turnId: 'turn-1',
        kind: 'assistant',
        markdown: '界面已准备。',
        status: 'completed'
      }
    ],
    status: status(),
    stats: {
      tools: 0,
      failedTools: 0,
      retries: 0,
      compactions: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    },
    historyEnabled: true
  };
  suggestions = [
    {
      trigger: '/',
      match(value, cursor) {
        return value.startsWith('/') && cursor === value.length ? { query: value.slice(1) } : null;
      },
      suggest(request) {
        return [
          {
            id: 'command:model',
            label: '/model',
            description: `Switch model ${request.query}`,
            insertText: '/model ',
            replaceStart: 0,
            replaceEnd: request.query.length + 1
          }
        ];
      }
    },
    {
      trigger: '@',
      match(value, cursor) {
        return value.startsWith('@') && cursor === value.length ? { query: value.slice(1) } : null;
      },
      suggest(request) {
        return [
          {
            id: 'context:file',
            label: '@src/index.ts',
            description: 'Workspace file context',
            insertText: '@src/index.ts',
            replaceStart: 0,
            replaceEnd: request.query.length + 1
          }
        ];
      }
    },
    {
      trigger: '$',
      match(value, cursor) {
        return value.startsWith('$') && cursor === value.length ? { query: value.slice(1) } : null;
      },
      suggest(request) {
        return [
          {
            id: 'skill:demo',
            label: '$phase8-demo [project]',
            description: 'Review the TUI workflow',
            insertText: '$phase8-demo ',
            replaceStart: 0,
            replaceEnd: request.query.length + 1
          }
        ];
      }
    }
  ];
  inputHistory = ['/status'];

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  emit() {
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  submit(value) {
    this.submitted.push(value);
    return Promise.resolve();
  }
  notice() {}
  abortCurrent() {
    return false;
  }
  requestExit() {
    this.snapshot = { ...this.snapshot, state: 'exiting', exitReason: 'test' };
    this.emit();
  }
  resolvePending(value) {
    this.resolved.push(value);
    this.snapshot = { ...this.snapshot, pending: undefined };
    this.emit();
  }
  rejectPending() {
    this.resolved.push('cancelled');
  }
  updatePending(update) {
    this.snapshot = { ...this.snapshot, pending: { ...this.snapshot.pending, ...update } };
    this.emit();
  }
  toggleLatestToolDetail() {
    const index = this.snapshot.transcript.findLastIndex(
      (entry) => entry.kind === 'tool-group' && entry.items.some((item) => item.detail)
    );
    if (index < 0) return false;
    this.snapshot = {
      ...this.snapshot,
      transcript: this.snapshot.transcript.map((entry, entryIndex) =>
        entryIndex === index
          ? {
              ...entry,
              items: entry.items.map((item) =>
                item.detail ? { ...item, expanded: !item.expanded } : item
              )
            }
          : entry
      )
    };
    this.emit();
    return true;
  }
  setPending(pending) {
    this.snapshot = { ...this.snapshot, pending };
    this.emit();
  }
}

test('fullscreen TUI renders bounded Chinese content and reuses its suggestion region', async () => {
  const controller = new FakeController();
  controller.snapshot.status = {
    ...controller.snapshot.status,
    permissionMode: 'acceptEdits',
    context: {
      ...controller.snapshot.status.context,
      estimatedInputTokens: 50_000,
      contextWindowTokens: 65_536
    }
  };
  controller.snapshot.session = { permissionScope: 'workspace' };
  const view = render(React.createElement(TuiApp, { controller }));
  assert.match(view.lastFrame(), /检查中文界面/);
  assert.match(view.lastFrame(), /Syzzz Code/);
  assert.match(view.lastFrame(), /C:\\workspace/);
  assert.match(view.lastFrame(), /phase8-session/);
  assert.match(view.lastFrame(), /Provider \/ model/);
  assert.match(view.lastFrame(), /50K\/64K ctx/u);
  assert.match(view.lastFrame(), /acceptEdits:workspace/u);

  view.stdin.write('/');
  await wait(100);
  assert.match(view.lastFrame(), /\/model/);
  view.stdin.write('\u001b');
  view.stdin.write('\b');
  view.stdin.write('@');
  await wait(100);
  assert.match(view.lastFrame(), /@src\/index\.ts/);
  view.stdin.write('\u001b');
  view.stdin.write('\b');
  view.stdin.write('$');
  await wait(100);
  assert.match(view.lastFrame(), /\$phase8-demo/);
  view.stdin.write('\r');
  await wait();
  assert.match(view.lastFrame(), /\$phase8-demo/);
  view.stdin.write('检查');
  view.stdin.write('\r');
  await wait();
  assert.equal(controller.submitted.at(-1), '$phase8-demo 检查');
  view.stdin.write('第一行');
  view.stdin.write('\u001b[200~\n第二行🙂\u001b[201~');
  await wait();
  assert.match(view.lastFrame(), /第一行/);
  assert.match(view.lastFrame(), /第二行🙂/);
  assert.ok(
    view
      .lastFrame()
      .split('\n')
      .every((line) => stringWidth(line) <= 100)
  );
  view.unmount();
});

test('TUI composer supports Ctrl+A replacement before submission', async () => {
  const controller = new FakeController();
  const view = render(React.createElement(TuiApp, { controller }));

  view.stdin.write('draft 你🙂 text');
  view.stdin.write('\u0001');
  await wait();
  view.stdin.write('替换后的问题');
  view.stdin.write('\r');
  await wait();

  assert.equal(controller.submitted.at(-1), '替换后的问题');
  view.unmount();
});

test('TUI approval resolves without writing the answer into the composer', async () => {
  const controller = new FakeController();
  const view = render(React.createElement(TuiApp, { controller }));
  controller.setPending({
    id: 'approval-1',
    type: 'approval',
    scroll: 0,
    request: {
      toolCallId: 'write-1',
      toolName: 'Write',
      risk: 'write',
      input: { path: 'phase8.txt' },
      description: 'Create phase8.txt',
      preview: '+PHASE8',
      choices: ['allow-once', 'allow-edits-session', 'deny']
    }
  });
  await wait();
  assert.match(view.lastFrame(), /Approval: Write/);
  view.stdin.write('a');
  await wait();
  assert.match(view.lastFrame(), /> a/);
  assert.deepEqual(controller.resolved, []);
  view.stdin.write('\r');
  await wait();
  assert.deepEqual(controller.resolved, ['allow-edits-session']);
  view.unmount();
});

test('TUI select panels follow choices beyond the first visible page', async () => {
  const controller = new FakeController();
  const view = render(React.createElement(TuiApp, { controller }), { columns: 80, rows: 24 });
  controller.setPending({
    id: 'sessions',
    type: 'select',
    selected: 0,
    request: {
      title: 'Resume session',
      message: 'Choose any saved session',
      choices: Array.from({ length: 12 }, (_, index) => ({
        value: `session-${index + 1}`,
        label: `Session ${index + 1}`
      }))
    }
  });
  await wait();
  assert.match(view.lastFrame(), /Session 1/u);
  for (let index = 0; index < 9; index += 1) {
    view.stdin.write('\u001b[B');
    await wait(5);
  }
  assert.match(view.lastFrame(), /> Session 10/u);
  assert.doesNotMatch(view.lastFrame(), /Session 1(?:\D|$)/u);
  view.unmount();
});

test('alternate screen, raw mode, cursor and resize state restore after unmount', async () => {
  const controller = new FakeController();
  const stdin = new TtyInput();
  const stdout = ttyOutput();
  const stderr = ttyOutput();
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  const instance = renderInk(React.createElement(TuiApp, { controller }), {
    alternateScreen: true,
    exitOnCtrlC: false,
    interactive: true,
    patchConsole: false,
    stdin,
    stdout,
    stderr,
    incrementalRendering: true
  });
  await instance.waitUntilRenderFlush();
  assert.equal(stdin.isRaw, true);
  const initialFullClears = (output.match(/\u001b\[2J/gu) ?? []).length;
  stdin.write('你好');
  await wait(80);
  await instance.waitUntilRenderFlush();
  assert.match(output, /> 你好/u);
  stdin.write('\u007f');
  stdin.write('\u007f');
  stdin.write('/');
  await wait(100);
  await instance.waitUntilRenderFlush();
  stdin.write('\u007f');
  stdin.write('first');
  stdin.write('\u001b\r');
  stdin.write('二');
  await wait(100);
  await instance.waitUntilRenderFlush();
  assert.match(output, /> first[^\n]*\n[^\n]*\s二/u);
  const cursorSequences = [...output.matchAll(/\u001b\[(\d+)A\u001b\[(\d+)G\u001b\[\?25h/gu)];
  assert.ok(cursorSequences.length > 0);
  assert.equal((output.match(/\u001b\[2J/gu) ?? []).length, initialFullClears);
  const replay = new xtermHeadless.Terminal({
    cols: stdout.columns,
    rows: stdout.rows,
    allowProposedApi: true
  });
  await writeTerminal(replay, output.replace(/(?<!\r)\n/gu, '\r\n'));
  const screen = terminalScreen(replay);
  assert.match(screen, /Syzzz Code/);
  assert.match(screen, /> first/);
  assert.match(screen, /二/);
  const cursorLine = replay.buffer.active
    .getLine(replay.buffer.active.cursorY)
    ?.translateToString(true);
  assert.match(cursorLine ?? '', /二/);
  const cursorContent = cursorLine ?? '';
  assert.equal(
    replay.buffer.active.cursorX,
    stringWidth(cursorContent.slice(0, cursorContent.indexOf('二') + 1))
  );
  replay.dispose();
  stdout.columns = 30;
  stdout.rows = 10;
  stdout.emit('resize');
  await wait(50);
  await instance.waitUntilRenderFlush();
  assert.match(output, /Terminal too small/);
  instance.unmount();
  await instance.waitUntilExit();
  assert.equal(stdin.isRaw, false);
  assert.match(output, /\u001b\[\?1049h/u);
  assert.match(output, /\u001b\[\?1049l/u);
});

test('conservative renderer does not rewrite historical answers while typing or approving', async () => {
  const controller = new FakeController();
  controller.snapshot = {
    ...controller.snapshot,
    transcript: [
      { id: 'old-user', turnId: 'old-turn', kind: 'user', text: 'old question', submittedAt: 0 },
      {
        id: 'old-answer',
        turnId: 'old-turn',
        kind: 'assistant',
        markdown: 'HISTORICAL_ANSWER_MUST_STAY_STABLE',
        status: 'completed'
      }
    ]
  };
  const stdin = new TtyInput();
  const target = ttyOutput(100, 30);
  const stderr = ttyOutput(100, 30);
  const stdout = new ConservativeTuiOutput(target);
  let emitted = '';
  target.on('data', (chunk) => {
    emitted += chunk.toString('utf8');
  });
  const instance = renderInk(React.createElement(TuiApp, { controller }), {
    alternateScreen: true,
    concurrent: false,
    exitOnCtrlC: false,
    interactive: true,
    patchConsole: false,
    stdin,
    stdout,
    stderr,
    incrementalRendering: true
  });
  await instance.waitUntilRenderFlush();
  emitted = '';
  stdin.write('x');
  await wait(80);
  await instance.waitUntilRenderFlush();
  assert.doesNotMatch(emitted, /HISTORICAL_ANSWER_MUST_STAY_STABLE/u);
  assert.doesNotMatch(emitted, /\u001b\[2J/u);

  controller.setPending({
    id: 'approval-stability',
    type: 'approval',
    scroll: 0,
    request: {
      toolCallId: 'write-stability',
      toolName: 'Write',
      risk: 'write',
      input: { path: 'stable.txt' },
      description: 'Create stable.txt',
      preview: '+stable',
      choices: ['allow-once', 'allow-edits-session', 'deny']
    }
  });
  await wait(80);
  await instance.waitUntilRenderFlush();
  emitted = '';
  stdin.write('y');
  await wait(80);
  await instance.waitUntilRenderFlush();
  assert.doesNotMatch(emitted, /HISTORICAL_ANSWER_MUST_STAY_STABLE/u);
  assert.doesNotMatch(emitted, /\u001b\[2J/u);

  instance.unmount();
  await instance.waitUntilExit();
  stdout.dispose();
});

test('left-button drag selects visible transcript text and copies it without a mode switch', async () => {
  const controller = new FakeController();
  controller.snapshot = {
    ...controller.snapshot,
    transcript: [{ id: 'copy', kind: 'notice', text: 'SELECT_THIS_TEXT' }]
  };
  const copied = [];
  const view = render(
    React.createElement(TuiApp, {
      controller,
      copyToClipboard: (text) => copied.push(text)
    })
  );
  view.stdin.write('\u001b[<0;2;2M');
  view.stdin.write('\u001b[<32;20;2M');
  view.stdin.write('\u001b[<0;20;2m');
  await wait();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /SELECT_THIS_TEXT/);
  assert.match(view.lastFrame(), /Copied!/);
  view.unmount();
});

test('terminal clipboard output is bounded UTF-8 OSC 52 data', () => {
  const encoded = encodeOsc52Clipboard('中文 clipboard');
  assert.match(encoded, /^\u001b\]52;c;/u);
  const payload = encoded.slice('\u001b]52;c;'.length, -1);
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), '中文 clipboard');
  assert.throws(() => encodeOsc52Clipboard('x'.repeat(MAX_CLIPBOARD_CHARACTERS + 1)), /exceeds/);
});

test('TUI mouse wheel scrolls bounded transcript history in both directions', async () => {
  assert.deepEqual(parseMouseInput('\u001b[<0;12;3M'), {
    type: 'press',
    x: 12,
    y: 3
  });
  assert.deepEqual(parseMouseInput('\u001b[<32;12;4M'), {
    type: 'move',
    x: 12,
    y: 4
  });
  assert.deepEqual(parseMouseInput('\u001b[<0;12;4m'), {
    type: 'release',
    x: 12,
    y: 4
  });
  const controller = new FakeController();
  controller.snapshot = {
    ...controller.snapshot,
    transcript: Array.from({ length: 30 }, (_, index) => ({
      id: `row-${index}`,
      kind: 'notice',
      text: `TRANSCRIPT_ROW_${String(index).padStart(2, '0')}`
    }))
  };
  const view = render(React.createElement(TuiApp, { controller }), { columns: 70, rows: 18 });
  assert.match(view.lastFrame(), /TRANSCRIPT_ROW_29/);
  view.stdin.write('\u001b[<64;10;8M');
  await wait(80);
  assert.match(view.lastFrame(), /Viewing history/);
  assert.doesNotMatch(view.lastFrame(), /TRANSCRIPT_ROW_29/);
  view.stdin.write('\u001b[<65;10;8M');
  await wait(80);
  assert.match(view.lastFrame(), /TRANSCRIPT_ROW_29/);
  view.stdin.write('\u001b[<0;99;2M');
  await wait(80);
  assert.match(view.lastFrame(), /TRANSCRIPT_ROW_00/);
  view.stdin.write('\u001b[<32;99;99M');
  view.stdin.write('\u001b[<0;99;99m');
  await wait(80);
  assert.match(view.lastFrame(), /TRANSCRIPT_ROW_29/);
  view.unmount();
});

test('unknown Windows terminals treat arrow-translated wheel input as transcript scrolling', async () => {
  const controller = new FakeController();
  controller.snapshot = {
    ...controller.snapshot,
    transcript: Array.from({ length: 30 }, (_, index) => ({
      id: `fallback-row-${index}`,
      kind: 'notice',
      text: `FALLBACK_ROW_${String(index).padStart(2, '0')}`
    }))
  };
  const profile = createTerminalCapabilityProfile({
    keyboardStatus: {
      host: 'unknown',
      setupAvailable: false,
      setupInstalled: false
    },
    keyboard: { shiftEnterAvailable: false, newlineShortcut: 'Ctrl+J' },
    kittySupported: false,
    environment: {},
    platform: 'win32'
  });
  const view = render(React.createElement(TuiApp, { controller, profile }), {
    columns: 70,
    rows: 18
  });

  view.stdin.write('\u001b[A');
  await wait(80);
  assert.match(view.lastFrame(), /Viewing history/);
  assert.doesNotMatch(view.lastFrame(), /> \/status/);

  view.stdin.write('\u0010');
  await wait(80);
  assert.match(view.lastFrame(), /> \/status/);
  view.unmount();
});

test('terminal input separates batched SGR mouse reports from real text', () => {
  const normalized = normalizeTerminalInput(
    'de\u001b[<0;39;54M[<32;41;54M\u001b[<0;41;54m[<65;48;53M'
  );
  assert.equal(normalized.text, 'de');
  assert.deepEqual(normalized.mouseEvents, [
    { type: 'press', x: 39, y: 54 },
    { type: 'move', x: 41, y: 54 },
    { type: 'release', x: 41, y: 54 },
    { type: 'wheel', direction: 1 }
  ]);
  assert.equal(parseMouseInput('text\u001b[<0;1;1M'), undefined);
});

test('terminal input consumes embedded-terminal, URXVT, and X10 mouse variants', () => {
  const embedded = normalizeTerminalInput('before[0;39;54M[0;39;54m[65;48;53Mafter');
  assert.equal(embedded.text, 'beforeafter');
  assert.deepEqual(embedded.mouseEvents, [
    { type: 'press', x: 39, y: 54 },
    { type: 'release', x: 39, y: 54 },
    { type: 'wheel', direction: 1 }
  ]);

  const urxvt = normalizeTerminalInput('\u001b[96;12;8M\u001b[97;12;8M');
  assert.equal(urxvt.text, '');
  assert.deepEqual(urxvt.mouseEvents, [
    { type: 'wheel', direction: -1 },
    { type: 'wheel', direction: 1 }
  ]);

  const x10 = normalizeTerminalInput(
    `\u001b[M${String.fromCharCode(96)}${String.fromCharCode(44)}${String.fromCharCode(40)}`
  );
  assert.equal(x10.text, '');
  assert.deepEqual(x10.mouseEvents, [{ type: 'wheel', direction: -1 }]);
});

test('terminal input decoder preserves text while joining fragmented mouse reports', () => {
  const decoder = new TerminalInputDecoder();
  assert.deepEqual(decoder.push('before\u001b[<64;12;'), {
    text: 'before',
    mouseEvents: []
  });
  assert.deepEqual(decoder.push('3Mafter'), {
    text: 'after',
    mouseEvents: [{ type: 'wheel', direction: -1 }]
  });
  assert.equal(decoder.flush(), '');

  assert.deepEqual(decoder.push('\u001b[<0;4'), { text: '', mouseEvents: [] });
  assert.equal(decoder.flush(), '\u001b[<0;4');
});

test('terminal capability profile selects a conservative embedded Windows renderer', () => {
  const keyboardStatus = {
    host: 'vscode',
    setupAvailable: true,
    setupInstalled: false
  };
  const keyboard = { shiftEnterAvailable: false, newlineShortcut: 'Ctrl+J' };
  const conservative = createTerminalCapabilityProfile({
    keyboardStatus,
    keyboard,
    kittySupported: false,
    environment: {},
    platform: 'win32'
  });
  assert.equal(conservative.renderer, 'conservative');
  assert.equal(conservative.maxFps, 20);
  assert.equal(conservative.concurrentRendering, false);
  assert.equal(conservative.synchronizedOutput, 'coalesced');
  assert.equal(conservative.wheelInput, 'mouse-reports');
  assert.match(formatTerminalCapabilityProfile(conservative), /vscode \(embedded\)/);

  const overridden = createTerminalCapabilityProfile({
    keyboardStatus,
    keyboard,
    kittySupported: false,
    environment: { SYZZZ_TUI_PROFILE: 'standard' },
    platform: 'win32'
  });
  assert.equal(overridden.renderer, 'standard');
  assert.equal(overridden.override, 'standard');
  assert.equal(overridden.concurrentRendering, true);
  assert.equal(overridden.synchronizedOutput, 'ink-managed');

  const codexStatus = {
    host: detectTerminalHost({
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
      CODEX_THREAD_ID: 'thread-id'
    }),
    setupAvailable: false,
    setupInstalled: false
  };
  const codex = createTerminalCapabilityProfile({
    keyboardStatus: codexStatus,
    keyboard,
    kittySupported: false,
    environment: {},
    platform: 'win32'
  });
  assert.equal(codex.host, 'codex');
  assert.equal(codex.renderer, 'conservative');
  assert.equal(codex.wheelInput, 'arrow-fallback');

  const unknownWindows = createTerminalCapabilityProfile({
    keyboardStatus: {
      host: 'unknown',
      setupAvailable: false,
      setupInstalled: false
    },
    keyboard,
    kittySupported: false,
    environment: {},
    platform: 'win32'
  });
  assert.equal(unknownWindows.renderer, 'conservative');
  assert.equal(unknownWindows.concurrentRendering, false);
  assert.equal(unknownWindows.synchronizedOutput, 'coalesced');
  assert.equal(unknownWindows.wheelInput, 'arrow-fallback');
  assert.match(formatTerminalCapabilityProfile(unknownWindows), /history Ctrl\+P\/Ctrl\+N/);

  const sixtyFps = createTerminalCapabilityProfile({
    keyboardStatus,
    keyboard,
    kittySupported: false,
    environment: {},
    platform: 'win32',
    configuredFrameRate: 60
  });
  assert.equal(sixtyFps.renderer, 'conservative');
  assert.equal(sixtyFps.maxFps, 60);
  assert.equal(sixtyFps.configuredFrameRate, 60);
  assert.equal(sixtyFps.textFrameIntervalMs, 17);
  assert.match(formatTerminalCapabilityProfile(sixtyFps), /configured: 60/);
});

test('conservative TUI output coalesces synchronized frames and skips unchanged rows', async () => {
  const target = ttyOutput();
  const writes = [];
  target.on('data', (chunk) => writes.push(chunk.toString('utf8')));
  const output = new ConservativeTuiOutput(target);
  const begin = '\u001b[?2026h';
  const end = '\u001b[?2026l';
  const traversal = '\u001b[?25l\u001b[12B\u001b[1G\u001b[20A' + '\u001b[E'.repeat(8);
  output.write(begin);
  output.write(`${traversal}> changed\u001b[K`);
  assert.equal(writes.length, 0);
  output.write(end);
  await wait();
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0], /(?:\u001b\[E){2,}/u);
  assert.match(writes[0], /\u001b\[1G> changed/u);
  output.dispose();

  const compacted = compactConservativeTerminalOutput(traversal);
  assert.equal(compacted, '\u001b[?25l\u001b[1G');
});

test('TUI localization covers contextual suggestions, activities, and safe fallbacks', () => {
  assert.notEqual(
    localizeSuggestionDescription('context:src/index.ts', 'Workspace context', 'zh-CN'),
    'Workspace context'
  );
  assert.equal(localizeSuggestionDescription('skill:demo', 'Skill', 'zh-CN'), 'Skill');
  assert.equal(localizeSuggestionDescription('context:file', 'Context', 'en'), 'Context');

  assert.notEqual(localizeTuiActivity('thinking', 'zh-CN'), 'thinking');
  assert.match(localizeTuiActivity('Delegate running', 'zh-CN'), /^Delegate\s/u);
  assert.equal(localizeTuiActivity('custom activity', 'zh-CN'), 'custom activity');
  assert.equal(localizeTuiActivity('thinking', 'en'), 'thinking');
});

test('newline detection accepts Shift+Enter terminal encodings without treating Enter as newline', () => {
  const plain = { ctrl: false, meta: false, return: true, shift: false };
  assert.equal(isExplicitNewlineInput('\r', plain), false);
  assert.equal(isExplicitNewlineInput('\n', plain), true);
  assert.equal(
    isExplicitNewlineInput('\r', { ctrl: false, meta: false, return: true, shift: true }),
    true
  );
  assert.equal(
    isExplicitNewlineInput('\r', { ctrl: false, meta: true, return: true, shift: false }),
    true
  );
  assert.equal(
    isExplicitNewlineInput('\u001b[13;2u', {
      ctrl: false,
      meta: false,
      return: false,
      shift: false
    }),
    true
  );
  assert.equal(
    isExplicitNewlineInput('[27;2;13~', {
      ctrl: false,
      meta: false,
      return: false,
      shift: false
    }),
    true
  );
});

test('terminal keyboard probing completes before rendering and restores raw input state', async () => {
  const input = new TtyInput();
  const writes = [];
  const output = {
    isTTY: true,
    write(value) {
      writes.push(value);
      queueMicrotask(() => input.emit('data', Buffer.from('\u001b[?1u', 'latin1')));
      return true;
    }
  };
  assert.equal(
    await probeKittyKeyboardSupport(input, output, 20, { TERM_PROGRAM: 'test-terminal' }),
    true
  );
  assert.deepEqual(writes, ['\u001b[?u']);
  assert.equal(input.isRaw, false);
  assert.deepEqual(
    terminalKeyboardPresentation(true, {
      host: 'unknown',
      setupAvailable: false,
      setupInstalled: false
    }),
    { shiftEnterAvailable: true, newlineShortcut: 'Shift+Enter' }
  );

  const unsupported = new TtyInput();
  assert.equal(
    await probeKittyKeyboardSupport(unsupported, { isTTY: true, write: () => true }, 2, {
      TERM_PROGRAM: 'vscode'
    }),
    false
  );
  assert.equal(unsupported.isRaw, false);
});

test('terminal keyboard probing preserves unrelated input when capability detection times out', async () => {
  const input = new TtyInput();
  input.isRaw = true;
  input.pause();
  const output = {
    isTTY: true,
    write() {
      queueMicrotask(() => input.emit('data', 'typed-during-probe'));
      return true;
    }
  };

  assert.equal(
    await probeKittyKeyboardSupport(input, output, 2, { TERM_PROGRAM: 'plain-terminal' }),
    false
  );
  assert.equal(input.isRaw, true);
  assert.equal(input.isPaused(), true);
});

test('terminal setup installs an idempotent VS Code Shift+Enter mapping with backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-terminal-setup-'));
  const environment = { TERM_PROGRAM: 'vscode', APPDATA: root };
  const path = join(root, 'Code', 'User', 'keybindings.json');
  try {
    await mkdir(join(root, 'Code', 'User'), { recursive: true });
    await writeFile(path, '[\n  // keep this comment\n]\n', 'utf8');
    assert.equal(detectTerminalHost(environment), 'vscode');
    assert.equal((await inspectTerminalKeyboard(environment)).setupInstalled, false);
    const installed = await installTerminalShiftEnter(environment);
    assert.equal(installed.changed, true);
    assert.ok(installed.backupPath);
    assert.match(await readFile(installed.backupPath, 'utf8'), /keep this comment/);
    const content = await readFile(path, 'utf8');
    assert.match(content, /keep this comment/);
    assert.match(content, /workbench\.action\.terminal\.sendSequence/);
    assert.match(content, /shift\+enter/);
    assert.equal((await inspectTerminalKeyboard(environment)).setupInstalled, true);
    assert.equal((await installTerminalShiftEnter(environment)).changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal setup creates missing mappings and rejects malformed or conflicting configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-terminal-validation-'));
  const environment = { TERM_PROGRAM: 'cursor', APPDATA: root };
  const path = join(root, 'Cursor', 'User', 'keybindings.json');
  try {
    assert.equal(detectTerminalHost({ TERM_PROGRAM: 'ghostty' }), 'native-kitty');
    assert.deepEqual(await inspectTerminalKeyboard({ TERM_PROGRAM: 'plain' }, 'linux'), {
      host: 'unknown',
      setupAvailable: false,
      setupInstalled: false
    });
    await assert.rejects(
      () => installTerminalShiftEnter({ TERM_PROGRAM: 'plain' }, 'linux'),
      /setup is unavailable/
    );

    const created = await installTerminalShiftEnter(environment, 'linux');
    assert.equal(created.changed, true);
    assert.equal(created.backupPath, undefined);
    assert.match(await readFile(path, 'utf8'), /workbench\.action\.terminal\.sendSequence/);

    await writeFile(path, '[{"key":"shift+enter","command":"other"}]', 'utf8');
    const conflict = await inspectTerminalKeyboard(environment, 'linux');
    assert.match(conflict.conflict, /already assigned/);
    await assert.rejects(
      () => installTerminalShiftEnter(environment, 'linux'),
      /already assigned in the terminal keybindings/
    );

    await writeFile(path, '{}', 'utf8');
    await assert.rejects(
      () => installTerminalShiftEnter(environment, 'linux'),
      /Expected a JSON array/
    );

    await writeFile(path, '{ invalid', 'utf8');
    await assert.rejects(
      () => inspectTerminalKeyboard(environment, 'linux'),
      /Cannot update invalid JSON configuration/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal setup preserves Windows Terminal JSONC and refuses an occupied Shift+Enter binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-wt-setup-'));
  const environment = { WT_SESSION: 'test', LOCALAPPDATA: root };
  const directory = join(root, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState');
  const path = join(directory, 'settings.json');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, '{\n  // existing\n  "actions": [],\n  "keybindings": []\n}\n');
    const installed = await installTerminalShiftEnter(environment, 'win32');
    assert.equal(installed.changed, true);
    const content = await readFile(path, 'utf8');
    assert.match(content, /Syzzz\.SendShiftEnter/);
    assert.match(content, /sendInput/);
    assert.match(content, /existing/);
    assert.equal((await inspectTerminalKeyboard(environment, 'win32')).setupInstalled, true);

    await writeFile(
      path,
      '{"actions":[{"id":"Other","command":"copy"}],"keybindings":[{"id":"Other","keys":"shift+enter"}]}'
    );
    await assert.rejects(
      () => installTerminalShiftEnter(environment, 'win32'),
      /already assigned in Windows Terminal/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sticky question preserves the final visible answer row', () => {
  const blocks = [
    {
      id: 'question',
      turnId: 'turn',
      kind: 'user',
      text: 'question one\nquestion two\nquestion three\nquestion four\nquestion five',
      submittedAt: 0
    },
    {
      id: 'answer',
      turnId: 'turn',
      kind: 'assistant',
      markdown: 'line one\n\nline two\n\nline three\n\nline four\n\nline five\n\nFINAL_ANSWER_ROW',
      status: 'completed'
    }
  ];
  const layout = transcriptLayoutForTest(blocks, 50);
  const collapsed = render(
    React.createElement(TranscriptView, {
      layout,
      width: 50,
      height: 7
    })
  );
  assert.match(collapsed.lastFrame(), /> question one/);
  assert.match(collapsed.lastFrame(), /question three/);
  assert.doesNotMatch(collapsed.lastFrame(), /question four/);
  assert.match(collapsed.lastFrame(), /click to expand/);
  assert.match(collapsed.lastFrame(), /FINAL_ANSWER_ROW/);
  collapsed.unmount();

  const expanded = render(
    React.createElement(TranscriptView, {
      layout,
      width: 50,
      height: 7,
      stickyExpanded: true
    })
  );
  assert.match(expanded.lastFrame(), /question five/);
  assert.match(expanded.lastFrame(), /click to collapse/);
  assert.match(expanded.lastFrame(), /FINAL_ANSWER_ROW/);
  expanded.unmount();
});

test('TUI transcript keeps the latest streamed rows visible instead of clipping the response head', async () => {
  const controller = new FakeController();
  controller.snapshot = {
    ...controller.snapshot,
    transcript: [
      {
        id: 'assistant-stream',
        turnId: 'stream-turn',
        kind: 'assistant',
        markdown: 'starting',
        status: 'streaming'
      }
    ]
  };
  const view = render(React.createElement(TuiApp, { controller }), { columns: 60, rows: 18 });
  assert.match(view.lastFrame(), /starting/);
  controller.snapshot = {
    ...controller.snapshot,
    transcript: [
      {
        id: 'assistant-stream',
        kind: 'assistant',
        markdown: `starting ${'x'.repeat(900)} STREAM_TAIL`,
        status: 'streaming'
      }
    ]
  };
  controller.emit();
  await wait();
  assert.match(view.lastFrame(), /STREAM_TAIL/);
  view.unmount();
});

test('a single large live Provider delta is revealed by Markdown lines with an honest render status', async () => {
  const controller = new FakeController();
  const markdown = Array.from(
    { length: 18 },
    (_, index) => `STREAM_BLOCK_${String(index).padStart(2, '0')}`
  ).join('\n\n');
  controller.snapshot = {
    ...controller.snapshot,
    transcript: [
      {
        id: 'single-provider-delta',
        turnId: 'single-delta-turn',
        kind: 'assistant',
        markdown,
        status: 'completed',
        live: true
      }
    ]
  };
  const view = render(React.createElement(TuiApp, { controller }), { columns: 70, rows: 24 });
  assert.match(view.lastFrame(), /STREAM_BLOCK_00/);
  assert.doesNotMatch(view.lastFrame(), /STREAM_BLOCK_17/);
  assert.match(view.lastFrame(), /Rendering response/);
  await wait(700);
  assert.match(view.lastFrame(), /STREAM_BLOCK_17/);
  assert.doesNotMatch(view.lastFrame(), /Rendering response/);
  // Typing or a status update must not replay an already presented live answer.
  view.stdin.write('next');
  await wait();
  assert.match(view.lastFrame(), /STREAM_BLOCK_17/);
  assert.doesNotMatch(view.lastFrame(), /Rendering response/);
  controller.snapshot = {
    ...controller.snapshot,
    transcript: controller.snapshot.transcript.map((block) => ({ ...block }))
  };
  controller.emit();
  await wait();
  assert.match(view.lastFrame(), /STREAM_BLOCK_17/);
  assert.doesNotMatch(view.lastFrame(), /Rendering response/);
  view.unmount();
});

test('settled answers stay complete across resize, subsequent turns and cancelled streams', async () => {
  function Probe({ blocks, width = 40 }) {
    const layout = useTranscriptLayout(blocks, width);
    return React.createElement(
      Text,
      null,
      `pending=${layout.pendingPresentationRows}\n` +
        layout.rows.map((row) => row.spans.map((span) => span.text).join('')).join('\n')
    );
  }
  const first = {
    id: 'first',
    turnId: 'one',
    kind: 'assistant',
    markdown: 'START\n\nMIDDLE\n\nEND',
    status: 'completed',
    live: true
  };
  const view = render(React.createElement(Probe, { blocks: [first] }));
  try {
    await wait(500);
    assert.match(view.lastFrame(), /pending=0/);
    assert.match(view.lastFrame(), /END/);
    view.rerender(React.createElement(Probe, { blocks: [{ ...first }], width: 20 }));
    await wait();
    assert.match(view.lastFrame(), /pending=0/);
    assert.match(view.lastFrame(), /END/);
    const next = { ...first, id: 'next', turnId: 'two', markdown: 'PARTIAL', status: 'streaming' };
    view.rerender(React.createElement(Probe, { blocks: [first, next] }));
    await wait();
    assert.match(view.lastFrame(), /END/);
    assert.match(view.lastFrame(), /PARTIAL/);
    view.rerender(
      React.createElement(Probe, { blocks: [first, { ...next, status: 'cancelled' }] })
    );
    await wait(500);
    assert.match(view.lastFrame(), /pending=0/);
    assert.match(view.lastFrame(), /END/);
    assert.match(view.lastFrame(), /PARTIAL/);
    // A genuinely revised body must not be suppressed by the completed-source marker.
    view.rerender(
      React.createElement(Probe, {
        blocks: [{ ...first, markdown: 'REVISED\n\nFINAL', live: false }]
      })
    );
    await wait();
    assert.match(view.lastFrame(), /pending=0/);
    assert.match(view.lastFrame(), /FINAL/);
    assert.doesNotMatch(view.lastFrame(), /END|PARTIAL/);
  } finally {
    view.unmount();
  }
});

test('TUI renders bounded tool details, notices, omissions and every local interaction panel', async () => {
  const controller = new FakeController();
  controller.snapshot = {
    ...controller.snapshot,
    activity: 'Compacting context...',
    phase: 'compaction',
    transcript: [
      { id: 'omitted', kind: 'omitted', text: '12 older entries omitted' },
      { id: 'notice', kind: 'notice', tone: 'warning', text: 'Local warning' },
      {
        id: 'tool-group',
        turnId: 'tool-turn',
        kind: 'tool-group',
        category: 'action',
        items: [
          {
            id: 'tool',
            toolCallId: 'tool',
            name: 'Shell',
            status: 'error',
            durationMs: 42,
            summary: 'command failed',
            detail: 'bounded stderr',
            expanded: true
          }
        ]
      }
    ],
    stats: {
      tools: 1,
      failedTools: 1,
      retries: 1,
      compactions: 1,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
    }
  };
  const view = render(React.createElement(TuiApp, { controller }));
  assert.match(view.lastFrame(), /12 older entries omitted/);
  assert.match(view.lastFrame(), /bounded stderr/);
  assert.match(view.lastFrame(), /Compacting context/);
  view.stdin.write('\u000f');
  await wait();
  assert.doesNotMatch(view.lastFrame(), /bounded stderr/);

  controller.setPending({
    id: 'confirm',
    type: 'confirm',
    request: {
      title: 'Trust workspace',
      message: 'Review command',
      preview: 'node hook.mjs',
      confirmToken: 'y'
    }
  });
  await wait();
  assert.match(view.lastFrame(), /Trust workspace/);
  view.stdin.write('Y');
  await wait();
  assert.match(view.lastFrame(), /> Y/);
  view.stdin.write('\r');
  await wait();
  assert.deepEqual(controller.resolved.pop(), true);

  controller.setPending({
    id: 'select',
    type: 'select',
    selected: 0,
    request: {
      title: 'Select model',
      message: 'Configured models',
      choices: [
        { value: 'one', label: 'One', current: true },
        { value: 'two', label: 'Two', description: 'Second' }
      ]
    }
  });
  await wait();
  assert.match(view.lastFrame(), /Configured models/);
  view.stdin.write('\u001b[B');
  await wait();
  view.stdin.write('\r');
  await wait();
  assert.equal(controller.resolved.pop(), 'two');

  controller.setPending({
    id: 'text',
    type: 'text',
    value: '',
    request: { title: 'Rename', message: 'New title', maximumCharacters: 20, hidden: true }
  });
  await wait();
  view.stdin.write('abc');
  await wait();
  view.stdin.write('\u007f');
  await wait();
  view.stdin.write('\r');
  await wait();
  assert.equal(controller.resolved.pop(), 'ab');
  view.unmount();
});

test('TUI AskUser handles single, multi, and short text answers without touching composer', async () => {
  const controller = new FakeController();
  const view = render(React.createElement(TuiApp, { controller }));
  controller.setPending({
    id: 'questions',
    type: 'question',
    answers: {},
    request: {
      requestId: 'questions',
      questions: [
        {
          id: 'single',
          header: 'Mode',
          prompt: 'Choose mode',
          kind: 'single',
          options: [
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' }
          ]
        },
        {
          id: 'multi',
          header: 'Checks',
          prompt: 'Choose checks',
          kind: 'multi',
          options: [
            { value: 'lint', label: 'Lint' },
            { value: 'test', label: 'Test' }
          ]
        },
        { id: 'text', header: 'Note', prompt: 'Add note', kind: 'text' }
      ]
    }
  });
  await wait();
  assert.match(view.lastFrame(), /Choose mode/);
  assert.ok(
    view.lastFrame().indexOf('Choose mode') < view.lastFrame().lastIndexOf('>'),
    'AskUser panel must render directly above the composer'
  );
  assert.match(view.lastFrame(), /> One/);
  view.stdin.write('\u001b[B');
  await wait();
  view.stdin.write('\r');
  await wait();
  assert.match(view.lastFrame(), /Choose checks/);
  view.stdin.write(' ');
  await wait();
  view.stdin.write('\u001b[B');
  await wait();
  view.stdin.write(' ');
  await wait();
  view.stdin.write('\r');
  await wait();
  assert.match(view.lastFrame(), /Add note/);
  view.stdin.write('first');
  view.stdin.write('\u001b[13;2u');
  view.stdin.write('second');
  await wait();
  assert.match(view.lastFrame(), /first/);
  assert.match(view.lastFrame(), /second/);
  view.stdin.write('\r');
  await wait();
  assert.deepEqual(controller.resolved.pop(), {
    single: 'two',
    multi: ['lint', 'test'],
    text: 'first\nsecond'
  });
  assert.doesNotMatch(view.lastFrame(), />\s*first/u);
  view.unmount();
});

test('TUI AskUser offers a bounded custom answer alongside Agent choices', async () => {
  const controller = new FakeController();
  const view = render(React.createElement(TuiApp, { controller }));
  controller.setPending({
    id: 'custom-question',
    type: 'question',
    answers: {},
    request: {
      requestId: 'custom-question',
      questions: [
        {
          id: 'direction',
          header: 'Direction',
          prompt: 'Choose a direction',
          kind: 'single',
          allowCustom: false,
          options: [
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' }
          ]
        }
      ]
    }
  });
  await wait();
  assert.match(view.lastFrame(), /Type my own answer/);
  assert.match(view.lastFrame(), /C type my own answer/);
  view.stdin.write('c');
  await wait();
  view.stdin.write('my ');
  view.stdin.write('\u001b[<0;39;10M\u001b[<32;40;10M\u001b[<0;40;10m\u001b[<65;48;9M');
  view.stdin.write('own path');
  await wait();
  assert.match(view.lastFrame(), /my own path/);
  assert.doesNotMatch(view.lastFrame(), /\[<\d+;/u);
  view.stdin.write('\r');
  await wait();
  assert.deepEqual(controller.resolved.at(-1), { direction: 'my own path' });
  view.unmount();
});

test('Chinese TUI chrome localizes activity, approval, choices, and footer labels', async () => {
  const controller = new FakeController();
  controller.snapshot = {
    ...controller.snapshot,
    language: 'zh-CN',
    activity: {
      turnId: 'zh-turn',
      phase: 'tools',
      detail: 'AskUser running',
      startedAt: Date.now(),
      accumulatedActiveMs: 1_000,
      waitingForInput: true
    },
    stats: { ...controller.snapshot.stats, tools: 2 }
  };
  const view = render(React.createElement(TuiApp, { controller }));
  assert.match(view.lastFrame(), /等待输入/);
  assert.match(view.lastFrame(), /2 次工具/);
  controller.setPending({
    id: 'approval-zh',
    type: 'approval',
    scroll: 0,
    request: {
      toolCallId: 'write-zh',
      toolName: 'Write',
      risk: 'write',
      input: { path: 'zh.txt' },
      description: 'Create zh.txt',
      choices: ['allow-once', 'allow-edits-session', 'deny']
    }
  });
  await wait();
  assert.match(view.lastFrame(), /操作审批: Write/);
  assert.match(view.lastFrame(), /本次.*本会话编辑.*拒绝.*取消/);
  view.unmount();
});
