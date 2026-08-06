import type {
  ToolApprovalChoice,
  ToolApprovalRequest,
  UserInputAnswers,
  UserInputRequest
} from '../types.js';

export type InteractionState = 'idle' | 'command' | 'turn' | 'approval' | 'question' | 'exiting';

export type NoticeTone = 'info' | 'success' | 'warning' | 'error' | 'muted';

export interface InteractionNotice {
  tone: NoticeTone;
  text: string;
  transient?: boolean;
}

export interface InteractionChoice {
  value: string;
  label: string;
  description?: string;
  current?: boolean;
}

export interface SelectRequest {
  title: string;
  message?: string;
  choices: readonly InteractionChoice[];
  initialValue?: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  preview?: string;
  confirmToken: string;
  cancelLabel?: string;
}

export interface TextInputRequest {
  title: string;
  message?: string;
  placeholder?: string;
  maximumCharacters?: number;
  hidden?: boolean;
}

export interface InteractionPort {
  notice(notice: InteractionNotice): void;
  confirm(request: ConfirmRequest, signal: AbortSignal): Promise<boolean>;
  select(request: SelectRequest, signal: AbortSignal): Promise<string | undefined>;
  textInput(request: TextInputRequest, signal: AbortSignal): Promise<string | undefined>;
  requestApproval(request: ToolApprovalRequest, signal: AbortSignal): Promise<ToolApprovalChoice>;
  requestUserInput(request: UserInputRequest, signal: AbortSignal): Promise<UserInputAnswers>;
  suspendTerminal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
  historyStatus(): { enabled: boolean; entries: number; path: string };
  setHistoryEnabled(enabled: boolean): Promise<void>;
  clearHistory(): Promise<void>;
}
