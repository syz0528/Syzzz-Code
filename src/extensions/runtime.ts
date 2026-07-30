import { existsSync } from 'node:fs';
import {
  getExtensionConfigPaths,
  inspectProjectExtensions,
  loadExtensionConfiguration
} from './config.js';
import { McpManager, type McpConnectionFactory } from './mcp-manager.js';
import { setWorkspaceTrusted } from './trust.js';
import { HookRunner } from './hooks.js';
import {
  SUBAGENT_CONTEXT_WINDOW_TOKENS,
  SUBAGENT_HARD_TOKEN_BUDGET,
  SUBAGENT_MAX_CALLS_PER_TURN,
  SUBAGENT_MAX_PROVIDER_CALLS,
  SUBAGENT_MAX_REPORT_BYTES,
  SUBAGENT_MAX_TOOL_CALLS,
  SUBAGENT_MAX_TOOL_ROUNDS,
  SUBAGENT_SOFT_DEADLINE_MS,
  SUBAGENT_SOFT_TOKEN_BUDGET,
  SUBAGENT_TIMEOUT_MS
} from '../subagents.js';
import type { ExtensionConfiguration, ExtensionReloadResult, ExtensionStatus } from './types.js';

export interface ExtensionRuntimeOptions {
  workspaceRoot: string;
  subagentsEnabled: boolean;
  subagentsAvailable: boolean;
  forbiddenEnvironmentNames?: Iterable<string>;
  mcpConnectionFactory?: McpConnectionFactory;
}

export interface WorkspaceTrustPreview {
  workspaceRoot: string;
  lines: string[];
  warnings: string[];
  projectMcpServers: number;
  projectHooks: number;
  digest?: string;
  valid: boolean;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

export class ExtensionRuntime {
  readonly mcp: McpManager;
  readonly hooks: HookRunner;
  private configuration: ExtensionConfiguration;
  private readonly workspaceRoot: string;
  private subagentsEnabled: boolean;
  private subagentsAvailable: boolean;
  private lastSubagentStopReason?: string;

  constructor(options: ExtensionRuntimeOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.subagentsEnabled = options.subagentsEnabled;
    this.subagentsAvailable = options.subagentsAvailable;
    this.configuration = loadExtensionConfiguration(this.workspaceRoot);
    this.mcp = new McpManager({
      workspaceRoot: this.workspaceRoot,
      servers: this.configuration.mcpServers,
      toolPolicies: this.configuration.mcpToolPolicies,
      forbiddenEnvironmentNames: options.forbiddenEnvironmentNames,
      connectionFactory: options.mcpConnectionFactory
    });
    this.hooks = new HookRunner(this.configuration.hooks, options.forbiddenEnvironmentNames);
  }

  getConfiguration(): ExtensionConfiguration {
    return structuredClone(this.configuration);
  }

  supportsSubagents(): boolean {
    return this.subagentsAvailable;
  }

  canRunSubagents(): boolean {
    return this.subagentsEnabled && this.subagentsAvailable;
  }

  setSubagentsEnabled(enabled: boolean): void {
    this.subagentsEnabled = enabled;
  }

  setSubagentsAvailable(available: boolean): void {
    this.subagentsAvailable = available;
  }

  setLastSubagentStopReason(reason: string | undefined): void {
    this.lastSubagentStopReason = reason;
  }

  getStatus(): ExtensionStatus {
    const paths = getExtensionConfigPaths(this.workspaceRoot);
    const statuses = this.mcp.getStatuses();
    const projectConfigurationPresent =
      existsSync(paths.projectMcp) || existsSync(paths.projectHooks);
    const inactiveInspection =
      !this.configuration.workspaceTrusted && projectConfigurationPresent
        ? inspectProjectExtensions(this.workspaceRoot)
        : undefined;
    return {
      trustState: this.configuration.trustState,
      workspaceTrusted: this.configuration.workspaceTrusted,
      projectConfigurationPresent,
      ...(inactiveInspection
        ? {
            inactiveProject: {
              mcpServers: inactiveInspection.mcpServers.length,
              hooks: inactiveInspection.hooks.length
            }
          }
        : {}),
      mcp: {
        configured: statuses.length,
        ready: statuses.filter((status) => status.state === 'ready').length,
        error: statuses.filter((status) => status.state === 'error').length,
        disconnected: statuses.filter((status) => status.state === 'disconnected').length,
        servers: statuses
      },
      hooks: this.hooks.getStatus(),
      subagents: {
        enabled: this.subagentsEnabled,
        available: this.subagentsAvailable,
        budgets: {
          maxPerTurn: SUBAGENT_MAX_CALLS_PER_TURN,
          maxToolRounds: SUBAGENT_MAX_TOOL_ROUNDS,
          maxToolCalls: SUBAGENT_MAX_TOOL_CALLS,
          maxProviderCalls: SUBAGENT_MAX_PROVIDER_CALLS,
          softTimeoutMs: SUBAGENT_SOFT_DEADLINE_MS,
          hardTimeoutMs: SUBAGENT_TIMEOUT_MS,
          contextWindowTokens: SUBAGENT_CONTEXT_WINDOW_TOKENS,
          maxReportBytes: SUBAGENT_MAX_REPORT_BYTES,
          softTokenBudget: SUBAGENT_SOFT_TOKEN_BUDGET,
          hardTokenBudget: SUBAGENT_HARD_TOKEN_BUDGET,
          ...(this.lastSubagentStopReason ? { lastStopReason: this.lastSubagentStopReason } : {})
        }
      },
      warnings: [
        ...new Set([...this.configuration.warnings, ...(inactiveInspection?.warnings ?? [])])
      ]
    };
  }

  getTrustPreview(): WorkspaceTrustPreview {
    const inspection = inspectProjectExtensions(this.workspaceRoot);
    const lines: string[] = [];
    for (const server of inspection.mcpServers) {
      if (server.config.type === 'stdio') {
        lines.push(
          `MCP ${server.name}: ` +
            [server.config.command, ...server.config.args].map(quoted).join(' ')
        );
      } else {
        lines.push(`MCP ${server.name}: ${server.config.url}`);
      }
    }
    for (const hook of inspection.hooks) {
      lines.push(
        `Hook ${hook.config.name} (${hook.config.event}): ` +
          [hook.config.command, ...hook.config.args].map(quoted).join(' ')
      );
    }
    for (const policy of inspection.mcpToolPolicies) {
      lines.push(`MCP policy ${policy.qualifiedName}: ${policy.policy}`);
    }
    return {
      workspaceRoot: this.workspaceRoot,
      lines,
      warnings: inspection.warnings,
      projectMcpServers: inspection.mcpServers.length,
      projectHooks: inspection.hooks.length,
      ...(inspection.digest ? { digest: inspection.digest } : {}),
      valid: inspection.valid
    };
  }

  async trustWorkspace(expectedDigest: string): Promise<ExtensionReloadResult> {
    const current = inspectProjectExtensions(this.workspaceRoot);
    if (!current.valid || !current.digest) {
      throw new Error('Project extension configuration is invalid and cannot be trusted');
    }
    if (current.digest !== expectedDigest) {
      throw new Error(
        'Project extension configuration changed during confirmation; review it again'
      );
    }
    setWorkspaceTrusted(this.workspaceRoot, true, current.digest);
    return this.reload();
  }

  async untrustWorkspace(): Promise<ExtensionReloadResult> {
    setWorkspaceTrusted(this.workspaceRoot, false);
    return this.reload();
  }

  async reload(): Promise<ExtensionReloadResult> {
    const next = loadExtensionConfiguration(this.workspaceRoot);
    this.configuration = next;
    this.hooks.replaceHooks(next.hooks);
    await this.mcp.replaceServers(next.mcpServers, next.mcpToolPolicies);
    const status = this.getStatus();
    return {
      trustState: status.trustState,
      mcp: {
        configured: status.mcp.configured,
        ready: status.mcp.ready,
        error: status.mcp.error,
        disconnected: status.mcp.disconnected
      },
      hooks: {
        configured: status.hooks.configured,
        enabled: status.hooks.enabled,
        error: status.hooks.entries.filter(
          (entry) => entry.lastOutcome === 'error' || entry.lastOutcome === 'timeout'
        ).length
      },
      warnings: [...status.warnings]
    };
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }
}
