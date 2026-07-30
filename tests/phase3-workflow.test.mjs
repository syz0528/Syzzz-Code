import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  diagnosticsTool,
  gitDiffTool,
  globTool,
  grepTool,
  patchTool,
  readTool,
  repoMapTool
} from '../dist/tools/index.js';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function context(workspaceRoot, approvalData) {
  return {
    toolCallId: 'phase3-workflow',
    workspaceRoot,
    workingDirectory: workspaceRoot,
    signal: new AbortController().signal,
    ...(approvalData === undefined ? {} : { approvalData })
  };
}

async function createMediumRepository() {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-phase3-workflow-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true
      },
      include: ['src']
    }),
    'utf8'
  );
  await writeFile(
    join(root, 'src', 'calculator.ts'),
    ['export function calculate(value: number): number {', '  return value + 1;', '}', ''].join(
      '\r\n'
    ),
    'utf8'
  );
  for (let index = 1; index <= 10; index++) {
    const previous = index === 1 ? './calculator.js' : `./module-${index - 1}.js`;
    const importedName = index === 1 ? 'calculate' : `step${index - 1}`;
    await writeFile(
      join(root, 'src', `module-${index}.ts`),
      [
        `import { ${importedName} } from '${previous}';`,
        `export const step${index} = (value: number): number => ${importedName}(value);`,
        ''
      ].join('\n'),
      'utf8'
    );
  }
  await writeFile(
    join(root, 'src', 'index.ts'),
    [
      "export { calculate } from './calculator.js';",
      "export { step10 } from './module-10.js';",
      ''
    ].join('\n'),
    'utf8'
  );

  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Syzzz Tests',
      '-c',
      'user.email=tests@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    ],
    { cwd: root }
  );
  return root;
}

test('medium TS workflow closes search, read, patch, diff and diagnostics', async () => {
  const root = await createMediumRepository();
  try {
    const glob = await globTool.execute(
      {
        pattern: 'src/**/*.ts',
        limit: 100
      },
      context(root)
    );
    assert.equal(glob.metadata.matchCount, 12);

    const grep = await grepTool.execute(
      {
        pattern: 'calculate',
        literal: true,
        path: 'src',
        outputMode: 'files'
      },
      context(root)
    );
    assert.match(grep.content, /src\/calculator\.ts/);

    const map = await repoMapTool.execute(
      {
        query: 'calculate',
        maxFiles: 12
      },
      context(root)
    );
    assert.match(map.content, /function calculate\(value: number\): number/);
    assert.match(map.content, /imported by: .*src\/module-1\.ts/);

    const read = await readTool.execute(
      {
        path: 'src/calculator.ts',
        offset: 1,
        limit: 20
      },
      context(root)
    );
    assert.equal(read.metadata.lineEnding, 'CRLF');

    const patchInput = {
      path: 'src/calculator.ts',
      expectedHash: read.metadata.versionHash,
      operations: [
        {
          oldText: 'return value + 1;',
          newText: 'return value + 2;'
        }
      ]
    };
    const approval = await patchTool.prepareApproval(patchInput, context(root));
    const patched = await patchTool.execute(patchInput, context(root, approval.executionData));
    assert.equal(patched.isError, undefined, patched.content);
    assert.equal(
      await readFile(join(root, 'src', 'calculator.ts'), 'utf8'),
      ['export function calculate(value: number): number {', '  return value + 2;', '}', ''].join(
        '\r\n'
      )
    );

    const diff = await gitDiffTool.execute(
      {
        scope: 'unstaged',
        path: 'src/calculator.ts'
      },
      context(root)
    );
    assert.match(diff.content, /\+  return value \+ 2;/);

    const diagnostics = await diagnosticsTool.execute(
      {
        path: '.',
        limit: 20
      },
      context(root)
    );
    assert.equal(diagnostics.metadata.diagnosticCount, 0, diagnostics.content);

    await execFileAsync(
      process.execPath,
      [
        join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--project',
        join(root, 'tsconfig.json'),
        '--noEmit'
      ],
      { cwd: root }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
