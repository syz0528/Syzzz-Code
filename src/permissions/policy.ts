import type { ToolDefinition, ToolRisk } from '../types.js';
import type { PermissionMode } from './mode.js';

/**
 * Decide whether a tool call needs an interactive user approval prompt
 * under the current session permission mode.
 *
 * Tool-level `approval: 'never'` always skips the prompt.
 * Mode then relaxes write and/or execute risks.
 */
export function requiresUserApproval(
  mode: PermissionMode,
  tool: Pick<ToolDefinition, 'approval' | 'risk'>
): boolean {
  if (tool.approval === 'never') {
    return false;
  }

  return requiresUserApprovalForRisk(mode, tool.risk);
}

export function requiresUserApprovalForRisk(mode: PermissionMode, risk: ToolRisk): boolean {
  switch (mode) {
    case 'safe':
      // Read tools should declare approval: 'never'. If a read tool is marked
      // always, still fail closed and ask.
      return risk === 'write' || risk === 'execute' || risk === 'read';
    case 'acceptEdits':
      return risk === 'execute';
    case 'fullAccess':
      return false;
  }
}
