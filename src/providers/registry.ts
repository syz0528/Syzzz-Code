// 厂商注册表 - 用户友好的配置中心

export interface ProviderConfig {
  id: string;               // 厂商唯一标识
  name: string;             // 显示名称
  type: 'anthropic' | 'openai-compatible';  // Provider 类型
  baseURL: string;          // API 地址
  models: ModelConfig[];    // 支持的模型列表
  description?: string;     // 描述
  homepage?: string;        // 官网
}

export interface ModelConfig {
  id: string;               // 模型 ID
  name: string;             // 显示名称
  description?: string;     // 描述
  pricing?: {
    input: number;          // 输入价格（每百万 token）
    output: number;         // 输出价格（每百万 token）
  };
}

// 🎯 内置厂商配置（开箱即用）
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'Deepseek',
    type: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    description: '性价比最高的中文 AI',
    homepage: 'https://platform.deepseek.com',
    models: [
      {
        id: 'deepseek-chat',
        name: 'Deepseek Chat',
        description: '通用对话模型',
        pricing: { input: 1, output: 2 }
      },
      {
        id: 'deepseek-reasoner',
        name: 'Deepseek Reasoner',
        description: '推理增强模型',
        pricing: { input: 1, output: 2 }
      }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    description: '最强大的 AI 模型',
    homepage: 'https://console.anthropic.com',
    models: [
      {
        id: 'claude-opus-4-20250514',
        name: 'Claude Opus 4',
        description: '最强大，最智能',
        pricing: { input: 15, output: 75 }
      },
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude Sonnet 3.5',
        description: '平衡性能和成本（推荐）',
        pricing: { input: 3, output: 15 }
      },
      {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude Haiku 3.5',
        description: '快速且经济',
        pricing: { input: 0.8, output: 4 }
      }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    description: 'GPT 系列模型',
    homepage: 'https://platform.openai.com',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: '多模态旗舰模型',
        pricing: { input: 2.5, output: 10 }
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        description: '轻量快速版本',
        pricing: { input: 0.15, output: 0.6 }
      }
    ]
  },
  {
    id: 'moonshot',
    name: '月之暗面 Moonshot',
    type: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    description: '国产长文本 AI',
    homepage: 'https://platform.moonshot.cn',
    models: [
      {
        id: 'moonshot-v1-8k',
        name: 'Moonshot 8K',
        description: '8K 上下文',
        pricing: { input: 12, output: 12 }
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Moonshot 32K',
        description: '32K 上下文',
        pricing: { input: 24, output: 24 }
      }
    ]
  }
];

// 🔍 工具函数
export function getProvider(id: string): ProviderConfig | undefined {
  return BUILTIN_PROVIDERS.find(p => p.id === id);
}

export function getModel(providerId: string, modelId: string): ModelConfig | undefined {
  const provider = getProvider(providerId);
  return provider?.models.find(m => m.id === modelId);
}

export function listProviders(): ProviderConfig[] {
  return BUILTIN_PROVIDERS;
}

export function listModels(providerId: string): ModelConfig[] {
  const provider = getProvider(providerId);
  return provider?.models || [];
}

// 🎨 格式化显示
export function formatProviderInfo(config: ProviderConfig): string {
  let info = `${config.name}`;
  if (config.description) {
    info += ` - ${config.description}`;
  }
  return info;
}

export function formatModelInfo(model: ModelConfig): string {
  let info = `${model.name}`;
  if (model.description) {
    info += ` - ${model.description}`;
  }
  if (model.pricing) {
    const cost = model.pricing.input + model.pricing.output;
    info += ` ($${cost}/M tokens)`;
  }
  return info;
}
