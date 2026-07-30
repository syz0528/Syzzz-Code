import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandRegistry,
  createSlashSuggestionProvider,
  parseSlashCommand
} from '../dist/interactive-commands.js';

function command(name, options = {}) {
  return {
    name,
    category: 'general',
    priority: 100,
    description: `${name} command`,
    execute() {
      return 'continue';
    },
    ...options
  };
}

test('command registry resolves aliases and rejects duplicate names', () => {
  const registry = new CommandRegistry();
  registry.register(command('help', { aliases: ['?'] }));

  assert.equal(registry.resolve('HELP', {}).name, 'help');
  assert.equal(registry.resolve('?', {}).name, 'help');
  assert.throws(
    () => registry.register(command('other', { aliases: ['help'] })),
    /Duplicate command name or alias/
  );
  assert.throws(
    () => registry.register(command('bad-category', { category: 'unknown' })),
    /Invalid command category/
  );
  assert.throws(
    () => registry.register(command('bad-priority', { priority: -1 })),
    /Invalid command priority/
  );
});

test('slash parsing keeps commands local and leaves double slash escaped', () => {
  assert.deepEqual(parseSlashCommand('/model model-b'), {
    name: 'model',
    argument: 'model-b'
  });
  assert.deepEqual(parseSlashCommand('  /help  '), { name: 'help' });
  assert.equal(parseSlashCommand('//literal'), null);
  assert.equal(parseSlashCommand('ordinary message'), null);
});

test('slash suggestions expose commands and dynamic current choices', async () => {
  const context = { streamOutput: true };
  const registry = new CommandRegistry();
  registry.register(
    command('stream', {
      category: 'runtime',
      priority: 80,
      argumentHint: '[on|off]',
      choices(current) {
        return [
          { value: 'on', current: current.streamOutput },
          { value: 'off', current: !current.streamOutput }
        ];
      }
    })
  );
  registry.register(
    command('help', {
      category: 'general',
      priority: 140
    })
  );
  registry.register(
    command('plan', {
      category: 'work',
      priority: 20
    })
  );
  registry.register(
    command('ask', {
      category: 'work',
      priority: 10
    })
  );
  const provider = createSlashSuggestionProvider(registry, () => context);

  const rootRequest = provider.match('/', 1);
  assert.ok(rootRequest);
  const root = await provider.suggest(rootRequest, new AbortController().signal);
  assert.deepEqual(
    root.map((item) => item.id),
    ['command:ask', 'command:plan', 'command:stream', 'command:help']
  );
  assert.match(root[0].description, /^Work modes · /);
  assert.equal(root.find((item) => item.id === 'command:stream').submitOnAccept, false);

  const choiceRequest = provider.match('/stream ', 8);
  const choices = await provider.suggest(choiceRequest, new AbortController().signal);
  assert.match(choices[0].label, /^\* on$/);
  assert.equal(choices[0].insertText, '/stream on');
  assert.equal(choices[0].submitOnAccept, true);

  context.streamOutput = false;
  const updated = await provider.suggest(choiceRequest, new AbortController().signal);
  assert.match(updated[1].label, /^\* off$/);
});

test('disabled commands are hidden and typo candidates stay bounded', () => {
  const registry = new CommandRegistry();
  registry.register(command('permissions', { priority: 50 }));
  registry.register(command('model', { priority: 60 }));
  registry.register(command('hidden', { isEnabled: (context) => context.enabled }));

  assert.equal(registry.resolve('hidden', { enabled: false }), undefined);
  assert.deepEqual(
    registry.search('', { enabled: false }).map((item) => item.name),
    ['permissions', 'model']
  );
  assert.deepEqual(registry.closest('permisisons', { enabled: false }, 1), ['permissions']);
});
