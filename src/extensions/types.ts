import type { AgentMode } from '../modes.js';
import type { PermissionMode } from '../permissions/mode.js';

export type ExtensionSource = 'user' | 'project';
export type McpProtocolMode = 'legacy' | 'modern';

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

export type McpServerConfig =
  | StdioMcpServerConfig
  | HttpMcpServerConfig;

export interface ResolvedMcpServerConfig {
  name: string;
  source: ExtensionSource;
  trusted: boolean;
  config: McpServerConfig;
}

export type HookEventName =
  | 'PreTurn'
  | 'PreToolUse'
  | 'PostToolUse'
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
  workspaceTrusted: boolean;
  mcpServers: ResolvedMcpServerConfig[];
  hooks: ResolvedHookConfig[];
  warnings: string[];
}

export type McpServerState =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'error';

export interface McpServerStatus {
  name: string;
  source: ExtensionSource;
  transport: 'stdio' | 'http';
  state: McpServerState;
  toolCount: number;
  protocolMode: McpProtocolMode;
  errorCode?: string;
}

export interface HookRuntimeStatus {
  configured: number;
  enabled: number;
  lastErrorCode?: string;
}

export interface ExtensionStatus {
  workspaceTrusted: boolean;
  projectConfigurationPresent: boolean;
  inactiveProject?: {
    mcpServers: number;
    hooks: number;
  };
  mcp: {
    configured: number;
    ready: number;
    servers: McpServerStatus[];
  };
  hooks: HookRuntimeStatus;
  subagents: {
    enabled: boolean;
    available: boolean;
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
