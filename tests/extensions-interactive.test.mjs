import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

function runInteractive(input) {
  const script = String.raw`
    import { runInteractiveSession } from './dist/interactive.js';

    let trusted = false;
    let subagentsEnabled = true;
    const calls = [];
    const runtime = {
      mcp: {
        getStatuses() {
          return [{
            name: 'project-mcp',
            source: 'project',
            transport: 'stdio',
            state: 'disconnected',
            toolCount: 0,
            protocolMode: 'legacy'
          }];
        },
        async reconnect(name) {
          calls.push('reconnect:' + name);
        }
      },
      getStatus() {
        return {
          workspaceTrusted: trusted,
          projectConfigurationPresent: true,
          ...(trusted
            ? {}
            : { inactiveProject: { mcpServers: 1, hooks: 1 } }),
          mcp: {
            configured: trusted ? 1 : 0,
            ready: 0,
            servers: trusted ? this.mcp.getStatuses() : []
          },
          hooks: {
            configured: trusted ? 1 : 0,
            enabled: trusted ? 1 : 0
          },
          subagents: {
            enabled: subagentsEnabled,
            available: true
          },
          warnings: []
        };
      },
      getTrustPreview() {
        return {
          lines: [
            'MCP stdio project-mcp: node server.mjs --flag',
            'Hook PreToolUse block-shell: node hook.mjs'
          ],
          warnings: []
        };
      },
      supportsSubagents() {
        return true;
      },
      setSubagentsEnabled(enabled) {
        subagentsEnabled = enabled;
        calls.push('agents:' + enabled);
      },
      async trustWorkspace() {
        trusted = true;
        calls.push('trust');
      },
      async untrustWorkspace() {
        trusted = false;
        calls.push('untrust');
      },
      async reload() {
        calls.push('reload');
      }
    };
    const engine = {
      getMode() { return 'code'; },
      getPermissionMode() { return 'safe'; },
      getExtensionRuntime() { return runtime; },
      getStatus() {
        return {
          sessionId: 'phase5-status',
          workspaceRoot: process.cwd(),
          mode: 'code',
          permissionMode: 'safe',
          provider: {
            name: 'Fixture',
            type: 'fixture',
            model: 'fixture-model'
          },
          messageCount: 0,
          totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          persistence: { state: 'unmanaged', dirty: false },
          extensions: runtime.getStatus(),
          context: {
            estimatedInputTokens: 100,
            contextWindowTokens: 1000,
            triggerTokens: 850,
            compactions: 0,
            compactionCircuitOpen: false
          }
        };
      },
      async chat(message) {
        calls.push('chat:' + message);
        return 'unexpected';
      }
    };

    await runInteractiveSession(engine, {
      persistSubagentsEnabled(enabled) {
        calls.push('persist-agents:' + enabled);
      }
    });
    console.log('RESULT:' + JSON.stringify({ calls, trusted, subagentsEnabled }));
  `;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: projectDirectory,
      encoding: 'utf8',
      input,
      timeout: 5_000
    }
  );
}

function parseResult(output) {
  const match = output.match(/RESULT:(\{.*\})/);
  assert.ok(match, output);
  return JSON.parse(match[1]);
}

test('workspace trust displays exact extensions and accepts only y or Y', () => {
  const result = runInteractive(
    '/trust\nyes\n/trust\n y \n/trust\ny\n/untrust\n/exit\n'
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /node server\.mjs --flag/);
  assert.match(result.stdout, /node hook\.mjs/);
  assert.match(
    result.stdout,
    /Future project extension changes take effect after restart or reload/
  );
  assert.equal(
    (result.stdout.match(/Workspace trust cancelled/g) ?? []).length,
    2
  );
  const state = parseResult(result.stdout);
  assert.deepEqual(state.calls, ['trust', 'untrust']);
  assert.equal(state.trusted, false);
});

test('/agents persists display state and extension commands stay local', () => {
  const result = runInteractive(
    '/status\n/agents\n/agents off\n/agents on\n/mcp reload\n/hooks reload\n/exit\n'
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /0 configured \/ 1 project inactive/);
  assert.match(result.stdout, /Read-only subagents/);
  const state = parseResult(result.stdout);
  assert.deepEqual(state.calls, [
    'persist-agents:false',
    'agents:false',
    'persist-agents:true',
    'agents:true',
    'reload',
    'reload'
  ]);
  assert.equal(state.subagentsEnabled, true);
  assert.equal(state.calls.some(value => value.startsWith('chat:')), false);
});
