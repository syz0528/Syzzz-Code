import { createRequire } from 'node:module';

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
}

const require = createRequire(import.meta.url);
const metadata = require('../package.json') as PackageMetadata;

if (metadata.name !== 'syzzz-code' || typeof metadata.version !== 'string') {
  throw new Error('Invalid Syzzz Code package metadata');
}

export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;
