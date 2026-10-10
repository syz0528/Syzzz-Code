import { createHash } from 'node:crypto';
import MiniSearch from 'minisearch';
import { z } from 'zod';
import { tokenizeRagText } from '../rag/tokenizer.js';
import type { SkillDescriptor, SkillDiscoveryPage } from './types.js';

// Categories may contain different intents; only aliases within a concept expand together.
const concepts = [
  ['testing', ['test', 'tests', 'testing', 'tdd', '测试', '回归', '单元测试']],
  ['testing', ['playwright']],
  ['testing', ['pytest']],
  ['review', ['review', 'audit', '审查', '审计', '代码评审']],
  ['debugging', ['debug', 'debugging', 'troubleshoot', '调试', '排障', '故障']],
  ['documentation', ['doc', 'docs', 'document', 'documents', 'documentation', '文档', '说明书']],
  ['documentation', ['readme']],
  ['frontend', ['frontend', 'ui', '界面', '前端']],
  ['frontend', ['react']],
  ['frontend', ['css']],
  ['data', ['data', '数据']],
  ['data', ['database', 'databases', '数据库']],
  ['data', ['sql']],
  ['data', ['rag', 'retrieval', '检索']],
  ['security', ['security', 'vulnerability', '安全', '漏洞']],
  ['delivery', ['deploy', 'deployment', '部署']],
  ['delivery', ['release', 'releases', '发布', '交付']],
  ['delivery', ['docker']],
  ['delivery', ['ci']],
  ['planning', ['plan', 'plans', 'planning', 'planned', '规划', '计划']],
  ['planning', ['interview', 'interviews', 'interviewing', 'grill', 'grilling', '访谈', '追问']],
  ['planning', ['question', 'questions', '提问']]
] as const;
const categoryNames = [...new Set(concepts.map(([name]) => name)), 'general'];
export const skillDiscoveryInputSchema = z
  .object({
    query: z.string().max(1000).optional(),
    category: z.enum(categoryNames as [string, ...string[]]).optional(),
    offset: z.number().int().min(0).max(2000).optional(),
    limit: z.number().int().min(1).max(8).optional(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional()
  })
  .strict();

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function words(text: string): string[] {
  return tokenizeRagText(text).filter((term) => Array.from(term).length >= 2);
}
function clean(text: string, maximum: number): string {
  return Array.from(
    text
      .replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  )
    .slice(0, maximum)
    .join('');
}
function hasAlias(text: string, terms: ReadonlySet<string>, alias: string): boolean {
  return /[^\x00-\x7f]/u.test(alias) ? text.includes(alias) : terms.has(alias);
}
function tags(text: string): string[] {
  const terms = new Set(words(text));
  const matches = concepts.filter(([, aliases]) =>
    aliases.some((alias) => hasAlias(text, terms, alias))
  );
  return matches.length ? [...new Set(matches.map(([name]) => name))] : ['general'];
}
function expand(query: string): string {
  const queryTerms = new Set(words(query));
  const aliases = concepts.flatMap(([, terms]) =>
    terms.some((term) => hasAlias(query, queryTerms, term)) ? [...terms] : []
  );
  return [query, ...aliases].join(' ');
}

export class SkillDiscoveryIndex {
  readonly revision: string;
  private readonly skills: SkillDescriptor[];
  private readonly index = new MiniSearch({
    fields: ['name', 'display', 'description', 'resources'],
    tokenize: words,
    searchOptions: { boost: { name: 5, display: 3, description: 2 }, prefix: true, fuzzy: false }
  });
  private readonly categoryMap = new Map<string, string[]>();

  constructor(skills: readonly SkillDescriptor[]) {
    this.skills = [...skills].sort((a, b) => compare(a.name, b.name));
    for (const skill of this.skills) {
      const description = `${skill.description} ${skill.interface.shortDescription}`;
      this.categoryMap.set(
        skill.name,
        tags(`${skill.name} ${skill.interface.displayName} ${description}`.toLowerCase())
      );
      this.index.add({
        id: skill.name,
        name: skill.name,
        display: skill.interface.displayName,
        description,
        resources: skill.resourceManifest.entries.join(' ')
      });
    }
    this.revision = createHash('sha256')
      .update(
        JSON.stringify({
          algorithm: 'concept-aliases-v2',
          skills: this.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            interface: skill.interface,
            source: skill.source,
            policy: skill.policy,
            dependencies: skill.dependencies,
            resources: skill.resourceManifest.entries
          }))
        })
      )
      .digest('hex');
  }

  overview(): Array<{ name: string; count: number }> {
    return categoryNames
      .map((name) => ({
        name,
        count: this.skills.filter((skill) => this.categoryMap.get(skill.name)?.includes(name))
          .length
      }))
      .filter(({ count }) => count > 0);
  }

  search(raw: unknown, active: ReadonlySet<string>, implicitAllowed: boolean): SkillDiscoveryPage {
    const input = skillDiscoveryInputSchema.parse(raw);
    if (input.revision && input.revision !== this.revision)
      throw new Error('Skill directory changed; restart discovery at offset 0 without revision');
    const query = (input.query ?? '').normalize('NFKC').trim().toLowerCase().replace(/^\$/u, '');
    const results = query ? this.index.search(expand(query)) : [];
    const scores = new Map(results.map(({ id, score }) => [String(id), score]));
    let matches = this.skills.filter(
      (skill) =>
        (!input.category || this.categoryMap.get(skill.name)?.includes(input.category)) &&
        (!query || skill.name === query || scores.has(skill.name))
    );
    if (query)
      matches = matches.sort(
        (a, b) =>
          Number(b.name === query) - Number(a.name === query) ||
          (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0) ||
          compare(a.name, b.name)
      );
    const offset = input.offset ?? 0;
    const page: SkillDiscoveryPage = {
      schemaVersion: 1,
      revision: this.revision,
      eligible: this.skills.length,
      matched: matches.length,
      offset,
      categories: this.overview(),
      candidates: [],
      byteLimited: false
    };
    for (const skill of matches.slice(offset, offset + (input.limit ?? 8))) {
      const candidate: SkillDiscoveryPage['candidates'][number] = {
        name: skill.name,
        displayName: clean(skill.interface.displayName, 80),
        description: clean(skill.description, 400),
        source: skill.source,
        categories: [...(this.categoryMap.get(skill.name) ?? ['general'])],
        invocation:
          implicitAllowed && skill.policy.allowImplicitInvocation
            ? 'explicit+implicit'
            : 'explicit-only',
        activeThisTurn: active.has(skill.name),
        resourceNames: skill.resourceManifest.entries.slice(0, 4).map((entry) => clean(entry, 100)),
        declaredDependencies: skill.dependencies.slice(0, 4).map(({ raw }) => clean(raw, 120)),
        dependencyStatus: 'not-checked',
        matchedBy: !query ? 'browse' : skill.name === query ? 'name' : 'lexical',
        ...(query ? { score: Math.round((scores.get(skill.name) ?? 0) * 1000) / 1000 } : {}),
        metadataTruncated:
          skill.description.length > 400 ||
          skill.interface.displayName.length > 80 ||
          skill.resourceManifest.entries.length > 4 ||
          skill.resourceManifest.entries.some((entry) => entry.length > 100) ||
          skill.resourceManifest.omittedEntries > 0 ||
          skill.dependencies.length > 4 ||
          skill.dependencies.some(({ raw }) => raw.length > 120)
      };
      page.candidates.push(candidate);
      if (Buffer.byteLength(JSON.stringify(page)) > 16 * 1024 - 64) {
        page.candidates.pop();
        page.byteLimited = true;
        break;
      }
    }
    if (offset + page.candidates.length < matches.length)
      page.nextOffset = offset + page.candidates.length;
    return page;
  }
}

export function formatSkillDiscovery(page: SkillDiscoveryPage, chinese = false): string {
  return [
    chinese
      ? 'Skill 本地发现（候选不代表已加载或执行）'
      : 'Local Skill discovery (candidates are not activations or execution)',
    `${chinese ? '可用/匹配/本页' : 'Eligible/matched/shown'}: ${page.eligible}/${page.matched}/${page.candidates.length}; revision: ${page.revision}`,
    ...page.candidates.map((skill) =>
      [
        `  ${skill.name} [${skill.source}] ${skill.invocation}${skill.activeThisTurn ? (chinese ? ' [本轮已加载]' : ' [active this turn]') : ''}`,
        `    ${skill.displayName}: ${skill.description}`,
        `    ${chinese ? '匹配依据' : 'Match'}: ${skill.matchedBy}${skill.score === undefined ? '' : `; lexical score=${skill.score}`}`,
        ...(skill.declaredDependencies.length
          ? [
              `    ${chinese ? '声明依赖，未检查' : 'Declared dependencies, not checked'}: ${skill.declaredDependencies.join(', ')}`
            ]
          : [])
      ].join('\n')
    ),
    ...(page.nextOffset === undefined
      ? []
      : [
          `${chinese ? '下一页' : 'Next page'}: offset=${page.nextOffset}; revision=${page.revision}`
        ]),
    chinese
      ? '没有匹配不等于不存在：换关键词或不带 query 分页浏览；模型须另行 ActivateSkill，用户可显式 $name。'
      : 'No match is not proof of absence: change keywords or browse without query. ActivateSkill loads the body separately; the user can request $name.'
  ].join('\n');
}
