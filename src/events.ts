import type { ToolApprovalChoice, ToolRisk } from './types.js';
import type {
  ProviderInfo,
  ProviderUsage
} from './providers/base.js';
import type {
  ProviderErrorCode,
  PublicProviderError
} from './providers/errors.js';
import type { AgentMode } from './modes.js';
import type { SubagentRole } from './subagents.js';

export interface AgentEventEnvelope {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  sequence: number;
  timestamp: string;
}

export type AgentPhase =
  | 'provider'
  | 'compaction'
  | 'extension'
  | 'subagent'
  | 'approval'
  | 'tool'
  | 'completed';

export interface TurnStartedEvent extends AgentEventEnvelope {
  type: 'turn_started';
  provider: ProviderInfo;
  mode: AgentMode;
}

export interface PhaseChangedEvent extends AgentEventEnvelope {
  type: 'phase_changed';
  phase: AgentPhase;
}

export interface ProviderRequestStartedEvent extends AgentEventEnvelope {
  type: 'provider_request_started';
  provider: string;
  model: string;
  attempt: number;
  attemptId: string;
  purpose?: ProviderPurpose;
}

export interface ProviderRequestFailedEvent extends AgentEventEnvelope {
  type: 'provider_request_failed';
  provider: string;
  model: string;
  attempt: number;
  attemptId: string;
  durationMs: number;
  willRetry: boolean;
  error: PublicProviderError;
  purpose?: ProviderPurpose;
}

export interface ProviderRequestCompletedEvent extends AgentEventEnvelope {
  type: 'provider_request_completed';
  provider: string;
  model: string;
  attempt: number;
  attemptId: string;
  durationMs: number;
  finishReason?: string | null;
  requestId?: string;
  reportedModel?: string;
  purpose?: ProviderPurpose;
}

export interface ReasoningStatusEvent extends AgentEventEnvelope {
  type: 'reasoning_status';
  status: 'started' | 'completed';
  attempt: number;
  attemptId: string;
  durationMs?: number;
  characterCount?: number;
}

export interface TextDeltaEvent extends AgentEventEnvelope {
  type: 'text_delta';
  attempt: number;
  attemptId: string;
  delta: string;
}

export interface RetryScheduledEvent extends AgentEventEnvelope {
  type: 'retry_scheduled';
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  reason: ProviderErrorCode;
  purpose?: ProviderPurpose;
}

export interface UsageUpdatedEvent extends AgentEventEnvelope {
  type: 'usage_updated';
  attempt: number;
  attemptId: string;
  usage: ProviderUsage;
  cumulativeUsage: ProviderUsage;
  purpose?: ProviderPurpose;
}

export type ProviderPurpose = 'turn' | 'compaction' | 'subagent';

export interface ContextUsageUpdatedEvent extends AgentEventEnvelope {
  type: 'context_usage_updated';
  inputTokens: number;
  contextWindowTokens: number;
  triggerTokens: number;
  source: 'estimated' | 'reported';
}

export type CompactionReason =
  | 'threshold'
  | 'context_exceeded'
  | 'model_switch'
  | 'manual';

export interface CompactionStartedEvent extends AgentEventEnvelope {
  type: 'compaction_started';
  reason: CompactionReason;
  mode: 'history' | 'intra-turn';
  beforeTokens: number;
  contextWindowTokens: number;
}

export interface CompactionCompletedEvent extends AgentEventEnvelope {
  type: 'compaction_completed';
  reason: CompactionReason;
  mode: 'history' | 'intra-turn';
  beforeTokens: number;
  afterTokens: number;
  messagesCompacted: number;
  durationMs: number;
}

export interface CompactionFailedEvent extends AgentEventEnvelope {
  type: 'compaction_failed';
  reason: CompactionReason;
  mode?: 'history' | 'intra-turn';
  durationMs: number;
  recoverable: boolean;
  error: AgentErrorDetails;
}

export interface ToolRequestedEvent extends AgentEventEnvelope {
  type: 'tool_requested';
  toolCallId: string;
  toolName: string;
}

export interface ApprovalRequestedEvent extends AgentEventEnvelope {
  type: 'approval_requested';
  toolCallId: string;
  toolName: string;
  risk: ToolRisk;
  choices: readonly ToolApprovalChoice[];
}

export interface ApprovalResolvedEvent extends AgentEventEnvelope {
  type: 'approval_resolved';
  toolCallId: string;
  toolName: string;
  choice: ToolApprovalChoice;
  resolution: 'user' | 'handler-unavailable' | 'invalid-choice';
}

export interface ToolStartedEvent extends AgentEventEnvelope {
  type: 'tool_started';
  toolCallId: string;
  toolName: string;
}

export interface McpServerStatusEvent extends AgentEventEnvelope {
  type: 'mcp_server_status';
  server: string;
  source: 'user' | 'project';
  transport: 'stdio' | 'http';
  state: 'disabled' | 'disconnected' | 'connecting' | 'ready' | 'error';
  toolCount: number;
  errorCode?: string;
}

export type HookEventName =
  | 'PreTurn'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'TurnCompleted'
  | 'TurnFailed'
  | 'TurnCancelled';

export interface HookStartedEvent extends AgentEventEnvelope {
  type: 'hook_started';
  hook: string;
  event: HookEventName;
  source: 'user' | 'project';
}

export interface HookCompletedEvent extends AgentEventEnvelope {
  type: 'hook_completed';
  hook: string;
  event: HookEventName;
  source: 'user' | 'project';
  outcome: 'success' | 'denied' | 'error' | 'timeout';
  durationMs: number;
  errorCode?: string;
}

export interface SubagentStartedEvent extends AgentEventEnvelope {
  type: 'subagent_started';
  subagentId: string;
  role: SubagentRole;
}

export interface SubagentProgressEvent extends AgentEventEnvelope {
  type: 'subagent_progress';
  subagentId: string;
  role: SubagentRole;
  phase: 'provider' | 'tool';
  toolName?: string;
}

export interface SubagentCompletedEvent extends AgentEventEnvelope {
  type: 'subagent_completed';
  subagentId: string;
  role: SubagentRole;
  outcome: 'success' | 'error' | 'cancelled';
  durationMs: number;
  toolCalls: number;
  usage?: ProviderUsage;
  errorCode?: string;
}

export type ToolOutcome = 'success' | 'error' | 'denied' | 'cancelled';

export interface ToolCompletedEvent extends AgentEventEnvelope {
  type: 'tool_completed';
  toolCallId: string;
  toolName: string;
  outcome: ToolOutcome;
  durationMs: number;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentErrorDetails {
  code: string;
  message: string;
  provider?: string;
  status?: number;
  requestId?: string;
}

export interface TurnCompletedEvent extends AgentEventEnvelope {
  type: 'turn_completed';
  durationMs: number;
  finishReason?: string | null;
  usage?: ProviderUsage;
}

export interface TurnFailedEvent extends AgentEventEnvelope {
  type: 'turn_failed';
  durationMs: number;
  error: AgentErrorDetails;
}

export interface TurnCancelledEvent extends AgentEventEnvelope {
  type: 'turn_cancelled';
  durationMs: number;
  reason: string;
}

export type AgentEvent =
  | TurnStartedEvent
  | PhaseChangedEvent
  | ProviderRequestStartedEvent
  | ProviderRequestFailedEvent
  | ProviderRequestCompletedEvent
  | ReasoningStatusEvent
  | TextDeltaEvent
  | RetryScheduledEvent
  | UsageUpdatedEvent
  | ContextUsageUpdatedEvent
  | CompactionStartedEvent
  | CompactionCompletedEvent
  | CompactionFailedEvent
  | ToolRequestedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ToolStartedEvent
  | McpServerStatusEvent
  | HookStartedEvent
  | HookCompletedEvent
  | SubagentStartedEvent
  | SubagentProgressEvent
  | SubagentCompletedEvent
  | ToolCompletedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent;

export type AgentEventData = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, keyof AgentEventEnvelope>
    : never
  : never;

export type TurnResult =
  | {
      status: 'completed';
      response: string;
      durationMs: number;
      finishReason?: string | null;
      usage?: ProviderUsage;
      context?: {
        compactions: number;
        inputTokens: number;
        contextWindowTokens: number;
      };
    }
  | {
      status: 'failed';
      durationMs: number;
      error: AgentErrorDetails;
    }
  | {
      status: 'cancelled';
      durationMs: number;
      reason: string;
    };
