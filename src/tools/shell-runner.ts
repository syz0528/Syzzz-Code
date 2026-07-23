import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STREAM_BYTES = 40 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const TERMINATION_DEADLINE_MS = 4_000;
const WINDOWS_PROCESS_SNAPSHOT_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SyzzzProcessSnapshot {
  private const uint SnapshotProcesses = 0x00000002;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  private struct ProcessEntry {
    public uint Size;
    public uint Usage;
    public uint ProcessId;
    public IntPtr DefaultHeapId;
    public uint ModuleId;
    public uint Threads;
    public uint ParentProcessId;
    public int BasePriority;
    public uint Flags;

    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string ExecutableFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  public static int[][] GetPairs() {
    var pairs = new List<int[]>();
    var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
    if (snapshot == new IntPtr(-1)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    try {
      var entry = new ProcessEntry();
      entry.Size = (uint)Marshal.SizeOf(entry);
      if (Process32First(snapshot, ref entry)) {
        do {
          pairs.Add(new[] { (int)entry.ProcessId, (int)entry.ParentProcessId });
        } while (Process32Next(snapshot, ref entry));
      }
    } finally {
      CloseHandle(snapshot);
    }

    return pairs.ToArray();
  }
}
`;

export type ShellCompletionReason =
  | 'exited'
  | 'timeout'
  | 'aborted'
  | 'output_limit'
  | 'spawn_error';

export interface ShellInvocation {
  executable: string;
  arguments: string[];
  kind: 'cmd' | 'sh';
}

export interface ProcessTerminationResult {
  attempted: boolean;
  strategy: 'posix-process-group' | 'windows-toolhelp';
  succeeded: boolean;
  forced: boolean;
  error?: string;
}

export interface ShellRunResult {
  ok: boolean;
  completionReason: ShellCompletionReason;
  command: string;
  cwd: string;
  shell: ShellInvocation;
  processId: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytesSeen: number;
  stderrBytesSeen: number;
  stdoutBytesCaptured: number;
  stderrBytesCaptured: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputLimitStream?: 'stdout' | 'stderr';
  termination?: ProcessTerminationResult;
  spawnError?: string;
}

export interface RunShellCommandOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  terminationGraceMs?: number;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

interface CapturedOutput {
  chunks: Buffer[];
  bytesSeen: number;
  bytesCaptured: number;
  truncated: boolean;
}

export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): ShellInvocation {
  if (platform === 'win32') {
    return {
      executable: environment.ComSpec || environment.COMSPEC || 'cmd.exe',
      arguments: ['/d', '/s', '/c', `"${command}"`],
      kind: 'cmd'
    };
  }

  return {
    executable: '/bin/sh',
    arguments: ['-c', command],
    kind: 'sh'
  };
}

function captureOutputChunk(
  output: CapturedOutput,
  chunk: Buffer,
  maximumBytes: number
): boolean {
  output.bytesSeen += chunk.length;
  const remainingBytes = Math.max(0, maximumBytes - output.bytesCaptured);

  if (remainingBytes > 0) {
    const capturedChunk = chunk.subarray(0, remainingBytes);
    output.chunks.push(capturedChunk);
    output.bytesCaptured += capturedChunk.length;
  }

  if (chunk.length > remainingBytes) {
    output.truncated = true;
    return true;
  }

  return false;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isProcessGroupRunning(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : undefined;
    return errorCode !== 'ESRCH';
  }
}

async function terminatePosixProcessGroup(
  processId: number,
  graceMilliseconds: number
): Promise<ProcessTerminationResult> {
  const result: ProcessTerminationResult = {
    attempted: true,
    strategy: 'posix-process-group',
    succeeded: false,
    forced: false
  };

  try {
    process.kill(-processId, 'SIGTERM');
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : undefined;
    if (errorCode === 'ESRCH') {
      return { ...result, succeeded: true };
    }
    return {
      ...result,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const deadline = Date.now() + graceMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessGroupRunning(processId)) {
      return { ...result, succeeded: true };
    }
    await wait(50);
  }

  try {
    process.kill(-processId, 'SIGKILL');
    return {
      ...result,
      succeeded: true,
      forced: true
    };
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : undefined;
    if (errorCode === 'ESRCH') {
      return { ...result, succeeded: true };
    }
    return {
      ...result,
      forced: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function terminateWindowsProcessTree(
  processId: number
): Promise<ProcessTerminationResult> {
  const result: ProcessTerminationResult = {
    attempted: true,
    strategy: 'windows-toolhelp',
    succeeded: false,
    forced: true
  };

  try {
    process.kill(processId, 'SIGKILL');
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : undefined;
    if (errorCode !== 'ESRCH') {
      result.error = error instanceof Error ? error.message : String(error);
    }
  }

  const snapshotSource = Buffer.from(
    WINDOWS_PROCESS_SNAPSHOT_SOURCE,
    'utf8'
  ).toString('base64');
  const script = [
    `$rootPid = ${processId}`,
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${snapshotSource}'))`,
    'Add-Type -TypeDefinition $source',
    '$all = [SyzzzProcessSnapshot]::GetPairs()',
    '$targets = New-Object System.Collections.Generic.List[int]',
    '$targets.Add($rootPid)',
    'for ($index = 0; $index -lt $targets.Count; $index++) {',
    '  $parentPid = $targets[$index]',
    '  foreach ($candidate in $all) {',
    '    $candidatePid = [int]$candidate[0]',
    '    if ([int]$candidate[1] -eq $parentPid -and -not $targets.Contains($candidatePid)) {',
    '      $targets.Add($candidatePid)',
    '    }',
    '  }',
    '}',
    'for ($index = $targets.Count - 1; $index -ge 0; $index--) {',
    '  Stop-Process -Id $targets[$index] -Force -ErrorAction SilentlyContinue',
    '}',
    '$remaining = @()',
    'for ($attempt = 0; $attempt -lt 20; $attempt++) {',
    '  $remaining = @($targets | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })',
    '  if ($remaining.Count -eq 0) { exit 0 }',
    '  Start-Sleep -Milliseconds 50',
    '}',
    'Write-Error ("Processes remained after termination: " + ($remaining -join ","))',
    'exit 1'
  ].join('; ');
  return new Promise(resolve => {
    const powershellProcess = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let output = '';
    let settled = false;
    const finish = (terminationResult: ProcessTerminationResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      resolve(terminationResult);
    };
    const deadlineTimer = setTimeout(() => {
      powershellProcess.kill('SIGKILL');
      finish({
        ...result,
        error: 'PowerShell process-tree termination exceeded its deadline'
      });
    }, TERMINATION_DEADLINE_MS);

    powershellProcess.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    powershellProcess.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    powershellProcess.on('error', error => {
      finish({ ...result, error: error.message });
    });
    powershellProcess.on('exit', exitCode => {
      const succeeded = exitCode === 0;
      finish({
        ...result,
        succeeded,
        ...(succeeded
          ? {}
          : {
              error: output.trim() || result.error ||
                `PowerShell process-tree termination exited with code ${exitCode ?? 'unknown'}`
            })
      });
    });
  });
}

async function terminateProcessTree(
  processId: number,
  platform: NodeJS.Platform,
  graceMilliseconds: number
): Promise<ProcessTerminationResult> {
  if (platform === 'win32') {
    return terminateWindowsProcessTree(processId);
  }

  return terminatePosixProcessGroup(processId, graceMilliseconds);
}

export async function runShellCommand(
  command: string,
  options: RunShellCommandOptions
): Promise<ShellRunResult> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const invocation = resolveShellInvocation(command, platform, environment);
  const startedAt = Date.now();

  const emptyOutput = (): CapturedOutput => ({
    chunks: [],
    bytesSeen: 0,
    bytesCaptured: 0,
    truncated: false
  });

  if (options.signal.aborted) {
    return {
      ok: false,
      completionReason: 'aborted',
      command,
      cwd: options.cwd,
      shell: invocation,
      processId: null,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      stdoutBytesSeen: 0,
      stderrBytesSeen: 0,
      stdoutBytesCaptured: 0,
      stderrBytesCaptured: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    };
  }

  return new Promise(resolve => {
    const stdout = emptyOutput();
    const stderr = emptyOutput();
    let requestedCompletionReason: ShellCompletionReason | undefined;
    let outputLimitStream: 'stdout' | 'stderr' | undefined;
    let terminationPromise: Promise<ProcessTerminationResult> | undefined;
    let spawnError: string | undefined;
    let isSettled = false;

    const childProcess = spawn(invocation.executable, invocation.arguments, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: platform === 'win32',
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const processId = childProcess.pid ?? null;
    let terminationDeadlineTimer: NodeJS.Timeout | undefined;

    const requestTermination = (reason: ShellCompletionReason): void => {
      if (requestedCompletionReason !== undefined) {
        return;
      }

      requestedCompletionReason = reason;
      if (processId !== null) {
        terminationPromise = terminateProcessTree(
          processId,
          platform,
          terminationGraceMs
        );
      }

      terminationDeadlineTimer = setTimeout(() => {
        void finalize(null, null);
      }, terminationGraceMs + TERMINATION_DEADLINE_MS);
    };

    const handleAbort = (): void => requestTermination('aborted');
    const timeoutTimer = setTimeout(
      () => requestTermination('timeout'),
      Math.max(1, timeoutMs)
    );

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (terminationDeadlineTimer) {
        clearTimeout(terminationDeadlineTimer);
      }
      options.signal.removeEventListener('abort', handleAbort);
    };

    const finalize = async (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null
    ): Promise<void> => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      cleanup();

      const termination = terminationPromise
        ? await terminationPromise
        : undefined;
      const completionReason = requestedCompletionReason ?? (
        spawnError ? 'spawn_error' : 'exited'
      );

      resolve({
        ok: completionReason === 'exited' && exitCode === 0,
        completionReason,
        command,
        cwd: options.cwd,
        shell: invocation,
        processId,
        exitCode,
        signal: exitSignal,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        stdoutBytesSeen: stdout.bytesSeen,
        stderrBytesSeen: stderr.bytesSeen,
        stdoutBytesCaptured: stdout.bytesCaptured,
        stderrBytesCaptured: stderr.bytesCaptured,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        ...(outputLimitStream ? { outputLimitStream } : {}),
        ...(termination ? { termination } : {}),
        ...(spawnError ? { spawnError } : {})
      });
    };

    childProcess.stdout?.on('data', (chunk: Buffer) => {
      if (captureOutputChunk(stdout, chunk, maxStdoutBytes)) {
        outputLimitStream = outputLimitStream ?? 'stdout';
        requestTermination('output_limit');
      }
    });
    childProcess.stderr?.on('data', (chunk: Buffer) => {
      if (captureOutputChunk(stderr, chunk, maxStderrBytes)) {
        outputLimitStream = outputLimitStream ?? 'stderr';
        requestTermination('output_limit');
      }
    });
    childProcess.on('error', error => {
      spawnError = error.message;
      requestedCompletionReason = requestedCompletionReason ?? 'spawn_error';
    });
    childProcess.on('close', (exitCode, exitSignal) => {
      void finalize(exitCode, exitSignal);
    });

    options.signal.addEventListener('abort', handleAbort, { once: true });
    if (options.signal.aborted) {
      handleAbort();
    }
  });
}
