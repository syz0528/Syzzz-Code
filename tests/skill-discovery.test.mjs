import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TaskCompositionRuntime } from '../dist/composition/runtime.js';
import {
  SkillDiscoveryIndex,
  skillDiscoveryInputSchema,
  formatSkillDiscovery
} from '../dist/composition/skill-discovery.js';
import { QueryEngine } from '../dist/engine.js';
import { consumeAgentTurn, serializeAgentEvent } from '../dist/cli-renderer.js';
import { toAuditRecord } from '../dist/audit.js';
import { createInteractiveCommandRuntime } from '../dist/interactive.js';
import { validateConfig } from '../dist/config.js';

const signal = () => new AbortController().signal;
const skillsConfig = { enabled: true, allowImplicit: true, disabled: [] };
async function fixture(t, count = 0) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(home);
  const createSkill = async (
    name,
    description = 'Generic local workflow',
    body = 'BODY_NOT_METADATA',
    metadata,
    project = false
  ) => {
    const directory = join(project ? workspace : home, '.agents', 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`
    );
    if (metadata) {
      await mkdir(join(directory, 'agents'));
      await writeFile(join(directory, 'agents', 'openai.yaml'), metadata);
    }
    return directory;
  };
  for (let index = 0; index < count; index++)
    await createSkill(
      `workflow-${String(index).padStart(3, '0')}`,
      `Local independent workflow number ${index}`
    );
  const runtime = async (extra = {}) =>
    TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: { ...skillsConfig },
      ...extra
    });
  return { root, workspace, home, createSkill, runtime };
}
function tools(runtime) {
  return new Map(runtime.getTools().map((tool) => [tool.name, tool]));
}
async function discover(runtime, input = {}) {
  return tools(runtime).get('DiscoverSkills').execute(input, { signal: signal() });
}
function page(result) {
  return JSON.parse(result.content.split('\n')[2]);
}
function provider(sequence = []) {
  const requests = [];
  return {
    requests,
    getInfo: () => ({
      name: 'offline',
      type: 'test',
      model: 'offline',
      contextWindowTokens: 16384,
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
              toolCalls: [{ id: `call-${requests.length}`, ...call }]
            }
          : { role: 'assistant', content: 'Done' },
        finishReason: 'stop'
      };
    }
  };
}
test('discovery convergence is advisory, per turn, and ignores manual browsing', async (t) => {
  const { runtime } = await fixture(t, 12);
  const instance = await runtime();
  instance.beginTurn();
  await instance.discoverSkills({ query: 'workflow' }, signal());
  const first = await discover(instance, { query: 'workflow' });
  assert.equal(first.metadata.discoveryCalls, 1);
  assert.equal(first.metadata.repeatedRequest, false);
  const again = await discover(instance, { query: ' WORKFLOW ', offset: 0, limit: 8 });
  assert.equal(again.metadata.repeatedRequest, true);
  assert.match(again.content, /Repeated unchanged discovery/);
  assert.deepEqual(page(first), page(again));
  const next = await discover(instance, { offset: 8, revision: page(first).revision });
  assert.equal(next.metadata.repeatedRequest, false);
  assert.equal(page(next).candidates.length, 4);
  assert.match(next.content, /preserve budget/);
  assert.equal(instance.getStatus().skills.activeThisTurn, 0);
  assert.equal(JSON.stringify(next.metadata).includes('WORKFLOW'), false);
  instance.beginTurn();
  assert.equal((await discover(instance, { query: 'workflow' })).metadata.discoveryCalls, 1);
});

test('active workflow discourages redundant discovery without blocking missing capabilities', async (t) => {
  const { runtime } = await fixture(t, 12);
  const instance = await runtime();
  instance.beginTurn();
  await tools(instance)
    .get('ActivateSkill')
    .execute({ name: 'workflow-000' }, { signal: signal() });
  const result = await discover(instance, { query: 'workflow-011' });
  assert.match(result.content, /A workflow is already active/);
  assert.equal(page(result).candidates[0].name, 'workflow-011');
  assert.deepEqual(instance.getStatus().skills.activeNames, ['workflow-000']);
});
async function turn(engine, message = 'Find a suitable workflow') {
  const events = [];
  const result = await consumeAgentTurn(engine.runTurn(message), (event) => events.push(event));
  return { events, result };
}

test('hundred-level directory uses bounded progressive metadata and reaches omitted exact names', async (t) => {
  const { runtime } = await fixture(t, 125);
  const instance = await runtime();
  const prelude = await instance.getPreludeMessages({
    signal: signal(),
    contextWindowTokens: 1000
  });
  assert.equal(instance.getStatus().skills.catalogMode, 'progressive');
  assert.ok(instance.getStatus().skills.catalogCharacters <= 80);
  assert.ok(instance.getStatus().skills.catalogOmitted > 0);
  assert.doesNotMatch(
    prelude.map(({ content }) => content).join(''),
    /BODY_NOT_METADATA|workflow-124/u
  );
  const found = page(await discover(instance, { query: '$workflow-124' }));
  assert.equal(found.candidates[0].name, 'workflow-124');
  assert.equal(found.candidates[0].matchedBy, 'name');
  assert.equal(instance.getStatus().skills.activeThisTurn, 0);
});

test('all eligible names can be paged without gaps, duplicates, or body loading', async (t) => {
  const { runtime } = await fixture(t, 125);
  const instance = await runtime();
  const names = [];
  let offset = 0;
  let revision;
  do {
    const result = page(await discover(instance, { offset, revision }));
    assert.ok(result.candidates.length <= 8);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
    assert.doesNotMatch(JSON.stringify(result), /BODY_NOT_METADATA/u);
    names.push(...result.candidates.map(({ name }) => name));
    revision = result.revision;
    offset = result.nextOffset;
  } while (offset !== undefined);
  assert.equal(names.length, 125);
  assert.equal(new Set(names).size, 125);
});

test('English and Chinese aliases, display metadata, and resource names are searchable', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  const root = await createSkill(
    'systematic-debugging',
    'Troubleshoot reproducible failures',
    undefined,
    'interface:\n  display_name: "故障诊断"\n  short_description: "分析故障"\n'
  );
  await mkdir(join(root, 'references'));
  await writeFile(join(root, 'references', 'trace-matrix.md'), 'RESOURCE_BODY_NEVER_RETURNED');
  const instance = await runtime();
  for (const query of ['调试', '排障', 'troubleshoot', '故障诊断', 'trace-matrix']) {
    const found = page(await discover(instance, { query }));
    assert.equal(found.candidates[0].name, 'systematic-debugging', query);
    assert.ok(found.candidates[0].categories.includes('debugging'));
    assert.doesNotMatch(JSON.stringify(found), /RESOURCE_BODY_NEVER_RETURNED/u);
  }
  assert.equal(page(await discover(instance, { category: 'documentation' })).matched, 0);
});

test('planning word forms classify generic workflows consistently with exact search', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  await createSkill('implementation-plans', 'Use given requirements for a multi-step task');
  await createSkill('release-workflow', 'Build planned releases');
  const instance = await runtime();
  for (const name of ['implementation-plans', 'release-workflow']) {
    const result = page(await discover(instance, { query: name, category: 'planning' }));
    assert.equal(result.candidates[0].name, name);
    assert.ok(result.candidates[0].categories.includes('planning'));
  }
  const overview = page(await discover(instance)).categories;
  assert.equal(overview.filter((c) => c.name === 'planning').length, 1);
});

test('category membership does not expand planning into interview or other domain intents', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  await createSkill('implementation-plans', 'Use given requirements for a multi-step task');
  await createSkill('grilling', 'Interview users and ask questions to clarify their needs');
  await createSkill('sql-pro', 'Optimize SQL database query performance');
  await createSkill('cloud-designer', 'Design cloud infrastructure');
  const instance = await runtime();
  for (const query of ['计划', 'planning', 'plans', '编写客户端交接计划']) {
    const result = page(await discover(instance, { query }));
    assert.equal(result.candidates[0].name, 'implementation-plans', query);
    assert.ok(!result.candidates.some((c) => c.name === 'grilling'), query);
  }
  assert.equal(page(await discover(instance, { query: '访谈' })).candidates[0].name, 'grilling');
  assert.equal(page(await discover(instance, { query: 'sql' })).candidates[0].name, 'sql-pro');
  assert.equal(page(await discover(instance, { query: 'sql', category: 'planning' })).matched, 0);
});

test('framework and delivery aliases do not substitute unrelated peers in the same category', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  await createSkill('react-workflow', 'Build React components');
  await createSkill('css-workflow', 'Apply CSS styles');
  await createSkill('docker-workflow', 'Manage Docker containers');
  await createSkill('release-workflow', 'Manage releases');
  const instance = await runtime();
  for (const [query, expected] of [
    ['react', 'react-workflow'],
    ['docker', 'docker-workflow']
  ]) {
    const result = page(await discover(instance, { query }));
    assert.deepEqual(
      result.candidates.map((c) => c.name),
      [expected]
    );
  }
});

test('each discovery returns a bounded receipt including both calls in a batch without query text', async (t) => {
  const { runtime } = await fixture(t, 12);
  const instance = await runtime();
  const query = 'workflow USER_QUERY_PRIVATE';
  const first = await discover(instance, { query, limit: 2 });
  const second = await discover(instance, { query, offset: 2, limit: 2 });
  const a = first.metadata.discoveryReceipt;
  const b = second.metadata.discoveryReceipt;
  assert.deepEqual(
    a.candidates.map((c) => c.name),
    page(first).candidates.map((c) => c.name)
  );
  assert.deepEqual(
    b.candidates.map((c) => c.rank),
    [3, 4]
  );
  assert.notEqual(a.requestHash, b.requestHash);
  assert.equal(a.guidanceReason, 'candidate-fit');
  assert.equal(a.revision, page(first).revision);
  assert.ok(Buffer.byteLength(JSON.stringify(a)) < 8 * 1024);
  assert.doesNotMatch(
    JSON.stringify([a, b]),
    /USER_QUERY_PRIVATE|BODY_NOT_METADATA|description|skillFilePath/u
  );
  first.metadata.discoveryReceipt.candidates[0].categories.push('invented');
  assert.ok(
    !(
      await discover(instance, { query })
    ).metadata.discoveryReceipt.candidates[0].categories.includes('invented')
  );
  const audited = toAuditRecord({
    schemaVersion: 1,
    type: 'tool_completed',
    toolCallId: 'receipt-test',
    toolName: 'DiscoverSkills',
    outcome: 'success',
    durationMs: 1,
    metadata: first.metadata
  });
  assert.doesNotMatch(JSON.stringify(audited), /workflow|requestHash|discoveryReceipt/u);
});

test('discovery receipt records hint type and active workflows without imposing a hard stop', async (t) => {
  const { runtime } = await fixture(t, 12);
  const instance = await runtime();
  await discover(instance, { query: 'workflow' });
  const repeated = await discover(instance, { query: 'workflow' });
  assert.equal(repeated.metadata.discoveryReceipt.guidanceReason, 'repeated-request');
  const third = await discover(instance, { query: 'workflow-003' });
  assert.equal(third.metadata.discoveryReceipt.guidanceReason, 'budget-reminder');
  await tools(instance)
    .get('ActivateSkill')
    .execute({ name: 'workflow-003' }, { signal: signal() });
  const extra = await discover(instance, { query: 'workflow-004' });
  assert.equal(extra.metadata.discoveryReceipt.guidanceReason, 'active-workflow');
  assert.deepEqual(extra.metadata.discoveryReceipt.activeNames, ['workflow-003']);
  assert.equal(page(extra).candidates[0].name, 'workflow-004');
  instance.beginTurn();
  assert.deepEqual((await discover(instance)).metadata.discoveryReceipt.activeNames, []);
});

test('engine emits a receipt for every discovery in one provider response, not just last status', async (t) => {
  const { workspace, runtime } = await fixture(t, 12);
  const composition = await runtime();
  const backend = provider();
  backend.chat = async (request) => {
    backend.requests.push(request);
    return {
      message:
        backend.requests.length === 1
          ? {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'first', name: 'DiscoverSkills', input: { query: 'workflow-003' } },
                { id: 'second', name: 'DiscoverSkills', input: { query: 'workflow-009' } }
              ]
            }
          : { role: 'assistant', content: 'Done' },
      finishReason: 'stop'
    };
  };
  const engine = new QueryEngine({
    composition,
    provider: backend,
    workspaceRoot: workspace,
    audit: false,
    tools: composition.getTools()
  });
  const { events } = await turn(engine);
  const receipts = events.filter(
    (e) => e.type === 'tool_completed' && e.toolName === 'DiscoverSkills'
  );
  assert.deepEqual(
    receipts.map((e) => e.toolCallId),
    ['first', 'second']
  );
  assert.deepEqual(
    receipts.map((e) => e.metadata.discoveryReceipt.candidates[0].name),
    ['workflow-003', 'workflow-009']
  );
  assert.equal(composition.getStatus().skills.lastDiscovery.names[0], 'workflow-009');
  assert.ok(receipts.every((e) => !serializeAgentEvent(e).includes('discoveryReceipt')));
  assert.ok(receipts.every((e) => !serializeAgentEvent(e).includes('workflow-')));
});

test('disabled, shadowed, allowlisted and explicit-only policies survive discovery', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  await createSkill('disabled-one');
  await createSkill(
    'explicit-one',
    'Manual only',
    undefined,
    'policy:\n  allow_implicit_invocation: false\n'
  );
  await createSkill('allowed-one');
  await createSkill('allowed-one', 'Project winner', undefined, undefined, true);
  const instance = await runtime({ skills: { ...skillsConfig, disabled: ['disabled-one'] } });
  assert.deepEqual(
    page(await discover(instance)).candidates.map(({ name }) => name),
    ['allowed-one']
  );
  const manual = await instance.discoverSkills({}, signal());
  assert.deepEqual(
    manual.candidates.map(({ name }) => name),
    ['allowed-one', 'explicit-one']
  );
  assert.equal(manual.candidates[1].invocation, 'explicit-only');
  assert.equal(manual.candidates[0].source, 'project');
  const limited = await runtime({ skillAllowlist: ['allowed-one'] });
  assert.deepEqual(
    (await limited.discoverSkills({}, signal())).candidates.map(({ name }) => name),
    ['allowed-one']
  );
  const noImplicit = await runtime({ skills: { ...skillsConfig, allowImplicit: false } });
  assert.equal(page(await discover(noImplicit)).eligible, 0);
  assert.equal((await noImplicit.discoverSkills({}, signal())).eligible, 3);
  assert.equal((await noImplicit.getPreludeMessages()).length, 0);
  const disabled = await runtime({ skills: { ...skillsConfig, enabled: false } });
  assert.equal((await disabled.discoverSkills({}, signal())).eligible, 0);
});

test('declared dependencies are bounded and never represented as installed or healthy', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  await createSkill(
    'dependency-one',
    'Review files',
    undefined,
    'dependencies:\n  tools:\n    - type: mcp\n      value: "server:missing/tool:review"\n'
  );
  const candidate = page(await discover(await runtime())).candidates[0];
  assert.equal(candidate.dependencyStatus, 'not-checked');
  assert.ok(candidate.declaredDependencies.length > 0);
});

test('reenabling a Skill cannot bypass the runtime allowlist', async (t) => {
  const { workspace, home, createSkill } = await fixture(t);
  await createSkill('allowed-one');
  await createSkill('outside-list');
  const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/composition/runtime.js')).href;
  const code = `import assert from 'node:assert/strict';
    import { TaskCompositionRuntime } from ${JSON.stringify(moduleUrl)};
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: ${JSON.stringify(workspace)}, homeDirectory: ${JSON.stringify(home)},
      skills: { enabled: true, allowImplicit: true, disabled: [] }, skillAllowlist: ['allowed-one']
    });
    runtime.setSkillEnabled('outside-list', true);
    const page = await runtime.discoverSkills({}, new AbortController().signal);
    assert.deepEqual(page.candidates.map(s => s.name), ['allowed-one']);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('directory mutation invalidates page revision and refreshes search without stale candidates', async (t) => {
  const { createSkill, runtime } = await fixture(t, 12);
  const instance = await runtime();
  const first = page(await discover(instance));
  await createSkill('new-target', 'Chinese regression testing');
  await assert.rejects(
    discover(instance, { offset: 8, revision: first.revision }),
    /directory changed/u
  );
  const refreshed = page(await discover(instance, { query: 'new-target' }));
  assert.equal(refreshed.candidates[0].name, 'new-target');
  assert.notEqual(refreshed.revision, first.revision);
  assert.equal(instance.getStatus().skills.lastDiscovery.names[0], 'new-target');
});

test('activation rechecks implicit policy changed after discovery', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  const directory = await createSkill('policy-change', 'Review source');
  const instance = await runtime();
  assert.equal(page(await discover(instance)).candidates[0].name, 'policy-change');
  await mkdir(join(directory, 'agents'));
  await writeFile(
    join(directory, 'agents', 'openai.yaml'),
    'policy:\n  allow_implicit_invocation: false\n'
  );
  const result = await tools(instance)
    .get('ActivateSkill')
    .execute({ name: 'policy-change' }, { signal: signal() });
  assert.equal(result.isError, true);
  assert.match(result.content, /Implicit Skill activation is disabled/u);
  assert.equal(instance.getStatus().skills.activeThisTurn, 0);
});

test('returned categories cannot mutate the cached index', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  await createSkill('test-workflow', 'Run regression tests');
  const instance = await runtime();
  const first = await instance.discoverSkills({}, signal());
  first.candidates[0].categories.push('invented');
  assert.ok(
    !(await instance.discoverSkills({}, signal())).candidates[0].categories.includes('invented')
  );
});

test('no lexical match is not described as absence and offset can enumerate the directory', async (t) => {
  const { runtime } = await fixture(t, 4);
  const instance = await runtime();
  const empty = page(await discover(instance, { query: 'unicornunlikelytoken' }));
  assert.equal(empty.matched, 0);
  assert.match(formatSkillDiscovery(empty, true), /不等于不存在/u);
  assert.match(formatSkillDiscovery(empty), /not proof of absence/u);
  assert.equal(page(await discover(instance, { offset: 2000 })).candidates.length, 0);
  assert.equal(page(await discover(instance)).matched, 4);
});

test('input bounds reject unsupported filters and oversized or invalid pagination', () => {
  for (const input of [
    { limit: 9 },
    { offset: -1 },
    { offset: 1.5 },
    { offset: 2001 },
    { query: 'x'.repeat(1001) },
    { category: 'unknown' },
    { revision: 'old' },
    { scope: 'user' },
    { load: true }
  ])
    assert.equal(
      skillDiscoveryInputSchema.safeParse(input).success,
      false,
      JSON.stringify(input).slice(0, 100)
    );
});

test('aborted discovery returns no result and project junction escapes remain undiscoverable', async (t) => {
  const { root, workspace, runtime } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(
    join(outside, 'SKILL.md'),
    '---\nname: escaped\ndescription: escaped secret\n---\nbody'
  );
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true });
  await symlink(
    outside,
    join(workspace, '.agents', 'skills', 'escaped'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const instance = await runtime();
  assert.equal((await instance.discoverSkills({}, signal())).eligible, 0);
  await assert.rejects(instance.discoverSkills({}, AbortSignal.abort()), /cancel|abort/iu);
});

for (const mode of ['ask', 'plan', 'code'])
  test(`discovery and real activation use the normal engine pipeline in ${mode}`, async (t) => {
    const { workspace, createSkill, runtime } = await fixture(t);
    await createSkill('chosen-workflow', 'Review source', 'ACTUAL_BODY_MARKER');
    const composition = await runtime();
    const backend = provider([
      { name: 'DiscoverSkills', input: { query: 'chosen-workflow' } },
      { name: 'ActivateSkill', input: { name: 'chosen-workflow' } }
    ]);
    const engine = new QueryEngine({
      composition,
      provider: backend,
      workspaceRoot: workspace,
      mode,
      audit: false,
      tools: composition.getTools()
    });
    const { events, result } = await turn(engine);
    assert.equal(result.status, 'completed');
    assert.equal(events.filter(({ type }) => type === 'skill_activated').length, 1);
    assert.ok(
      backend.requests[2].messages.some(
        ({ role, content }) => role === 'tool' && content.includes('ACTUAL_BODY_MARKER')
      )
    );
    assert.equal(composition.getStatus().skills.activeNames[0], 'chosen-workflow');
    assert.equal(
      events.some(({ type }) => type === 'approval_requested'),
      false
    );
    const wire = events.map(serializeAgentEvent).join('\n');
    assert.match(wire, /skill_activated/u);
    const audit = JSON.stringify(events.map(toAuditRecord));
    assert.doesNotMatch(audit, /ACTUAL_BODY_MARKER|Find a suitable workflow|Review source/u);
  });

test('explicit user request bypasses discovery without changing existing activation rules', async (t) => {
  const { workspace, createSkill, runtime } = await fixture(t);
  await createSkill(
    'manual-workflow',
    'Explicit workflow',
    'EXPLICIT_BODY',
    'policy:\n  allow_implicit_invocation: false\n'
  );
  const composition = await runtime();
  const backend = provider();
  const engine = new QueryEngine({
    composition,
    provider: backend,
    workspaceRoot: workspace,
    audit: false,
    tools: composition.getTools()
  });
  const { events } = await turn(engine, '$manual-workflow review it');
  assert.equal(backend.requests.length, 1);
  assert.ok(
    events.some(({ type, activation }) => type === 'skill_activated' && activation === 'explicit')
  );
  assert.equal(
    events.some(({ toolName }) => toolName === 'DiscoverSkills'),
    false
  );
  assert.match(backend.requests[0].messages.at(-1).content, /EXPLICIT_BODY/u);
});

test('small talk adds neither discovery nor extra provider calls', async (t) => {
  const { workspace, runtime } = await fixture(t, 40);
  const composition = await runtime();
  const backend = provider();
  const engine = new QueryEngine({
    composition,
    provider: backend,
    workspaceRoot: workspace,
    audit: false,
    tools: composition.getTools()
  });
  const { events } = await turn(engine, 'Hello');
  assert.equal(backend.requests.length, 1);
  assert.equal(
    events.some(({ type }) => type === 'tool_started'),
    false
  );
});

test('a Hook denial blocks discovery execution and cannot be bypassed by full access', async (t) => {
  const { workspace, runtime } = await fixture(t, 3);
  const composition = await runtime();
  const hooks = {
    async *run(invocation) {
      return invocation.event === 'PreToolUse'
        ? { decision: 'deny', reason: 'Denied discovery' }
        : { decision: 'continue' };
    }
  };
  const backend = provider([{ name: 'DiscoverSkills', input: { query: 'workflow' } }]);
  const engine = new QueryEngine({
    composition,
    provider: backend,
    workspaceRoot: workspace,
    audit: false,
    tools: composition.getTools(),
    permissionMode: 'fullAccess',
    extensions: { hooks }
  });
  const { events } = await turn(engine);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool_completed' &&
        event.outcome === 'denied' &&
        event.metadata.reason === 'hook-policy'
    )
  );
  assert.equal(composition.getStatus().skills.lastDiscovery, undefined);
});

test('full and progressive modes have the same activatable set and a metadata-only difference', async (t) => {
  const { runtime } = await fixture(t, 125);
  const full = await runtime({ skills: { ...skillsConfig, catalogMode: 'full' } });
  const progressive = await runtime({ skills: { ...skillsConfig, catalogMode: 'progressive' } });
  const a = await full.getPreludeMessages({ contextWindowTokens: 512000 });
  const b = await progressive.getPreludeMessages({ contextWindowTokens: 512000 });
  assert.equal(full.getStatus().skills.catalogOmitted, 0);
  assert.equal(progressive.getStatus().skills.catalogMode, 'progressive');
  assert.ok(b[0].content.length < a[0].content.length);
  assert.deepEqual(
    page(await discover(full, { query: 'workflow-124' })),
    page(await discover(progressive, { query: 'workflow-124' }))
  );
  assert.equal(page(await discover(full)).candidates[0].activeThisTurn, false);
});

test('extreme metadata produces bounded complete JSON without ANSI or partial candidate data', async (t) => {
  const { createSkill, runtime } = await fixture(t);
  await createSkill('large-meta', '中文'.repeat(500));
  const instance = await runtime();
  const descriptors = instance.listSkills();
  descriptors[0].description = '中'.repeat(5000);
  descriptors[0].interface.displayName = '\x1b[31m' + '中'.repeat(200);
  const result = new SkillDiscoveryIndex(descriptors).search({}, new Set(), true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
  assert.equal(result.candidates[0].metadataTruncated, true);
  assert.doesNotMatch(JSON.stringify(result), /\x1b/u);
});

test('slash discovery stays local and reports candidates separately from activation', async (t) => {
  const { workspace, runtime } = await fixture(t, 12);
  const composition = await runtime();
  const backend = provider();
  const engine = new QueryEngine({
    composition,
    provider: backend,
    workspaceRoot: workspace,
    audit: false
  });
  const notices = [];
  const commands = createInteractiveCommandRuntime(
    engine,
    { uiLanguage: 'zh-CN' },
    { readLine: async () => ({ type: 'eof' }) },
    { notice: ({ text }) => notices.push(text) },
    false
  );
  const messagesBefore = engine.getMessages();
  await commands.execute('/skills discover workflow-011', signal());
  await commands.execute('/skills browse 8', signal());
  assert.match(notices.join('\n'), /本地发现|候选不代表已加载/u);
  assert.equal(backend.requests.length, 0);
  assert.equal(composition.getStatus().skills.activeThisTurn, 0);
  assert.deepEqual(engine.getMessages(), messagesBefore);
});

test('CLI discovery emits a bounded JSON page without contacting a provider', async (t) => {
  const { workspace, home, createSkill } = await fixture(t);
  await createSkill('cli-target', 'A local workflow', undefined, undefined, true);
  // The CLI cwd is the requested workspace, not the source repository.
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), 'dist/index.js'), 'skills', 'discover', 'cli-target', '--json'],
    { cwd: workspace, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).candidates[0].name, 'cli-target');
});

test('configuration accepts optional catalog mode and rejects invalid modes', () => {
  const config = {
    schemaVersion: 1,
    currentProvider: 'test',
    providers: {
      test: {
        name: 'test',
        type: 'openai-compatible',
        model: 'test',
        models: ['test'],
        env: { BASE_URL: 'https://example.com/v1', API_KEY: 'test' }
      }
    },
    skills: { ...skillsConfig, catalogMode: 'progressive' }
  };
  assert.equal(validateConfig(config).skills.catalogMode, 'progressive');
  for (const value of ['unbounded', ['auto'], {}, null, true]) {
    config.skills.catalogMode = value;
    assert.throws(() => validateConfig(config), /catalogMode/u);
  }
  delete config.skills.catalogMode;
  assert.equal(validateConfig(config).skills.catalogMode, undefined);
});
