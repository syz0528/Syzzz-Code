import type { SuggestionItem, SuggestionProvider, SuggestionRequest } from '../terminal-input.js';
import { listWorkspaceFiles } from '../tools/search-tools.js';
import type { TaskCompositionRuntimeLike } from './types.js';

interface ContextSuggestionRequest extends SuggestionRequest {
  replaceStart: number;
  replaceEnd: number;
  quoted: boolean;
}

function findContextToken(value: string, cursor: number): ContextSuggestionRequest | null {
  if (cursor !== value.length) {
    return null;
  }
  for (let index = cursor - 1; index >= 0; index -= 1) {
    if (value[index] !== '@') {
      continue;
    }
    if (value[index - 1] === '@' || value[index + 1] === '@') {
      continue;
    }
    const previous = index === 0 ? '' : value[index - 1];
    if (previous && !/\s|[([{,:;]/.test(previous)) {
      continue;
    }
    const token = value.slice(index + 1, cursor);
    if (!token.startsWith('"') && /\s/.test(token)) {
      return null;
    }
    if (token.startsWith('"') && token.slice(1).includes('"')) {
      return null;
    }
    return {
      query: token.startsWith('"') ? token.slice(1) : token,
      replaceStart: index,
      replaceEnd: cursor,
      quoted: token.startsWith('"')
    };
  }
  return null;
}

export function createContextSuggestionProvider(
  runtime: TaskCompositionRuntimeLike
): SuggestionProvider {
  return {
    trigger: '@',
    match: findContextToken,
    async suggest(request: SuggestionRequest, signal: AbortSignal): Promise<SuggestionItem[]> {
      const contextRequest = request as ContextSuggestionRequest;
      const listed = await listWorkspaceFiles(runtime.workspaceRoot, '.', '**/*', signal);
      const query = contextRequest.query.toLowerCase();
      const candidates = new Set(listed.paths);
      for (const path of listed.paths) {
        const segments = path.split('/');
        for (let index = 1; index < segments.length; index += 1) {
          candidates.add(`${segments.slice(0, index).join('/')}/`);
        }
      }
      return [...candidates]
        .sort((left, right) => left.localeCompare(right))
        .filter((path) => !query || path.toLowerCase().includes(query))
        .slice(0, 100)
        .map((path) => {
          const quoted = contextRequest.quoted || /\s/.test(path);
          return {
            id: `context:${path}`,
            label: `@${path}`,
            description: 'Workspace file context',
            insertText: quoted ? `@"${path}"` : `@${path}`,
            replaceStart: contextRequest.replaceStart,
            replaceEnd: contextRequest.replaceEnd
          };
        });
    }
  };
}

export function createSkillSuggestionProvider(
  runtime: TaskCompositionRuntimeLike
): SuggestionProvider {
  return {
    trigger: '$',
    match(value: string, cursor: number): SuggestionRequest | null {
      if (cursor !== value.length) {
        return null;
      }
      const leadingWhitespace = /^\s*/.exec(value)?.[0] ?? '';
      const rest = value.slice(leadingWhitespace.length);
      if (!rest.startsWith('$') || rest.startsWith('$$') || /\s/.test(rest)) {
        return null;
      }
      return { query: rest.slice(1) };
    },
    suggest(request: SuggestionRequest): SuggestionItem[] {
      const query = request.query.toLowerCase();
      return runtime
        .listSkills()
        .filter((skill) => !skill.shadowed && skill.enabled)
        .filter(
          (skill) =>
            !query ||
            skill.name.includes(query) ||
            skill.interface.displayName.toLowerCase().includes(query) ||
            skill.interface.shortDescription.toLowerCase().includes(query)
        )
        .map((skill) => {
          const source =
            skill.source === 'project'
              ? 'project'
              : skill.source === 'user-shared'
                ? 'user'
                : 'legacy';
          return {
            id: `skill:${skill.name}`,
            label:
              `$${skill.name}` +
              `${skill.interface.displayName === skill.name ? '' : `  ${skill.interface.displayName}`}` +
              ` [${source}]`,
            description: skill.interface.shortDescription,
            insertText: `$${skill.name} `,
            replaceStart: 0,
            replaceEnd: request.query.length + 1
          };
        });
    }
  };
}
