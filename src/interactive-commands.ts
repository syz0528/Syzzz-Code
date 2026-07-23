import type {
  SuggestionItem,
  SuggestionProvider,
  SuggestionRequest
} from './terminal-input.js';

export interface CommandChoice {
  value: string;
  label?: string;
  description?: string;
  current?: boolean;
}

export type CommandExecutionResult = 'continue' | 'exit';

export interface CommandDefinition<Context> {
  name: string;
  aliases?: readonly string[];
  description: string;
  argumentHint?: string;
  isEnabled?: (context: Context) => boolean;
  choices?: (context: Context) => readonly CommandChoice[];
  execute(
    argument: string | undefined,
    context: Context,
    signal: AbortSignal
  ): Promise<CommandExecutionResult> | CommandExecutionResult;
}

export interface ParsedSlashCommand {
  name: string;
  argument?: string;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function commandScore(command: CommandDefinition<unknown>, query: string): number {
  const names = [command.name, ...(command.aliases ?? [])].map(normalizeName);
  if (!query) {
    return 0;
  }
  if (names.some(name => name === query)) {
    return 0;
  }
  const prefixIndex = names.findIndex(name => name.startsWith(query));
  if (prefixIndex !== -1) {
    return 10 + prefixIndex;
  }
  const substringIndex = names.findIndex(name => name.includes(query));
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }
  if (command.description.toLowerCase().includes(query)) {
    return 200;
  }
  return Number.POSITIVE_INFINITY;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export class CommandRegistry<Context> {
  private readonly commands: CommandDefinition<Context>[] = [];
  private readonly names = new Map<string, CommandDefinition<Context>>();

  register(command: CommandDefinition<Context>): void {
    const canonicalName = normalizeName(command.name);
    if (!/^[a-z][a-z0-9-]*$/.test(canonicalName)) {
      throw new Error(`Invalid command name: ${command.name}`);
    }

    const commandNames = [canonicalName, ...(command.aliases ?? []).map(normalizeName)];
    for (const name of commandNames) {
      if (!name || this.names.has(name)) {
        throw new Error(`Duplicate command name or alias: ${name}`);
      }
    }

    this.commands.push(command);
    for (const name of commandNames) {
      this.names.set(name, command);
    }
  }

  list(context: Context): readonly CommandDefinition<Context>[] {
    return this.commands.filter(command => command.isEnabled?.(context) ?? true);
  }

  resolve(name: string, context: Context): CommandDefinition<Context> | undefined {
    const command = this.names.get(normalizeName(name));
    return command && (command.isEnabled?.(context) ?? true)
      ? command
      : undefined;
  }

  search(query: string, context: Context): readonly CommandDefinition<Context>[] {
    const normalizedQuery = normalizeName(query);
    return this.list(context)
      .map(command => ({
        command,
        score: commandScore(command as CommandDefinition<unknown>, normalizedQuery)
      }))
      .filter(result => Number.isFinite(result.score))
      .sort((left, right) =>
        left.score - right.score || left.command.name.localeCompare(right.command.name)
      )
      .map(result => result.command);
  }

  closest(name: string, context: Context, maximum = 3): readonly string[] {
    const normalizedName = normalizeName(name);
    return this.list(context)
      .map(command => ({
        name: command.name,
        distance: Math.min(
          editDistance(normalizedName, normalizeName(command.name)),
          ...(command.aliases ?? []).map(alias =>
            editDistance(normalizedName, normalizeName(alias))
          )
        )
      }))
      .sort((left, right) => left.distance - right.distance ||
        left.name.localeCompare(right.name))
      .slice(0, maximum)
      .map(result => result.name);
  }
}

export function parseSlashCommand(value: string): ParsedSlashCommand | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return null;
  }
  const separator = trimmed.search(/\s/);
  if (separator === -1) {
    return { name: trimmed.slice(1) };
  }

  const argument = trimmed.slice(separator).trim();
  return {
    name: trimmed.slice(1, separator),
    ...(argument ? { argument } : {})
  };
}

export function createSlashSuggestionProvider<Context>(
  registry: CommandRegistry<Context>,
  getContext: () => Context
): SuggestionProvider {
  return {
    trigger: '/',
    match(value: string, cursor: number): SuggestionRequest | null {
      if (!value.startsWith('/') || value.startsWith('//') || cursor !== value.length) {
        return null;
      }
      return { query: value.slice(1) };
    },
    suggest(request: SuggestionRequest): readonly SuggestionItem[] {
      const context = getContext();
      const firstSpace = request.query.search(/\s/);
      if (firstSpace === -1) {
        return registry.search(request.query, context).map(command => {
          const hasChoices = Boolean(command.choices?.(context).length);
          return {
            id: `command:${command.name}`,
            label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
            description: command.description,
            insertText: `/${command.name}${hasChoices ? ' ' : ''}`,
            replaceStart: 0,
            replaceEnd: request.query.length + 1,
            submitOnAccept: !hasChoices
          };
        });
      }

      const name = request.query.slice(0, firstSpace);
      const argumentQuery = request.query.slice(firstSpace).trim().toLowerCase();
      const command = registry.resolve(name, context);
      const choices = command?.choices?.(context) ?? [];
      if (!command || choices.length === 0) {
        return [];
      }

      return choices
        .filter(choice => {
          const label = (choice.label ?? choice.value).toLowerCase();
          return !argumentQuery ||
            choice.value.toLowerCase().includes(argumentQuery) ||
            label.includes(argumentQuery);
        })
        .map(choice => ({
          id: `choice:${command.name}:${choice.value}`,
          label: `${choice.current ? '* ' : '  '}${choice.label ?? choice.value}`,
          description: choice.description,
          insertText: `/${command.name} ${choice.value}`,
          replaceStart: 0,
          replaceEnd: request.query.length + 1,
          submitOnAccept: true
        }));
    }
  };
}
