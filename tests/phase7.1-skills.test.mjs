import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskCompositionRuntime } from '../dist/composition/runtime.js';
import { createSkill, validateSkillPath } from '../dist/composition/skill-authoring.js';
import { runSkillActivationEval } from '../dist/composition/skill-eval.js';
import { createSkillSuggestionProvider } from '../dist/composition/suggestions.js';
import {
  parseSkillActivationEval,
  parseSkillOpenAiMetadata
} from '../dist/composition/skill-format.js';
import { QueryEngine } from '../dist/engine.js';

const skillsConfig = { enabled: true, allowImplicit: true, disabled: [] };
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, 'dist', 'index.js');

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'syzzz-phase71-skills-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    await run({ root, workspace, home });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(root, name, description, body) {
  const skillRoot = join(root, name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8'
  );
  return skillRoot;
}

function toolContext(workspace) {
  return {
    toolCallId: 'tool-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    workspaceRoot: workspace,
    workingDirectory: workspace,
    mode: 'ask',
    permissionMode: 'safe',
    signal: new AbortController().signal
  };
}

test('OpenAI metadata controls implicit discovery while explicit activation remains available', async () => {
  await fixture(async ({ workspace, home }) => {
    const skillRoot = await writeSkill(
      join(home, '.agents', 'skills'),
      'metadata-demo',
      'Long standard description',
      'METADATA WORKFLOW'
    );
    await mkdir(join(skillRoot, 'agents'), { recursive: true });
    await mkdir(join(skillRoot, 'references'), { recursive: true });
    await writeFile(join(skillRoot, 'references', 'guide.md'), 'guide', 'utf8');
    await writeFile(
      join(skillRoot, 'agents', 'openai.yaml'),
      [
        'interface:',
        '  display_name: Metadata Demo',
        '  short_description: One line summary',
        '  brand_color: "#123ABC"',
        'policy:',
        '  allow_implicit_invocation: false',
        'dependencies:',
        '  tools:',
        '    - type: mcp',
        '      value: weather__forecast'
      ].join('\n'),
      'utf8'
    );
    const brokenRoot = await writeSkill(
      join(home, '.agents', 'skills'),
      'broken-metadata',
      'Still explicitly usable',
      'BROKEN METADATA BODY'
    );
    await mkdir(join(brokenRoot, 'agents'), { recursive: true });
    await writeFile(join(brokenRoot, 'agents', 'openai.yaml'), 'interface: [broken', 'utf8');
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    const descriptor = runtime.inspectSkill('metadata-demo');
    assert.equal(descriptor.interface.displayName, 'Metadata Demo');
    assert.equal(descriptor.interface.shortDescription, 'One line summary');
    assert.equal(descriptor.policy.allowImplicitInvocation, false);
    assert.equal(descriptor.dependencies[0].raw, 'weather__forecast');
    assert.ok(descriptor.resourceManifest.entries.includes('references/guide.md'));

    const prelude = await runtime.getPreludeMessages({
      signal: new AbortController().signal,
      contextWindowTokens: 65_536
    });
    assert.equal(
      prelude.some((message) => message.content.includes('metadata-demo')),
      false
    );
    const explicit = await runtime.compose('$metadata-demo use it', new AbortController().signal);
    assert.match(explicit.message, /METADATA WORKFLOW/);
    const activate = runtime.getTools().find((tool) => tool.name === 'ActivateSkill');
    const implicit = await activate.execute({ name: 'metadata-demo' }, toolContext(workspace));
    assert.equal(implicit.isError, true);
    assert.match(implicit.content, /disabled/);
    const broken = runtime.inspectSkill('broken-metadata');
    assert.ok(broken.metadataError);
    assert.equal(broken.policy.allowImplicitInvocation, false);
    const brokenExplicit = await runtime.compose('$broken-metadata', new AbortController().signal);
    assert.match(brokenExplicit.message, /BROKEN METADATA BODY/);
  });
});

test('OpenAI metadata and activation eval schemas validate all supported fields', () => {
  const metadata = parseSkillOpenAiMetadata(
    [
      'interface:',
      '  display_name: Demo',
      '  short_description: Short',
      '  icon_small: assets/small.svg',
      '  icon_large: assets/large.svg',
      '  brand_color: "#ABCDEF"',
      '  default_prompt: Run the workflow',
      'policy:',
      '  allow_implicit_invocation: true',
      'dependencies:',
      '  - type: mcp',
      '    value: server/tool',
      '  - type: ignored',
      '    value: no-op'
    ].join('\n')
  );
  assert.deepEqual(metadata.interface, {
    displayName: 'Demo',
    shortDescription: 'Short',
    iconSmall: 'assets/small.svg',
    iconLarge: 'assets/large.svg',
    brandColor: '#ABCDEF',
    defaultPrompt: 'Run the workflow'
  });
  assert.equal(metadata.policy.allowImplicitInvocation, true);
  assert.deepEqual(metadata.dependencies[0], {
    type: 'mcp',
    server: 'server',
    tool: 'tool',
    raw: 'server/tool'
  });
  const evaluation = parseSkillActivationEval(
    'schemaVersion: 1\ncases:\n  - id: direct\n    prompt: use it\n    expect: activate\n'
  );
  assert.equal(evaluation.cases.length, 1);
  for (const invalid of [
    'interface: []',
    'interface:\n  brand_color: red',
    'policy:\n  allow_implicit_invocation: yes',
    'dependencies:\n  tools: invalid',
    'dependencies:\n  - type: mcp'
  ]) {
    assert.throws(() => parseSkillOpenAiMetadata(invalid));
  }
  assert.throws(() => parseSkillActivationEval('schemaVersion: 2\ncases: []\n'), /schemaVersion 1/);
  assert.throws(
    () =>
      parseSkillActivationEval(
        'schemaVersion: 1\ncases:\n  - id: duplicate\n    prompt: one\n    expect: activate\n  - id: duplicate\n    prompt: two\n    expect: not-activate\n'
      ),
    /duplicate/
  );
});

test('Skill suggestions expose stable source labels and search display metadata', async () => {
  await fixture(async ({ workspace, home }) => {
    const projectSkill = await writeSkill(
      join(workspace, '.agents', 'skills'),
      'project-skill',
      'Project description',
      'PROJECT'
    );
    await mkdir(join(projectSkill, 'agents'), { recursive: true });
    await writeFile(
      join(projectSkill, 'agents', 'openai.yaml'),
      'interface:\n  display_name: Project Display\n  short_description: Weather workflow\n',
      'utf8'
    );
    await writeSkill(join(home, '.agents', 'skills'), 'user-skill', 'User description', 'USER');
    await writeSkill(
      join(home, '.syzzz-code', 'skills'),
      'legacy-skill',
      'Legacy description',
      'LEGACY'
    );
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    const provider = createSkillSuggestionProvider(runtime);

    assert.equal(provider.match('$', 0), null);
    assert.equal(provider.match('$$', 2), null);
    assert.equal(provider.match('$project skill', 14), null);
    const request = provider.match('$', 1);
    assert.ok(request);
    const suggestions = await provider.suggest(request, new AbortController().signal);
    assert.ok(
      suggestions.some(
        (item) => item.label.includes('$project-skill') && item.label.includes('[project]')
      )
    );
    assert.ok(
      suggestions.some(
        (item) => item.label.includes('$user-skill') && item.label.includes('[user]')
      )
    );
    assert.ok(
      suggestions.some(
        (item) => item.label.includes('$legacy-skill') && item.label.includes('[legacy]')
      )
    );

    const metadataMatches = await provider.suggest(
      { query: 'weather' },
      new AbortController().signal
    );
    assert.deepEqual(
      metadataMatches.map((item) => item.insertText),
      ['$project-skill ']
    );
    assert.equal(metadataMatches[0].description, 'Weather workflow');
  });
});

test('Skill catalog is budgeted and Skill changes refresh automatically before a turn', async () => {
  await fixture(async ({ workspace, home }) => {
    const root = join(home, '.agents', 'skills');
    const dynamic = await writeSkill(root, 'dynamic-skill', 'D'.repeat(300), 'VERSION ONE');
    await writeSkill(root, 'second-skill', 'S'.repeat(300), 'SECOND');
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    await runtime.getPreludeMessages({
      signal: new AbortController().signal,
      contextWindowTokens: 1_000
    });
    assert.ok(runtime.getStatus().skills.catalogOmitted > 0);
    await writeFile(
      join(dynamic, 'SKILL.md'),
      '---\nname: dynamic-skill\ndescription: refreshed\n---\n\nVERSION TWO WITH NEW SIZE\n',
      'utf8'
    );
    runtime.beginTurn();
    const composed = await runtime.compose('$dynamic-skill', new AbortController().signal);
    assert.match(composed.message, /VERSION TWO WITH NEW SIZE/);
    assert.ok(runtime.getStatus().skills.autoRefresh.reloadCount >= 2);
  });
});

test('user Skill symlinks and in-root resource links work but target changes fail closed', async () => {
  await fixture(async ({ root, workspace, home }) => {
    const outside = join(root, 'linked-skill');
    await writeSkill(root, 'linked-skill', 'linked description', 'LINKED BODY');
    await mkdir(join(outside, 'references'), { recursive: true });
    await writeFile(join(outside, 'references', 'actual.txt'), 'INSIDE LINK', 'utf8');
    const source = join(home, '.agents', 'skills');
    await mkdir(source, { recursive: true });
    const link = join(source, 'linked-skill');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        return;
      }
      throw error;
    }
    const resourceLink = join(outside, 'references', 'linked.txt');
    try {
      await symlink(join(outside, 'references', 'actual.txt'), resourceLink, 'file');
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') {
        throw error;
      }
    }
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    runtime.beginTurn();
    await runtime.compose('$linked-skill', new AbortController().signal);
    assert.equal(await runtime.resolveActiveSkillRoot('linked-skill'), outside);
    const resource = runtime.getTools().find((tool) => tool.name === 'ReadSkillResource');
    if (await readFile(resourceLink, 'utf8').catch(() => undefined)) {
      const result = await resource.execute(
        { skill: 'linked-skill', path: 'references/linked.txt' },
        toolContext(workspace)
      );
      assert.match(result.content, /INSIDE LINK/);
    }
    const replacement = join(root, 'replacement');
    await writeSkill(root, 'replacement', 'replacement', 'REPLACEMENT');
    await rm(link, { recursive: true, force: true });
    await symlink(replacement, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(runtime.resolveActiveSkillRoot('linked-skill'), /changed since discovery/);
  });
});

test('project Skill symlinks are accepted only when their canonical target stays in the repository', async () => {
  await fixture(async ({ workspace, home }) => {
    const target = await writeSkill(
      join(workspace, 'vendor'),
      'project-link',
      'Repository local linked Skill',
      'PROJECT LINK BODY'
    );
    const source = join(workspace, '.agents', 'skills');
    await mkdir(source, { recursive: true });
    try {
      await symlink(
        target,
        join(source, 'project-link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        return;
      }
      throw error;
    }
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    const descriptor = runtime.inspectSkill('project-link');
    assert.equal(descriptor.source, 'project');
    assert.equal(descriptor.canonicalRootPath, target);
    const composed = await runtime.compose('$project-link', new AbortController().signal);
    assert.match(composed.message, /PROJECT LINK BODY/);
  });
});

test('Skill creation, validation, and isolated activation eval form a complete workflow', async () => {
  await fixture(async ({ workspace, home }) => {
    const created = await createSkill({
      name: 'created-demo',
      description: 'Created for validation',
      workspaceRoot: workspace,
      homeDirectory: home
    });
    assert.equal(created.rootPath, join(home, '.agents', 'skills', 'created-demo'));
    const validation = await validateSkillPath(created.rootPath);
    assert.equal(validation.ok, true, validation.errors.join('\n'));
    assert.match(await readFile(join(created.rootPath, 'SKILL.md'), 'utf8'), /TODO:/);

    const evalRoot = await writeSkill(
      join(home, '.agents', 'skills'),
      'eval-demo',
      'Use for direct workflow requests',
      'EVAL WORKFLOW'
    );
    await mkdir(join(evalRoot, 'evals'), { recursive: true });
    await writeFile(
      join(evalRoot, 'evals', 'activation.yaml'),
      [
        'schemaVersion: 1',
        'cases:',
        '  - id: direct',
        '    prompt: use the direct workflow',
        '    expect: activate',
        '  - id: unrelated',
        '    prompt: explain arrays',
        '    expect: not-activate'
      ].join('\n'),
      'utf8'
    );
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    const descriptor = runtime.inspectSkill('eval-demo');
    const providerFactory = () => {
      let calls = 0;
      return {
        async chat(request) {
          calls += 1;
          const prompt =
            request.messages.findLast((message) => message.role === 'user')?.content ?? '';
          if (calls === 1 && prompt.includes('direct workflow')) {
            return {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [
                  { id: 'activate-1', name: 'ActivateSkill', input: { name: 'eval-demo' } }
                ]
              },
              usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
            };
          }
          return {
            message: { role: 'assistant', content: 'done' },
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
          };
        },
        getInfo() {
          return {
            name: 'EvalFixture',
            type: 'test',
            model: 'eval-model',
            capabilities: { streaming: false, reasoningToggle: false }
          };
        }
      };
    };
    const report = await runSkillActivationEval({
      descriptor,
      workspaceRoot: workspace,
      homeDirectory: home,
      providerFactory,
      signal: new AbortController().signal
    });
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 0);
    assert.equal(report.infrastructureFailures, 0);
    assert.deepEqual(
      report.cases.map((result) => result.actual),
      ['activate', 'not-activate']
    );
    assert.equal('prompt' in report.cases[0], false);
  });
});

test('Skill authoring rejects conflicts and validation isolates malformed optional files', async () => {
  await fixture(async ({ workspace, home }) => {
    const bodyPath = join(workspace, 'body.md');
    await writeFile(bodyPath, 'CUSTOM BODY\n', 'utf8');
    const created = await createSkill({
      name: 'project-created',
      description: 'Project scoped Skill',
      scope: 'project',
      bodyFile: bodyPath,
      workspaceRoot: workspace,
      homeDirectory: home
    });
    assert.equal(created.rootPath, join(workspace, '.agents', 'skills', 'project-created'));
    assert.match(await readFile(join(created.rootPath, 'SKILL.md'), 'utf8'), /CUSTOM BODY/);
    await assert.rejects(
      createSkill({
        name: 'project-created',
        description: 'Do not overwrite',
        scope: 'project',
        workspaceRoot: workspace,
        homeDirectory: home
      }),
      /Refusing to overwrite/
    );
    await assert.rejects(
      createSkill({
        name: 'Invalid Name',
        description: 'invalid',
        workspaceRoot: workspace,
        homeDirectory: home
      }),
      /Skill name/
    );
    await assert.rejects(
      createSkill({
        name: 'empty-description',
        description: ' ',
        workspaceRoot: workspace,
        homeDirectory: home
      }),
      /description/
    );

    await writeFile(join(created.rootPath, 'agents', 'openai.yaml'), 'policy: [invalid', 'utf8');
    await mkdir(join(created.rootPath, 'evals'), { recursive: true });
    await writeFile(
      join(created.rootPath, 'evals', 'activation.yaml'),
      'schemaVersion: 1\ncases: []\n',
      'utf8'
    );
    const invalid = await validateSkillPath(created.rootPath);
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.some((error) => /openai|flow|policy/i.test(error)));
    assert.ok(invalid.errors.some((error) => /1 to 20 cases/.test(error)));
    const missing = await validateSkillPath(join(workspace, 'missing-skill'));
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.length > 0);

    const invalidUtf8Body = join(workspace, 'invalid-body.md');
    await writeFile(invalidUtf8Body, Buffer.from([0xff, 0xfe]));
    await assert.rejects(
      createSkill({
        name: 'invalid-body',
        description: 'Invalid UTF-8 body',
        bodyFile: invalidUtf8Body,
        workspaceRoot: workspace,
        homeDirectory: home
      }),
      /not valid UTF-8/
    );
    const oversizedBody = join(workspace, 'oversized-body.md');
    await writeFile(oversizedBody, Buffer.alloc(64 * 1024 + 1, 0x61));
    await assert.rejects(
      createSkill({
        name: 'oversized-body',
        description: 'Oversized body',
        bodyFile: oversizedBody,
        workspaceRoot: workspace,
        homeDirectory: home
      }),
      /no larger than 64 KiB/
    );

    const iconRoot = await writeSkill(
      join(home, '.agents', 'skills'),
      'icon-skill',
      'Icon validation fixture',
      'ICON BODY'
    );
    await mkdir(join(iconRoot, 'agents'), { recursive: true });
    await mkdir(join(iconRoot, 'assets'), { recursive: true });
    await writeFile(join(iconRoot, 'assets', 'small.svg'), '<svg/>', 'utf8');
    await writeFile(
      join(iconRoot, 'agents', 'openai.yaml'),
      'interface:\n  icon_small: assets/small.svg\n  icon_large: assets/missing.svg\n',
      'utf8'
    );
    const iconValidation = await validateSkillPath(iconRoot);
    assert.equal(iconValidation.ok, false);
    assert.ok(iconValidation.errors.some((error) => /does not exist/.test(error)));
  });
});

test('Skill activation eval classifies Provider failures and honors cancellation', async () => {
  await fixture(async ({ workspace, home }) => {
    const evalRoot = await writeSkill(
      join(home, '.agents', 'skills'),
      'failure-eval',
      'Activation failure fixture',
      'FAILURE EVAL'
    );
    await mkdir(join(evalRoot, 'evals'), { recursive: true });
    await writeFile(
      join(evalRoot, 'evals', 'activation.yaml'),
      'schemaVersion: 1\ncases:\n  - id: provider-failure\n    prompt: activate this\n    expect: activate\n',
      'utf8'
    );
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    const descriptor = runtime.inspectSkill('failure-eval');
    const report = await runSkillActivationEval({
      descriptor,
      workspaceRoot: workspace,
      homeDirectory: home,
      providerFactory() {
        return {
          async chat() {
            throw new Error('provider unavailable');
          },
          getInfo() {
            return {
              name: 'FailureFixture',
              type: 'test',
              model: 'failure-model',
              capabilities: { streaming: false, reasoningToggle: false }
            };
          }
        };
      },
      signal: new AbortController().signal
    });
    assert.equal(report.infrastructureFailures, 1);
    assert.equal(report.cases[0].passed, false);
    assert.ok(report.cases[0].infrastructureError);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runSkillActivationEval({
        descriptor,
        workspaceRoot: workspace,
        homeDirectory: home,
        providerFactory() {
          throw new Error('must not create provider');
        },
        signal: controller.signal
      }),
      /aborted|cancel/i
    );
  });
});

test('Skills CLI creates and validates a project Skill without contacting a Provider', async () => {
  await fixture(async ({ workspace, home }) => {
    const environment = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SYZZZ_CONFIG_DIR: join(home, '.syzzz-code')
    };
    const created = spawnSync(
      process.execPath,
      [
        cliPath,
        'skills',
        'create',
        'cli-created',
        '--scope',
        'project',
        '--description',
        'Created by the CLI',
        '--json'
      ],
      { cwd: workspace, env: environment, encoding: 'utf8' }
    );
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).explicitOnly, true);
    const validated = spawnSync(
      process.execPath,
      [cliPath, 'skills', 'validate', 'cli-created', '--json'],
      { cwd: workspace, env: environment, encoding: 'utf8' }
    );
    assert.equal(validated.status, 0, validated.stderr);
    const report = JSON.parse(validated.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.results[0].name, 'cli-created');
  });
});

test('Shell can use only an activated Skill cwd and includes it in approval', async () => {
  await fixture(async ({ workspace, home }) => {
    const skillRoot = await writeSkill(
      join(home, '.agents', 'skills'),
      'shell-skill',
      'Run an explicitly approved script',
      'Use Shell with this Skill directory when requested.'
    );
    const runtime = await TaskCompositionRuntime.create({
      workspaceRoot: workspace,
      homeDirectory: home,
      skills: skillsConfig
    });
    let calls = 0;
    let toolResult = '';
    const provider = {
      async chat(request) {
        calls += 1;
        if (calls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'shell-1',
                  name: 'Shell',
                  input: {
                    command: `"${process.execPath}" -e "process.stdout.write(process.cwd())"`,
                    workingDirectory: { type: 'skill', name: 'shell-skill' }
                  }
                }
              ]
            }
          };
        }
        toolResult = request.messages.findLast((message) => message.role === 'tool')?.content ?? '';
        return { message: { role: 'assistant', content: 'done' } };
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
      composition: runtime,
      workspaceRoot: workspace,
      audit: false
    });
    let approval;
    const response = await engine.chat('$shell-skill run it', {
      requestApproval(request) {
        approval = request;
        return Promise.resolve('allow-once');
      }
    });
    assert.equal(response, 'done');
    assert.match(approval.description, /Skill shell-skill/);
    assert.match(approval.preview, new RegExp(skillRoot.replaceAll('\\', '\\\\')));
    assert.match(toolResult, new RegExp(skillRoot.replaceAll('\\', '\\\\')));
  });
});
