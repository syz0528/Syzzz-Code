import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCases, fixtureFiles } from '../scripts/decision-eval-cases.mjs';
import { reviewRun } from '../scripts/decision-eval-review.mjs';
import {
  assess,
  canPrefetch,
  compareDecision,
  decisionState,
  percentile,
  ruleDecision,
  validateDecision
} from '../scripts/decision-eval-lib.mjs';

test('decision dataset keeps topic families disjoint and counts 40/80 target cases', () => {
  const dev = buildCases('dev'),
    frozen = buildCases('test');
  assert.equal(dev.length, 40);
  assert.equal(frozen.length, 80);
  assert.equal(new Set([...dev, ...frozen].map((item) => item.id)).size, 120);
  assert.ok(frozen.every((item) => !dev.some((other) => other.family === item.family)));
  for (const split of [dev, frozen]) {
    for (const item of split) {
      validateDecision(item.expected);
      assert.equal(typeof item.prompt, 'string');
      assert.ok(item.forbiddenTools.includes('Shell'));
    }
    assert.ok(split.some((item) => item.history && item.expected.clarify));
    assert.ok(split.some((item) => item.history && !item.expected.clarify));
    assert.ok(split.some((item) => item.fault));
  }
  assert.throws(() => buildCases('other'));
});
test('decision schema rejects invented scope, malformed values and inconsistent advice', () => {
  const good = {
    rag: true,
    local: false,
    clarify: false,
    collections: ['techdocs'],
    action: 'inspect'
  };
  assert.deepEqual(validateDecision(good), good);
  for (const bad of [
    null,
    [],
    {},
    { ...good, rag: 'yes' },
    { ...good, collections: ['private'] },
    { ...good, collections: ['techdocs', 'techdocs'] },
    { ...good, action: 'execute' },
    { ...good, command: 'rm' },
    { ...good, rag: false }
  ])
    assert.throws(() => validateDecision(bad));
  assert.equal(canPrefetch(undefined), false);
  assert.equal(canPrefetch({ ...good, clarify: 'unknown' }), false);
  assert.equal(canPrefetch({ ...good, collections: [] }), false);
  assert.equal(canPrefetch(good), true);
});
test('decision state contains no expected labels, answer or reference query', () => {
  const item = buildCases('dev')[1];
  const state = decisionState(item);
  for (const key of ['expected', 'value', 'referenceQuery', 'concepts', 'topicPath'])
    assert.equal(state[key], undefined);
  assert.deepEqual(
    state.collections.map((item) => item.name),
    ['techdocs']
  );
  assert.equal(compareDecision(undefined, item.expected).exact, false);
  assert.equal(compareDecision(item.expected, item.expected).exact, true);
});
test('simple routing rules prioritize explicit prohibition over quoted retrieval instruction', () => {
  const item = buildCases('dev').find((item) => item.group === 'scope');
  const advice = ruleDecision(item);
  assert.equal(advice.rag, false);
  assert.equal(advice.local, true);
  const files = fixtureFiles([item]);
  assert.match(files[item.file], new RegExp(item.value));
});
test('automatic diagnostics do not count a grounding block as a good rejection', () => {
  const item = buildCases('dev').find((item) => item.group === 'negative');
  const entry = {
    status: 'completed',
    filesUnchanged: true,
    tools: [],
    retrievals: 1,
    evidence: [],
    verification: [],
    answer: 'RAG grounding blocked: No evidence-backed conclusion was returned'
  };
  const result = assess(item, entry);
  assert.equal(result.notBlocked, false);
  assert.equal(result.contentProxy, false);
  assert.equal(assess(item, { ...entry, answer: '证据不足。' }).contentProxy, true);
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
});

test('review preserves automatic results and separates injected faults from task scores', () => {
  const dataset = buildCases('dev');
  const arms = ['baseline', 'oracle-hint', 'oracle-route'];
  const results = dataset.flatMap((item) =>
    arms.map((arm) => ({
      id: item.id,
      group: item.group,
      arm,
      repetition: 1,
      automaticPass: true,
      checks: { notBlocked: true, retrieval: true, localEvidence: true },
      tools: [],
      requests: [],
      retrievals: 0,
      usage: { input: 0, output: 0 },
      filesUnchanged: true,
      firstTextMs: null,
      durationMs: 1
    }))
  );
  const raw = {
    complete: true,
    codeUnchanged: true,
    collectionUnchanged: true,
    results,
    arms,
    datasetHash: createHash('sha256').update(JSON.stringify(dataset)).digest('hex')
  };
  const result = reviewRun(
    raw,
    dataset,
    'af1929c5a89aa5408531b1e8083f61e22b9f333b66992868f588132d99f375b9'
  );
  assert.equal(result.mainTurns, 117);
  assert.equal(result.injectedTurns, 3);
  assert.equal(result.summary.baseline.mainCount, 39);
  assert.equal(result.summary.baseline.automaticPass, 39);
  assert.equal(result.summary.baseline.reviewedPass, 38);
  assert.ok(raw.results.every((row) => row.automaticPass));
  assert.throws(() => reviewRun(raw, dataset, 'another-report'));
  assert.throws(() =>
    reviewRun(raw, [], 'af1929c5a89aa5408531b1e8083f61e22b9f333b66992868f588132d99f375b9')
  );
});
