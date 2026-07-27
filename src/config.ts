import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.syzzz-code');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface ProviderConfigItem {
  name: string;
  type: 'anthropic' | 'openai-compatible';
  model: string;
  models: string[];
  modelContextWindows?: Record<string, number>;
  env: {
    BASE_URL: string;
    API_KEY: string;
  };
}

export interface AuditConfig {
  retentionDays: number;
  maxBytes: number;
}

export interface UiConfig {
  streamOutput: boolean;
}

export interface ContextConfig {
  autoCompact: boolean;
  defaultWindowTokens: number;
}

export const DEFAULT_AUDIT_CONFIG: Readonly<AuditConfig> = Object.freeze({
  retentionDays: 30,
  maxBytes: 20 * 1024 * 1024
});

export const DEFAULT_UI_CONFIG: Readonly<UiConfig> = Object.freeze({
  streamOutput: true
});

export const DEFAULT_CONTEXT_CONFIG: Readonly<ContextConfig> = Object.freeze({
  autoCompact: true,
  defaultWindowTokens: 65_536
});

export interface Config {
  currentProvider: string;
  providers: {
    [key: string]: ProviderConfigItem;
  };
  audit: AuditConfig;
  ui: UiConfig;
  context: ContextConfig;
}

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

  return baseURL.replace(/\/$/, '');
}

function validateAuditConfig(value: unknown): AuditConfig {
  if (value === undefined) {
    return { ...DEFAULT_AUDIT_CONFIG };
  }
  if (!isRecord(value)) {
    throw new Error('audit must be an object');
  }

  const retentionDays = value.retentionDays;
  if (!Number.isInteger(retentionDays) || (retentionDays as number) < 0) {
    throw new Error('audit.retentionDays must be a non-negative integer');
  }

  const maxBytes = value.maxBytes;
  if (!Number.isInteger(maxBytes) || (maxBytes as number) <= 0) {
    throw new Error('audit.maxBytes must be a positive integer');
  }

  return {
    retentionDays: retentionDays as number,
    maxBytes: maxBytes as number
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

  return { streamOutput: value.streamOutput };
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
    throw new Error(
      'context.defaultWindowTokens must be an integer between 16384 and 2000000'
    );
  }
  return {
    autoCompact: value.autoCompact,
    defaultWindowTokens: Number(value.defaultWindowTokens)
  };
}

export function validateConfig(value: unknown): Config {
  if (!isRecord(value)) {
    throw new Error('configuration root must be an object');
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
    if (type !== 'anthropic' && type !== 'openai-compatible') {
      throw new Error(`${providerPath}.type must be "anthropic" or "openai-compatible"`);
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
      for (const [modelId, windowTokens] of Object.entries(
        providerValue.modelContextWindows
      )) {
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

    providers[providerId] = {
      name: requireNonEmptyString(providerValue.name, `${providerPath}.name`),
      type,
      model,
      models,
      ...(modelContextWindows ? { modelContextWindows } : {}),
      env: {
        BASE_URL: validateBaseURL(providerValue.env.BASE_URL, `${providerPath}.env.BASE_URL`),
        API_KEY: typeof providerValue.env.API_KEY === 'string' ? providerValue.env.API_KEY : ''
      }
    };
  }

  if (!providers[currentProvider]) {
    throw new Error(`currentProvider "${currentProvider}" does not exist in providers`);
  }

  return {
    currentProvider,
    providers,
    audit: validateAuditConfig(value.audit),
    ui: validateUiConfig(value.ui),
    context: validateContextConfig(value.context)
  };
}

const DEFAULT_CONFIG: Config = {
  currentProvider: 'deepseek',
  audit: { ...DEFAULT_AUDIT_CONFIG },
  ui: { ...DEFAULT_UI_CONFIG },
  context: { ...DEFAULT_CONTEXT_CONFIG },
  providers: {
    deepseek: {
      name: 'Deepseek',
      type: 'openai-compatible',
      model: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      env: {
        BASE_URL: 'https://api.deepseek.com',
        API_KEY: ''
      }
    }
  }
};

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    return validateConfig(JSON.parse(content));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid configuration at ${CONFIG_FILE}: ${reason}`);
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  const validatedConfig = validateConfig(config);
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;

  try {
    writeFileSync(temporaryFile, `${JSON.stringify(validatedConfig, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    });
    renameSync(temporaryFile, CONFIG_FILE);
  } finally {
    if (existsSync(temporaryFile)) {
      unlinkSync(temporaryFile);
    }
  }
}

// 获取当前使用的 Provider 配置
export function getCurrentProviderConfig(): ProviderConfigItem {
  const config = loadConfig();
  const current = config.providers[config.currentProvider];
  
  if (!current) {
    throw new Error(`Provider ${config.currentProvider} not found in config`);
  }
  
  return current;
}
