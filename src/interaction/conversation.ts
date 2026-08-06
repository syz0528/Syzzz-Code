import type { InteractionNotice } from './types.js';

export type ToolTimelineStatus =
  'requested' | 'running' | 'success' | 'error' | 'denied' | 'cancelled';

export interface ToolTimelineItem {
  id: string;
  toolCallId: string;
  name: string;
  status: ToolTimelineStatus;
  durationMs?: number;
  summary?: string;
  detail?: string;
  expanded?: boolean;
}

export interface TurnDisplaySummary {
  durationMs: number;
  workingDurationMs: number;
  tools: number;
  failedTools: number;
  retries: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string | null;
}

export type ConversationBlock =
  | {
      id: string;
      turnId: string;
      kind: 'user';
      text: string;
      submittedAt: number;
    }
  | {
      id: string;
      turnId: string;
      kind: 'assistant';
      markdown: string;
      status: 'streaming' | 'completed' | 'failed' | 'cancelled';
      live?: boolean;
      summary?: TurnDisplaySummary;
    }
  | {
      id: string;
      turnId: string;
      kind: 'tool-group';
      category: 'read' | 'action';
      items: readonly ToolTimelineItem[];
    }
  | {
      id: string;
      kind: 'notice';
      text: string;
      tone?: InteractionNotice['tone'];
    }
  | { id: string; kind: 'omitted'; text: string };

export interface TurnActivityState {
  turnId: string;
  phase: string;
  detail?: string;
  startedAt: number;
  activeSince?: number;
  accumulatedActiveMs: number;
  waitingForInput: boolean;
}

export interface TranscriptAnchor {
  blockId: string;
  sourceRow: number;
  viewportOffset: number;
}

const COMPACT_READ_TOOLS = new Set(['Read', 'ListDirectory', 'Glob', 'Grep']);

export function toolTimelineCategory(toolName: string): 'read' | 'action' {
  return COMPACT_READ_TOOLS.has(toolName) ? 'read' : 'action';
}

export function activityElapsedMs(activity: TurnActivityState, now = Date.now()): number {
  return (
    activity.accumulatedActiveMs +
    (activity.activeSince === undefined ? 0 : Math.max(0, now - activity.activeSince))
  );
}

export function pauseActivity(
  activity: TurnActivityState | undefined,
  now = Date.now()
): TurnActivityState | undefined {
  if (!activity || activity.activeSince === undefined) {
    return activity;
  }
  return {
    ...activity,
    accumulatedActiveMs: activityElapsedMs(activity, now),
    activeSince: undefined,
    waitingForInput: true
  };
}

export function resumeActivity(
  activity: TurnActivityState | undefined,
  now = Date.now()
): TurnActivityState | undefined {
  if (!activity || activity.activeSince !== undefined) {
    return activity;
  }
  return { ...activity, activeSince: now, waitingForInput: false };
}
