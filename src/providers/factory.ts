// Provider Factory - 根据配置创建对应的 Provider
import type { AIProvider } from './base.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';

export interface ProviderConfig {
  name: string;
  type: 'anthropic' | 'openai-compatible';
  model: string;
  env: {
    BASE_URL: string;
    API_KEY: string;
  };
}

export function createProvider(config: ProviderConfig): AIProvider {
  const { name, type, model, env } = config;
  const { BASE_URL, API_KEY } = env;

  if (!API_KEY) {
    throw new Error(`API Key not set for provider: ${name}`);
  }

  if (type === 'anthropic') {
    return new AnthropicProvider(API_KEY, BASE_URL, model);
  } else {
    // openai-compatible
    return new OpenAICompatibleProvider(API_KEY, BASE_URL, model, name);
  }
}
