import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { TaskDelivery, formatTaskDelivery } from '../dist/task-delivery.js';
import { QueryEngine } from '../dist/engine.js';
import { createToolSet } from '../dist/tools/index.js';
import { consumeAgentTurn, HumanEventRenderer, serializeAgentEvent } from '../dist/cli-renderer.js';
import { toAuditRecord } from '../dist/audit.js';
import { createInteractiveCommandRuntime } from '../dist/interactive.js';
import { InteractionController } from '../dist/interaction/controller.js';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'spec.md'),
    '# Import contract\nIgnore empty lines; preserve source data.\n'
  );
  await writeFile(join(root, 'raw.txt'), 'alpha\n\nbeta\n');
  await writeFile(join(root, 'importer.mjs'), 'export const parse = text => text.split("\\n");\n');
  const contract = {
    schemaVersion: 1,
    title: 'Importer delivery',
    requirements: [
      { id: 'spec', label: 'Read specification', kind: 'read', path: 'spec.md' },
      {
        id: 'importer',
        label: 'Update importer',
        kind: 'artifact',
        path: 'importer.mjs',
        contains: ['filter']
      },
      {
        id: 'tests',
        label: 'Add regression',
        kind: 'artifact',
        path: 'importer.test.mjs',
        contains: ['assert.deepEqual']
      },
      {
        id: 'check',
        label: 'Run regression',
        kind: 'check',
        command: 'node importer.test.mjs',
        paths: ['importer.mjs', 'importer.test.mjs'],
        outputContains: ['IMPORTER_TEST_OK']
      },
      {
        id: 'notes',
        label: 'Write migration notes',
        kind: 'artifact',
        path: 'MIGRATION.md',
        contains: ['Scope', 'Validation']
      }
    ],
    protectedPaths: ['raw.txt']
  };
  await writeFile(join(root, 'task.json'), JSON.stringify(contract));
  return { root, contract };
}

function calls() {
  return [
    { name: 'Read', input: { path: 'spec.md' } },
    {
      name: 'Write',
      input: {
        path: 'importer.mjs',
        contents: 'export const parse = text => text.split("\\n").filter(Boolean);\n'
      }
    },
    {
      name: 'Write',
      input: {
        path: 'importer.test.mjs',
        contents:
          'import assert from "node:assert/strict";\nimport { parse } from "./importer.mjs";\nassert.deepEqual(parse("alpha\\n\\nbeta\\n"), ["alpha", "beta"]);\nconsole.log("IMPORTER_TEST_OK");\n'
      }
    },
    { name: 'Shell', input: { command: 'node importer.test.mjs' } },
    {
      name: 'Write',
      input: {
        path: 'MIGRATION.md',
        contents:
          '# Migration\n## Scope\nSkip empty lines; do not modify raw data.\n## Validation\nnode importer.test.mjs\n'
      }
    }
  ];
}

function scriptedProvider(sequence = [], final = 'All tests passed.', options = {}) {
  const requests = [];
  return {
    requests,
    getInfo: () => ({
      name: 'Delivery test',
      type: 'test',
      model: 'delivery-test',
      contextWindowTokens: options.window ?? 65536,
      capabilities: { streaming: false, reasoningToggle: false }
    }),
    async chat(request) {
      requests.push(request);
      const call = sequence[requests.length - 1];
      if (call)
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: `call-${requests.length}`, ...call }]
          }
        };
      if (options.fail) throw new Error('provider failed after execution');
      return {
        message: { role: 'assistant', content: final },
        finishReason: options.finishReason ?? 'stop'
      };
    }
  };
}

async function runFixture(t, options = {}) {
  const { root, contract } = await workspace(t);
  if (options.contract)
    await writeFile(join(root, 'task.json'), JSON.stringify(options.contract(contract)));
  const provider = scriptedProvider(options.calls ?? calls(), options.final, options);
  const engine = new QueryEngine({
    provider,
    workspaceRoot: root,
    tools:
      options.tools ??
      createToolSet().filter(({ name }) =>
        ['Read', 'Write', 'Edit', 'Patch', 'Shell'].includes(name)
      ),
    mode: options.mode ?? 'code',
    audit: false,
    context: options.context,
    maxProviderCalls: options.maxProviderCalls,
    maxToolCalls: options.maxToolCalls,
    maxToolRounds: options.maxToolRounds,
    finalizeOnToolBudget: options.finalizeOnToolBudget
  });
  if (options.track !== false) await engine.startTaskDelivery('task.json');
  const events = [];
  const result = await consumeAgentTurn(
    engine.runTurn('Read spec, fix importer, test it, and write notes.', {
      requestApproval: options.approval ?? (async () => 'allow-once'),
      signal: options.signal
    }),
    (event) => {
      events.push(event);
      options.onEvent?.(event);
    }
  );
  return {
    root,
    contract,
    provider,
    engine,
    events,
    result,
    snapshot: await engine.inspectTaskDelivery()
  };
}

test('delivery vertical slice uses real Read/Write/Shell and leaves protected raw data unchanged', async (t) => {
  const fixture = await runFixture(t);
  assert.equal(fixture.result.status, 'completed');
  assert.deepEqual(
    fixture.snapshot.items.map(({ state }) => state),
    ['read', 'artifact', 'artifact', 'checked', 'artifact']
  );
  assert.equal(fixture.snapshot.protection, 'unchanged');
  assert.equal(fixture.snapshot.satisfied, true);
  assert.equal(await readFile(join(fixture.root, 'raw.txt'), 'utf8'), 'alpha\n\nbeta\n');
  assert.match(await readFile(join(fixture.root, 'MIGRATION.md'), 'utf8'), /Validation/);
  const shell = fixture.events.find(
    (event) => event.type === 'tool_completed' && event.toolName === 'Shell'
  );
  assert.equal(shell.metadata.exitCode, 0);
  assert.equal(shell.metadata.completionReason, 'exited');
  assert.equal(fixture.snapshot.items[3].receipt.toolCallId, shell.toolCallId);
  const final = fixture.events.find(
    (event) => event.type === 'delivery_updated' && event.stage === 'final'
  );
  assert.deepEqual(final.snapshot, fixture.snapshot);
  assert.ok(
    fixture.events.indexOf(final) <
      fixture.events.findIndex((event) => event.type === 'turn_completed')
  );
});

function requestDeliveryState(request) {
  const block = request.messages.find((message) =>
    message.content?.startsWith('<delivery_state>\n')
  );
  return JSON.parse(block.content.replace(/^<delivery_state>\n|\n<\/delivery_state>$/gu, ''));
}

test('exact check hints are independently byte bounded and never truncate a command', async (t) => {
  const { root } = await workspace(t);
  const commands = ['界'.repeat(1000), '另'.repeat(1000), 'node check.mjs'];
  const delivery = await TaskDelivery.create(root, {
    schemaVersion: 1,
    title: 'Bounded checks',
    requirements: commands.map((command, i) => ({
      id: `check${i}`,
      label: 'Check',
      kind: 'check',
      command,
      paths: ['raw.txt']
    })),
    protectedPaths: ['raw.txt']
  });
  const summary = JSON.parse(delivery.contextSummary());
  assert.equal(summary.checksOmitted, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(summary.checks)) <= 2048);
  assert.deepEqual(
    summary.checks.map(({ input }) => input.command),
    ['node check.mjs']
  );
  assert.equal(summary.receiptRequirementsComplete, false);
  assert.equal(delivery.snapshot().items.length, 3);
});

test('delivery context keeps the exact check object and distinguishes readiness from completion', async (t) => {
  const fixture = await runFixture(t, { maxProviderCalls: 10, finalizeOnToolBudget: true });
  const initial = requestDeliveryState(fixture.provider.requests[0]);
  assert.deepEqual(initial.checks, [
    {
      id: 'check',
      state: 'planned',
      input: { command: 'node importer.test.mjs' },
      paths: ['importer.mjs', 'importer.test.mjs']
    }
  ]);
  assert.equal(initial.receiptRequirementsComplete, false);
  const final = requestDeliveryState(fixture.provider.requests.at(-1));
  assert.equal(final.checks[0].state, 'checked');
  assert.equal(final.receiptRequirementsComplete, true);
  assert.equal(final.outcome, 'active');
  assert.equal(fixture.snapshot.satisfied, true);
  assert.equal(fixture.provider.requests.length, 6);
  assert.equal(fixture.result.budgetStopReason, undefined);
  assert.match(fixture.provider.requests.at(-1).systemPrompt, /stop optional tools/);
});

test('delivery focus exposes exact known locations and follows receipts without adding model calls', async (t) => {
  const steps = calls();
  const fixture = await runFixture(t, {
    calls: [steps[0], steps[1], steps[2], steps[4], steps[3]],
    maxProviderCalls: 10,
    finalizeOnToolBudget: true
  });
  const summaries = fixture.provider.requests.map(requestDeliveryState);
  assert.deepEqual(
    summaries.map(({ focus }) => focus),
    [
      'read-sources',
      'produce-artifacts',
      'produce-artifacts',
      'produce-artifacts',
      'run-checks',
      'report'
    ]
  );
  assert.deepEqual(summaries[0].locations, [
    { id: 'spec', kind: 'read', state: 'planned', path: 'spec.md' },
    { id: 'importer', kind: 'artifact', state: 'planned', path: 'importer.mjs' },
    { id: 'tests', kind: 'artifact', state: 'planned', path: 'importer.test.mjs' },
    { id: 'notes', kind: 'artifact', state: 'planned', path: 'MIGRATION.md' }
  ]);
  assert.equal(summaries[1].locations[0].state, 'read');
  assert.deepEqual(summaries[4].checks[0].input, { command: 'node importer.test.mjs' });
  assert.equal(fixture.provider.requests.length, 6);
  assert.equal(fixture.snapshot.satisfied, true);
  assert.match(fixture.provider.requests[0].systemPrompt, /Read the listed source paths directly/);
  assert.match(fixture.provider.requests.at(-1).systemPrompt, /regardless of focus/);
  assert.equal(
    fixture.engine
      .exportState()
      .messages.some(({ content }) => content.startsWith('<delivery_state>')),
    false
  );
});

function requestDeliveryBudget(request) {
  const match = request.systemPrompt.match(/<delivery_budget>\n([^\n]+)\n<\/delivery_budget>/u);
  return match ? JSON.parse(match[1]) : undefined;
}

const includeNotesInCheck = (contract) => ({
  ...contract,
  requirements: contract.requirements.map((requirement) =>
    requirement.kind === 'check'
      ? { ...requirement, paths: [...requirement.paths, 'MIGRATION.md'] }
      : requirement
  )
});

test('a check before a required document exists stays unverified until the real final recheck', async (t) => {
  const steps = calls();
  const fixture = await runFixture(t, {
    contract: includeNotesInCheck,
    calls: [...steps, steps[3]]
  });
  const summaries = fixture.provider.requests.map(requestDeliveryState);
  assert.equal(summaries[4].checks[0].state, 'unknown');
  assert.equal(summaries[5].checks[0].state, 'unknown');
  assert.equal(summaries[5].receiptRequirementsComplete, false);
  assert.deepEqual(summaries[5].checks[0].paths, [
    'importer.mjs',
    'importer.test.mjs',
    'MIGRATION.md'
  ]);
  assert.match(fixture.provider.requests[5].systemPrompt, /including required documentation/);
  assert.match(
    fixture.provider.requests[5].systemPrompt,
    /rerun the exact authorized check with normal approval/
  );
  assert.equal(summaries[6].checks[0].state, 'checked');
  assert.equal(fixture.snapshot.satisfied, true);
  assert.equal(fixture.provider.requests.length, 7);
  assert.equal(
    fixture.events.filter((event) => event.type === 'tool_completed' && event.toolName === 'Shell')
      .length,
    2
  );
});

test('changing a checked document makes the receipt stale and requires a new successful check', async (t) => {
  const steps = calls();
  const updated = {
    ...steps[4],
    input: { ...steps[4].input, contents: `${steps[4].input.contents}Additional scope detail.\n` }
  };
  const fixture = await runFixture(t, {
    contract: includeNotesInCheck,
    calls: [steps[0], steps[1], steps[2], steps[4], steps[3], updated, steps[3]]
  });
  const summaries = fixture.provider.requests.map(requestDeliveryState);
  assert.equal(summaries[5].checks[0].state, 'checked');
  assert.equal(summaries[6].checks[0].state, 'stale');
  assert.equal(summaries[6].receiptRequirementsComplete, false);
  assert.match(
    fixture.provider.requests[6].systemPrompt,
    /after a check requires an explicit recheck/
  );
  assert.equal(summaries[7].checks[0].state, 'checked');
  assert.equal(fixture.snapshot.items[3].receipt.toolCallId, 'call-7');
  assert.equal(fixture.snapshot.satisfied, true);
  assert.equal(fixture.provider.requests.length, 8);
});

test('check dependency hints are omitted whole when their full paths exceed the shared byte limit', async (t) => {
  const { root } = await workspace(t);
  const paths = Array.from({ length: 16 }, (_, index) => `${'a'.repeat(140)}-${index}.txt`);
  const delivery = await TaskDelivery.create(root, {
    schemaVersion: 1,
    title: 'Long dependency hints',
    requirements: [
      {
        id: 'check',
        label: 'Check',
        kind: 'check',
        command: 'node check.mjs',
        paths
      }
    ],
    protectedPaths: []
  });
  const summary = JSON.parse(delivery.contextSummary());
  assert.deepEqual(summary.checks, []);
  assert.equal(summary.checksOmitted, 1);
  assert.equal(summary.receiptRequirementsComplete, false);
  assert.equal(delivery.snapshot().items.length, 1);
});

test('delivery request ceilings are visible from the first request without spending extra calls', async (t) => {
  const fixture = await runFixture(t, {
    maxProviderCalls: 10,
    maxToolCalls: 24,
    maxToolRounds: 10,
    finalizeOnToolBudget: true
  });
  const hints = fixture.provider.requests.map(requestDeliveryBudget);
  assert.deepEqual(
    hints.map((hint) => hint.providerRequestsRemaining),
    [10, 9, 8, 7, 6, 5]
  );
  assert.deepEqual(
    hints.map((hint) => hint.toolRequestsRemaining),
    [9, 8, 7, 6, 5, 4]
  );
  assert.deepEqual(
    hints.map((hint) => hint.toolCallsRemaining),
    [24, 23, 22, 21, 20, 19]
  );
  assert.ok(hints.every((hint) => hint.reservedFinalRequests === 1 && hint.includesCurrentRequest));
  assert.match(fixture.provider.requests[0].systemPrompt, /diagnostic baseline check is valid/);
  assert.equal(fixture.snapshot.satisfied, true);
  assert.equal(fixture.provider.requests.length, 6);
  assert.equal(
    fixture.engine
      .exportState()
      .messages.some(({ content }) => content.includes('<delivery_budget>')),
    false
  );
});

test('uncapped and hard budgets do not invent a reserved final request or change ordinary chats', async (t) => {
  const uncapped = await runFixture(t, { calls: [] });
  assert.equal(
    requestDeliveryBudget(uncapped.provider.requests[0]).providerRequestsRemaining,
    null
  );
  assert.equal(requestDeliveryBudget(uncapped.provider.requests[0]).toolCallsRemaining, null);
  assert.equal(requestDeliveryBudget(uncapped.provider.requests[0]).reservedFinalRequests, 0);
  const hard = await runFixture(t, { calls: [], maxProviderCalls: 2 });
  assert.equal(requestDeliveryBudget(hard.provider.requests[0]).toolRequestsRemaining, 2);
  const ordinary = await runFixture(t, { calls: [], track: false });
  assert.equal(requestDeliveryBudget(ordinary.provider.requests[0]), undefined);
});

test('one reserved request exposes zero tool capacity and never manufactures a passing delivery', async (t) => {
  const fixture = await runFixture(t, {
    calls: [],
    maxProviderCalls: 1,
    finalizeOnToolBudget: true
  });
  const hint = requestDeliveryBudget(fixture.provider.requests[0]);
  assert.equal(hint.providerRequestsRemaining, 1);
  assert.equal(hint.toolRequestsRemaining, 0);
  assert.deepEqual(fixture.provider.requests[0].tools, []);
  assert.equal(fixture.result.budgetStopReason, 'provider-call-limit');
  assert.equal(fixture.snapshot.outcome, 'incomplete');
  assert.equal(fixture.snapshot.satisfied, false);
});

test('tool-call and round ceilings close truthfully without relaxing approval or delivery', async (t) => {
  for (const options of [{ maxToolCalls: 1 }, { maxToolRounds: 1 }]) {
    const fixture = await runFixture(t, {
      ...options,
      calls: options.maxToolCalls ? [calls()[0], calls()[0]] : [calls()[0]],
      finalizeOnToolBudget: true
    });
    const hints = fixture.provider.requests.map(requestDeliveryBudget);
    assert.equal(hints.at(-1).toolRequestsRemaining, 0);
    assert.deepEqual(fixture.provider.requests.at(-1).tools, []);
    assert.equal(fixture.snapshot.satisfied, false);
    assert.equal(fixture.snapshot.outcome, 'incomplete');
    assert.ok(
      Buffer.byteLength(
        fixture.provider.requests[0].systemPrompt.match(
          /<delivery_budget>[\s\S]*?<\/delivery_budget>/u
        )[0]
      ) < 512
    );
  }
});

test('delivery budget reflects compaction calls before the actual turn request', async (t) => {
  const { root } = await workspace(t);
  const requests = [];
  const provider = scriptedProvider([], undefined, { window: 12000 });
  provider.chat = async (request) => {
    requests.push(request);
    return {
      message: {
        role: 'assistant',
        content: !requestDeliveryBudget(request)
          ? 'Earlier discussion considered record import; no files were changed or checks executed.'
          : 'Work remains unchecked.'
      },
      finishReason: 'stop'
    };
  };
  const engine = new QueryEngine({
    provider,
    workspaceRoot: root,
    tools: [],
    audit: false,
    maxProviderCalls: 4,
    finalizeOnToolBudget: true,
    context: {
      defaultWindowTokens: 12000,
      triggerRatio: 0.85,
      targetRatio: 0.5,
      reservedOutputTokens: 512,
      minimumCompactableTokens: 20
    }
  });
  const previous = engine.exportState();
  engine.restoreState({
    ...previous,
    messages: [
      { role: 'user', content: 'Earlier record discussion. '.repeat(1500) },
      { role: 'assistant', content: 'No execution yet. '.repeat(1500) }
    ]
  });
  await engine.startTaskDelivery('task.json');
  await consumeAgentTurn(engine.runTurn('Report current state.'), () => {});
  const turnIndex = requests.findIndex((request) => requestDeliveryBudget(request));
  assert.ok(turnIndex > 0, 'Compaction must actually consume a prior request');
  const hint = requestDeliveryBudget(requests[turnIndex]);
  assert.equal(hint.providerRequestsRemaining, 4 - turnIndex);
  assert.equal(hint.toolRequestsRemaining, Math.max(0, 3 - turnIndex));
  assert.ok(requests.length <= 4);
});

test('location hints omit whole entries within a byte limit and preserve every delivery obligation', async (t) => {
  const { root } = await workspace(t);
  const requirements = Array.from({ length: 8 }, (_, i) => ({
    id: `file${i}`,
    label: 'Artifact',
    kind: 'artifact',
    path: `folder${i}/${'界'.repeat(220)}.md`
  }));
  const delivery = await TaskDelivery.create(root, {
    schemaVersion: 1,
    title: 'Bounded locations',
    requirements,
    protectedPaths: []
  });
  const summary = JSON.parse(delivery.contextSummary());
  assert.ok(summary.locationsOmitted > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(summary.locations)) <= 2048);
  assert.equal(summary.locations.length + summary.locationsOmitted, 8);
  for (const location of summary.locations)
    assert.equal(location.path, requirements.find(({ id }) => id === location.id).path);
  assert.equal(summary.focus, 'produce-artifacts');
  assert.equal(summary.receiptRequirementsComplete, false);
  assert.equal(delivery.snapshot().items.length, 8);
});

test('focus is guidance, not a tool filter or permission to bypass a blocked operation', async (t) => {
  const fixture = await runFixture(t, {
    calls: [{ name: 'ListDirectory', input: {} }, ...calls()],
    tools: createToolSet().filter(({ name }) =>
      ['Read', 'Write', 'Shell', 'ListDirectory'].includes(name)
    ),
    approval: async (request) => (request.toolName === 'Shell' ? 'deny' : 'allow-once')
  });
  assert.equal(requestDeliveryState(fixture.provider.requests[0]).focus, 'read-sources');
  assert.equal(
    fixture.events.find((e) => e.type === 'tool_completed' && e.toolName === 'ListDirectory')
      .outcome,
    'success'
  );
  assert.equal(requestDeliveryState(fixture.provider.requests.at(-1)).focus, 'inspect-blockers');
  assert.equal(fixture.snapshot.items[3].reason, 'denied');
  assert.equal(fixture.snapshot.satisfied, false);
  assert.ok(fixture.provider.requests[0].tools.some(({ name }) => name === 'ListDirectory'));
});

test('restored, stale and unresolved receipts never produce a misleading report focus', async (t) => {
  const fixture = await runFixture(t);
  const delivery = TaskDelivery.restore(fixture.root, fixture.engine.exportState().taskDelivery);
  assert.equal(JSON.parse(delivery.contextSummary()).focus, 'inspect-blockers');
  await delivery.reconcile();
  assert.equal(JSON.parse(delivery.contextSummary()).focus, 'report');
  await writeFile(join(fixture.root, 'spec.md'), 'Changed specification\n');
  await delivery.reconcile();
  assert.equal(JSON.parse(delivery.contextSummary()).focus, 'read-sources');
  await delivery.beginOperation('pending', 'Shell', { command: 'node check.mjs' });
  assert.equal(JSON.parse(delivery.contextSummary()).focus, 'inspect-blockers');
  assert.equal(JSON.parse(delivery.contextSummary()).receiptRequirementsComplete, false);
});

test('a schema correction requires a fresh model call and normal approval before real verification', async (t) => {
  const steps = calls();
  let shellApprovals = 0;
  const fixture = await runFixture(t, {
    calls: [
      ...steps.slice(0, 3),
      { name: 'Shell', input: { command: 'node importer.test.mjs', workingDirectory: '.' } },
      ...steps.slice(3)
    ],
    maxProviderCalls: 10,
    finalizeOnToolBudget: true,
    approval: async (request) => {
      if (request.toolName === 'Shell') shellApprovals++;
      return 'allow-once';
    }
  });
  const shellEvents = fixture.events.filter(
    (e) => e.type === 'tool_completed' && e.toolName === 'Shell'
  );
  assert.deepEqual(
    shellEvents.map((e) => e.outcome),
    ['error', 'success']
  );
  assert.equal(shellEvents[0].metadata.reason, 'invalid-tool-input');
  assert.match(shellEvents[0].result, /Validation did not execute/);
  assert.equal(shellApprovals, 1);
  assert.equal(fixture.provider.requests.length, 7);
  assert.equal(fixture.snapshot.satisfied, true);
});

test('a rejected Patch schema preserves current prior receipts without execution or approval', async (t) => {
  let approvals = 0;
  const invalid = { name: 'Patch', input: { path: 'MIGRATION.md', patch: 'invented diff' } };
  const fixture = await runFixture(t, {
    calls: [...calls(), invalid],
    approval: async () => {
      approvals++;
      return 'allow-once';
    }
  });
  assert.equal(approvals, 4);
  const rejected = fixture.events.find(
    (e) => e.toolName === 'Patch' && e.type === 'tool_completed'
  );
  assert.equal(rejected.metadata.reason, 'invalid-tool-input');
  assert.match(rejected.result, /expectedHash.*operations/su);
  assert.ok(Buffer.byteLength(rejected.result) <= 2048);
  assert.equal(fixture.snapshot.items.at(-1).state, 'artifact');
  assert.equal(fixture.snapshot.items.at(-1).receipt.toolCallId, 'call-5');
  assert.equal(fixture.snapshot.satisfied, true);
  assert.equal(requestDeliveryState(fixture.provider.requests.at(-1)).focus, 'report');
  assert.match(
    fixture.provider.requests.at(-1).systemPrompt,
    /takes precedence over optional Skill follow-ups/u
  );
  assert.match(await readFile(join(fixture.root, 'MIGRATION.md'), 'utf8'), /Scope/);
});

test('invalid schema cannot manufacture an artifact or a passing check', async (t) => {
  const fixture = await runFixture(t, {
    calls: [{ name: 'Patch', input: { path: 'MIGRATION.md', patch: 'not executed' } }]
  });
  assert.equal(fixture.snapshot.satisfied, false);
  assert.ok(fixture.snapshot.items.every((item) => item.state === 'planned' && !item.receipt));
  await assert.rejects(readFile(join(fixture.root, 'MIGRATION.md')), /ENOENT/);
});

test('a schema rejection still reconciles external changes to earlier verified files', async (t) => {
  const fixture = await runFixture(t);
  const delivery = TaskDelivery.restore(fixture.root, fixture.engine.exportState().taskDelivery);
  await delivery.reconcile();
  await writeFile(join(fixture.root, 'importer.mjs'), 'externally changed\n');
  await delivery.observe({
    toolCallId: 'invalid',
    tool: 'Patch',
    input: { path: 'importer.mjs' },
    outcome: 'error',
    metadata: { reason: 'invalid-tool-input' }
  });
  assert.equal(delivery.snapshot().items[1].state, 'stale');
  assert.equal(delivery.snapshot().items[3].state, 'stale');
  assert.equal(delivery.snapshot().satisfied, false);
});

test('executed failures cannot masquerade as a host schema rejection', async (t) => {
  const fixture = await runFixture(t);
  const delivery = TaskDelivery.restore(fixture.root, fixture.engine.exportState().taskDelivery);
  await delivery.reconcile();
  const input = { path: 'MIGRATION.md', contents: 'failed write' };
  await delivery.beforeTool('executed', 'Write');
  await delivery.beginOperation('executed', 'Write', input);
  await delivery.observe({
    toolCallId: 'executed',
    tool: 'Write',
    input,
    outcome: 'error',
    metadata: { reason: 'invalid-tool-input' }
  });
  assert.equal(delivery.snapshot().items.at(-1).state, 'blocked');
  assert.equal(delivery.snapshot().unresolvedOperations[0].state, 'unknown');
  assert.equal(delivery.snapshot().satisfied, false);
});

test('a denied exact check stays blocked despite being shown in the delivery context', async (t) => {
  const fixture = await runFixture(t, {
    approval: async (request) => (request.toolName === 'Shell' ? 'deny' : 'allow-once')
  });
  const final = requestDeliveryState(fixture.provider.requests.at(-1));
  assert.equal(final.checks[0].state, 'blocked');
  assert.equal(final.receiptRequirementsComplete, false);
  assert.equal(fixture.snapshot.satisfied, false);
  assert.equal(fixture.snapshot.items[3].reason, 'denied');
  assert.match(fixture.provider.requests.at(-1).systemPrompt, /never retry denied/);
});

test('model claims do not change delivery facts and ordinary chats add no calls/events', async (t) => {
  const tracked = await runFixture(t, { calls: [] });
  assert.equal(tracked.snapshot.satisfied, false);
  assert.ok(tracked.snapshot.items.every(({ state }) => state === 'planned'));
  const ordinary = await runFixture(t, { calls: [], track: false });
  assert.equal(ordinary.provider.requests.length, 1);
  assert.equal(
    ordinary.events.some(({ type }) => type === 'delivery_updated'),
    false
  );
  assert.equal(ordinary.engine.getStatus().delivery, undefined);
  assert.equal(tracked.provider.requests.length, ordinary.provider.requests.length);
  assert.match(tracked.provider.requests[0].systemPrompt, /Delivery state is a bounded/);
  assert.doesNotMatch(ordinary.provider.requests[0].systemPrompt, /Delivery state is a bounded/);
});

test('later file changes invalidate check and artifact receipts without changing old events', async (t) => {
  const fixture = await runFixture(t);
  const originalEvent = fixture.events.find(
    (event) => event.type === 'delivery_updated' && event.stage === 'final'
  );
  await writeFile(join(fixture.root, 'importer.mjs'), 'export const parse = () => [];\n');
  const snapshot = await fixture.engine.inspectTaskDelivery();
  assert.equal(snapshot.items[1].state, 'stale');
  assert.equal(snapshot.items[3].state, 'stale');
  assert.equal(snapshot.satisfied, false);
  assert.equal(originalEvent.snapshot.satisfied, true);
});

test('a mutation after tests within the same turn makes the check stale', async (t) => {
  const fixture = await runFixture(t, {
    calls: [
      ...calls(),
      {
        name: 'Write',
        input: {
          path: 'importer.mjs',
          contents: 'export const parse = text => text.split("\\n").filter(() => false);\n'
        }
      }
    ]
  });
  assert.equal(fixture.snapshot.items[3].state, 'stale');
  assert.equal(fixture.snapshot.satisfied, false);
});

test('a failed actual check blocks delivery even if the model claims success', async (t) => {
  const sequence = calls();
  sequence[2].input.contents =
    'import assert from "node:assert/strict";\nassert.deepEqual(1, 2);\n';
  const fixture = await runFixture(t, { calls: sequence });
  assert.equal(fixture.snapshot.items[3].state, 'blocked');
  assert.equal(fixture.snapshot.items[3].receipt.outcome, 'error');
  assert.equal(fixture.snapshot.satisfied, false);
});

test('a normally exited failing contract check permits approved repair and a fresh real recheck', async (t) => {
  const steps = calls();
  let approvals = 0;
  const fixture = await runFixture(t, {
    calls: [steps[0], steps[2], steps[3], steps[1], steps[3], steps[4]],
    approval: async () => {
      approvals++;
      return 'allow-once';
    }
  });
  const checks = fixture.events.filter(
    (e) => e.type === 'tool_completed' && e.toolName === 'Shell'
  );
  assert.deepEqual(
    checks.map((e) => e.metadata.exitCode),
    [1, 0]
  );
  assert.deepEqual(
    checks.map((e) => e.outcome),
    ['error', 'success']
  );
  assert.ok(approvals >= 5);
  assert.equal(fixture.result.status, 'completed');
  assert.equal(fixture.snapshot.satisfied, true);
  assert.equal(fixture.snapshot.items[3].receipt.toolCallId, checks[1].toolCallId);
  assert.equal(fixture.snapshot.unresolvedOperations, undefined);
  assert.equal(fixture.snapshot.protection, 'unchanged');
});

for (const boundary of [
  'timeout',
  'cancelled',
  'truncated',
  'wrong-command',
  'skill-directory',
  'changed-scope',
  'missing-exit',
  'zero-exit'
]) {
  test(`failed check recovery stays closed for ${boundary}`, async (t) => {
    const { root } = await workspace(t);
    const delivery = await TaskDelivery.create(root, {
      schemaVersion: 1,
      title: 'Failed check boundary',
      requirements: [
        {
          id: 'check',
          label: 'Verification',
          kind: 'check',
          command: 'node check.mjs',
          paths: ['importer.mjs']
        }
      ],
      protectedPaths: ['raw.txt']
    });
    const input = {
      command: boundary === 'wrong-command' ? 'node other.mjs' : 'node check.mjs',
      ...(boundary === 'skill-directory'
        ? { workingDirectory: { type: 'skill', name: 'fixture' } }
        : {})
    };
    await delivery.beforeTool('failed-check', 'Shell');
    await delivery.beginOperation('failed-check', 'Shell', input);
    if (boundary === 'changed-scope') await writeFile(join(root, 'importer.mjs'), 'changed');
    await delivery.observe({
      toolCallId: 'failed-check',
      tool: 'Shell',
      input,
      outcome: boundary === 'cancelled' ? 'cancelled' : 'error',
      metadata: {
        completionReason: boundary === 'timeout' ? 'timeout' : 'exited',
        exitCode: boundary === 'missing-exit' ? undefined : boundary === 'zero-exit' ? 0 : 1,
        stdoutTruncated: boundary === 'truncated'
      }
    });
    const snapshot = await delivery.finish('completed');
    assert.equal(snapshot.satisfied, false);
    assert.equal(snapshot.unresolvedOperations[0].state, 'unknown');
    await assert.rejects(
      delivery.assertOperationAllowed('Write', { path: 'importer.mjs', contents: 'fix' }),
      /Unresolved prior operation/
    );
  });
}

test('approval denial and ask mode preserve the permission boundary', async (t) => {
  for (const options of [{ approval: async () => 'deny' }, { mode: 'ask' }]) {
    const fixture = await runFixture(t, options);
    assert.equal(fixture.snapshot.items[1].state, 'blocked');
    assert.equal(fixture.snapshot.items[3].state, 'blocked');
    assert.equal(fixture.snapshot.satisfied, false);
    assert.equal(
      await readFile(join(fixture.root, 'importer.mjs'), 'utf8'),
      'export const parse = text => text.split("\\n");\n'
    );
  }
});

test('partial Read is unknown and whole-file read can replace it', async (t) => {
  const fixture = await runFixture(t, {
    calls: [{ name: 'Read', input: { path: 'spec.md', limit: 1 } }, ...calls()]
  });
  const snapshots = fixture.events.filter(({ type }) => type === 'delivery_updated');
  assert.ok(snapshots.some(({ snapshot }) => snapshot.items[0].state === 'unknown'));
  assert.equal(fixture.snapshot.items[0].state, 'read');
});

test('cancelled turn and provider failure cannot report a satisfied delivery', async (t) => {
  const abort = new AbortController();
  const cancelled = await runFixture(t, {
    signal: abort.signal,
    onEvent: (event) => {
      if (event.type === 'tool_completed' && event.toolName === 'Shell') abort.abort();
    }
  });
  assert.equal(cancelled.result.status, 'cancelled');
  assert.equal(cancelled.snapshot.outcome, 'cancelled');
  assert.equal(cancelled.snapshot.satisfied, false);
  const failed = await runFixture(t, { fail: true });
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.snapshot.outcome, 'failed');
  assert.equal(failed.snapshot.satisfied, false);
});

test('protected-file changes are sticky and block fulfillment', async (t) => {
  const sequence = [
    ...calls(),
    { name: 'Write', input: { path: 'raw.txt', contents: 'changed\n' } },
    { name: 'Write', input: { path: 'raw.txt', contents: 'alpha\n\nbeta\n' } }
  ];
  const fixture = await runFixture(t, { calls: sequence });
  assert.equal(fixture.snapshot.protection, 'changed');
  assert.equal(fixture.snapshot.satisfied, false);
});

for (const metadata of [
  { completionReason: 'exited', exitCode: 0, stdoutTruncated: true },
  { completionReason: 'exited', exitCode: 0, outputTruncated: true },
  { completionReason: 'timeout', exitCode: 0 },
  {}
]) {
  test(`check requires complete metadata: ${JSON.stringify(metadata)}`, async (t) => {
    const { root } = await workspace(t);
    const delivery = await TaskDelivery.create(root, {
      schemaVersion: 1,
      title: 'Check',
      requirements: [
        {
          id: 'check',
          label: 'Check',
          kind: 'check',
          command: 'node check.mjs',
          paths: ['importer.mjs']
        }
      ]
    });
    delivery.startTurn();
    await delivery.beforeTool('shell', 'Shell');
    await delivery.observe({
      toolCallId: 'shell',
      tool: 'Shell',
      input: { command: 'node check.mjs' },
      outcome: 'success',
      metadata
    });
    assert.equal((await delivery.finish('completed')).items[0].state, 'unknown');
  });
}

test('a skill cwd or different command does not satisfy a workspace check', async (t) => {
  const { root } = await workspace(t);
  const delivery = await TaskDelivery.create(root, {
    schemaVersion: 1,
    title: 'Check',
    requirements: [
      {
        id: 'check',
        label: 'Check',
        kind: 'check',
        command: 'node check.mjs',
        paths: ['importer.mjs']
      }
    ]
  });
  for (const input of [
    { command: 'node other.mjs' },
    { command: 'node check.mjs', workingDirectory: { type: 'skill', name: 'demo' } }
  ]) {
    await delivery.beforeTool('shell', 'Shell');
    await delivery.observe({
      toolCallId: 'shell',
      tool: 'Shell',
      input,
      outcome: 'success',
      metadata: { completionReason: 'exited', exitCode: 0 }
    });
  }
  assert.equal((await delivery.finish('completed')).items[0].state, 'planned');
});

test('file mutations during a check are not checked', async (t) => {
  const { root } = await workspace(t);
  const delivery = await TaskDelivery.create(root, {
    schemaVersion: 1,
    title: 'Check',
    requirements: [
      {
        id: 'check',
        label: 'Check',
        kind: 'check',
        command: 'node check.mjs',
        paths: ['importer.mjs']
      }
    ]
  });
  await delivery.beforeTool('shell', 'Shell');
  await writeFile(join(root, 'importer.mjs'), '// changed while testing\n');
  await delivery.observe({
    toolCallId: 'shell',
    tool: 'Shell',
    input: { command: 'node check.mjs' },
    outcome: 'success',
    metadata: { completionReason: 'exited', exitCode: 0 }
  });
  assert.equal((await delivery.finish('completed')).items[0].state, 'unknown');
});

test('contract parsing rejects duplicate IDs, escapes, secrets, oversized or unreadable input', async (t) => {
  const { root, contract } = await workspace(t);
  for (const file of ['../escape.json', 'C:/escape.json', '.env', '/etc/passwd', 'a/../task.json'])
    await assert.rejects(TaskDelivery.load(root, file));
  await assert.rejects(
    TaskDelivery.create(root, {
      ...contract,
      requirements: [contract.requirements[0], contract.requirements[0]]
    }),
    /unique/
  );
  await assert.rejects(
    TaskDelivery.create(root, { ...contract, protectedPaths: ['missing.txt'] }),
    /must exist/
  );
  await writeFile(join(root, 'large.json'), 'x'.repeat(32769));
  await assert.rejects(TaskDelivery.load(root, 'large.json'), /32 KiB/);
  await writeFile(join(root, 'bad.json'), 'not JSON');
  await assert.rejects(TaskDelivery.load(root, 'bad.json'));
  await assert.rejects(TaskDelivery.create(root, { ...contract, title: '\x1b[2J' }));
});

test('symlink escape cannot become a contract path', async (t) => {
  const { root, contract } = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), 'syzzz-delivery-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    TaskDelivery.create(root, {
      ...contract,
      requirements: [{ id: 'read', label: 'Read', kind: 'read', path: 'escape/secret.txt' }]
    }),
    /escapes/
  );
});

test('delivery renderers agree and audit excludes labels, file names, hashes and receipt IDs', async (t) => {
  const fixture = await runFixture(t);
  const event = fixture.events.find(
    (item) => item.type === 'delivery_updated' && item.stage === 'final'
  );
  const output = [];
  const renderer = new HumanEventRenderer({
    streamOutput: false,
    language: 'zh',
    output: { write: (line) => output.push(line) }
  });
  renderer.handle(event);
  assert.match(output.join(''), /契约检查已满足/);
  assert.ok(output.join('').includes(formatTaskDelivery(event.snapshot, 'zh')));
  assert.deepEqual(
    JSON.parse(serializeAgentEvent(event)).snapshot,
    JSON.parse(JSON.stringify(event.snapshot))
  );
  const audit = JSON.stringify(toAuditRecord(event, 'workspace-hash'));
  for (const text of [
    'Importer delivery',
    'spec.md',
    'Read specification',
    'call-4',
    fixture.snapshot.items[3].receipt.versions['importer.mjs']
  ])
    assert.equal(audit.includes(text), false);
  assert.equal(JSON.parse(audit).satisfied, true);
});

test(
  'slash task stays local and TUI displays the same final delivery snapshot',
  { timeout: 15000 },
  async (t) => {
    const { root } = await workspace(t);
    const provider = scriptedProvider(calls());
    const engine = new QueryEngine({
      provider,
      workspaceRoot: root,
      audit: false,
      tools: createToolSet().filter(({ name }) => ['Read', 'Write', 'Shell'].includes(name))
    });
    const notices = [];
    const runtime = createInteractiveCommandRuntime(
      engine,
      { uiLanguage: 'zh-CN' },
      {
        readLine: async () => {
          throw new Error('unexpected text input');
        }
      },
      { notice: (notice) => notices.push(notice) },
      false
    );
    await runtime.execute('/task start task.json', new AbortController().signal);
    await runtime.execute('/task status', new AbortController().signal);
    assert.equal(provider.requests.length, 0);
    assert.equal(engine.getMessages().length, 0);
    assert.ok(notices.some(({ text }) => text.includes('交付记录')));
    await assert.rejects(engine.startTaskDelivery('task.json'), /Clear/);
    const controller = await InteractionController.create({
      engine,
      persistentHistory: false,
      streamOutput: true,
      sessionOptions: { uiLanguage: 'zh-CN' }
    });
    const timer = setInterval(() => {
      if (controller.getSnapshot().pending?.type === 'approval')
        controller.resolvePending('allow-once');
    }, 10);
    try {
      await controller.submit('Perform delivery');
    } finally {
      clearInterval(timer);
    }
    assert.ok(
      controller
        .getSnapshot()
        .transcript.some(
          (block) => block.kind === 'notice' && block.text.includes('契约检查已满足')
        )
    );
    await runtime.execute('/task clear', new AbortController().signal);
    assert.equal(await engine.inspectTaskDelivery(), undefined);
    controller.requestExit('test-completed');
  }
);

test('request output cap matches reserve and additive request breakdown', async (t) => {
  for (const [window, expected] of [
    [16384, 4096],
    [200000, 8192]
  ]) {
    const fixture = await runFixture(t, { calls: [], window, track: false });
    const request = fixture.provider.requests[0];
    const budget = fixture.engine.getStatus().context.lastRequest;
    assert.equal(request.maxOutputTokens, expected);
    assert.equal(budget.reservedOutputTokens, expected);
    const started = fixture.events.find(({ type }) => type === 'provider_request_started');
    assert.deepEqual(started.budget, budget);
    assert.equal(
      Object.values(budget.segments).reduce((a, b) => a + b, 0),
      budget.estimatedInputTokens
    );
    assert.equal(
      Object.values(budget.breakdown).reduce((a, b) => a + b, 0),
      budget.estimatedInputTokens
    );
  }
});

test('an output-limited final response never marks the contract satisfied', async (t) => {
  const fixture = await runFixture(t, { finishReason: 'length' });
  assert.equal(fixture.result.status, 'completed');
  assert.equal(fixture.snapshot.outcome, 'incomplete');
  assert.equal(fixture.snapshot.satisfied, false);
  assert.equal(fixture.snapshot.items[3].state, 'checked');
});

test('equivalent workspace absolute paths match the explicit relative contract', async (t) => {
  const { root } = await workspace(t);
  const provider = scriptedProvider([{ name: 'Read', input: { path: join(root, 'spec.md') } }]);
  const engine = new QueryEngine({
    provider,
    workspaceRoot: root,
    audit: false,
    tools: createToolSet()
  });
  await engine.startTaskDelivery('task.json');
  await consumeAgentTurn(engine.runTurn('read the spec'), () => {});
  assert.equal((await engine.inspectTaskDelivery()).items[0].state, 'read');
});

test('observed protection changes before an operation remain visible after restore', async (t) => {
  const { root, contract } = await workspace(t);
  const delivery = await TaskDelivery.create(root, contract);
  await writeFile(join(root, 'raw.txt'), 'external change');
  await delivery.beforeTool('restore', 'Write');
  await writeFile(join(root, 'raw.txt'), 'alpha\n\nbeta\n');
  await delivery.observe({
    toolCallId: 'restore',
    tool: 'Write',
    input: { path: 'raw.txt' },
    outcome: 'success'
  });
  assert.equal((await delivery.finish('completed')).protection, 'changed');
});

test('a success exit without the required output marker is unknown', async (t) => {
  const { root } = await workspace(t);
  const delivery = await TaskDelivery.create(root, {
    schemaVersion: 1,
    title: 'Check',
    requirements: [
      {
        id: 'check',
        label: 'Check',
        kind: 'check',
        command: 'node check.mjs',
        paths: ['importer.mjs'],
        outputContains: ['TEST_OK']
      }
    ]
  });
  await delivery.beforeTool('check', 'Shell');
  await delivery.observe({
    toolCallId: 'check',
    tool: 'Shell',
    input: { command: 'node check.mjs' },
    outcome: 'success',
    result: 'zero tests ran',
    metadata: { completionReason: 'exited', exitCode: 0 }
  });
  assert.equal((await delivery.finish('completed')).items[0].state, 'unknown');
});

test('downstream context truncation invalidates a previously complete receipt', async (t) => {
  const { root, contract } = await workspace(t);
  const delivery = await TaskDelivery.create(root, contract);
  await delivery.beforeTool('check', 'Shell');
  await delivery.observe({
    toolCallId: 'check',
    tool: 'Shell',
    input: { command: contract.requirements[3].command },
    outcome: 'success',
    result: 'IMPORTER_TEST_OK',
    metadata: { completionReason: 'exited', exitCode: 0 }
  });
  // This scope is missing importer.test.mjs, so create a separate valid check before truncating it.
  const single = await TaskDelivery.create(root, {
    schemaVersion: 1,
    title: 'Single check',
    requirements: [
      {
        id: 'check',
        label: 'Check',
        kind: 'check',
        command: 'node check.mjs',
        paths: ['importer.mjs']
      }
    ]
  });
  await single.beforeTool('valid', 'Shell');
  await single.observe({
    toolCallId: 'valid',
    tool: 'Shell',
    input: { command: 'node check.mjs' },
    outcome: 'success',
    metadata: { completionReason: 'exited', exitCode: 0 }
  });
  assert.equal(single.snapshot().items[0].state, 'checked');
  single.markTruncated('valid');
  assert.equal((await single.finish('completed')).items[0].state, 'unknown');
});

test('budget snapshots cannot mutate the engine through nested values', async (t) => {
  const fixture = await runFixture(t, { calls: [], track: false });
  const budget = fixture.engine.getStatus().context.lastRequest;
  budget.breakdown.system = 0;
  budget.segments.systemRules = 0;
  assert.ok(fixture.engine.getStatus().context.lastRequest.breakdown.system > 0);
  assert.ok(fixture.engine.getStatus().context.lastRequest.segments.systemRules > 0);
});

test('consumer close after a started tool keeps the partial record non-complete', async (t) => {
  const { root } = await workspace(t);
  const provider = scriptedProvider([
    { name: 'Shell', input: { command: 'node importer.test.mjs' } }
  ]);
  const engine = new QueryEngine({
    provider,
    workspaceRoot: root,
    audit: false,
    tools: createToolSet()
  });
  await engine.startTaskDelivery('task.json');
  const turn = engine.runTurn('run the check', { requestApproval: async () => 'allow-once' });
  while (true) {
    const next = await turn.next();
    if (next.done || next.value.type === 'tool_started') break;
  }
  await turn.return();
  const snapshot = await engine.inspectTaskDelivery();
  assert.equal(snapshot.outcome, 'cancelled');
  assert.equal(snapshot.satisfied, false);
});

test('session export preserves bounded delivery contracts and clear resets the record', async (t) => {
  const fixture = await runFixture(t);
  const state = fixture.engine.exportState();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.taskDelivery.contract.title, 'Importer delivery');
  fixture.engine.clearMessages();
  assert.equal(fixture.engine.getStatus().delivery, undefined);
  fixture.engine.restoreState(state);
  assert.equal(fixture.engine.getStatus().delivery.satisfied, false);
  assert.equal((await fixture.engine.inspectTaskDelivery()).satisfied, true);
});

test('matching a successful Shell artifact requires a real file change, not preexisting text', async (t) => {
  const { root } = await workspace(t);
  const delivery = await TaskDelivery.create(root, {
    schemaVersion: 1,
    title: 'Artifact',
    requirements: [{ id: 'artifact', label: 'Generate', kind: 'artifact', path: 'spec.md' }]
  });
  await delivery.beforeTool('shell', 'Shell');
  await delivery.observe({
    toolCallId: 'shell',
    tool: 'Shell',
    input: { command: 'node -v' },
    outcome: 'success',
    metadata: { completionReason: 'exited', exitCode: 0 }
  });
  assert.equal((await delivery.finish('completed')).items[0].state, 'planned');
});

test('truncated tool output cannot prove a successful check in the engine', async (t) => {
  const shell = {
    name: 'Shell',
    description: 'Check fixture',
    risk: 'execute',
    approval: 'always',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => ({
      content: 'x'.repeat(5000),
      metadata: { completionReason: 'exited', exitCode: 0 }
    })
  };
  const fixture = await runFixture(t, {
    calls: calls().slice(0, 4),
    tools: [...createToolSet().filter(({ name }) => name === 'Read' || name === 'Write'), shell],
    context: { maxToolResultBytes: 512 }
  });
  assert.equal(fixture.snapshot.items[3].state, 'unknown');
  assert.equal(fixture.snapshot.satisfied, false);
});
