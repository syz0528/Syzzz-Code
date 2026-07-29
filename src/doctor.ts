import { createRequire } from 'node:module';
import {
  access,
  constants,
  mkdir,
  stat
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  getConfigDirectory,
  getConfigPath,
  inspectConfig,
  resolveProviderCredential
} from './config.js';
import { SessionStore } from './session-store.js';
import {
  getExtensionConfigPaths,
  inspectProjectExtensions,
  loadExtensionConfiguration
} from './extensions/config.js';
import { inspectWorkspaceTrust } from './extensions/trust.js';

export type DoctorCheckStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  hasErrors: boolean;
}

function check(
  checks: DoctorCheck[],
  name: string,
  status: DoctorCheckStatus,
  message: string
): void {
  checks.push({ name, status, message });
}

async function checkPrivateDirectory(
  checks: DoctorCheck[],
  name: string,
  path: string
): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await access(path, constants.R_OK | constants.W_OK);
    const directoryStats = await stat(path);
    if (!directoryStats.isDirectory()) {
      throw new Error(`${path} is not a directory`);
    }
    if (process.platform === 'win32') {
      check(
        checks,
        name,
        'warning',
        `${path} is writable; Windows ACL privacy was not automatically verified`
      );
      return;
    }
    const mode = directoryStats.mode & 0o777;
    check(
      checks,
      name,
      mode & 0o077 ? 'warning' : 'ok',
      `${path}; mode ${mode.toString(8).padStart(3, '0')}, expected 700`
    );
  } catch (error) {
    check(
      checks,
      name,
      'error',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function runDoctor(
  workspaceRoot: string = process.cwd()
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  check(
    checks,
    'Node.js',
    nodeMajor >= 20 ? 'ok' : 'error',
    `Node ${process.versions.node}; version 20 or newer is required`
  );

  const inspection = inspectConfig();
  if (inspection.status === 'missing') {
    check(
      checks,
      'Configuration',
      'warning',
      `No configuration exists at ${inspection.path}; it will be created on startup`
    );
  } else if (inspection.status === 'invalid') {
    check(
      checks,
      'Configuration',
      'error',
      `${inspection.reason}; run "syzzz doctor --repair-config" to back up and reset it`
    );
  } else if (inspection.status === 'unsupported') {
    check(
      checks,
      'Configuration',
      'error',
      `${inspection.reason}; upgrade Syzzz Code because repair is disabled for future schemas`
    );
  } else {
    check(
      checks,
      'Configuration',
      inspection.legacy ? 'warning' : 'ok',
      inspection.legacy
        ? 'Legacy configuration is valid and will migrate to schema v1'
        : 'Schema v1 is valid'
    );
    const current = inspection.config.providers[
      inspection.config.currentProvider
    ];
    const credential = resolveProviderCredential(current);
    check(
      checks,
      'Provider',
      credential.source === 'missing' ? 'error' : 'ok',
      credential.source === 'environment'
        ? `Current Provider credentials resolve from ${credential.environmentVariable}`
        : credential.source === 'stored'
          ? 'Current Provider credentials resolve from the private config file'
          : `Current Provider has no usable credentials` +
            (credential.environmentVariable
              ? `; ${credential.environmentVariable} is unset`
              : '')
    );
    check(
      checks,
      'Model',
      'ok',
      `Configured model: ${current.model}`
    );
    const endpoint = new URL(current.env.BASE_URL);
    check(
      checks,
      'Endpoint',
      'ok',
      endpoint.origin
    );
  }

  const extensionPaths = getExtensionConfigPaths(workspaceRoot);
  const extensionConfiguration = loadExtensionConfiguration(workspaceRoot);
  const projectInspection = inspectProjectExtensions(workspaceRoot);
  const trustInspection = inspectWorkspaceTrust(workspaceRoot);
  const extensionWarnings = [
    ...extensionConfiguration.warnings,
    ...projectInspection.warnings
  ];
  check(
    checks,
    'MCP configuration',
    extensionWarnings.length > 0 ? 'warning' : 'ok',
    extensionWarnings.length > 0
      ? `${extensionWarnings.length} extension configuration warning(s); ` +
        'run "syzzz mcp list" and "syzzz hooks list" for details'
      : `${extensionConfiguration.mcpServers.length} active server(s); offline validation only`
  );
  const projectConfigurationPresent =
    existsSync(extensionPaths.projectMcp) ||
    existsSync(extensionPaths.projectHooks);
  check(
    checks,
    'Workspace trust',
    projectConfigurationPresent && !trustInspection.trusted ? 'warning' : 'ok',
    projectConfigurationPresent
      ? trustInspection.trusted
        ? 'Project extensions are active for this canonical workspace path'
        : 'Project extension files are present but inactive'
      : 'No project extension files are present'
  );

  await checkPrivateDirectory(
    checks,
    'Config directory',
    getConfigDirectory()
  );

  if (inspection.status !== 'missing') {
    try {
      const fileStats = await stat(getConfigPath());
      if (!fileStats.isFile()) {
        throw new Error('configuration path is not a regular file');
      }
      if (process.platform === 'win32') {
        check(
          checks,
          'Config permissions',
          'warning',
          'Windows ACL privacy was not automatically verified'
        );
      } else {
        const mode = fileStats.mode & 0o777;
        check(
          checks,
          'Config permissions',
          mode & 0o077 ? 'warning' : 'ok',
          `mode ${mode.toString(8).padStart(3, '0')}; expected 600`
        );
      }
    } catch (error) {
      check(
        checks,
        'Config permissions',
        'error',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  try {
    const require = createRequire(import.meta.url);
    const ripgrep = require('@vscode/ripgrep') as { rgPath?: unknown };
    if (typeof ripgrep.rgPath !== 'string') {
      throw new Error('bundled ripgrep path is unavailable');
    }
    const rgStats = await stat(ripgrep.rgPath);
    if (!rgStats.isFile()) {
      throw new Error('bundled ripgrep is not a regular file');
    }
    check(checks, 'ripgrep', 'ok', 'Bundled executable is available');
  } catch (error) {
    check(
      checks,
      'ripgrep',
      'error',
      error instanceof Error ? error.message : String(error)
    );
  }

  try {
    const workerPath = fileURLToPath(
      new URL('./tools/analysis-worker.js', import.meta.url)
    );
    const workerStats = await stat(workerPath);
    if (!workerStats.isFile()) {
      throw new Error('analysis Worker is not a regular file');
    }
    check(checks, 'TypeScript Worker', 'ok', 'Analysis runtime is available');
  } catch (error) {
    check(
      checks,
      'TypeScript Worker',
      'error',
      error instanceof Error ? error.message : String(error)
    );
  }

  try {
    const store = await SessionStore.create({ workspaceRoot });
    await checkPrivateDirectory(
      checks,
      'Sessions',
      store.workspaceDirectory
    );
  } catch (error) {
    check(
      checks,
      'Sessions',
      'error',
      error instanceof Error ? error.message : String(error)
    );
  }

  await checkPrivateDirectory(
    checks,
    'Audit',
    join(getConfigDirectory(), 'audit')
  );

  return {
    checks,
    hasErrors: checks.some(item => item.status === 'error')
  };
}
