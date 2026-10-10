import type { InteractiveCommandContext } from './interactive.js';
import type { CommandDefinition, CommandHandlerResult } from './interactive-commands.js';
import { resolveUiLanguage } from './ui-language.js';
import { throwIfAborted } from './tools/abort.js';
import { MAX_PROJECT_MEMORY_TEXT_BYTES, type ProjectMemoryKind } from './project-memory.js';

export function createProjectMemoryCommand(
  priority: number
): CommandDefinition<InteractiveCommandContext> {
  return {
    name: 'memory',
    category: 'runtime',
    priority,
    description: 'Review and explicitly confirm workspace-scoped project memory.',
    argumentHint: '[status|list|add|edit|inspect|refresh|remove|clear|on|off] [key]',
    isEnabled: (context) => Boolean(context.engine.getCompositionRuntime?.()?.getProjectMemory?.()),
    choices: (context) => {
      const zh = resolveUiLanguage(context.uiLanguage) === 'zh-CN';
      return [
        {
          value: 'status',
          label: zh ? '状态' : 'Status',
          description: zh ? '查看当前工作区记忆状态' : 'Inspect workspace memory status'
        },
        {
          value: 'list',
          label: zh ? '查看记忆' : 'List',
          description: zh ? '查看内容、来源与失效状态' : 'Review entries, sources and freshness'
        },
        {
          value: 'add',
          label: zh ? '新增记忆' : 'Add',
          description: zh
            ? '经预览确认后保存，不自动执行'
            : 'Save only after preview and confirmation'
        },
        {
          value: 'on',
          label: zh ? '开启' : 'On',
          description: zh ? '允许注入有效记忆' : 'Enable valid memory guidance'
        },
        {
          value: 'off',
          label: zh ? '关闭' : 'Off',
          description: zh ? '停止注入，保留本地内容' : 'Stop injection, keep local entries'
        },
        {
          value: 'clear',
          label: zh ? '清空' : 'Clear',
          description: zh ? '确认后只清空当前工作区' : 'Confirm clearing only this workspace'
        }
      ];
    },
    async execute(argument, context, signal): Promise<CommandHandlerResult> {
      const store = context.engine.getCompositionRuntime?.()?.getProjectMemory?.();
      if (!store) throw new Error('Project memory is unavailable');
      const zh = resolveUiLanguage(context.uiLanguage) === 'zh-CN';
      const t = (en: string, cn: string) => (zh ? cn : en);
      const notice = (text: string) => context.interaction.notice({ tone: 'info', text });
      const [action = 'status', key, ...extra] = (argument?.trim() || 'status').split(/\s+/u);
      if (extra.length) throw new Error(t('Unexpected memory arguments', '记忆命令参数过多'));
      const snapshot = await store.snapshot(signal);
      if (action === 'status' || action === 'list' || action === 'inspect') {
        const usable = snapshot.entries.filter(
          (entry) => entry.freshness === 'fresh' || entry.freshness === 'confirmed'
        ).length;
        const healthLabel = zh
          ? { healthy: '正常', corrupt: '损坏', unavailable: '不可用' }[snapshot.health]
          : snapshot.health;
        const names = zh
          ? {
              command: '构建/检查命令',
              convention: '编码约定',
              decision: '架构决策',
              confirmed: '用户确认（无文件来源）',
              fresh: '来源有效',
              stale: '已过期',
              unavailable: '来源不可用'
            }
          : {
              command: 'Command',
              convention: 'Convention',
              decision: 'Decision',
              confirmed: 'User-confirmed (unsourced)',
              fresh: 'Fresh',
              stale: 'Stale',
              unavailable: 'Source unavailable'
            };
        const entries =
          action === 'inspect'
            ? snapshot.entries.filter((entry) => entry.key === key)
            : snapshot.entries;
        if (action === 'inspect' && !entries.length)
          throw new Error(t('Memory key not found', '未找到该记忆键'));
        notice(
          [
            t('Project memory', '项目记忆'),
            `${t('Injection', '上下文注入')}: ${snapshot.enabled ? t('on', '开启') : t('off', '关闭')}; ${t('Health', '存储健康')}: ${healthLabel}; ${t('Entries', '条目')}: ${snapshot.entries.length}/32`,
            `${t('Eligible', '有效')}: ${usable}; ${t('Stale/unavailable', '过期/来源不可用')}: ${snapshot.entries.length - usable}`,
            t(
              'Local plaintext; valid entries may be sent to the current Provider. No automatic execution.',
              '本地明文保存；有效条目可能发送给当前 Provider，不自动执行。'
            ),
            ...(action === 'status'
              ? []
              : entries.flatMap((entry) => [
                  `${entry.key} [${names[entry.kind]} / ${names[entry.freshness]}]`,
                  entry.text,
                  `${t('Source', '来源')}: ${entry.source?.path ?? t('explicit user confirmation', '用户显式确认')}; ${t('Confirmed', '确认时间')}: ${entry.confirmedAt}`
                ]))
          ].join('\n')
        );
        return 'continue';
      }
      if (snapshot.health !== 'healthy')
        throw new Error(
          t(
            'Memory storage is unavailable or corrupt; preserve and inspect the local file before retrying.',
            '记忆存储不可用或损坏；请先保留并检查本地文件，不会覆盖原文件。'
          )
        );
      if (action === 'on' || action === 'off') {
        if (key) throw new Error(t('No key is allowed for on/off', '开关操作不接受记忆键'));
        await store.setEnabled(action === 'on', signal);
        notice(
          t(`Project memory ${action}.`, `项目记忆注入已${action === 'on' ? '开启' : '关闭'}。`)
        );
        return 'continue';
      }
      if (action === 'remove' || action === 'clear') {
        const existing = snapshot.entries.find((entry) => entry.key === key);
        if ((action === 'remove' && !existing) || (action === 'clear' && key))
          throw new Error(t('Invalid memory target', '记忆目标无效'));
        const approved = await context.interaction.confirm(
          {
            title: t('Delete project memory?', '删除项目记忆？'),
            message: t('Only this workspace will be changed.', '只修改当前工作区的记忆。'),
            preview: existing
              ? `${existing.key}\n${existing.text}`
              : t(`${snapshot.entries.length} entries`, `${snapshot.entries.length} 个条目`),
            confirmToken: 'y'
          },
          signal
        );
        throwIfAborted(signal);
        if (approved) {
          await store.remove(action === 'clear' ? undefined : key, snapshot.revision, true, signal);
          notice(t('Project memory deleted.', '项目记忆已删除。'));
        }
        return 'continue';
      }
      if (!['add', 'edit', 'refresh'].includes(action))
        throw new Error(
          t(
            'Use /memory status|list|add|edit|inspect|refresh|remove|clear|on|off',
            '用法：/memory status|list|add|edit|inspect|refresh|remove|clear|on|off'
          )
        );
      const existing = snapshot.entries.find((entry) => entry.key === key);
      if (action !== 'add' && !existing)
        throw new Error(t('Memory key not found', '未找到该记忆键'));
      const targetKey =
        key ??
        (await context.interaction.textInput(
          {
            title: t('Memory key', '记忆键'),
            message: t(
              'Use a-z, digits, hyphens or underscores; start with a letter.',
              '使用英文字母、数字、短横线或下划线，以字母开头。'
            ),
            maximumCharacters: 48
          },
          signal
        ));
      if (targetKey === undefined) return 'continue';
      if (action === 'add' && snapshot.entries.some((entry) => entry.key === targetKey))
        throw new Error(t('Key exists; use /memory edit', '记忆键已存在，请使用 /memory edit'));
      const kind =
        existing?.kind ??
        (await context.interaction.select(
          {
            title: t('Memory kind', '记忆类型'),
            choices: [
              { value: 'command', label: t('Build/check command', '构建/检查命令') },
              { value: 'convention', label: t('Coding convention', '编码约定') },
              { value: 'decision', label: t('Architecture decision', '架构决策') }
            ]
          },
          signal
        ));
      if (!kind) return 'continue';
      const text =
        action === 'refresh'
          ? existing?.text
          : await context.interaction.textInput(
              {
                title: t('Memory content', '记忆内容'),
                message: [
                  existing?.text,
                  t(
                    'Do not save credentials or sensitive content. Limit: 1 KiB UTF-8.',
                    '不要保存凭证或敏感资料；上限为 1 KiB UTF-8。'
                  )
                ]
                  .filter(Boolean)
                  .join('\n'),
                maximumCharacters: MAX_PROJECT_MEMORY_TEXT_BYTES
              },
              signal
            );
      if (text === undefined) return 'continue';
      const sourcePath =
        action === 'refresh'
          ? existing?.source?.path
          : await context.interaction.textInput(
              {
                title: t('Source file (optional)', '来源文件（可选）'),
                message: t(
                  'Relative workspace path; empty means user-confirmed without a file. Changing or losing it invalidates the memory.',
                  '输入工作区相对路径；留空表示仅由用户确认。文件变更或丢失后，该记忆失效。'
                ),
                maximumCharacters: 512
              },
              signal
            );
      if (action !== 'refresh' && sourcePath === undefined) return 'continue';
      const prepared = await store.prepare(
        {
          key: targetKey,
          kind: kind as ProjectMemoryKind,
          text,
          ...(sourcePath ? { sourcePath } : {})
        },
        signal
      );
      // The initial view and the approved preview must refer to the same revision.
      if (prepared.revision !== snapshot.revision)
        throw new Error(t('Memory changed; review again', '记忆已变化，请重新审阅'));
      const approved = await context.interaction.confirm(
        {
          title: t('Save confirmed project memory?', '保存已确认的项目记忆？'),
          message: t(
            'Local plaintext; valid guidance may be sent to the current Provider. This grants no permission and executes nothing.',
            '本地明文保存；有效约定可能发送给当前 Provider。不授予权限，也不会执行命令。'
          ),
          preview: `${prepared.entry.key} [${prepared.entry.kind}]\n${prepared.entry.text}\n${t('Source', '来源')}: ${prepared.entry.source?.path ?? t('user confirmation', '用户确认')}`,
          confirmToken: 'y'
        },
        signal
      );
      throwIfAborted(signal);
      if (approved) {
        await store.save(prepared, true, signal);
        notice(
          snapshot.enabled
            ? t(
                'Project memory saved; applies to the next request.',
                '项目记忆已保存，下次请求生效。'
              )
            : t(
                'Project memory saved; injection remains off.',
                '项目记忆已保存；注入仍关闭，可用 /memory on 开启。'
              )
        );
      }
      return 'continue';
    }
  };
}
