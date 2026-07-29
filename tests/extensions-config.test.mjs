import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  expandEnvironmentTemplates,
  validateHookConfig,
  validateMcpServerConfig,
  validateMcpServerName
} from '../dist/extensions/config.js';

test('extension validators reject unsafe transports and malformed execution fields', () => {
  assert.throws(
    () => validateMcpServerConfig({
      type: 'http',
      url: 'http://example.com/mcp'
    }),
    /HTTPS/
  );
  assert.throws(
    () => validateMcpServerConfig({
      type: 'http',
      url: 'https://user:secret@example.com/mcp'
    }),
    /embedded credentials/
  );
  assert.throws(
    () => validateMcpServerConfig({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { 'Bad\nHeader': 'value' }
    }),
    /invalid HTTP header/
  );
  assert.throws(
    () => validateMcpServerConfig({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer plaintext-secret' }
    }),
    /must reference an environment variable/
  );
  assert.throws(
    () => validateMcpServerConfig({
      type: 'stdio',
      command: 'server',
      env: { 'BAD-NAME': 'value' }
    }),
    /invalid environment variable/
  );
  assert.throws(
    () => validateMcpServerName('ambiguous__server'),
    /must not contain "__"/
  );
  assert.equal(
    validateMcpServerConfig({
      type: 'http',
      url: 'http://127.0.0.1:3000/mcp'
    }).type,
    'http'
  );
  assert.equal(
    validateMcpServerConfig({
      type: 'http',
      url: 'http://[::1]:3000/mcp'
    }).type,
    'http'
  );

  assert.throws(
    () => validateHookConfig({
      name: '../unsafe',
      event: 'PreTurn',
      command: 'node'
    }, 'hook'),
    /Hook names/
  );
  assert.throws(
    () => validateHookConfig({
      name: 'deny-after',
      event: 'PostToolUse',
      command: 'node',
      onError: 'deny'
    }, 'hook'),
    /only for PreToolUse/
  );
  assert.throws(
    () => validateHookConfig({
      name: 'unused-matcher',
      event: 'PreTurn',
      command: 'node',
      matcher: 'builtin:*'
    }, 'hook'),
    /matcher is valid only/
  );
});

test('environment templates require explicit, valid environment variables', () => {
  assert.deepEqual(
    expandEnvironmentTemplates(
      { TOKEN: 'Bearer ${SAFE_TOKEN}' },
      { SAFE_TOKEN: 'fixture' }
    ),
    { TOKEN: 'Bearer fixture' }
  );
  assert.throws(
    () => expandEnvironmentTemplates(
      { TOKEN: '${MISSING_TOKEN}' },
      {}
    ),
    /MISSING_TOKEN is not set/
  );
  assert.throws(
    () => expandEnvironmentTemplates(
      { TOKEN: '${PROVIDER_API_KEY}' },
      { PROVIDER_API_KEY: 'must-not-leak' },
      ['PROVIDER_API_KEY']
    ),
    /reserved for Provider credentials/
  );
});

function runIsolatedExtensionScenario(home, workspace) {
  const script = String.raw`
    import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const workspace = process.argv[1];
    const userRoot = join(process.env.USERPROFILE || process.env.HOME, '.syzzz-code');
    mkdirSync(join(workspace, '.syzzz-code'), { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const write = (path, value, comment = '') =>
      writeFileSync(
        path,
        JSON.stringify(value, null, 2) +
          (comment ? '\n// ' + comment + '\n' : '')
      );
    write(join(userRoot, 'mcp.json'), {
      mcpServers: {
        shared: { command: 'user-server' },
        userOnly: { command: 'user-only' }
      }
    }, 'first formatting comment');
    write(join(userRoot, 'hooks.json'), {
      schemaVersion: 1,
      hooks: [
        { name: 'user-first', event: 'PreTurn', command: 'user-hook' },
        { name: 'shared-hook', event: 'PreTurn', command: 'user-shared' }
      ]
    });
    write(join(workspace, '.mcp.json'), {
      mcpServers: {
        shared: { command: 'project-server' },
        projectOnly: { command: 'project-only' }
      }
    }, 'different formatting comment');
    write(join(workspace, '.syzzz-code', 'hooks.json'), {
      schemaVersion: 1,
      hooks: [
        { name: 'shared-hook', event: 'PreTurn', command: 'project-shared' },
        { name: 'project-last', event: 'PreTurn', command: 'project-hook' }
      ]
    });
    const config = await import('./dist/extensions/config.js');
    const trust = await import('./dist/extensions/trust.js');
    const before = config.loadExtensionConfiguration(workspace);
    const { ExtensionRuntime } = await import('./dist/extensions/runtime.js');
    const runtime = new ExtensionRuntime({
      workspaceRoot: workspace,
      subagentsEnabled: true,
      subagentsAvailable: true
    });
    const beforeStatus = runtime.getStatus();
    await runtime.close();
    const preview = config.inspectProjectExtensions(workspace);
    trust.setWorkspaceTrusted(workspace, true, preview.digest);
    const trusted = config.loadExtensionConfiguration(workspace);
    write(join(workspace, '.mcp.json'), {
      mcpServers: {
        shared: { command: 'project-server-v2' },
        projectOnly: { command: 'project-only' }
      }
    });
    const changed = config.loadExtensionConfiguration(workspace);
    const changedPreview = config.inspectProjectExtensions(workspace);
    trust.setWorkspaceTrusted(workspace, true, changedPreview.digest);
    unlinkSync(join(workspace, '.mcp.json'));
    const missing = config.loadExtensionConfiguration(workspace);
    trust.setWorkspaceTrusted(workspace, false);
    const after = config.loadExtensionConfiguration(workspace);
    process.stdout.write(JSON.stringify({
      before: {
        trusted: before.workspaceTrusted,
        servers: before.mcpServers.map(item => [item.name, item.config.command]),
        hooks: before.hooks.map(item => [item.config.name, item.config.command]),
        inactiveProject: beforeStatus.inactiveProject
      },
      preview: {
        servers: preview.mcpServers.map(item => item.name),
        hooks: preview.hooks.map(item => item.config.name)
      },
      trusted: {
        trusted: trusted.workspaceTrusted,
        servers: trusted.mcpServers.map(item => [item.name, item.config.command]),
        hooks: trusted.hooks.map(item => [item.config.name, item.config.command])
      },
      changed: {
        trustState: changed.trustState,
        servers: changed.mcpServers.map(item => [item.name, item.config.command])
      },
      missing: {
        trustState: missing.trustState,
        servers: missing.mcpServers.map(item => [item.name, item.config.command])
      },
      after: {
        trusted: after.workspaceTrusted,
        servers: after.mcpServers.map(item => [item.name, item.config.command])
      }
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, workspace],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home
      },
      encoding: 'utf8'
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('project extensions load only after path trust and override by stable name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syzzz-extension-config-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    const result = runIsolatedExtensionScenario(home, workspace);
    assert.equal(result.before.trusted, false);
    assert.deepEqual(result.before.servers, [
      ['shared', 'user-server'],
      ['userOnly', 'user-only']
    ]);
    assert.deepEqual(result.preview.servers, ['shared', 'projectOnly']);
    assert.deepEqual(result.before.inactiveProject, {
      mcpServers: 2,
      hooks: 2
    });
    assert.equal(result.trusted.trusted, true);
    assert.deepEqual(result.trusted.servers, [
      ['userOnly', 'user-only'],
      ['shared', 'project-server'],
      ['projectOnly', 'project-only']
    ]);
    assert.deepEqual(result.trusted.hooks, [
      ['user-first', 'user-hook'],
      ['shared-hook', 'project-shared'],
      ['project-last', 'project-hook']
    ]);
    assert.equal(result.changed.trustState, 'review-required');
    assert.deepEqual(result.changed.servers, [
      ['shared', 'user-server'],
      ['userOnly', 'user-only']
    ]);
    assert.equal(result.missing.trustState, 'review-required');
    assert.deepEqual(result.missing.servers, [
      ['shared', 'user-server'],
      ['userOnly', 'user-only']
    ]);
    assert.equal(result.after.trusted, false);
    assert.deepEqual(result.after.servers, [
      ['shared', 'user-server'],
      ['userOnly', 'user-only']
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt project scope is isolated from trusted user extensions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syzzz-extension-corrupt-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(home, '.syzzz-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(home, '.syzzz-code', 'mcp.json'),
    JSON.stringify({ mcpServers: { user: { command: 'user-server' } } })
  );
  await writeFile(
    path.join(workspace, '.mcp.json'),
    JSON.stringify({ mcpServers: { project: { command: 'project-server' } } })
  );
  const script = String.raw`
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const workspace = process.argv[1];
    const config = await import('./dist/extensions/config.js');
    const trust = await import('./dist/extensions/trust.js');
    const preview = config.inspectProjectExtensions(workspace);
    trust.setWorkspaceTrusted(workspace, true, preview.digest);
    writeFileSync(join(workspace, '.mcp.json'), '{not json');
    const loaded = config.loadExtensionConfiguration(workspace);
    process.stdout.write(JSON.stringify({
      trustState: loaded.trustState,
      servers: loaded.mcpServers.map(item => item.name),
      warnings: loaded.warnings
    }));
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, workspace],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home
        },
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.trustState, 'review-required');
    assert.deepEqual(output.servers, ['user']);
    assert.equal(output.warnings.some(value =>
      value.includes('project MCP configuration disabled')
    ), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trust v1 requires review and normalized project digests detect changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syzzz-extension-trust-v2-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(home, '.syzzz-code'), { recursive: true });
  await mkdir(path.join(workspace, '.syzzz-code'), { recursive: true });
  const script = String.raw`
    import { realpathSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const workspace = process.argv[1];
    const home = process.env.USERPROFILE || process.env.HOME;
    const config = await import('./dist/extensions/config.js');
    const trust = await import('./dist/extensions/trust.js');
    const write = (path, value, comment = '') =>
      writeFileSync(
        path,
        JSON.stringify(value, null, 2) +
          (comment ? '\n// ' + comment + '\n' : '')
      );
    write(join(workspace, '.mcp.json'), {
      syzzz: {
        toolPolicies: {
          fixture__mutate: 'execute'
        }
      },
      mcpServers: {
        fixture: {
          args: ['server.mjs'],
          command: 'node',
          type: 'stdio'
        }
      }
    }, 'first digest comment');
    write(join(workspace, '.syzzz-code', 'hooks.json'), {
      schemaVersion: 1,
      hooks: [{
        command: 'node',
        event: 'PreCompact',
        matcher: 'manual',
        name: 'compact'
      }]
    });
    const first = config.inspectProjectExtensions(workspace);
    write(join(workspace, '.mcp.json'), {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          env: {},
          enabled: true,
          startupTimeoutMs: 30000,
          toolTimeoutMs: 60000,
          protocolMode: 'legacy'
        }
      },
      syzzz: {
        toolPolicies: {
          fixture__mutate: 'execute'
        }
      }
    }, 'different digest comment');
    const second = config.inspectProjectExtensions(workspace);
    let canonical = realpathSync.native(workspace).replaceAll('\\', '/');
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
    write(join(home, '.syzzz-code', 'trusted-workspaces.json'), {
      schemaVersion: 1,
      workspaces: [{
        schemaVersion: 1,
        canonicalWorkspaceRoot: canonical,
        trustedAt: '2026-07-28T00:00:00.000Z'
      }]
    });
    const legacy = trust.inspectWorkspaceTrust(workspace, second.digest);
    const legacyLoaded = config.loadExtensionConfiguration(workspace);
    trust.setWorkspaceTrusted(workspace, true, second.digest);
    const trusted = trust.inspectWorkspaceTrust(workspace, second.digest);
    write(join(workspace, '.syzzz-code', 'hooks.json'), {
      schemaVersion: 1,
      hooks: [{
        command: 'node',
        event: 'PreCompact',
        matcher: 'threshold',
        name: 'compact'
      }]
    });
    const changedConfig = config.inspectProjectExtensions(workspace);
    const changed = trust.inspectWorkspaceTrust(
      workspace,
      changedConfig.digest
    );
    process.stdout.write(JSON.stringify({
      firstDigest: first.digest,
      secondDigest: second.digest,
      changedDigest: changedConfig.digest,
      legacy: legacy.trustState,
      legacyServers: legacyLoaded.mcpServers.map(item => item.name),
      trusted: trusted.trustState,
      changed: changed.trustState
    }));
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, workspace],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.firstDigest, output.secondDigest);
    assert.notEqual(output.secondDigest, output.changedDigest);
    assert.equal(output.legacy, 'review-required');
    assert.deepEqual(output.legacyServers, []);
    assert.equal(output.trusted, 'trusted');
    assert.equal(output.changed, 'review-required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trust confirmation fails if project configuration changes after preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syzzz-extension-toctou-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, '.mcp.json'),
    JSON.stringify({ mcpServers: { fixture: { command: 'first' } } })
  );
  const script = String.raw`
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const workspace = process.argv[1];
    const { ExtensionRuntime } = await import('./dist/extensions/runtime.js');
    const runtime = new ExtensionRuntime({
      workspaceRoot: workspace,
      subagentsEnabled: true,
      subagentsAvailable: true
    });
    const preview = runtime.getTrustPreview();
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
      mcpServers: { fixture: { command: 'second' } }
    }));
    let error;
    try {
      await runtime.trustWorkspace(preview.digest);
    } catch (caught) {
      error = caught.message;
    }
    const status = runtime.getStatus();
    await runtime.close();
    process.stdout.write(JSON.stringify({ error, trustState: status.trustState }));
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, workspace],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.error, /changed during confirmation/);
    assert.equal(output.trustState, 'untrusted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP policies merge by strictness and project policy needs matching trust', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syzzz-mcp-policy-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(home, '.syzzz-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(home, '.syzzz-code', 'mcp.json'),
    JSON.stringify({
      mcpServers: { fixture: { command: 'user-server' } },
      syzzz: {
        toolPolicies: {
          fixture__mutate: 'execute',
          fixture__hidden: 'disabled'
        }
      }
    })
  );
  await writeFile(
    path.join(workspace, '.mcp.json'),
    JSON.stringify({
      mcpServers: { fixture: { command: 'project-server' } },
      syzzz: {
        toolPolicies: {
          fixture__mutate: 'disabled',
          fixture__other: 'execute'
        }
      }
    })
  );
  const script = String.raw`
    const workspace = process.argv[1];
    const config = await import('./dist/extensions/config.js');
    const trust = await import('./dist/extensions/trust.js');
    const before = config.loadExtensionConfiguration(workspace);
    const preview = config.inspectProjectExtensions(workspace);
    trust.setWorkspaceTrusted(workspace, true, preview.digest);
    const after = config.loadExtensionConfiguration(workspace);
    process.stdout.write(JSON.stringify({
      before: before.mcpToolPolicies,
      after: after.mcpToolPolicies
    }));
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, workspace],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      output.before.map(entry => [entry.qualifiedName, entry.policy]),
      [
        ['fixture__hidden', 'disabled'],
        ['fixture__mutate', 'execute']
      ]
    );
    assert.deepEqual(
      output.after.map(entry => [
        entry.qualifiedName,
        entry.policy,
        entry.sources
      ]),
      [
        ['fixture__hidden', 'disabled', ['user']],
        ['fixture__mutate', 'disabled', ['user', 'project']],
        ['fixture__other', 'execute', ['project']]
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reload disconnects active project MCP when the reviewed digest changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syzzz-extension-reload-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, '.mcp.json'),
    JSON.stringify({ mcpServers: { fixture: { command: 'first' } } })
  );
  const script = String.raw`
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const workspace = process.argv[1];
    const config = await import('./dist/extensions/config.js');
    const trust = await import('./dist/extensions/trust.js');
    const { ExtensionRuntime } = await import('./dist/extensions/runtime.js');
    const preview = config.inspectProjectExtensions(workspace);
    trust.setWorkspaceTrusted(workspace, true, preview.digest);
    let closes = 0;
    const runtime = new ExtensionRuntime({
      workspaceRoot: workspace,
      subagentsEnabled: true,
      subagentsAvailable: true,
      mcpConnectionFactory: async () => ({
        async listTools() {
          return [{
            name: 'read',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true }
          }];
        },
        async callTool() { return { content: [] }; },
        async close() { closes += 1; }
      })
    });
    await runtime.mcp.search({}, new AbortController().signal);
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
      mcpServers: { fixture: { command: 'second' } }
    }));
    const result = await runtime.reload();
    const status = runtime.getStatus();
    await runtime.close();
    process.stdout.write(JSON.stringify({
      closes,
      result,
      trustState: status.trustState,
      configured: status.mcp.configured
    }));
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, workspace],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.closes, 1);
    assert.equal(output.trustState, 'review-required');
    assert.equal(output.configured, 0);
    assert.equal(output.result.trustState, 'review-required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
