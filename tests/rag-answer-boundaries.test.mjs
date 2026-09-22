import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { QueryEngine } from '../dist/engine.js';
import { RagRuntime } from '../dist/rag/runtime.js';
import { RagStore } from '../dist/rag/store.js';
import {
  createProviderRagVerifier,
  createProviderRagAnswerRepairer,
  isPureRagAbstention
} from '../dist/rag/verifier.js';

const signal = () => new AbortController().signal;
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-rag-boundaries-'));
  const workspace = join(root, 'workspace');
  try {
    await mkdir(workspace);
    await writeFile(
      join(workspace, 'docs.md'),
      '# Evidence\nUse TestClient in a with statement.\n'
    );
    const rag = new RagRuntime({
      workspaceRoot: workspace,
      store: new RagStore(join(root, 'index')),
      config: { enabled: true, autoRetrieve: 'off', autoRefresh: false }
    });
    await rag.index({ signal: signal() });
    const [hit] = await rag.search({ query: 'TestClient', signal: signal() });
    await run({ rag, workspace, hit });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const info = () => ({
  name: 'Mock',
  type: 'mock',
  model: 'mock',
  capabilities: { streaming: false, reasoningToggle: false }
});
const reply = (content) => ({ message: { role: 'assistant', content }, finishReason: 'stop' });
const call = (name, input, id) => ({
  message: { role: 'assistant', content: '', toolCalls: [{ name, input, id }] },
  finishReason: 'tool_calls'
});

test('pure abstention is an exact allowlist, not a substring heuristic', () => {
  assert.equal(isPureRagAbstention('证据不足。'), true);
  assert.equal(isPureRagAbstention(' Evidence is insufficient.\n'), true);
  for (const text of [
    '证据不足。但价格是10元。',
    'Evidence is insufficient. Use app.start().',
    '证据不足。 [[rag:1234567890abcdef]]',
    '```证据不足。```'
  ])
    assert.equal(isPureRagAbstention(text), false);
});

test('citation validation counts malformed and truncated tokens beside a valid citation', async () => {
  await fixture(async ({ rag, hit }) => {
    await rag.readChunks([hit.chunkId], 'turn', signal());
    for (const suffix of ['[[rag:1234', '[[rag:xyz]]', '[[rag:1234567890abcdef]']) {
      const checks = await rag.validateCitations(
        `[[rag:${hit.chunkId}]] ${suffix}`,
        'turn',
        signal()
      );
      assert.equal(checks.length, 2);
      assert.equal(checks[0].status, 'valid');
      assert.notEqual(checks[1].status, 'valid');
    }
  });
});

test('verification cache is draft-specific and question state is bounded and cleared', async () => {
  await fixture(async ({ rag, hit }) => {
    await rag.readChunks([hit.chunkId], 'turn', signal());
    const observed = [];
    rag.setSemanticVerifier(async ({ question, chunks }) => {
      observed.push(question);
      return [{ claim: '__overall__', outcome: 'supported', citations: [chunks[0].id] }];
    });
    rag.setTurnQuestion('turn', 'Q'.repeat(9000));
    const draft = `Use with. [[rag:${hit.chunkId}]]`;
    await rag.verify(draft, 'turn', signal());
    assert.equal(observed[0].length, 8192);
    assert.equal(rag.getTurnVerification('turn', draft).outcome, 'supported');
    assert.equal(rag.getTurnVerification('turn', `${draft} Invented.`), undefined);
    rag.clearTurn('turn');
    assert.equal(rag.getTurnVerification('turn', draft), undefined);
    await rag.readChunks([hit.chunkId], 'turn', signal());
    await rag.verify(draft, 'turn', signal());
    assert.equal(observed[1], undefined);
  });
});

test('isolated verifier sees the actual question but events never contain it', async () => {
  let request;
  const provider = {
    getInfo: info,
    fork() {
      return this;
    },
    async chat(value) {
      request = value;
      return reply('{"claims":[{"claim":"__overall__","outcome":"partial","citations":[]}]}');
    }
  };
  const events = [];
  await createProviderRagVerifier(provider)({
    question: 'PRIVATE_QUESTION',
    draft: 'PRIVATE_DRAFT',
    chunks: [],
    signal: signal(),
    emitEvent: (e) => events.push(e)
  });
  assert.match(request.messages[0].content, /<question>\nPRIVATE_QUESTION/);
  assert.match(request.systemPrompt, /unrelated definition is partial/);
  assert.deepEqual(request.tools, []);
  assert.equal(request.stopSequences, undefined);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('repair rejects token-limited and oversized responses rather than accepting truncated conclusions', async () => {
  let response = { ...reply('证据不足。'), finishReason: 'length' };
  const provider = {
    getInfo: info,
    fork() {
      return this;
    },
    async chat() {
      return response;
    }
  };
  const repair = createProviderRagAnswerRepairer(provider);
  const args = { question: 'q', chunks: [], signal: signal() };
  await assert.rejects(repair(args), /truncated/);
  response = reply('x'.repeat(4097));
  await assert.rejects(repair(args), /response limit/);
  response = reply('证据不足。');
  assert.equal(await repair(args), '证据不足。');
});

test('a pure refusal after reading evidence is returned without pretending semantic support; added facts are still blocked', async () => {
  await fixture(async ({ rag, workspace, hit }) => {
    let verifications = 0;
    rag.setSemanticVerifier(async () => {
      verifications++;
      return [{ claim: '__overall__', outcome: 'unsupported', citations: [] }];
    });
    for (const answer of ['证据不足。', '证据不足。但价格为10元。']) {
      let round = 0;
      const provider = {
        getInfo: info,
        async chat() {
          return ++round === 1
            ? call('RagSearch', { query: 'TestClient' }, 's')
            : round === 2
              ? call('RagRead', { chunkIds: [hit.chunkId] }, 'r')
              : reply(answer);
        }
      };
      const engine = new QueryEngine({
        provider,
        rag,
        workspaceRoot: workspace,
        mode: 'ask',
        audit: false
      });
      try {
        const result = await engine.chat('What is the price?');
        if (isPureRagAbstention(answer)) {
          assert.equal(result, answer);
          assert.equal(verifications, 0);
        } else {
          assert.match(result, /grounding blocked/);
          assert.ok(verifications > 0);
        }
      } finally {
        await engine.close();
      }
    }
  });
});

test('RagVerify on an early draft cannot approve a different final answer', async () => {
  await fixture(async ({ rag, workspace, hit }) => {
    const drafts = [];
    rag.setSemanticVerifier(async ({ draft }) => {
      drafts.push(draft);
      return [
        {
          claim: '__overall__',
          outcome: draft.includes('INVENTED') ? 'unsupported' : 'supported',
          citations: [hit.chunkId]
        }
      ];
    });
    let round = 0;
    const original = `Use with. [[rag:${hit.chunkId}]]`;
    const provider = {
      getInfo: info,
      async chat() {
        round++;
        return round === 1
          ? call('RagSearch', { query: 'TestClient' }, 's')
          : round === 2
            ? call('RagRead', { chunkIds: [hit.chunkId] }, 'r')
            : round === 3
              ? call('RagVerify', { draft: original }, 'v')
              : reply(`${original} INVENTED`);
      }
    };
    const engine = new QueryEngine({
      provider,
      rag,
      workspaceRoot: workspace,
      mode: 'ask',
      audit: false
    });
    try {
      assert.match(await engine.chat('Explain with'), /grounding blocked/);
      assert.equal(drafts.length, 2);
      assert.match(drafts[1], /INVENTED/);
    } finally {
      await engine.close();
    }
  });
});

test('supported snippets extracted from a rejected draft must pass a fresh whole-answer verification', async () => {
  await fixture(async ({ rag, workspace, hit }) => {
    let verifications = 0;
    rag.setSemanticVerifier(async () => {
      verifications++;
      return [
        { claim: '__overall__', outcome: 'partial', citations: [hit.chunkId] },
        { claim: 'Use with.', outcome: 'supported', citations: [hit.chunkId] }
      ];
    });
    let round = 0;
    const provider = {
      getInfo: info,
      async chat() {
        return ++round === 1
          ? call('RagSearch', { query: 'TestClient' }, 's')
          : round === 2
            ? call('RagRead', { chunkIds: [hit.chunkId] }, 'r')
            : reply(`Use with. Missing other requested fact. [[rag:${hit.chunkId}]]`);
      }
    };
    const engine = new QueryEngine({
      provider,
      rag,
      workspaceRoot: workspace,
      mode: 'ask',
      audit: false
    });
    try {
      assert.match(await engine.chat('Explain both facts'), /grounding blocked/);
      assert.equal(verifications, 2);
    } finally {
      await engine.close();
    }
  });
});
