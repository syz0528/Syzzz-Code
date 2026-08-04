import { parseDocument } from 'yaml';
import type { SkillActivationEvalV1, SkillOpenAiMetadata } from './types.js';

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ParsedSkillFile {
  name: string;
  description: string;
  unsupportedFields: string[];
}

function parseYamlObject(content: string, label: string): Record<string, unknown> {
  const document = parseDocument(content.replace(/^\uFEFF/, ''), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid ${label}: ${document.errors[0].message}`);
  }
  const value = document.toJS() as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  maximumCharacters: number
): string | undefined {
  const key = keys.find((candidate) => record[candidate] !== undefined);
  if (!key) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if ([...normalized].length > maximumCharacters) {
    throw new Error(`${label} must not exceed ${maximumCharacters} characters`);
  }
  return normalized;
}

export function parseSkillDocument(content: string, directoryName?: string): ParsedSkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.replace(/^\uFEFF/, ''));
  if (!match) {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }
  const record = parseYamlObject(match[1], 'Skill frontmatter');
  if (
    typeof record.name !== 'string' ||
    !SKILL_NAME_PATTERN.test(record.name) ||
    record.name.endsWith('-') ||
    record.name.includes('--')
  ) {
    throw new Error(
      'Skill name must be 1-64 lowercase letters, digits, or hyphens, without leading, trailing, or consecutive hyphens'
    );
  }
  if (directoryName && record.name !== directoryName) {
    throw new Error(`Skill name ${record.name} must match its directory ${directoryName}`);
  }
  if (typeof record.description !== 'string' || !record.description.trim()) {
    throw new Error('Skill description must be a non-empty string up to 1024 characters');
  }
  const description = record.description.trim();
  const descriptionCharacters = [...description].length;
  if (descriptionCharacters > 1_024) {
    throw new Error(
      `Skill description must be a non-empty string up to 1024 characters (received ${descriptionCharacters})`
    );
  }
  const supported = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
  return {
    name: record.name,
    description,
    unsupportedFields: Object.keys(record).filter((key) => !supported.has(key))
  };
}

export function parseSkillOpenAiMetadata(content: string): SkillOpenAiMetadata {
  const root = parseYamlObject(content, 'agents/openai.yaml');
  const interfaceValue = root.interface;
  let interface_: SkillOpenAiMetadata['interface'];
  if (interfaceValue !== undefined) {
    if (!interfaceValue || typeof interfaceValue !== 'object' || Array.isArray(interfaceValue)) {
      throw new Error('agents/openai.yaml interface must be an object');
    }
    const record = interfaceValue as Record<string, unknown>;
    const brandColor = optionalString(record, ['brand_color', 'brandColor'], 'brand color', 32);
    if (brandColor && !/^#[0-9a-f]{6}$/i.test(brandColor)) {
      throw new Error('brand color must use #RRGGBB');
    }
    interface_ = {
      ...(optionalString(record, ['display_name', 'displayName'], 'display name', 128)
        ? {
            displayName: optionalString(
              record,
              ['display_name', 'displayName'],
              'display name',
              128
            )
          }
        : {}),
      ...(optionalString(
        record,
        ['short_description', 'shortDescription'],
        'short description',
        256
      )
        ? {
            shortDescription: optionalString(
              record,
              ['short_description', 'shortDescription'],
              'short description',
              256
            )
          }
        : {}),
      ...(optionalString(record, ['icon_small', 'iconSmall'], 'small icon', 512)
        ? {
            iconSmall: optionalString(record, ['icon_small', 'iconSmall'], 'small icon', 512)
          }
        : {}),
      ...(optionalString(record, ['icon_large', 'iconLarge'], 'large icon', 512)
        ? {
            iconLarge: optionalString(record, ['icon_large', 'iconLarge'], 'large icon', 512)
          }
        : {}),
      ...(brandColor ? { brandColor } : {}),
      ...(optionalString(record, ['default_prompt', 'defaultPrompt'], 'default prompt', 4_096)
        ? {
            defaultPrompt: optionalString(
              record,
              ['default_prompt', 'defaultPrompt'],
              'default prompt',
              4_096
            )
          }
        : {})
    };
  }

  const policyValue = root.policy;
  let policy: SkillOpenAiMetadata['policy'];
  if (policyValue !== undefined) {
    if (!policyValue || typeof policyValue !== 'object' || Array.isArray(policyValue)) {
      throw new Error('agents/openai.yaml policy must be an object');
    }
    const record = policyValue as Record<string, unknown>;
    const implicit = record.allow_implicit_invocation ?? record.allowImplicitInvocation;
    if (implicit !== undefined && typeof implicit !== 'boolean') {
      throw new Error('allow_implicit_invocation must be boolean');
    }
    policy = implicit === undefined ? {} : { allowImplicitInvocation: implicit };
  }

  const dependencyRoot = root.dependencies;
  let dependencyValues: unknown[] = [];
  if (Array.isArray(dependencyRoot)) {
    dependencyValues = dependencyRoot;
  } else if (dependencyRoot && typeof dependencyRoot === 'object') {
    const tools = (dependencyRoot as Record<string, unknown>).tools;
    if (tools !== undefined && !Array.isArray(tools)) {
      throw new Error('agents/openai.yaml dependencies.tools must be an array');
    }
    dependencyValues = (tools as unknown[] | undefined) ?? [];
  } else if (dependencyRoot !== undefined) {
    throw new Error('agents/openai.yaml dependencies must be an object or array');
  }
  if (dependencyValues.length > 50) {
    throw new Error('agents/openai.yaml supports at most 50 dependencies');
  }
  const dependencies: SkillOpenAiMetadata['dependencies'] = [];
  for (const [index, value] of dependencyValues.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`dependency ${index + 1} must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (record.type !== 'mcp') {
      continue;
    }
    const rawValue = record.value ?? record.tool;
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      throw new Error(`MCP dependency ${index + 1} requires value or tool`);
    }
    const raw = rawValue.trim();
    const separator = raw.includes('__') ? '__' : raw.includes('/') ? '/' : undefined;
    const [server, tool] = separator ? raw.split(separator, 2) : [undefined, raw];
    dependencies.push({
      type: 'mcp',
      ...(server ? { server } : {}),
      ...(tool ? { tool } : {}),
      raw
    });
  }
  return {
    ...(interface_ ? { interface: interface_ } : {}),
    ...(policy ? { policy } : {}),
    dependencies
  };
}

export function parseSkillActivationEval(content: string): SkillActivationEvalV1 {
  const root = parseYamlObject(content, 'Skill activation eval');
  if (root.schemaVersion !== 1 || !Array.isArray(root.cases)) {
    throw new Error('Skill activation eval requires schemaVersion 1 and a cases array');
  }
  if (root.cases.length < 1 || root.cases.length > 20) {
    throw new Error('Skill activation eval must contain 1 to 20 cases');
  }
  const ids = new Set<string>();
  const cases = root.cases.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Skill activation eval case ${index + 1} must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.id)) {
      throw new Error(`Skill activation eval case ${index + 1} has an invalid id`);
    }
    if (ids.has(record.id)) {
      throw new Error(`Skill activation eval contains duplicate id ${record.id}`);
    }
    ids.add(record.id);
    if (
      typeof record.prompt !== 'string' ||
      !record.prompt.trim() ||
      Buffer.byteLength(record.prompt, 'utf8') > 4 * 1024
    ) {
      throw new Error(`Skill activation eval case ${record.id} prompt exceeds 4 KiB or is empty`);
    }
    if (record.expect !== 'activate' && record.expect !== 'not-activate') {
      throw new Error(`Skill activation eval case ${record.id} has an invalid expectation`);
    }
    const expectation: 'activate' | 'not-activate' = record.expect;
    return {
      id: record.id,
      prompt: record.prompt,
      expect: expectation
    };
  });
  return { schemaVersion: 1, cases };
}
