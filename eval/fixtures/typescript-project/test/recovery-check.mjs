import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { add } from '../src/calculator.mjs';

const marker = '.eval-recovery-ran';
if (!existsSync(marker)) {
  writeFileSync(marker, 'first run observed\n', 'utf8');
  console.error('Injected first-run failure. Inspect the result, then rerun the same command.');
  process.exitCode = 1;
} else {
  assert.equal(add(2, 3), 5);
  console.log('recovery check passed');
}
