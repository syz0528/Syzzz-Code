import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosticsTool, repoMapTool } from '../dist/tools/index.js';
import { runAnalysisWorker } from '../dist/tools/analysis-worker-client.js';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'syzzz-analysis-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.ssh'), { recursive: true });
  writeFileSync(
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
  writeFileSync(
    join(root, 'src', 'types.ts'),
    ['export interface User {', '  name: string;', '}', ''].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(root, 'src', 'service.ts'),
    [
      "import type { User } from './types.js';",
      '',
      'export function formatUser(user: User): string {',
      '  return user.name;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(root, 'src', 'index.ts'),
    [
      "export { formatUser } from './service.js';",
      "const broken: number = 'wrong';",
      'export { broken };',
      ''
    ].join('\n'),
    'utf8'
  );
  writeFileSync(join(root, '.gitignore'), 'src/ignored.ts\n', 'utf8');
  writeFileSync(
    join(root, 'src', 'ignored.ts'),
    "const ignored: number = 'PRIVATE_IGNORED_CONTENT';\n",
    'utf8'
  );
  writeFileSync(
    join(root, '.ssh', 'secret.ts'),
    "const secret: number = 'PRIVATE_SSH_CONTENT';\n",
    'utf8'
  );
  writeFileSync(join(root, '.env'), 'SECRET=do-not-read\n', 'utf8');
  return root;
}

function context(root, signal = new AbortController().signal) {
  return {
    toolCallId: 'analysis-test',
    workspaceRoot: root,
    workingDirectory: root,
    signal
  };
}

test('RepoMap extracts ranked TS/JS symbols and relative import edges', async () => {
  const root = createFixture();
  try {
    const first = await repoMapTool.execute(
      {
        path: '.',
        query: 'formatUser',
        maxFiles: 10
      },
      context(root)
    );

    assert.equal(first.isError, undefined, first.content);
    assert.match(first.content, /src\/service\.ts/);
    assert.match(first.content, /function formatUser\(user: User\): string/);
    assert.match(first.content, /imports: src\/types\.ts/);
    assert.match(first.content, /imported by: src\/index\.ts/);
    assert.equal(first.content.includes('.env'), false);
    assert.ok(Buffer.byteLength(first.content, 'utf8') <= 40 * 1024);

    const focused = await repoMapTool.execute(
      {
        path: 'src/service.ts',
        maxFiles: 1
      },
      context(root)
    );
    assert.equal(focused.isError, undefined, focused.content);
    assert.match(focused.content, /src\/service\.ts/);
    assert.match(focused.content, /imports: src\/types\.ts/);

    const second = await repoMapTool.execute(
      {
        path: '.',
        query: 'formatUser',
        maxFiles: 10
      },
      context(root)
    );
    assert.equal(second.metadata.cacheHits, 3);

    writeFileSync(
      join(root, 'src', 'service.ts'),
      [
        "import type { User } from './types.js';",
        'export const formatUser = (user: User): string => user.name;',
        ''
      ].join('\n'),
      'utf8'
    );
    const changed = await repoMapTool.execute(
      {
        query: 'formatUser',
        maxFiles: 10
      },
      context(root)
    );
    assert.ok(changed.metadata.cacheHits < 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Diagnostics uses the Compiler API without running project scripts', async () => {
  const root = createFixture();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          build: "node -e \"require('fs').writeFileSync('SHOULD_NOT_EXIST','x')\""
        }
      }),
      'utf8'
    );
    const result = await diagnosticsTool.execute(
      {
        path: '.',
        limit: 20
      },
      context(root)
    );

    assert.equal(result.isError, undefined, result.content);
    assert.match(result.content, /src\/index\.ts:2:/);
    assert.match(result.content, /TS2322 error/);
    assert.equal(result.metadata.diagnosticCount, 1);
    assert.equal(result.metadata.configPath, 'tsconfig.json');
    assert.equal(result.content.includes('PRIVATE_IGNORED_CONTENT'), false);
    assert.equal(result.content.includes('PRIVATE_SSH_CONTENT'), false);
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= 40 * 1024);

    const targeted = await diagnosticsTool.execute(
      {
        path: 'src/index.ts',
        limit: 20
      },
      context(root)
    );
    assert.equal(targeted.metadata.configPath, 'tsconfig.json');
    assert.equal(targeted.metadata.diagnosticCount, 1, targeted.content);
    assert.match(targeted.content, /src\/index\.ts:2:/);

    const cleanTarget = await diagnosticsTool.execute(
      {
        path: 'src/service.ts',
        limit: 20
      },
      context(root)
    );
    assert.equal(cleanTarget.metadata.configPath, 'tsconfig.json');
    assert.equal(cleanTarget.metadata.diagnosticCount, 0, cleanTarget.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analysis tools honor an already-aborted request', async () => {
  const root = createFixture();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => repoMapTool.execute({}, context(root, controller.signal)),
      /abort|cancel/i
    );
    await assert.rejects(
      () => diagnosticsTool.execute({}, context(root, controller.signal)),
      /abort|cancel/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an active Worker analysis is terminated on cancellation and can restart', async () => {
  const root = createFixture();
  const controller = new AbortController();
  try {
    const pending = runAnalysisWorker(
      {
        operation: 'repo-map',
        workspaceRoot: root,
        files: Array.from({ length: 5_000 }, () => 'src/service.ts'),
        modifiedPaths: [],
        maxFiles: 10
      },
      controller.signal
    );
    controller.abort();
    await assert.rejects(pending, /abort|cancel/i);

    const restarted = await repoMapTool.execute(
      {
        query: 'formatUser',
        maxFiles: 5
      },
      context(root)
    );
    assert.equal(restarted.isError, undefined, restarted.content);
    assert.match(restarted.content, /src\/service\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analysis Worker does not inherit incompatible parent Node flags', () => {
  const root = createFixture();
  try {
    const script = [
      "import { repoMapTool } from './dist/tools/index.js';",
      'const root = process.env.SYZZZ_ANALYSIS_ROOT;',
      'const result = await repoMapTool.execute(',
      "  { path: 'src/service.ts', maxFiles: 1 },",
      '  {',
      "    toolCallId: 'exec-argv-test',",
      '    workspaceRoot: root,',
      '    workingDirectory: root,',
      '    signal: new AbortController().signal',
      '  }',
      ');',
      'if (result.isError) {',
      '  throw new Error(result.content);',
      '}'
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SYZZZ_ANALYSIS_ROOT: root
      },
      encoding: 'utf8',
      timeout: 20_000
    });

    assert.equal(
      child.status,
      0,
      child.stderr || child.stdout || `Child exited with ${child.status}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
