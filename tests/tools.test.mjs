import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { editTool, readTool, writeTool } from '../dist/tools/index.js';
import {
  convertToolSchemaToJsonSchema,
  validateToolInput
} from '../dist/tools/runtime.js';
import { resolveWorkspacePath } from '../dist/tools/workspace.js';

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
