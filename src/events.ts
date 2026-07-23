import type { ToolApprovalChoice, ToolRisk } from './types.js';
import type {
  ProviderInfo,
  ProviderUsage
} from './providers/base.js';
import type {
  ProviderErrorCode,
  PublicProviderError
} from './providers/errors.js';

export interface AgentEventEnvelope {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  sequence: number;
  timestamp: string;
}

export type AgentPhase =
  | 'provider'
  | 'approval'
  | 'tool'
  | 'completed';

export interface TurnStartedEvent extends AgentEventEnvelope {
  type: 'turn_started';
  provider: ProviderInfo;
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
}

export interface UsageUpdatedEvent extends AgentEventEnvelope {
  type: 'usage_updated';
  attempt: number;
  attemptId: string;
  usage: ProviderUsage;
  cumulativeUsage: ProviderUsage;
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
  | ToolRequestedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ToolStartedEvent
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
