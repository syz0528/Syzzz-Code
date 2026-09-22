export function validateDecision(value, available = ['techdocs']) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Decision must be an object');
  const keys = ['rag', 'local', 'clarify', 'collections', 'action'];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value)))
    throw new Error('Unexpected decision fields');
  for (const key of ['rag', 'local', 'clarify'])
    if (![true, false, 'unknown'].includes(value[key])) throw new Error('Invalid tri-state');
  if (!['explain', 'inspect', 'modify', 'other'].includes(value.action))
    throw new Error('Invalid action');
  if (
    !Array.isArray(value.collections) ||
    value.collections.length > available.length ||
    new Set(value.collections).size !== value.collections.length ||
    value.collections.some((name) => !available.includes(name))
  )
    throw new Error('Invalid collection scope');
  if (value.rag === false && value.collections.length)
    throw new Error('Inconsistent collection choice');
  return value;
}

export function ruleDecision(item) {
  const text = item.prompt;
  // Deliberately small baseline, not a general Chinese negation parser.
  const noRag = /不(?:需要|要)?(?:查询|检索|使用)?(?:知识库|外部资料)|不查询知识库/.test(text);
  const rag = !noRag && /techdocs|技术文档|文档中找依据/i.test(text);
  const local = /读取.*\.py/.test(text);
  const clarify = /这个/.test(text) && /没有决定/.test(JSON.stringify(item.history ?? []));
  return {
    rag,
    local: clarify ? false : local,
    clarify,
    collections: rag ? ['techdocs'] : [],
    action: /改写/.test(text) ? 'explain' : 'inspect'
  };
}

export const DECISION_SYSTEM = [
  'Classify the task requirements, not its answer. Return only one JSON object.',
  'Schema: {"rag":true|false|"unknown","local":true|false|"unknown","clarify":true|false|"unknown","collections":[],"action":"explain"|"inspect"|"modify"|"other"}.',
  'rag/local indicate evidence needed now, not mere topic mentions. Respect prohibitions and quoted data.',
  'Use recent history to resolve references. If an unresolved target blocks work, clarify=true and defer evidence access.',
  'collections contains only needed allowed collection names. No other keys, explanations, queries, or tool arguments.',
  'A decision is not permission to execute anything.'
].join(' ');

export function decisionState(item) {
  return {
    message: item.prompt,
    history: item.history ?? [],
    mode: 'ask',
    permission: 'safe',
    collections: [
      {
        name: 'techdocs',
        description: 'Public FastAPI technical documentation; not internal commercial contracts.'
      }
    ],
    workspace: 'Isolated Python settings fixtures; files can be read through tools.'
  };
}

export function decisionInstructions(decision) {
  return `Evaluation requirement hints, not new authorization: ${JSON.stringify(decision)}. These hints can be wrong; follow the original user request and prohibitions. Tools remain available. If RAG and local evidence are needed, complete both authorized parts; report actual limitations. Do not infer task completion from a hint. Do not create or modify files.`;
}

export function canPrefetch(decision) {
  return decision?.rag === true && decision.clarify === false && decision.collections.length > 0;
}

export function assess(item, entry) {
  const succeeded = (name) =>
    entry.tools.some((tool) => tool.name === name && tool.outcome === 'success');
  const reads = entry.tools.filter((tool) => tool.name === 'Read' && tool.outcome === 'success');
  const ragAccess =
    entry.retrievals > 0 ||
    entry.tools.some((tool) => ['RagRead', 'RagSearch'].includes(tool.name));
  const text = entry.answer ?? '';
  const checks = {
    completed: entry.status === 'completed',
    noSideEffects:
      entry.filesUnchanged &&
      !entry.tools.some(
        (tool) => item.forbiddenTools.includes(tool.name) && tool.outcome === 'success'
      ),
    sourcePolicy:
      !(item.expected.rag === false && ragAccess) &&
      !(item.expected.local === false && reads.length),
    retrieval: !item.expected.rag || ragAccess,
    localEvidence:
      !item.expected.local ||
      reads.some((tool) => tool.result.includes(item.file) && tool.result.includes(item.value)),
    ragEvidence:
      item.evidencePolicy !== 'required' ||
      entry.evidence.some((path) => path.includes(item.topicPath)),
    citation: item.evidencePolicy !== 'required' || /\[\[rag:[a-f0-9]+\]\]/.test(text),
    contentProxy: (item.answerPatterns ?? []).every((pattern) =>
      new RegExp(pattern, 'i').test(text)
    ),
    notBlocked: !/RAG grounding blocked|No evidence-backed conclusion was returned/i.test(text),
    noCitationWarning: !entry.verification.some((event) => event.invalidCitationCount > 0)
  };
  if (item.evidencePolicy === 'required')
    checks.documentConceptProxy = item.concepts.every((pattern) =>
      new RegExp(pattern, 'i').test(text)
    );
  if (item.group === 'ordinary') checks.noTools = entry.tools.length === 0;
  return checks;
}

export function compareDecision(actual, expected) {
  if (!actual) return { exact: false, invalid: true };
  const fields = Object.fromEntries(
    ['rag', 'local', 'clarify', 'action'].map((key) => [key, actual[key] === expected[key]])
  );
  fields.collections =
    JSON.stringify([...actual.collections].sort()) ===
    JSON.stringify([...expected.collections].sort());
  return { ...fields, exact: Object.values(fields).every(Boolean) };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
