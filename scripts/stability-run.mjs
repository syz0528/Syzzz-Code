import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stabilityTests = [
  'tests/shell-runner.test.mjs',
  'tests/session-store.test.mjs',
  'tests/session-controller.test.mjs',
  'tests/mcp-manager.test.mjs',
  'tests/hooks.test.mjs'
];

async function runRound(round) {
  const child = spawn(process.execPath, ['--test', ...stabilityTests], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) {
        reject(new Error(`stability round ${round} terminated by ${signal}`));
        return;
      }
      resolve(exitCode ?? 1);
    });
  });
  if (code !== 0) {
    throw new Error(`stability round ${round} failed; no automatic retry was attempted`);
  }
  console.log(`Stability round ${round}/3 passed`);
}

for (let round = 1; round <= 3; round += 1) {
  await runRound(round);
}
