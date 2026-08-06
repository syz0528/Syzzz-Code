# Syzzz Code 架构

本文描述 `v1.0.0` CLI 产品的稳定边界。npm 包中的 `dist` 模块属于实现细节，不承诺为稳定 Library API。

## 分层

```text
CLI / Slash commands / NDJSON
          |                 |
 InteractionController   Machine event stream
    |             |
 Ink TUI      Inline renderer
          |
   Session controller
                     |
       Task Composition Runtime
          |                    |
  @ / AGENTS / Skills      QueryEngine + Context Manager
                                  |          |           |
                           Provider Runner  Tool Runtime  Extension Runtime
                                  |          |           |
                         OpenAI-compatible  Workspace    MCP / Hooks / Delegate
                         Anthropic          Shell
```

### CLI 与会话

- `src/index.ts` 负责命令行入口、配置选择和一次性命令。
- `src/interaction/controller.ts` 持有交互状态机和有界 UI 投影；`src/interaction/types.ts` 定义与 Renderer 无关的 `InteractionPort`。
- `src/tui` 使用 Ink/React 实现 fullscreen Renderer；`src/interactive.ts`、`src/terminal-input.ts` 与 `src/cli-renderer.ts` 继续提供 inline adapter。两条路径复用同一个命令注册表。
- `src/tui/composer-buffer.ts` 按 grapheme 管理多行输入，工作区历史由 `src/interaction/history.ts` 原子保存。
- `src/interaction/conversation.ts` 定义语义化用户、Assistant、工具组和 notice；Controller 只维护语义状态，不解释终端物理行。
- `src/tui/streaming-presenter.ts` 从原始 Markdown 维护 stable/mutable 行与有界提交队列；`markdown.ts` 只使用 lexer 生成终端样式，不执行 HTML。
- `src/tui/transcript-view.tsx` 从不可变语义块生成可见窗口、sticky 问题、source-row 锚点、可拖动的有界滚动条及按终端单元格计算的正文选区。runner 使用 SGR 1002 鼠标事件，并以有界 OSC 52 写入剪贴板；共享输入规范化层会先从同批数据中分离鼠标控制码与真实文字，再交给 Composer 或 AskUser。Windows 仍预留一个物理行，避免 Ink incremental renderer 触发 fullscreen 清屏分支。
- `src/tui/terminal-keyboard.ts` 在 fullscreen 首帧前完成有界 Kitty 能力探测；只有终端明确响应时才由 Ink 启用并负责恢复增强键盘协议。旧 Windows Terminal 与 IDE 内嵌终端可通过 `/terminal-setup install` 备份并安装 `Shift+Enter -> ESC+CR` 映射；未设置时界面如实使用 `Ctrl+J` 后备，不在 React 渲染期间写入键盘协议控制序列。
- `src/session-controller.ts` 与 `src/session-store.ts` 负责当前工作区内的原子快照、锁和恢复；TUI 启动选择通过同一个 InteractionPort 决定继续最近会话或保留它并新建会话。
- `src/permissions/grant-store.ts` 只保存会话级或工作区级 `acceptEdits` 授权。该存储与会话快照、workspace trust 分离，不能表示 `fullAccess` 或 Shell 批准。

### Agent Runtime

- `src/runtime-engine.ts` 拥有回合状态机、模式硬边界、审批、工具循环、上下文提交和唯一终态。
- `src/events.ts` 定义 `AgentEvent`；终端、NDJSON 和审计消费同一事件源。
- `src/context-manager.ts` 负责预算估算、自动/手动压缩与失败回滚。

### Task Composition

- `src/composition/runtime.ts` 在首次 Provider 请求前解析显式 `@` 证据、分层 `AGENTS.md` 与 `$skill`，按回合签名自动刷新 Skill，并按模型窗口生成有界 catalog。
- 显式引用内容作为有界 user message 进入历史；AGENTS 与 Skill 目录是按当前磁盘状态生成的瞬时前缀，不提升为 system prompt。
- `src/composition/skill-format.ts` 统一解析 Agent Skills frontmatter、`agents/openai.yaml` 和 `evals/activation.yaml`；损坏 metadata 对显式激活保持可用，但隐式调用 fail-closed。
- `ActivateSkill` 与 `ReadSkillResource` 是只读工具。Skill 的 `allowed-tools` 或脚本不产生任何授权；Shell 的 Skill cwd 必须指向当前回合已激活 Skill 的实时 canonical root。
- `src/composition/skill-authoring.ts` 和 `skill-eval.ts` 提供本地创建、离线验证与隔离的 Live 激活评测。
- `src/composition/skill-installer.ts` 以固定 Git argv 安装公开 HTTPS Skill，固定 commit、校验文件类型和大小，并通过原子目录替换维护一个回滚版本。新用户安装写入 `~/.agents/skills`，legacy 安装锁继续原地管理。

### Provider

- `src/providers/runner.ts` 是 timeout、有限重试、取消和错误分类的唯一所有者。
- OpenAI-compatible Provider 实现 Chat Completions SSE、工具碎片聚合和 DeepSeek reasoning 恢复。
- OpenAI Responses Provider 实现语义流事件、function call 聚合与无状态工具续接；受限私有 output items 只存在于当前内存工具链，持久化时继续剥离。
- Anthropic Provider 保持非流式兼容路径。
- Provider、协议、URL、模型和凭证只来自用户配置；工厂按 `anthropic | openai-compatible | openai-responses` 显式路由，不自动探测或跨协议回退。

### 工具与扩展

- `src/tools` 提供受工作区边界、输入 schema、输出上限和取消约束的内置工具。
- `AskUser` 只在调用方提供 `UserInputHandler` 时暴露；问题通过 InteractionPort 展示，客户端始终在预设选项之外提供有界自定义答案，最终答案作为普通 ToolResult 返回。
- 写入工具复用审批快照、SHA-256 冲突检测、同目录临时文件和原子替换。
- `src/extensions` 提供 Trust V2、渐进式 MCP Broker 和本地 Hook 生命周期。
- `src/subagents.ts` 仅提供 `explore | review` 两种只读委派，并受多重预算限制。

## 关键不变量

1. `ask | plan` 在工具暴露层和执行层均禁止副作用。
2. `fullAccess` 不能绕过模式、工作区路径、Hook deny 或 MCP disabled。
3. Provider attempt 出现正文或工具碎片后不重试。
4. 失败或取消的回合不提交模型历史；已发生副作用通过回执和会话检查点保留。
5. reasoning 不进入终端正文、NDJSON、审计或会话快照。
6. MCP 调用不自动重放；断线只影响下一次独立操作的惰性重连。
7. Hook 与 Subagent 不能提升权限或获得未显式分配的工具。
8. `@`、AGENTS 和 Skills 都是不可信 user-level 输入，不能修改模式、权限、审批、Hook、MCP policy 或路径边界。
9. TUI、inline 与 NDJSON 是同一 Runtime 的投影；Renderer 不能授权工具、修改 AgentEvent 或成为业务状态真相源。
10. 任一时刻只有一个阻塞交互；审批与 Agent 提问的取消统一通过 `AbortSignal` 表达。
11. 持久化权限只能收敛到 `acceptEdits`；`fullAccess` 与 Shell 单次批准永不跨进程恢复。

## 本地数据

- 配置：`~/.syzzz-code/config.json`
- 会话：`~/.syzzz-code/sessions/<workspaceHash>/<sessionId>`
- 审计：`~/.syzzz-code/audit/YYYY/MM/DD/<sessionId>.jsonl`
- Trust：`~/.syzzz-code/trusted-workspaces.json`
- 用户扩展：`~/.syzzz-code/mcp.json`、`~/.syzzz-code/hooks.json`
- 用户指令与 Skills：`~/.syzzz-code/AGENTS.md`、`~/.agents/skills`；`~/.syzzz-code/skills` 作为 legacy 来源继续发现
- Skill 安装记录：`~/.syzzz-code/skill-installs.json`
- 工作区输入历史：`~/.syzzz-code/history/<workspaceHash>.json`
- 编辑授权：`~/.syzzz-code/permission-grants.json`

会话快照包含恢复所需的有界模型上下文，未加密。审计只保存 allowlist 元数据。

## 发布结构

`package.json` 是名称和版本的唯一事实源。构建前会删除 `dist`，避免陈旧模块进入 tarball。发布包只允许包含：

- `dist`
- README、SECURITY、LICENSE、CHANGELOG、ARCHITECTURE、TESTING
- `docs`
- npm 自动包含的 `package.json`

完整测试与发布门禁见 [TESTING.md](TESTING.md)，威胁模型见 [SECURITY.md](SECURITY.md)。
