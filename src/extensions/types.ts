import type { AgentMode } from '../modes.js';
import type { PermissionMode } from '../permissions/mode.js';

export type ExtensionSource = 'user' | 'project';
export type McpProtocolMode = 'legacy' | 'modern';
export type McpToolPolicy = 'execute' | 'disabled';
export type ExtensionTrustState = 'untrusted' | 'trusted' | 'review-required';

interface McpServerConfigBase {
  enabled: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  protocolMode: McpProtocolMode;
}

export interface StdioMcpServerConfig extends McpServerConfigBase {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface HttpMcpServerConfig extends McpServerConfigBase {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface ResolvedMcpServerConfig {
  name: string;
  source: ExtensionSource;
  trusted: boolean;
  config: McpServerConfig;
}

export interface ResolvedMcpToolPolicy {
  qualifiedName: string;
  policy: McpToolPolicy;
  sources: ExtensionSource[];
}

export type HookEventName =
  | 'PreTurn'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TurnCompleted'
  | 'TurnFailed'
  | 'TurnCancelled';

export type HookErrorPolicy = 'continue' | 'deny';

export interface HookConfig {
  name: string;
  event: HookEventName;
  command: string;
  args: string[];
  matcher?: string;
  timeoutMs: number;
  onError: HookErrorPolicy;
  env: Record<string, string>;
  enabled: boolean;
}

export interface ResolvedHookConfig {
  source: ExtensionSource;
  trusted: boolean;
  config: HookConfig;
}

export interface ExtensionConfiguration {
  workspaceRoot: string;
  trustState: ExtensionTrustState;
  workspaceTrusted: boolean;
  projectDigest?: string;
  mcpServers: ResolvedMcpServerConfig[];
  mcpToolPolicies: ResolvedMcpToolPolicy[];
  hooks: ResolvedHookConfig[];
  warnings: string[];
}

export type McpServerState = 'disabled' | 'disconnected' | 'connecting' | 'ready' | 'error';

export interface McpServerStatus {
  name: string;
  source: ExtensionSource;
  transport: 'stdio' | 'http';
  state: McpServerState;
  toolCount: number;
  protocolMode: McpProtocolMode;
  negotiatedProtocolVersion?: string;
  lastConnectedAt?: string;
  errorCode?: string;
}

export interface HookEntryRuntimeStatus {
  name: string;
  event: HookEventName;
  source: ExtensionSource;
  enabled: boolean;
  matcher?: string;
  lastOutcome?: 'success' | 'denied' | 'error' | 'timeout';
  lastDurationMs?: number;
  lastErrorCode?: string;
}

export interface HookRuntimeStatus {
  configured: number;
  enabled: number;
  lastErrorCode?: string;
  entries: HookEntryRuntimeStatus[];
}

export interface SubagentBudgetStatus {
  maxPerTurn: number;
  maxToolRounds: number;
  maxToolCalls: number;
  maxProviderCalls: number;
  softTimeoutMs: number;
  hardTimeoutMs: number;
  contextWindowTokens: number;
  maxReportBytes: number;
  softTokenBudget: number;
  hardTokenBudget: number;
  lastStopReason?: string;
}

export interface ExtensionStatus {
  trustState: ExtensionTrustState;
  workspaceTrusted: boolean;
  projectConfigurationPresent: boolean;
  inactiveProject?: {
    mcpServers: number;
    hooks: number;
  };
  mcp: {
    configured: number;
    ready: number;
    error: number;
    disconnected: number;
    servers: McpServerStatus[];
  };
  hooks: HookRuntimeStatus;
  subagents: {
    enabled: boolean;
    available: boolean;
    budgets: SubagentBudgetStatus;
  };
  warnings: string[];
}

export interface ExtensionReloadResult {
  trustState: ExtensionTrustState;
  mcp: {
    configured: number;
    ready: number;
    error: number;
    disconnected: number;
  };
  hooks: {
    configured: number;
    enabled: number;
    error: number;
  };
  warnings: string[];
}

export interface ExtensionTurnContext {
  sessionId: string;
  turnId: string;
  mode: AgentMode;
  permissionMode: PermissionMode;
}

export interface WorkspaceTrustRecordV1 {
  schemaVersion: 1;
  canonicalWorkspaceRoot: string;
  trustedAt: string;
}

export interface WorkspaceTrustRecordV2 {
  schemaVersion: 2;
  canonicalWorkspaceRoot: string;
  reviewedDigest?: string;
  reviewedAt?: string;
}
