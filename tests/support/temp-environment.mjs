import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET_NAME_PATTERN = /(?:API|AUTH|ACCESS|SECRET|TOKEN|KEY|PASSWORD)/i;

export function createIsolatedEnvironment(home, additions = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_NAME_PATTERN.test(name)) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    NO_COLOR: '1',
    ...additions
  };
}

export async function withTempDirectory(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
