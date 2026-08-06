import type { ZodType } from 'zod';
import type { AgentEventData } from './events.js';
import type { AgentMode } from './modes.js';
import type { PermissionMode } from './permissions/mode.js';

export type ToolRisk = 'read' | 'write' | 'execute';

export type ToolApprovalChoice = 'allow-once' | 'allow-edits-session' | 'deny';

export interface ToolResult<Output = unknown> {
  content: string;
  data?: Output;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolApprovalDetails {
  description: string;
  preview?: string;
  executionData?: unknown;
}

export interface ToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  risk: ToolRisk;
  input: unknown;
  description: string;
  preview?: string;
  choices: readonly ToolApprovalChoice[];
}

export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
  signal: AbortSignal
) => Promise<ToolApprovalChoice>;

export type UserQuestionKind = 'single' | 'multi' | 'text';

export interface UserQuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  header: string;
  prompt: string;
  kind: UserQuestionKind;
  options?: UserQuestionOption[];
  /** @deprecated The interactive client always permits a bounded custom answer. */
  allowCustom?: boolean;
}

export interface UserInputRequest {
  requestId: string;
  questions: UserQuestion[];
}

export type UserInputAnswers = Record<string, string | string[]>;

export type UserInputHandler = (
  request: UserInputRequest,
  signal: AbortSignal
) => Promise<UserInputAnswers>;

export interface ToolContext {
  toolCallId: string;
  sessionId: string;
  turnId: string;
  workspaceRoot: string;
  workingDirectory: string;
  resolveSkillWorkingDirectory?: (name: string, signal: AbortSignal) => Promise<string>;
  mode: AgentMode;
  permissionMode: PermissionMode;
  signal: AbortSignal;
  requestUserInput?: UserInputHandler;
  approvalData?: unknown;
  emitEvent?: (event: AgentEventData) => void;
}

export interface ResolvedToolPolicy {
  risk: ToolRisk;
  approval: 'never' | 'always';
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodType<unknown>;
  risk: ToolRisk;
  approval: 'never' | 'always';
  modeAccess?: 'risk-derived' | 'all-modes';
  resolvePolicy?: (input: unknown, context: ToolContext) => Promise<ResolvedToolPolicy>;
  prepareApproval?: (input: unknown, context: ToolContext) => Promise<ToolApprovalDetails>;
  execute: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface TypedToolDefinition<Input, Output = unknown> extends Omit<
  ToolDefinition,
  'inputSchema' | 'resolvePolicy' | 'prepareApproval' | 'execute'
> {
  inputSchema: ZodType<Input>;
  resolvePolicy?: (input: Input, context: ToolContext) => Promise<ResolvedToolPolicy>;
  prepareApproval?: (input: Input, context: ToolContext) => Promise<ToolApprovalDetails>;
  execute: (input: Input, context: ToolContext) => Promise<ToolResult<Output>>;
}
