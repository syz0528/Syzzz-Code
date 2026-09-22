import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'));
const allowedLicenses = new Set([
  '0BSD',
  '(MIT OR CC0-1.0)',
  'Apache-2.0',
  'Apache-2.0 AND LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'LGPL-3.0-or-later',
  'MIT'
]);
// Exact packages with separately reviewed license files, including metadata exceptions.
// Keep the exception tied to the exact package version so an update requires a fresh review.
const reviewedMetadataExceptions = new Map([
  ['base-64@0.1.0', 'MIT (LICENSE-MIT.txt)'],
  ['flatbuffers@1.12.0', 'Apache-2.0 (LICENSE.txt)'],
  ['flatbuffers@24.12.23', 'Apache-2.0 (LICENSE)'],
  ['fast-sha256@1.3.0', 'Unlicense (LICENSE; Anthropic SDK via standardwebhooks)'],
  ['json-bignum@0.0.3', 'MIT (LICENSE)']
]);
const packages = [];
const failures = [];

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path || metadata.dev === true) {
    continue;
  }
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const license = metadata.license;
  packages.push({ name, license });
  const reviewedException = reviewedMetadataExceptions.has(`${name}@${metadata.version}`);
  if (!reviewedException && (typeof license !== 'string' || !allowedLicenses.has(license))) {
    failures.push(`${name}: ${typeof license === 'string' ? license : 'missing license'}`);
  }
}

if (packages.length === 0) {
  failures.push('package-lock.json contains no production dependencies');
}
if (failures.length > 0) {
  throw new Error(
    'Production dependency license review failed:\n- ' +
      failures.join('\n- ') +
      '\nUpdate the explicit allowlist only after reviewing the dependency license.'
  );
}

console.log(
  `License check OK: ${packages.length} production package entries use reviewed licenses`
);
