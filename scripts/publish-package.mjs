import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const release = JSON.parse(await readFile(join(projectRoot, 'artifacts', 'release.json'), 'utf8'));

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('npm_execpath is unavailable; run publishing through npm');
  }
  return {
    command: process.execPath,
    args: [npmCli, ...args]
  };
}

async function npm(args, allowMissing = false) {
  const invocation = npmInvocation(args);
  try {
    return await execFileAsync(invocation.command, invocation.args, {
      cwd: projectRoot,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000,
      windowsHide: true
    });
  } catch (error) {
    const output = `${error instanceof Error ? error.message : String(error)} ${
      typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : ''
    }`;
    if (allowMissing && /\bE404\b|is not in this registry|No match found/iu.test(output)) {
      return undefined;
    }
    throw error;
  }
}

async function registryIntegrity() {
  const result = await npm(
    ['view', `${release.name}@${release.version}`, 'dist.integrity', '--json'],
    true
  );
  if (!result) {
    return undefined;
  }
  const parsed = JSON.parse(result.stdout);
  return typeof parsed === 'string' ? parsed : undefined;
}

let remoteIntegrity = await registryIntegrity();
if (remoteIntegrity === undefined) {
  await npm([
    'publish',
    join(projectRoot, 'artifacts', release.tarball),
    '--access',
    'public',
    '--provenance',
    '--ignore-scripts'
  ]);
  for (let attempt = 0; attempt < 6 && remoteIntegrity === undefined; attempt += 1) {
    await delay(2_000);
    remoteIntegrity = await registryIntegrity();
  }
  if (remoteIntegrity === undefined) {
    throw new Error('npm accepted the publish, but registry integrity is not yet observable');
  }
  console.log(`Published ${release.name}@${release.version} with npm provenance`);
} else {
  console.log(`Registry already contains ${release.name}@${release.version}; verifying recovery`);
}

if (remoteIntegrity !== release.integrity) {
  throw new Error(
    `Registry integrity mismatch for ${release.name}@${release.version}; refusing recovery`
  );
}
console.log(`Registry integrity verified: ${remoteIntegrity}`);
