import { isAbsolute } from 'node:path';
import {
  loadRawHookConfig,
  loadRawMcpConfig,
  inspectProjectExtensions,
  saveRawHookConfig,
  saveRawMcpConfig,
  validateHookConfig,
  validateHookName,
  validateMcpServerConfig,
  validateMcpServerName,
  validateQualifiedMcpToolName
} from './config.js';
import { ExtensionRuntime } from './runtime.js';
import { inspectWorkspaceTrust } from './trust.js';
import type { ExtensionSource } from './types.js';

export interface McpManagementRequest {
  action: string;
  name?: string;
  command: string[];
  scope?: string;
  url?: string;
  headers?: string[];
  environment?: string[];
  protocolMode?: string;
  json?: boolean;
  workspaceRoot: string;
  signal: AbortSignal;
  forbiddenEnvironmentNames?: Iterable<string>;
}

export interface HookManagementRequest {
  action: string;
  name?: string;
  command: string[];
  scope?: string;
  event?: string;
  matcher?: string;
  timeoutMs?: string;
  onError?: string;
  environment?: string[];
  json?: boolean;
  workspaceRoot: string;
}

export interface ManagementResult {
  text: string;
  json: unknown;
}

function parseScope(value: string | undefined): ExtensionSource {
  const scope = value ?? 'user';
  if (scope !== 'user' && scope !== 'project') {
    throw new Error('scope must be "user" or "project"');
  }
  return scope;
}

function parseAssignments(
  values: readonly string[] | undefined,
  label: string
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values ?? []) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`${label} values must use NAME=VALUE`);
    }
    const name = value.slice(0, separator).trim();
    if (!name) {
      throw new Error(`${label} names cannot be empty`);
    }
    result[name] = value.slice(separator + 1);
  }
  return result;
}

function requireName(value: string | undefined, action: string): string {
  if (!value) {
    throw new Error(`${action} requires a name`);
  }
  return value;
}

function rawRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} is not a valid object`);
  }
  return value as Record<string, unknown>;
}

function redactedHttpTarget(value: string): string {
  const url = new URL(value);
  if (url.search) {
    url.search = '?[redacted]';
  }
  url.hash = '';
  return url.toString();
}

function listMcpEntries(workspaceRoot: string): Array<Record<string, unknown>> {
  const project = inspectProjectExtensions(workspaceRoot);
  const trusted = inspectWorkspaceTrust(workspaceRoot, project.digest).trusted;
  const entries: Array<Record<string, unknown>> = [];
  for (const scope of ['user', 'project'] as const) {
    let config;
    try {
      config = loadRawMcpConfig(scope, workspaceRoot);
    } catch (error) {
      entries.push({
        name: `${scope}-configuration`,
        scope,
        active: false,
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    for (const [name, raw] of Object.entries(config.mcpServers)) {
      try {
        validateMcpServerName(name);
        const server = validateMcpServerConfig(raw, `mcpServers.${name}`);
        entries.push({
          name,
          scope,
          active: scope === 'user' || trusted,
          enabled: server.enabled,
          transport: server.type,
          target: server.type === 'stdio' ? server.command : redactedHttpTarget(server.url),
          protocolMode: server.protocolMode
        });
      } catch (error) {
        entries.push({
          name,
          scope,
          active: false,
          valid: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return entries;
}

export async function manageMcp(request: McpManagementRequest): Promise<ManagementResult> {
  const action = request.action.toLowerCase();
  if (action === 'list') {
    const entries = listMcpEntries(request.workspaceRoot);
    return {
      json: entries,
      text:
        entries.length === 0
          ? 'No MCP servers are configured.'
          : entries
              .map(
                (entry) =>
                  `${String(entry.name).padEnd(20)} ` +
                  `${String(entry.transport ?? 'invalid').padEnd(7)} ` +
                  `${entry.enabled === false ? 'disabled' : entry.active ? 'active' : 'inactive'} ` +
                  `[${entry.scope}]`
              )
              .join('\n')
    };
  }

  if (action === 'doctor') {
    const runtime = new ExtensionRuntime({
      workspaceRoot: request.workspaceRoot,
      subagentsEnabled: false,
      subagentsAvailable: false,
      forbiddenEnvironmentNames: request.forbiddenEnvironmentNames
    });
    try {
      const statuses = await runtime.mcp.doctor(request.signal, request.name);
      return {
        json: statuses,
        text:
          statuses.length === 0
            ? 'No active MCP servers are configured.'
            : statuses
                .map(
                  (status) =>
                    `${status.name.padEnd(20)} ${status.state.padEnd(12)} ` +
                    `${status.toolCount} tools` +
                    `${status.errorCode ? ` (${status.errorCode})` : ''}`
                )
                .join('\n')
      };
    } finally {
      await runtime.close();
    }
  }

  const scope = parseScope(request.scope);
  const name = validateMcpServerName(requireName(request.name, `mcp ${action}`));
  const config = loadRawMcpConfig(scope, request.workspaceRoot);

  if (action === 'policy') {
    const toolName = request.command[0];
    const policy = request.command[1];
    if (!toolName || !policy || request.command.length !== 2) {
      throw new Error('mcp policy requires <server> <tool> execute|disabled|reset');
    }
    const qualifiedName = validateQualifiedMcpToolName(`${name}__${toolName}`);
    if (policy !== 'execute' && policy !== 'disabled' && policy !== 'reset') {
      throw new Error('MCP tool policy must be execute, disabled, or reset');
    }
    const toolPolicies = {
      ...(config.syzzz?.toolPolicies ?? {})
    };
    if (policy === 'reset') {
      delete toolPolicies[qualifiedName];
    } else {
      toolPolicies[qualifiedName] = policy;
    }
    config.syzzz = Object.keys(toolPolicies).length > 0 ? { toolPolicies } : undefined;
    saveRawMcpConfig(scope, request.workspaceRoot, config);
    return {
      json: {
        action: 'policy',
        server: name,
        tool: toolName,
        policy,
        scope
      },
      text:
        `${policy === 'reset' ? 'Reset' : 'Set'} MCP policy for ` +
        `${qualifiedName}${policy === 'reset' ? '' : ` to ${policy}`} ` +
        `[${scope}].` +
        (scope === 'project' ? ' Project extensions require /trust review after this change.' : '')
    };
  }

  if (action === 'add') {
    if (config.mcpServers[name]) {
      throw new Error(`MCP server already exists in ${scope} scope: ${name}`);
    }
    const raw = request.url
      ? {
          type: 'http',
          url: request.url,
          headers: parseAssignments(request.headers, '--header'),
          protocolMode: request.protocolMode ?? 'legacy'
        }
      : {
          type: 'stdio',
          command: request.command[0],
          args: request.command.slice(1),
          env: parseAssignments(request.environment, '--env'),
          protocolMode: request.protocolMode ?? 'legacy'
        };
    const normalized = validateMcpServerConfig(raw, `mcpServers.${name}`);
    config.mcpServers[name] = normalized;
    saveRawMcpConfig(scope, request.workspaceRoot, config);
    return {
      json: {
        action: 'added',
        name,
        scope,
        transport: normalized.type,
        protocolMode: normalized.protocolMode,
        enabled: normalized.enabled
      },
      text:
        `Added MCP server ${name} to ${scope} scope.` +
        (scope === 'project'
          ? ' Project configuration remains inactive until the workspace is trusted.'
          : '')
    };
  }

  if (action === 'remove') {
    if (!config.mcpServers[name]) {
      throw new Error(`MCP server does not exist in ${scope} scope: ${name}`);
    }
    delete config.mcpServers[name];
    if (config.syzzz?.toolPolicies) {
      const remaining = Object.fromEntries(
        Object.entries(config.syzzz.toolPolicies).filter(
          ([qualifiedName]) => !qualifiedName.startsWith(`${name}__`)
        )
      );
      config.syzzz = Object.keys(remaining).length > 0 ? { toolPolicies: remaining } : undefined;
    }
    saveRawMcpConfig(scope, request.workspaceRoot, config);
    return {
      json: { action: 'removed', name, scope },
      text: `Removed MCP server ${name} from ${scope} scope.`
    };
  }

  if (action === 'enable' || action === 'disable') {
    const server = rawRecord(config.mcpServers[name], `mcpServers.${name}`);
    server.enabled = action === 'enable';
    validateMcpServerConfig(server, `mcpServers.${name}`);
    config.mcpServers[name] = server;
    saveRawMcpConfig(scope, request.workspaceRoot, config);
    return {
      json: { action, name, scope },
      text: `${action === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${name}.`
    };
  }

  throw new Error('mcp action must be list, add, remove, enable, disable, policy, or doctor');
}

function listHookEntries(workspaceRoot: string): Array<Record<string, unknown>> {
  const project = inspectProjectExtensions(workspaceRoot);
  const trusted = inspectWorkspaceTrust(workspaceRoot, project.digest).trusted;
  const entries: Array<Record<string, unknown>> = [];
  for (const scope of ['user', 'project'] as const) {
    let file;
    try {
      file = loadRawHookConfig(scope, workspaceRoot);
    } catch (error) {
      entries.push({
        name: `${scope}-configuration`,
        scope,
        active: false,
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    for (const [index, raw] of file.hooks.entries()) {
      try {
        const hook = validateHookConfig(raw, `hooks[${index}]`);
        entries.push({
          name: hook.name,
          event: hook.event,
          scope,
          active: hook.enabled && (scope === 'user' || trusted),
          enabled: hook.enabled,
          command: hook.command
        });
      } catch (error) {
        entries.push({
          index,
          scope,
          active: false,
          valid: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return entries;
}

function findHookIndex(hooks: unknown[], name: string): number {
  return hooks.findIndex(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { name?: unknown }).name === name
  );
}

export async function manageHooks(request: HookManagementRequest): Promise<ManagementResult> {
  const action = request.action.toLowerCase();
  if (action === 'list' || action === 'doctor') {
    const entries = listHookEntries(request.workspaceRoot);
    const diagnosed: Array<Record<string, unknown>> =
      action === 'doctor'
        ? entries.map((entry) => ({
            ...entry,
            executable:
              entry.valid === false
                ? false
                : typeof entry.command === 'string' &&
                  (isAbsolute(entry.command) || !/[\\/]/.test(entry.command))
          }))
        : entries;
    return {
      json: diagnosed,
      text:
        diagnosed.length === 0
          ? 'No Hooks are configured.'
          : diagnosed
              .map(
                (entry) =>
                  `${String(entry.name ?? `index:${entry.index}`).padEnd(20)} ` +
                  `${String(entry.event ?? 'invalid').padEnd(14)} ` +
                  `${entry.active ? 'active' : 'inactive'} [${entry.scope}]`
              )
              .join('\n')
    };
  }

  const scope = parseScope(request.scope);
  const name = validateHookName(requireName(request.name, `hooks ${action}`));
  const file = loadRawHookConfig(scope, request.workspaceRoot);
  const existingIndex = findHookIndex(file.hooks, name);

  if (action === 'add') {
    if (existingIndex !== -1) {
      throw new Error(`Hook already exists in ${scope} scope: ${name}`);
    }
    const raw = {
      name,
      event: request.event,
      command: request.command[0],
      args: request.command.slice(1),
      ...(request.matcher ? { matcher: request.matcher } : {}),
      ...(request.timeoutMs ? { timeoutMs: Number(request.timeoutMs) } : {}),
      onError: request.onError ?? 'continue',
      env: parseAssignments(request.environment, '--env'),
      enabled: true
    };
    const normalized = validateHookConfig(raw, `hooks.${name}`);
    file.hooks.push(normalized);
    saveRawHookConfig(scope, request.workspaceRoot, file);
    return {
      json: {
        action: 'added',
        name,
        scope,
        event: normalized.event,
        enabled: normalized.enabled,
        onError: normalized.onError
      },
      text:
        `Added Hook ${name} to ${scope} scope.` +
        (scope === 'project'
          ? ' Project configuration remains inactive until the workspace is trusted.'
          : '')
    };
  }

  if (existingIndex === -1) {
    throw new Error(`Hook does not exist in ${scope} scope: ${name}`);
  }
  if (action === 'remove') {
    file.hooks.splice(existingIndex, 1);
  } else if (action === 'enable' || action === 'disable') {
    const hook = rawRecord(file.hooks[existingIndex], `hooks.${name}`);
    hook.enabled = action === 'enable';
    validateHookConfig(hook, `hooks.${name}`);
    file.hooks[existingIndex] = hook;
  } else {
    throw new Error('hooks action must be list, add, remove, enable, disable, or doctor');
  }
  saveRawHookConfig(scope, request.workspaceRoot, file);
  return {
    json: { action, name, scope },
    text: `${
      action === 'remove' ? 'Removed' : action === 'enable' ? 'Enabled' : 'Disabled'
    } Hook ${name}.`
  };
}
