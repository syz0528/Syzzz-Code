import type { ConversationMessage } from '../providers/base.js';
import type { AgentEventData } from '../events.js';

export interface ContextReference {
  raw: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface ContextReceipt {
  type: 'file' | 'directory';
  relativePath: string;
  sha256: string;
  byteCount: number;
  lineStart?: number;
  lineEnd?: number;
  truncated: boolean;
}

export type InstructionSource = 'user' | 'workspace' | 'nested';

export type SkillSource = 'user-shared' | 'user-syzzz' | 'project' | 'project-syzzz';

export interface SkillDescriptor {
  name: string;
  description: string;
  source: SkillSource;
  rootPath: string;
  skillFilePath: string;
  enabled: boolean;
  shadowed: boolean;
  unsupportedFields: string[];
}

export interface SkillActivation {
  name: string;
  activation: 'explicit' | 'implicit';
  arguments?: string;
  byteCount: number;
}

export interface SkillInstallRecordV1 {
  schemaVersion: 1;
  name: string;
  sourceUrl: string;
  requestedRef?: string;
  resolvedCommit: string;
  sourceSkillPath: string;
  scope: 'user' | 'project';
  installedAt: string;
  fileCount: number;
  totalBytes: number;
}

export interface LoadedInstruction {
  source: InstructionSource;
  path: string;
  content: string;
  byteCount: number;
  truncated: boolean;
}

export interface CompositionStatus {
  instructions: {
    loaded: number;
    sources: Array<{
      source: InstructionSource;
      path: string;
      byteCount: number;
      truncated: boolean;
    }>;
  };
  context: {
    lastReferenceCount: number;
    maximumReferencesPerTurn: number;
    maximumFileBytes: number;
    maximumTotalBytes: number;
  };
  skills: {
    enabled: boolean;
    allowImplicit: boolean;
    available: number;
    disabled: number;
    invalid: number;
    shadowed: number;
    activeThisTurn: number;
  };
  warnings: string[];
}

export interface ComposedTurn {
  message: string;
  events: AgentEventData[];
  receipts: ContextReceipt[];
}

export interface TaskCompositionRuntimeLike {
  readonly workspaceRoot: string;
  beginTurn(): void;
  reload(): Promise<CompositionStatus>;
  compose(message: string, signal: AbortSignal): Promise<ComposedTurn>;
  getPreludeMessages(signal?: AbortSignal): Promise<ConversationMessage[]>;
  noteTouchedPaths(paths: readonly string[]): Promise<void>;
  getStatus(): CompositionStatus;
  listSkills(): SkillDescriptor[];
  inspectSkill(name: string): SkillDescriptor | undefined;
  setSkillEnabled(name: string, enabled: boolean): void;
  getTools(): import('../types.js').ToolDefinition[];
}
