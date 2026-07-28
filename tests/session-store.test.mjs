import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SESSION_STATE_BYTES,
  SessionStore,
  SessionStoreError
} from '../dist/session-store.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '11111111-1111-4111-8111-222222222222';

function snapshot(store, sessionId = SESSION_A, overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    sessionId,
    title: 'Phase 4 session',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:01:00.000Z',
    workspace: {
      id: store.workspaceId,
      root: store.workspaceRoot
    },
    provider: {
      id: 'test',
      model: 'test-model'
    },
    mode: 'plan',
    engineState: {
      schemaVersion: 1,
      messages: [
        { role: 'user', content: 'Inspect the project' },
        { role: 'assistant', content: 'Plan ready' }
      ],
      pendingFileChangeReceipts: [],
      compactionCount: 1,
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    },
    usage: {
      turns: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    },
    auditSessionId: sessionId,
    ...overrides
  };
}

async function withStore(callback, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-sessions-'));
  const workspace = join(directory, 'workspace');
  const baseDirectory = join(directory, 'sessions');
  await mkdir(workspace);
  try {
    const store = await SessionStore.create({
      workspaceRoot: workspace,
      baseDirectory,
      now: () => Date.parse('2026-07-28T00:02:00.000Z'),
      hostname: 'test-host',
      pid: 1234,
      isProcessAlive: () => true,
      ...options
    });
    await callback({ store, directory, workspace, baseDirectory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('session store atomically saves, loads, lists, and rebuilds metadata', async () => {
  await withStore(async ({ store }) => {
    const lease = await store.acquire(SESSION_A);
    await store.save(snapshot(store), lease);

    const loaded = await store.load('11111111-1111-4111-8111-111111111111');
    assert.equal(loaded.title, 'Phase 4 session');
    assert.equal(loaded.engineState.messages.length, 2);
    assert.equal((await store.list())[0].mode, 'plan');

    const sessionDirectory = join(store.workspaceDirectory, SESSION_A);
    await writeFile(join(sessionDirectory, 'meta.json'), '{broken');
    const rebuilt = await store.list();
    assert.equal(rebuilt[0].available, true);
    assert.equal(rebuilt[0].title, 'Phase 4 session');
    assert.doesNotMatch(
      await readFile(join(sessionDirectory, 'meta.json'), 'utf8'),
      /broken/
    );
    assert.equal(
      (await readdir(sessionDirectory)).some(name => name.endsWith('.tmp')),
      false
    );

    if (process.platform !== 'win32') {
      assert.equal((await stat(join(sessionDirectory, 'state.json'))).mode & 0o777, 0o600);
    }
    await lease.release();
  });
});

test('stale metadata is rebuilt from the authoritative state snapshot', async () => {
  await withStore(async ({ store }) => {
    const lease = await store.acquire(SESSION_A);
    await store.save(snapshot(store), lease);
    await lease.release();

    const sessionDirectory = join(store.workspaceDirectory, SESSION_A);
    const statePath = join(sessionDirectory, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.revision = 2;
    state.title = 'State is authoritative';
    state.updatedAt = '2026-07-28T00:02:30.000Z';
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const metadataPath = join(sessionDirectory, 'meta.json');
    const metadataMtimeMs = (await stat(metadataPath)).mtimeMs;
    const newerStateTime = new Date(metadataMtimeMs + 60_000);
    await utimes(statePath, newerStateTime, newerStateTime);
    assert.ok(
      (await stat(statePath)).mtimeMs > (await stat(metadataPath)).mtimeMs,
      'test setup must make state.json newer than meta.json'
    );

    const listed = await store.list();
    assert.equal(listed[0].available, true);
    assert.equal(listed[0].revision, 2);
    assert.equal(listed[0].title, 'State is authoritative');
    const metadata = JSON.parse(
      await readFile(metadataPath, 'utf8')
    );
    assert.equal(metadata.revision, 2);
  });
});

test('session locks reject live owners and recover dead owners', async () => {
  await withStore(async ({ store, workspace, baseDirectory }) => {
    const firstLease = await store.acquire(SESSION_A);
    await assert.rejects(
      () => store.acquire(SESSION_A),
      error => error instanceof SessionStoreError && error.code === 'LOCKED'
    );

    const recoveringStore = await SessionStore.create({
      workspaceRoot: workspace,
      baseDirectory,
      now: () => Date.parse('2026-07-28T00:03:00.000Z'),
      hostname: 'test-host',
      pid: 5678,
      isProcessAlive: () => false
    });
    const recoveredLease = await recoveringStore.acquire(SESSION_A);
    await firstLease.release();
    await recoveredLease.release();
  });
});

test('session lock timeout never overrides a verified live local owner', async () => {
  await withStore(async ({ store, workspace, baseDirectory }) => {
    const firstLease = await store.acquire(SESSION_A);
    const liveLocalStore = await SessionStore.create({
      workspaceRoot: workspace,
      baseDirectory,
      now: () => Date.parse('2026-07-30T00:02:00.000Z'),
      hostname: 'test-host',
      pid: 5678,
      staleLockMs: 24 * 60 * 60 * 1_000,
      isProcessAlive: () => true
    });
    await assert.rejects(
      () => liveLocalStore.acquire(SESSION_A),
      error => error instanceof SessionStoreError && error.code === 'LOCKED'
    );

    const timedOutRemoteStore = await SessionStore.create({
      workspaceRoot: workspace,
      baseDirectory,
      now: () => Date.parse('2026-07-30T00:02:00.000Z'),
      hostname: 'remote-host',
      pid: 9012,
      staleLockMs: 24 * 60 * 60 * 1_000,
      isProcessAlive: () => true
    });
    const recoveredLease = await timedOutRemoteStore.acquire(SESSION_A);
    await firstLease.release();
    await recoveredLease.release();
  });
});

test('session IDs resolve by unique prefix and locked sessions cannot be deleted', async () => {
  await withStore(async ({ store }) => {
    const leaseA = await store.acquire(SESSION_A);
    await store.save(snapshot(store, SESSION_A), leaseA);
    const leaseB = await store.acquire(SESSION_B);
    await store.save(snapshot(store, SESSION_B, {
      sessionId: SESSION_B,
      auditSessionId: SESSION_B,
      title: 'Second session'
    }), leaseB);

    assert.equal(await store.resolveSessionId('11111111-1111-4111-8111-1'), SESSION_A);
    await assert.rejects(
      () => store.resolveSessionId('1111'),
      error => error instanceof SessionStoreError &&
        error.code === 'AMBIGUOUS_ID'
    );
    await assert.rejects(
      () => store.resolveSessionId('9999'),
      error => error instanceof SessionStoreError &&
        error.code === 'NOT_FOUND' &&
        /current workspace/.test(error.message)
    );
    await assert.rejects(
      () => store.delete(SESSION_A),
      error => error instanceof SessionStoreError && error.code === 'LOCKED'
    );

    await leaseA.release();
    assert.equal(await store.delete(SESSION_A), SESSION_A);
    await leaseB.release();
  });
});

test('oversized and corrupt session states are isolated', async () => {
  await withStore(async ({ store }) => {
    const lease = await store.acquire(SESSION_A);
    await store.save(snapshot(store), lease);
    await lease.release();
    const statePath = join(store.workspaceDirectory, SESSION_A, 'state.json');

    await truncate(statePath, MAX_SESSION_STATE_BYTES + 1);
    await assert.rejects(
      () => store.load(SESSION_A),
      error => error instanceof SessionStoreError && error.code === 'TOO_LARGE'
    );
    const oversizedList = await store.list();
    assert.equal(oversizedList[0].available, false);
    assert.match(oversizedList[0].unavailableReason, /exceeds/i);

    await writeFile(statePath, '{"schemaVersion":1}');
    await writeFile(
      join(store.workspaceDirectory, SESSION_A, 'meta.json'),
      '{broken'
    );
    const listed = await store.list();
    assert.equal(listed[0].available, false);
    assert.match(listed[0].unavailableReason, /corrupt/i);
  });
});

test('session save accepts exactly 64 MiB and rejects one byte more atomically', {
  timeout: 30_000
}, async () => {
  await withStore(async ({ store }) => {
    const lease = await store.acquire(SESSION_A);
    const exact = snapshot(store, SESSION_A, {
      engineState: {
        schemaVersion: 1,
        messages: [{ role: 'user', content: '' }],
        pendingFileChangeReceipts: [],
        compactionCount: 0,
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      },
      usage: {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    });
    const emptySize = Buffer.byteLength(
      `${JSON.stringify(exact, null, 2)}\n`
    );
    exact.engineState.messages[0].content =
      'x'.repeat(MAX_SESSION_STATE_BYTES - emptySize);
    assert.equal(
      Buffer.byteLength(`${JSON.stringify(exact, null, 2)}\n`),
      MAX_SESSION_STATE_BYTES
    );
    await store.save(exact, lease);

    const oversized = structuredClone(exact);
    oversized.revision = 2;
    oversized.engineState.messages[0].content += 'x';
    await assert.rejects(
      () => store.save(oversized, lease),
      error => error instanceof SessionStoreError &&
        error.code === 'TOO_LARGE'
    );
    const loaded = await store.load(SESSION_A);
    assert.equal(loaded.revision, 1);
    assert.equal(
      loaded.engineState.messages[0].content.length,
      MAX_SESSION_STATE_BYTES - emptySize
    );
    assert.equal(
      (await readdir(join(store.workspaceDirectory, SESSION_A)))
        .some(name => name.endsWith('.tmp')),
      false
    );
    await lease.release();
  });
});

test('prune removes only old unlocked sessions in the current workspace', async () => {
  await withStore(async ({ store }) => {
    const leaseA = await store.acquire(SESSION_A);
    await store.save(snapshot(store, SESSION_A, {
      updatedAt: '2026-07-20T00:00:00.000Z'
    }), leaseA);
    await leaseA.release();

    const leaseB = await store.acquire(SESSION_B);
    await store.save(snapshot(store, SESSION_B, {
      sessionId: SESSION_B,
      auditSessionId: SESSION_B,
      title: 'Locked old session',
      updatedAt: '2026-07-20T00:00:00.000Z'
    }), leaseB);

    assert.deepEqual(await store.prune(1), [SESSION_A]);
    assert.equal((await store.list())[0].sessionId, SESSION_B);
    await leaseB.release();
  });
});

test('session snapshots cannot be restored through another workspace bucket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syzzz-workspace-scope-'));
  const firstWorkspace = join(directory, 'first');
  const secondWorkspace = join(directory, 'second');
  const baseDirectory = join(directory, 'sessions');
  await mkdir(firstWorkspace);
  await mkdir(secondWorkspace);
  try {
    const first = await SessionStore.create({
      workspaceRoot: firstWorkspace,
      baseDirectory
    });
    const lease = await first.acquire(SESSION_A);
    await first.save(snapshot(first), lease);
    await lease.release();

    const second = await SessionStore.create({
      workspaceRoot: secondWorkspace,
      baseDirectory
    });
    await cp(
      join(first.workspaceDirectory, SESSION_A),
      join(second.workspaceDirectory, SESSION_A),
      { recursive: true }
    );
    await assert.rejects(
      () => second.load(SESSION_A),
      error => error instanceof SessionStoreError &&
        error.code === 'WORKSPACE_MISMATCH'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
