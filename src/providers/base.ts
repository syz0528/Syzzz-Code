export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface UserMessage {
  role: 'user';
  content: string;
  kind?: 'compaction-summary';
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

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderChatResponse {
  message: AssistantMessage;
  finishReason?: string | null;
  usage?: ProviderUsage;
  requestId?: string;
  reportedModel?: string;
}

export interface ProviderAttemptOptions {
  signal: AbortSignal;
  attempt: number;
  attemptId: string;
  includeUsage: boolean;
  disableReasoning: boolean;
}

export type ProviderDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | { type: 'usage'; usage: ProviderUsage };

export interface ProviderCapabilities {
  streaming: boolean;
  reasoningToggle: boolean;
}

export interface ProviderInfo {
  name: string;
  type: string;
  model: string;
  contextWindowTokens?: number;
  capabilities: ProviderCapabilities;
}

export interface AIProvider {
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;

  chatStream?(
    request: ProviderChatRequest,
    attemptOptions: ProviderAttemptOptions
  ): AsyncGenerator<ProviderDelta, ProviderChatResponse>;

  getInfo(): ProviderInfo;

  setModel?(model: string): void;

  fork?(): AIProvider;
}
