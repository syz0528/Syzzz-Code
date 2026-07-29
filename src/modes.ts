import type { ToolDefinition } from './types.js';

export const AGENT_MODES = ['ask', 'plan', 'code'] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

export const DEFAULT_AGENT_MODE: AgentMode = 'code';

export function parseAgentMode(value: string): AgentMode | undefined {
  const normalized = value.trim().toLowerCase();
  return AGENT_MODES.find(mode => mode === normalized);
}

export function agentModeDescription(mode: AgentMode): string {
  switch (mode) {
    case 'ask':
      return 'Read-only analysis and answers.';
    case 'plan':
      return 'Read-only exploration and implementation planning.';
    case 'code':
      return 'Execute coding tasks under the active permission policy.';
  }
}

export function isToolAllowedInMode(
  mode: AgentMode,
  tool: Pick<ToolDefinition, 'risk' | 'modeAccess'>
): boolean {
  return mode === 'code' ||
    tool.risk === 'read' ||
    tool.modeAccess === 'all-modes';
}

export function isToolRiskAllowedInMode(
  mode: AgentMode,
  risk: ToolDefinition['risk']
): boolean {
  return mode === 'code' || risk === 'read';
}

export function modeSystemInstructions(mode: AgentMode): readonly string[] {
  switch (mode) {
    case 'ask':
      return [
        'Work mode: ask.',
        'Only inspect and analyze. Do not write files or execute shell commands.',
        'Answer the user directly after gathering only the context that is needed.'
      ];
    case 'plan':
      return [
        'Work mode: plan.',
        'Only inspect and analyze. Do not write files or execute shell commands.',
        'Produce a concrete implementation plan and remain in plan mode until the user explicitly switches to code mode.'
      ];
    case 'code':
      return [
        'Work mode: code.',
        'You may use all available tools subject to the active permission policy.'
      ];
  }
}
