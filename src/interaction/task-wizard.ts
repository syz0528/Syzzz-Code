import { stripVTControlCharacters } from 'node:util';
import {
  TaskDelivery,
  formatTaskDelivery,
  parseTaskDeliveryContract,
  parseTaskPath,
  parseTaskRequirement,
  type TaskDeliveryContract,
  type TaskDeliverySnapshot
} from '../task-delivery.js';
import type { InteractionPort } from './types.js';

type Requirement = TaskDeliveryContract['requirements'][number];
type Language = 'zh' | 'en';
class DraftCancelled extends Error {}
class DraftValidationError extends Error {}

function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x09\x0b-\x1f\x7f]/gu, '');
}

function validate<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new DraftValidationError();
  }
}

export function formatTaskRequirement(requirement: Requirement, language: Language): string {
  const zh = language === 'zh';
  const lines = [`${requirement.id}: ${requirement.label}`];
  if (requirement.kind === 'check') {
    lines.push(`${zh ? '检查命令' : 'Check command'}: ${requirement.command}`);
    lines.push(`${zh ? '依赖文件' : 'Dependencies'}: ${requirement.paths.join(', ')}`);
    lines.push(
      `${zh ? '成功输出标记' : 'Output markers'}: ${requirement.outputContains?.join(', ') || '-'}`
    );
  } else {
    lines.push(`${zh ? '文件' : 'File'}: ${requirement.path}`);
    if (requirement.kind === 'artifact')
      lines.push(
        `${zh ? '正文标记' : 'Content markers'}: ${requirement.contains?.join(', ') || '-'}`
      );
  }
  return terminalText(lines.join('\n'));
}

export async function createTaskDraft(
  port: InteractionPort,
  root: string,
  language: Language,
  signal: AbortSignal
): Promise<TaskDeliveryContract | undefined> {
  const text = (en: string, zh: string) => (language === 'zh' ? zh : en);
  const choose = async (title: string, choices: Array<{ value: string; label: string }>) => {
    signal.throwIfAborted();
    const value = await port.select(
      {
        title: terminalText(title),
        choices: choices.map((choice) => ({ ...choice, label: terminalText(choice.label) }))
      },
      signal
    );
    signal.throwIfAborted();
    if (value === undefined) throw new DraftCancelled();
    return value;
  };
  const input = async (
    title: string,
    maximumCharacters: number,
    current = '',
    message?: string
  ) => {
    signal.throwIfAborted();
    const currentPreview =
      Array.from(terminalText(current)).slice(0, 48).join('') + (current.length > 48 ? '...' : '');
    const value = await port.textInput(
      {
        title,
        maximumCharacters,
        message: [
          message,
          current
            ? text(
                `Current: ${currentPreview}; Enter keeps it.`,
                `当前：${currentPreview}；直接 Enter 保留。`
              )
            : undefined
        ]
          .filter(Boolean)
          .join('\n')
      },
      signal
    );
    signal.throwIfAborted();
    if (value === undefined) throw new DraftCancelled();
    return value.trim() || current;
  };
  const list = async (title: string, original: string[], maximum: number, paths: boolean) => {
    const values = [...original];
    for (;;) {
      const action = await choose(title, [
        ...(values.length < maximum ? [{ value: 'add', label: text('Add', '新增') }] : []),
        ...values.map((value, index) => ({
          value: `remove:${index}`,
          label: text(`Remove: ${value}`, `移除：${value}`)
        })),
        { value: 'done', label: text(`Done (${values.length})`, `完成（${values.length} 项）`) }
      ]);
      if (action === 'done') return values;
      if (action.startsWith('remove:')) {
        values.splice(Number(action.slice(7)), 1);
        continue;
      }
      const value = await input(
        title,
        paths ? 240 : 256,
        '',
        paths
          ? text(
              'One workspace-relative file path, not a directory.',
              '填写一个工作区相对文件路径，不是目录。'
            )
          : undefined
      );
      try {
        if (!value) throw new Error(text('A value is required.', '内容不能为空。'));
        const normalized = paths ? parseTaskPath(value) : value;
        if (!values.includes(normalized)) values.push(normalized);
      } catch {
        port.notice({
          tone: 'warning',
          text: text(
            'Invalid or empty value; use a workspace-relative path without .. or drive letters.',
            '内容无效或为空；路径须为工作区相对路径，不允许 .. 或盘符。'
          )
        });
      }
    }
  };
  const edit = async (
    kind: Requirement['kind'],
    id: string,
    original?: Requirement
  ): Promise<Requirement> => {
    const label = await input(text('Item label', '验收项名称'), 160, original?.label);
    const base = { id, label, kind };
    if (kind === 'check') {
      const previous = original?.kind === 'check' ? original : undefined;
      const command = await input(
        text('Exact check command', '准确的检查命令'),
        1024,
        previous?.command,
        text(
          'Tracking only; this form does not run the command or authorize Shell.',
          '只记录验收条件；此表单不会执行命令，也不会授权 Shell。'
        )
      );
      const dependencies = await list(
        text('All files affecting this check', '影响检查结果的全部依赖文件'),
        previous?.paths ?? [],
        16,
        true
      );
      const markers = await list(
        text('Required output markers (optional)', '成功输出标记（可选）'),
        previous?.outputContains ?? [],
        8,
        false
      );
      return validate(() =>
        parseTaskRequirement({
          ...base,
          command,
          paths: dependencies,
          outputContains: markers
        })
      );
    }
    const previous = original && original.kind !== 'check' ? original : undefined;
    const path = await input(
      text('Workspace-relative file', '工作区相对文件路径'),
      240,
      previous?.path
    );
    if (kind === 'read') return validate(() => parseTaskRequirement({ ...base, path }));
    const markers = await list(
      text('Required content markers (optional)', '产物正文标记（可选）'),
      previous?.kind === 'artifact' ? (previous.contains ?? []) : [],
      8,
      false
    );
    return validate(() => parseTaskRequirement({ ...base, path, contains: markers }));
  };
  try {
    const draft: TaskDeliveryContract = {
      schemaVersion: 1,
      title: await input(text('Task title', '任务名称'), 160),
      requirements: [],
      protectedPaths: []
    };
    let nextId = 1;
    for (;;) {
      const action = await choose(
        text(
          `Task draft: ${draft.title} (${draft.requirements.length}/8)`,
          `任务草稿：${draft.title}（${draft.requirements.length}/8）`
        ),
        [
          ...(draft.requirements.length < 8
            ? [
                { value: 'read', label: text('Add file reading', '新增：读取文件') },
                { value: 'artifact', label: text('Add deliverable file', '新增：交付文件') },
                { value: 'check', label: text('Add command check', '新增：命令验收') }
              ]
            : []),
          ...(draft.requirements.length
            ? [
                {
                  value: 'edit',
                  label: text('Inspect / edit / remove item', '查看 / 编辑 / 删除验收项')
                }
              ]
            : []),
          { value: 'title', label: text('Edit title', '修改任务名称') },
          { value: 'protect', label: text('Protected files', '设置不得改动的文件') },
          { value: 'confirm', label: text('Preview and confirm', '预览并确认启用') },
          { value: 'cancel', label: text('Discard draft', '放弃草稿') }
        ]
      );
      if (action === 'cancel') return undefined;
      try {
        if (action === 'title')
          draft.title = await input(text('Task title', '任务名称'), 160, draft.title);
        else if (action === 'protect')
          draft.protectedPaths = await list(
            text('Protected files (must already exist)', '保护文件（必须已存在）'),
            draft.protectedPaths,
            16,
            true
          );
        else if (action === 'edit') {
          const id = await choose(
            text('Choose an item', '选择验收项'),
            draft.requirements.map(({ id, label }) => ({ value: id, label }))
          );
          const index = draft.requirements.findIndex((item) => item.id === id);
          const item = draft.requirements[index];
          if (!item) continue;
          port.notice({ tone: 'info', text: formatTaskRequirement(item, language) });
          const operation = await choose(text('Item action', '验收项操作'), [
            { value: 'back', label: text('Keep and return', '保留并返回') },
            { value: 'edit', label: text('Edit', '编辑') },
            { value: 'remove', label: text('Remove', '删除') }
          ]);
          if (operation === 'remove') draft.requirements.splice(index, 1);
          if (operation === 'edit') draft.requirements[index] = await edit(item.kind, id, item);
        } else if (action === 'confirm') {
          const contract = validate(() => parseTaskDeliveryContract(draft));
          try {
            await TaskDelivery.create(root, contract);
          } catch {
            throw new DraftValidationError();
          }
          const preview = [
            contract.title,
            ...contract.requirements.map((item) => formatTaskRequirement(item, language)),
            `${text('Protected files', '保护文件')}: ${contract.protectedPaths.join(', ') || '-'}`
          ].join('\n\n');
          port.notice({ tone: 'info', text: preview });
          const confirmed = await port.confirm(
            {
              title: text('Enable this task checklist?', '启用这份任务验收清单？'),
              message: text(
                'Full preview is in the local transcript. Confirm tracking only; no commands, permission changes or task.json writes.',
                '完整预览在本地记录中。仅启用检查记录；不执行命令、改变权限或写入 task.json。'
              ),
              preview: text(
                `${contract.requirements.length} items; ${contract.protectedPaths.length} protected files.`,
                `${contract.requirements.length} 个验收项；${contract.protectedPaths.length} 个保护文件。`
              ),
              confirmToken: 'y'
            },
            signal
          );
          signal.throwIfAborted();
          if (confirmed) return contract;
        } else if (action === 'read' || action === 'artifact' || action === 'check') {
          draft.requirements.push(await edit(action, `item${nextId++}`));
        }
      } catch (error) {
        if (!(error instanceof DraftValidationError)) throw error;
        port.notice({
          tone: 'warning',
          text: text(
            'Draft not accepted. Check nonempty title/labels, relative file paths, check dependencies, and existing UTF-8 protected files. The previous draft is retained.',
            '草稿未通过校验：请检查名称非空、相对文件路径、检查依赖，以及保护文件是否为已有 UTF-8 文件；原草稿保留，可继续编辑。'
          )
        });
      }
    }
  } catch (error) {
    if (error instanceof DraftCancelled) return undefined;
    throw error;
  }
}

export async function inspectTaskItem(
  port: InteractionPort,
  contract: TaskDeliveryContract,
  snapshot: TaskDeliverySnapshot,
  language: Language,
  signal: AbortSignal
): Promise<void> {
  const id = await port.select(
    {
      title: language === 'zh' ? '查看验收项与回执' : 'Inspect task item and receipt',
      choices: snapshot.items.map(({ id, label }) => ({
        value: id,
        label
      }))
    },
    signal
  );
  const requirement = contract.requirements.find((item) => item.id === id);
  const item = snapshot.items.find((item) => item.id === id);
  if (!requirement || !item) return;
  const receipt = item.receipt;
  port.notice({
    tone: 'info',
    text: [
      formatTaskRequirement(requirement, language),
      formatTaskDelivery(snapshot, language),
      receipt
        ? `${language === 'zh' ? '回执' : 'Receipt'}: ${receipt.tool} / ${receipt.outcome} / ${receipt.timestamp}\n${receipt.toolCallId}\n${Object.entries(
            receipt.versions
          )
            .map(([path, hash]) => `${path}: ${hash}`)
            .join('\n')}`
        : language === 'zh'
          ? '尚无工具回执；计划描述不等于完成。'
          : 'No tool receipt; a plan is not completion.'
    ].join('\n\n')
  });
}
