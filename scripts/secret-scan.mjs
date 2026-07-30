import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const secretPatterns = [
  /\b(?:sk-(?:proj-)?|sk-ant-)[A-Za-z0-9_-]{20,}\b/gu,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)\s*[:=]\s*["'][^"'${}\s]{20,}["']/giu,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/giu
];
const reviewedFixtureLiterals = [
  'sk-ant-api03-YOUR-KEY-HERE',
  'sk-ant-api03-YOUR-REAL-KEY',
  'https://user:secret@example.com',
  'package-smoke-placeholder',
  'fixture-placeholder-key'
];

async function git(args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true
  });
  return stdout;
}

function containsSecret(text) {
  const reviewed = reviewedFixtureLiterals.reduce(
    (value, literal) => value.replaceAll(literal, '[reviewed-fixture]'),
    text
  );
  return secretPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(reviewed);
  });
}

const findings = [];
const worktreeFiles = (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
  .split('\0')
  .filter(Boolean);
for (const path of worktreeFiles) {
  let content;
  try {
    content = await readFile(join(projectRoot, path), 'utf8');
  } catch {
    continue;
  }
  if (containsSecret(content)) {
    findings.push(`worktree file ${path}`);
  }
}

const history = await git([
  'log',
  '--all',
  '--full-history',
  '--no-ext-diff',
  '--pretty=format:__SYZZZ_COMMIT__%H',
  '-p'
]);
let commit = 'unknown';
let path = 'unknown';
for (const line of history.split(/\r?\n/u)) {
  if (line.startsWith('__SYZZZ_COMMIT__')) {
    commit = line.slice('__SYZZZ_COMMIT__'.length);
  } else if (line.startsWith('+++ b/')) {
    path = line.slice('+++ b/'.length);
  } else if ((line.startsWith('+') || line.startsWith('-')) && containsSecret(line.slice(1))) {
    findings.push(`history ${commit.slice(0, 12)} ${path}`);
  }
}

const commitMessages = await git(['log', '--all', '--format=%H%x00%B%x00']);
const commitMessageParts = commitMessages.split('\0');
for (let index = 0; index + 1 < commitMessageParts.length; index += 2) {
  const commitHash = commitMessageParts[index]?.trim();
  const message = commitMessageParts[index + 1] ?? '';
  if (commitHash && containsSecret(message)) {
    findings.push(`commit message ${commitHash.slice(0, 12)}`);
  }
}

const uniqueFindings = [...new Set(findings)];
if (uniqueFindings.length > 0) {
  throw new Error(
    'Potential credentials detected. Rotate real credentials before deciding whether history ' +
      `must be rewritten:\n- ${uniqueFindings.join('\n- ')}`
  );
}

console.log(
  `Secret scan OK: ${worktreeFiles.length} worktree files, reachable patches, and commit messages checked`
);
