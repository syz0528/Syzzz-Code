import type { UiLanguage } from './config.js';
import type { CommandCategory } from './interactive-commands.js';

export type ResolvedUiLanguage = 'zh-CN' | 'en';

const COMMAND_DESCRIPTIONS_ZH: Readonly<Record<string, string>> = {
  ask: '切换到只读问答模式，可在同一条命令后直接提交问题。',
  plan: '切换到只读规划模式，分析后输出实施计划。',
  code: '切换到代码模式，允许按权限策略执行修改。',
  status: '查看会话、模型、权限、Token 和上下文状态。',
  new: '新建会话，同时保留当前已保存会话。',
  resume: '恢复当前工作区中已保存的会话。',
  rename: '重命名当前会话。',
  save: '立即保存当前会话。',
  compact: '立即压缩当前会话上下文。',
  provider: '切换本地已配置且凭证可用的 Provider。',
  stream: '开启或关闭终端中的渐进式正文显示。',
  context: '查看上下文状态、重新加载指令或选择窗口预算。',
  skills: '发现、检查和管理 Agent Skills。',
  permissions: '查看或修改权限模式及其持久化范围。',
  extensions: '查看或重新加载完整扩展运行时。',
  mcp: '查看、重载或重新连接 MCP Server。',
  hooks: '查看或重新加载命令 Hooks。',
  agents: '查看或开关受限只读 Subagent。',
  trust: '信任当前工作区的项目 MCP 与 Hooks。',
  untrust: '撤销当前工作区的项目扩展信任。',
  model: '切换当前 Provider 中配置的模型。',
  history: '查看或管理当前工作区的输入历史。',
  'terminal-setup': '检查或安装安全的 Shift+Enter 终端键位映射。',
  language: '切换命令、上下文候选和本地界面描述语言。',
  help: '查看可用的交互命令。',
  exit: '退出当前交互会话。'
};

const CATEGORY_LABELS_ZH: Record<CommandCategory, string> = {
  work: '工作模式',
  session: '会话',
  runtime: '运行设置',
  extensions: '扩展',
  general: '常规'
};

const TUI_ACTIVITY_LABELS_ZH: Readonly<Record<string, string>> = {
  'Compacting context...': '正在压缩上下文...',
  'Rendering response...': '正在呈现回答...',
  'AskUser running': '正在等待用户回答',
  thinking: '思考中',
  sampling: '生成回答中',
  tools: '执行工具中',
  approval: '等待审批',
  compaction: '压缩上下文中',
  subagent: '子 Agent 工作中'
};

const TUI_PANEL_TEXT_ZH: Readonly<Record<string, string>> = {
  'Enable Full Access for this session?': '为本会话启用完全访问？',
  'Discard unsaved session changes?': '放弃尚未保存的会话变更？',
  'Resume session': '恢复会话',
  'Select model': '选择模型',
  'Select provider': '选择 Provider',
  'Select permission mode': '选择权限模式',
  'Trust project extensions for this workspace?': '信任此工作区的项目扩展？',
  'Clear workspace input history?': '清除当前工作区的输入历史？',
  'Skill description': 'Skill 描述',
  'The current session has unsaved changes.': '当前会话包含尚未保存的变更。'
};

export function resolveUiLanguage(language: UiLanguage): ResolvedUiLanguage {
  if (language !== 'auto') return language;
  const locale =
    process.env.LC_ALL ??
    process.env.LC_MESSAGES ??
    process.env.LANG ??
    Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh(?:[-_]|$)/iu.test(locale) ? 'zh-CN' : 'en';
}

export function localizeCommandDescription(
  name: string,
  fallback: string,
  language: ResolvedUiLanguage
): string {
  return language === 'zh-CN' ? (COMMAND_DESCRIPTIONS_ZH[name] ?? fallback) : fallback;
}

export function localizeCommandCategory(
  category: CommandCategory,
  fallback: string,
  language: ResolvedUiLanguage
): string {
  return language === 'zh-CN' ? CATEGORY_LABELS_ZH[category] : fallback;
}

export function localizeSuggestionDescription(
  id: string,
  fallback: string | undefined,
  language: ResolvedUiLanguage
): string | undefined {
  if (language !== 'zh-CN') return fallback;
  if (id.startsWith('context:')) return '工作区文件上下文';
  return fallback;
}

export function localizeTuiActivity(label: string, language: ResolvedUiLanguage): string {
  if (language !== 'zh-CN') return label;
  const translated = TUI_ACTIVITY_LABELS_ZH[label];
  if (translated) return translated;
  const running = /^(.*?)\s+running$/iu.exec(label);
  return running ? `${running[1]} 执行中` : label;
}

export function localizeTuiPanelText(text: string, language: ResolvedUiLanguage): string {
  return language === 'zh-CN' ? (TUI_PANEL_TEXT_ZH[text] ?? text) : text;
}
