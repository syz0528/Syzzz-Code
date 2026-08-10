export function selectLatestAgentEvalReport(reports) {
  const candidates = reports
    .filter(
      ({ report }) =>
        report?.schemaVersion === 1 && report.suite === 'offline' && Array.isArray(report.tasks)
    )
    .sort(({ name: left }, { name: right }) => left.localeCompare(right));

  const selected = candidates.at(-1);
  if (!selected) {
    throw new Error('No valid offline Agent Eval report is available for the release');
  }
  return selected.report;
}

export function createAgentEvalSummary(report) {
  return {
    schemaVersion: report.schemaVersion,
    runId: report.runId,
    suite: report.suite,
    gitCommit: report.gitCommit,
    platform: report.platform,
    arch: report.arch,
    nodeVersion: report.nodeVersion,
    providerProtocol: report.providerProtocol,
    model: report.model,
    durationMs: report.durationMs,
    summary: report.summary,
    tasks: report.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      durationMs: task.durationMs,
      providerCalls: task.providerCalls,
      toolCalls: task.toolCalls,
      approvals: task.approvals,
      retries: task.retries,
      compactions: task.compactions,
      usage: task.usage,
      changedFiles: task.changedFiles,
      insertions: task.insertions,
      deletions: task.deletions,
      graderChecks: task.graderChecks
    }))
  };
}
