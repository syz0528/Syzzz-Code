import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

const KITTY_QUERY = '\u001B[?u';
const KITTY_RESPONSE = /\u001B\[\?\d+u/gu;
const SHIFT_ENTER_INPUT = '\u001B\r';
const WINDOWS_TERMINAL_ACTION_ID = 'Syzzz.SendShiftEnter';

export type TerminalHost =
  'windows-terminal' | 'vscode' | 'cursor' | 'windsurf' | 'codex' | 'native-kitty' | 'unknown';

export interface TerminalKeyboardStatus {
  host: TerminalHost;
  setupAvailable: boolean;
  setupInstalled: boolean;
  configurationPath?: string;
  conflict?: string;
}

export interface TerminalKeyboardPresentation {
  shiftEnterAvailable: boolean;
  newlineShortcut: 'Shift+Enter' | 'Ctrl+J';
}

interface TerminalSetupTarget {
  kind: 'windows-terminal' | 'vscode-family';
  host: TerminalHost;
  path: string;
}

interface TerminalSetupResult {
  status: TerminalKeyboardStatus;
  changed: boolean;
  backupPath?: string;
}

interface TtyInput {
  isTTY?: boolean;
  isRaw?: boolean;
  isPaused(): boolean;
  setRawMode(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  unshift(chunk: Buffer): unknown;
}

interface TtyOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

function normalizedTerminalName(environment: NodeJS.ProcessEnv): string {
  return (environment.TERM_PROGRAM ?? environment.TERMINAL_EMULATOR ?? '').toLowerCase();
}

export function detectTerminalHost(environment: NodeJS.ProcessEnv = process.env): TerminalHost {
  const terminal = normalizedTerminalName(environment);
  if (environment.WT_SESSION) return 'windows-terminal';
  if (terminal.includes('cursor') || environment.CURSOR_TRACE_ID) return 'cursor';
  if (terminal.includes('windsurf')) return 'windsurf';
  if (terminal.includes('vscode') || environment.VSCODE_PID) return 'vscode';
  if (environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || environment.CODEX_THREAD_ID) return 'codex';
  if (
    terminal.includes('kitty') ||
    terminal.includes('wezterm') ||
    terminal.includes('ghostty') ||
    terminal.includes('iterm') ||
    environment.KITTY_WINDOW_ID ||
    environment.WEZTERM_PANE ||
    environment.GHOSTTY_RESOURCES_DIR
  ) {
    return 'native-kitty';
  }
  return 'unknown';
}

function vscodeConfigurationDirectory(host: TerminalHost, environment: NodeJS.ProcessEnv): string {
  const applicationData = environment.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const product = host === 'cursor' ? 'Cursor' : host === 'windsurf' ? 'Windsurf' : 'Code';
  return join(applicationData, product, 'User', 'keybindings.json');
}

function windowsTerminalConfigurationPath(environment: NodeJS.ProcessEnv): string {
  const localApplicationData = environment.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(
    localApplicationData,
    'Packages',
    'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    'LocalState',
    'settings.json'
  );
}

function setupTarget(
  environment: NodeJS.ProcessEnv = process.env
): TerminalSetupTarget | undefined {
  const host = detectTerminalHost(environment);
  if (host === 'windows-terminal' && platform() === 'win32') {
    return {
      kind: 'windows-terminal',
      host,
      path: windowsTerminalConfigurationPath(environment)
    };
  }
  if (host === 'vscode' || host === 'cursor' || host === 'windsurf') {
    return {
      kind: 'vscode-family',
      host,
      path: vscodeConfigurationDirectory(host, environment)
    };
  }
  return undefined;
}

function parseJsoncDocument(content: string, path: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(`Cannot update invalid JSON configuration: ${path}`);
  }
  return value;
}

function isShiftEnter(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().replace(/\s+/gu, '') === 'shift+enter';
}

function isSendInputCommand(command: unknown): boolean {
  return (
    typeof command === 'object' &&
    command !== null &&
    (command as { action?: unknown }).action === 'sendInput' &&
    (command as { input?: unknown }).input === SHIFT_ENTER_INPUT
  );
}

function inspectWindowsTerminal(value: unknown): { installed: boolean; conflict?: string } {
  if (typeof value !== 'object' || value === null) return { installed: false };
  const document = value as { actions?: unknown; keybindings?: unknown };
  const actions = Array.isArray(document.actions) ? document.actions : [];
  const keybindings = Array.isArray(document.keybindings) ? document.keybindings : [];
  const actionById = new Map<string, unknown>();
  for (const action of actions) {
    if (typeof action === 'object' && action !== null && typeof action.id === 'string') {
      actionById.set(action.id, action.command);
    }
  }
  const binding = keybindings.find(
    (candidate) =>
      typeof candidate === 'object' && candidate !== null && isShiftEnter(candidate.keys)
  ) as { id?: unknown } | undefined;
  if (!binding) return { installed: false };
  const command = typeof binding.id === 'string' ? actionById.get(binding.id) : undefined;
  if (isSendInputCommand(command)) return { installed: true };
  return {
    installed: false,
    conflict: 'Shift+Enter is already assigned in Windows Terminal; Syzzz did not replace it.'
  };
}

function inspectVscode(value: unknown): { installed: boolean; conflict?: string } {
  if (!Array.isArray(value)) return { installed: false };
  const binding = value.find(
    (candidate) =>
      typeof candidate === 'object' && candidate !== null && isShiftEnter(candidate.key)
  ) as { command?: unknown; args?: { text?: unknown }; when?: unknown } | undefined;
  if (!binding) return { installed: false };
  if (
    binding.command === 'workbench.action.terminal.sendSequence' &&
    binding.args?.text === SHIFT_ENTER_INPUT &&
    typeof binding.when === 'string' &&
    binding.when.includes('terminalFocus')
  ) {
    return { installed: true };
  }
  return {
    installed: false,
    conflict:
      'Shift+Enter is already assigned in the terminal keybindings; Syzzz did not replace it.'
  };
}

async function readSetupContent(target: TerminalSetupTarget): Promise<string> {
  try {
    return await readFile(target.path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return target.kind === 'vscode-family' ? '[]\n' : '{}\n';
  }
}

export async function inspectTerminalKeyboard(
  environment: NodeJS.ProcessEnv = process.env
): Promise<TerminalKeyboardStatus> {
  const host = detectTerminalHost(environment);
  const target = setupTarget(environment);
  if (!target) {
    return {
      host,
      setupAvailable: false,
      setupInstalled: false
    };
  }
  const content = await readSetupContent(target);
  const inspected =
    target.kind === 'windows-terminal'
      ? inspectWindowsTerminal(parseJsoncDocument(content, target.path))
      : inspectVscode(parseJsoncDocument(content, target.path));
  return {
    host,
    setupAvailable: true,
    setupInstalled: inspected.installed,
    configurationPath: target.path,
    ...(inspected.conflict ? { conflict: inspected.conflict } : {})
  };
}

function appendJsoncValue(content: string, path: (string | number)[], value: unknown): string {
  const edits = modify(content, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 4, eol: '\n' }
  });
  return applyEdits(content, edits);
}

function updateWindowsTerminal(content: string, path: string): string {
  const document = parseJsoncDocument(content, path) as {
    actions?: unknown;
    keybindings?: unknown;
  };
  const inspected = inspectWindowsTerminal(document);
  if (inspected.installed) return content;
  if (inspected.conflict) throw new Error(inspected.conflict);
  const action = {
    command: { action: 'sendInput', input: SHIFT_ENTER_INPUT },
    id: WINDOWS_TERMINAL_ACTION_ID
  };
  const binding = { id: WINDOWS_TERMINAL_ACTION_ID, keys: 'shift+enter' };
  let updated = Array.isArray(document.actions)
    ? appendJsoncValue(content, ['actions', -1], action)
    : appendJsoncValue(content, ['actions'], [action]);
  const updatedDocument = parseJsoncDocument(updated, path) as { keybindings?: unknown };
  updated = Array.isArray(updatedDocument.keybindings)
    ? appendJsoncValue(updated, ['keybindings', -1], binding)
    : appendJsoncValue(updated, ['keybindings'], [binding]);
  return updated;
}

function updateVscode(content: string, path: string): string {
  const document = parseJsoncDocument(content, path);
  const inspected = inspectVscode(document);
  if (inspected.installed) return content;
  if (inspected.conflict) throw new Error(inspected.conflict);
  if (!Array.isArray(document)) {
    throw new Error(`Expected a JSON array in ${path}`);
  }
  return appendJsoncValue(content, [-1], {
    key: 'shift+enter',
    command: 'workbench.action.terminal.sendSequence',
    args: { text: SHIFT_ENTER_INPUT },
    when: 'terminalFocus'
  });
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${randomUUID()}.syzzz.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function installTerminalShiftEnter(
  environment: NodeJS.ProcessEnv = process.env
): Promise<TerminalSetupResult> {
  const target = setupTarget(environment);
  if (!target) {
    throw new Error('Automatic Shift+Enter setup is unavailable for this terminal.');
  }
  const content = await readSetupContent(target);
  const updated =
    target.kind === 'windows-terminal'
      ? updateWindowsTerminal(content, target.path)
      : updateVscode(content, target.path);
  if (updated === content) {
    return { status: await inspectTerminalKeyboard(environment), changed: false };
  }
  let backupPath: string | undefined;
  try {
    await stat(target.path);
    backupPath = `${target.path}.syzzz-${Date.now()}.bak`;
    await copyFile(target.path, backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeAtomic(target.path, updated);
  return {
    status: await inspectTerminalKeyboard(environment),
    changed: true,
    ...(backupPath ? { backupPath } : {})
  };
}

function stripKittyResponses(buffer: Buffer): Buffer {
  return Buffer.from(buffer.toString('latin1').replace(KITTY_RESPONSE, ''), 'latin1');
}

export async function probeKittyKeyboardSupport(
  input: TtyInput = process.stdin,
  output: TtyOutput = process.stdout,
  timeoutMs = 120,
  environment: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return false;
  const host = detectTerminalHost(environment);
  if (host === 'vscode' || host === 'cursor' || host === 'windsurf' || host === 'codex')
    return false;

  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  const chunks: Buffer[] = [];
  let supported = false;
  let resolveProbe: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveProbe = resolve;
  });
  const onData = (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    chunks.push(value);
    if (KITTY_RESPONSE.test(Buffer.concat(chunks).toString('latin1'))) {
      KITTY_RESPONSE.lastIndex = 0;
      supported = true;
      resolveProbe?.();
    } else {
      KITTY_RESPONSE.lastIndex = 0;
    }
  };

  try {
    if (!wasRaw) input.setRawMode(true);
    input.on('data', onData);
    input.resume();
    output.write(KITTY_QUERY);
    await Promise.race([completed, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  } finally {
    input.removeListener('data', onData);
    const remaining = stripKittyResponses(Buffer.concat(chunks));
    if (remaining.length > 0) input.unshift(remaining);
    if (wasPaused) input.pause();
    if (!wasRaw) input.setRawMode(false);
  }
  return supported;
}

export function terminalKeyboardPresentation(
  kittySupported: boolean,
  status: TerminalKeyboardStatus
): TerminalKeyboardPresentation {
  const shiftEnterAvailable = kittySupported || status.setupInstalled;
  return {
    shiftEnterAvailable,
    newlineShortcut: shiftEnterAvailable ? 'Shift+Enter' : 'Ctrl+J'
  };
}
