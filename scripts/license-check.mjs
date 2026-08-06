import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'));
const allowedLicenses = new Set([
  '(MIT OR CC0-1.0)',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT'
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
  if (typeof license !== 'string' || !allowedLicenses.has(license)) {
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
  `License check OK: ${packages.length} production package entries use reviewed permissive licenses`
);
