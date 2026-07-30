import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withTempDirectory } from './support/temp-environment.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(projectRoot, 'eval', 'fixtures', 'typescript-project');
const grader = join(projectRoot, 'scripts', 'eval-grader.mjs');
const typeScriptPackageRoot = join(projectRoot, 'node_modules', 'typescript');
const typeScriptRuntime = join(typeScriptPackageRoot, 'lib', 'typescript.js');

async function runGrader(taskId, workspace) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${grader}`,
      `--allow-fs-read=${workspace}`,
      `--allow-fs-read=${typeScriptPackageRoot}`,
      grader,
      taskId,
      workspace,
      typeScriptRuntime
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true
    }
  );
  return JSON.parse(stdout);
}

test('external Eval grader cannot be bypassed by replacing workspace tests', async () => {
  await withTempDirectory('syzzz-eval-grader-', async (root) => {
    const workspace = join(root, 'workspace');
    await cp(fixtureRoot, workspace, { recursive: true });
    await writeFile(
      join(workspace, 'test', 'checkout.test.mjs'),
      "import test from 'node:test';\ntest('always passes', () => {});\n",
      'utf8'
    );

    const result = await runGrader('cross-file-bug', workspace);
    assert.equal(
      result.checks.some((entry) => entry.passed === false),
      true
    );
    assert.deepEqual(
      result.checks.map((entry) => entry.name),
      ['external-tax-behavior', 'external-checkout-behavior']
    );
  });
});

test('type-error grader accepts equivalent string implementations and rejects non-string contracts', async () => {
  await withTempDirectory('syzzz-eval-label-grader-', async (root) => {
    const workspace = join(root, 'workspace');
    await cp(fixtureRoot, workspace, { recursive: true });
    const labelPath = join(workspace, 'src', 'label.ts');
    const cases = [
      {
        name: 'explicit string',
        source: "export const label: string = '42';\n",
        expected: true
      },
      {
        name: 'inferred string',
        source: 'export const label = "42";\n',
        expected: true
      },
      {
        name: 'String conversion',
        source: 'export const label = String(42);\n',
        expected: true
      },
      {
        name: 'numeric value',
        source: 'export const label = 42;\n',
        expected: false
      },
      {
        name: 'any annotation',
        source: "export const label: any = '42';\n",
        expected: false
      }
    ];

    for (const entry of cases) {
      await writeFile(labelPath, entry.source, 'utf8');
      const result = await runGrader('type-error', workspace);
      assert.deepEqual(
        result.checks,
        [
          {
            name: 'external-label-contract',
            passed: entry.expected,
            ...(entry.expected ? {} : { code: 'LABEL_CONTRACT' })
          }
        ],
        entry.name
      );
    }
  });
});
