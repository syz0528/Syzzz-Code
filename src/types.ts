import type { ZodType } from 'zod';

export type ToolRisk = 'read' | 'write' | 'execute';

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
}

export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
  signal: AbortSignal
) => Promise<boolean>;

export interface ToolContext {
  toolCallId: string;
  workspaceRoot: string;
  workingDirectory: string;
  signal: AbortSignal;
  approvalData?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodType<unknown>;
  risk: ToolRisk;
  approval: 'never' | 'always';
  prepareApproval?: (
    input: unknown,
    context: ToolContext
  ) => Promise<ToolApprovalDetails>;
  execute: (
    input: unknown,
    context: ToolContext
  ) => Promise<ToolResult>;
}

export interface TypedToolDefinition<Input, Output = unknown>
  extends Omit<ToolDefinition, 'inputSchema' | 'prepareApproval' | 'execute'> {
  inputSchema: ZodType<Input>;
  prepareApproval?: (
    input: Input,
    context: ToolContext
  ) => Promise<ToolApprovalDetails>;
  execute: (
    input: Input,
    context: ToolContext
  ) => Promise<ToolResult<Output>>;
}
