import { existsSync } from 'node:fs';
import {
  getExtensionConfigPaths,
  inspectProjectExtensions,
  loadExtensionConfiguration
} from './config.js';
import { McpManager, type McpConnectionFactory } from './mcp-manager.js';
import { setWorkspaceTrusted } from './trust.js';
import { HookRunner } from './hooks.js';
import type {
  ExtensionConfiguration,
  ExtensionStatus
} from './types.js';

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

  constructor(options: ExtensionRuntimeOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.subagentsEnabled = options.subagentsEnabled;
    this.subagentsAvailable = options.subagentsAvailable;
    this.configuration = loadExtensionConfiguration(this.workspaceRoot);
    this.mcp = new McpManager({
      workspaceRoot: this.workspaceRoot,
      servers: this.configuration.mcpServers,
      forbiddenEnvironmentNames: options.forbiddenEnvironmentNames,
      connectionFactory: options.mcpConnectionFactory
    });
    this.hooks = new HookRunner(
      this.configuration.hooks,
      options.forbiddenEnvironmentNames
    );
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
        ready: statuses.filter(status => status.state === 'ready').length,
        servers: statuses
      },
      hooks: this.hooks.getStatus(),
      subagents: {
        enabled: this.subagentsEnabled,
        available: this.subagentsAvailable
      },
      warnings: [
        ...this.configuration.warnings,
        ...(inactiveInspection?.warnings ?? [])
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
          [server.config.command, ...server.config.args]
            .map(quoted)
            .join(' ')
        );
      } else {
        lines.push(`MCP ${server.name}: ${server.config.url}`);
      }
    }
    for (const hook of inspection.hooks) {
      lines.push(
        `Hook ${hook.config.name} (${hook.config.event}): ` +
        [hook.config.command, ...hook.config.args]
          .map(quoted)
          .join(' ')
      );
    }
    return {
      workspaceRoot: this.workspaceRoot,
      lines,
      warnings: inspection.warnings,
      projectMcpServers: inspection.mcpServers.length,
      projectHooks: inspection.hooks.length
    };
  }

  async trustWorkspace(): Promise<void> {
    setWorkspaceTrusted(this.workspaceRoot, true);
    await this.reload();
  }

  async untrustWorkspace(): Promise<void> {
    setWorkspaceTrusted(this.workspaceRoot, false);
    await this.reload();
  }

  async reload(): Promise<void> {
    const next = loadExtensionConfiguration(this.workspaceRoot);
    this.configuration = next;
    this.hooks.replaceHooks(next.hooks);
    await this.mcp.replaceServers(next.mcpServers);
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }
}
