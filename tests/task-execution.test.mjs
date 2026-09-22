import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskExecutionLedger, mentionedTaskFiles } from '../dist/task-execution.js';
import { QueryEngine } from '../dist/engine.js';
import { RagRuntime } from '../dist/rag/runtime.js';
import { RagStore } from '../dist/rag/store.js';

test('file mentions are bounded lexical hints, never intent or authority', () => {
  assert.deepEqual(mentionedTaskFiles('Check `src/test_lifespan.py`，do not read secrets.json。'), [
    'src/test_lifespan.py',
    'secrets.json'
  ]);
  assert.deepEqual(mentionedTaskFiles('Explain arrays and https://example.com/x.py'), []);
  assert.equal(
    mentionedTaskFiles(Array.from({ length: 10 }, (_, n) => `file${n}.py`).join(' ')).length,
    4
  );
  const ledger = new TaskExecutionLedger('Do not read secrets.json; query docs only.');
  assert.equal(ledger.instructions(), undefined);
  ledger.observe('RagSearch', {}, 'success');
  assert.match(ledger.instructions(), /NOT inferred obligations/);
  assert.match(ledger.instructions(), /original user request/);
  assert.equal(ledger.takeFinalizationReview(), true);
  assert.equal(ledger.takeFinalizationReview(), false);
});

test('execution facts preserve failed and denied reads instead of trusting model prose', () => {
  const ledger = new TaskExecutionLedger('Inspect target.py');
  ledger.observe('RagSearch', { query: 'untrusted secret' }, 'error');
  ledger.observe('Read', { path: 'other.py' }, 'success');
  assert.equal(ledger.takeFinalizationReview(), true);
  assert.doesNotMatch(ledger.instructions(), /untrusted secret/);
  for (const outcome of ['success', 'error', 'denied', 'cancelled']) {
    const item = new TaskExecutionLedger('Inspect target.py');
    item.observe('RagSearch', {}, 'success');
    item.observe('Read', { path: './target.py' }, outcome);
    assert.equal(item.takeFinalizationReview(), false);
    assert.match(item.instructions(), new RegExp(outcome));
  }
});

test('execution observations and file hints stay bounded', () => {
  const ledger = new TaskExecutionLedger('Inspect a.py');
  ledger.observe('RagRead', {}, 'success');
  for (let i = 0; i < 100; i++) ledger.observe('Read', { path: 'x'.repeat(1024) }, 'error');
  assert.ok(ledger.instructions().length < 7000);
  assert.match(ledger.instructions(), /returned range/);
});

test('ordinary messages with file mentions get no review before actual RAG activity', () => {
  const ledger = new TaskExecutionLedger('Explain the name test.PY. Do not read it.');
  assert.deepEqual(ledger.mentions, ['test.PY']);
  assert.equal(ledger.takeFinalizationReview(), false);
  ledger.observe('Read', { path: 'other.py' }, 'success');
  assert.equal(ledger.takeFinalizationReview(), false);
  ledger.observe('AutoRagRead', {}, 'success');
  assert.equal(ledger.takeFinalizationReview(), true);
});

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-task-execution-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'test_lifespan.py'), 'client = TestClient(app)\n');
  await writeFile(
    join(workspace, 'evidence.md'),
    '# Testing\nUse TestClient with a with statement for lifespan.\n'
  );
  const rag = new RagRuntime({
    workspaceRoot: workspace,
    config: { enabled: true, autoRetrieve: 'off', autoRefresh: false },
    store: new RagStore(join(root, 'rag'))
  });
  await rag.index({ signal: new AbortController().signal });
  try {
    await run({ workspace, rag });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const reply = (content) => ({ message: { role: 'assistant', content }, finishReason: 'stop' });
const call = (name, input, id) => ({
  message: { role: 'assistant', content: '', toolCalls: [{ name, input, id }] },
  finishReason: 'tool_calls'
});
const info = () => ({
  name: 'Mock',
  type: 'mock',
  model: 'mock',
  contextWindowTokens: 16384,
  capabilities: { streaming: false, reasoningToggle: false }
});
async function collect(engine, prompt, options) {
  const events = [];
  const turn = engine.runTurn(prompt, options);
  while (true) {
    const next = await turn.next();
    if (next.done) return { result: next.value, events };
    events.push(next.value);
  }
}

test('default runtime allows remaining work after RAG without enabling experimental review', async () => {
  await fixture(async ({ workspace, rag }) => {
    let calls = 0;
    const provider = {
      getInfo: info,
      async chat(request) {
        calls++;
        assert.doesNotMatch(
          request.systemPrompt,
          /Current-turn execution facts|One-time completion review/
        );
        const tools = request.messages.filter((m) => m.role === 'tool');
        if (!tools.length) return call('RagSearch', { query: 'TestClient lifespan' }, 's');
        if (tools.length === 1)
          return call('RagRead', { chunkIds: [/\b[a-f0-9]{32}\b/.exec(tools[0].content)[0]] }, 'r');
        assert.equal(request.maxOutputTokens, 512);
        assert.equal(request.stopSequences, undefined);
        assert.match(request.systemPrompt, /finish every requested authorized part/);
        assert.match(request.systemPrompt, /returned line range/);
        assert.doesNotMatch(request.systemPrompt, /two short sentences and stop/);
        return reply(
          `Use TestClient with a with statement ${/\[\[rag:[a-f0-9]{32}\]\]/.exec(tools[1].content)[0]}`
        );
      }
    };
    const engine = new QueryEngine({
      provider,
      workspaceRoot: workspace,
      rag,
      mode: 'ask',
      audit: false
    });
    try {
      const { result } = await collect(engine, 'Read docs then inspect test_lifespan.py');
      assert.equal(result.status, 'completed');
      assert.equal(calls, 3);
    } finally {
      await engine.close();
    }
  });
});

test('combined task gets one completion review, performs local Read and does not stream the discarded draft', async () => {
  await fixture(async ({ workspace, rag }) => {
    const requests = [];
    const provider = {
      getInfo: info,
      async chat(request) {
        requests.push(request);
        const tools = request.messages.filter((m) => m.role === 'tool');
        if (!tools.length) return call('RagSearch', { query: 'TestClient lifespan' }, 's');
        if (tools.length === 1)
          return call('RagRead', { chunkIds: [/\b[a-f0-9]{32}\b/.exec(tools[0].content)[0]] }, 'r');
        const token = /\[\[rag:[a-f0-9]{32}\]\]/.exec(tools[1].content)[0];
        if (!request.systemPrompt.includes('One-time completion review'))
          return reply(`PREMATURE ${token}`);
        if (tools.length === 2) return call('Read', { path: 'test_lifespan.py' }, 'local');
        return reply(`Use TestClient with a with statement ${token}`);
      }
    };
    const engine = new QueryEngine({
      experimentalTaskCompletionReview: true,
      provider,
      workspaceRoot: workspace,
      rag,
      mode: 'ask',
      audit: false,
      announceProvider: false
    });
    try {
      const { result, events } = await collect(
        engine,
        'Read the lifespan evidence then inspect test_lifespan.py; do not modify files.'
      );
      assert.equal(result.status, 'completed');
      assert.equal(requests.length, 5);
      assert.ok(
        events.some(
          (e) => e.type === 'tool_completed' && e.toolName === 'Read' && e.outcome === 'success'
        )
      );
      assert.ok(!events.some((e) => e.type === 'text_delta' && e.delta.includes('PREMATURE')));
      assert.doesNotMatch(result.response, /PREMATURE/);
      assert.equal(requests[2].maxOutputTokens, 512);
      assert.equal(requests[2].stopSequences, undefined);
      assert.doesNotMatch(requests[2].systemPrompt, /two short sentences and stop/);
      assert.ok(!requests[4].messages.some((m) => m.content.includes('PREMATURE')));
      assert.ok(
        !requests[4].messages.some(
          (m) => m.role === 'user' && m.content.includes('One-time completion review')
        )
      );
      assert.ok(requests.every((r) => !r.tools.some((t) => t.name === 'Shell')));
      const before = requests.length;
      provider.chat = async (request) => {
        requests.push(request);
        return reply('An array.');
      };
      await collect(engine, 'Explain arrays without tools.');
      assert.equal(requests.length, before + 1);
      assert.doesNotMatch(requests.at(-1).systemPrompt, /execution facts|completion review/);
    } finally {
      await engine.close();
    }
  });
});

test('a RAG scope failure does not stop requested local reading; missing files are reported without retry', async () => {
  await fixture(async ({ workspace, rag }) => {
    let calls = 0;
    const provider = {
      getInfo: info,
      async chat(request) {
        calls++;
        const tools = request.messages.filter((m) => m.role === 'tool');
        if (!tools.length)
          return call('RagSearch', { query: 'lifespan', collections: ['unmounted'] }, 's');
        if (!request.systemPrompt.includes('One-time completion review'))
          return reply('PREMATURE no documents');
        if (tools.length === 1) return call('Read', { path: 'missing.py' }, 'r');
        assert.equal(tools[1].isError, true);
        return reply('The collection is unavailable and the local file could not be read.');
      }
    };
    const engine = new QueryEngine({
      experimentalTaskCompletionReview: true,
      provider,
      workspaceRoot: workspace,
      rag,
      mode: 'ask',
      audit: false,
      announceProvider: false
    });
    try {
      const { result, events } = await collect(
        engine,
        'Query the collection then inspect missing.py'
      );
      assert.equal(result.status, 'completed');
      assert.equal(calls, 4);
      assert.equal(
        events.filter((e) => e.type === 'tool_completed' && e.toolName === 'Read').length,
        1
      );
    } finally {
      await engine.close();
    }
  });
});

test('one-time review respects a prohibition and never executes tools by itself', async () => {
  await fixture(async ({ workspace, rag }) => {
    let calls = 0;
    const provider = {
      getInfo: info,
      async chat(request) {
        calls++;
        if (calls === 1) return call('RagSearch', { query: 'nothing-found' }, 's');
        assert.match(request.messages.find((m) => m.role === 'user').content, /Do not read/);
        return reply('No evidence. I did not read test_lifespan.py as instructed.');
      }
    };
    const engine = new QueryEngine({
      experimentalTaskCompletionReview: true,
      provider,
      workspaceRoot: workspace,
      rag,
      mode: 'ask',
      audit: false,
      announceProvider: false
    });
    try {
      const { result, events } = await collect(
        engine,
        'Search docs. Do not read test_lifespan.py.'
      );
      assert.equal(result.status, 'completed');
      assert.equal(calls, 3);
      assert.ok(!events.some((e) => e.type === 'tool_requested' && e.toolName === 'Read'));
    } finally {
      await engine.close();
    }
  });
});

test('completion review does not exceed Provider or tool-round budgets', async () => {
  for (const limits of [{ maxProviderCalls: 2 }, { maxToolRounds: 1 }])
    await fixture(async ({ workspace, rag }) => {
      let calls = 0;
      const provider = {
        getInfo: info,
        async chat() {
          calls++;
          return calls === 1
            ? call('RagSearch', { query: 'nothing-found' }, 's')
            : reply('Insufficient evidence; local file not inspected.');
        }
      };
      const engine = new QueryEngine({
        experimentalTaskCompletionReview: true,
        provider,
        workspaceRoot: workspace,
        rag,
        mode: 'ask',
        audit: false,
        announceProvider: false,
        ...limits
      });
      try {
        const { result } = await collect(engine, 'Search then inspect test_lifespan.py');
        assert.equal(result.status, 'completed');
        assert.equal(calls, 2);
      } finally {
        await engine.close();
      }
    });
});

test('cancelling during completion review ends the turn without local execution', async () => {
  await fixture(async ({ workspace, rag }) => {
    const controller = new AbortController();
    let calls = 0;
    const provider = {
      getInfo: info,
      async chat(request) {
        calls++;
        if (calls === 1) return call('RagSearch', { query: 'nothing-found' }, 's');
        if (request.systemPrompt.includes('One-time completion review')) controller.abort();
        return reply('No evidence.');
      }
    };
    const engine = new QueryEngine({
      experimentalTaskCompletionReview: true,
      provider,
      workspaceRoot: workspace,
      rag,
      mode: 'ask',
      audit: false,
      announceProvider: false
    });
    try {
      const { result, events } = await collect(engine, 'Search then inspect test_lifespan.py', {
        signal: controller.signal
      });
      assert.equal(result.status, 'cancelled');
      assert.ok(!events.some((e) => e.type === 'tool_requested' && e.toolName === 'Read'));
    } finally {
      await engine.close();
    }
  });
});
