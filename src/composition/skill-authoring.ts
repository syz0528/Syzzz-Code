import { lstat, mkdir, open, readFile, realpath, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { stringify } from 'yaml';
import {
  parseSkillActivationEval,
  parseSkillDocument,
  parseSkillOpenAiMetadata,
  SKILL_NAME_PATTERN
} from './skill-format.js';
import type { SkillActivationEvalV1, SkillDescriptor } from './types.js';

const MAX_SKILL_BODY_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_VALIDATION_FILES = 2_000;

export interface SkillCreationResult {
  name: string;
  scope: 'user' | 'project';
  rootPath: string;
  explicitOnly: boolean;
}

export interface SkillValidationResult {
  name?: string;
  path: string;
  canonicalPath?: string;
  ok: boolean;
  warnings: string[];
  errors: string[];
  resourceFiles: number;
  activationCases: number;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createSkill(options: {
  name: string;
  description: string;
  scope?: 'user' | 'project';
  bodyFile?: string;
  workspaceRoot: string;
  homeDirectory?: string;
}): Promise<SkillCreationResult> {
  const name = options.name.toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name) || name.endsWith('-') || name.includes('--')) {
    throw new Error('Skill name must use 1-64 lowercase letters, digits, or hyphens');
  }
  const description = options.description.trim();
  if (!description || [...description].length > 1_024) {
    throw new Error('Skill description must contain 1 to 1024 characters');
  }
  const scope = options.scope ?? 'user';
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const parent =
    scope === 'user'
      ? join(homeDirectory, '.agents', 'skills')
      : join(resolve(options.workspaceRoot), '.agents', 'skills');
  const rootPath = join(parent, name);
  let body =
    'TODO: Replace this placeholder with the Skill workflow, constraints, and expected outputs.\n';
  if (options.bodyFile) {
    const bodyPath = resolve(options.bodyFile);
    const info = await stat(bodyPath);
    if (!info.isFile() || info.size > MAX_SKILL_BODY_BYTES) {
      throw new Error('Skill body file must be a regular UTF-8 file no larger than 64 KiB');
    }
    body = decodeUtf8(await readFile(bodyPath), bodyPath).trimEnd() + '\n';
  }
  const skillContent = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
  if (Buffer.byteLength(skillContent, 'utf8') > MAX_SKILL_BODY_BYTES) {
    throw new Error('Generated SKILL.md exceeds 64 KiB');
  }
  const metadata = stringify({
    interface: {
      display_name: name,
      short_description: description
    },
    policy: {
      allow_implicit_invocation: false
    }
  });
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    await mkdir(rootPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing Skill directory: ${rootPath}`);
    }
    throw error;
  }
  try {
    await mkdir(join(rootPath, 'agents'), { mode: 0o700 });
    await writeExclusive(join(rootPath, 'SKILL.md'), skillContent);
    await writeExclusive(join(rootPath, 'agents', 'openai.yaml'), metadata);
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true });
    throw error;
  }
  return { name, scope, rootPath, explicitOnly: true };
}

async function validateResourceTree(canonicalRoot: string): Promise<{
  files: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let files = 0;
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (path === join(canonicalRoot, 'SKILL.md')) {
        continue;
      }
      files += 1;
      if (files > MAX_VALIDATION_FILES) {
        errors.push(`Skill validation exceeds ${MAX_VALIDATION_FILES} files`);
        return { files, errors };
      }
      if (entry.isSymbolicLink()) {
        try {
          const target = await realpath(path);
          if (!isWithin(canonicalRoot, target)) {
            errors.push(`Resource symlink escapes Skill root: ${relative(canonicalRoot, path)}`);
          }
        } catch (error) {
          errors.push(
            `Cannot resolve resource symlink ${relative(canonicalRoot, path)}: ${String(error)}`
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (!entry.isFile()) {
        errors.push(`Resource is not a regular file: ${relative(canonicalRoot, path)}`);
      }
    }
  }
  return { files, errors };
}

export async function validateSkillPath(path: string): Promise<SkillValidationResult> {
  const rootPath = resolve(path);
  const warnings: string[] = [];
  const errors: string[] = [];
  let name: string | undefined;
  let canonicalPath: string | undefined;
  let activationCases = 0;
  let resourceFiles = 0;
  try {
    const rootInfo = await lstat(rootPath);
    if (!rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) {
      throw new Error('Skill path must be a directory or directory symlink');
    }
    canonicalPath = await realpath(rootPath);
    const skillPath = join(rootPath, 'SKILL.md');
    const skillInfo = await stat(skillPath);
    if (!skillInfo.isFile() || skillInfo.size > MAX_SKILL_BODY_BYTES) {
      throw new Error('SKILL.md must be a regular UTF-8 file no larger than 64 KiB');
    }
    const parsed = parseSkillDocument(
      decodeUtf8(await readFile(skillPath), skillPath),
      basename(rootPath)
    );
    name = parsed.name;
    warnings.push(
      ...parsed.unsupportedFields.map(
        (field) => `${field} is unsupported and grants no authorization`
      )
    );
    const metadataPath = join(rootPath, 'agents', 'openai.yaml');
    try {
      const metadataInfo = await stat(metadataPath);
      if (!metadataInfo.isFile() || metadataInfo.size > MAX_METADATA_BYTES) {
        throw new Error('agents/openai.yaml must be a regular file no larger than 32 KiB');
      }
      const metadata = parseSkillOpenAiMetadata(
        decodeUtf8(await readFile(metadataPath), metadataPath)
      );
      warnings.push(
        ...metadata.dependencies.map(
          (dependency) => `MCP dependency ${dependency.raw} is diagnostic only`
        )
      );
      for (const icon of [metadata.interface?.iconSmall, metadata.interface?.iconLarge]) {
        if (!icon) {
          continue;
        }
        const iconPath = resolve(rootPath, icon);
        let resolvedIcon: string;
        try {
          resolvedIcon = await realpath(iconPath);
        } catch {
          errors.push(`Metadata icon does not exist: ${icon}`);
          continue;
        }
        if (!isWithin(canonicalPath, resolvedIcon) || !(await stat(resolvedIcon)).isFile()) {
          errors.push(`Metadata icon escapes the Skill or is not a file: ${icon}`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const evalPath = join(rootPath, 'evals', 'activation.yaml');
    try {
      const evalInfo = await stat(evalPath);
      if (!evalInfo.isFile() || evalInfo.size > MAX_METADATA_BYTES) {
        throw new Error('evals/activation.yaml must be a regular file no larger than 32 KiB');
      }
      activationCases = parseSkillActivationEval(decodeUtf8(await readFile(evalPath), evalPath))
        .cases.length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const resources = await validateResourceTree(canonicalPath);
    resourceFiles = resources.files;
    errors.push(...resources.errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    ...(name ? { name } : {}),
    path: rootPath,
    ...(canonicalPath ? { canonicalPath } : {}),
    ok: errors.length === 0,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    resourceFiles,
    activationCases
  };
}

export async function validateSkillDescriptors(
  descriptors: readonly SkillDescriptor[]
): Promise<SkillValidationResult[]> {
  const roots = [
    ...new Map(descriptors.map((descriptor) => [descriptor.rootPath, descriptor.rootPath])).values()
  ];
  return await Promise.all(roots.map(async (root) => await validateSkillPath(root)));
}

export async function readSkillActivationEval(
  descriptor: SkillDescriptor
): Promise<SkillActivationEvalV1> {
  const path = join(descriptor.rootPath, 'evals', 'activation.yaml');
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_METADATA_BYTES) {
    throw new Error('evals/activation.yaml must be a regular file no larger than 32 KiB');
  }
  return parseSkillActivationEval(decodeUtf8(await readFile(path), path));
}
