import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));

async function git(args, allowFailure = false) {
  try {
    return await execFileAsync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true
    });
  } catch (error) {
    if (allowFailure) {
      return undefined;
    }
    throw error;
  }
}

const failures = [];
const status = await git(['status', '--porcelain=v1', '--untracked-files=all']);
if (status.stdout.trim()) {
  failures.push('Git worktree is not clean');
}

const tag = `v${packageJson.version}`;
const existingTag = await git(['tag', '--list', tag]);
if (existingTag.stdout.trim()) {
  const [{ stdout: tagCommit }, { stdout: headCommit }] = await Promise.all([
    git(['rev-list', '-n', '1', tag]),
    git(['rev-parse', 'HEAD'])
  ]);
  if (tagCommit.trim() !== headCommit.trim()) {
    failures.push(`release tag ${tag} exists on a different commit`);
  }
}

const originMain = await git(['rev-parse', '--verify', 'origin/main'], true);
if (originMain) {
  const ancestry = await git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], true);
  if (!ancestry) {
    failures.push('origin/main is not an ancestor of the release commit');
  }
}

const changelog = await readFile(join(projectRoot, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${packageJson.version}]`)) {
  failures.push(`CHANGELOG.md has no ${packageJson.version} release entry`);
}

const license = await readFile(join(projectRoot, 'LICENSE'), 'utf8');
if (!license.includes('Apache License') || !license.includes('Version 2.0')) {
  failures.push('LICENSE is not an Apache-2.0 license text');
}

const sourceVersionSearch = await git(['grep', '-n', packageJson.version, '--', 'src'], true);
if (sourceVersionSearch?.stdout.trim()) {
  failures.push('the package version is hard-coded under src instead of package.json');
}

if (failures.length > 0) {
  throw new Error(`Release verification failed:\n- ${failures.join('\n- ')}`);
}

console.log(
  `Release source OK: ${packageJson.name}@${packageJson.version}, clean tree, ` +
    'main ancestry verified, version sourced from package.json'
);
