import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupAuditDirectory,
  LocalAuditLogger,
  toAuditRecord
} from '../dist/audit.js';

function envelope(type, payload = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-audit',
    turnId: 'turn-audit',
    sequence: 1,
    timestamp: '2026-07-22T00:00:00.000Z',
    type,
    ...payload
  };
}

test('audit records only allowlisted metadata', () => {
  const toolEvent = envelope('tool_completed', {
    toolCallId: 'tool-1',
    toolName: 'Read',
    outcome: 'success',
    durationMs: 5,
    result: 'SECRET FILE CONTENT',
    metadata: {
      path: 'C:/secret.txt',
      diff: '+secret'
    }
  });
  const record = toAuditRecord(toolEvent, 'workspace-hash');
  const serialized = JSON.stringify(record);

  assert.equal(record.outcome, 'success');
  assert.equal(
    serialized.includes('SECRET FILE CONTENT'),
    false
  );
  assert.equal(serialized.includes('secret.txt'), false);
  assert.equal(serialized.includes('+secret'), false);
  assert.equal(toAuditRecord(envelope('text_delta', {
    attempt: 1,
    attemptId: 'a',
    delta: 'PRIVATE RESPONSE'
  }), 'workspace-hash'), undefined);

  const failed = toAuditRecord(envelope('turn_failed', {
    durationMs: 10,
    error: {
      code: 'authentication',
      message: 'API key sk-secret failed',
      provider: 'Provider',
      status: 401,
      requestId: 'req-1'
    }
  }), 'workspace-hash');
  assert.deepEqual(failed.error, {
    code: 'authentication',
    provider: 'Provider',
    status: 401,
    requestId: 'req-1'
  });

  const compaction = toAuditRecord(envelope('compaction_completed', {
    reason: 'threshold',
    mode: 'history',
    beforeTokens: 60_000,
    afterTokens: 20_000,
    messagesCompacted: 12,
    durationMs: 50,
    summary: 'PRIVATE COMPACTION SUMMARY'
  }), 'workspace-hash');
  assert.deepEqual(compaction, {
    schemaVersion: 1,
    sessionId: 'session-audit',
    turnId: 'turn-audit',
    sequence: 1,
    timestamp: '2026-07-22T00:00:00.000Z',
    type: 'compaction_completed',
    workspaceId: 'workspace-hash',
    reason: 'threshold',
    mode: 'history',
    beforeTokens: 60_000,
    afterTokens: 20_000,
    messagesCompacted: 12,
    durationMs: 50
  });
  assert.equal(
    JSON.stringify(compaction).includes('PRIVATE COMPACTION SUMMARY'),
    false
  );
});

test('local audit logger writes JSONL without raw content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'syzzz-audit-'));
  try {
    const logger = new LocalAuditLogger({
      config: {
        retentionDays: 30,
        maxBytes: 1024 * 1024
      },
      sessionId: 'session-write',
      workspaceRoot: root,
      baseDirectory: join(root, 'audit'),
      now: () => Date.parse('2026-07-22T00:00:00.000Z')
    });
    logger.record(envelope('turn_started', {
      provider: {
        name: 'Provider',
        type: 'test',
        model: 'model',
        capabilities: {
          streaming: true,
          reasoningToggle: true
        }
      }
    }));
    logger.record(envelope('text_delta', {
      attempt: 1,
      attemptId: 'a',
      delta: 'DO NOT WRITE THIS'
    }));
    logger.record(envelope('tool_completed', {
      toolCallId: 'tool-1',
      toolName: 'Shell',
      outcome: 'success',
      durationMs: 3,
      result: 'SHELL SECRET'
    }));
    await logger.flush();

    const content = readFileSync(logger.getFilePath(), 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map(line => line.type),
      ['turn_started', 'tool_completed']
    );
    assert.equal(content.includes('DO NOT WRITE THIS'), false);
    assert.equal(content.includes('SHELL SECRET'), false);
    assert.match(lines[0].workspaceId, /^[a-f0-9]{16}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit cleanup enforces age, size and current protection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'syzzz-audit-clean-'));
  const directory = join(root, 'audit');
  const now = Date.parse('2026-07-22T00:00:00.000Z');
  const oldFile = join(directory, 'old.jsonl');
  const middleFile = join(directory, 'middle.jsonl');
  const currentFile = join(directory, 'current.jsonl');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(oldFile, 'o'.repeat(100));
    await writeFile(middleFile, 'm'.repeat(100));
    await writeFile(currentFile, 'c'.repeat(100));
    await utimes(
      oldFile,
      new Date(now - 40 * 86_400_000),
      new Date(now - 40 * 86_400_000)
    );
    await utimes(
      middleFile,
      new Date(now - 2_000),
      new Date(now - 2_000)
    );
    await utimes(
      currentFile,
      new Date(now - 50 * 86_400_000),
      new Date(now - 50 * 86_400_000)
    );

    await cleanupAuditDirectory(directory, {
      retentionDays: 30,
      maxBytes: 150
    }, currentFile, now);

    assert.equal(existsSync(oldFile), false);
    assert.equal(existsSync(middleFile), false);
    assert.equal(existsSync(currentFile), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retention zero disables files and failures warn once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'syzzz-audit-disabled-'));
  try {
    const disabled = new LocalAuditLogger({
      config: { retentionDays: 0, maxBytes: 1024 },
      sessionId: 'disabled',
      workspaceRoot: root,
      baseDirectory: join(root, 'disabled-audit')
    });
    disabled.record(envelope('turn_cancelled', {
      durationMs: 1,
      reason: 'secret'
    }));
    await disabled.flush();
    assert.equal(existsSync(disabled.getFilePath()), false);

    const blockedPath = join(root, 'not-a-directory');
    writeFileSync(blockedPath, 'file');
    const warnings = [];
    const failing = new LocalAuditLogger({
      config: { retentionDays: 30, maxBytes: 1024 },
      sessionId: 'failing',
      workspaceRoot: root,
      baseDirectory: blockedPath,
      warn: warning => warnings.push(warning)
    });
    failing.record(envelope('turn_cancelled', {
      durationMs: 1,
      reason: 'one'
    }));
    failing.record(envelope('turn_cancelled', {
      durationMs: 2,
      reason: 'two'
    }));
    await failing.flush();
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
