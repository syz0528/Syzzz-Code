import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from './decision-eval-lib.mjs';

const reviewedHash = 'af1929c5a89aa5408531b1e8083f61e22b9f333b66992868f588132d99f375b9';
const overrides = {
  'dev-clarify-lifespan/baseline/1':
    '未真正请求用户确定对象，反而已用 Grep 检查两份文件；关键词命中不能证明澄清完成。',
  'dev-explicit-cors/oracle-hint/1':
    '主要事实正确，但增加无关简单请求说明，最后一个引用被截断；不满足完整可引用答案要求。',
  'dev-implicit-cors/oracle-route/1': '回答全部为英文，违反题目明确要求的一两句中文。',
  'dev-clarify-dependency/oracle-route/1':
    '只宣称接下来读取两份文件，没有请求用户确定对象，也没有执行所宣称的读取。'
};
const notes = {
  'dev-implicit-cors/baseline/1':
    '轻微：origin 译为“原因”；三组成部分正确，本轮接受但保留语言问题。',
  'dev-local-cors/oracle-hint/1':
    '轻微：中文提问得到英文回答；本题未明确限定答案语言，值与读取均正确。',
  'dev-clarify-form/baseline/1': '轻微：请求用户提供更多内容而非直接选目标，仍确实暂停并请求澄清。',
  'dev-clarify-form/oracle-hint/1':
    '轻微：附带不必要的分析承诺，但实际请求用户选择且未读取文件正文。',
  'dev-clarify-form/oracle-route/1': '轻微：澄清问题偏宽，仍请求补充上下文且未读取文件正文。',
  'dev-negative-form/oracle-route/1':
    '注入故障单列：Runtime 返回准确的 HTTP 503 错误，但直接终止回合，无助手降级回答；并非隐瞒错误。'
};
const key = (row) => `${row.id}/${row.arm}/${row.repetition}`;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const count = (rows, predicate) => rows.filter(predicate).length;

export function reviewRun(raw, dataset, sourceHash) {
  // These judgments belong to one inspected run, never silently reuse them on a rerun.
  assert.equal(sourceHash, reviewedHash, 'This Codex review belongs to a different raw report');
  assert.ok(raw.complete && raw.codeUnchanged && raw.collectionUnchanged);
  assert.equal(sha(JSON.stringify(dataset)), raw.datasetHash, 'Dataset changed after the run');
  assert.equal(raw.results.length, 120);
  assert.equal(new Set(raw.results.map(key)).size, 120);
  const cases = new Map(dataset.map((item) => [item.id, item]));
  const rows = raw.results.map((row) => {
    const item = cases.get(row.id);
    assert.ok(item, 'Missing case');
    return {
      ...row,
      faultInjection: Boolean(item.fault),
      reviewedPass: row.automaticPass && !overrides[key(row)],
      reviewNote:
        overrides[key(row)] ??
        notes[key(row)] ??
        (row.automaticPass
          ? '复核维持通过：核对最终内容及工具结果；不是仅依赖关键词评分。'
          : `复核维持未通过；自动检查项：${Object.entries(row.checks)
              .filter(([, value]) => !value)
              .map(([name]) => name)
              .join(', ')}。`)
    };
  });
  for (const id of Object.keys(overrides)) assert.ok(rows.some((row) => key(row) === id));
  const summary = {};
  const groups = {};
  for (const arm of raw.arms) {
    const all = rows.filter((row) => row.arm === arm);
    const main = all.filter((row) => !row.faultInjection);
    const requiredRag = main.filter((row) => cases.get(row.id).expected.rag);
    const requiredLocal = main.filter((row) => cases.get(row.id).expected.local);
    const forbiddenRag = main.filter((row) => !cases.get(row.id).expected.rag);
    summary[arm] = {
      mainCount: main.length,
      automaticPass: count(main, (row) => row.automaticPass),
      reviewedPass: count(main, (row) => row.reviewedPass),
      p50Ms: percentile(
        main.map((row) => row.durationMs),
        0.5
      ),
      p95Ms: percentile(
        main.map((row) => row.durationMs),
        0.95
      ),
      timeoutCount: count(main, (row) => row.deadlineReached),
      blockedCount: count(main, (row) => !row.checks.notBlocked),
      missingRagAccess: count(requiredRag, (row) => !row.checks.retrieval),
      requiredRagCount: requiredRag.length,
      missingLocalEvidence: count(requiredLocal, (row) => !row.checks.localEvidence),
      requiredLocalCount: requiredLocal.length,
      unnecessaryRag: count(
        forbiddenRag,
        (row) =>
          row.retrievals > 0 ||
          row.tools.some((tool) => ['RagSearch', 'RagRead'].includes(tool.name))
      ),
      noRagCount: forbiddenRag.length,
      inputTokens: main.reduce((total, row) => total + row.usage.input, 0),
      outputTokens: main.reduce((total, row) => total + row.usage.output, 0),
      requests: main.reduce((total, row) => total + row.requests.length, 0),
      tools: main.reduce((total, row) => total + row.tools.length, 0),
      toolErrors: main.reduce(
        (total, row) => total + count(row.tools, (tool) => tool.outcome !== 'success'),
        0
      ),
      malformedProviderResponses: count(main, (row) => row.error?.code === 'malformed_response'),
      fileSideEffects: count(all, (row) => !row.filesUnchanged),
      firstProviderTextProxy: {
        coverage: count(main, (row) => row.firstTextMs !== null),
        p50Ms: percentile(
          main.map((row) => row.firstTextMs).filter((value) => value !== null),
          0.5
        ),
        p95Ms: percentile(
          main.map((row) => row.firstTextMs).filter((value) => value !== null),
          0.95
        ),
        warning: '首个主模型正文，可能被验证拦截；不是首个有效用户可见回答，不用于首字收益结论。'
      }
    };
    groups[arm] = Object.fromEntries(
      [...new Set(main.map((row) => row.group))].map((group) => {
        const items = main.filter((row) => row.group === group);
        return [group, { count: items.length, passed: count(items, (row) => row.reviewedPass) }];
      })
    );
  }
  const paired = Object.fromEntries(
    raw.arms
      .filter((arm) => arm !== 'baseline')
      .map((arm) => {
        const gains = [],
          losses = [];
        for (const base of rows.filter((row) => row.arm === 'baseline' && !row.faultInjection)) {
          const candidate = rows.find(
            (row) => row.id === base.id && row.arm === arm && row.repetition === base.repetition
          );
          assert.ok(candidate);
          if (!base.reviewedPass && candidate.reviewedPass) gains.push(base.id);
          if (base.reviewedPass && !candidate.reviewedPass) losses.push(base.id);
        }
        return [arm, { gains, losses }];
      })
  );
  return {
    schemaVersion: 1,
    reviewer: 'Codex，用户授权代审，非独立人工 Gold',
    rawReportHash: sourceHash,
    datasetHash: raw.datasetHash,
    decision: '不接入前置模型；按计划停止冻结配对扩测。',
    mainTurns: count(rows, (row) => !row.faultInjection),
    injectedTurns: count(rows, (row) => row.faultInjection),
    summary,
    groups,
    paired,
    rows
  };
}

async function main() {
  const directory = resolve(process.argv[2] ?? 'artifacts/decision-eval/dev-oracle-20260921');
  const rawText = await readFile(join(directory, 'report.json'), 'utf8');
  const dataset = JSON.parse(await readFile(join(directory, 'dataset.json'), 'utf8'));
  const review = reviewRun(JSON.parse(rawText), dataset, sha(rawText));
  await writeFile(join(directory, 'codex-review.json'), JSON.stringify(review, null, 2));
  const lines = [
    '# 开发对照逐条复核',
    '',
    '审核者：Codex，用户授权代审，非独立人工 Gold。',
    '',
    '原始自动评分不变。117 个真实模型任务回合与 3 个 HTTP 503 注入回合分开统计。',
    '',
    `原始报告 SHA256：\`${review.rawReportHash}\``,
    '',
    '复核检查：是否完成原问题；引用是否完整；明确语言要求；是否真实澄清；实际证据及错误是否如实表述。轻微措辞不一律判失败。',
    ''
  ];
  for (const row of review.rows) {
    const item = dataset.find((item) => item.id === row.id);
    lines.push(
      `## ${key(row)}`,
      '',
      item.prompt,
      '',
      `自动：${row.automaticPass ? '通过' : '未通过'}；复核：${row.reviewedPass ? '通过' : '未通过'}${row.faultInjection ? '（故障单列，不计任务通过率）' : ''}。`,
      '',
      row.reviewNote,
      '',
      `工具：${row.tools.map((tool) => `${tool.name}:${tool.outcome}`).join('、') || '无显式工具'}；检索次数：${row.retrievals}；耗时：${row.durationMs} ms。`,
      '',
      '~~~~text',
      row.answer || `无助手正文；错误：${row.error?.message ?? '未提供'}`,
      '~~~~',
      ''
    );
  }
  await writeFile(join(directory, 'codex-review.md'), lines.join('\n'));
  console.log(
    JSON.stringify(
      { summary: review.summary, groups: review.groups, paired: review.paired },
      null,
      2
    )
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
