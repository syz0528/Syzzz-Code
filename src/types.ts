export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (input: any) => Promise<string>;
}

export interface ChatSession {
  id: string;
  messages: Message[];
  model: string;
  createdAt: Date;
}

export interface Config {
  provider: string;         // 厂商 ID (deepseek, anthropic, openai, ...)
  model: string;            // 模型 ID
  apiKey?: string;          // API Key
  baseURL?: string;         // 自定义 API 地址（可选，覆盖默认）
  maxTokens: number;
  temperature: number;
}
