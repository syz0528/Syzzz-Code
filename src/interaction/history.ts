import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const HISTORY_SCHEMA_VERSION = 1 as const;
export const MAX_HISTORY_ENTRIES = 500;
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_HISTORY_ENTRY_BYTES = 64 * 1024;

interface HistoryFileV1 {
  schemaVersion: 1;
  entries: string[];
}

export interface WorkspaceHistoryOptions {
  workspaceRoot: string;
  enabled?: boolean;
  baseDirectory?: string;
  onWarning?: (message: string) => void;
}

function normalizeWorkspacePath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/').replace(/\/$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function historyWorkspaceId(workspaceRoot: string): string {
  return createHash('sha256')
    .update(normalizeWorkspacePath(workspaceRoot))
    .digest('hex')
    .slice(0, 16);
}

function boundedEntries(entries: readonly string[]): string[] {
  const result: string[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const value = entries[index];
    if (value === undefined) {
      continue;
    }
    const entryBytes = Buffer.byteLength(value, 'utf8');
    if (!value || entryBytes > MAX_HISTORY_ENTRY_BYTES) {
      continue;
    }
    if (result.length >= MAX_HISTORY_ENTRIES || bytes + entryBytes > MAX_HISTORY_BYTES) {
      break;
    }
    result.unshift(value);
    bytes += entryBytes;
  }
  return result;
}

export class WorkspaceInputHistory {
  readonly path: string;
  private entries: string[] = [];
  private enabled: boolean;
  private warned = false;
  private readonly onWarning?: (message: string) => void;

  private constructor(options: WorkspaceHistoryOptions) {
    const baseDirectory = options.baseDirectory ?? join(homedir(), '.syzzz-code', 'history');
    this.path = join(baseDirectory, `${historyWorkspaceId(options.workspaceRoot)}.json`);
    this.enabled = options.enabled ?? true;
    this.onWarning = options.onWarning;
  }

  static async create(options: WorkspaceHistoryOptions): Promise<WorkspaceInputHistory> {
    const history = new WorkspaceInputHistory(options);
    await history.load();
    return history;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  list(): readonly string[] {
    return [...this.entries];
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (enabled) {
      await this.save();
    }
  }

  async record(value: string): Promise<boolean> {
    if (!this.enabled || !value || Buffer.byteLength(value, 'utf8') > MAX_HISTORY_ENTRY_BYTES) {
      return false;
    }
    if (this.entries.at(-1) === value) {
      return false;
    }
    this.entries.push(value);
    this.entries = boundedEntries(this.entries);
    await this.save();
    return true;
  }

  async clear(): Promise<void> {
    this.entries = [];
    if (this.enabled) {
      await this.save();
    }
  }

  private warn(message: string): void {
    if (!this.warned) {
      this.warned = true;
      this.onWarning?.(message);
    }
  }

  private async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`Cannot read input history: ${String(error)}`);
      }
      return;
    }
    try {
      const parsed = JSON.parse(content) as Partial<HistoryFileV1>;
      if (
        parsed.schemaVersion !== HISTORY_SCHEMA_VERSION ||
        !Array.isArray(parsed.entries) ||
        parsed.entries.some((entry) => typeof entry !== 'string')
      ) {
        throw new Error('unsupported or malformed history data');
      }
      this.entries = boundedEntries(parsed.entries);
    } catch (error) {
      const quarantine = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, quarantine).catch(() => undefined);
      this.warn(`Input history was isolated because it is damaged: ${String(error)}`);
    }
  }

  private async save(): Promise<void> {
    const payload = `${JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, entries: this.entries })}\n`;
    const directory = dirname(this.path);
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600).catch((error) => {
        this.warn(`Input history permissions could not be restricted: ${String(error)}`);
      });
    } catch (error) {
      this.warn(`Cannot save input history: ${String(error)}`);
    }
  }
}
