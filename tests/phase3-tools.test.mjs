import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  editTool,
  gitDiffTool,
  gitStatusTool,
  globTool,
  grepTool,
  patchTool,
  readTool
} from '../dist/tools/index.js';

const execFileAsync = promisify(execFile);

async function withWorkspace(run) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'syzzz-phase3-tools-'));
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function createContext(workspaceRoot, approvalData, signal = new AbortController().signal) {
  return {
    toolCallId: 'phase3-test-call',
    workspaceRoot,
    workingDirectory: workspaceRoot,
    signal,
    ...(approvalData === undefined ? {} : { approvalData })
  };
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

test('Glob and Grep stay bounded, paginate, and exclude ignored and sensitive content', async () => {
  await withWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, 'src'));
    await writeFile(
      join(workspaceRoot, 'src', 'alpha.ts'),
      'export const needle = 1;\nconst nearby = true;\n',
      'utf8'
    );
    await writeFile(join(workspaceRoot, 'src', 'beta.ts'), 'export const needle = 2;\n', 'utf8');
    await writeFile(join(workspaceRoot, 'ignored.ts'), 'needle ignored\n', 'utf8');
    await writeFile(join(workspaceRoot, '.gitignore'), 'ignored.ts\n', 'utf8');
    await writeFile(join(workspaceRoot, '.env'), 'TOP_SECRET_NEEDLE=1\n', 'utf8');
    await writeFile(join(workspaceRoot, '.env.example'), 'EXAMPLE_NEEDLE=1\n', 'utf8');

    const glob = await globTool.execute(
      { pattern: '**/*.ts', limit: 1 },
      createContext(workspaceRoot)
    );
    assert.equal(glob.isError, undefined);
    assert.equal(glob.metadata.shownCount, 1);
    assert.equal(glob.metadata.truncated, true);
    assert.doesNotMatch(glob.content, /ignored\.ts/);
    assert.doesNotMatch(glob.content, /\.env/);

    const content = await grepTool.execute(
      {
        pattern: 'needle',
        path: 'src',
        outputMode: 'content',
        ignoreCase: true,
        context: 1,
        limit: 10
      },
      createContext(workspaceRoot)
    );
    assert.equal(content.isError, undefined);
    assert.match(content.content, /src\/alpha\.ts:1:export const needle/);
    assert.match(content.content, /src\/alpha\.ts-2-const nearby/);
    assert.match(content.content, /src\/beta\.ts:1:export const needle/);
    assert.ok(Buffer.byteLength(content.content, 'utf8') <= 40 * 1024);

    const files = await grepTool.execute(
      { pattern: 'needle', outputMode: 'files', ignoreCase: true },
      createContext(workspaceRoot)
    );
    assert.equal(files.isError, undefined);
    assert.match(files.content, /src\/alpha\.ts/);
    assert.match(files.content, /src\/beta\.ts/);
    assert.doesNotMatch(files.content, /ignored\.ts/);

    const count = await grepTool.execute(
      { pattern: 'needle', outputMode: 'count', ignoreCase: true },
      createContext(workspaceRoot)
    );
    assert.equal(count.isError, undefined);
    assert.match(count.content, /src\/alpha\.ts:1/);

    const sensitive = await grepTool.execute(
      { pattern: 'TOP_SECRET_NEEDLE', outputMode: 'content' },
      createContext(workspaceRoot)
    );
    assert.equal(sensitive.isError, undefined);
    assert.doesNotMatch(sensitive.content, /TOP_SECRET_NEEDLE=1/);

    const example = await grepTool.execute(
      { pattern: 'EXAMPLE_NEEDLE', outputMode: 'files' },
      createContext(workspaceRoot)
    );
    assert.equal(example.isError, undefined);
    assert.match(example.content, /\.env\.example/);
  });
});
test('Grep supports a single file path and literal matching', async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, 'literal.txt'), 'a+b\nother\n', 'utf8');
    const result = await grepTool.execute(
      {
        pattern: 'a+b',
        path: 'literal.txt',
        literal: true,
        outputMode: 'content'
      },
      createContext(workspaceRoot)
    );
    assert.equal(result.isError, undefined);
    assert.match(result.content, /literal\.txt:1:a\+b/);
  });
});

test('Read returns line ranges, versions, CRLF metadata, and bounded continuation', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const content =
      Array.from({ length: 700 }, (_, index) => `line-${index + 1}`).join('\r\n') + '\r\n';
    await writeFile(join(workspaceRoot, 'range.txt'), content, 'utf8');

    const result = await readTool.execute(
      { path: 'range.txt', offset: 101, limit: 3 },
      createContext(workspaceRoot)
    );
    assert.equal(result.isError, undefined);
    assert.match(result.content, /101\| line-101/);
    assert.match(result.content, /103\| line-103/);
    assert.doesNotMatch(result.content, /104\|/);
    assert.equal(result.metadata.totalLines, 700);
    assert.equal(result.metadata.nextOffset, 104);
    assert.equal(result.metadata.lineEnding, 'CRLF');
    assert.equal(result.metadata.versionHash, sha256(content));
  });
});

test('Read permits explicit ranges up to 8 MiB while keeping model output bounded', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const overLegacyLimit = `${'line\n'.repeat(230_000)}`;
    assert.ok(Buffer.byteLength(overLegacyLimit) > 1024 * 1024);
    await writeFile(join(workspaceRoot, 'large.txt'), overLegacyLimit, 'utf8');

    const unbounded = await readTool.execute({ path: 'large.txt' }, createContext(workspaceRoot));
    assert.equal(unbounded.isError, true);
    assert.match(unbounded.content, /Provide offset or limit/);

    const ranged = await readTool.execute(
      { path: 'large.txt', offset: 200_000, limit: 2 },
      createContext(workspaceRoot)
    );
    assert.equal(ranged.isError, undefined);
    assert.match(ranged.content, /200000\| line/);
    assert.ok(Buffer.byteLength(ranged.content, 'utf8') <= 40 * 1024);

    await writeFile(join(workspaceRoot, 'over-eight.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    const overEight = await readTool.execute(
      { path: 'over-eight.bin', offset: 1, limit: 1 },
      createContext(workspaceRoot)
    );
    assert.equal(overEight.isError, true);
    assert.match(overEight.content, /limit is 8388608 bytes/);
  });
});

test('Patch applies exact non-overlapping operations and preserves CRLF style', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const targetPath = join(workspaceRoot, 'patch.ts');
    const original = 'const alpha = 1;\r\nconst beta = 2;\r\n';
    await writeFile(targetPath, original, 'utf8');
    const input = {
      path: 'patch.ts',
      expectedHash: sha256(original),
      operations: [
        { oldText: 'alpha = 1;\n', newText: 'alpha = 10;\n' },
        { oldText: 'beta = 2;', newText: 'beta = 20;' }
      ]
    };

    const approval = await patchTool.prepareApproval(input, createContext(workspaceRoot));
    assert.match(approval.preview, /alpha = 10/);
    assert.match(approval.preview, /beta = 20/);
    const result = await patchTool.execute(
      input,
      createContext(workspaceRoot, approval.executionData)
    );

    assert.equal(result.isError, undefined);
    assert.match(result.content, /Version: sha256:[a-f0-9]{64}/);
    assert.equal(result.metadata.changeCount, 2);
    assert.equal(await readFile(targetPath, 'utf8'), 'const alpha = 10;\r\nconst beta = 20;\r\n');
    assert.equal(
      (await readdir(workspaceRoot)).some((name) => name.includes('.syzzz-')),
      false
    );
  });
});

test('Patch rejects stale, ambiguous, overlapping, and post-approval changes', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const targetPath = join(workspaceRoot, 'conflict.txt');
    await writeFile(targetPath, 'same same unique\n', 'utf8');

    await assert.rejects(
      patchTool.prepareApproval(
        {
          path: 'conflict.txt',
          expectedHash: '0'.repeat(64),
          operations: [{ oldText: 'unique', newText: 'changed' }]
        },
        createContext(workspaceRoot)
      ),
      /changed after it was read/
    );
    await assert.rejects(
      patchTool.prepareApproval(
        {
          path: 'conflict.txt',
          expectedHash: sha256('same same unique\n'),
          operations: [{ oldText: 'same', newText: 'different' }]
        },
        createContext(workspaceRoot)
      ),
      /found 2 matches/
    );
    await assert.rejects(
      patchTool.prepareApproval(
        {
          path: 'conflict.txt',
          expectedHash: sha256('same same unique\n'),
          operations: [
            { oldText: 'same same', newText: 'first' },
            { oldText: 'same unique', newText: 'second' }
          ]
        },
        createContext(workspaceRoot)
      ),
      /overlap/
    );

    const input = {
      path: 'conflict.txt',
      expectedHash: sha256('same same unique\n'),
      operations: [{ oldText: 'unique', newText: 'changed' }]
    };
    const approval = await patchTool.prepareApproval(input, createContext(workspaceRoot));
    await writeFile(targetPath, 'external\n', 'utf8');
    const result = await patchTool.execute(
      input,
      createContext(workspaceRoot, approval.executionData)
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /changed after approval/);
    assert.equal(await readFile(targetPath, 'utf8'), 'external\n');
  });
});

test('Edit optionally enforces the Read version hash', async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, 'edit.txt'), 'before\n', 'utf8');
    await assert.rejects(
      editTool.prepareApproval(
        {
          path: 'edit.txt',
          old_string: 'before',
          new_string: 'after',
          expectedHash: '0'.repeat(64)
        },
        createContext(workspaceRoot)
      ),
      /changed after it was read/
    );
  });
});

test('GitStatus and GitDiff expose bounded non-sensitive workspace changes', async () => {
  await withWorkspace(async (workspaceRoot) => {
    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'phase3@example.test'], {
      cwd: workspaceRoot
    });
    await execFileAsync('git', ['config', 'user.name', 'Phase 3 Test'], {
      cwd: workspaceRoot
    });
    await execFileAsync('git', ['config', 'core.autocrlf', 'false'], {
      cwd: workspaceRoot
    });
    await mkdir(dirname(join(workspaceRoot, 'src', 'file.ts')), { recursive: true });
    await writeFile(join(workspaceRoot, 'src', 'file.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(join(workspaceRoot, '.env'), 'SECRET=before\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: workspaceRoot });

    await writeFile(join(workspaceRoot, 'src', 'file.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(workspaceRoot, '.env'), 'SECRET=after\n', 'utf8');

    const status = await gitStatusTool.execute({}, createContext(workspaceRoot));
    assert.equal(status.isError, undefined);
    assert.match(status.content, /src\/file\.ts/);
    assert.doesNotMatch(status.content, /\.env/);

    const diff = await gitDiffTool.execute({}, createContext(workspaceRoot));
    assert.equal(diff.isError, undefined);
    assert.match(diff.content, /export const value = 2/);
    assert.doesNotMatch(diff.content, /SECRET=after/);
    assert.ok(Buffer.byteLength(diff.content, 'utf8') <= 40 * 1024);

    await execFileAsync('git', ['add', 'src/file.ts'], { cwd: workspaceRoot });
    const staged = await gitDiffTool.execute({ scope: 'staged' }, createContext(workspaceRoot));
    assert.equal(staged.isError, undefined);
    assert.match(staged.content, /export const value = 2/);
  });
});
