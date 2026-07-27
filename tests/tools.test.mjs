import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { editTool, listDirectoryTool, readTool, writeTool } from '../dist/tools/index.js';
import {
  convertToolSchemaToJsonSchema,
  validateToolInput
} from '../dist/tools/runtime.js';
import {
  resolveWorkspacePath,
  validateWorkspacePathSyntax
} from '../dist/tools/workspace.js';

async function withWorkspace(run) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'syzzz-tools-'));
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function createContext(workspaceRoot, approvalData) {
  return {
    toolCallId: 'test-call',
    workspaceRoot,
    workingDirectory: workspaceRoot,
    signal: new AbortController().signal,
    ...(approvalData === undefined ? {} : { approvalData })
  };
}

test('validates tool input and derives provider JSON schema from Zod', () => {
  const tool = {
    name: 'Example',
    description: 'Example tool',
    inputSchema: z.object({
      path: z.string(),
      count: z.number().int().optional()
    }).strict(),
    risk: 'read',
    approval: 'never',
    async execute() {
      return { content: 'ok' };
    }
  };

  assert.deepEqual(validateToolInput(tool, { path: 'src/index.ts' }), {
    success: true,
    data: { path: 'src/index.ts' }
  });
  const invalidResult = validateToolInput(tool, { path: 1, extra: true });
  assert.equal(invalidResult.success, false);
  assert.match(invalidResult.message, /Invalid tool input/);

  const schema = convertToolSchemaToJsonSchema(tool);
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['path']);
  assert.equal(schema.properties.path.type, 'string');
  assert.equal(schema.properties.count.type, 'integer');
});

test('keeps file access inside the workspace and blocks sensitive paths', async () => {
  await withWorkspace(async workspaceRoot => {
    await writeFile(join(workspaceRoot, 'safe.txt'), 'safe', 'utf8');
    await writeFile(join(workspaceRoot, '.env'), 'SECRET=value', 'utf8');

    assert.equal(
      await resolveWorkspacePath('safe.txt', workspaceRoot, 'read'),
      join(workspaceRoot, 'safe.txt')
    );
    await assert.rejects(
      resolveWorkspacePath('../outside.txt', workspaceRoot, 'write'),
      error => error?.code === 'OUTSIDE_WORKSPACE'
    );
    await assert.rejects(
      resolveWorkspacePath('.env', workspaceRoot, 'read'),
      error => error?.code === 'SENSITIVE_PATH'
    );
    assert.equal(
      await resolveWorkspacePath('.env.example', workspaceRoot, 'write'),
      join(workspaceRoot, '.env.example')
    );
  });
});

test('rejects unsafe Windows path syntax without blocking normal drive paths', () => {
  assert.doesNotThrow(() =>
    validateWorkspacePathSyntax('C:\\workspace\\src\\index.ts', 'win32')
  );
  assert.doesNotThrow(() =>
    validateWorkspacePathSyntax('NUL.txt', 'linux')
  );

  for (const unsafePath of [
    'file.txt:secret',
    '\\\\?\\C:\\workspace\\file.txt',
    '\\\\.\\NUL',
    'NUL.txt',
    'folder\\COM1.log',
    'folder.',
    'folder '
  ]) {
    assert.throws(
      () => validateWorkspacePathSyntax(unsafePath, 'win32'),
      error => error?.code === 'INVALID_PATH',
      unsafePath
    );
  }
});

test('blocks symbolic-link or junction escapes and sensitive aliases', async t => {
  await withWorkspace(async workspaceRoot => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'syzzz-outside-'));
    try {
      await writeFile(join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
      await mkdir(join(workspaceRoot, '.git'));
      await writeFile(join(workspaceRoot, '.git', 'config'), 'private', 'utf8');

      const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
      try {
        await symlink(outsideRoot, join(workspaceRoot, 'outside-link'), directoryLinkType);
        await symlink(join(workspaceRoot, '.git'), join(workspaceRoot, 'git-alias'), directoryLinkType);
      } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'EACCES') {
          t.skip(`Symbolic links are unavailable: ${error.message}`);
          return;
        }
        throw error;
      }

      await assert.rejects(
        resolveWorkspacePath('outside-link/secret.txt', workspaceRoot, 'read'),
        error => error?.code === 'OUTSIDE_WORKSPACE'
      );
      await assert.rejects(
        resolveWorkspacePath('git-alias/config', workspaceRoot, 'read'),
        error => error?.code === 'SENSITIVE_PATH'
      );
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('read tool returns errors instead of accessing paths outside the workspace', async () => {
  await withWorkspace(async workspaceRoot => {
    const result = await readTool.execute(
      { path: '../outside.txt' },
      createContext(workspaceRoot)
    );

    assert.equal(result.isError, true);
    assert.match(result.content, /outside the workspace/);
    assert.equal(result.metadata.errorCode, 'OUTSIDE_WORKSPACE');
  });
});

test('read tool bounds allocation and only accepts regular files', async () => {
  await withWorkspace(async workspaceRoot => {
    const limitBytes = 1024 * 1024;
    await writeFile(join(workspaceRoot, 'limit.txt'), Buffer.alloc(limitBytes, 0x61));
    await writeFile(join(workspaceRoot, 'too-large.txt'), Buffer.alloc(limitBytes + 1, 0x62));
    await writeFile(join(workspaceRoot, 'invalid-utf8.txt'), Buffer.from([0xc3, 0x28]));
    await mkdir(join(workspaceRoot, 'directory'));

    const atLimit = await readTool.execute(
      { path: 'limit.txt' },
      createContext(workspaceRoot)
    );
    assert.equal(atLimit.isError, undefined);
    assert.ok(Buffer.byteLength(atLimit.content) <= 40 * 1024);
    assert.match(atLimit.content, /Version: sha256:[a-f0-9]{64}/);
    assert.equal(atLimit.metadata.longLinesTruncated, 1);
    assert.equal(atLimit.metadata.sizeBytes, limitBytes);

    const tooLarge = await readTool.execute(
      { path: 'too-large.txt' },
      createContext(workspaceRoot)
    );
    assert.equal(tooLarge.isError, true);
    assert.match(tooLarge.content, /limit is 1048576 bytes/);
    assert.equal(tooLarge.metadata.errorCode, 'FILE_TOO_LARGE');

    const directory = await readTool.execute(
      { path: 'directory' },
      createContext(workspaceRoot)
    );
    assert.equal(directory.isError, true);
    assert.match(directory.content, /regular files/);
    assert.equal(directory.metadata.errorCode, 'NOT_REGULAR_FILE');

    const invalidUtf8 = await readTool.execute(
      { path: 'invalid-utf8.txt' },
      createContext(workspaceRoot)
    );
    assert.equal(invalidUtf8.isError, true);
    assert.match(invalidUtf8.content, /not valid UTF-8/);
    assert.equal(invalidUtf8.metadata.errorCode, 'INVALID_UTF8');
  });
});

test('list directory tool lists workspace entries and blocks escapes', async () => {
  await withWorkspace(async workspaceRoot => {
    await mkdir(join(workspaceRoot, 'src'));
    await writeFile(join(workspaceRoot, 'README.md'), 'hi', 'utf8');
    await writeFile(join(workspaceRoot, '.env'), 'SECRET=1', 'utf8');

    const listed = await listDirectoryTool.execute(
      {},
      createContext(workspaceRoot)
    );
    assert.equal(listed.isError, undefined);
    assert.match(listed.content, /README\.md/);
    assert.match(listed.content, /src/);
    assert.match(listed.content, /dir\s+src/);
    assert.match(listed.content, /file\s+README\.md/);

    const outside = await listDirectoryTool.execute(
      { path: '../outside' },
      createContext(workspaceRoot)
    );
    assert.equal(outside.isError, true);
    assert.match(outside.content, /outside the workspace/);

    const sensitive = await listDirectoryTool.execute(
      { path: '.env' },
      createContext(workspaceRoot)
    );
    assert.equal(sensitive.isError, true);
    assert.match(sensitive.content, /sensitive path/i);
  });
});

test('write tool previews changes and rejects files changed after approval', async () => {
  await withWorkspace(async workspaceRoot => {
    const targetPath = join(workspaceRoot, 'notes.txt');
    await writeFile(targetPath, 'before\n', 'utf8');
    const baseContext = createContext(workspaceRoot);
    const approval = await writeTool.prepareApproval(
      { path: 'notes.txt', contents: 'after\n' },
      baseContext
    );

    assert.match(approval.preview, /-before/);
    assert.match(approval.preview, /\+after/);
    await writeFile(targetPath, 'changed externally\n', 'utf8');

    const rejected = await writeTool.execute(
      { path: 'notes.txt', contents: 'after\n' },
      createContext(workspaceRoot, approval.executionData)
    );
    assert.equal(rejected.isError, true);
    assert.match(rejected.content, /changed after approval/);
    assert.equal(await readFile(targetPath, 'utf8'), 'changed externally\n');
    assert.equal(
      (await readdir(workspaceRoot)).some(name => name.includes('.syzzz-')),
      false
    );
  });
});

test('write tool atomically replaces content, preserves mode, and cleans temporary files', async () => {
  await withWorkspace(async workspaceRoot => {
    const targetPath = join(workspaceRoot, 'atomic.txt');
    await writeFile(targetPath, 'before\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(targetPath, 0o640);
    }

    const input = { path: 'atomic.txt', contents: 'after\n' };
    const approval = await writeTool.prepareApproval(
      input,
      createContext(workspaceRoot)
    );
    const result = await writeTool.execute(
      input,
      createContext(workspaceRoot, approval.executionData)
    );

    assert.equal(result.isError, undefined);
    assert.equal(await readFile(targetPath, 'utf8'), 'after\n');
    if (process.platform !== 'win32') {
      assert.equal((await stat(targetPath)).mode & 0o777, 0o640);
    }
    assert.equal(
      (await readdir(workspaceRoot)).some(name => name.includes('.syzzz-')),
      false
    );
  });
});

test('write and edit tools apply exactly the approved content', async () => {
  await withWorkspace(async workspaceRoot => {
    const writeInput = { path: 'nested/file.txt', contents: 'alpha beta\n' };
    await mkdir(dirname(join(workspaceRoot, writeInput.path)), { recursive: true });
    const writeApproval = await writeTool.prepareApproval(
      writeInput,
      createContext(workspaceRoot)
    );
    const writeResult = await writeTool.execute(
      writeInput,
      createContext(workspaceRoot, writeApproval.executionData)
    );
    assert.equal(writeResult.isError, undefined);
    assert.equal(await readFile(join(workspaceRoot, writeInput.path), 'utf8'), 'alpha beta\n');

    const editInput = {
      path: writeInput.path,
      old_string: 'beta',
      new_string: 'gamma'
    };
    const editApproval = await editTool.prepareApproval(
      editInput,
      createContext(workspaceRoot)
    );
    assert.match(editApproval.preview, /alpha gamma/);
    const editResult = await editTool.execute(
      editInput,
      createContext(workspaceRoot, editApproval.executionData)
    );
    assert.equal(editResult.isError, undefined);
    assert.equal(await readFile(join(workspaceRoot, writeInput.path), 'utf8'), 'alpha gamma\n');
  });
});

test('edit tool requires old_string to occur exactly once', async () => {
  await withWorkspace(async workspaceRoot => {
    await writeFile(join(workspaceRoot, 'duplicate.txt'), 'same same', 'utf8');

    await assert.rejects(
      editTool.prepareApproval(
        { path: 'duplicate.txt', old_string: 'same', new_string: 'new' },
        createContext(workspaceRoot)
      ),
      /found 2 matches/
    );
  });
});
