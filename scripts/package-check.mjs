import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = join(projectRoot, 'package.json');

export const PACKAGE_LIMITS = Object.freeze({
  files: 260,
  packedBytes: 2 * 1024 * 1024,
  unpackedBytes: 8 * 1024 * 1024
});

const requiredRootFiles = new Set([
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'TESTING.md',
  'package.json'
]);

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('npm_execpath is unavailable; run this check through npm run pack:check');
  }
  return {
    command: process.execPath,
    args: [npmCli, ...args]
  };
}

async function npmPackManifest() {
  const invocation = npmInvocation(['pack', '--dry-run', '--json', '--ignore-scripts']);
  const { stdout } = await execFileAsync(invocation.command, invocation.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack returned ${Array.isArray(parsed) ? parsed.length : 0} manifests`);
  }
  return parsed[0];
}

function isAllowedPackagePath(path) {
  return requiredRootFiles.has(path) || path.startsWith('dist/') || path.startsWith('docs/');
}

function assertPackageMetadata(packageJson) {
  const failures = [];
  if (packageJson.license !== 'Apache-2.0') {
    failures.push('license must be Apache-2.0');
  }
  if (packageJson.engines?.node !== '>=22') {
    failures.push('engines.node must be >=22');
  }
  if (packageJson.publishConfig?.access !== 'public') {
    failures.push('publishConfig.access must be public');
  }
  if (packageJson.bin?.syzzz !== './dist/index.js') {
    failures.push('bin.syzzz must target ./dist/index.js');
  }
  if (packageJson.main !== undefined || packageJson.exports !== undefined) {
    failures.push('the CLI package must not advertise a stable module entry point');
  }
  for (const field of ['repository', 'homepage', 'bugs', 'keywords']) {
    if (!packageJson[field]) {
      failures.push(`package metadata is missing ${field}`);
    }
  }
  return failures;
}

export async function verifyPackageManifest() {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const manifest = await npmPackManifest();
  const paths = manifest.files.map((file) => file.path);
  const failures = assertPackageMetadata(packageJson);

  for (const required of requiredRootFiles) {
    if (!paths.includes(required)) {
      failures.push(`package is missing ${required}`);
    }
  }
  if (!paths.includes('dist/index.js')) {
    failures.push('package is missing dist/index.js');
  }
  for (const path of paths) {
    if (!isAllowedPackagePath(path)) {
      failures.push(`package contains disallowed path: ${path}`);
    }
    if (
      /(^|\/)(?:archive|src|tests?|eval|coverage|artifacts)(?:\/|$)/u.test(path) ||
      /(?:\.env|\.jsonl|phase\d|hook-should)/iu.test(path)
    ) {
      failures.push(`package contains forbidden release content: ${path}`);
    }
  }
  if (manifest.entryCount !== paths.length) {
    failures.push(`entryCount ${manifest.entryCount} does not match file list ${paths.length}`);
  }
  if (manifest.entryCount > PACKAGE_LIMITS.files) {
    failures.push(`package has ${manifest.entryCount} files; limit is ${PACKAGE_LIMITS.files}`);
  }
  if (manifest.size > PACKAGE_LIMITS.packedBytes) {
    failures.push(`packed size ${manifest.size} exceeds ${PACKAGE_LIMITS.packedBytes}`);
  }
  if (manifest.unpackedSize > PACKAGE_LIMITS.unpackedBytes) {
    failures.push(`unpacked size ${manifest.unpackedSize} exceeds ${PACKAGE_LIMITS.unpackedBytes}`);
  }
  if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) {
    failures.push('npm pack identity differs from package.json');
  }

  if (failures.length > 0) {
    throw new Error(`Package verification failed:\n- ${failures.join('\n- ')}`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    files: manifest.entryCount,
    packedBytes: manifest.size,
    unpackedBytes: manifest.unpackedSize,
    integrity: manifest.integrity
  };
}

const result = await verifyPackageManifest();
console.log(
  `Package OK: ${result.name}@${result.version}, ${result.files} files, ` +
    `${result.packedBytes} packed bytes, ${result.unpackedBytes} unpacked bytes`
);
