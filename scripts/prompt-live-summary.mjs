import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const reportPath = resolve(process.argv[2] ?? 'artifacts/prompt-live/paired-20260914/report.json');
const directory = dirname(reportPath);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const dataset = JSON.parse(await readFile(join(directory, 'dataset.json'), 'utf8'));
const definitions = new Map(dataset.cases.map((item) => [item.id, item]));
const measured = report.results.filter((item) => !item.setup);
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
const count = (items, predicate) => items.filter(predicate).length;
const isEvidence = (item) => ['evidence', 'mixed'].includes(definitions.get(item.id).expect);
const totalUsage = (items) =>
  items.reduce(
    (total, item) => {
      for (const usage of Object.values(item.usageByPurpose)) {
        total.inputTokens += usage.inputTokens;
        total.outputTokens += usage.outputTokens;
      }
      return total;
    },
    { inputTokens: 0, outputTokens: 0 }
  );
const byArm = {};
for (const arm of ['baseline', 'candidate']) {
  const items = measured.filter((item) => item.arm === arm);
  const timed = items.filter((item) => definitions.get(item.id).expect !== 'cancelled');
  const evidence = items.filter(isEvidence);
  byArm[arm] = {
    cases: items.length,
    automaticPass: count(items, (item) => item.automaticPass),
    completed: count(items, (item) => item.status === 'completed'),
    blocked: count(items, (item) => /RAG grounding blocked/.test(item.answer)),
    deadlineExceeded: count(timed, (item) => item.deadlineReached),
    evidenceCases: evidence.length,
    evidenceRead: count(evidence, (item) => item.checks.expectedEvidenceRead),
    evidenceAutomaticPass: count(evidence, (item) => item.automaticPass),
    evidenceSearchSucceeded: count(evidence, (item) => item.checks.searchSucceeded),
    evidenceSearchEmpty: count(
      evidence,
      (item) =>
        item.tools.some((tool) => tool.name === 'RagSearch' && tool.outcome === 'success') &&
        !item.tools.some(
          (tool) =>
            tool.name === 'RagSearch' &&
            tool.outcome === 'success' &&
            tool.result.includes('rag://')
        )
    ),
    evidenceNoRead: count(
      evidence,
      (item) => !item.tools.some((tool) => tool.name === 'RagRead' && tool.outcome === 'success')
    ),
    evidenceOtherDocumentOnly: count(
      evidence,
      (item) =>
        !item.checks.expectedEvidenceRead &&
        item.tools.some((tool) => tool.name === 'RagRead' && tool.outcome === 'success')
    ),
    toolErrors: items.reduce(
      (sum, item) => sum + count(item.tools, (tool) => tool.outcome === 'error'),
      0
    ),
    nonFaultToolErrors: items
      .filter((item) => item.group !== 'fault')
      .reduce((sum, item) => sum + count(item.tools, (tool) => tool.outcome === 'error'), 0),
    toolCalls: items.reduce((sum, item) => sum + item.tools.length, 0),
    modelRequests: items.reduce((sum, item) => sum + item.requests.length, 0),
    verificationFailures: items.reduce(
      (sum, item) =>
        sum + count(item.verification, (event) => event.type === 'rag_verification_failed'),
      0
    ),
    unsafeWrites: count(items, (item) => !item.checks.noSuccessfulWrites || !item.filesUnchanged),
    wrongSource: count(items, (item) => !item.checks.sourceScope),
    medianMs: percentile(
      timed.map((item) => item.durationMs),
      0.5
    ),
    p95Ms: percentile(
      timed.map((item) => item.durationMs),
      0.95
    ),
    observedUsage: totalUsage(items),
    usageIncludingSetup: totalUsage(report.results.filter((item) => item.arm === arm)),
    byGroup: Object.fromEntries(
      [...new Set(items.map((item) => item.group))].map((group) => {
        const subset = items.filter((item) => item.group === group);
        return [
          group,
          { total: subset.length, automaticPass: count(subset, (item) => item.automaticPass) }
        ];
      })
    )
  };
}
const summary = {
  datasetSha256: report.datasetSha256,
  complete: report.complete ?? false,
  collectionUnchanged: report.collectionUnchanged,
  byArm,
  pairedAutomatic: measured
    .filter((item) => item.arm === 'baseline')
    .reduce(
      (total, item) => {
        const peer = measured.find(
          (other) =>
            other.arm === 'candidate' &&
            other.id === item.id &&
            other.repetition === item.repetition
        );
        if (!peer) return total;
        const key = item.automaticPass
          ? peer.automaticPass
            ? 'bothPass'
            : 'baselineOnly'
          : peer.automaticPass
            ? 'candidateOnly'
            : 'bothFail';
        total[key] += 1;
        return total;
      },
      { bothPass: 0, baselineOnly: 0, candidateOnly: 0, bothFail: 0 }
    ),
  warning:
    'Automatic passes are diagnostic proxies, not expert accuracy. Codex review must be reported separately. Latency excludes deliberate cancellation and is capped by turn timeout; shared model cache and unseeded sampling remain confounders.'
};
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
const lines = [
  '# Prompt 对照评测逐条复核',
  '',
  '固定公共资料；自动分数不是事实正确率。以下为本地评测输出，不含用户会话。',
  '',
  `数据集 hash：\`${report.datasetSha256}\``,
  '',
  '| 版本 | 自动门通过 | 读到目标文档 | 错误工具调用 | 阻断 | 中位耗时 ms | P95 ms |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
];
for (const [arm, stats] of Object.entries(byArm))
  lines.push(
    `| ${arm} | ${stats.automaticPass}/${stats.cases} | ${stats.evidenceRead}/${stats.evidenceCases} | ${stats.toolErrors} | ${stats.blocked} | ${stats.medianMs} | ${stats.p95Ms} |`
  );
for (const item of dataset.cases) {
  const results = measured.filter((entry) => entry.id === item.id);
  if (!results.length) continue;
  lines.push('', `## ${item.id}`, '', `问题：${item.prompt}`, '');
  if (item.setup) lines.push(`前置问题：${item.setup}`, '');
  for (const entry of results) {
    lines.push(
      `### ${entry.arm} / 重复 ${entry.repetition}`,
      '',
      `状态：${entry.status}；耗时 ${entry.durationMs} ms；自动门：${entry.automaticPass ? '通过' : '未通过'}。`,
      '',
      `工具：${entry.tools.map((tool) => `${tool.name}:${tool.outcome}`).join(' → ') || '无'}`,
      '',
      `未通过的检查：${
        Object.entries(entry.checks)
          .filter(([, passed]) => !passed)
          .map(([name]) => name)
          .join('、') || '无'
      }`,
      '',
      '回答：',
      '',
      '```text',
      entry.answer || '(空)',
      '```',
      ''
    );
  }
}
await writeFile(join(directory, 'review.md'), lines.join('\n'));
console.log(JSON.stringify(summary, null, 2));
