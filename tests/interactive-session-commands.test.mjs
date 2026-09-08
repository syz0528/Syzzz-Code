import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

test('interactive session lifecycle commands remain local and compose', () => {
  const script = `
    import { runInteractiveSession } from './dist/interactive.js';

    function makeEngine(sessionId, mode = 'code') {
      let currentMode = mode;
      let permission = 'safe';
      let model = 'alpha-model';
      return {
        getSessionId() { return sessionId; },
        getMode() { return currentMode; },
        setMode(value) { currentMode = value; },
        getPermissionMode() { return permission; },
        setPermissionMode(value) { permission = value; },
        getProviderInfo() {
          return {
            name: 'Alpha',
            type: 'test',
            model,
            capabilities: { streaming: false, reasoningToggle: false }
          };
        },
        setProvider() { model = 'beta-model'; },
        getStatus() {
          return {
            sessionId,
            workspaceRoot: process.cwd(),
            mode: currentMode,
            permissionMode: permission,
            provider: this.getProviderInfo(),
            messageCount: 2,
            totalUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            persistence: { state: 'healthy', dirty: false },
            context: {
              estimatedInputTokens: 100,
              contextWindowTokens: 65536,
              triggerTokens: 55705,
              compactions: 1,
              compactionCircuitOpen: false,
              lastRequest: { estimatedInputTokens: 13164, triggerTokens: 13926, contextWindowTokens: 16384 }
            }
          };
        },
        async *compactContext() {
          console.log('MARK:compact');
          return {
            status: 'completed',
            durationMs: 1,
            compactions: 1,
            beforeTokens: 1000,
            afterTokens: 300
          };
        }
      };
    }

    const session = {
      engine: makeEngine('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      providerId: 'alpha',
      sessionStore: { workspaceDirectory: 'LOCAL_SESSION_DIRECTORY' },
      getStatus() {
        return {
          sessionId: this.engine.getSessionId(),
          title: 'Current',
          revision: 1,
          autoSave: true,
          dirty: false,
          persistence: 'healthy'
        };
      },
      hasUnsavedChanges() { return false; },
      async stateChanged() { console.log('MARK:state'); },
      async recordTurn() {},
      async rename(title) { console.log('MARK:rename:' + title); },
      async save() {
        console.log('MARK:save');
        return {
          title: 'Current',
          sessionId: this.engine.getSessionId()
        };
      },
      async list() {
        return [{
          available: true,
          sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          title: 'Saved',
          updatedAt: '2026-07-28T00:00:00.000Z'
        }];
      },
      async newSession(title) {
        console.log('MARK:new:' + title);
        this.engine = makeEngine(
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        );
        return {
          sessionId: this.engine.getSessionId(),
          title,
          providerId: this.providerId
        };
      },
      async resume(id) {
        console.log('MARK:resume:' + id);
        this.engine = makeEngine(
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          'plan'
        );
        return {
          sessionId: this.engine.getSessionId(),
          title: 'Saved',
          providerId: this.providerId
        };
      },
      async setProviderReference(id) {
        this.providerId = id;
        console.log('MARK:provider:' + id);
      },
      async close() { console.log('MARK:close'); }
    };

    await runInteractiveSession(session.engine, {
      session,
      uiLanguage: 'en',
      availableModels: ['alpha-model'],
      getProviderOptions() {
        return [
          {
            id: 'alpha',
            name: 'Alpha',
            model: 'alpha-model',
            models: ['alpha-model'],
            available: true
          },
          {
            id: 'beta',
            name: 'Beta',
            model: 'beta-model',
            models: ['beta-model'],
            available: true
          }
        ];
      },
      modelsForProvider(id) {
        return [id + '-model'];
      },
      async activateProvider(id, engine) {
        engine.setProvider();
        return { providerId: id, models: [id + '-model'] };
      }
    });
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: projectDirectory,
    encoding: 'utf8',
    input: [
      '/rename Better title',
      '/save',
      '/compact',
      '/provider beta',
      '/new Fresh',
      '/resume dddddddd',
      '/status',
      '/exit',
      ''
    ].join('\n'),
    timeout: 5_000
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /MARK:rename:Better title/);
  assert.match(result.stdout, /MARK:save/);
  assert.match(result.stdout, /MARK:compact/);
  assert.match(result.stdout, /MARK:provider:beta/);
  assert.match(result.stdout, /MARK:new:Fresh/);
  assert.match(result.stdout, /MARK:resume:dddddddd/);
  assert.match(result.stdout, /Work mode:\s+plan/);
  assert.match(
    result.stdout,
    /Last request:\s+13164 \/ 13926 tokens \(estimated \/ safe input limit\); model window 16384/
  );
  assert.match(result.stdout, /MARK:close/);
  assert.doesNotMatch(result.stdout, /HANDLED:.*\//);
  const chinese = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script.replace("uiLanguage: 'en'", "uiLanguage: 'zh-CN'")],
    {
      cwd: projectDirectory,
      encoding: 'utf8',
      input: '/status\n/exit\n',
      timeout: 5_000
    }
  );
  assert.equal(chinese.status, 0, chinese.stderr || chinese.error?.message);
  assert.match(
    chinese.stdout,
    /上次完整请求：13164 \/ 13926 tokens（估算 \/ 安全输入上限）; 模型窗口 16384/
  );
});

test('autosave-off session switching requires explicit discard confirmation', () => {
  const script = `
    import { runInteractiveSession } from './dist/interactive.js';

    let dirty = false;
    const engine = {
      getMode() { return 'code'; },
      getPermissionMode() { return 'safe'; },
      getProviderInfo() {
        return { name: 'Test', type: 'test', model: 'test-model' };
      },
      async chat(message) {
        console.log('HANDLED:' + message);
        return 'done';
      }
    };
    const session = {
      engine,
      providerId: 'test',
      sessionStore: { workspaceDirectory: 'LOCAL_SESSION_DIRECTORY' },
      getStatus() {
        return {
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Unsaved',
          revision: 0,
          autoSave: false,
          dirty,
          persistence: 'disabled'
        };
      },
      hasUnsavedChanges() { return dirty; },
      async recordTurn() { dirty = true; },
      async newSession() { console.log('MARK:new-should-not-run'); },
      async close() {}
    };
    await runInteractiveSession(engine, { session, uiLanguage: 'en' });
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: projectDirectory,
    encoding: 'utf8',
    input: 'hello\n/new\nn\n/exit\n',
    timeout: 5_000
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /HANDLED:hello/);
  assert.match(result.stdout, /New session cancelled/);
  assert.doesNotMatch(result.stdout, /MARK:new-should-not-run/);
});
