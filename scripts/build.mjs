import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');

await rm(join(projectRoot, 'dist'), { recursive: true, force: true });

const child = spawn(process.execPath, [compiler, '--project', join(projectRoot, 'tsconfig.json')], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: true
});

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) {
      reject(new Error(`TypeScript compiler terminated by ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
}
