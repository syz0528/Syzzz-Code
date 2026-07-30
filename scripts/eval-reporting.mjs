const toolOutcomes = ['success', 'error', 'denied', 'cancelled'];
const approvalChoices = ['allow-once', 'allow-edits-session', 'deny'];
const budgetStopReasons = new Set([
  'tool-round-limit',
  'tool-call-limit',
  'provider-call-limit',
  'soft-timeout',
  'soft-token-limit',
  'hard-token-limit'
]);

function emptyCounts(values) {
  return Object.fromEntries(values.map((value) => [value, 0]));
}

function countEvents(events, eventType, field, values) {
  const counts = emptyCounts(values);
  for (const event of events) {
    if (event.type === eventType && Object.hasOwn(counts, event[field])) {
      counts[event[field]] += 1;
    }
  }
  return counts;
}

function failureStopReason(result) {
  if (
    result.error.code === 'runtime_error' &&
    /^Tool call limit exceeded \(\d+ rounds\)$/u.test(result.error.message)
  ) {
    return 'tool-round-limit';
  }
  const code = /^[a-z][a-z0-9_-]{0,63}$/u.test(result.error.code) ? result.error.code : 'unknown';
  return `error:${code}`;
}

export function emptyEvalExecutionMetadata(terminalStatus = 'not-run', stopReason = 'not-run') {
  return {
    terminalStatus,
    stopReason,
    toolOutcomeCounts: emptyCounts(toolOutcomes),
    approvalOutcomeCounts: emptyCounts(approvalChoices)
  };
}

export function collectEvalExecutionMetadata(events, result, timedOut = false) {
  let stopReason;
  if (timedOut) {
    stopReason = 'eval-timeout';
  } else if (result.status === 'completed') {
    stopReason = budgetStopReasons.has(result.budgetStopReason)
      ? result.budgetStopReason
      : 'completed';
  } else if (result.status === 'cancelled') {
    stopReason = 'cancelled';
  } else {
    stopReason = failureStopReason(result);
  }

  return {
    terminalStatus: result.status,
    stopReason,
    toolOutcomeCounts: countEvents(events, 'tool_completed', 'outcome', toolOutcomes),
    approvalOutcomeCounts: countEvents(events, 'approval_resolved', 'choice', approvalChoices)
  };
}
