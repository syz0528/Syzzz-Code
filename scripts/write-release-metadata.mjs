import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentEvalSummary, selectLatestAgentEvalReport } from './release-eval-summary.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(projectRoot, 'artifacts');
const manifests = JSON.parse(await readFile(join(artifacts, 'pack.json'), 'utf8'));
if (!Array.isArray(manifests) || manifests.length !== 1) {
  throw new Error('Expected exactly one npm pack manifest');
}

const manifest = manifests[0];
const tarball = basename(manifest.filename);
const tarballBytes = await readFile(join(artifacts, tarball));
const sha256 = createHash('sha256').update(tarballBytes).digest('hex');
const release = {
  name: manifest.name,
  version: manifest.version,
  tarball,
  sha256,
  integrity: manifest.integrity,
  packedBytes: manifest.size,
  unpackedBytes: manifest.unpackedSize,
  files: manifest.entryCount
};
await writeFile(join(artifacts, 'release.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');
await writeFile(join(artifacts, 'SHA256SUMS'), `${sha256}  ${tarball}\n`, 'utf8');

const evalDirectory = join(projectRoot, 'eval-results');
const evalFiles = (await readdir(evalDirectory))
  .filter((name) => name.endsWith('-offline.json'))
  .sort();
if (evalFiles.length === 0) {
  throw new Error('No offline Eval report is available for the release');
}
const reports = await Promise.all(
  evalFiles.map(async (name) => ({
    name,
    report: JSON.parse(await readFile(join(evalDirectory, name), 'utf8'))
  }))
);
const evalSummary = createAgentEvalSummary(selectLatestAgentEvalReport(reports));
await writeFile(
  join(artifacts, 'eval-summary.json'),
  `${JSON.stringify(evalSummary, null, 2)}\n`,
  'utf8'
);

console.log(`Release metadata written for ${release.name}@${release.version}`);
