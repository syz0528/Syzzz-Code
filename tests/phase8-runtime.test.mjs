import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { QueryEngine } from '../dist/engine.js';
import { TaskCompositionRuntime } from '../dist/composition/runtime.js';
import { toAuditRecord } from '../dist/audit.js';
import { WorkspaceInputHistory } from '../dist/interaction/history.js';
import { InteractionController } from '../dist/interaction/controller.js';
import { InlineInteractionPort } from '../dist/interaction/inline-port.js';
import {
  ComposerBuffer,
  MAX_COMPOSER_BYTES,
  createComposerViewport,
  splitAtGraphemeCursor
} from '../dist/tui/composer-buffer.js';
import { partitionMarkdownSource, renderMarkdown } from '../dist/tui/markdown.js';
import { CATCH_UP_DEPTH, StreamingTextPresenter } from '../dist/tui/streaming-presenter.js';
import { resolveUiMode } from '../dist/ui-mode.js';
import {
  askUserInputSchema,
  askUserTool,
  validateUserInputAnswers
} from '../dist/tools/ask-user-tool.js';

function providerInfo() {
  return {
    name: 'Phase 8 Provider',
    type: 'test',
    model: 'phase8-model',
    capabilities: { streaming: false, reasoningToggle: false }
  };
}

function conversationText(entry) {
  return entry.kind === 'assistant' ? entry.markdown : (entry.text ?? '');
}

async function collect(turn) {
  const events = [];
  while (true) {
    const next = await turn.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

test('AskUser is exposed only with a handler and returns validated answers through tool history', async () => {
  const requests = [];
  const provider = {
    async chat(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'ask-1',
                name: 'AskUser',
                input: {
                  questions: [
                    {
                      id: 'choice',
                      header: 'Mode',
                      prompt: 'Choose one mode',
                      kind: 'single',
                      options: [
                        { value: 'safe', label: 'Safe' },
                        { value: 'fast', label: 'Fast' }
                      ]
                    }
                  ]
                }
              }
            ]
          }
        };
      }
      return { message: { role: 'assistant', content: 'Selected safe.' } };
    },
    getInfo: providerInfo
  };
  const engine = new QueryEngine({ provider, tools: [askUserTool], audit: false });
  const { events, result } = await collect(
    engine.runTurn('Ask me', {
      async requestUserInput(request) {
        assert.equal(request.questions[0].prompt, 'Choose one mode');
        return { choice: 'safe' };
      }
    })
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(
    events.filter((event) => event.type.startsWith('user_input_')).map((event) => event.type),
    ['user_input_requested', 'user_input_resolved']
  );
  assert.equal(events.find((event) => event.type === 'user_input_resolved').outcome, 'answered');
  assert.ok(requests[0].tools.some((tool) => tool.name === 'AskUser'));
  assert.match(requests[0].systemPrompt, /Interactive AskUser is available/);
  assert.match(requests[0].systemPrompt, /Do not print a numbered question list/);
  assert.match(requests[0].systemPrompt, /prefer a single-select question with 2-6 options/);
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), {
    answers: { choice: 'safe' }
  });
  assert.deepEqual(engine.getConversationDisplaySnapshot().messages, [
    { role: 'user', content: 'Ask me' },
    { role: 'assistant', content: 'Selected safe.' }
  ]);
});

test('AskUser fails closed without a handler and audit records no question or answer text', async () => {
  const requests = [];
  const provider = {
    async chat(request) {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'forged-ask',
                  name: 'AskUser',
                  input: {
                    questions: [
                      { id: 'secret', header: 'Secret', prompt: 'private prompt', kind: 'text' }
                    ]
                  }
                }
              ]
            }
          }
        : { message: { role: 'assistant', content: 'Unavailable.' } };
    },
    getInfo: providerInfo
  };
  const engine = new QueryEngine({ provider, tools: [askUserTool], audit: false });
  assert.equal(await engine.chat('Do not ask'), 'Unavailable.');
  assert.equal(
    requests[0].tools.some((tool) => tool.name === 'AskUser'),
    false
  );
  assert.doesNotMatch(requests[0].systemPrompt, /Interactive AskUser is available/);
  assert.match(requests[1].messages.at(-1).content, /no interactive input handler/i);

  const record = toAuditRecord(
    {
      schemaVersion: 1,
      sessionId: 'session',
      turnId: 'turn',
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      type: 'user_input_resolved',
      requestId: 'request',
      questionCount: 2,
      durationMs: 15,
      outcome: 'answered'
    },
    'workspace'
  );
  assert.deepEqual(record, {
    schemaVersion: 1,
    sessionId: 'session',
    turnId: 'turn',
    sequence: 1,
    timestamp: new Date(0).toISOString(),
    workspaceId: 'workspace',
    type: 'user_input_resolved',
    requestId: 'request',
    questionCount: 2,
    durationMs: 15,
    outcome: 'answered'
  });
});

test('grill-me Skill activation enters the structured AskUser lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-phase8-grill-me-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const skillRoot = join(workspace, '.agents', 'skills', 'grill-me');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(home, '.syzzz-code'), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    [
      '---',
      'name: grill-me',
      'description: Stress-test a plan through structured questions.',
      '---',
      '',
      'Before reviewing the plan, you MUST call AskUser with a single-select question.',
      ''
    ].join('\n'),
    'utf8'
  );
  try {
    const composition = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home
    });
    const requests = [];
    const provider = {
      async chat(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          assert.match(request.messages.at(-1).content, /grill-me/);
          assert.match(request.messages.at(-1).content, /MUST call AskUser/);
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'grill-question',
                  name: 'AskUser',
                  input: {
                    questions: [
                      {
                        id: 'priority',
                        header: 'Priority',
                        prompt: 'Which quality matters most?',
                        kind: 'single',
                        options: [
                          { value: 'safety', label: 'Safety' },
                          { value: 'speed', label: 'Speed' }
                        ]
                      }
                    ]
                  }
                }
              ]
            }
          };
        }
        return { message: { role: 'assistant', content: 'Shared understanding reached.' } };
      },
      getInfo: providerInfo
    };
    const engine = new QueryEngine({
      provider,
      tools: [...composition.getTools(), askUserTool],
      composition,
      workspaceRoot: workspace,
      audit: false
    });
    const { events, result } = await collect(
      engine.runTurn('$grill-me review this plan', {
        async requestUserInput() {
          return { priority: 'safety' };
        }
      })
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(
      events
        .filter((event) =>
          ['skill_activated', 'user_input_requested', 'user_input_resolved'].includes(event.type)
        )
        .map((event) => event.type),
      ['skill_activated', 'user_input_requested', 'user_input_resolved']
    );
    assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), {
      answers: { priority: 'safety' }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UI mode routing is deterministic and explicit TUI fails closed', () => {
  const ready = {
    stdinTTY: true,
    stdoutTTY: true,
    ci: false,
    dumbTerminal: false,
    screenReader: false
  };
  assert.equal(resolveUiMode('auto', ready), 'tui');
  assert.equal(resolveUiMode('inline', ready), 'inline');
  assert.equal(resolveUiMode('auto', { ...ready, ci: true }), 'inline');
  assert.equal(resolveUiMode('auto', { ...ready, screenReader: true }), 'inline');
  assert.throws(() => resolveUiMode('tui', { ...ready, stdoutTTY: false }), /requires interactive/);
});

test('ComposerBuffer edits graphemes and preserves multiline paste without splitting emoji', () => {
  const buffer = new ComposerBuffer('A你👩‍💻\nnext');
  buffer.set(buffer.value, buffer.value.indexOf('\n'));
  buffer.backspace();
  assert.equal(buffer.value, 'A你\nnext');
  buffer.moveHome();
  buffer.moveEnd();
  assert.equal(buffer.cursor, 2);
  assert.equal(buffer.insert('\r\n组合'), true);
  assert.equal(buffer.value, 'A你\n组合\nnext');
  assert.equal(buffer.insert('x'.repeat(MAX_COMPOSER_BYTES)), false);
});

test('question text cursor keeps emoji and combining characters intact', () => {
  assert.deepEqual(splitAtGraphemeCursor('A👩‍💻e\u0301Z', 1), {
    before: 'A',
    current: '👩‍💻',
    after: 'e\u0301Z'
  });
  assert.deepEqual(splitAtGraphemeCursor('A👩‍💻e\u0301Z', 'A👩‍💻'.length), {
    before: 'A👩‍💻',
    current: 'e\u0301',
    after: 'Z'
  });
});

test('ComposerBuffer covers deletion, horizontal and vertical grapheme navigation boundaries', () => {
  assert.throws(() => new ComposerBuffer('x'.repeat(MAX_COMPOSER_BYTES + 1)), /exceeds/);
  const buffer = new ComposerBuffer('ab\n你🙂\nxyz');
  buffer.moveLeft();
  assert.equal(buffer.cursor, buffer.value.length - 1);
  buffer.moveRight();
  assert.equal(buffer.cursor, buffer.value.length);
  assert.equal(buffer.delete(), false);
  buffer.moveHome();
  assert.equal(buffer.cursor, 7);
  assert.equal(buffer.delete(), true);
  assert.equal(buffer.value, 'ab\n你🙂\nyz');
  buffer.moveVertical(-1);
  assert.equal(buffer.cursor, 3);
  buffer.moveVertical(-1);
  assert.equal(buffer.cursor, 0);
  buffer.moveVertical(-1);
  assert.equal(buffer.cursor, 0);
  buffer.moveVertical(1);
  buffer.moveVertical(1);
  buffer.moveVertical(1);
  assert.equal(buffer.cursor, buffer.value.length);
  buffer.set('one\r\ntwo', -50);
  assert.equal(buffer.cursor, 0);
  assert.throws(() => buffer.set('x'.repeat(MAX_COMPOSER_BYTES + 1)), /exceeds/);
  buffer.clear();
  assert.equal(buffer.empty, true);
  assert.equal(buffer.backspace(), false);
});

test('Composer viewport keeps the real cursor aligned across CJK, emoji, long lines, and scrolling', () => {
  const wide = createComposerViewport('ab你🙂', 'ab你🙂'.length, 12, 3);
  assert.equal(wide.cursorX, 6);
  assert.deepEqual(wide.lines, ['ab你🙂']);

  const horizontal = createComposerViewport('0123456789你', '0123456789你'.length, 6, 3);
  assert.ok(horizontal.cursorX >= 0 && horizontal.cursorX < 6);
  assert.ok(horizontal.lines[0].length < '0123456789你'.length);

  const multiline = createComposerViewport('first\nsecond\n第三行\nfourth', 15, 20, 2);
  assert.equal(multiline.totalLogicalLines, 4);
  assert.ok(multiline.cursorRow >= 0 && multiline.cursorRow < multiline.lines.length);
});

test('workspace history is isolated, bounded, persistent, and quarantines damage', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'syzzz-phase8-history-'));
  const first = await WorkspaceInputHistory.create({
    workspaceRoot: join(baseDirectory, 'one'),
    baseDirectory
  });
  const second = await WorkspaceInputHistory.create({
    workspaceRoot: join(baseDirectory, 'two'),
    baseDirectory
  });
  assert.notEqual(first.path, second.path);
  await first.record('/status');
  await first.record('/status');
  await first.record('你好\nPhase 8');
  assert.deepEqual(first.list(), ['/status', '你好\nPhase 8']);
  const reloaded = await WorkspaceInputHistory.create({
    workspaceRoot: join(baseDirectory, 'one'),
    baseDirectory
  });
  assert.deepEqual(reloaded.list(), first.list());
  assert.equal(JSON.parse(await readFile(first.path, 'utf8')).schemaVersion, 1);

  let warning = '';
  await writeFile(first.path, '{broken', 'utf8');
  const damaged = await WorkspaceInputHistory.create({
    workspaceRoot: join(baseDirectory, 'one'),
    baseDirectory,
    onWarning: (message) => {
      warning = message;
    }
  });
  assert.deepEqual(damaged.list(), []);
  assert.match(warning, /isolated/);
});

function displayEngine(sessionId, label) {
  const skill = {
    name: `${label}-skill`,
    source: 'project',
    shadowed: false,
    enabled: true,
    interface: {
      displayName: `${label} skill`,
      shortDescription: `${label} session skill`
    }
  };
  return {
    getSessionId: () => sessionId,
    getProviderInfo: providerInfo,
    getCompositionRuntime: () => ({ listSkills: () => [skill] }),
    getConversationDisplaySnapshot: () => ({
      messages: [
        { role: 'user', content: `${label} user` },
        { role: 'assistant', content: `${label} assistant` }
      ],
      omitted: 0,
      total: 2,
      bytes: 32
    }),
    getStatus: () => ({
      sessionId,
      workspaceRoot: 'C:\\phase8-workspace',
      mode: 'code',
      permissionMode: 'safe',
      provider: providerInfo(),
      messageCount: 2,
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
    })
  };
}

test('controller replaces restored transcript and suggestions when a session switches engines', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'syzzz-phase8-controller-'));
  const oldEngine = displayEngine('old-session', 'old');
  const newEngine = displayEngine('new-session', 'new');
  const session = {
    engine: oldEngine,
    providerId: 'provider',
    sessionStore: { workspaceDirectory: baseDirectory },
    getStatus() {
      return {
        sessionId: this.engine.getSessionId(),
        title: 'Session',
        revision: 0,
        autoSave: true,
        dirty: false,
        persistence: 'healthy'
      };
    },
    hasUnsavedChanges: () => false,
    async newSession() {
      this.engine = newEngine;
      return { sessionId: 'new-session', title: 'New session', providerId: 'provider' };
    },
    async close() {}
  };
  const controller = await InteractionController.create({
    engine: oldEngine,
    sessionOptions: {
      session,
      modelsForProvider: () => ['phase8-model']
    },
    streamOutput: true,
    persistentHistory: false,
    historyBaseDirectory: baseDirectory
  });

  await controller.submit('/new');
  const transcriptText = controller.getSnapshot().transcript.map(conversationText).join('\n');
  assert.doesNotMatch(transcriptText, /old user|old assistant/);
  assert.match(transcriptText, /new user/);
  assert.match(transcriptText, /Started session new-sess/);

  const skills = controller.suggestions.find((provider) => provider.trigger === '$');
  const request = skills.match('$', 1);
  const suggestions = await skills.suggest(request, new AbortController().signal);
  assert.deepEqual(
    suggestions.map((item) => item.id),
    ['skill:new-skill']
  );
  await controller.close();
});

test('TUI startup offers a saved workspace conversation before starting a new one', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'syzzz-phase8-startup-'));
  const freshEngine = displayEngine('fresh-session', 'fresh');
  const savedEngine = displayEngine('saved-session', 'saved');
  let resumeCalls = 0;
  const session = {
    engine: freshEngine,
    providerId: 'provider',
    sessionStore: { workspaceDirectory: baseDirectory },
    getStatus() {
      return {
        sessionId: this.engine.getSessionId(),
        title: 'Session',
        revision: 0,
        autoSave: true,
        dirty: false,
        persistence: 'healthy',
        permissionScope: 'none'
      };
    },
    async list() {
      return [
        {
          sessionId: 'saved-session',
          title: 'Previous work',
          updatedAt: '2026-08-06T00:00:00.000Z',
          available: true
        }
      ];
    },
    async resume(sessionId) {
      assert.equal(sessionId, 'saved-session');
      resumeCalls += 1;
      this.engine = savedEngine;
      return {
        sessionId,
        title: 'Previous work',
        providerId: 'provider'
      };
    },
    async close() {}
  };
  const controller = await InteractionController.create({
    engine: freshEngine,
    sessionOptions: {
      session,
      modelsForProvider: () => ['phase8-model']
    },
    uiLanguage: 'zh-CN',
    streamOutput: true,
    persistentHistory: false,
    historyBaseDirectory: baseDirectory
  });

  const startup = controller.promptSessionStartup(new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  const pending = controller.getSnapshot().pending;
  assert.equal(pending.type, 'select');
  assert.equal(pending.request.title, '打开会话');
  assert.deepEqual(
    pending.request.choices.map((choice) => choice.value),
    ['saved-session', 'new']
  );
  controller.resolvePending('saved-session');
  await startup;

  assert.equal(resumeCalls, 1);
  assert.equal(session.engine, savedEngine);
  assert.match(controller.getSnapshot().transcript.map(conversationText).join('\n'), /saved user/u);
  await controller.close();
  await rm(baseDirectory, { recursive: true, force: true });
});

test('controller projects Agent events and serializes every blocking interaction', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'syzzz-phase8-events-'));
  const engine = displayEngine('event-session', 'event');
  const controller = await InteractionController.create({
    engine,
    sessionOptions: {},
    streamOutput: true,
    persistentHistory: true,
    historyBaseDirectory: baseDirectory
  });
  controller.notice({ tone: 'info', text: '\u001b[31mtransient\u001b[0m', transient: true });
  assert.equal(controller.getSnapshot().activity, 'transient');

  controller.handleAgentEvent({ type: 'phase_changed', phase: 'sampling' });
  controller.handleAgentEvent({ type: 'reasoning_status', status: 'started' });
  controller.handleAgentEvent({ type: 'retry_scheduled', delayMs: 250, reason: 'network' });
  controller.handleAgentEvent({ type: 'compaction_started' });
  controller.handleAgentEvent({ type: 'compaction_completed' });
  controller.handleAgentEvent({
    type: 'usage_updated',
    cumulativeUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }
  });
  controller.handleAgentEvent({ type: 'tool_requested', toolCallId: 'tool-1', toolName: 'Read' });
  controller.handleAgentEvent({ type: 'tool_started', toolCallId: 'tool-1' });
  controller.handleAgentEvent({
    type: 'tool_completed',
    toolCallId: 'tool-1',
    outcome: 'error',
    durationMs: 8,
    result: 'failed to read\ndetail'
  });
  controller.handleAgentEvent({ type: 'hook_started', hook: 'guard', event: 'PreToolUse' });
  controller.handleAgentEvent({ type: 'mcp_server_status', server: 'fixture', state: 'ready' });
  controller.handleAgentEvent({ type: 'subagent_started', role: 'review' });
  controller.handleAgentEvent({
    type: 'subagent_progress',
    role: 'review',
    phase: 'tool',
    toolName: 'GitDiff'
  });
  controller.handleAgentEvent({ type: 'turn_failed', error: { message: 'turn failed' } });
  controller.handleAgentEvent({ type: 'turn_cancelled' });
  controller.handleAgentEvent({
    type: 'skill_activated',
    skill: 'phase8-demo',
    activation: 'explicit',
    byteCount: 42
  });
  controller.handleAgentEvent({
    type: 'skill_failed',
    skill: 'broken-demo',
    activation: 'implicit',
    code: 'invalid_skill'
  });
  const projected = controller.getSnapshot();
  assert.equal(projected.stats.tools, 1);
  assert.equal(projected.stats.failedTools, 1);
  assert.equal(projected.stats.retries, 1);
  assert.equal(projected.stats.compactions, 1);
  assert.equal(projected.stats.usage.totalTokens, 13);
  assert.ok(
    projected.transcript.some(
      (entry) => entry.kind === 'tool-group' && entry.items.some((item) => item.expanded)
    )
  );
  assert.equal(controller.toggleLatestToolDetail(), true);
  assert.ok(
    controller
      .getSnapshot()
      .transcript.some(
        (entry) =>
          entry.kind === 'tool-group' && entry.items.some((item) => item.expanded === false)
      )
  );
  assert.equal(controller.toggleLatestToolDetail(), true);
  assert.ok(
    projected.transcript.some((entry) => entry.kind === 'notice' && /turn failed/.test(entry.text))
  );
  assert.ok(
    controller
      .getSnapshot()
      .transcript.some(
        (entry) => entry.kind === 'notice' && /phase8-demo activated \(explicit\)/.test(entry.text)
      )
  );
  assert.ok(
    controller
      .getSnapshot()
      .transcript.some(
        (entry) =>
          entry.kind === 'notice' && /broken-demo failed \(invalid_skill\)/.test(entry.text)
      )
  );

  const confirm = controller.confirm(
    { title: 'Confirm', message: 'Proceed?', confirmToken: 'y' },
    new AbortController().signal
  );
  assert.equal(controller.getSnapshot().state, 'approval');
  await assert.rejects(
    controller.textInput({ title: 'Blocked' }, new AbortController().signal),
    /Another blocking interaction/
  );
  controller.resolvePending(true);
  assert.equal(await confirm, true);

  const select = controller.select(
    {
      title: 'Select',
      choices: [
        { value: 'one', label: 'One' },
        { value: 'two', label: 'Two' }
      ],
      initialValue: 'two'
    },
    new AbortController().signal
  );
  assert.equal(controller.getSnapshot().pending.selected, 1);
  controller.updatePending({ selected: 0 });
  controller.resolvePending('one');
  assert.equal(await select, 'one');

  const textInput = controller.textInput(
    { title: 'Text', maximumCharacters: 20 },
    new AbortController().signal
  );
  controller.updatePending({ value: 'answer' });
  controller.resolvePending('answer');
  assert.equal(await textInput, 'answer');

  const approval = controller.requestApproval(
    {
      toolCallId: 'write',
      toolName: 'Write',
      risk: 'write',
      input: {},
      description: 'Write file',
      choices: ['allow-once', 'allow-edits-session', 'deny']
    },
    new AbortController().signal
  );
  controller.resolvePending('allow-edits-session');
  assert.equal(await approval, 'allow-edits-session');

  const question = controller.requestUserInput(
    {
      requestId: 'question',
      questions: [{ id: 'text', header: 'Text', prompt: 'Answer', kind: 'text' }]
    },
    new AbortController().signal
  );
  controller.resolvePending({ text: 'value' });
  assert.deepEqual(await question, { text: 'value' });

  const aborted = new AbortController();
  const pending = controller.confirm(
    { title: 'Abort', message: 'Abort', confirmToken: 'y' },
    aborted.signal
  );
  aborted.abort();
  await assert.rejects(pending, /cancelled|aborted/i);
  assert.equal(await controller.suspendTerminal(async () => 42, new AbortController().signal), 42);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    controller.suspendTerminal(async () => 0, alreadyAborted.signal),
    /cancelled|aborted/i
  );
  await controller.setHistoryEnabled(false);
  assert.equal(controller.historyStatus().enabled, false);
  await controller.clearHistory();
  controller.requestExit('test');
  assert.equal(controller.getSnapshot().state, 'exiting');
  await controller.close();
});

test('controller runs streamed and buffered turns without mixing local commands into history', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'syzzz-phase8-turns-'));
  const engine = displayEngine('turn-session', 'turn');
  engine.runTurn = async function* (message, options) {
    assert.equal(typeof options.requestApproval, 'function');
    assert.equal(typeof options.requestUserInput, 'function');
    yield { type: 'phase_changed', phase: 'sampling' };
    yield { type: 'text_delta', delta: `reply:${message}` };
    yield { type: 'phase_changed', phase: 'completed' };
    return { status: 'completed', response: `reply:${message}`, durationMs: 2 };
  };
  const controller = await InteractionController.create({
    engine,
    sessionOptions: {},
    streamOutput: false,
    persistentHistory: true,
    historyBaseDirectory: baseDirectory
  });
  await controller.submit('hello');
  assert.ok(
    controller
      .getSnapshot()
      .transcript.some((entry) => entry.kind === 'assistant' && entry.markdown === 'reply:hello')
  );
  await controller.submit('//literal');
  assert.ok(
    controller
      .getSnapshot()
      .transcript.some((entry) => entry.kind === 'user' && entry.text === '/literal')
  );
  await controller.submit('/unknown-command');
  assert.ok(
    controller
      .getSnapshot()
      .transcript.some((entry) => entry.kind === 'notice' && /Unknown command/.test(entry.text))
  );
  await controller.submit('');
  assert.equal(controller.inputHistory.includes(''), false);
  assert.equal(controller.toggleLatestToolDetail(), false);
  await controller.submit('exit');
  assert.equal(controller.getSnapshot().exitReason, 'user');
  await controller.close();
});

test('changing /stream updates the active TUI renderer instead of keeping its startup value', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'syzzz-phase8-stream-toggle-'));
  const engine = displayEngine('stream-session', 'stream');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  engine.runTurn = async function* () {
    yield { type: 'text_delta', delta: 'first' };
    await gate;
    yield { type: 'text_delta', delta: '-second' };
    return { status: 'completed', response: 'first-second', durationMs: 2 };
  };
  const controller = await InteractionController.create({
    engine,
    sessionOptions: {},
    streamOutput: false,
    persistentHistory: false,
    historyBaseDirectory: baseDirectory
  });
  await controller.submit('/stream on');
  const turn = controller.submit('stream now');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(
    controller
      .getSnapshot()
      .transcript.some((entry) => entry.kind === 'assistant' && entry.markdown === 'first')
  );
  release();
  await turn;
  assert.ok(
    controller
      .getSnapshot()
      .transcript.some((entry) => entry.kind === 'assistant' && entry.markdown === 'first-second')
  );
  await controller.close();
});

class QueueTerminal {
  constructor(results) {
    this.results = [...results];
    this.replaced = undefined;
  }
  async readLine() {
    return this.results.shift() ?? { type: 'eof' };
  }
  replaceHistory(value) {
    this.replaced = value;
  }
}

test('inline interaction adapter preserves structured confirmation, approval, and question semantics', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'syzzz-phase8-inline-'));
  const history = await WorkspaceInputHistory.create({
    workspaceRoot: baseDirectory,
    baseDirectory
  });
  await history.record('stored');
  const terminal = new QueueTerminal([
    { type: 'line', value: 'Y' },
    { type: 'line', value: '' },
    { type: 'line', value: 'text' },
    { type: 'line', value: 'a' },
    { type: 'line', value: '2' },
    { type: 'line', value: 'a,b' },
    { type: 'line', value: 'short answer' }
  ]);
  const port = new InlineInteractionPort(terminal, history);
  const signal = new AbortController().signal;
  assert.equal(
    await port.confirm(
      { title: 'Confirm', message: 'Proceed', preview: 'preview', confirmToken: 'y' },
      signal
    ),
    true
  );
  assert.equal(
    await port.select(
      {
        title: 'Select',
        message: 'Choose',
        choices: [
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two', current: true, description: 'Current' }
        ],
        initialValue: 'two'
      },
      signal
    ),
    'two'
  );
  assert.equal(
    await port.textInput({ title: 'Text', message: 'Enter', maximumCharacters: 10 }, signal),
    'text'
  );
  assert.equal(
    await port.requestApproval(
      {
        toolCallId: 'edit',
        toolName: 'Edit',
        risk: 'write',
        input: {},
        description: 'Edit file',
        preview: 'diff',
        choices: ['allow-once', 'allow-edits-session', 'deny']
      },
      signal
    ),
    'allow-edits-session'
  );
  assert.deepEqual(
    await port.requestUserInput(
      {
        requestId: 'input',
        questions: [
          {
            id: 'single',
            header: 'Single',
            prompt: 'Choose',
            kind: 'single',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' }
            ]
          },
          {
            id: 'multi',
            header: 'Multi',
            prompt: 'Choose many',
            kind: 'multi',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B', description: 'Second' }
            ]
          },
          { id: 'text', header: 'Text', prompt: 'Explain', kind: 'text' }
        ]
      },
      signal
    ),
    { single: 'b', multi: ['a', 'b'], text: 'short answer' }
  );
  assert.equal(await port.suspendTerminal(async () => 'done', signal), 'done');
  assert.deepEqual(port.historyStatus(), { enabled: true, entries: 1, path: history.path });
  await port.setHistoryEnabled(false);
  await port.clearHistory();
  assert.deepEqual(terminal.replaced, []);
});

test('inline interaction adapter fails closed on interrupts, hidden and oversized input', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    new InlineInteractionPort(new QueueTerminal([{ type: 'interrupt' }])).confirm(
      { title: 'Confirm', message: 'Proceed', confirmToken: 'y' },
      signal
    ),
    /cancelled/i
  );
  await assert.rejects(
    new InlineInteractionPort(new QueueTerminal([])).textInput(
      { title: 'Secret', hidden: true },
      signal
    ),
    /Hidden input/
  );
  await assert.rejects(
    new InlineInteractionPort(new QueueTerminal([{ type: 'line', value: 'too long' }])).textInput(
      { title: 'Text', maximumCharacters: 2 },
      signal
    ),
    /exceeds/
  );
  await assert.rejects(
    new InlineInteractionPort(new QueueTerminal([{ type: 'interrupt' }])).requestApproval(
      {
        toolCallId: 'shell',
        toolName: 'Shell',
        risk: 'execute',
        input: {},
        description: 'Run',
        choices: ['allow-once', 'deny']
      },
      signal
    ),
    /cancelled/i
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    new InlineInteractionPort(new QueueTerminal([])).suspendTerminal(async () => 1, aborted.signal),
    /cancelled|aborted/i
  );
});

test('AskUser schemas and answer validation reject ambiguous or invalid responses', async () => {
  assert.equal(
    askUserInputSchema.safeParse({
      questions: [{ id: 'text', header: 'Text', prompt: 'Prompt', kind: 'text' }]
    }).success,
    true
  );
  for (const input of [
    {
      questions: [
        { id: 'same', header: 'A', prompt: 'A', kind: 'text' },
        { id: 'same', header: 'B', prompt: 'B', kind: 'text' }
      ]
    },
    {
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          prompt: 'Choose',
          kind: 'single',
          options: [
            { value: 'a', label: 'A' },
            { value: 'a', label: 'Again' }
          ]
        }
      ]
    },
    {
      questions: [
        {
          id: 'text',
          header: 'Text',
          prompt: 'Prompt',
          kind: 'text',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' }
          ]
        }
      ]
    }
  ]) {
    assert.equal(askUserInputSchema.safeParse(input).success, false);
  }
  const questions = [
    { id: 'text', header: 'Text', prompt: 'Text', kind: 'text' },
    {
      id: 'single',
      header: 'Single',
      prompt: 'Single',
      kind: 'single',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ],
      allowCustom: false
    },
    {
      id: 'multi',
      header: 'Multi',
      prompt: 'Multi',
      kind: 'multi',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]
    }
  ];
  assert.deepEqual(
    validateUserInputAnswers(questions, { text: 'ok', single: 'a', multi: ['a', 'b'] }),
    {
      text: 'ok',
      single: 'a',
      multi: ['a', 'b']
    }
  );
  assert.throws(
    () => validateUserInputAnswers(questions, { text: '', single: 'a', multi: ['a'] }),
    /text answer/
  );
  assert.deepEqual(validateUserInputAnswers(questions, { text: 'ok', single: 'x', multi: ['a'] }), {
    text: 'ok',
    single: 'x',
    multi: ['a']
  });
  assert.deepEqual(
    validateUserInputAnswers([{ ...questions[1], allowCustom: true }], { single: '我的其他想法' }),
    { single: '我的其他想法' }
  );
  assert.throws(
    () => validateUserInputAnswers(questions, { text: 'ok', single: 'a', multi: ['a', 'a'] }),
    /multi-select/
  );
  await assert.rejects(askUserTool.execute({}, {}), /interactive runtime/);
});

test('terminal Markdown rendering is styled, bounded, ANSI-safe, and block-aware', () => {
  const lines = renderMarkdown(
    '# Heading\n\n**bold** and `code`\n\n- one\n- two\n\n```ts\nconst value = 1;\n```\n\n\u001b[31mplain',
    40
  );
  const text = lines.map((line) => line.spans.map((item) => item.text).join('')).join('\n');
  assert.match(text, /Heading/);
  assert.match(text, /bold and code/);
  assert.match(text, /- one/);
  assert.match(text, /const value = 1/);
  assert.doesNotMatch(text, /\*\*|`|\u001b/);
  assert.ok(lines.some((line) => line.spans.some((item) => item.bold && item.text === 'bold')));
  assert.deepEqual(partitionMarkdownSource('first\n\nsecond', false), {
    stable: 'first\n\n',
    mutable: 'second'
  });
});

test('streaming presenter retains queued rows and catches up under bounded pressure', () => {
  const presenter = new StreamingTextPresenter();
  presenter.sync('first\n\nsecond', 40, false, 0);
  assert.equal(presenter.snapshot().queueDepth, 1);
  assert.match(
    presenter
      .visibleRows()
      .flatMap((line) => line.spans.map((item) => item.text))
      .join(''),
    /second/
  );
  presenter.sync('first\n\nsecond', 40, false, 10);
  assert.equal(
    presenter.snapshot().queueDepth,
    1,
    'a repeated render must not discard pending rows'
  );
  assert.equal(presenter.drain(40), true);
  assert.match(
    presenter
      .visibleRows()
      .flatMap((line) => line.spans.map((item) => item.text))
      .join(' '),
    /first.*second/
  );

  const burst = new StreamingTextPresenter();
  const source =
    Array.from({ length: CATCH_UP_DEPTH + 1 }, (_, index) => `row ${index}`).join('\n\n') + '\n\n';
  burst.sync(source, 40, false, 0);
  assert.ok(burst.snapshot().queueDepth >= CATCH_UP_DEPTH);
  burst.drain(1);
  assert.ok(burst.snapshot().queueDepth > 0);
  while (burst.drain(1)) {
    // Catch-up remains bounded per frame rather than replacing the whole answer.
  }
  assert.equal(burst.snapshot().queueDepth, 0);
});

test('controller keeps assistant segments in event order around tools and pauses for AskUser', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'syzzz-phase8-semantic-'));
  const engine = displayEngine('semantic-session', 'semantic');
  let continueQuestion;
  const questionGate = new Promise((resolve) => {
    continueQuestion = resolve;
  });
  engine.runTurn = async function* (_message, options) {
    yield { type: 'text_delta', delta: 'Before tool.' };
    yield { type: 'tool_requested', toolCallId: 'read-1', toolName: 'Read' };
    yield { type: 'tool_started', toolCallId: 'read-1', toolName: 'Read' };
    yield {
      type: 'tool_completed',
      toolCallId: 'read-1',
      toolName: 'Read',
      outcome: 'success',
      durationMs: 2,
      result: 'ok'
    };
    const answers = await options.requestUserInput(
      {
        requestId: 'semantic-question',
        questions: [
          {
            id: 'choice',
            header: 'Direction',
            prompt: 'Choose direction',
            kind: 'single',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' }
            ]
          }
        ]
      },
      options.signal
    );
    await questionGate;
    yield { type: 'text_delta', delta: `After tool: ${answers.choice}.` };
    return { status: 'completed', response: 'Before tool.After tool: a.', durationMs: 20 };
  };
  const controller = await InteractionController.create({
    engine,
    sessionOptions: {},
    streamOutput: true,
    persistentHistory: false,
    historyBaseDirectory: baseDirectory
  });
  const turn = controller.submit('semantic turn');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(controller.getSnapshot().pending.type, 'question');
  assert.equal(controller.getSnapshot().activity.waitingForInput, true);
  controller.resolvePending({ choice: 'a' });
  continueQuestion();
  await turn;
  assert.deepEqual(
    controller
      .getSnapshot()
      .transcript.slice(-4)
      .map((block) => block.kind),
    ['user', 'assistant', 'tool-group', 'assistant']
  );
  assert.equal(controller.getSnapshot().transcript.at(-1).markdown, 'After tool: a.');
  await controller.close();
});
