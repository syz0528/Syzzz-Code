import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveShellInvocation, runShellCommand } from '../dist/tools/shell-runner.js';

async function withWorkingDirectory(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'syzzz-shell-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function commandFor(windowsCommand, posixCommand) {
  return process.platform === 'win32' ? windowsCommand : posixCommand;
}

test('selects the native shell without enabling child-process shell mode', () => {
  assert.deepEqual(resolveShellInvocation('echo ok', 'win32', { ComSpec: 'custom-cmd.exe' }), {
    executable: 'custom-cmd.exe',
    arguments: ['/d', '/s', '/c', '"echo ok"'],
    kind: 'cmd'
  });
  assert.deepEqual(resolveShellInvocation('echo ok', 'linux'), {
    executable: '/bin/sh',
    arguments: ['-c', 'echo ok'],
    kind: 'sh'
  });
});

test('captures successful stdout as a structured result', async () => {
  await withWorkingDirectory(async (cwd) => {
    const result = await runShellCommand('echo hello', {
      cwd,
      signal: new AbortController().signal
    });

    assert.equal(result.ok, true);
    assert.equal(result.completionReason, 'exited');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello/);
    assert.equal(result.stderr, '');
  });
});

test('keeps stderr and non-zero exit status separate from stdout', async () => {
  await withWorkingDirectory(async (cwd) => {
    const command = commandFor('echo failure 1>&2 & exit /b 7', 'echo failure >&2; exit 7');
    const result = await runShellCommand(command, {
      cwd,
      signal: new AbortController().signal
    });

    assert.equal(result.ok, false);
    assert.equal(result.completionReason, 'exited');
    assert.equal(result.exitCode, 7);
    assert.match(result.stderr, /failure/);
  });
});

test('does not spawn a command when cancellation already happened', async () => {
  await withWorkingDirectory(async (cwd) => {
    const abortController = new AbortController();
    abortController.abort();
    const result = await runShellCommand('echo should-not-run', {
      cwd,
      signal: abortController.signal
    });

    assert.equal(result.ok, false);
    assert.equal(result.completionReason, 'aborted');
    assert.equal(result.processId, null);
    assert.equal(result.stdout, '');
  });
});

test('terminates a command when its timeout expires', async () => {
  await withWorkingDirectory(async (cwd) => {
    const command = commandFor('ping -n 6 127.0.0.1 >nul', 'sleep 5');
    const result = await runShellCommand(command, {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 100,
      terminationGraceMs: 100
    });

    assert.equal(result.ok, false);
    assert.equal(result.completionReason, 'timeout');
    assert.equal(result.termination?.attempted, true);
    assert.ok(result.durationMs < 5_000);
  });
});

test('propagates runtime cancellation to the process tree', async () => {
  await withWorkingDirectory(async (cwd) => {
    const abortController = new AbortController();
    const command = commandFor('ping -n 6 127.0.0.1 >nul', 'sleep 5');
    const resultPromise = runShellCommand(command, {
      cwd,
      signal: abortController.signal,
      timeoutMs: 10_000,
      terminationGraceMs: 100
    });
    setTimeout(() => abortController.abort(), 100);

    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.equal(result.completionReason, 'aborted');
    assert.equal(result.termination?.attempted, true);
    assert.ok(result.durationMs < 5_000);
  });
});

test('terminates commands that exceed the configured output limit', async () => {
  await withWorkingDirectory(async (cwd) => {
    const command = 'node -e "process.stdout.write(\'x\'.repeat(10000))"';
    const result = await runShellCommand(command, {
      cwd,
      signal: new AbortController().signal,
      maxStdoutBytes: 128,
      terminationGraceMs: 100
    });

    assert.equal(result.completionReason, 'output_limit', JSON.stringify(result, null, 2));
    assert.equal(result.ok, false);
    assert.equal(result.outputLimitStream, 'stdout');
    assert.equal(result.stdoutBytesCaptured, 128);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(Buffer.byteLength(result.stdout), 128);
  });
});

test('termination removes descendant processes instead of leaving them running', async () => {
  await withWorkingDirectory(async (cwd) => {
    const readyPath = join(cwd, 'child-ready.txt');
    const childScript = [
      "const fs=require('node:fs')",
      'fs.writeFileSync(process.argv[1],String(process.pid))',
      'setInterval(()=>{},1000)'
    ].join(';');
    const command = `"${process.execPath}" -e "${childScript}" "${readyPath}"`;

    const result = await runShellCommand(command, {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 500,
      terminationGraceMs: 100
    });

    assert.equal(result.completionReason, 'timeout');
    assert.equal(result.termination?.succeeded, true, JSON.stringify(result, null, 2));
    const childProcessId = Number(await readFile(readyPath, 'utf8'));
    assert.equal(Number.isInteger(childProcessId), true);

    assert.throws(
      () => process.kill(childProcessId, 0),
      (error) => error?.code === 'ESRCH'
    );
  });
});
