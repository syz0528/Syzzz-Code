import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import type { Config } from './types.js';

// 加载 .env 文件
dotenvConfig();

const CONFIG_DIR = join(homedir(), '.syzzz-code');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Config = {
  model: 'claude-3-5-sonnet-20241022',
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
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
}

export function getApiKey(): string {
  const config = loadConfig();
  
  // 优先级：1. 配置文件 2. 环境变量
  if (config.apiKey) return config.apiKey;
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  
  return '';
}
