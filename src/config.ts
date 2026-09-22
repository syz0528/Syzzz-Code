import {
  chmodSync,
  closeSync,
  copyFileSync,
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
import { join } from 'node:path';
import { validateProviderHeaders } from './providers/headers.js';

export const CONFIG_SCHEMA_VERSION = 1 as const;
const CONFIG_DIR = join(homedir(), '.syzzz-code');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface ProviderConfigItem {
  name: string;
  type: 'anthropic' | 'openai-compatible' | 'openai-responses';
  model: string;
  models: string[];
  modelContextWindows?: Record<string, number>;
  headers?: Readonly<Record<string, string>>;
  env: {
    BASE_URL: string;
    API_KEY: string;
    API_KEY_ENV?: string;
  };
}

export interface AuditConfig {
  retentionDays: number;
  maxBytes: number;
}

export interface UiConfig {
  streamOutput: boolean;
  mode: UiMode;
  persistentHistory: boolean;
  language: UiLanguage;
  frameRate: UiFrameRate;
}

export type UiMode = 'auto' | 'tui' | 'inline';
export type UiLanguage = 'auto' | 'zh-CN' | 'en';
export type UiFrameRate = 'auto' | 30 | 60;

export interface ContextConfig {
  autoCompact: boolean;
  defaultWindowTokens: number;
}

export interface SessionsConfig {
  autoSave: boolean;
  startup: SessionStartupBehavior;
}

export type SessionStartupBehavior = 'ask' | 'new' | 'continue';

export interface SubagentsConfig {
  enabled: boolean;
}

export interface SkillsConfig {
  enabled: boolean;
  allowImplicit: boolean;
  disabled: string[];
}

export type RagAutoRetrieve = 'off' | 'ask-plan' | 'all';

export interface RagRemoteEnvironmentConfig {
  BASE_URL: string;
  API_KEY: string;
  API_KEY_ENV?: string;
}

export interface RagEmbeddingConfig {
  type: 'openai-compatible';
  model: string;
  dimensions?: number;
  env: RagRemoteEnvironmentConfig;
}

export interface RagRerankerConfig {
  type: 'jina-compatible';
  model: string;
  env: RagRemoteEnvironmentConfig;
}

export interface RagServiceConfig {
  enabled: boolean;
  baseUrl: string;
  collections: string[];
  apiKeyEnv?: string;
  timeoutMs: number;
}

export interface RagConfig {
  enabled: boolean;
  autoRetrieve: RagAutoRetrieve;
  autoRefresh: boolean;
  embedding?: RagEmbeddingConfig;
  reranker?: RagRerankerConfig;
  service?: RagServiceConfig;
}

export interface Config {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  currentProvider: string;
  providers: Record<string, ProviderConfigItem>;
  audit: AuditConfig;
  ui: UiConfig;
  context: ContextConfig;
  sessions: SessionsConfig;
  subagents: SubagentsConfig;
  skills: SkillsConfig;
  rag: RagConfig;
}

export type ConfigInspection =
  | { status: 'missing'; path: string }
  | { status: 'valid'; path: string; config: Config; legacy: boolean }
  | {
      status: 'unsupported';
      path: string;
      version: string;
      reason: string;
    }
  | { status: 'invalid'; path: string; reason: string };

export interface ConfigRepairResult {
  config: Config;
  action: 'initialized' | 'migrated' | 'repaired' | 'unchanged';
  backupPath?: string;
}

export interface ResolvedProviderCredential {
  value: string;
  source: 'environment' | 'stored' | 'missing';
  environmentVariable?: string;
}

export const DEFAULT_AUDIT_CONFIG: Readonly<AuditConfig> = Object.freeze({
  retentionDays: 30,
  maxBytes: 20 * 1024 * 1024
});

export const DEFAULT_UI_CONFIG: Readonly<UiConfig> = Object.freeze({
  streamOutput: true,
  mode: 'auto',
  persistentHistory: true,
  language: 'auto',
  frameRate: 'auto'
});

export const DEFAULT_CONTEXT_CONFIG: Readonly<ContextConfig> = Object.freeze({
  autoCompact: true,
  defaultWindowTokens: 65_536
});

export const DEFAULT_SESSIONS_CONFIG: Readonly<SessionsConfig> = Object.freeze({
  autoSave: true,
  startup: 'ask'
});

export const DEFAULT_SUBAGENTS_CONFIG: Readonly<SubagentsConfig> = Object.freeze({
  enabled: true
});

export const DEFAULT_SKILLS_CONFIG: Readonly<SkillsConfig> = Object.freeze({
  enabled: true,
  allowImplicit: true,
  disabled: []
});

export const DEFAULT_RAG_CONFIG: Readonly<RagConfig> = Object.freeze({
  enabled: true,
  autoRetrieve: 'off',
  autoRefresh: true
});

const DEFAULT_CONFIG: Config = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  currentProvider: 'deepseek',
  audit: { ...DEFAULT_AUDIT_CONFIG },
  ui: { ...DEFAULT_UI_CONFIG },
  context: { ...DEFAULT_CONTEXT_CONFIG },
  sessions: { ...DEFAULT_SESSIONS_CONFIG },
  subagents: { ...DEFAULT_SUBAGENTS_CONFIG },
  skills: { enabled: true, allowImplicit: true, disabled: [] },
  rag: { ...DEFAULT_RAG_CONFIG },
  providers: {
    deepseek: {
      name: 'Deepseek',
      type: 'openai-compatible',
      model: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      env: {
        BASE_URL: 'https://api.deepseek.com',
        API_KEY: '',
        API_KEY_ENV: 'DEEPSEEK_API_KEY'
      }
    }
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldPath} must be a non-empty string`);
  }
  return value;
}

function validateBaseURL(value: unknown, fieldPath: string): string {
  const baseURL = requireNonEmptyString(value, fieldPath);
  let parsedURL: URL;
  try {
    parsedURL = new URL(baseURL);
  } catch {
    throw new Error(`${fieldPath} must be a valid URL`);
  }
  if (parsedURL.protocol !== 'https:' && parsedURL.protocol !== 'http:') {
    throw new Error(`${fieldPath} must use http or https`);
  }
  if (parsedURL.username || parsedURL.password) {
    throw new Error(`${fieldPath} must not contain embedded credentials`);
  }
  if (parsedURL.search || parsedURL.hash) {
    throw new Error(`${fieldPath} must not contain a query or fragment`);
  }
  return baseURL.replace(/\/$/, '');
}

function validateEnvironmentVariable(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const name = requireNonEmptyString(value, fieldPath);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${fieldPath} must be a valid environment variable name`);
  }
  return name;
}

function validateAuditConfig(value: unknown): AuditConfig {
  if (value === undefined) {
    return { ...DEFAULT_AUDIT_CONFIG };
  }
  if (!isRecord(value)) {
    throw new Error('audit must be an object');
  }
  if (!Number.isInteger(value.retentionDays) || Number(value.retentionDays) < 0) {
    throw new Error('audit.retentionDays must be a non-negative integer');
  }
  if (!Number.isInteger(value.maxBytes) || Number(value.maxBytes) <= 0) {
    throw new Error('audit.maxBytes must be a positive integer');
  }
  return {
    retentionDays: Number(value.retentionDays),
    maxBytes: Number(value.maxBytes)
  };
}

function validateUiConfig(value: unknown): UiConfig {
  if (value === undefined) {
    return { ...DEFAULT_UI_CONFIG };
  }
  if (!isRecord(value)) {
    throw new Error('ui must be an object');
  }
  if (typeof value.streamOutput !== 'boolean') {
    throw new Error('ui.streamOutput must be a boolean');
  }
  const mode = value.mode ?? DEFAULT_UI_CONFIG.mode;
  if (mode !== 'auto' && mode !== 'tui' && mode !== 'inline') {
    throw new Error('ui.mode must be "auto", "tui", or "inline"');
  }
  const persistentHistory = value.persistentHistory ?? DEFAULT_UI_CONFIG.persistentHistory;
  if (typeof persistentHistory !== 'boolean') {
    throw new Error('ui.persistentHistory must be a boolean');
  }
  const language = value.language ?? DEFAULT_UI_CONFIG.language;
  if (language !== 'auto' && language !== 'zh-CN' && language !== 'en') {
    throw new Error('ui.language must be "auto", "zh-CN", or "en"');
  }
  const frameRate = value.frameRate ?? DEFAULT_UI_CONFIG.frameRate;
  if (frameRate !== 'auto' && frameRate !== 30 && frameRate !== 60) {
    throw new Error('ui.frameRate must be "auto", 30, or 60');
  }
  return { streamOutput: value.streamOutput, mode, persistentHistory, language, frameRate };
}

function validateContextConfig(value: unknown): ContextConfig {
  if (value === undefined) {
    return { ...DEFAULT_CONTEXT_CONFIG };
  }
  if (!isRecord(value)) {
    throw new Error('context must be an object');
  }
  if (typeof value.autoCompact !== 'boolean') {
    throw new Error('context.autoCompact must be a boolean');
  }
  if (
    !Number.isInteger(value.defaultWindowTokens) ||
    Number(value.defaultWindowTokens) < 16_384 ||
    Number(value.defaultWindowTokens) > 2_000_000
  ) {
    throw new Error('context.defaultWindowTokens must be an integer between 16384 and 2000000');
  }
  return {
    autoCompact: value.autoCompact,
    defaultWindowTokens: Number(value.defaultWindowTokens)
  };
}

function validateSessionsConfig(value: unknown): SessionsConfig {
  if (value === undefined) {
    return { ...DEFAULT_SESSIONS_CONFIG };
  }
  if (!isRecord(value)) {
    throw new Error('sessions must be an object');
  }
  if (typeof value.autoSave !== 'boolean') {
    throw new Error('sessions.autoSave must be a boolean');
  }
  const startup = value.startup ?? DEFAULT_SESSIONS_CONFIG.startup;
  if (startup !== 'ask' && startup !== 'new' && startup !== 'continue') {
    throw new Error('sessions.startup must be "ask", "new", or "continue"');
  }
  return { autoSave: value.autoSave, startup };
}

function validateSubagentsConfig(value: unknown): SubagentsConfig {
  if (value === undefined) {
    return { ...DEFAULT_SUBAGENTS_CONFIG };
  }
  if (!isRecord(value)) {
    throw new Error('subagents must be an object');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('subagents.enabled must be a boolean');
  }
  return { enabled: value.enabled };
}

function validateSkillsConfig(value: unknown): SkillsConfig {
  if (value === undefined) {
    return { enabled: true, allowImplicit: true, disabled: [] };
  }
  if (!isRecord(value)) {
    throw new Error('skills must be an object');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('skills.enabled must be a boolean');
  }
  if (typeof value.allowImplicit !== 'boolean') {
    throw new Error('skills.allowImplicit must be a boolean');
  }
  if (!Array.isArray(value.disabled)) {
    throw new Error('skills.disabled must be an array');
  }
  const disabled = value.disabled.map((name, index) =>
    requireNonEmptyString(name, `skills.disabled[${index}]`)
  );
  if (new Set(disabled).size !== disabled.length) {
    throw new Error('skills.disabled must not contain duplicates');
  }
  return {
    enabled: value.enabled,
    allowImplicit: value.allowImplicit,
    disabled
  };
}

function validateRagRemoteEnvironment(
  value: unknown,
  fieldPath: string
): RagRemoteEnvironmentConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }
  const apiKeyEnvironment = validateEnvironmentVariable(
    value.API_KEY_ENV,
    `${fieldPath}.API_KEY_ENV`
  );
  return {
    BASE_URL: validateBaseURL(value.BASE_URL, `${fieldPath}.BASE_URL`),
    API_KEY: typeof value.API_KEY === 'string' ? value.API_KEY : '',
    ...(apiKeyEnvironment ? { API_KEY_ENV: apiKeyEnvironment } : {})
  };
}

function validateRagConfig(value: unknown): RagConfig {
  if (value === undefined) {
    return { ...DEFAULT_RAG_CONFIG };
  }
  if (!isRecord(value)) {
    throw new Error('rag must be an object');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('rag.enabled must be a boolean');
  }
  const autoRetrieve = value.autoRetrieve ?? DEFAULT_RAG_CONFIG.autoRetrieve;
  if (autoRetrieve !== 'off' && autoRetrieve !== 'ask-plan' && autoRetrieve !== 'all') {
    throw new Error('rag.autoRetrieve must be "off", "ask-plan", or "all"');
  }
  const autoRefresh = value.autoRefresh ?? DEFAULT_RAG_CONFIG.autoRefresh;
  if (typeof autoRefresh !== 'boolean') {
    throw new Error('rag.autoRefresh must be a boolean');
  }

  let service: RagServiceConfig | undefined;
  if (value.service !== undefined) {
    const remote = value.service;
    if (!isRecord(remote) || typeof remote.enabled !== 'boolean') {
      throw new Error('rag.service.enabled must be a boolean');
    }
    if (
      !Array.isArray(remote.collections) ||
      remote.collections.length < 1 ||
      remote.collections.length > 16 ||
      remote.collections.some(
        (name) => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
      )
    ) {
      throw new Error('rag.service.collections must contain 1 to 16 collection names');
    }
    const timeoutMs = remote.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > 120_000) {
      throw new Error('rag.service.timeoutMs must be between 100 and 120000');
    }
    const apiKeyEnv = validateEnvironmentVariable(remote.apiKeyEnv, 'rag.service.apiKeyEnv');
    service = {
      enabled: remote.enabled,
      baseUrl: validateBaseURL(remote.baseUrl, 'rag.service.baseUrl'),
      collections: [...new Set(remote.collections as string[])],
      timeoutMs: Number(timeoutMs),
      ...(apiKeyEnv ? { apiKeyEnv } : {})
    };
  }

  let embedding: RagEmbeddingConfig | undefined;
  if (value.embedding !== undefined) {
    if (!isRecord(value.embedding) || value.embedding.type !== 'openai-compatible') {
      throw new Error('rag.embedding.type must be "openai-compatible"');
    }
    const dimensions = value.embedding.dimensions;
    if (
      dimensions !== undefined &&
      (!Number.isSafeInteger(dimensions) || Number(dimensions) < 1 || Number(dimensions) > 65_536)
    ) {
      throw new Error('rag.embedding.dimensions must be an integer between 1 and 65536');
    }
    embedding = {
      type: 'openai-compatible',
      model: requireNonEmptyString(value.embedding.model, 'rag.embedding.model'),
      ...(dimensions === undefined ? {} : { dimensions: Number(dimensions) }),
      env: validateRagRemoteEnvironment(value.embedding.env, 'rag.embedding.env')
    };
  }

  let reranker: RagRerankerConfig | undefined;
  if (value.reranker !== undefined) {
    if (!isRecord(value.reranker) || value.reranker.type !== 'jina-compatible') {
      throw new Error('rag.reranker.type must be "jina-compatible"');
    }
    reranker = {
      type: 'jina-compatible',
      model: requireNonEmptyString(value.reranker.model, 'rag.reranker.model'),
      env: validateRagRemoteEnvironment(value.reranker.env, 'rag.reranker.env')
    };
  }

  return {
    enabled: value.enabled,
    autoRetrieve,
    autoRefresh,
    ...(service ? { service } : {}),
    ...(embedding ? { embedding } : {}),
    ...(reranker ? { reranker } : {})
  };
}

export function validateConfig(value: unknown): Config {
  if (!isRecord(value)) {
    throw new Error('configuration root must be an object');
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`unsupported configuration schemaVersion: ${String(value.schemaVersion)}`);
  }

  const currentProvider = requireNonEmptyString(value.currentProvider, 'currentProvider');
  if (!isRecord(value.providers)) {
    throw new Error('providers must be an object');
  }

  const providers: Record<string, ProviderConfigItem> = {};
  for (const [providerId, providerValue] of Object.entries(value.providers)) {
    const providerPath = `providers.${providerId}`;
    if (!isRecord(providerValue)) {
      throw new Error(`${providerPath} must be an object`);
    }
    const type = requireNonEmptyString(providerValue.type, `${providerPath}.type`);
    if (type !== 'anthropic' && type !== 'openai-compatible' && type !== 'openai-responses') {
      throw new Error(
        `${providerPath}.type must be "anthropic", "openai-compatible", or "openai-responses"`
      );
    }
    if (!Array.isArray(providerValue.models) || providerValue.models.length === 0) {
      throw new Error(`${providerPath}.models must contain at least one model`);
    }
    const models = providerValue.models.map((model, index) =>
      requireNonEmptyString(model, `${providerPath}.models[${index}]`)
    );
    const model = requireNonEmptyString(providerValue.model, `${providerPath}.model`);
    if (!models.includes(model)) {
      throw new Error(`${providerPath}.model must be included in ${providerPath}.models`);
    }
    if (!isRecord(providerValue.env)) {
      throw new Error(`${providerPath}.env must be an object`);
    }

    let modelContextWindows: Record<string, number> | undefined;
    if (providerValue.modelContextWindows !== undefined) {
      if (!isRecord(providerValue.modelContextWindows)) {
        throw new Error(`${providerPath}.modelContextWindows must be an object`);
      }
      modelContextWindows = {};
      for (const [modelId, windowTokens] of Object.entries(providerValue.modelContextWindows)) {
        if (!models.includes(modelId)) {
          throw new Error(
            `${providerPath}.modelContextWindows.${modelId} is not a configured model`
          );
        }
        if (
          !Number.isInteger(windowTokens) ||
          Number(windowTokens) < 16_384 ||
          Number(windowTokens) > 2_000_000
        ) {
          throw new Error(
            `${providerPath}.modelContextWindows.${modelId} must be an integer between 16384 and 2000000`
          );
        }
        modelContextWindows[modelId] = Number(windowTokens);
      }
    }

    const apiKeyEnvironment = validateEnvironmentVariable(
      providerValue.env.API_KEY_ENV,
      `${providerPath}.env.API_KEY_ENV`
    );
    const headers = validateProviderHeaders(providerValue.headers, `${providerPath}.headers`);
    providers[providerId] = {
      name: requireNonEmptyString(providerValue.name, `${providerPath}.name`),
      type,
      model,
      models,
      ...(modelContextWindows ? { modelContextWindows } : {}),
      ...(headers ? { headers } : {}),
      env: {
        BASE_URL: validateBaseURL(providerValue.env.BASE_URL, `${providerPath}.env.BASE_URL`),
        API_KEY: typeof providerValue.env.API_KEY === 'string' ? providerValue.env.API_KEY : '',
        ...(apiKeyEnvironment ? { API_KEY_ENV: apiKeyEnvironment } : {})
      }
    };
  }

  if (!providers[currentProvider]) {
    throw new Error(`currentProvider "${currentProvider}" does not exist in providers`);
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    currentProvider,
    providers,
    audit: validateAuditConfig(value.audit),
    ui: validateUiConfig(value.ui),
    context: validateContextConfig(value.context),
    sessions: validateSessionsConfig(value.sessions),
    subagents: validateSubagentsConfig(value.subagents),
    skills: validateSkillsConfig(value.skills),
    rag: validateRagConfig(value.rag)
  };
}

export function resolveProviderCredential(
  provider: Pick<ProviderConfigItem, 'env'>,
  environment: NodeJS.ProcessEnv = process.env
): ResolvedProviderCredential {
  const environmentVariable = provider.env.API_KEY_ENV;
  const environmentValue = environmentVariable
    ? environment[environmentVariable]?.trim()
    : undefined;
  if (environmentValue) {
    return {
      value: environmentValue,
      source: 'environment',
      environmentVariable
    };
  }
  const storedValue = provider.env.API_KEY.trim();
  if (storedValue) {
    return {
      value: storedValue,
      source: 'stored',
      ...(environmentVariable ? { environmentVariable } : {})
    };
  }
  return {
    value: '',
    source: 'missing',
    ...(environmentVariable ? { environmentVariable } : {})
  };
}

export function getConfigDirectory(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getDefaultConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    // Windows ACLs are diagnosed separately by `syzzz doctor`.
  }
}

function backupConfig(suffix = 'bak'): string {
  ensureConfigDir();
  const backupPath = `${CONFIG_FILE}.${Date.now()}.${randomUUID()}.${suffix}`;
  copyFileSync(CONFIG_FILE, backupPath);
  try {
    chmodSync(backupPath, 0o600);
  } catch {
    // Best effort; doctor reports permission limitations.
  }
  return backupPath;
}

export function inspectConfig(): ConfigInspection {
  if (!existsSync(CONFIG_FILE)) {
    return { status: 'missing', path: CONFIG_FILE };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as unknown;
  } catch (error) {
    return {
      status: 'invalid',
      path: CONFIG_FILE,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  if (
    isRecord(raw) &&
    raw.schemaVersion !== undefined &&
    raw.schemaVersion !== CONFIG_SCHEMA_VERSION
  ) {
    const version =
      typeof raw.schemaVersion === 'number' && Number.isSafeInteger(raw.schemaVersion)
        ? String(raw.schemaVersion)
        : 'unknown';
    return {
      status: 'unsupported',
      path: CONFIG_FILE,
      version,
      reason: `configuration schemaVersion ${version} is not supported by this build`
    };
  }
  try {
    const legacy = isRecord(raw) && raw.schemaVersion === undefined;
    return {
      status: 'valid',
      path: CONFIG_FILE,
      config: validateConfig(raw),
      legacy
    };
  } catch (error) {
    return {
      status: 'invalid',
      path: CONFIG_FILE,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  const inspection = inspectConfig();
  if (inspection.status === 'missing') {
    const config = getDefaultConfig();
    saveConfig(config);
    return config;
  }
  if (inspection.status === 'unsupported') {
    throw new Error(
      `Configuration at ${CONFIG_FILE} uses unsupported schemaVersion ` +
        `${inspection.version}. Upgrade Syzzz Code before opening this config; ` +
        'it was not modified.'
    );
  }
  if (inspection.status === 'invalid') {
    throw new Error(
      `Invalid configuration at ${CONFIG_FILE}: ${inspection.reason}. ` +
        'Run "syzzz doctor" for repair guidance.'
    );
  }
  if (inspection.legacy) {
    backupConfig('pre-v1.bak');
    saveConfig(inspection.config);
  }
  return inspection.config;
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  const validatedConfig = validateConfig(config);
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryFile, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(validatedConfig, null, 2)}\n`, {
      encoding: 'utf8'
    });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryFile, CONFIG_FILE);
    try {
      chmodSync(CONFIG_FILE, 0o600);
    } catch {
      // Windows ACLs are diagnosed separately by `syzzz doctor`.
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporaryFile)) {
      unlinkSync(temporaryFile);
    }
  }
}

export function repairConfig(): ConfigRepairResult {
  ensureConfigDir();
  const inspection = inspectConfig();
  if (inspection.status === 'unsupported') {
    throw new Error(
      `Refusing to overwrite unsupported configuration schemaVersion ` +
        `${inspection.version}; upgrade Syzzz Code instead`
    );
  }
  if (inspection.status === 'valid') {
    if (!inspection.legacy) {
      return {
        config: inspection.config,
        action: 'unchanged'
      };
    }
    const backupPath = backupConfig('pre-v1.bak');
    saveConfig(inspection.config);
    return {
      config: inspection.config,
      action: 'migrated',
      backupPath
    };
  }
  if (inspection.status === 'missing') {
    const config = getDefaultConfig();
    saveConfig(config);
    return {
      config,
      action: 'initialized'
    };
  }

  const backupPath = backupConfig('invalid.bak');
  const config = getDefaultConfig();
  saveConfig(config);
  return {
    config,
    action: 'repaired',
    backupPath
  };
}

export function getCurrentProviderConfig(): ProviderConfigItem {
  const config = loadConfig();
  const current = config.providers[config.currentProvider];
  if (!current) {
    throw new Error(`Provider ${config.currentProvider} not found in configuration`);
  }
  return current;
}
