import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { QueryEngine } from '../dist/engine.js';
import { InteractionController } from '../dist/interaction/controller.js';
import { InlineInteractionPort } from '../dist/interaction/inline-port.js';
import { OperationAbortedError } from '../dist/tools/abort.js';
import { createToolSet } from '../dist/tools/index.js';
import { consumeAgentTurn } from '../dist/cli-renderer.js';
import { createInteractiveCommandRuntime } from '../dist/interactive.js';
import {
  createTaskDraft,
  formatTaskRequirement,
  inspectTaskItem
} from '../dist/interaction/task-wizard.js';
import {
  TaskDelivery,
  formatTaskDelivery,
  formatTaskDeliveryProgress,
  parseTaskDeliveryContract,
  parseTaskPath
} from '../dist/task-delivery.js';

const signal = () => new AbortController().signal;
const read = (id = 'item1', path = 'spec.md') => ({ id, label: '读取说明', kind: 'read', path });
const contract = () => ({
  schemaVersion: 1,
  title: '修正导入器',
  requirements: [read()],
  protectedPaths: []
});

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-task-ux-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'spec.md'), '# Specification\n');
  return root;
}

function scriptPort(steps) {
  const queue = [...steps];
  const notices = [];
  const requests = [];
  const answer = async (type, request) => {
    requests.push({ type, request });
    assert.ok(queue.length, `unexpected ${type}: ${request.title}`);
    const step = queue.shift();
    assert.equal(step[0], type, request.title);
    if (step[2]) await step[2](request);
    if (step[1] instanceof Error) throw step[1];
    if (type === 'select' && step[1] !== undefined)
      assert.ok(
        request.choices.some(({ value }) => value === step[1]),
        `missing choice ${step[1]}`
      );
    return step[1];
  };
  return {
    notices,
    requests,
    notice: (notice) => notices.push(notice),
    select: (request) => answer('select', request),
    textInput: (request) => answer('text', request),
    confirm: (request) => answer('confirm', request),
    done: () => assert.equal(queue.length, 0, 'unconsumed answers')
  };
}

function engineFor(root) {
  const requests = [];
  return new QueryEngine({
    workspaceRoot: root,
    audit: false,
    tools: [],
    provider: {
      requests,
      getInfo: () => ({
        name: 'Mock',
        type: 'mock',
        model: 'mock',
        capabilities: { streaming: false, reasoningToggle: false }
      }),
      async chat(request) {
        requests.push(request);
        throw new Error('No model call permitted');
      }
    }
  });
}

function runtimeFor(engine, port, structured = false) {
  return createInteractiveCommandRuntime(
    engine,
    { uiLanguage: 'zh-CN' },
    {
      readLine: () => {
        throw new Error('Command must use InteractionPort');
      }
    },
    port,
    structured
  );
}

const readSteps = () => [
  ['select', 'read'],
  ['text', '读取说明'],
  ['text', 'spec.md']
];

test('task wizard validates and confirms all three requirement kinds without files or model calls', async (t) => {
  const root = await workspace(t);
  const engine = engineFor(root);
  const port = scriptPort([
    ['text', '修正导入器'],
    ...readSteps(),
    ['select', 'artifact'],
    ['text', '交付代码'],
    ['text', 'result.txt'],
    ['select', 'add'],
    ['text', 'DONE'],
    ['select', 'done'],
    ['select', 'check'],
    ['text', '回归测试'],
    ['text', 'node test.mjs'],
    ['select', 'add'],
    ['text', 'result.txt'],
    ['select', 'add'],
    ['text', 'test.mjs'],
    ['select', 'done'],
    ['select', 'add'],
    ['text', 'TEST_OK'],
    ['select', 'done'],
    ['select', 'protect'],
    ['select', 'add'],
    ['text', 'spec.md'],
    ['select', 'done'],
    ['select', 'confirm'],
    [
      'confirm',
      true,
      (request) => {
        assert.equal(engine.getStatus().delivery, undefined);
        assert.equal(request.confirmToken, 'y');
        assert.ok(
          port.notices.some(
            ({ text }) => text.includes('node test.mjs') && text.includes('TEST_OK')
          )
        );
      }
    ]
  ]);
  await runtimeFor(engine, port).execute('/task new', signal());
  port.done();
  assert.equal(engine.getStatus().delivery.items.length, 3);
  assert.equal(engine.getStatus().delivery.outcome, 'idle');
  assert.equal(engine.getStatus().permissionMode, 'safe');
  assert.deepEqual(engine.getMessages(), []);
  assert.deepEqual(await readdir(root), ['spec.md']);
  assert.deepEqual(engine.getTaskDeliveryContract().protectedPaths, ['spec.md']);
  const saved = engine.exportState();
  assert.equal(saved.taskDelivery.contract.requirements[2].command, 'node test.mjs');
  const restored = engineFor(root);
  restored.restoreState(saved);
  assert.equal((await restored.inspectTaskDelivery()).restored, true);
  assert.deepEqual(restored.getTaskDeliveryContract(), engine.getTaskDeliveryContract());
});

test('declining confirmation retains editable draft; activation uses the revised checklist', async (t) => {
  const root = await workspace(t);
  const engine = engineFor(root);
  const port = scriptPort([
    ['text', 'Original'],
    ...readSteps(),
    ['select', 'confirm'],
    ['confirm', false],
    ['select', 'title'],
    ['text', 'Revised'],
    ['select', 'edit'],
    ['select', 'item1'],
    ['select', 'edit'],
    ['text', 'Revised label'],
    ['text', '', (request) => assert.match(request.message, /当前：spec.md/)],
    ['select', 'confirm'],
    ['confirm', true, () => assert.equal(engine.getStatus().delivery, undefined)]
  ]);
  await runtimeFor(engine, port).execute('/task new', signal());
  port.done();
  assert.equal(engine.getTaskDeliveryContract().title, 'Revised');
  assert.equal(engine.getTaskDeliveryContract().requirements[0].label, 'Revised label');
});

test('item removal and optional list removal preserve a valid bounded draft', async (t) => {
  const root = await workspace(t);
  const port = scriptPort([
    ['text', 'Draft'],
    ...readSteps(),
    ['select', 'edit'],
    ['select', 'item1'],
    ['select', 'back'],
    ['select', 'edit'],
    ['select', 'item1'],
    ['select', 'remove'],
    ['select', 'artifact'],
    ['text', '产物'],
    ['text', 'out.txt'],
    ['select', 'add'],
    ['text', 'OLD'],
    ['select', 'add'],
    ['text', 'OLD'],
    ['select', 'remove:0'],
    ['select', 'done'],
    ['select', 'edit'],
    ['select', 'item2'],
    ['select', 'edit'],
    ['text', ''],
    ['text', ''],
    ['select', 'done'],
    ['select', 'confirm'],
    ['confirm', true]
  ]);
  const draft = await createTaskDraft(port, root, 'zh', signal());
  port.done();
  assert.deepEqual(draft.requirements[0].contains, []);
  assert.equal(draft.requirements[0].id, 'item2');
});

test('check editing keeps command and dependencies without executing them', async (t) => {
  const root = await workspace(t);
  const port = scriptPort([
    ['text', 'Draft'],
    ['select', 'check'],
    ['text', 'Run check'],
    ['text', 'node test.mjs'],
    ['select', 'add'],
    ['text', 'spec.md'],
    ['select', 'done'],
    ['select', 'done'],
    ['select', 'edit'],
    ['select', 'item1'],
    ['select', 'edit'],
    ['text', ''],
    ['text', ''],
    ['select', 'done'],
    ['select', 'done'],
    ['select', 'confirm'],
    ['confirm', true]
  ]);
  const draft = await createTaskDraft(port, root, 'en', signal());
  port.done();
  assert.deepEqual(draft.requirements[0].paths, ['spec.md']);
  assert.match(formatTaskRequirement(draft.requirements[0], 'en'), /Output markers: -/);
});

for (const [name, steps] of [
  ['discard', [['text', 'Draft'], ...readSteps(), ['select', 'cancel']]],
  [
    'selection cancellation',
    [
      ['text', 'Draft'],
      ['select', undefined]
    ]
  ],
  ['input cancellation', [['text', undefined]]]
])
  test(`wizard ${name} enables nothing`, async (t) => {
    const root = await workspace(t);
    const engine = engineFor(root);
    const port = scriptPort(steps);
    await runtimeFor(engine, port).execute('/task new', signal());
    port.done();
    assert.equal(engine.getStatus().delivery, undefined);
    assert.deepEqual(engine.getMessages(), []);
  });

test('AbortSignal cancels a draft even if a pending form returns a value', async (t) => {
  const root = await workspace(t);
  const abort = new AbortController();
  const port = scriptPort([['text', 'Draft', () => abort.abort(new Error('Cancelled'))]]);
  await assert.rejects(createTaskDraft(port, root, 'zh', abort.signal), /Cancelled/);
});

test('Esc cancellation and unexpected form errors propagate instead of reopening the draft', async (t) => {
  const root = await workspace(t);
  for (const error of [new OperationAbortedError(), new Error('Form failed')]) {
    const port = scriptPort([
      ['text', 'Draft'],
      ['select', 'read'],
      ['text', error]
    ]);
    await assert.rejects(createTaskDraft(port, root, 'zh', signal()), (actual) => actual === error);
    port.done();
    assert.equal(port.notices.length, 0);
  }
});

test('resolve menu is empty-safe and requires acknowledgement for actual unresolved operations', async (t) => {
  const root = await workspace(t);
  const engine = engineFor(root);
  const empty = scriptPort([]);
  await runtimeFor(engine, empty).execute('/task resolve', signal());
  assert.match(empty.notices[0].text, /暂无未决操作/);
  const delivery = await TaskDelivery.create(root, contract());
  await delivery.beginOperation('pending-1', 'Write', { path: 'spec.md', contents: 'new' });
  engine.restoreState({ ...engine.exportState(), taskDelivery: delivery.exportState() });
  const port = scriptPort([
    ['select', undefined],
    ['select', 'pending-1'],
    ['confirm', false],
    ['select', 'pending-1'],
    ['confirm', true]
  ]);
  const runtime = runtimeFor(engine, port);
  await runtime.execute('/task resolve', signal());
  await runtime.execute('/task resolve', signal());
  assert.equal(engine.getStatus().delivery.unresolvedOperations.length, 1);
  await runtime.execute('/task resolve', signal());
  port.done();
  assert.equal(engine.getStatus().delivery.unresolvedOperations, undefined);
  assert.equal(engine.getStatus().delivery.satisfied, false);
  assert.equal(engine.getStatus().permissionMode, 'safe');
  assert.deepEqual(engine.getMessages(), []);
});

test('invalid requirement and empty checklist can be corrected without enabling anything', async (t) => {
  const root = await workspace(t);
  const port = scriptPort([
    ['text', 'Draft'],
    ['select', 'confirm'],
    ['select', 'read'],
    ['text', 'Bad'],
    ['text', '../secret.md'],
    ...readSteps(),
    ['select', 'confirm'],
    ['confirm', true]
  ]);
  const draft = await createTaskDraft(port, root, 'zh', signal());
  port.done();
  assert.equal(draft.requirements.length, 1);
  assert.equal(port.notices.filter(({ tone }) => tone === 'warning').length, 2);
});

test('invalid list values and missing protection file require correction, not silent acceptance', async (t) => {
  const root = await workspace(t);
  const port = scriptPort([
    ['text', 'Draft'],
    ...readSteps(),
    ['select', 'protect'],
    ['select', 'add'],
    ['text', ''],
    ['select', 'add'],
    ['text', 'C:\\outside.txt'],
    ['select', 'add'],
    ['text', 'missing.md'],
    ['select', 'done'],
    ['select', 'confirm'],
    ['select', 'protect'],
    ['select', 'remove:0'],
    ['select', 'add'],
    ['text', 'spec.md'],
    ['select', 'done'],
    ['select', 'confirm'],
    ['confirm', true]
  ]);
  const draft = await createTaskDraft(port, root, 'en', signal());
  port.done();
  assert.deepEqual(draft.protectedPaths, ['spec.md']);
  assert.equal(port.notices.filter(({ tone }) => tone === 'warning').length, 3);
});

test('wizard menus enforce eight items and eight markers before confirmation', async (t) => {
  const root = await workspace(t);
  const steps = [['text', 'Bounded']];
  for (let index = 0; index < 8; index++) steps.push(...readSteps());
  steps.push([
    'select',
    'edit',
    (request) =>
      assert.equal(
        request.choices.some(({ value }) => value === 'read'),
        false
      )
  ]);
  steps.push(
    ['select', 'item1'],
    ['select', 'remove'],
    ['select', 'artifact'],
    ['text', 'out'],
    ['text', 'out.txt']
  );
  for (let index = 0; index < 8; index++)
    steps.push(['select', 'add'], ['text', `MARKER_${index}`]);
  steps.push([
    'select',
    'done',
    (request) =>
      assert.equal(
        request.choices.some(({ value }) => value === 'add'),
        false
      )
  ]);
  steps.push(['select', 'confirm'], ['confirm', true]);
  const port = scriptPort(steps);
  const draft = await createTaskDraft(port, root, 'zh', signal());
  port.done();
  assert.equal(draft.requirements.length, 8);
  assert.equal(draft.requirements[7].contains.length, 8);
});

test('in-memory activation applies the same schema, path and protected-file gates as JSON', async (t) => {
  const root = await workspace(t);
  const engine = engineFor(root);
  await assert.rejects(
    engine.startTaskDelivery({ ...contract(), protectedPaths: ['missing.md'] }),
    /Protected files/
  );
  await assert.rejects(
    engine.startTaskDelivery({ ...contract(), requirements: [read('bad', '../outside')] }),
    /schema/
  );
  await assert.rejects(
    engine.startTaskDelivery({ ...contract(), requirements: [read(), read()] }),
    /unique/
  );
  assert.equal(engine.getStatus().delivery, undefined);
  await engine.startTaskDelivery(contract());
  const copy = engine.getTaskDeliveryContract();
  copy.requirements[0].path = 'changed.md';
  assert.equal(engine.getTaskDeliveryContract().requirements[0].path, 'spec.md');
  await assert.rejects(engine.startTaskDelivery(contract()), /Clear/);
});

test('cancellation before or during activation leaves the Engine unchanged', async (t) => {
  const root = await workspace(t);
  const engine = engineFor(root);
  const before = new AbortController();
  before.abort();
  await assert.rejects(engine.startTaskDelivery(contract(), before.signal), { name: 'AbortError' });
  const during = new AbortController();
  const running = engine.startTaskDelivery(contract(), during.signal);
  during.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(engine.getStatus().delivery, undefined);
});

test('confirmed wizard checklist tracks a real tool result and later external edits', async (t) => {
  const root = await workspace(t);
  let calls = 0;
  const provider = {
    getInfo: () => ({
      name: 'Mock',
      type: 'mock',
      model: 'mock',
      capabilities: { streaming: false, reasoningToggle: false }
    }),
    async chat() {
      calls++;
      return calls === 1
        ? {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'read-spec', name: 'Read', input: { path: 'spec.md' } }]
            }
          }
        : { message: { role: 'assistant', content: '读取完成。' }, finishReason: 'stop' };
    }
  };
  const engine = new QueryEngine({
    workspaceRoot: root,
    audit: false,
    provider,
    tools: createToolSet().filter(({ name }) => name === 'Read')
  });
  const port = scriptPort([
    ['text', 'Task'],
    ...readSteps(),
    ['select', 'confirm'],
    ['confirm', true]
  ]);
  await runtimeFor(engine, port).execute('/task new', signal());
  assert.equal(calls, 0);
  const events = [];
  const result = await consumeAgentTurn(engine.runTurn('读取 spec.md'), (event) =>
    events.push(event)
  );
  assert.equal(result.status, 'completed');
  assert.equal(engine.getStatus().delivery.satisfied, true);
  assert.equal(engine.getStatus().delivery.items[0].receipt.toolCallId, 'read-spec');
  assert.ok(
    events.some(
      ({ type, snapshot }) => type === 'delivery_updated' && snapshot.items[0].state === 'read'
    )
  );
  await writeFile(join(root, 'spec.md'), '# Changed externally\n');
  await runtimeFor(engine, port).execute('/task status', signal());
  assert.equal(engine.getStatus().delivery.items[0].state, 'stale');
  assert.match(port.notices.at(-1).text, /待复核 1/);
  assert.equal(calls, 2);
});

test('new-contract byte bound and path normalization are deterministic', () => {
  assert.equal(parseTaskPath('src\\file name.ts'), 'src/file name.ts');
  const large = {
    ...contract(),
    requirements: Array.from({ length: 8 }, (_, index) => ({
      id: `item${index}`,
      label: '界'.repeat(160),
      kind: 'check',
      command: '界'.repeat(1024),
      paths: ['spec.md'],
      outputContains: Array(8).fill('界'.repeat(256))
    }))
  };
  assert.throws(() => parseTaskDeliveryContract(large), /32 KiB/);
});

test('structured /task menu invokes the same draft flow and retains existing tasks', async (t) => {
  const root = await workspace(t);
  const engine = engineFor(root);
  const port = scriptPort([
    ['select', 'new'],
    ['text', 'Draft'],
    ...readSteps(),
    ['select', 'confirm'],
    ['confirm', true]
  ]);
  await runtimeFor(engine, port, true).execute('/task', signal());
  port.done();
  const unchanged = engine.getTaskDeliveryContract();
  await runtimeFor(engine, port).execute('/task new', signal());
  assert.deepEqual(engine.getTaskDeliveryContract(), unchanged);
  assert.match(port.notices.at(-1).text, /已有任务保持不变/);
});

test('task inspect shows exact dependencies and receipt hashes locally', async (t) => {
  const root = await workspace(t);
  const engine = engineFor(root);
  const full = {
    ...contract(),
    requirements: [
      {
        id: 'check',
        label: 'Check',
        kind: 'check',
        command: 'node verify.mjs',
        paths: ['spec.md'],
        outputContains: ['OK']
      }
    ]
  };
  await engine.startTaskDelivery(full);
  const snapshot = await engine.inspectTaskDelivery();
  snapshot.items[0] = {
    ...snapshot.items[0],
    state: 'checked',
    receipt: {
      toolCallId: 'call-1',
      tool: 'Shell',
      outcome: 'success',
      timestamp: '2026-10-12T00:00:00Z',
      versions: { 'spec.md': 'a'.repeat(64) }
    }
  };
  const port = scriptPort([['select', 'check']]);
  await inspectTaskItem(port, full, snapshot, 'zh', signal());
  port.done();
  assert.match(port.notices[0].text, /依赖文件: spec.md/);
  assert.match(port.notices[0].text, /a{64}/);
  assert.match(port.notices[0].text, /call-1/);
  assert.deepEqual(engine.getMessages(), []);
});

test('inspect cancellation and empty status are safe; clearing retains files', async (t) => {
  const root = await workspace(t);
  const engine = engineFor(root);
  const port = scriptPort([
    ['select', 'item1'],
    ['select', undefined]
  ]);
  const runtime = runtimeFor(engine, port);
  await runtime.execute('/task inspect', signal());
  assert.match(port.notices.at(-1).text, /task new/);
  await engine.startTaskDelivery(contract());
  await runtime.execute('/task inspect', signal());
  assert.match(port.notices.at(-1).text, /尚无工具回执/);
  await runtime.execute('/task inspect', signal());
  await runtime.execute('/task clear', signal());
  port.done();
  assert.equal(engine.getStatus().delivery, undefined);
  assert.equal(await readFile(join(root, 'spec.md'), 'utf8'), '# Specification\n');
});

test('progress distinguishes missing, stale, unknown and protection warnings, not model claims', () => {
  const snapshot = {
    schemaVersion: 1,
    title: 'Progress',
    outcome: 'incomplete',
    satisfied: false,
    protection: 'changed',
    items: [
      { ...read(), state: 'read' },
      { ...read('a'), state: 'planned' },
      { ...read('b'), state: 'blocked' },
      { ...read('c'), state: 'stale' },
      { ...read('d'), state: 'unknown', reason: 'operation-unconfirmed' }
    ]
  };
  assert.match(formatTaskDeliveryProgress(snapshot, 'zh'), /有效回执 1\/5 \| 缺失 2 \| 待复核 2/);
  assert.match(formatTaskDeliveryProgress(snapshot, 'en'), /recovery\/protection warning/);
  assert.match(formatTaskDelivery(snapshot, 'zh'), /操作影响尚未确认/);
  assert.match(
    formatTaskDeliveryProgress(
      { ...snapshot, protection: 'unchanged', unresolvedOperations: [{ toolCallId: 'x' }] },
      'en'
    ),
    /warning/
  );
});

test('task detail text cannot inject terminal controls even from legacy JSON', () => {
  const text = formatTaskRequirement(
    {
      id: 'check',
      label: 'Check',
      kind: 'check',
      command: '\u001b]52;c;ZXZpbA==\u0007node test\u001b[2J',
      paths: ['spec.md']
    },
    'en'
  );
  assert.doesNotMatch(text, /\u001b|\u0007/);
  assert.match(text, /node test/);
  assert.match(
    formatTaskRequirement({ id: 'file', label: 'File', kind: 'artifact', path: 'out.txt' }, 'en'),
    /Content markers: -/
  );
});

test('inline and structured renderer share the same confirmed contract', async (t) => {
  const root = await workspace(t);
  const answers = ['Draft', '1', 'Read spec', 'spec.md', '7', 'y'];
  const port = new InlineInteractionPort({
    readLine: async () => ({ type: 'line', value: answers.shift() })
  });
  const notices = [];
  port.notice = (notice) => notices.push(notice);
  const draft = await createTaskDraft(port, root, 'en', signal());
  assert.equal(answers.length, 0);
  assert.equal(draft.requirements[0].path, 'spec.md');
  assert.ok(notices.some(({ text }) => text.includes('no commands')));
});

test(
  'Controller wizard answers and confirmation stay out of input and model history',
  { timeout: 10000 },
  async (t) => {
    const root = await workspace(t);
    const engine = engineFor(root);
    const controller = await InteractionController.create({
      engine,
      persistentHistory: true,
      historyBaseDirectory: join(root, 'history'),
      streamOutput: true,
      sessionOptions: { uiLanguage: 'zh-CN' }
    });
    t.after(() => controller.requestExit('test-completed'));
    const steps = [['text', 'Draft'], ...readSteps(), ['select', 'confirm'], ['confirm', true]];
    const running = controller.submit('/task new');
    for (const [type, answer] of steps) {
      for (let attempt = 0; attempt < 200 && !controller.getSnapshot().pending; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(controller.getSnapshot().pending?.type, type);
      controller.resolvePending(answer);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await running;
    assert.equal(engine.getStatus().delivery.items.length, 1);
    assert.deepEqual(engine.getMessages(), []);
    assert.deepEqual(controller.inputHistory, ['/task new']);
    assert.equal(controller.getSnapshot().state, 'idle');
  }
);
