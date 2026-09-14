import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPromptCase } from '../scripts/prompt-live-checks.mjs';

const entry = (answer, tools = []) => ({
  answer,
  tools,
  status: 'completed',
  filesUnchanged: true,
  verification: []
});
const search = { name: 'RagSearch', outcome: 'success', result: 'candidates' };
test('live eval does not score grounding block as a correct refusal', () => {
  const checks = assessPromptCase(
    entry('RAG grounding blocked: No evidence-backed conclusion was returned.', [search]),
    { expect: 'refusal' }
  );
  assert.equal(checks.notBlocked, false);
  assert.equal(Object.values(checks).every(Boolean), false);
  assert.ok(
    Object.values(
      assessPromptCase(entry('证据不足，材料没有相关信息。', [search]), { expect: 'refusal' })
    ).every(Boolean)
  );
});
test('live eval separates evidence selection from unsupported code in an answer', () => {
  const checks = assessPromptCase(
    entry('TestClient with TestClient(app) [[rag:aaaaaaaaaaaaaaaa]]', [
      search,
      { name: 'RagRead', outcome: 'success', result: 'rag://techdocs/advanced/testing-events.md' }
    ]),
    { expect: 'evidence', topic: 'lifespan' }
  );
  assert.equal(checks.expectedEvidenceRead, true);
  assert.equal(checks.noCode, false);
});
test('live eval distinguishes cancellation, wrong scope, writes and invalid JSON', () => {
  assert.equal(
    assessPromptCase({ ...entry(''), status: 'cancelled' }, { expect: 'cancelled' }).completed,
    true
  );
  assert.equal(assessPromptCase(entry('null'), { expect: 'json' }).exactJson, false);
  assert.equal(
    assessPromptCase(entry('{"status":"ready","count":3}'), { expect: 'json' }).exactJson,
    true
  );
  assert.equal(
    assessPromptCase(entry('RAG', [{ ...search, result: 'rag://library/private.md' }]), {
      expect: 'direct'
    }).sourceScope,
    false
  );
  assert.equal(
    assessPromptCase(entry('done', [{ name: 'Write', outcome: 'success', result: '' }]), {
      expect: 'direct'
    }).noSuccessfulWrites,
    false
  );
});
