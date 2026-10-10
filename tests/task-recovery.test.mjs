import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { QueryEngine } from '../dist/engine.js';
import { TaskDelivery, taskDeliveryStateSchema } from '../dist/task-delivery.js';
import { SessionController } from '../dist/session-controller.js';
import { SessionStore } from '../dist/session-store.js';
import { createToolSet } from '../dist/tools/index.js';
import { consumeAgentTurn } from '../dist/cli-renderer.js';
import { createInteractiveCommandRuntime } from '../dist/interactive.js';
import { toAuditRecord } from '../dist/audit.js';
import { InteractionController } from '../dist/interaction/controller.js';
import { TaskCompositionRuntime } from '../dist/composition/runtime.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  await mkdir(root);
  await writeFile(join(root, 'source.txt'), 'original\n');
  await writeFile(join(root, 'check.mjs'), 'console.log("CHECK_OK");\n');
  const contract = {
    schemaVersion: 1,
    title: 'Recovery delivery',
    requirements: [
      { id: 'source', label: 'Read source', kind: 'read', path: 'source.txt' },
      {
        id: 'artifact',
        label: 'Produce notes',
        kind: 'artifact',
        path: 'NOTES.md',
        contains: ['Verified']
      },
      {
        id: 'check',
        label: 'Run check',
        kind: 'check',
        command: 'node check.mjs',
        paths: ['check.mjs', 'NOTES.md'],
        outputContains: ['CHECK_OK']
      }
    ],
    protectedPaths: ['source.txt']
  };
  await writeFile(join(root, 'task.json'), JSON.stringify(contract));
  return { directory, root, contract };
}

async function recoveryComposition(data, skills = {}) {
  const skillRoot = join(data.root, '.agents', 'skills', 'recovery-workflow');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    '---\nname: recovery-workflow\ndescription: Review and verify resumed delivery.\n---\nRECOVERY_SKILL_BODY\n'
  );
  return TaskCompositionRuntime.create({
    workspaceRoot: data.root,
    homeDirectory: join(data.directory, 'isolated-home'),
    projectMemory: false,
    skills: {
      enabled: true,
      allowImplicit: true,
      disabled: [],
      catalogMode: 'progressive',
      ...skills
    }
  });
}
function provider(sequence = []) {
  const requests = [];
  return {
    requests,
    getInfo: () => ({
      name: 'Recovery test',
      type: 'test',
      model: 'recovery-test',
      contextWindowTokens: 65536,
      capabilities: { streaming: false, reasoningToggle: false }
    }),
    async chat(request) {
      requests.push(request);
      const call = sequence[requests.length - 1];
      return {
        message: call
          ? {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: `op-${requests.length}`, ...call }]
            }
          : { role: 'assistant', content: 'Done' },
        finishReason: 'stop'
      };
    }
  };
}
function engine(root, instance = provider(), extra = {}) {
  return new QueryEngine({
    provider: instance,
    workspaceRoot: root,
    audit: false,
    sessionId: A,
    tools: createToolSet().filter(({ name }) => ['Read', 'Write', 'Shell'].includes(name)),
    ...extra
  });
}
async function run(instance, options = {}) {
  const events = [];
  const result = await consumeAgentTurn(
    instance.runTurn('Complete the requested delivery.', {
      requestApproval: async () => 'allow-once',
      ...options
    }),
    (event) => events.push(event)
  );
  return { events, result };
}
async function completed(t) {
  const data = await fixture(t);
  const instance = engine(
    data.root,
    provider([
      { name: 'Read', input: { path: 'source.txt' } },
      { name: 'Write', input: { path: 'NOTES.md', contents: 'Verified\n' } },
      { name: 'Shell', input: { command: 'node check.mjs' } }
    ])
  );
  await instance.startTaskDelivery('task.json');
  await run(instance);
  assert.equal(instance.getStatus().delivery.satisfied, true);
  return { ...data, instance, state: instance.exportState() };
}
async function controller(root, directory, initial, autoSave = true, instanceFactory) {
  const store = await SessionStore.create({
    workspaceRoot: root,
    baseDirectory: join(directory, 'sessions')
  });
  const session = await SessionController.create({
    store,
    engine: initial,
    providerId: 'test',
    autoSave,
    idFactory: () => B,
    engineFactory: ({ sessionId, mode }) => ({
      engine: instanceFactory
        ? instanceFactory(sessionId, mode)
        : engine(root, provider(), { sessionId, mode }),
      providerId: 'test'
    }),
    warn: () => {}
  });
  return { session, store };
}

test('completed receipts persist and are revalidated without any provider or tool call on restore', async (t) => {
  const { root, directory, instance } = await completed(t);
  const { session, store } = await controller(root, directory, instance);
  t.after(() => session.close());
  await session.save();
  const saved = await store.load(A);
  assert.equal(saved.engineState.taskDelivery.items[2].state, 'checked');
  await session.newSession();
  const restored = await session.resume(A);
  assert.equal(restored.delivery.restored, true);
  assert.equal(restored.delivery.satisfied, true);
  assert.equal(session.engine.getPermissionMode(), 'safe');
  assert.equal(session.engine.getStatus().messageCount, instance.getStatus().messageCount);
});

test('changed file makes previous check stale while confirmed unchanged receipts remain valid', async (t) => {
  const { root, state } = await completed(t);
  await writeFile(join(root, 'check.mjs'), 'console.log("CHANGED");\n');
  const restored = engine(root);
  restored.restoreState(state);
  assert.equal(restored.getStatus().delivery.satisfied, false);
  const snapshot = await restored.inspectTaskDelivery();
  assert.deepEqual(
    snapshot.items.map(({ state: value }) => value),
    ['read', 'artifact', 'stale']
  );
  assert.equal(snapshot.satisfied, false);
});

test('protected file changes survive repeated saves and restores', async (t) => {
  const { root, state } = await completed(t);
  await writeFile(join(root, 'source.txt'), 'changed\n');
  const first = engine(root);
  first.restoreState(state);
  assert.equal((await first.inspectTaskDelivery()).protection, 'changed');
  const saved = first.exportState();
  await writeFile(join(root, 'source.txt'), 'original\n');
  const second = engine(root);
  second.restoreState(saved);
  assert.equal((await second.inspectTaskDelivery()).protection, 'changed');
});

test('old sessions without delivery fields restore unchanged and never invent a task', async (t) => {
  const { root } = await fixture(t);
  const state = engine(root).exportState();
  assert.equal(state.taskDelivery, undefined);
  const restored = engine(root);
  restored.restoreState(state);
  assert.equal(await restored.inspectTaskDelivery(), undefined);
  assert.equal(restored.exportState().schemaVersion, 1);
});

test('invalid delivery state fails closed before replacing an existing engine', async (t) => {
  const { root, instance, state } = await completed(t);
  for (const mutate of [
    (saved) => {
      saved.items[0].id = 'wrong';
    },
    (saved) => {
      saved.baselines['outside.txt'] = 'a'.repeat(64);
    },
    (saved) => {
      saved.items[2].receipt.versions['outside.txt'] = 'a'.repeat(64);
    },
    (saved) => {
      saved.contract.permissionMode = 'fullAccess';
    },
    (saved) => {
      saved.items[0].receipt = undefined;
    },
    (saved) => {
      saved.operations = Array(17).fill({
        toolCallId: 'x',
        tool: 'Shell',
        fingerprint: 'a'.repeat(64),
        state: 'pending',
        timestamp: new Date().toISOString()
      });
    }
  ]) {
    const changed = structuredClone(state);
    mutate(changed.taskDelivery);
    assert.throws(() => instance.restoreState(changed));
    assert.equal(instance.getStatus().delivery.satisfied, true);
  }
  const other = await fixture(t);
  assert.throws(() => engine(other.root).restoreState(state), /workspace mismatch/);
  for (const invalid of [null, false, 0]) {
    assert.throws(() => instance.restoreState({ ...state, taskDelivery: invalid }));
    assert.equal(instance.getStatus().delivery.satisfied, true);
  }
});

test('session store rejects a corrupt optional task field instead of silently discarding it', async (t) => {
  const { root, directory, instance } = await completed(t);
  const { session, store } = await controller(root, directory, instance);
  t.after(() => session.close());
  await session.save();
  const file = join(store.workspaceDirectory, A, 'state.json');
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  snapshot.engineState.taskDelivery.contract.requirements[0].path = '../escape';
  await writeFile(file, JSON.stringify(snapshot));
  await assert.rejects(store.load(A), /corrupt/);
});

test('journal is persisted before execution and completed receipts after the actual tool outcome', async (t) => {
  const { root } = await fixture(t);
  const checkpoints = [];
  let observedPending = false;
  const tool = {
    name: 'Shell',
    description: 'Receipt fixture',
    risk: 'execute',
    approval: 'always',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => {
      observedPending = checkpoints.at(-1).state.taskDelivery.operations[0].state === 'pending';
      return { content: 'done', metadata: { completionReason: 'exited', exitCode: 0 } };
    }
  };
  const instance = engine(root, provider([{ name: 'Shell', input: { command: 'fixture' } }]), {
    tools: [tool],
    checkpoint: async (reason, state) => checkpoints.push({ reason, state })
  });
  await instance.startTaskDelivery('task.json');
  await run(instance);
  assert.equal(observedPending, true);
  assert.ok(checkpoints.some(({ reason }) => reason === 'task-operation-started'));
  assert.equal(checkpoints.at(-1).state.taskDelivery.operations.length, 0);
  assert.equal(checkpoints.at(-1).state.taskDelivery.outcome, 'completed');
});

test('non-file tool paths remain opaque while write-ahead records contain only fingerprints', async (t) => {
  const { root, contract } = await fixture(t);
  const checkpoints = [];
  let executions = 0;
  let approvals = 0;
  const input = { path: '/tickets/1', value: 'REMOTE_TITLE' };
  const tool = {
    name: 'UpdateTicket',
    description: 'Offline remote effect fixture',
    risk: 'write',
    approval: 'always',
    inputSchema: z.object({ path: z.string(), value: z.string() }),
    execute: async () => {
      executions++;
      return { content: 'updated' };
    }
  };
  const instance = engine(root, provider([{ name: tool.name, input }]), {
    tools: [tool],
    checkpoint: async (reason, state) => checkpoints.push({ reason, state })
  });
  await instance.startTaskDelivery('task.json');
  const { events } = await run(instance, {
    requestApproval: async () => {
      approvals++;
      return 'allow-once';
    }
  });
  assert.equal(approvals, 1);
  assert.equal(executions, 1);
  assert.ok(events.some((event) => event.type === 'tool_completed' && event.outcome === 'success'));
  const journal = checkpoints.find(({ reason }) => reason === 'task-operation-started').state
    .taskDelivery.operations;
  assert.equal(journal[0].tool, tool.name);
  assert.match(journal[0].fingerprint, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(journal), /tickets|REMOTE_TITLE/u);
  assert.equal(instance.exportState().taskDelivery.operations.length, 0);
  const delivery = await TaskDelivery.create(root, contract);
  await delivery.beginOperation('remote-unconfirmed', tool.name, input);
  await assert.rejects(
    delivery.assertOperationAllowed(tool.name, { path: '/tickets/2' }),
    /Unresolved/u
  );
});

test('failed write-ahead checkpoint stops execution and closes further tool access for that turn', async (t) => {
  const { root } = await fixture(t);
  let executions = 0;
  const warnings = [];
  const tool = {
    name: 'Shell',
    description: 'Effect',
    risk: 'execute',
    approval: 'always',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => {
      executions++;
      return { content: 'done' };
    }
  };
  const instance = engine(root, provider([{ name: 'Shell', input: { command: 'change' } }]), {
    tools: [tool],
    checkpoint: async (reason) => {
      if (reason === 'task-operation-started') throw new Error('disk full');
    },
    onCheckpointError: (error) => warnings.push(error.message)
  });
  await instance.startTaskDelivery('task.json');
  const { events } = await run(instance);
  assert.equal(executions, 0);
  assert.deepEqual(warnings, ['disk full']);
  assert.ok(events.some((event) => event.metadata?.reason === 'task-checkpoint-failed'));
  assert.equal(instance.getStatus().delivery.satisfied, false);
});

test('unconfirmed operation blocks exact retry before approval, even with reordered arguments', async (t) => {
  const { root, contract } = await fixture(t);
  const saved = await TaskDelivery.create(root, contract);
  await saved.beginOperation('prior', 'Shell', {
    command: 'node check.mjs',
    workingDirectory: { type: 'workspace' }
  });
  const persisted = saved.exportState();
  let approvals = 0;
  let executions = 0;
  const tool = {
    name: 'Shell',
    description: 'Effect',
    risk: 'execute',
    approval: 'always',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => {
      executions++;
      return { content: 'done' };
    }
  };
  const instance = engine(
    root,
    provider([{ name: 'Shell', input: { command: 'node check.mjs' } }]),
    { tools: [tool] }
  );
  instance.restoreState({ ...instance.exportState(), taskDelivery: persisted });
  const { events } = await run(instance, {
    requestApproval: async () => {
      approvals++;
      return 'allow-once';
    }
  });
  assert.equal(approvals, 0);
  assert.equal(executions, 0);
  assert.ok(events.some((event) => event.metadata?.reason === 'task-recovery-required'));
  assert.equal(instance.getStatus().delivery.unresolvedOperations[0].state, 'unknown');
  await instance.resolveTaskOperation('prior');
  assert.equal(instance.getStatus().delivery.satisfied, false);
  await assert.rejects(
    saved.assertOperationAllowed('Shell', { command: 'another command' }),
    /Unresolved/
  );
});

test('resolution does not execute, grant permission, or certify an unknown operation', async (t) => {
  const { root, contract } = await fixture(t);
  const delivery = await TaskDelivery.create(root, contract);
  await delivery.beginOperation('prior', 'Write', { contents: 'Verified', path: 'NOTES.md' });
  const instance = engine(root);
  instance.restoreState({ ...instance.exportState(), taskDelivery: delivery.exportState() });
  const notices = [];
  const confirmations = [];
  let approve = false;
  const runtime = createInteractiveCommandRuntime(
    instance,
    { streamOutput: false, uiLanguage: 'zh-CN' },
    {},
    {
      notice: (notice) => notices.push(notice),
      confirm: async (request) => {
        confirmations.push(request);
        return approve;
      }
    },
    false
  );
  await runtime.execute('/task resolve prior', new AbortController().signal);
  assert.equal(instance.getStatus().delivery.unresolvedOperations.length, 1);
  approve = true;
  await runtime.execute('/task resolve prior', new AbortController().signal);
  assert.equal(instance.getStatus().delivery.unresolvedOperations, undefined);
  assert.equal(instance.getStatus().delivery.satisfied, false);
  assert.equal(instance.getPermissionMode(), 'safe');
  assert.ok(notices.some(({ text }) => text.includes('尚未形成')));
  assert.ok(confirmations.every(({ confirmToken }) => confirmToken === 'y'));
  await assert.rejects(readFile(join(root, 'NOTES.md')), /ENOENT/);
});

test('clearing unresolved work asks for confirmation and persists removal', async (t) => {
  const { root, directory, contract } = await fixture(t);
  const delivery = await TaskDelivery.create(root, contract);
  await delivery.beginOperation('prior', 'Shell', { command: 'unknown' });
  const instance = engine(root);
  instance.restoreState({ ...instance.exportState(), taskDelivery: delivery.exportState() });
  const { session, store } = await controller(root, directory, instance);
  t.after(() => session.close());
  let approve = false;
  const runtime = createInteractiveCommandRuntime(
    instance,
    { session, streamOutput: false },
    {},
    { notice: () => {}, confirm: async () => approve },
    false
  );
  await runtime.execute('/task clear', new AbortController().signal);
  assert.ok(instance.getStatus().delivery);
  approve = true;
  await runtime.execute('/task clear', new AbortController().signal);
  assert.equal((await store.load(A)).engineState.taskDelivery, undefined);
});

test('task summary is bounded, fresh, ephemeral, and not a duplicate contract or source dump', async (t) => {
  const { root } = await fixture(t);
  const back = provider([{ name: 'Read', input: { path: 'source.txt' } }]);
  const instance = engine(root, back);
  await instance.startTaskDelivery('task.json');
  await run(instance);
  for (const request of back.requests) {
    const summaries = request.messages.filter(({ content }) =>
      content.startsWith('<delivery_state>\n')
    );
    assert.equal(summaries.length, 1);
    assert.ok(Buffer.byteLength(summaries[0].content) < 4096);
    assert.doesNotMatch(summaries[0].content, /original|Recovery delivery/);
    const summary = JSON.parse(
      summaries[0].content.replace(/^<delivery_state>\n|\n<\/delivery_state>$/gu, '')
    );
    assert.deepEqual(summary.checks[0].input, {
      command: 'node check.mjs'
    });
    assert.equal(summary.locations.find(({ kind }) => kind === 'read').path, 'source.txt');
    assert.equal(summary.receiptRequirementsComplete, false);
  }
  assert.match(
    back.requests.at(-1).messages.find(({ content }) => content.startsWith('<delivery_state>'))
      .content,
    /"state":"read"/
  );
  assert.equal(
    instance.exportState().messages.some(({ content }) => content.startsWith('<delivery_state>')),
    false
  );
});

test('task journal and audit persist no raw input or extra permission grants', async (t) => {
  const { root, contract } = await fixture(t);
  const delivery = await TaskDelivery.create(root, contract);
  await delivery.beginOperation('prior', 'McpCall', { remote: 'secret-command-value' });
  const state = delivery.exportState();
  assert.doesNotMatch(JSON.stringify(state), /secret-command-value|fullAccess/);
  const audit = toAuditRecord({
    schemaVersion: 1,
    sessionId: A,
    turnId: B,
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'delivery_updated',
    stage: 'active',
    snapshot: delivery.snapshot()
  });
  assert.equal(audit.unresolvedOperations, 1);
  assert.doesNotMatch(JSON.stringify(audit), /prior|McpCall|source.txt|Recovery delivery/);
});

test('consumer interruption exports unresolved operations without marking the task complete', async (t) => {
  const { root } = await fixture(t);
  const instance = engine(
    root,
    provider([{ name: 'Shell', input: { command: 'node check.mjs' } }])
  );
  await instance.startTaskDelivery('task.json');
  const iterator = instance.runTurn('Run check', { requestApproval: async () => 'allow-once' });
  while (true) {
    const next = await iterator.next();
    if (next.done || next.value.type === 'tool_started') break;
  }
  await iterator.return();
  const saved = instance.exportState().taskDelivery;
  assert.equal(saved.outcome, 'cancelled');
  assert.equal(saved.operations[0].state, 'unknown');
});

test('autosave disabled keeps explicit task changes dirty until manual save', async (t) => {
  const { root, directory } = await fixture(t);
  const instance = engine(root);
  const { session, store } = await controller(root, directory, instance, false);
  t.after(() => session.close());
  await instance.startTaskDelivery('task.json');
  assert.equal(session.getStatus().dirty, true);
  await assert.rejects(store.load(A), /not found/);
  await session.save();
  assert.ok((await store.load(A)).engineState.taskDelivery);
});

test('restore detects a file parent replaced by an escaping symlink or junction', async (t) => {
  const { root, directory } = await fixture(t);
  await mkdir(join(root, 'evidence'));
  await writeFile(join(root, 'evidence', 'NOTES.md'), 'Verified\n');
  await writeFile(
    join(root, 'task.json'),
    JSON.stringify({
      schemaVersion: 1,
      title: 'Junction receipt',
      requirements: [{ id: 'read', label: 'Read', kind: 'read', path: 'evidence/NOTES.md' }]
    })
  );
  const instance = engine(root, provider([{ name: 'Read', input: { path: 'evidence/NOTES.md' } }]));
  await instance.startTaskDelivery('task.json');
  await run(instance);
  const state = instance.exportState();
  assert.equal(instance.getStatus().delivery.satisfied, true);
  await mkdir(join(directory, 'outside'));
  await writeFile(join(directory, 'outside', 'NOTES.md'), 'Verified\n');
  await rm(join(root, 'evidence'), { recursive: true });
  await symlink(
    join(directory, 'outside'),
    join(root, 'evidence'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const restored = engine(root);
  restored.restoreState(state);
  assert.equal((await restored.inspectTaskDelivery()).items[0].state, 'stale');
});

test('new session is empty while original task is available after returning to its session', async (t) => {
  const { root, directory } = await fixture(t);
  const { session } = await controller(root, directory, engine(root));
  t.after(() => session.close());
  await session.engine.startTaskDelivery('task.json');
  await session.newSession();
  assert.equal(session.engine.getStatus().delivery, undefined);
  await session.resume(A);
  assert.equal(session.engine.getStatus().delivery.title, 'Recovery delivery');
});

test(
  'forced process exit after a real side effect restores a pending journal and never replays it',
  { timeout: 20000 },
  async (t) => {
    const { root, directory } = await fixture(t);
    const urls = Object.fromEntries(
      ['engine', 'session-store', 'session-controller'].map((name) => [
        name,
        pathToFileURL(join(process.cwd(), 'dist', `${name}.js`)).href
      ])
    );
    const script = `import { appendFile } from 'node:fs/promises';
import { z } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'node_modules/zod/index.js')).href)};
import { QueryEngine } from ${JSON.stringify(urls.engine)};
import { SessionStore } from ${JSON.stringify(urls['session-store'])};
import { SessionController } from ${JSON.stringify(urls['session-controller'])};
const root = ${JSON.stringify(root)};
const tool = {name:'Shell',description:'Effect',risk:'execute',approval:'always',inputSchema:z.object({command:z.string()}),execute:async()=>{ await appendFile(${JSON.stringify(join(root, 'effects.txt'))}, 'once\\n'); process.stdout.write('M2_EFFECT_DONE\\n'); await new Promise(()=>{setInterval(()=>{},1000);}); }};
const back = {getInfo:()=>({name:'test',type:'test',model:'test',capabilities:{streaming:false,reasoningToggle:false}}),chat:async()=>({message:{role:'assistant',content:'',toolCalls:[{id:'crashed-op',name:'Shell',input:{command:'append once'}}]}})};
const engine = new QueryEngine({provider:back,tools:[tool],workspaceRoot:root,sessionId:${JSON.stringify(A)},audit:false});
const store = await SessionStore.create({workspaceRoot:root,baseDirectory:${JSON.stringify(join(directory, 'sessions'))}});
await SessionController.create({store,engine,providerId:'test',autoSave:true,engineFactory:()=>{throw new Error('unused');}});
await engine.startTaskDelivery('task.json');
for await (const event of engine.runTurn('Append once', {requestApproval:async()=> 'allow-once'})) {}
`;
    const file = join(directory, 'crash.mjs');
    await writeFile(file, script);
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    let output = '';
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Crash fixture timeout: ${errors}`)), 10000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('M2_EFFECT_DONE')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(new Error(`Crash fixture exited early: ${errors}`));
      });
    });
    child.kill();
    await closed;
    const store = await SessionStore.create({
      workspaceRoot: root,
      baseDirectory: join(directory, 'sessions')
    });
    const checkpoint = await store.load(A);
    assert.equal(checkpoint.engineState.taskDelivery.operations[0].state, 'pending');
    let executions = 0;
    const back = provider([{ name: 'Shell', input: { command: 'append once' } }]);
    const tool = {
      name: 'Shell',
      description: 'Effect',
      risk: 'execute',
      approval: 'always',
      inputSchema: z.object({ command: z.string() }),
      execute: async () => {
        executions++;
        return { content: 'done' };
      }
    };
    const restored = engine(root, back, { sessionId: B, tools: [tool] });
    const { session } = await controller(root, directory, restored, true, (sessionId, mode) =>
      engine(root, back, { sessionId, mode, tools: [tool] })
    );
    t.after(() => session.close());
    const result = await session.resume(A);
    assert.equal(back.requests.length, 0);
    assert.equal(result.delivery.unresolvedOperations[0].state, 'unknown');
    await run(session.engine);
    assert.equal(executions, 0);
    assert.equal(await readFile(join(root, 'effects.txt'), 'utf8'), 'once\n');
  }
);

test('exported delivery state is deeply isolated from live state', async (t) => {
  const { root, instance } = await completed(t);
  const state = instance.exportState();
  state.taskDelivery.contract.title = 'tampered';
  state.taskDelivery.items[0].state = 'planned';
  state.taskDelivery.baselines['source.txt'] = 'f'.repeat(64);
  assert.equal(instance.getStatus().delivery.title, 'Recovery delivery');
  assert.equal((await instance.inspectTaskDelivery()).satisfied, true);
  assert.ok(taskDeliveryStateSchema.safeParse(instance.exportState().taskDelivery).success);
  await assert.rejects(TaskDelivery.load(root, '../task.json'));
});

test('unresolved effects block a different command too, but permit multiple real read-only inspections', async (t) => {
  const { root, contract } = await fixture(t);
  const delivery = await TaskDelivery.create(root, contract);
  await delivery.beginOperation('previous-effect', 'Shell', { command: 'original command' });
  const back = provider([
    { name: 'Read', input: { path: 'source.txt' } },
    { name: 'Read', input: { path: 'check.mjs' } },
    { name: 'Shell', input: { command: 'a completely different command' } }
  ]);
  const instance = engine(root, back);
  instance.restoreState({ ...instance.exportState(), taskDelivery: delivery.exportState() });
  let approvals = 0;
  const { events } = await run(instance, {
    requestApproval: async () => {
      approvals++;
      return 'allow-once';
    }
  });
  assert.equal(
    events.filter(
      (event) =>
        event.type === 'tool_completed' && event.toolName === 'Read' && event.outcome === 'success'
    ).length,
    2
  );
  assert.equal(approvals, 0);
  assert.ok(events.some((event) => event.metadata?.reason === 'task-recovery-required'));
  assert.equal(instance.getStatus().delivery.satisfied, false);
});

test('acknowledgement requires a new approval before an explicit later attempt', async (t) => {
  const { root, contract } = await fixture(t);
  const delivery = await TaskDelivery.create(root, contract);
  await delivery.beginOperation('prior', 'Shell', { command: 'retry' });
  let executions = 0;
  let approvals = 0;
  const tool = {
    name: 'Shell',
    description: 'Effect',
    risk: 'execute',
    approval: 'always',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => {
      executions++;
      return { content: 'done', metadata: { completionReason: 'exited', exitCode: 0 } };
    }
  };
  const back = provider([
    { name: 'Shell', input: { command: 'retry' } },
    undefined,
    { name: 'Shell', input: { command: 'retry' } }
  ]);
  const instance = engine(root, back, { tools: [tool] });
  instance.restoreState({ ...instance.exportState(), taskDelivery: delivery.exportState() });
  const approval = async () => {
    approvals++;
    return 'allow-once';
  };
  await run(instance, { requestApproval: approval });
  assert.equal(executions, 0);
  assert.equal(approvals, 0);
  await instance.resolveTaskOperation('prior');
  assert.equal(executions, 0);
  assert.equal(approvals, 0);
  await run(instance, { requestApproval: approval });
  assert.equal(executions, 1);
  assert.equal(approvals, 1);
});

test('SessionController marks persistence degraded and does not run an effect after disk failure', async (t) => {
  const { root, directory } = await fixture(t);
  let executions = 0;
  const tool = {
    name: 'Shell',
    description: 'Effect',
    risk: 'execute',
    approval: 'always',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => {
      executions++;
      return { content: 'done' };
    }
  };
  const instance = engine(root, provider([{ name: 'Shell', input: { command: 'change' } }]), {
    tools: [tool]
  });
  const { session, store } = await controller(root, directory, instance);
  t.after(() => session.close());
  await instance.startTaskDelivery('task.json');
  store.save = async () => {
    throw new Error('simulated disk failure');
  };
  await run(instance);
  assert.equal(executions, 0);
  assert.equal(session.getStatus().persistence, 'degraded');
  assert.equal(session.getStatus().dirty, true);
});

test('TUI startup displays restored delivery warnings and keeps confirmation answers out of history', async (t) => {
  const { root, contract } = await fixture(t);
  const delivery = await TaskDelivery.create(root, contract);
  await delivery.beginOperation('prior', 'Shell', { command: 'unknown' });
  const instance = engine(root);
  instance.restoreState({ ...instance.exportState(), taskDelivery: delivery.exportState() });
  const ui = await InteractionController.create({
    engine: instance,
    persistentHistory: false,
    streamOutput: false,
    sessionOptions: { uiLanguage: 'zh-CN' }
  });
  t.after(() => ui.requestExit('test-complete'));
  assert.ok(
    ui
      .getSnapshot()
      .transcript.some((block) => block.kind === 'notice' && block.text.includes('未决操作'))
  );
  const submitted = ui.submit('/task resolve prior');
  while (!ui.getSnapshot().pending) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(ui.getSnapshot().pending.type, 'confirm');
  ui.resolvePending(true);
  await submitted;
  assert.equal(instance.getStatus().delivery.unresolvedOperations, undefined);
  assert.equal(ui.inputHistory.includes('y'), false);
  assert.equal(instance.getMessages().length, 0);
});

test('task state is a separate additive context segment and ordinary chats have none', async (t) => {
  const { root } = await fixture(t);
  const ordinary = engine(root);
  await run(ordinary);
  assert.equal(ordinary.getStatus().context.lastRequest.segments.taskState, 0);
  const tracked = engine(root);
  await tracked.startTaskDelivery('task.json');
  await run(tracked);
  const budget = tracked.getStatus().context.lastRequest;
  assert.ok(budget.segments.taskState > 0);
  assert.equal(
    Object.values(budget.segments).reduce((sum, value) => sum + value, 0),
    budget.estimatedInputTokens
  );
});

test('failed task restore cannot activate full access through persisted fields', async (t) => {
  const { root, state } = await completed(t);
  state.taskDelivery.permissionMode = 'fullAccess';
  const restored = engine(root);
  assert.throws(() => restored.restoreState(state));
  assert.equal(restored.getPermissionMode(), 'safe');
  assert.equal(restored.getStatus().delivery, undefined);
});

for (const mode of ['ask', 'plan', 'code'])
  test(`resumed ${mode} delivery distinguishes discovery from current-turn activation`, async (t) => {
    const data = await fixture(t);
    const composition = await recoveryComposition(data);
    const original = engine(data.root);
    await original.startTaskDelivery('task.json');
    const backend = provider([
      { name: 'DiscoverSkills', input: { query: 'recovery-workflow' } },
      { name: 'ActivateSkill', input: { name: 'recovery-workflow' } }
    ]);
    const restored = engine(data.root, backend, {
      composition,
      tools: composition.getTools(),
      mode
    });
    restored.restoreState(original.exportState());
    const { events, result } = await run(restored);
    assert.equal(result.status, 'completed');
    assert.match(backend.requests[0].systemPrompt, /Restored task\/file receipts do not restore/u);
    assert.match(backend.requests[1].systemPrompt, /searching is not loading/u);
    assert.match(backend.requests[1].systemPrompt, /takes precedence over delivery focus/u);
    assert.match(backend.requests[1].systemPrompt, /necessary source reads may come first/u);
    assert.match(
      backend.requests[1].systemPrompt,
      /Do not activate a Skill for an unrelated request/u
    );
    assert.doesNotMatch(backend.requests[1].systemPrompt, /RECOVERY_SKILL_BODY/u);
    assert.doesNotMatch(
      backend.requests[2].systemPrompt,
      /Restored task\/file receipts do not restore/u
    );
    assert.ok(
      backend.requests[2].messages.some(
        (message) => message.role === 'tool' && message.content.includes('RECOVERY_SKILL_BODY')
      )
    );
    assert.equal(events.filter((event) => event.type === 'skill_activated').length, 1);
    assert.equal(backend.requests.length, 3);
    assert.equal(restored.getPermissionMode(), 'safe');
    assert.equal(
      events.some((event) => event.type === 'approval_requested'),
      false
    );
  });

test('cancelled activation is not automatically replayed by session state restore', async (t) => {
  const data = await fixture(t);
  const composition = await recoveryComposition(data);
  const original = engine(
    data.root,
    provider([{ name: 'ActivateSkill', input: { name: 'recovery-workflow' } }]),
    { composition, tools: composition.getTools() }
  );
  await original.startTaskDelivery('task.json');
  const abort = new AbortController();
  const result = await consumeAgentTurn(
    original.runTurn('Use a workflow.', { signal: abort.signal }),
    (event) => {
      if (event.type === 'skill_activated') abort.abort();
    }
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(original.getMessages().length, 0);
  const freshComposition = await recoveryComposition(data);
  const backend = provider();
  const restored = engine(data.root, backend, {
    composition: freshComposition,
    tools: freshComposition.getTools()
  });
  restored.restoreState(original.exportState());
  const { events } = await run(restored);
  assert.match(backend.requests[0].systemPrompt, /No Skill is currently active/u);
  assert.doesNotMatch(JSON.stringify(backend.requests[0].messages), /RECOVERY_SKILL_BODY/u);
  assert.equal(freshComposition.getStatus().skills.activeThisTurn, 0);
  assert.equal(
    events.some((event) => event.type === 'tool_started'),
    false
  );
  assert.equal(backend.requests.length, 1);
});

for (const [name, config] of [
  ['disabled Skills', { enabled: false }],
  ['disabled implicit activation', { allowImplicit: false }],
  ['omitted activation tool', {}]
])
  test(`resume guidance does not request activation with ${name}`, async (t) => {
    const data = await fixture(t);
    const composition = await recoveryComposition(data, config);
    const original = engine(data.root);
    await original.startTaskDelivery('task.json');
    const backend = provider();
    const restored = engine(data.root, backend, {
      composition,
      tools: name === 'omitted activation tool' ? [] : composition.getTools()
    });
    restored.restoreState(original.exportState());
    const { events } = await run(restored);
    assert.doesNotMatch(
      backend.requests[0].systemPrompt,
      /Restored task\/file receipts do not restore/u
    );
    assert.equal(
      events.some((event) => event.type === 'tool_started'),
      false
    );
    assert.equal(backend.requests.length, 1);
  });

test('fresh delivery and ordinary conversation have no resume activation reminder', async (t) => {
  const data = await fixture(t);
  const composition = await recoveryComposition(data);
  for (const tracked of [false, true]) {
    const backend = provider();
    const instance = engine(data.root, backend, { composition, tools: composition.getTools() });
    if (tracked) await instance.startTaskDelivery('task.json');
    await run(instance);
    assert.doesNotMatch(
      backend.requests[0].systemPrompt,
      /Restored task\/file receipts do not restore/u
    );
    assert.equal(backend.requests.length, 1);
  }
});

test('closed tool window removes the resume activation reminder without adding a request', async (t) => {
  const data = await fixture(t);
  const composition = await recoveryComposition(data);
  const original = engine(data.root);
  await original.startTaskDelivery('task.json');
  const backend = provider([{ name: 'DiscoverSkills', input: { query: 'recovery-workflow' } }]);
  const restored = engine(data.root, backend, {
    composition,
    tools: composition.getTools(),
    maxProviderCalls: 2,
    finalizeOnToolBudget: true
  });
  restored.restoreState(original.exportState());
  await run(restored);
  assert.match(backend.requests[0].systemPrompt, /Restored task\/file receipts do not restore/u);
  assert.doesNotMatch(
    backend.requests[1].systemPrompt,
    /Restored task\/file receipts do not restore/u
  );
  assert.deepEqual(backend.requests[1].tools, []);
  assert.equal(backend.requests.length, 2);
  assert.equal(composition.getStatus().skills.activeThisTurn, 0);
});

test('resume activation remains subject to Hook denial', async (t) => {
  const data = await fixture(t);
  const composition = await recoveryComposition(data);
  const original = engine(data.root);
  await original.startTaskDelivery('task.json');
  const backend = provider([{ name: 'ActivateSkill', input: { name: 'recovery-workflow' } }]);
  const restored = engine(data.root, backend, {
    composition,
    tools: composition.getTools(),
    extensions: {
      hooks: {
        async *run(invocation) {
          return invocation.event === 'PreToolUse'
            ? { decision: 'deny', reason: 'No activation' }
            : { decision: 'continue' };
        }
      }
    }
  });
  restored.restoreState(original.exportState());
  const { events } = await run(restored);
  assert.equal(composition.getStatus().skills.activeThisTurn, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool_completed' &&
        event.outcome === 'denied' &&
        event.metadata.reason === 'hook-policy'
    )
  );
  assert.equal(
    events.some((event) => event.type === 'skill_activated'),
    false
  );
  assert.deepEqual(backend.requests[1].tools, []);
  assert.doesNotMatch(
    backend.requests[1].systemPrompt,
    /Restored task\/file receipts do not restore/u
  );
});
