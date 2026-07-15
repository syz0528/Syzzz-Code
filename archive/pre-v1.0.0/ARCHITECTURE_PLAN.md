# 🏗️ Syzzz Code - 架构重构计划

## 当前架构问题

### 硬编码的 Anthropic SDK

```typescript
// src/engine.ts - 当前实现
import Anthropic from '@anthropic-ai/sdk';

export class QueryEngine {
  private client: Anthropic | null = null;  // ❌ 硬编码类型
  
  async chat(userMessage: string): Promise<string> {
    const result = await this.client.messages.create({
      model: config.model,
      tools: this.tools,  // Anthropic 专属格式
      // ...
    });
  }
}
```

**问题**：
- 无法支持其他 AI 厂商（Deepseek、OpenAI 等）
- API 格式不兼容
- Tool calling 规范不同

---

## 目标架构：Provider 抽象层

### 1. 核心接口设计

```typescript
// src/providers/base.ts
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export interface AIProvider {
  // 基础对话
  chat(messages: ChatMessage[], tools: Tool[]): Promise<ChatResponse>;
  
  // 流式对话
  streamChat(
    messages: ChatMessage[], 
    tools: Tool[]
  ): AsyncIterator<ChatChunk>;
  
  // 获取 provider 信息
  getInfo(): {
    name: string;
    supportedModels: string[];
  };
}
```

### 2. Provider 实现

#### AnthropicProvider

```typescript
// src/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, ChatMessage, ChatResponse } from './base.js';

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  
  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL });
  }
  
  async chat(messages: ChatMessage[], tools: Tool[]): Promise<ChatResponse> {
    // 转换为 Anthropic 格式
    const anthropicMessages = this.convertMessages(messages);
    const anthropicTools = this.convertTools(tools);
    
    const result = await this.client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: anthropicMessages,
      tools: anthropicTools,
      system: this.getSystemPrompt()
    });
    
    // 转换回统一格式
    return this.convertResponse(result);
  }
  
  async *streamChat(messages: ChatMessage[], tools: Tool[]) {
    const stream = await this.client.messages.stream({...});
    
    for await (const chunk of stream) {
      yield this.convertChunk(chunk);
    }
  }
  
  private convertMessages(messages: ChatMessage[]) {
    // 格式转换逻辑
  }
  
  private convertTools(tools: Tool[]) {
    // 工具格式转换
  }
  
  getInfo() {
    return {
      name: 'Anthropic Claude',
      supportedModels: [
        'claude-opus-4-20250514',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022'
      ]
    };
  }
}
```

#### DeepseekProvider

```typescript
// src/providers/deepseek.ts
import OpenAI from 'openai';
import { AIProvider, ChatMessage, ChatResponse } from './base.js';

export class DeepseekProvider implements AIProvider {
  private client: OpenAI;
  
  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.deepseek.com'
    });
  }
  
  async chat(messages: ChatMessage[], tools: Tool[]): Promise<ChatResponse> {
    // 转换为 OpenAI 格式
    const openaiMessages = this.convertMessages(messages);
    const openaiTools = this.convertTools(tools);
    
    const result = await this.client.chat.completions.create({
      model: config.model,
      messages: openaiMessages,
      tools: openaiTools,
      temperature: config.temperature
    });
    
    // 转换回统一格式
    return this.convertResponse(result);
  }
  
  async *streamChat(messages: ChatMessage[], tools: Tool[]) {
    const stream = await this.client.chat.completions.create({
      stream: true,
      // ...
    });
    
    for await (const chunk of stream) {
      yield this.convertChunk(chunk);
    }
  }
  
  getInfo() {
    return {
      name: 'Deepseek',
      supportedModels: [
        'deepseek-chat',
        'deepseek-reasoner'
      ]
    };
  }
}
```

#### OpenAIProvider

```typescript
// src/providers/openai.ts
import OpenAI from 'openai';
import { AIProvider } from './base.js';

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }
  
  // 实现类似 DeepseekProvider，但 baseURL 不同
  
  getInfo() {
    return {
      name: 'OpenAI',
      supportedModels: [
        'gpt-4-turbo',
        'gpt-4o',
        'gpt-4o-mini'
      ]
    };
  }
}
```

### 3. Provider Factory

```typescript
// src/providers/factory.ts
import { AIProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { DeepseekProvider } from './deepseek.js';
import { OpenAIProvider } from './openai.js';

export type ProviderType = 'anthropic' | 'deepseek' | 'openai';

export function createProvider(
  type: ProviderType,
  apiKey: string,
  baseURL?: string
): AIProvider {
  switch (type) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, baseURL);
    case 'deepseek':
      return new DeepseekProvider(apiKey);
    case 'openai':
      return new OpenAIProvider(apiKey);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}
```

### 4. 更新 QueryEngine

```typescript
// src/engine.ts - 重构后
import { AIProvider } from './providers/base.js';
import { createProvider } from './providers/factory.js';

export class QueryEngine {
  private provider: AIProvider;
  private messages: Message[] = [];
  private tools: Tool[];

  constructor() {
    const config = loadConfig();
    const apiKey = getApiKey();
    
    if (!apiKey) {
      throw new Error('No API key found');
    }
    
    // ✅ 根据配置创建 provider
    this.provider = createProvider(
      config.provider,
      apiKey,
      config.baseURL
    );
    
    this.tools = allTools;
  }

  async chat(userMessage: string): Promise<string> {
    this.messages.push({
      role: 'user',
      content: userMessage
    });

    let response = '';

    while (true) {
      // ✅ 使用统一接口
      const result = await this.provider.chat(this.messages, this.tools);
      
      response += result.content;
      
      // 处理工具调用
      if (result.toolCalls && result.toolCalls.length > 0) {
        const toolResults = await this.executeTools(result.toolCalls);
        this.messages.push({
          role: 'assistant',
          content: result.content
        });
        this.messages.push({
          role: 'user',
          content: toolResults
        });
        continue;
      }
      
      break;
    }

    return response;
  }
  
  async executeTools(toolCalls: ToolCall[]) {
    // 执行工具并返回结果
  }
}
```

### 5. 配置结构

```typescript
// src/types.ts - 更新配置
export interface Config {
  provider: 'anthropic' | 'deepseek' | 'openai';
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens: number;
  temperature: number;
}

// src/config.ts - 更新默认配置
const DEFAULT_CONFIG: Config = {
  provider: 'deepseek',  // 默认使用 Deepseek
  model: 'deepseek-chat',
  maxTokens: 8192,
  temperature: 1.0
};
```

### 6. CLI 更新

```typescript
// src/index.ts - 添加 provider 选择
program
  .command('provider')
  .description('Select AI provider')
  .action(() => {
    console.log('Available providers:\n');
    console.log('1. deepseek   - Deepseek (recommended, cheaper)');
    console.log('2. anthropic  - Claude (powerful)');
    console.log('3. openai     - OpenAI GPT-4\n');
    
    rl.question('Select provider (1, 2, or 3): ', (answer) => {
      const providers = ['deepseek', 'anthropic', 'openai'];
      const choice = parseInt(answer.trim());
      
      if (choice >= 1 && choice <= 3) {
        const provider = providers[choice - 1];
        saveConfig({ provider });
        console.log(`✓ Provider set to: ${provider}`);
        
        // 提示设置对应的模型
        console.log('\nNow run: syzzz model');
      }
    });
  });

program
  .command('model')
  .description('Select AI model')
  .action(() => {
    const config = loadConfig();
    
    // 根据 provider 显示对应的模型列表
    const modelsByProvider = {
      deepseek: ['deepseek-chat', 'deepseek-reasoner'],
      anthropic: [
        'claude-opus-4-20250514',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022'
      ],
      openai: ['gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini']
    };
    
    const models = modelsByProvider[config.provider];
    console.log(`Available models for ${config.provider}:\n`);
    models.forEach((m, i) => {
      console.log(`${i + 1}. ${m}`);
    });
    
    // 选择逻辑...
  });
```

---

## 实施步骤

### Step 1: 创建基础接口（1小时）
- [ ] 创建 `src/providers/base.ts`
- [ ] 定义 `AIProvider` 接口
- [ ] 定义统一的消息和响应格式

### Step 2: 实现 DeepseekProvider（2-3小时）
- [ ] 创建 `src/providers/deepseek.ts`
- [ ] 实现 `chat()` 方法
- [ ] 实现消息格式转换
- [ ] 实现工具调用转换
- [ ] 测试基本对话

### Step 3: 实现 AnthropicProvider（2-3小时）
- [ ] 创建 `src/providers/anthropic.ts`
- [ ] 将现有代码迁移过来
- [ ] 实现接口方法
- [ ] 测试

### Step 4: 创建 Factory（30分钟）
- [ ] 创建 `src/providers/factory.ts`
- [ ] 实现 provider 创建逻辑

### Step 5: 重构 QueryEngine（1-2小时）
- [ ] 更新 `src/engine.ts`
- [ ] 使用 Provider 接口
- [ ] 移除硬编码的 Anthropic 调用
- [ ] 测试

### Step 6: 更新配置和 CLI（1小时）
- [ ] 更新 `src/types.ts`
- [ ] 更新 `src/config.ts`
- [ ] 添加 `provider` 命令
- [ ] 更新 `model` 命令

### Step 7: 测试和文档（2小时）
- [ ] 测试所有 provider
- [ ] 更新 README
- [ ] 添加使用示例
- [ ] 录制演示

**总时间估计：8-12小时（1-2天）**

---

## 关键技术点

### 1. Tool Calling 格式差异

**Anthropic 格式**：
```json
{
  "tools": [
    {
      "name": "Read",
      "description": "...",
      "input_schema": { "type": "object", "properties": {...} }
    }
  ]
}
```

**OpenAI 格式**：
```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "Read",
        "description": "...",
        "parameters": { "type": "object", "properties": {...} }
      }
    }
  ]
}
```

### 2. 响应格式差异

**Anthropic**：
```typescript
{
  content: [
    { type: 'text', text: '...' },
    { type: 'tool_use', id: '...', name: '...', input: {...} }
  ],
  stop_reason: 'end_turn'
}
```

**OpenAI**：
```typescript
{
  choices: [{
    message: {
      content: '...',
      tool_calls: [
        { id: '...', function: { name: '...', arguments: '...' } }
      ]
    },
    finish_reason: 'stop'
  }]
}
```

### 3. 格式转换策略

创建转换器类：
```typescript
// src/providers/converters.ts
export class MessageConverter {
  static toAnthropic(message: ChatMessage) { ... }
  static toOpenAI(message: ChatMessage) { ... }
  static fromAnthropic(response: any): ChatResponse { ... }
  static fromOpenAI(response: any): ChatResponse { ... }
}

export class ToolConverter {
  static toAnthropic(tool: Tool) { ... }
  static toOpenAI(tool: Tool) { ... }
}
```

---

## 成功标准

### 功能验证
- [ ] Deepseek API 可以正常对话
- [ ] Anthropic API 可以正常对话
- [ ] 工具调用在两个 provider 都正常
- [ ] 可以通过配置切换 provider
- [ ] 错误处理正确

### 代码质量
- [ ] TypeScript 无类型错误
- [ ] 接口设计清晰
- [ ] 代码有适当注释
- [ ] 遵循 SOLID 原则

### 文档完整
- [ ] README 包含 provider 说明
- [ ] 有配置示例
- [ ] 有使用示例
- [ ] 有架构图

---

## 面试讲解要点

### 1. 为什么用 Provider 模式？
- 不同 AI 厂商 API 不兼容
- 需要支持多个模型
- 符合开闭原则（对扩展开放，对修改关闭）

### 2. 如何处理差异？
- 定义统一接口
- 各 provider 实现接口
- 转换器处理格式差异

### 3. 如何扩展？
- 实现 AIProvider 接口
- 添加到 factory
- 更新配置

### 4. 权衡考虑？
- 抽象层增加复杂度
- 但带来了灵活性
- 便于测试（可以 mock provider）

---

**下次对话时，从这里开始实施！** 🚀
