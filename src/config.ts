import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import type { Config } from './types.js';
import { getProvider, getModel } from './providers/registry.js';

// 加载 .env 文件
dotenvConfig();

const CONFIG_DIR = join(homedir(), '.syzzz-code');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Config = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  maxTokens: 8192,
  temperature: 1.0
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
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const loaded = JSON.parse(content);
    
    // 确保数字类型正确
    return {
      ...DEFAULT_CONFIG,
      ...loaded,
      maxTokens: typeof loaded.maxTokens === 'string' ? parseInt(loaded.maxTokens) : loaded.maxTokens,
      temperature: typeof loaded.temperature === 'string' ? parseFloat(loaded.temperature) : loaded.temperature
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: Partial<Config>): void {
  ensureConfigDir();
  const current = existsSync(CONFIG_FILE) ? loadConfig() : DEFAULT_CONFIG;
  const updated = { ...current, ...config };
  
  // 验证配置
  if (updated.provider && updated.model) {
    const providerConfig = getProvider(updated.provider);
    if (!providerConfig) {
      throw new Error(`Unknown provider: ${updated.provider}`);
    }
    
    const modelConfig = getModel(updated.provider, updated.model);
    if (!modelConfig) {
      throw new Error(`Model ${updated.model} not found for provider ${updated.provider}`);
    }
  }
  
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
}

export function getApiKey(): string {
  const config = loadConfig();
  
  // 优先级：1. 配置文件 2. 环境变量（支持多种命名）
  if (config.apiKey) return config.apiKey;
  
  // 根据 provider 尝试不同的环境变量名
  const provider = config.provider;
  
  // Anthropic
  if (provider === 'anthropic') {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  }
  
  // OpenAI 系列
  if (provider === 'openai') {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  }
  
  // Deepseek
  if (provider === 'deepseek') {
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  }
  
  // Moonshot
  if (provider === 'moonshot') {
    if (process.env.MOONSHOT_API_KEY) return process.env.MOONSHOT_API_KEY;
  }
  
  // 通用环境变量
  if (process.env.AI_API_KEY) return process.env.AI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  
  return '';
}

// 获取当前 provider 配置
export function getCurrentProviderConfig() {
  const config = loadConfig();
  return getProvider(config.provider);
}

// 获取当前 model 配置
export function getCurrentModelConfig() {
  const config = loadConfig();
  return getModel(config.provider, config.model);
}
