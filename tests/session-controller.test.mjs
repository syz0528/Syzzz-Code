import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { QueryEngine } from '../dist/engine.js';
import { SessionController } from '../dist/session-controller.js';
import { SessionStore } from '../dist/session-store.js';

const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function provider(response = 'done') {
  return {
    async chat() {
      return {
        message: {
          role: 'assistant',
          content: response,
          reasoningContent: 'private reasoning'
        },
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14
        },
        reportedModel: 'reported-model'
      };
    },
    getInfo() {
      return {
        name: 'Test Provider',
        type: 'test',
        model: 'test-model',
        capabilities: { streaming: false, reasoningToggle: false }
      };
    }
  };
}

async function withController(callback, { autoSave = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-controller-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const store = await SessionStore.create({
    workspaceRoot: workspace,
    baseDirectory: join(directory, 'sessions'),
    hostname: 'test-host',
    isProcessAlive: () => true
  });
  const makeEngine = ({ sessionId, mode = 'code' }) => ({
    engine: new QueryEngine({
      provider: provider(),
      tools: [],
      sessionId,
      mode,
      audit: false
    }),
    providerId: 'test'
  });
  const initial = makeEngine({ sessionId: SESSION_A });
  const controller = await SessionController.create({
    store,
    engine: initial.engine,
    providerId: 'test',
    autoSave,
    engineFactory: makeEngine,
    idFactory: () => SESSION_B
  });
  try {
    await callback({ controller, store, directory });
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('session controller autosaves portable state and restores mode with safe permissions', async () => {
  await withController(async ({ controller, store }) => {
    controller.engine.setMode('plan');
    controller.engine.setPermissionMode('fullAccess');
    await controller.stateChanged();
    const response = await controller.engine.chat('Plan this');
    await controller.recordTurn('Plan this', {
      status: 'completed',
      response,
      durationMs: 1
    });

    const saved = await store.load(SESSION_A);
    assert.equal(saved.title, 'Plan this');
    assert.equal(saved.mode, 'plan');
    assert.equal(saved.usage.turns, 1);
    assert.equal(saved.provider.lastReportedModel, 'reported-model');
    assert.equal(
      saved.engineState.messages.some((message) => 'reasoningContent' in message),
      false
    );

    await controller.newSession();
    assert.equal(controller.engine.getSessionId(), SESSION_B);
    const resumed = await controller.resume(SESSION_A.slice(0, 12));
    assert.equal(resumed.sessionId, SESSION_A);
    assert.equal(controller.engine.getMode(), 'plan');
    assert.equal(controller.engine.getPermissionMode(), 'safe');
    assert.equal(controller.engine.getMessages().at(-1).content, 'done');
    assert.equal(controller.engine.getStatus().persistence.state, 'healthy');

    controller.engine.setPermissionMode('fullAccess');
    await controller.resume(SESSION_A);
    assert.equal(controller.engine.getPermissionMode(), 'safe');
  });
});

test('autosave off keeps state in memory until an explicit save', async () => {
  await withController(
    async ({ controller, store }) => {
      await controller.engine.chat('Do not save automatically');
      await controller.recordTurn('Do not save automatically', {
        status: 'completed',
        response: 'done',
        durationMs: 1
      });

      assert.equal((await store.list()).length, 0);
      assert.equal(controller.getStatus().dirty, true);
      await controller.save();
      assert.equal((await store.list()).length, 1);
      assert.equal(controller.getStatus().dirty, false);
    },
    { autoSave: false }
  );
});

test('a successful file side effect is checkpointed before a later turn failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-receipt-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const store = await SessionStore.create({
    workspaceRoot: workspace,
    baseDirectory: join(directory, 'sessions')
  });
  let providerCalls = 0;
  const failingProvider = {
    async chat() {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'write-1',
                name: 'Write',
                input: { path: 'changed.ts' }
              }
            ]
          }
        };
      }
      throw new Error('provider failed after write');
    },
    getInfo() {
      return {
        name: 'Test',
        type: 'test',
        model: 'test-model',
        capabilities: { streaming: false, reasoningToggle: false }
      };
    }
  };
  const writeTool = {
    name: 'Write',
    description: 'Write',
    inputSchema: z.object({ path: z.string() }).strict(),
    risk: 'write',
    approval: 'never',
    async execute() {
      return {
        content: 'changed',
        metadata: { versionHash: 'abc123' }
      };
    }
  };
  const engine = new QueryEngine({
    provider: failingProvider,
    tools: [writeTool],
    sessionId: SESSION_A,
    permissionMode: 'fullAccess',
    audit: false,
    providerRunner: { maxAttempts: 1 }
  });
  const controller = await SessionController.create({
    store,
    engine,
    providerId: 'test',
    autoSave: true,
    engineFactory: () => ({ engine, providerId: 'test' })
  });
  try {
    await assert.rejects(() => engine.chat('Change the file'), /provider request failed/);
    const checkpoint = await store.load(SESSION_A);
    assert.deepEqual(checkpoint.engineState.pendingFileChangeReceipts, [
      {
        path: 'changed.ts',
        versionHash: 'abc123'
      }
    ]);
    assert.deepEqual(checkpoint.engineState.messages, []);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a file side effect remains recoverable when the turn is cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-cancel-receipt-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const store = await SessionStore.create({
    workspaceRoot: workspace,
    baseDirectory: join(directory, 'sessions')
  });
  let providerCalls = 0;
  const provider = {
    async chat(_request, options = {}) {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'write-before-cancel',
                name: 'Write',
                input: { path: 'cancelled.ts' }
              }
            ]
          }
        };
      }
      return new Promise((_resolve, reject) => {
        const rejectForAbort = () => reject(options.signal?.reason ?? new Error('aborted'));
        if (options.signal?.aborted) {
          rejectForAbort();
        } else {
          options.signal?.addEventListener('abort', rejectForAbort, {
            once: true
          });
        }
      });
    },
    getInfo() {
      return {
        name: 'Test',
        type: 'test',
        model: 'test-model',
        capabilities: { streaming: false, reasoningToggle: false }
      };
    }
  };
  const writeTool = {
    name: 'Write',
    description: 'Write',
    inputSchema: z.object({ path: z.string() }).strict(),
    risk: 'write',
    approval: 'never',
    async execute() {
      return {
        content: 'changed',
        metadata: { versionHash: 'cancel-hash' }
      };
    }
  };
  const engine = new QueryEngine({
    provider,
    tools: [writeTool],
    sessionId: SESSION_A,
    permissionMode: 'fullAccess',
    audit: false,
    providerRunner: { maxAttempts: 1 }
  });
  const controller = await SessionController.create({
    store,
    engine,
    providerId: 'test',
    autoSave: true,
    engineFactory: () => ({ engine, providerId: 'test' })
  });
  try {
    const abortController = new AbortController();
    const turn = engine.runTurn('Change then wait', {
      signal: abortController.signal
    });
    let providerStarts = 0;
    let result;
    while (true) {
      const next = await turn.next();
      if (next.done) {
        result = next.value;
        break;
      }
      if (next.value.type === 'provider_request_started') {
        providerStarts += 1;
        if (providerStarts === 2) {
          abortController.abort();
        }
      }
    }
    assert.equal(result.status, 'cancelled');
    await controller.recordTurn('Change then wait', result);

    const checkpoint = await store.load(SESSION_A);
    assert.deepEqual(checkpoint.engineState.pendingFileChangeReceipts, [
      {
        path: 'cancelled.ts',
        versionHash: 'cancel-hash'
      }
    ]);
    assert.deepEqual(checkpoint.engineState.messages, []);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistence failures degrade status without changing in-memory state', async () => {
  await withController(async ({ controller, store }) => {
    const originalSave = store.save.bind(store);
    store.save = async () => {
      throw new Error('disk unavailable');
    };

    controller.engine.setMode('ask');
    await controller.stateChanged();
    assert.equal(controller.engine.getMode(), 'ask');
    assert.equal(controller.getStatus().persistence, 'degraded');
    assert.equal(controller.getStatus().dirty, true);
    assert.equal(controller.engine.getStatus().persistence.state, 'degraded');
    await assert.rejects(() => controller.save(), /disk unavailable/);

    store.save = originalSave;
    await controller.save();
    assert.equal(controller.getStatus().persistence, 'healthy');
    assert.equal(controller.getStatus().dirty, false);
  });
});

test('resume falls back to configured Provider and clears stale reported model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-fallback-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const store = await SessionStore.create({
    workspaceRoot: workspace,
    baseDirectory: join(directory, 'sessions')
  });
  const savedLease = await store.acquire(SESSION_A);
  await store.save(
    {
      schemaVersion: 1,
      revision: 1,
      sessionId: SESSION_A,
      title: 'Unavailable Provider session',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:01:00.000Z',
      workspace: {
        id: store.workspaceId,
        root: store.workspaceRoot
      },
      provider: {
        id: 'removed-provider',
        model: 'removed-model',
        lastReportedModel: 'removed-reported-model'
      },
      mode: 'plan',
      engineState: {
        schemaVersion: 1,
        messages: [{ role: 'user', content: 'Keep this context' }],
        pendingFileChangeReceipts: [],
        compactionCount: 2,
        totalUsage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        lastReportedModel: 'removed-reported-model'
      },
      usage: {
        turns: 1,
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10
      },
      auditSessionId: SESSION_A
    },
    savedLease
  );
  await savedLease.release();

  const fallbackProvider = {
    async chat() {
      return { message: { role: 'assistant', content: 'fallback' } };
    },
    getInfo() {
      return {
        name: 'Fallback',
        type: 'test',
        model: 'fallback-model',
        capabilities: { streaming: false, reasoningToggle: false }
      };
    }
  };
  const makeFallback = ({ sessionId, mode = 'code' }) => ({
    engine: new QueryEngine({
      provider: fallbackProvider,
      tools: [],
      sessionId,
      mode,
      audit: false
    }),
    providerId: 'fallback-provider',
    warning: 'Saved Provider is unavailable; using fallback-provider.'
  });
  const initial = makeFallback({ sessionId: SESSION_B });
  const controller = await SessionController.create({
    store,
    engine: initial.engine,
    providerId: initial.providerId,
    autoSave: true,
    engineFactory: makeFallback
  });
  try {
    const result = await controller.resume(SESSION_A);
    assert.match(result.warning, /unavailable/);
    assert.equal(controller.providerId, 'fallback-provider');
    assert.equal(controller.engine.getMode(), 'plan');
    assert.equal(controller.engine.getStatus().lastReportedModel, undefined);
    assert.equal(controller.engine.getMessages()[0].content, 'Keep this context');

    const updated = await store.load(SESSION_A);
    assert.equal(updated.provider.id, 'fallback-provider');
    assert.equal(updated.provider.model, 'fallback-model');
    assert.equal(updated.engineState.lastReportedModel, undefined);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('session switching stays on the current engine when old lease release fails', async () => {
  await withController(async ({ controller, store }) => {
    const originalEngine = controller.engine;
    const originalRelease = controller.lease.release.bind(controller.lease);
    controller.lease.release = async () => {
      throw new Error('lock release failed');
    };

    await assert.rejects(() => controller.newSession('Next'), /lock release failed/);
    assert.equal(controller.engine, originalEngine);
    assert.equal(controller.engine.getSessionId(), SESSION_A);
    const nextLease = await store.acquire(SESSION_B);
    await nextLease.release();

    controller.lease.release = originalRelease;
    await assert.rejects(() => controller.newSession('   '), /title cannot be empty/i);
    assert.equal(controller.engine, originalEngine);
  });
});
