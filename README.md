# Syzzz Code

Syzzz Code 是一个使用 TypeScript 构建的实验性命令行 AI 编程 Agent。它提供统一的 Provider 接口、事件化 Agent Runtime、受约束的代码库工具、可靠编辑、上下文压缩、可恢复的本地会话，以及受信任边界约束的 MCP、Hooks、只读 Subagent、显式上下文、开放 Skills 和全屏终端界面。

Phase 1 至 Phase 5.1、Phase 7 与 Phase 7.1 已完成并保持 **Frozen**。Phase 8 正处于 fullscreen TUI 的 dogfood 修正与复验阶段；Phase 6 继续保持 **Release Candidate Accepted**，其 npm、Tag、GitHub Release 与 registry 安装复验仍需单独完成。

> [!WARNING]
> Syzzz Code 仍处于实验阶段。文件工具受工作区边界、敏感路径和并发 hash 校验保护，但 Shell 不是 OS sandbox。获批或在 `fullAccess` 下自动执行的命令仍可产生工作区外副作用。

> [!IMPORTANT]
> 自动保存的会话包含完整但有界的模型可见上下文，其中可能包含用户提示、代码和工具结果。会话仅保存在本机 `~/.syzzz-code/sessions`，但当前版本不提供 Keychain、磁盘加密或云端同步。

## 核心能力

### Agent Runtime

- `QueryEngine.runTurn()` 以 `AsyncGenerator<AgentEvent, TurnResult>` 输出版本化事件流。
- OpenAI-compatible Provider 支持 Chat Completions 流式文本、reasoning 状态、tool call 聚合和 usage。
- OpenAI Responses Provider 按语义事件处理文本、reasoning 状态、function call、usage 和 `response.completed`，并支持无状态工具链续接。
- Anthropic 当前使用统一事件语义下的非流式兼容路径。
- Provider Runner 统一负责错误分类、超时、有限重试、`Retry-After` 和用户取消。
- 原始 `reasoning_content` 不进入终端、NDJSON、审计或会话快照。
- `stream-json` 使用 ASCII-safe NDJSON，适合 Windows PowerShell 按行解析。

### 工作模式与权限

工作模式决定 Agent 可以看到和执行哪类工具：

- `ask`：只读问答。
- `plan`：只读探索并生成计划，完成后保持在 plan 模式。
- `code`：在当前权限策略下执行编码任务。

权限模式决定 code 模式中的审批方式：

- `safe`：Write/Edit/Patch 与 Shell 均需要审批。
- `acceptEdits`：可选择跟随当前已保存对话或规范化工作区持久化文件编辑授权，Shell 仍逐次审批。
- `fullAccess`：仅当前进程跳过普通审批，永不持久化，也不能绕过 ask/plan 的只读边界。

新会话默认使用 `code + safe`。从 plan 进入执行必须显式输入 `/code`。`/permissions safe` 会同时撤销当前对话和工作区的持久化编辑授权。

### 代码库上下文与编辑

内置工具包括：

- 发现与读取：`Glob`、`Grep`、`ListDirectory`、`Read`
- TS/JS 分析：`RepoMap`、`Diagnostics`
- 编辑：`Patch`、`Edit`、`Write`
- Git 查看：`GitStatus`、`GitDiff`
- 命令执行：`Shell`

主要安全与可靠性约束：

- 文件访问限制在规范化工作区内，并阻止敏感路径、symlink/junction 逃逸和危险 Windows 路径。
- Read 支持行范围、SHA-256 版本、换行格式和 continuation。
- Patch/Edit 可使用 `expectedHash` 拒绝过期读取。
- 写入复用审批快照、同目录唯一临时文件、flush、mode 保留、最终 hash 复核和原子 rename。
- 单个模型可见工具结果不超过 40 KiB。
- Shell 保留超时、取消、stdout/stderr 分离、输出上限和进程树清理。

### 上下文管理

- 根据模型 context window、系统提示、工具 schema 和消息估算输入预算。
- `/context 64k|128k|200k` 可修改没有模型专属覆盖时使用的 fallback context window；Provider 的明确模型窗口仍优先。
- 默认在 `min(window * 85%, window - 8192)` 触发自动压缩，目标降到窗口的 50%。
- Assistant tool call 与对应 Tool Result 作为不可拆分原子组。
- `/compact` 可手动压缩；失败、取消、空历史或无可压缩内容不会修改会话历史。
- Provider 返回 `context_exceeded` 且尚未输出正文或工具碎片时，可进行一次强制压缩恢复。
- 文件写入成功后若回合失败或取消，会保存重新读取回执，并在恢复后的下一回合提醒 Agent。

### 任务组合、项目指令与 Skills

- `@path`、`@"path with spaces"` 和 `@path#L10-L40` 在首次 Provider 请求前解析工作区证据；`@@` 表示字面 `@`。
- 单轮最多 10 个引用，单文件最多 40 KiB/2000 行，全部正文最多 80 KiB；目录只注入最多 200 项的有界清单。
- 用户级 `~/.syzzz-code/AGENTS.md` 与从 Git 根到当前目录的分层 `AGENTS.md` 作为 user-level 指令加载；接触嵌套目录后，其祖先指令从下一次 Provider 请求起生效。
- 新安装的用户 Skill 默认位于 `~/.agents/skills`；用户和项目的 `.syzzz-code/skills` 继续作为 legacy 来源发现，旧安装记录可原地 update/rollback/remove。
- 启动时只注入允许隐式调用的 Skill catalog；catalog 按模型窗口限制为 2%，自动缩短描述并确定性省略。`$skill 参数` 始终可显式激活，`ActivateSkill` 还受全局与单 Skill `allow_implicit_invocation` 约束。
- `agents/openai.yaml` 可提供 display name、short description、图标、品牌色、默认 prompt、隐式调用策略和 MCP 依赖诊断。损坏 metadata 不妨碍显式使用，但会关闭隐式调用。
- 每轮最多激活 8 个 Skill、正文合计 128 KiB。激活块只列出有界的 `scripts/references/assets` 路径；`ReadSkillResource` 仍只读取 Skill 根内 40 KiB 以内的普通 UTF-8 文件。
- 用户 Skill 目录 symlink 可用；项目 Skill symlink 必须仍指向仓库内。激活和资源读取会复核 canonical target，变化后当前操作 fail-closed。
- Skill 脚本不会自动运行。code 模式可让 Shell 显式选择已激活 Skill 的工作目录，仍经过现有审批、Hook、取消和审计边界；ask/plan 不暴露 Shell。
- `allowed-tools`、Skill 脚本和项目指令都不能授予工具、提升权限或绕过模式、Hook、审批及 MCP policy。
- 显式引用的快照内容会进入会话历史；AGENTS 使用当前磁盘版本重新注入。审计仅记录数量、字节和 outcome，不保存路径或正文。

### 会话恢复

- 交互模式默认自动保存；同一工作区存在历史时，TUI 默认先选择“继续最近对话”或“新建对话”。
- `syzzz --continue` 恢复当前工作区最近会话。
- `syzzz --resume <id>` 按完整 ID 或唯一前缀恢复。
- `/new` 创建新会话；`/clear` 是其别名，旧会话不会删除。
- `/resume`、`/rename`、`/save` 和 `/compact` 管理当前会话。
- 恢复时保留工作模式；显式保存到该对话或工作区的 `acceptEdits` 可恢复，其他权限重置为 `safe`，`fullAccess` 永不恢复。
- 保存的 Provider 或模型不可用时，回退到当前可用配置并明确警告。
- 单个 `state.json` 硬上限为 64 MiB，使用原子替换和进程锁。
- 会话默认永久保留，只能通过显式 `sessions delete|prune` 删除。

会话目录：

```text
~/.syzzz-code/sessions/<workspaceHash>/<sessionId>/
  state.json
  meta.json
  lock.json
```

`state.json` 是恢复真相源；`meta.json` 仅用于快速列表，并可从 state 重建。
编辑授权单独保存在 `~/.syzzz-code/permission-grants.json`，只记录 `acceptEdits` 的会话 ID 或工作区哈希；它不保存 `fullAccess`、审批答案、Shell 授权或文件内容。

### 全屏终端界面

- 交互式 TTY 默认使用 Ink fullscreen TUI；非 TTY、CI、`TERM=dumb`、`INK_SCREEN_READER=true` 或 `--ui inline` 使用滚动式 inline 界面。
- Header、Transcript、Activity、结构化交互面板、Composer 和 Footer 消费同一个 `InteractionController`；Agent Runtime 不依赖 React。
- Composer 支持中文、Emoji、组合字符、多行编辑、bracketed paste、工作区历史，以及 `/`、`@`、`$` 的统一固定候选区域。
- Composer 使用简洁的 `>` 前缀，并通过 Ink 实际布局坐标定位真实终端光标；Windows 终端预留最后一个物理行，使 Ink 使用 changed-line 增量提交而不是每帧清屏。
- Transcript 使用 `ConversationBlock` 保存用户问题、Markdown 回答、工具组与 notice；用户问题采用全宽背景带，回答使用 `·` 前缀，并支持标题、强调、代码、列表、引用、链接与简单表格。
- 流式回答使用 source-backed stable/mutable 分区和有界队列。首个正文 delta 立即可见，稳定行平滑提交，积压时自动追平；Provider 只返回完整块时不会伪造打字动画。
- Phase 8.2 会缓存不可变的完成块，并根据终端能力选择 30 FPS `standard` 或 20 FPS `conservative` profile；IDE 内嵌 Windows 终端默认采用后者。`/setting fps auto|30|60` 可持久化选择 TUI 帧率并在下次启动生效；`/ui status` 可查看当前 profile、键盘协议、帧节奏和渲染耗时，`SYZZZ_TUI_PROFILE=standard|conservative` 可用于诊断覆盖。
- Transcript 支持鼠标滚轮、PageUp/PageDown、Home/End 和右侧滚动条有界回看；离开底部后冻结视口并提示新输出，当前回答对应的问题会在离开可视区后置顶。
- `/model`、`/provider`、`/permissions`、`/resume`、审批和确认在 TUI 中使用结构化面板。确认 token 会先显示在输入区域，按 Enter 后才提交。
- Agent 可在交互回合中使用 `AskUser` 提出单选、多选或短文本问题；单选和多选始终提供“输入自己的想法”，也可按 `C` 直接进入自定义回答。该能力由客户端保证，不能被模型关闭。问题和答案不会进入输入历史或审计正文，但答案会作为普通 ToolResult 进入模型上下文和会话快照。
- 鼠标追踪启用时，滚轮和支持按住拖动的右侧滚动条负责历史导航；Transcript 正文可直接按住左键拖选，松开后通过终端剪贴板协议自动复制，并在 Footer 右侧短暂显示“已复制！”或 `Copied!`。
- 固定活动栏展示当前 phase、动态状态、有效工作耗时和等待输入状态；回合结束后在回答尾部显示耗时、token、工具和重试摘要。
- 流式开关由当前交互上下文实时驱动；Skill 显式或隐式激活的成功与失败会投影到 Transcript，存在 `AskUser` 时改变执行路径的选项必须进入结构化提问面板。
- TUI 只保存有界显示投影，不改变 Engine 历史；恢复会话最多显示最后 100 条、512 KiB 的普通用户和 Assistant 文本。
- `chat -m` 与 `stream-json` 永不加载 TUI。fullscreen 不是新的权限边界，也不是 OS sandbox。

### 可信扩展

- `McpSearch` 渐进发现工具，`McpCall` 在执行前解析远端工具的实际风险与审批策略；不会把全部远端 schema 注入每次请求。
- 支持 stdio 和 Streamable HTTP。远程 HTTP 必须使用 HTTPS，loopback 可使用 HTTP，并且不跟随重定向。
- 项目 MCP 与 Hooks 只有在规范化 workspace 路径及当前配置摘要经过 `/trust` 确认后才加载；配置变化、损坏或 V1 信任迁移会进入 `review-required`，用户级配置不依赖 workspace trust。
- MCP 本地策略可把工具收紧为 `execute` 或 `disabled`；`disabled` 不可发现、不可调用，`fullAccess` 也不能绕过。无本地策略时，仅非 destructive 的 `readOnlyHint:true` 映射为只读免审批。
- Hooks 是用户授权的本地进程，只能由 `PreToolUse` 拒绝操作，不能授权、改写输入、注入上下文或改变模式；拒绝后当前回合关闭后续工具，避免重试或替代工具绕过。
- 压缩和 Subagent 生命周期 Hook 只接收有界脱敏元数据，不能拒绝或改变执行。
- `Delegate` 只提供 `explore` 与 `review` 两种只读 Subagent；每个父回合最多 2 次、单层、串行，并受轮次、工具调用、Provider 请求、时间、token、上下文和报告多重预算约束。
- MCP 结果和 Subagent 报告有界；原始 Subagent transcript 不进入终端、审计或会话快照。

完整配置、信任语义和人工验收步骤见 [扩展使用指南](docs/EXTENSIONS.md)，威胁模型见 [SECURITY.md](SECURITY.md)。

## 环境要求

- Node.js 22 或更高版本（CI 验证 Node 22 与 24）
- npm
- 一个 Anthropic、OpenAI-compatible Chat Completions 或 OpenAI Responses API 服务

## 安装

公开 npm 发布完成后可使用：

```bash
npm install --global syzzz-code
```

当前源码候选版本使用：

```bash
git clone https://github.com/syz0528/Syzzz-Code.git
cd Syzzz-Code
npm install
npm run build
npm link
```

不使用全局链接时，可以直接运行：

```bash
node dist/index.js --help
```

## 配置

首次运行会创建：

```text
~/.syzzz-code/config.json
```

### API Key

交互式隐藏输入：

```bash
syzzz config set apiKey
```

从标准输入读取，适合自动化：

```bash
printf "%s\n" "$API_KEY" | syzzz config set apiKey --stdin
```

推荐只保存环境变量名，不在配置文件中保存密钥：

```bash
syzzz config set apiKey --from-env DEEPSEEK_API_KEY
```

凭证解析优先级为：

1. `API_KEY_ENV` 指向且非空的进程环境变量
2. 配置文件中的 `API_KEY`
3. 未配置

命令行位置参数不接受明文 API Key，避免密钥进入 Shell 历史。隐藏输入仍会将 Key 以明文写入本地配置文件；当前版本没有系统 Keychain 集成。

### 配置示例

```json
{
  "schemaVersion": 1,
  "currentProvider": "deepseek",
  "providers": {
    "deepseek": {
      "name": "Deepseek",
      "type": "openai-compatible",
      "model": "deepseek-chat",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "env": {
        "BASE_URL": "https://api.deepseek.com",
        "API_KEY": "",
        "API_KEY_ENV": "DEEPSEEK_API_KEY"
      }
    }
  },
  "audit": {
    "retentionDays": 30,
    "maxBytes": 20971520
  },
  "ui": {
    "streamOutput": true,
    "mode": "auto",
    "persistentHistory": true,
    "language": "auto"
  },
  "context": {
    "autoCompact": true,
    "defaultWindowTokens": 65536
  },
  "sessions": {
    "autoSave": true,
    "startup": "ask"
  },
  "subagents": {
    "enabled": true
  },
  "skills": {
    "enabled": true,
    "allowImplicit": true,
    "disabled": []
  }
}
```

Chat Completions 与 Responses 是不同协议。一个 Provider 配置项只对应一种协议；`/model` 只切换该配置项中的同协议模型。需要同时使用两种协议时，应增加独立 Provider，并通过 `/provider` 切换。例如：

```json
{
  "opencode-chat": {
    "name": "OpenCode Chat",
    "type": "openai-compatible",
    "model": "deepseek-v4-flash",
    "models": ["deepseek-v4-flash"],
    "env": {
      "BASE_URL": "https://opencode.ai/zen/go/v1",
      "API_KEY": "",
      "API_KEY_ENV": "OPENCODE_API_KEY"
    }
  },
  "opencode-luna": {
    "name": "OpenCode Luna",
    "type": "openai-responses",
    "model": "gpt-5.6-luna",
    "models": ["gpt-5.6-luna"],
    "env": {
      "BASE_URL": "https://opencode.ai/zen/go/v1/responses",
      "API_KEY": "",
      "API_KEY_ENV": "OPENCODE_API_KEY"
    }
  }
}
```

`openai-responses` 的 `BASE_URL` 可以填写 API 根路径，也可以填写以 `/responses` 结尾的完整端点；运行时会规范化为 SDK 所需的根路径。协议不会自动猜测或静默回退，避免把已经产生正文或工具调用的请求错误地重放到另一协议。

缺少 `schemaVersion` 的旧配置会先备份，再迁移到 v1。未知未来版本拒绝启动且不会被 repair 覆盖。损坏配置不会自动重置，可使用：

```bash
syzzz doctor
syzzz doctor --repair-config
```

`doctor` 默认完全离线，并检查 Node、配置、Provider/模型、凭证来源、Endpoint、目录权限、ripgrep、TypeScript Worker、审计和会话目录。输出不包含 API Key。

## 使用

### 交互模式

```bash
syzzz
syzzz --ui tui
syzzz --ui inline
syzzz --continue
syzzz --resume <id-or-prefix>
```

`--ui auto` 是默认值。显式 `--ui tui` 在终端能力不足时 fail closed；`auto` 仅在初始化失败时警告并回退 inline，运行中的 TUI 异常不会复用不确定状态。

输入 `/` 可浏览当前命令。主要 Slash 命令：

```text
Work modes
/ask [message]                         切换到只读问答
/plan [message]                        切换到只读规划
/code [message]                        显式进入执行模式

Session
/status                                查看会话、模式、权限、token 和持久化状态
/new [title]                           创建新会话
/clear                                 /new 的别名
/resume [id-or-prefix]                 恢复当前工作区会话
/rename <title>                        重命名当前会话
/save                                  立即保存
/compact                               手动压缩上下文
/history status|on|off|clear           管理当前工作区输入历史

Runtime
/permissions safe|acceptEdits|workspace|fullAccess
                                        查看或切换权限与编辑授权范围
/model [model]                         切换当前 Provider 的配置模型
/provider [provider]                   切换本地已配置 Provider
/stream on|off                         控制正文是否逐段显示
/language auto|zh-CN|en                切换本地候选和命令描述语言
/setting                               集中设置语言、流式展示、帧率、历史与上下文
/setting fps auto|30|60                选择 TUI 帧率（下次启动生效）
/terminal-setup status|install         检查或安装 Shift+Enter 终端映射
/ui status                             查看终端能力与 TUI 渲染诊断

Composition
/context reload|64k|128k|200k          查看、重载或选择 fallback context window
/skills list|inspect|reload|doctor     查看、检查、重载或诊断 Skills
/skills create|validate|test           创建、验证或联网评测 Skill 激活
/skills enable|disable <name>          启用或禁用 Skill
/skills install|update|rollback|remove 管理公开 Git Skill

Extensions
/extensions [reload]                    查看或重载全部扩展
/mcp [reload|reconnect|inspect]         查看、重载、重连或检查 MCP
/hooks [reload]                         查看或重载 Hooks
/agents [on|off]                        查看预算或切换只读 Subagent
/trust                                 信任当前路径下的项目扩展
/untrust                               立即禁用当前项目扩展

General
/help                                  显示命令
/exit                                  退出
```

裸 `/` 按稳定优先级展示常用命令，输入命令片段后按匹配度过滤；`@` 和 `$` 分别提供工作区路径与 Skill 候选。`/?`、`/quit` 是别名，`//`、`@@`、`$$` 分别发送字面 Slash、`@` 和 `$`。

TUI Composer 中 `Enter` 提交。启动时会在 fullscreen 首帧前探测 Kitty Keyboard Protocol；终端明确支持时，`Shift+Enter` 换行。旧版 Windows Terminal 或 IDE 内嵌终端可能把 `Shift+Enter` 编码成与 Enter 完全相同的字节，此时使用 `Ctrl+J` 稳定换行，或运行 `/terminal-setup install`，经确认后备份终端设置并安装 `Shift+Enter -> ESC+CR` 映射。Syzzz 不覆盖已有冲突键位，也不在渲染期间强行写入未知键盘协议。鼠标滚轮、拖动右侧滚动条或 `PageUp/PageDown` 滚动 Transcript，左键拖选正文会在松开后复制，`Ctrl+O` 展开或收起最近一项工具详情，`Esc` 关闭候选、详情或正文选区。`Ctrl+C` 依次关闭面板、清空非空 Composer、取消当前操作；空闲且输入为空时两秒内按两次退出。

`/language` 会本地化 Syzzz 自带的 `/help`、Slash 分类、二级选择、常用本地状态与 `@` 上下文说明。Skill 作者提供的名称与描述、模型名以及第三方 MCP 文本保持原文，避免无依据翻译改变真实语义。

显式任务组合示例：

```text
解释 @src/runtime-engine.ts#L1-L120 与 @"docs/design notes.md" 的职责边界
$review 只读检查当前改动中的安全回归
```

### 单次调用

```bash
syzzz chat -m "分析当前项目" --mode ask
syzzz chat -m "给出实施计划" --mode plan
syzzz chat -m "运行最小验证" --mode code
syzzz chat -m "解释 package.json" --stream off
syzzz chat -m "检查项目" --output-format stream-json
```

一次性 `chat -m` 不持久化会话。退出码为成功 `0`、失败 `1`、取消 `130`。

### 会话管理

```bash
syzzz sessions list
syzzz sessions delete <id-or-prefix>
syzzz sessions delete <id-or-prefix> --yes
syzzz sessions prune --older-than 30
```

活动锁定的会话不能删除。`prune` 只删除当前工作区内满足时间条件且未锁定的会话，不会自动运行。

### 扩展管理

```bash
syzzz mcp list
syzzz mcp add <name> <executable> [args...]
syzzz mcp add <name> --url https://example.com/mcp --header 'Authorization=Bearer ${MCP_TOKEN}'
syzzz mcp enable|disable|remove <name>
syzzz mcp doctor [name]
syzzz mcp policy <server> <tool> execute|disabled|reset --scope user|project

syzzz extensions status
syzzz extensions status --json

syzzz hooks list
syzzz hooks add <name> <executable> [args...] --event PreToolUse --matcher "builtin:Shell"
syzzz hooks enable|disable|remove <name>
syzzz hooks doctor

syzzz skills list
syzzz skills inspect <name>
syzzz skills doctor
syzzz skills create <name> --description <text> [--scope user|project] [--body-file <path>]
syzzz skills validate [name|path] [--json]
syzzz skills test <name> [--json]
syzzz skills install <https-url> [--ref <ref>] [--skill <name>] [--scope user|project]
syzzz skills update|rollback|remove <name> [--yes]
```

`syzzz doctor`、`syzzz extensions status` 与 `syzzz skills doctor` 始终离线；只有 `syzzz mcp doctor` 会连接服务器。项目 MCP/Hook 配置变更后必须重新 `/trust`。项目 Skill 是无权限指令资源，不进入 workspace trust；安装只支持公开 HTTPS Git，固定到完整 commit，执行前展示文件清单并要求 `y/Y` 或 `--yes`，且不会运行仓库中的脚本。

`AGENTS.md`、`SKILL.md` 和 Skill 资源必须是 UTF-8。Windows PowerShell 5.1 的 `Set-Content` 默认使用当前 ANSI 代码页，创建中文测试文件时必须显式指定编码：

```powershell
Set-Content -LiteralPath .\AGENTS.md -Encoding UTF8 -Value '回答时必须包含 ROOT_RULE。'
@'
---
name: phase7-demo
description: 使用固定步骤审查 TypeScript 证据
---
回答必须包含 SKILL_ACTIVE，并引用给定证据。
'@ | Set-Content -LiteralPath .\.agents\skills\phase7-demo\SKILL.md -Encoding UTF8
```

无效 Skill 会被单独隔离并由 `/context`、`/skills inspect`、`/skills doctor` 或 `syzzz skills doctor` 报告，不会阻塞其他 Skill。Agent Skills 规范要求 `description` 不超过 1024 个字符；超限 Skill 需要由其作者缩短描述后才能加载。

`skills create` 默认创建用户级、explicit-only 的模板，避免未完成工作流被模型自动激活。`skills validate` 完全离线。`skills test` 会使用当前 Provider/模型读取 `<skill>/evals/activation.yaml`，每个 case 使用全新 ask+safe Engine 且只暴露 `ActivateSkill`；报告不保存 prompt、回答、reasoning 或 transcript。

### 其他命令

```bash
syzzz config list
syzzz config set sessions.autoSave on|off
syzzz config unset apiKey
syzzz switch
syzzz doctor
syzzz init
```

## 审计与隐私

审计文件位于：

```text
~/.syzzz-code/audit/YYYY/MM/DD/<sessionId>.jsonl
```

审计只记录 turn、Provider、retry、usage、审批结果、工具 outcome、MCP/Hook/Subagent 健康元数据、组合引用计数、Skill outcome、压缩状态和终态，不记录 prompt、正文、URL、认证头、文件路径、diff、工具输入输出、Shell 输出、Hook payload、Subagent transcript 或原始 reasoning。

会话快照与审计的隐私边界不同。会话为了恢复模型上下文，会保存有界的用户消息、Assistant 消息、MCP 工具结果和 Subagent 最终报告。通过 `sessions.autoSave=false` 可关闭后续自动保存，但 `/save` 仍可显式保存。

## 开发与验证

```bash
npm run build
npm test
npm run lint
npm run format:check
npm run test:tui
npm run test:coverage
npm run test:providers
npm run eval:offline
npm run pack:check
npm run smoke:package
npm audit --omit=dev --audit-level=high
git diff --check
```

自动化套件覆盖路径与权限安全、事件 Runtime、Provider 可靠性、双 Renderer、Composer、结构化交互、代码库上下文、压缩、会话恢复、Trust V2、MCP、Hooks 和只读 Subagent。当前包含五种离线 Provider Profile 与发布门禁；Phase 7 增加 `@`、分层 AGENTS、Skills、公开 Git 安装及五项任务组合 Eval。

Phase 8.2 当前本地完整回归为 **367/367**，TUI 专项为 **43/43**，离线 Eval 为 **12/12**；最新正式覆盖率为 Lines **82.18%**、Branches **75.96%**、Functions **85.45%**，均高于 82%/74%/84% 门槛。真实 VT/ANSI 屏幕回放还验证了普通按键、spinner、正文 delta 和增强键盘探测不触发重复全屏清除；本轮额外锁定拆分鼠标序列、终端 profile、首包立即显示、后续帧合并、中英文帮助、自动复制提示、`/setting` 和 30/60 FPS 配置。生产依赖审计、许可证、Secret 扫描、320 文件候选包检查和全新 prefix 安装 smoke 均通过。当前状态为 **Implemented**；跨平台 CI 与 Windows Terminal、Codex 内嵌终端的人工复验尚未完成，因此不能标记为 Validated 或 Frozen。Phase 6 的真实 DeepSeek/OpenCode Live Eval 保持 7/7；OpenCode `gpt-5.6-luna` 的 Responses 文本流与 function call 往返 smoke 已通过。

Phase 5 冻结验收还完成了 11 项真实终端 dogfood，覆盖未信任边界、Trust V2 复审、MCP 策略与惰性重连、Hook 拒绝与生命周期、取消清理、Subagent 预算、隐私恢复和撤销信任。公开 Streamable HTTP MCP 的真实握手、工具发现及只读天气调用同样通过；该外部服务只用于兼容性验证，不是 Syzzz 的运行依赖。

npm 包使用 allowlist，只包含 `dist`、README、SECURITY、LICENSE、CHANGELOG、ARCHITECTURE、TESTING、`docs` 和 npm 固定元数据，不包含 `src`、`tests`、`archive`、Eval fixture、本地配置或历史报告。测试与发布流程见 [TESTING.md](TESTING.md)，架构边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 已知边界

- Shell 不是 OS sandbox，也没有凭证隔离、命令 allowlist 或语义安全分类器。
- 文件最终 hash 复核到 rename 之间仍有极小 TOCTOU 窗口。
- token 估算不是精确 tokenizer；只有 Provider 上报 usage 是已发生请求的权威值。
- 压缩摘要可能丢失低相关细节。
- Anthropic 尚未实现真实流式。
- RepoMap 与 Diagnostics 仅提供 TS/JS 按需轻量分析，不是 LSP 或持久化语义索引。
- 会话没有加密、云同步、fork/rewind 或跨工作区迁移。
- workspace trust 授权项目扩展代码以当前用户权限运行，不是 OS sandbox，也不等于 `acceptEdits` 或 `fullAccess`。
- Trust V2 审查扩展配置定义，不会追踪被引用脚本或 executable 内容的后续变化。
- MCP `readOnlyHint` 是受信 Server 的声明，Syzzz 无法证明远端实现没有副作用。
- 当前不支持 OAuth、旧 SSE、MCP Resources/Prompts/Sampling、后台 Hooks、写入型或嵌套 Subagent。
- `@` 只支持工作区内普通 UTF-8 文件和有界目录清单，不支持外部路径、URL、图片、PDF 或多模态附件。
- Skill 安装只支持公开 HTTPS Git；不支持私有凭证、市场、自动更新、安装后自动执行或 `allowed-tools` 授权。
- TUI 当前提供滚轮、可拖动滚动条、正文拖选复制和 sticky 问题等有限鼠标交互，不支持通用点击控件、主题/插件系统、内嵌编辑器、交互式 Shell 或后台任务；inline 与 NDJSON 不会被移除。
- 当前没有并行工具、后台任务、LSP 或持久化语义索引。

## 当前阶段

Phase 1 至 Phase 5.1、Phase 7 与 Phase 7.1 均保持 **Frozen**，Phase 6 保持 **Release Candidate Accepted**。Phase 8.2 位于 `codex/phase8-tui`，当前为 **Implemented / Validation Pending**；回退检查点 `a4e93d4` 已推送，稳定帧、真实流式、语义 Transcript、终端 profile、输入解码、Markdown、活动栏、滚动锚点和结构化 Skill 提问已完成本地专项验收，仍需完整门槛、跨平台 CI 与真实终端 dogfood 后才能进入 Validated 和 Frozen。
