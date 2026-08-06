import { randomUUID } from 'node:crypto';
import type { AgentMode } from './modes.js';
import type { QueryEngine, QueryEngineStateV1 } from './engine.js';
import type { TurnResult } from './events.js';
import { PermissionGrantStore, type PermissionGrantScope } from './permissions/grant-store.js';
import type { PermissionMode } from './permissions/mode.js';
import {
  SessionLease,
  SessionStore,
  type SessionMetadata,
  type SessionSnapshotV1
} from './session-store.js';

const DEFAULT_SESSION_TITLE = 'New session';

export interface SessionEngineRequest {
  sessionId: string;
  mode: AgentMode;
  providerId?: string;
  model?: string;
}

export interface SessionEngineResult {
  engine: QueryEngine;
  providerId: string;
  warning?: string;
}

export type SessionEngineFactory = (
  request: SessionEngineRequest
) => SessionEngineResult | Promise<SessionEngineResult>;

export interface SessionControllerOptions {
  store: SessionStore;
  engine: QueryEngine;
  providerId: string;
  autoSave: boolean;
  engineFactory: SessionEngineFactory;
  title?: string;
  now?: () => number;
  idFactory?: () => string;
  warn?: (message: string) => void;
  permissionGrants?: PermissionGrantStore;
}

export interface SessionRuntimeStatus {
  sessionId: string;
  title: string;
  revision: number;
  autoSave: boolean;
  dirty: boolean;
  persistence: 'disabled' | 'healthy' | 'degraded';
  lastSavedAt?: string;
  permissionScope: PermissionGrantScope;
}

export interface SessionSwitchResult {
  sessionId: string;
  title: string;
  providerId: string;
  warning?: string;
}

function normalizeTitle(value: string): string {
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) {
    throw new Error('Session title cannot be empty');
  }
  return title.slice(0, 120);
}

function deriveTitle(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 72) : DEFAULT_SESSION_TITLE;
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionController {
  private currentEngine: QueryEngine;
  private currentProviderId: string;
  private lease!: SessionLease;
  private title: string;
  private revision = 0;
  private createdAt: string;
  private updatedAt: string;
  private turns = 0;
  private dirty = false;
  private degraded = false;
  private hasWarned = false;
  private lastSavedAt?: string;
  private closed = false;
  private readonly store: SessionStore;
  private readonly autoSave: boolean;
  private readonly engineFactory: SessionEngineFactory;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly warn: (message: string) => void;
  private readonly permissionGrants?: PermissionGrantStore;
  private permissionScope: PermissionGrantScope = 'none';

  private constructor(options: SessionControllerOptions) {
    this.store = options.store;
    this.currentEngine = options.engine;
    this.currentProviderId = options.providerId;
    this.autoSave = options.autoSave;
    this.engineFactory = options.engineFactory;
    this.title = normalizeTitle(options.title ?? DEFAULT_SESSION_TITLE);
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    this.permissionGrants = options.permissionGrants;
    const now = new Date(this.now()).toISOString();
    this.createdAt = now;
    this.updatedAt = now;
  }

  static async create(options: SessionControllerOptions): Promise<SessionController> {
    const controller = new SessionController(options);
    controller.lease = await options.store.acquire(options.engine.getSessionId());
    controller.applyStoredPermission();
    controller.attachCheckpointHandler();
    return controller;
  }

  get engine(): QueryEngine {
    return this.currentEngine;
  }

  get providerId(): string {
    return this.currentProviderId;
  }

  get sessionStore(): SessionStore {
    return this.store;
  }

  getStatus(): SessionRuntimeStatus {
    return {
      sessionId: this.currentEngine.getSessionId(),
      title: this.title,
      revision: this.revision,
      autoSave: this.autoSave,
      dirty: this.dirty,
      persistence: this.autoSave ? (this.degraded ? 'degraded' : 'healthy') : 'disabled',
      permissionScope: this.permissionScope,
      ...(this.lastSavedAt ? { lastSavedAt: this.lastSavedAt } : {})
    };
  }

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  async recordTurn(message: string, _result: TurnResult): Promise<void> {
    this.assertOpen();
    if (this.title === DEFAULT_SESSION_TITLE) {
      this.title = deriveTitle(message);
    }
    this.turns += 1;
    if (
      this.currentEngine.getPermissionMode() === 'acceptEdits' &&
      this.permissionScope === 'none'
    ) {
      this.persistAcceptEdits('session');
    }
    this.markDirty();
    await this.tryAutoSave();
  }

  async stateChanged(): Promise<void> {
    this.assertOpen();
    this.markDirty();
    await this.tryAutoSave();
  }

  async save(): Promise<SessionMetadata> {
    this.assertOpen();
    try {
      return await this.saveState(this.currentEngine.exportState());
    } catch (error) {
      this.reportPersistenceFailure(error);
      throw error;
    }
  }

  async rename(title: string): Promise<void> {
    this.assertOpen();
    this.title = normalizeTitle(title);
    this.markDirty();
    await this.tryAutoSave();
  }

  async list(): Promise<SessionMetadata[]> {
    return this.store.list();
  }

  async continueLatest(): Promise<SessionSwitchResult> {
    const latest = (await this.store.list()).find((session) => session.available);
    if (!latest) {
      throw new Error('No saved session exists for this workspace');
    }
    return this.resume(latest.sessionId);
  }

  async resume(idOrPrefix: string): Promise<SessionSwitchResult> {
    this.assertOpen();
    const sessionId = await this.store.resolveSessionId(idOrPrefix);
    if (sessionId === this.currentEngine.getSessionId()) {
      this.applyStoredPermission();
      return {
        sessionId,
        title: this.title,
        providerId: this.currentProviderId
      };
    }

    await this.saveBeforeSwitch();
    const nextLease = await this.store.acquire(sessionId);
    let snapshot: SessionSnapshotV1;
    let created: SessionEngineResult;
    let providerChanged: boolean;
    try {
      snapshot = await this.store.load(sessionId);
      created = await this.engineFactory({
        sessionId,
        mode: snapshot.mode,
        providerId: snapshot.provider.id,
        model: snapshot.provider.model
      });
      if (created.engine.getSessionId() !== sessionId) {
        throw new Error('Session engine factory returned a mismatched session ID');
      }
      providerChanged =
        created.providerId !== snapshot.provider.id ||
        created.engine.getProviderInfo().model !== snapshot.provider.model;
      const restoredState = structuredClone(snapshot.engineState);
      if (providerChanged) {
        delete restoredState.lastReportedModel;
      }
      created.engine.restoreState(restoredState);
    } catch (error) {
      await nextLease.release();
      throw error;
    }

    const oldLease = this.lease;
    const oldEngine = this.currentEngine;
    this.detachCheckpointHandler();
    try {
      await oldLease.release();
    } catch (error) {
      this.attachCheckpointHandler();
      await nextLease.release();
      throw error;
    }

    this.currentEngine = created.engine;
    this.currentProviderId = created.providerId;
    this.lease = nextLease;
    this.title = snapshot.title;
    this.revision = snapshot.revision;
    this.createdAt = snapshot.createdAt;
    this.updatedAt = snapshot.updatedAt;
    this.turns = snapshot.usage.turns;
    this.dirty = providerChanged;
    this.degraded = false;
    this.hasWarned = false;
    this.lastSavedAt = snapshot.updatedAt;
    this.applyStoredPermission();
    this.attachCheckpointHandler();
    if (typeof oldEngine.close === 'function') {
      await oldEngine.close().catch(() => undefined);
    }
    if (this.dirty) {
      await this.tryAutoSave();
    }
    return {
      sessionId,
      title: this.title,
      providerId: this.currentProviderId,
      ...(created.warning ? { warning: created.warning } : {})
    };
  }

  async newSession(title?: string): Promise<SessionSwitchResult> {
    this.assertOpen();
    const nextTitle = normalizeTitle(title ?? DEFAULT_SESSION_TITLE);
    await this.saveBeforeSwitch();
    const sessionId = this.idFactory();
    const created = await this.engineFactory({
      sessionId,
      mode: 'code',
      providerId: this.currentProviderId,
      model: this.currentEngine.getProviderInfo().model
    });
    if (created.engine.getSessionId() !== sessionId) {
      throw new Error('Session engine factory returned a mismatched session ID');
    }
    const nextLease = await this.store.acquire(sessionId);
    const oldLease = this.lease;
    const oldEngine = this.currentEngine;
    this.detachCheckpointHandler();
    try {
      await oldLease.release();
    } catch (error) {
      this.attachCheckpointHandler();
      await nextLease.release();
      throw error;
    }
    this.currentEngine = created.engine;
    this.currentProviderId = created.providerId;
    this.lease = nextLease;
    this.title = nextTitle;
    this.revision = 0;
    const now = new Date(this.now()).toISOString();
    this.createdAt = now;
    this.updatedAt = now;
    this.turns = 0;
    this.dirty = false;
    this.degraded = false;
    this.hasWarned = false;
    this.lastSavedAt = undefined;
    this.applyStoredPermission();
    this.attachCheckpointHandler();
    if (typeof oldEngine.close === 'function') {
      await oldEngine.close().catch(() => undefined);
    }
    return {
      sessionId,
      title: this.title,
      providerId: this.currentProviderId,
      ...(created.warning ? { warning: created.warning } : {})
    };
  }

  async setProviderReference(providerId: string): Promise<void> {
    this.assertOpen();
    this.currentProviderId = providerId;
    this.markDirty();
    await this.tryAutoSave();
  }

  async setPermissionMode(
    mode: PermissionMode,
    scope: Exclude<PermissionGrantScope, 'none'> = 'session'
  ): Promise<void> {
    this.assertOpen();
    if (mode === 'fullAccess') {
      this.currentEngine.setPermissionMode(mode);
      return;
    }
    if (mode === 'safe') {
      this.permissionScope = 'none';
      this.currentEngine.setPermissionMode('safe');
      try {
        this.permissionGrants?.clear(this.store.workspaceId, this.currentEngine.getSessionId());
      } catch (error) {
        this.warn(`Permission grant could not be cleared from disk: ${messageForError(error)}`);
      }
      return;
    }
    this.currentEngine.setPermissionMode('acceptEdits');
    this.persistAcceptEdits(scope);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      if (this.autoSave && this.dirty) {
        await this.saveState(this.currentEngine.exportState());
      }
    } catch (error) {
      this.reportPersistenceFailure(error);
    } finally {
      this.detachCheckpointHandler();
      if (typeof this.currentEngine.close === 'function') {
        await this.currentEngine.close().catch(() => undefined);
      }
      await this.lease.release();
      this.closed = true;
    }
  }

  private attachCheckpointHandler(): void {
    this.currentEngine.setCheckpointHandler(
      async (_reason, state) => {
        this.markDirty();
        if (this.autoSave) {
          await this.saveState(state);
        }
      },
      (error) => this.reportPersistenceFailure(error)
    );
    this.currentEngine.setPersistenceStatusProvider(() => {
      const status = this.getStatus();
      return {
        state: status.persistence,
        dirty: status.dirty,
        ...(status.lastSavedAt ? { lastSavedAt: status.lastSavedAt } : {})
      };
    });
  }

  private detachCheckpointHandler(): void {
    this.currentEngine.setCheckpointHandler(undefined);
    this.currentEngine.setPersistenceStatusProvider(undefined);
  }

  private markDirty(): void {
    this.dirty = true;
    this.updatedAt = new Date(this.now()).toISOString();
  }

  private async tryAutoSave(): Promise<void> {
    if (!this.autoSave) {
      return;
    }
    try {
      await this.saveState(this.currentEngine.exportState());
    } catch (error) {
      this.reportPersistenceFailure(error);
    }
  }

  private async saveBeforeSwitch(): Promise<void> {
    if (this.autoSave && this.dirty) {
      try {
        await this.saveState(this.currentEngine.exportState());
      } catch (error) {
        this.reportPersistenceFailure(error);
        throw error;
      }
    }
  }

  private async saveState(engineState: QueryEngineStateV1): Promise<SessionMetadata> {
    const status = this.currentEngine.getStatus();
    const revision = this.revision + 1;
    const updatedAt = new Date(this.now()).toISOString();
    const snapshot: SessionSnapshotV1 = {
      schemaVersion: 1,
      revision,
      sessionId: status.sessionId,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt,
      workspace: {
        id: this.store.workspaceId,
        root: this.store.workspaceRoot
      },
      provider: {
        id: this.currentProviderId,
        model: status.provider.model,
        ...(status.lastReportedModel ? { lastReportedModel: status.lastReportedModel } : {})
      },
      mode: status.mode,
      engineState,
      usage: {
        turns: this.turns,
        ...engineState.totalUsage
      },
      auditSessionId: status.sessionId
    };
    const metadata = await this.store.save(snapshot, this.lease);
    this.revision = revision;
    this.updatedAt = updatedAt;
    this.lastSavedAt = updatedAt;
    this.dirty = false;
    this.degraded = false;
    this.hasWarned = false;
    return metadata;
  }

  private reportPersistenceFailure(error: unknown): void {
    this.degraded = true;
    this.dirty = true;
    if (this.hasWarned) {
      return;
    }
    this.hasWarned = true;
    this.warn(`Session autosave failed: ${messageForError(error)}`);
  }

  private applyStoredPermission(): void {
    this.currentEngine.setPermissionMode('safe');
    this.permissionScope = 'none';
    if (!this.permissionGrants) return;
    try {
      const grant = this.permissionGrants.resolve(
        this.store.workspaceId,
        this.currentEngine.getSessionId()
      );
      this.permissionScope = grant.scope;
      this.currentEngine.setPermissionMode(grant.mode);
    } catch (error) {
      this.warn(`Permission grants ignored: ${messageForError(error)}`);
    }
  }

  private persistAcceptEdits(scope: Exclude<PermissionGrantScope, 'none'>): void {
    if (!this.permissionGrants) return;
    try {
      this.permissionGrants.setAcceptEdits(
        this.store.workspaceId,
        this.currentEngine.getSessionId(),
        scope
      );
      this.permissionScope = scope;
    } catch (error) {
      this.permissionScope = 'none';
      this.warn(`Permission grant was not persisted: ${messageForError(error)}`);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Session controller is closed');
    }
  }
}
