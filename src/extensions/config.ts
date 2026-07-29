import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import picomatch from 'picomatch';
import type {
  ExtensionConfiguration,
  ExtensionSource,
  HookConfig,
  HookErrorPolicy,
  HookEventName,
  McpProtocolMode,
  McpServerConfig,
  ResolvedHookConfig,
  ResolvedMcpServerConfig
} from './types.js';
import { inspectWorkspaceTrust } from './trust.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
const MAX_EXTENSION_TIMEOUT_MS = 120_000;
const MAX_HOOK_TIMEOUT_MS = 30_000;
const MAX_MCP_SERVERS = 20;
const MAX_SERVER_NAME_CHARACTERS = 64;
const MAX_COMMAND_CHARACTERS = 4_096;
const MAX_ARGUMENT_CHARACTERS = 16_384;
const MAX_URL_CHARACTERS = 8_192;

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const HOOK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HOOK_EVENTS = new Set<HookEventName>([
  'PreTurn',
  'PreToolUse',
  'PostToolUse',
  'TurnCompleted',
  'TurnFailed',
  'TurnCancelled'
]);

export interface ExtensionConfigPaths {
  userMcp: string;
  projectMcp: string;
  userHooks: string;
  projectHooks: string;
}

export interface McpConfigFile {
  mcpServers: Record<string, unknown>;
}

export interface HookConfigFile {
  schemaVersion: 1;
  hooks: unknown[];
}

export interface ProjectExtensionInspection {
  mcpServers: ResolvedMcpServerConfig[];
  hooks: ResolvedHookConfig[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  maximum: number
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new Error(`${field} exceeds ${maximum} characters`);
  }
  return value;
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
  field: string
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function timeoutValue(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || Number(value) < 100 || Number(value) > maximum) {
    throw new Error(`${field} must be an integer between 100 and ${maximum}`);
  }
  return Number(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((entry, index) =>
    requireString(entry, `${field}[${index}]`, MAX_ARGUMENT_CHARACTERS)
  );
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 256) {
      throw new Error(`${field} contains an invalid key`);
    }
    if (typeof entry !== 'string' || entry.length > MAX_ARGUMENT_CHARACTERS) {
      throw new Error(`${field}.${key} must be a bounded string`);
    }
    result[key] = entry;
  }
  return result;
}

function validateEnvironmentRecord(
  values: Record<string, string>,
  field: string
): Record<string, string> {
  for (const name of Object.keys(values)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new Error(`${field} contains an invalid environment variable name`);
    }
  }
  return values;
}

function validateHeaderRecord(
  values: Record<string, string>,
  field: string
): Record<string, string> {
  for (const [name, value] of Object.entries(values)) {
    if (!HTTP_HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`${field} contains an invalid HTTP header name`);
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`${field}.${name} cannot contain line breaks`);
    }
    if (!/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) {
      throw new Error(
        `${field}.${name} must reference an environment variable as ` +
        '${ENV_NAME}'
      );
    }
  }
  return values;
}

function protocolMode(value: unknown, field: string): McpProtocolMode {
  if (value === undefined) {
    return 'legacy';
  }
  if (value !== 'legacy' && value !== 'modern') {
    throw new Error(`${field} must be "legacy" or "modern"`);
  }
  return value;
}

function validateHttpUrl(value: unknown, field: string): string {
  const rawUrl = requireString(value, field, MAX_URL_CHARACTERS);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  const isLoopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`${field} must use HTTPS unless it targets loopback`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} cannot contain embedded credentials`);
  }
  return parsed.toString();
}

export function validateMcpServerName(name: string): string {
  if (
    !name ||
    name.length > MAX_SERVER_NAME_CHARACTERS ||
    !MCP_SERVER_NAME_PATTERN.test(name) ||
    name.includes('__')
  ) {
    throw new Error(
      `MCP server names must match ${MCP_SERVER_NAME_PATTERN}, must not contain ` +
      `"__", and must contain at most ${MAX_SERVER_NAME_CHARACTERS} characters`
    );
  }
  return name;
}

export function validateHookName(name: string): string {
  if (
    !name ||
    name.length > 128 ||
    !HOOK_NAME_PATTERN.test(name)
  ) {
    throw new Error(
      `Hook names must match ${HOOK_NAME_PATTERN} and contain at most 128 characters`
    );
  }
  return name;
}

export function validateMcpServerConfig(
  value: unknown,
  field = 'mcpServer'
): McpServerConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const inferredType = value.type ??
    (value.command !== undefined ? 'stdio' : value.url !== undefined ? 'http' : undefined);
  if (inferredType !== 'stdio' && inferredType !== 'http') {
    throw new Error(`${field}.type must be "stdio" or "http"`);
  }
  const common = {
    enabled: optionalBoolean(value.enabled, true, `${field}.enabled`),
    startupTimeoutMs: timeoutValue(
      value.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      MAX_EXTENSION_TIMEOUT_MS,
      `${field}.startupTimeoutMs`
    ),
    toolTimeoutMs: timeoutValue(
      value.toolTimeoutMs,
      DEFAULT_TOOL_TIMEOUT_MS,
      MAX_EXTENSION_TIMEOUT_MS,
      `${field}.toolTimeoutMs`
    ),
    protocolMode: protocolMode(value.protocolMode, `${field}.protocolMode`)
  };
  if (inferredType === 'stdio') {
    return {
      type: 'stdio',
      command: requireString(
        value.command,
        `${field}.command`,
        MAX_COMMAND_CHARACTERS
      ),
      args: stringArray(value.args, `${field}.args`),
      env: validateEnvironmentRecord(
        stringRecord(value.env, `${field}.env`),
        `${field}.env`
      ),
      ...common
    };
  }
  return {
    type: 'http',
    url: validateHttpUrl(value.url, `${field}.url`),
    headers: validateHeaderRecord(
      stringRecord(value.headers, `${field}.headers`),
      `${field}.headers`
    ),
    ...common
  };
}

export function validateHookConfig(value: unknown, field: string): HookConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const event = requireString(value.event, `${field}.event`, 64) as HookEventName;
  if (!HOOK_EVENTS.has(event)) {
    throw new Error(`${field}.event is not supported`);
  }
  const onError = value.onError ?? 'continue';
  if (onError !== 'continue' && onError !== 'deny') {
    throw new Error(`${field}.onError must be "continue" or "deny"`);
  }
  if (onError === 'deny' && event !== 'PreToolUse') {
    throw new Error(`${field}.onError "deny" is valid only for PreToolUse`);
  }
  const matcher = value.matcher === undefined
    ? undefined
    : requireString(value.matcher, `${field}.matcher`, 1_024);
  if (
    matcher &&
    event !== 'PreToolUse' &&
    event !== 'PostToolUse'
  ) {
    throw new Error(
      `${field}.matcher is valid only for PreToolUse or PostToolUse`
    );
  }
  if (matcher) {
    try {
      picomatch.makeRe(matcher);
    } catch {
      throw new Error(`${field}.matcher must be a valid glob`);
    }
  }
  return {
    name: validateHookName(
      requireString(value.name, `${field}.name`, 128)
    ),
    event,
    command: requireString(
      value.command,
      `${field}.command`,
      MAX_COMMAND_CHARACTERS
    ),
    args: stringArray(value.args, `${field}.args`),
    ...(matcher ? { matcher } : {}),
    timeoutMs: timeoutValue(
      value.timeoutMs,
      DEFAULT_HOOK_TIMEOUT_MS,
      MAX_HOOK_TIMEOUT_MS,
      `${field}.timeoutMs`
    ),
    onError: onError as HookErrorPolicy,
    env: validateEnvironmentRecord(
      stringRecord(value.env, `${field}.env`),
      `${field}.env`
    ),
    enabled: optionalBoolean(value.enabled, true, `${field}.enabled`)
  };
}

export function getExtensionConfigPaths(
  workspaceRoot: string
): ExtensionConfigPaths {
  const userRoot = join(homedir(), '.syzzz-code');
  const projectRoot = resolve(workspaceRoot);
  return {
    userMcp: join(userRoot, 'mcp.json'),
    projectMcp: join(projectRoot, '.mcp.json'),
    userHooks: join(userRoot, 'hooks.json'),
    projectHooks: join(projectRoot, '.syzzz-code', 'hooks.json')
  };
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readMcpScope(
  path: string,
  source: ExtensionSource,
  trusted: boolean,
  warnings: string[]
): ResolvedMcpServerConfig[] {
  let raw: unknown;
  try {
    raw = readJsonFile(path);
  } catch (error) {
    warnings.push(
      `${source} MCP configuration disabled: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
  if (raw === undefined) {
    return [];
  }
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
    warnings.push(`${source} MCP configuration disabled: mcpServers must be an object`);
    return [];
  }
  const servers: ResolvedMcpServerConfig[] = [];
  for (const [name, value] of Object.entries(raw.mcpServers)) {
    try {
      validateMcpServerName(name);
      servers.push({
        name,
        source,
        trusted,
        config: validateMcpServerConfig(value, `mcpServers.${name}`)
      });
    } catch (error) {
      warnings.push(
        `${source} MCP server "${name}" disabled: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return servers;
}

function readHookScope(
  path: string,
  source: ExtensionSource,
  trusted: boolean,
  warnings: string[]
): ResolvedHookConfig[] {
  let raw: unknown;
  try {
    raw = readJsonFile(path);
  } catch (error) {
    warnings.push(
      `${source} Hooks configuration disabled: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
  if (raw === undefined) {
    return [];
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.hooks)
  ) {
    warnings.push(
      `${source} Hooks configuration disabled: schemaVersion 1 and hooks[] are required`
    );
    return [];
  }
  const hooks: ResolvedHookConfig[] = [];
  const names = new Set<string>();
  for (const [index, value] of raw.hooks.entries()) {
    try {
      const config = validateHookConfig(value, `hooks[${index}]`);
      if (names.has(config.name)) {
        warnings.push(
          `${source} Hook at index ${index} disabled: duplicate name "${config.name}"`
        );
        continue;
      }
      names.add(config.name);
      hooks.push({
        source,
        trusted,
        config
      });
    } catch (error) {
      warnings.push(
        `${source} Hook at index ${index} disabled: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return hooks;
}

function mergeByName<T>(
  userEntries: T[],
  projectEntries: T[],
  nameOf: (entry: T) => string
): T[] {
  const projectNames = new Set(projectEntries.map(nameOf));
  return [
    ...userEntries.filter(entry => !projectNames.has(nameOf(entry))),
    ...projectEntries
  ];
}

export function loadExtensionConfiguration(
  workspaceRoot: string
): ExtensionConfiguration {
  const paths = getExtensionConfigPaths(workspaceRoot);
  const trust = inspectWorkspaceTrust(workspaceRoot);
  const warnings = [...trust.warnings];
  const userServers = readMcpScope(paths.userMcp, 'user', true, warnings);
  const projectServers = trust.trusted
    ? readMcpScope(paths.projectMcp, 'project', true, warnings)
    : [];
  const userHooks = readHookScope(paths.userHooks, 'user', true, warnings);
  const projectHooks = trust.trusted
    ? readHookScope(paths.projectHooks, 'project', true, warnings)
    : [];
  const mcpServers = mergeByName(
    userServers,
    projectServers,
    entry => entry.name
  );
  if (mcpServers.length > MAX_MCP_SERVERS) {
    warnings.push(
      `MCP configuration exceeds ${MAX_MCP_SERVERS} merged servers; ` +
      'servers after the limit are disabled'
    );
  }
  return {
    workspaceRoot: resolve(workspaceRoot),
    workspaceTrusted: trust.trusted,
    mcpServers: mcpServers.slice(0, MAX_MCP_SERVERS),
    hooks: mergeByName(
      userHooks,
      projectHooks,
      entry => entry.config.name
    ),
    warnings
  };
}

export function inspectProjectExtensions(
  workspaceRoot: string
): ProjectExtensionInspection {
  const paths = getExtensionConfigPaths(workspaceRoot);
  const warnings: string[] = [];
  return {
    mcpServers: readMcpScope(
      paths.projectMcp,
      'project',
      false,
      warnings
    ),
    hooks: readHookScope(
      paths.projectHooks,
      'project',
      false,
      warnings
    ),
    warnings
  };
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryFile = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryFile, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryFile, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows ACL privacy is reported by doctor; POSIX mode is best effort.
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporaryFile);
    } catch {
      // The successful rename removes the temporary path.
    }
  }
}

export function loadRawMcpConfig(
  scope: ExtensionSource,
  workspaceRoot: string
): McpConfigFile {
  const paths = getExtensionConfigPaths(workspaceRoot);
  const path = scope === 'user' ? paths.userMcp : paths.projectMcp;
  const raw = readJsonFile(path);
  if (raw === undefined) {
    return { mcpServers: {} };
  }
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
    throw new Error(`Invalid MCP configuration at ${path}`);
  }
  return { mcpServers: { ...raw.mcpServers } };
}

export function saveRawMcpConfig(
  scope: ExtensionSource,
  workspaceRoot: string,
  config: McpConfigFile
): void {
  const paths = getExtensionConfigPaths(workspaceRoot);
  writeJsonAtomically(
    scope === 'user' ? paths.userMcp : paths.projectMcp,
    config
  );
}

export function loadRawHookConfig(
  scope: ExtensionSource,
  workspaceRoot: string
): HookConfigFile {
  const paths = getExtensionConfigPaths(workspaceRoot);
  const path = scope === 'user' ? paths.userHooks : paths.projectHooks;
  const raw = readJsonFile(path);
  if (raw === undefined) {
    return { schemaVersion: 1, hooks: [] };
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.hooks)
  ) {
    throw new Error(`Invalid Hooks configuration at ${path}`);
  }
  return { schemaVersion: 1, hooks: [...raw.hooks] };
}

export function saveRawHookConfig(
  scope: ExtensionSource,
  workspaceRoot: string,
  config: HookConfigFile
): void {
  const paths = getExtensionConfigPaths(workspaceRoot);
  writeJsonAtomically(
    scope === 'user' ? paths.userHooks : paths.projectHooks,
    config
  );
}

export function expandEnvironmentTemplates(
  values: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env,
  forbiddenEnvironmentNames: Iterable<string> = []
): Record<string, string> {
  const normalizeName = (name: string): string =>
    process.platform === 'win32' ? name.toUpperCase() : name;
  const forbidden = new Set(
    [...forbiddenEnvironmentNames].map(normalizeName)
  );
  const expanded: Record<string, string> = {};
  for (const [key, template] of Object.entries(values)) {
    if (forbidden.has(normalizeName(key))) {
      throw new Error(
        `Environment variable ${key} is reserved for Provider credentials`
      );
    }
    expanded[key] = template.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, name: string) => {
        if (forbidden.has(normalizeName(name))) {
          throw new Error(
            `Environment variable ${name} is reserved for Provider credentials`
          );
        }
        if (!ENVIRONMENT_NAME_PATTERN.test(name) || environment[name] === undefined) {
          throw new Error(`Required environment variable ${name} is not set`);
        }
        return environment[name]!;
      }
    );
  }
  return expanded;
}
