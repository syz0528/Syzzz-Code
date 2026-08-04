// Provider Factory - 根据配置创建对应的 Provider
import type { AIProvider } from './base.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { AnthropicProvider } from './anthropic.js';
import { resolveProviderCredential } from '../config.js';

export interface ProviderConfig {
  name: string;
  type: 'anthropic' | 'openai-compatible' | 'openai-responses';
  model: string;
  modelContextWindows?: Record<string, number>;
  env: {
    BASE_URL: string;
    API_KEY: string;
    API_KEY_ENV?: string;
  };
}

export function createProvider(
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv = process.env
): AIProvider {
  const { name, type, model, modelContextWindows, env } = config;
  const { BASE_URL } = env;
  const API_KEY = resolveProviderCredential(config, environment).value;

  if (!API_KEY) {
    throw new Error(`API Key not set for provider: ${name}`);
  }

  if (type === 'anthropic') {
    return new AnthropicProvider(API_KEY, BASE_URL, model, modelContextWindows);
  }
  if (type === 'openai-responses') {
    return new OpenAIResponsesProvider(API_KEY, BASE_URL, model, name, modelContextWindows);
  }
  return new OpenAICompatibleProvider(
    API_KEY,
    BASE_URL,
    model,
    name,
    undefined,
    modelContextWindows
  );
}
