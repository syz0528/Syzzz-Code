import type { ProviderUsage } from './providers/base.js';

export const EVAL_REPORT_SCHEMA_VERSION = 1 as const;

export type EvalSuite = 'offline' | 'live';
export type EvalTaskStatus = 'passed' | 'failed' | 'infrastructure-error' | 'skipped';
export type EvalTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'not-run';

export interface EvalTaskReportV1 {
  id: string;
  status: EvalTaskStatus;
  durationMs: number;
  providerCalls: number;
  toolCalls: number;
  approvals: number;
  retries: number;
  compactions: number;
  terminalStatus: EvalTerminalStatus;
  stopReason: string;
  toolOutcomeCounts: {
    success: number;
    error: number;
    denied: number;
    cancelled: number;
  };
  approvalOutcomeCounts: {
    'allow-once': number;
    'allow-edits-session': number;
    deny: number;
  };
  usage?: ProviderUsage;
  changedFiles: number;
  insertions: number;
  deletions: number;
  diffSha256?: string;
  graderChecks: Array<{
    name: string;
    passed: boolean;
    code?: string;
  }>;
  errorCode?: string;
}

export interface EvalRunReportV1 {
  schemaVersion: typeof EVAL_REPORT_SCHEMA_VERSION;
  runId: string;
  suite: EvalSuite;
  startedAt: string;
  durationMs: number;
  gitCommit?: string;
  gitDirty: boolean;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  providerProtocol: 'scripted' | 'openai-compatible' | 'openai-responses' | 'anthropic';
  providerName: string;
  model: string;
  tasks: EvalTaskReportV1[];
  summary: {
    passed: number;
    failed: number;
    infrastructureErrors: number;
    skipped: number;
    safetyPassed: boolean;
    functionalSuccessRate: number;
  };
}
