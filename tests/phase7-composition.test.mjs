import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSkillDocument,
  TaskCompositionError,
  TaskCompositionRuntime
} from '../dist/composition/runtime.js';
import {
  createContextSuggestionProvider,
  createSkillSuggestionProvider
} from '../dist/composition/suggestions.js';
import { QueryEngine } from '../dist/engine.js';

const skillsConfig = {
  enabled: true,
  allowImplicit: true,
  disabled: []
};

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectDirectory, 'dist', 'index.js');

async function withCompositionFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-phase7-composition-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(home, '.syzzz-code'), { recursive: true });
  try {
    await run({ root, workspace, home });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(directory, name, description, body, extra = '') {
  const root = join(directory, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`,
    'utf8'
  );
  return root;
}

test('explicit context resolves quoted paths, line ranges, directories, and layered AGENTS', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeFile(join(home, '.syzzz-code', 'AGENTS.md'), 'user instruction', 'utf8');
    await writeFile(join(workspace, 'AGENTS.md'), 'workspace instruction', 'utf8');
    await writeFile(join(workspace, 'src', 'AGENTS.md'), 'nested instruction', 'utf8');
    await writeFile(join(workspace, 'src', 'hello world.ts'), 'one\ntwo\nthree\n', 'utf8');
    await writeFile(join(workspace, 'src', 'other.ts'), 'export {};\n', 'utf8');

    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    runtime.beginTurn();
    const composed = await runtime.compose(
      'Review @"src/hello world.ts"#L2-L3 and @src. Email a@b.com. Literal @@name.',
      new AbortController().signal
    );

    assert.equal(composed.receipts.length, 2);
    assert.deepEqual(
      composed.receipts.map((receipt) => receipt.type),
      ['file', 'directory']
    );
    assert.match(composed.message, /lines="2-3"/);
    assert.match(composed.message, /two\nthree/);
    assert.match(composed.message, /src\/other\.ts/);
    assert.match(composed.message, /Email a@b\.com\. Literal @name\./);
    assert.match(composed.message, /explicitly escaped these @ characters with @@/);
    assert.equal(composed.events.filter((event) => event.type === 'context_resolved').length, 2);

    const prelude = await runtime.getPreludeMessages();
    assert.equal(prelude.length, 1);
    const instructionText = prelude[0].content;
    assert.ok(
      instructionText.indexOf('user instruction') < instructionText.indexOf('workspace instruction')
    );
    assert.ok(
      instructionText.indexOf('workspace instruction') <
        instructionText.lastIndexOf('nested instruction'),
      instructionText
    );
    assert.equal(runtime.getStatus().instructions.loaded, 3);
  });
});

test('composition diagnostics explain Windows PowerShell encoding and enforce Skill metadata limits', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeFile(join(workspace, 'AGENTS.md'), Buffer.from([0xbb, 0xd8, 0xb4, 0xf0]));
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    assert.ok(
      runtime
        .getStatus()
        .warnings.some(
          (warning) =>
            /not valid UTF-8/.test(warning) && /PowerShell 5\.1 Set-Content/.test(warning)
        )
    );

    assert.throws(
      () => parseSkillDocument('---\nname: trailing-\ndescription: valid\n---\n'),
      /trailing, or consecutive hyphens/
    );
    assert.throws(
      () => parseSkillDocument('---\nname: double--hyphen\ndescription: valid\n---\n'),
      /trailing, or consecutive hyphens/
    );
    assert.throws(
      () =>
        parseSkillDocument(`---\nname: long-description\ndescription: ${'x'.repeat(1_025)}\n---\n`),
      /received 1025/
    );
    assert.equal(
      parseSkillDocument(
        `---\nname: exact-description\ndescription: |\n  ${'x'.repeat(1_024)}\n---\n`
      ).description.length,
      1_024
    );
  });
});

test('context failures are explicit and sensitive files never enter composed history', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeFile(join(workspace, '.env'), 'SECRET=value\n', 'utf8');
    await writeFile(join(workspace, 'large.txt'), 'line\n'.repeat(10_000), 'utf8');
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });

    await assert.rejects(
      runtime.compose('Read @large.txt', new AbortController().signal),
      (error) => {
        assert.ok(error instanceof TaskCompositionError);
        assert.equal(error.events.at(-1).type, 'context_failed');
        return /40 KiB/.test(error.message);
      }
    );
    await assert.rejects(
      runtime.compose('Read @.env', new AbortController().signal),
      (error) =>
        error instanceof TaskCompositionError &&
        error.events.some((event) => event.type === 'context_failed')
    );
    await assert.rejects(
      runtime.compose(
        Array.from({ length: 11 }, (_, index) => `@file-${index}.txt`).join(' '),
        new AbortController().signal
      ),
      /At most 10/
    );
  });
});

test('context line receipts do not count a trailing newline as an extra line', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeFile(join(workspace, 'evidence.ts'), '\uFEFFline one\r\nline two\r\n', 'utf8');
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });

    const composed = await runtime.compose('Review @evidence.ts', new AbortController().signal);
    assert.equal(composed.receipts[0].lineStart, 1);
    assert.equal(composed.receipts[0].lineEnd, 2);
    assert.match(composed.message, /lines="1-2"/);
    assert.match(composed.message, /line one\nline two/);
    assert.doesNotMatch(composed.message, /\uFEFF/);
  });
});

test('AGENTS loading is bounded, rejects symlinks, and does not duplicate diagnostics', async () => {
  await withCompositionFixture(async ({ root, workspace, home }) => {
    await writeFile(join(workspace, 'AGENTS.md'), 'A'.repeat(128 * 1024), 'utf8');
    await writeFile(join(workspace, 'src', 'file.ts'), 'export {};\n', 'utf8');
    const outside = join(root, 'outside-agents.md');
    await writeFile(outside, 'DO NOT LOAD THIS', 'utf8');
    let linked = true;
    try {
      await symlink(outside, join(workspace, 'src', 'AGENTS.md'), 'file');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        linked = false;
      } else {
        throw error;
      }
    }

    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    await runtime.noteTouchedPaths(['src/file.ts']);
    const first = await runtime.getPreludeMessages();
    const second = await runtime.getPreludeMessages();
    assert.ok(Buffer.byteLength(first[0].content, 'utf8') < 40 * 1024);
    assert.equal(first[0].content, second[0].content);
    const status = runtime.getStatus();
    assert.equal(status.warnings.filter((warning) => /was truncated/.test(warning)).length, 1);
    if (linked) {
      assert.doesNotMatch(first[0].content, /DO NOT LOAD THIS/);
      assert.equal(
        status.warnings.filter((warning) => /symbolic links are not loaded/.test(warning)).length,
        1
      );
    }
  });
});

test('Skill discovery is deterministic and activation remains unprivileged', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeSkill(join(home, '.agents', 'skills'), 'review-code', 'shared version', 'SHARED');
    await writeSkill(join(home, '.syzzz-code', 'skills'), 'review-code', 'syzzz version', 'USER');
    const projectSkill = await writeSkill(
      join(workspace, '.agents', 'skills'),
      'review-code',
      'project version',
      'PROJECT WORKFLOW',
      'allowed-tools: Shell\n'
    );
    await writeFile(join(projectSkill, 'guide.txt'), 'RESOURCE EVIDENCE', 'utf8');
    await writeFile(join(projectSkill, '..', 'outside.txt'), 'OUTSIDE SKILL ROOT', 'utf8');

    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    const winner = runtime.inspectSkill('review-code');
    assert.equal(winner.source, 'project');
    assert.equal(winner.description, 'project version');
    assert.deepEqual(winner.unsupportedFields, ['allowed-tools']);
    assert.equal(runtime.listSkills().filter((skill) => skill.shadowed).length, 2);

    runtime.beginTurn();
    const composed = await runtime.compose(
      '$review-code focus on safety',
      new AbortController().signal
    );
    assert.match(composed.message, /PROJECT WORKFLOW/);
    assert.match(composed.message, /<skill_arguments>focus on safety<\/skill_arguments>/);
    assert.ok(composed.events.some((event) => event.type === 'skill_activated'));

    const tools = new Map(runtime.getTools().map((tool) => [tool.name, tool]));
    const context = {
      toolCallId: 'tool-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      workspaceRoot: workspace,
      workingDirectory: workspace,
      mode: 'ask',
      permissionMode: 'safe',
      signal: new AbortController().signal
    };
    const resource = await tools
      .get('ReadSkillResource')
      .execute({ skill: 'review-code', path: 'guide.txt' }, context);
    assert.match(resource.content, /RESOURCE EVIDENCE/);
    const escapedResource = await tools
      .get('ReadSkillResource')
      .execute({ skill: 'review-code', path: '../outside.txt' }, context);
    assert.equal(escapedResource.isError, true);
    assert.doesNotMatch(escapedResource.content, /OUTSIDE SKILL ROOT/);
    const escaped = await runtime.compose('$$review-code is literal', new AbortController().signal);
    assert.equal(escaped.message, '$review-code is literal');
  });
});

test('project Skill discovery does not follow a directory outside the repository', async () => {
  await withCompositionFixture(async ({ root, workspace, home }) => {
    const outsideAgents = join(root, 'outside-agents');
    await writeSkill(
      join(outsideAgents, 'skills'),
      'outside-skill',
      'Must remain outside',
      'OUTSIDE SKILL BODY'
    );
    let linked = true;
    try {
      await symlink(
        outsideAgents,
        join(workspace, '.agents'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        linked = false;
      } else {
        throw error;
      }
    }
    if (!linked) {
      return;
    }

    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    assert.equal(runtime.inspectSkill('outside-skill'), undefined);
    assert.ok(
      runtime
        .getStatus()
        .warnings.some((warning) => /Skills directory resolves outside/.test(warning))
    );
  });
});

test('Engine injects current AGENTS transiently while persisting explicit evidence snapshots', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeFile(join(workspace, 'AGENTS.md'), 'Always inspect evidence carefully.', 'utf8');
    await writeFile(join(workspace, 'source.ts'), 'export const value = 42;\n', 'utf8');
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    let request;
    const provider = {
      async chat(nextRequest) {
        request = nextRequest;
        return { message: { role: 'assistant', content: 'done' } };
      },
      getInfo() {
        return {
          name: 'Fixture',
          type: 'test',
          model: 'fixture',
          contextWindowTokens: 65_536,
          capabilities: { streaming: false, reasoningToggle: false }
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      tools: [],
      composition: runtime,
      workspaceRoot: workspace,
      audit: false
    });
    const result = await engine.chat('Use @source.ts#L1');
    assert.equal(result, 'done');
    assert.match(request.messages[0].content, /Always inspect evidence carefully/);
    assert.match(request.messages.at(-1).content, /export const value = 42/);
    const persisted = engine.getMessages();
    assert.equal(
      persisted.some((message) => message.content?.includes('Always inspect evidence carefully')),
      false
    );
    assert.equal(
      persisted.some((message) => message.content?.includes('export const value = 42')),
      true
    );
  });
});

test('Engine reports composition failure before sampling and preserves unique terminal semantics', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeFile(join(workspace, '.env'), 'SECRET=value\n', 'utf8');
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    let providerCalls = 0;
    const provider = {
      async chat() {
        providerCalls += 1;
        return { message: { role: 'assistant', content: 'unexpected' } };
      },
      getInfo() {
        return {
          name: 'Fixture',
          type: 'test',
          model: 'fixture',
          capabilities: { streaming: false, reasoningToggle: false }
        };
      }
    };
    const engine = new QueryEngine({
      provider,
      tools: [],
      composition: runtime,
      workspaceRoot: workspace,
      audit: false
    });
    const events = [];
    const turn = engine.runTurn('Read @.env');
    let result;
    while (true) {
      const next = await turn.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }
    assert.equal(result.status, 'failed');
    assert.equal(providerCalls, 0);
    assert.equal(events.filter((event) => event.type === 'context_failed').length, 1);
    assert.deepEqual(
      events.filter((event) => event.type.startsWith('turn_')).map((event) => event.type),
      ['turn_started', 'turn_failed']
    );
    assert.equal(engine.getMessages().length, 0);
  });
});

test('@ and $ suggestion providers return bounded workspace and Skill candidates', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeFile(join(workspace, 'src', 'hello world.ts'), 'export {};\n', 'utf8');
    await writeSkill(
      join(workspace, '.agents', 'skills'),
      'review-code',
      'Review code safely',
      'Review the supplied evidence.'
    );
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    const contextProvider = createContextSuggestionProvider(runtime);
    const contextInput = 'Use @"src/hello';
    const contextRequest = contextProvider.match(contextInput, contextInput.length);
    assert.ok(contextRequest);
    const contextSuggestions = await contextProvider.suggest(
      contextRequest,
      new AbortController().signal
    );
    assert.equal(contextSuggestions[0].insertText, '@"src/hello world.ts"');

    const skillProvider = createSkillSuggestionProvider(runtime);
    const skillRequest = skillProvider.match('$rev', 4);
    assert.ok(skillRequest);
    const skillSuggestions = await skillProvider.suggest(
      skillRequest,
      new AbortController().signal
    );
    assert.equal(skillSuggestions[0].insertText, '$review-code ');
  });
});

test('Skills CLI lists, inspects, and diagnoses discovered Skills without a Provider request', async () => {
  await withCompositionFixture(async ({ workspace, home }) => {
    await writeSkill(
      join(workspace, '.agents', 'skills'),
      'review-code',
      'Review code safely',
      'Review the supplied evidence.'
    );
    await writeFile(
      join(home, '.syzzz-code', 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        currentProvider: 'fixture',
        providers: {
          fixture: {
            name: 'Fixture',
            type: 'openai-compatible',
            model: 'fixture-model',
            models: ['fixture-model'],
            env: { BASE_URL: 'https://example.invalid/v1', API_KEY: '' }
          }
        }
      }),
      'utf8'
    );
    const environment = { ...process.env, HOME: home, USERPROFILE: home };
    const run = (...arguments_) =>
      spawnSync(process.execPath, [cliPath, 'skills', ...arguments_], {
        cwd: workspace,
        env: environment,
        encoding: 'utf8'
      });

    const listed = run('list', '--json');
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).find((skill) => !skill.shadowed).name, 'review-code');

    const inspected = run('inspect', 'review-code', '--json');
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).description, 'Review code safely');

    const diagnosed = run('doctor', '--json');
    assert.equal(diagnosed.status, 0, diagnosed.stderr);
    assert.equal(JSON.parse(diagnosed.stdout).ok, true);

    const invalidScope = run('list', '--scope', 'shared');
    assert.equal(invalidScope.status, 1);
    assert.match(invalidScope.stderr, /scope must be user or project/);
  });
});
