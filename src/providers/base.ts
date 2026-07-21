export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  /** Provider-private reasoning metadata needed to continue some tool-call conversations. */
  reasoningContent?: string;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}

export type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ProviderChatRequest {
  messages: ConversationMessage[];
  tools: ProviderTool[];
  systemPrompt: string;
  signal?: AbortSignal;
}

export interface ProviderChatResponse {
  message: AssistantMessage;
  finishReason?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface AIProvider {
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;

  getInfo(): {
    name: string;
    type: string;
  };
}
