# Syzzz Code

Syzzz Code 是一个使用 TypeScript 构建的实验性命令行 AI 编程助手。它提供统一的 Provider 抽象、多轮对话和本地工具调用能力，可通过用户配置连接 Anthropic 协议或 OpenAI-compatible 协议的模型服务。

该项目受现代终端编程 Agent 的架构理念启发，但拥有独立实现的 CLI、对话引擎、Provider 适配层和工具循环。当前目标是将一个已经跑通核心链路的 MVP，逐步升级为安全、可观察、可恢复的本地编程 Agent。

> [!WARNING]
> 当前版本仍处于实验阶段。文件工具已经限制在工作区内；默认 Safe 模式下写入和 Shell 执行要求用户逐次确认。`fullAccess` 可在**当前会话**内跳过审批提示，但 **Shell 仍不是安全沙箱**，获批或自动放行的命令可以产生工作区外副作用。请只在可恢复、低权限且不包含敏感数据的环境中使用，并在执行前后检查文件和 Git 变更。

## 当前能力

- 直接运行 `syzzz` 进入连续对话模式，也支持 `syzzz chat -m` 单次调用；
- 支持 Anthropic Messages API 与 OpenAI-compatible Chat Completions；
- OpenAI-compatible 路径使用真流式响应；Anthropic 当前保持非流式兼容，并在 Runtime 中转换为统一事件；
- `QueryEngine.runTurn()` 以 `AsyncGenerator<AgentEvent, TurnResult>` 提供版本化事件流，`chat()` 保留原有 Promise 兼容契约；
- 每个事件都包含 `schemaVersion`、`sessionId`、`turnId`、单调递增 `sequence` 与时间戳；
- CLI 负责渲染 Thinking、reasoning 状态、正文 delta、工具、审批、重试和回合 footer，Engine 与 Provider 不直接输出日志；
- 交互输入支持 `/` 即时候选菜单，首批命令为 `/stream`、`/permissions`、`/model`、`/help` 和 `/exit`；
- `/stream on|off` 只控制终端正文是否逐段展示，Provider 与 `AgentEvent` 始终保持实时流式；
- `/model` 可在当前 Provider 配置的模型列表内热切换，并清理历史中的 Provider 私有 reasoning metadata；
- Read/List 成功状态为瞬时展示，Write/Edit/Shell 成功保留一行，异常始终保留；footer 同时统计工具调用、失败和重试；
- `syzzz chat -m ... --output-format stream-json` 在 stdout 输出逐行 ASCII-safe NDJSON 事件，跨 Windows PowerShell 代码页仍可稳定解析；
- Provider Runner 统一处理分类错误、120 秒单次超时、最多 3 次 attempt、180 秒总预算、指数退避、jitter 与 `Retry-After`；
- 一旦已输出正文或收到 tool-call delta 就不再重试，失败 attempt 的工具碎片不会执行；
- Provider 原始 `reasoning_content` 不公开，只输出 started/completed、耗时和字符数；工具链需要时才在 Provider 内部回放；
- 支持模型发起结构化工具调用，内置 `Glob`、`Grep`、`RepoMap`、`ListDirectory`、`Read`、`Diagnostics`、`Patch`、`Edit`、`Write`、`GitStatus`、`GitDiff` 和 `Shell`；
- 会话级权限模式为 `safe`、`acceptEdits`、`fullAccess`，普通审批不能间接进入 `fullAccess`；
- 文件工具受工作区、敏感路径、symlink/junction 与 Windows 特殊路径约束；`Read` 支持带行号的范围读取、版本 hash 与 continuation；
- `Patch`、`Write`、`Edit` 使用审批后 hash 冲突检测、同目录唯一临时文件、flush、mode 保留和原子替换；
- Context Manager 根据模型窗口估算输入预算，在 85% 阈值自动压缩旧历史，目标降至 50%，并保留工具调用与结果的原子分组；工具结果会在 40 KiB 硬上限内按当前窗口剩余预算进一步收缩；
- 压缩请求本身始终低于安全阈值且最多携带 256 KiB 转录；正常情况下保留最新工具组，只有下一次 Provider 请求无法安全发起时才整组紧急压缩；
- Provider 报告 `context_exceeded` 且尚未输出正文或工具碎片时，可执行一次强制压缩恢复；压缩摘要不会进入终端正文或元数据审计；
- `RepoMap` 接受目录或单个 TS/JS 焦点文件，按需提取 import/export 图与顶层符号；`Diagnostics` 在 512 MiB、60 秒上限的 Worker 中运行 TypeScript Compiler API `noEmit` 检查；
- `Shell` 使用异步子进程，保留超时、取消、stdout/stderr 分离、输出上限与进程树清理；
- 回合失败或取消不提交对话历史；若写文件后回合中断，下一回合会收到内存级重新读取提醒，但不会伪装成副作用已回滚；
- 默认写入仅含元数据的本地审计 JSONL，保留 30 天、总量上限 20 MiB；不记录 prompt、正文、路径、diff、工具输入输出或原始 reasoning；
- 项目 `.env` 不会被自动加载；Shell 只继承启动 Syzzz 时已有的进程环境；
- 当前离线测试套件包含 158 项测试，覆盖 Phase 1/1.1 安全回归、Phase 2/2.1 Runtime 与终端契约，以及 Phase 3 搜索、可靠编辑、上下文压缩和 TS/JS 分析闭环。

## 当前不具备的能力

以下内容尚未实现，不应视为当前版本能力：

- Anthropic 真流式；
- 会话保存、恢复和跨进程记忆；
- 持久化代码索引、LSP、跨语言语义数据库和全仓符号引用数据库；
- 费用估算与完整 Provider capability 数据库；
- Shell 沙箱、命令语义分类器和凭证隔离；
- 永久权限模式或工作区外路径逐次授权；
- 文件锁、事务日志、备份和自动回滚；
- 手动 `/compact`、`/status` 与压缩摘要查看；
- TUI、后台任务、并行工具调用或自动审批模型；
- 真正的 `@` 文件/上下文选择器与 `$` Skill 选择器；
- MCP、Hooks、插件、子 Agent 或图形界面；
- 从环境变量自动解析不同 Provider 的 API Key。

## 环境要求

- Node.js 20 或更高版本
- npm
- 一个可用的 Anthropic 或 OpenAI-compatible API 服务

建议使用当前 Node.js LTS 版本；npm 包也通过 `engines.node` 明确要求 Node.js `>=20`。

## 安装

克隆仓库并安装依赖：

```bash
git clone https://github.com/syz0528/Syzzz-Code.git
cd Syzzz-Code
npm install
npm run build
```

将 `syzzz` 注册为全局命令：

```bash
npm link
```

验证安装：

```bash
syzzz --help
```

如果不希望执行 `npm link`，也可以直接运行构建产物：

```bash
node dist/index.js --help
```

## 快速开始

### 1. 初始化配置

```bash
syzzz init
```

首次运行会在用户主目录创建配置文件：

```text
~/.syzzz-code/config.json
```

Windows 上通常对应：

```text
C:\Users\<用户名>\.syzzz-code\config.json
```

### 2. 设置当前供应商的 API Key

```bash
syzzz config set apiKey YOUR_API_KEY
```

> [!CAUTION]
> 通过命令参数输入 API Key 可能使密钥保留在 Shell 历史中。当前版本尚未提供隐藏输入或系统凭据存储；如需降低暴露风险，可直接编辑用户配置文件，并注意文件权限和终端录屏内容。

### 3. 启动对话

```bash
syzzz
```

也可以显式使用 `chat` 子命令：

```bash
syzzz chat
```

交互模式中：

- 输入消息并按 Enter 发送；
- 输入 `/` 立即浏览命令，支持输入过滤、方向键、Enter、Tab、Esc 与最多 8 行滚动；
- `/stream on|off` 切换正文实时展示并保存到用户配置；
- `/model <model>` 在当前 Provider 的 `models` 列表中切换并保存；
- 输入 `/permissions` 查看当前会话权限模式；
- 输入 `/permissions safe|acceptEdits|fullAccess` 切换模式（仅当前进程有效）；
- `/help` 显示注册表中的命令；`/?` 是别名；
- `/exit`、`/quit` 或普通 `exit` 退出；以 `//` 开头可向模型发送字面量 Slash 消息；
- 启用 `fullAccess` 时只有单独输入 `y` 或 `Y` 才会生效；`yes`、空行、EOF 和其他输入均取消；
- `Write`/`Edit` 审批中输入 `y` 仅允许本次，输入 `a` 允许本会话后续编辑，其他输入默认拒绝；
- `Shell` 审批仍为逐次 `[y/N]`，不能通过普通审批升级到 `fullAccess`；
- Provider、工具执行或权限确认期间按一次 `Ctrl+C` 只取消当前操作；
- 在两秒内连续按两次 `Ctrl+C` 退出。

### 4. 发送单次消息

默认文本输出：

```bash
syzzz chat -m "请解释 package.json 中的依赖"
```

可仅为当前进程关闭逐段展示，在回合完成后一次性打印正文：

```bash
syzzz chat -m "请解释 package.json 中的依赖" --stream off
```

机器可读事件输出：

```bash
syzzz chat -m "检查当前项目" --output-format stream-json
```

`stream-json` 的 stdout 只包含一行一个 `AgentEvent`，不含 ANSI、spinner、Provider 启动提示、工具结果正文或工具 metadata。序列化会把非 ASCII 字符写成标准 JSON `\uXXXX` 转义，解析后仍是原始中文或 emoji，避免 Windows PowerShell 5.1 按本地代码页拆坏 UTF-8。它始终实时输出，不能与 `--stream` 同时使用。诊断信息写入 stderr。退出码固定为成功 `0`、失败 `1`、取消 `130`。非交互调用没有审批输入通道，需要审批的工具会 fail closed。

## CLI 命令

```text
syzzz                                           启动交互式对话
syzzz chat                                      启动交互式对话
syzzz chat -m "<message>"                       发送一条消息并退出
syzzz chat -m "<message>" --output-format text  按 UI 配置显示文本
syzzz chat -m "<message>" --stream on|off        覆盖当前进程的正文展示方式
syzzz chat -m "<message>" --output-format stream-json
                                                输出 NDJSON AgentEvent
syzzz init                                      初始化用户配置
syzzz config list                               查看当前 Provider 配置摘要
syzzz config set apiKey <value>                 设置当前 Provider 的 API Key
syzzz switch                                    选择已配置的 Provider 和模型
syzzz --help                                    查看帮助
syzzz --version                                 查看版本
```

`syzzz config list` 只显示 API Key 是否已设置，不会打印完整密钥。

## Provider 配置

配置文件 `~/.syzzz-code/config.json` 是运行时 Provider、模型、UI 和审计设置的唯一数据源。旧配置没有 `audit` 或 `ui` 字段时会自动采用安全默认值。

```json
{
  "currentProvider": "deepseek",
  "audit": {
    "retentionDays": 30,
    "maxBytes": 20971520
  },
  "ui": {
    "streamOutput": true
  },
  "context": {
    "autoCompact": true,
    "defaultWindowTokens": 65536
  },
  "providers": {
    "deepseek": {
      "name": "Deepseek",
      "type": "openai-compatible",
      "model": "deepseek-chat",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "env": {
        "BASE_URL": "https://api.deepseek.com",
        "API_KEY": ""
      }
    }
  }
}
```

### 配置字段

- `currentProvider`：当前 Provider ID，必须存在于 `providers`；
- `name`：CLI 和事件中显示的 Provider 名称；
- `type`：只接受 `anthropic` 或 `openai-compatible`；
- `model`：当前模型，必须包含在同一 Provider 的 `models` 数组；
- `BASE_URL`：API 基地址，不是完整的 `/chat/completions` 地址；
- `API_KEY`：当前以明文保存在用户配置文件中；
- `audit.retentionDays`：审计保留天数，默认 `30`；设为 `0` 可停止后续审计；
- `audit.maxBytes`：启动清理后的审计总量上限，默认 `20971520` 字节；
- `ui.streamOutput`：终端正文是否实时展示，默认 `true`；不改变 Provider 或事件流本身。
- `context.autoCompact`：是否在达到预算阈值时自动压缩，默认 `true`；
- `context.defaultWindowTokens`：模型没有显式窗口信息时采用的保守默认值，默认 `65536`；
- `providers.<id>.modelContextWindows`：可选的模型到 context window token 数映射，切换模型后立即重新评估。

可在 `providers` 中配置多个协议端点，再通过 `syzzz switch` 选择。Provider 配置不会从工作区 `.env` 自动补全；Shell 仍继承启动进程环境，因此当前版本不宣称凭证隔离。

审计文件位于 `~/.syzzz-code/audit/YYYY/MM/DD/<sessionId>.jsonl`。写入或清理失败不会中断 Agent，当前进程只在第一次失败时向 stderr 警告。

## 架构概览

```text
CLI / NDJSON Consumer
  index + interactive + command registry + terminal input + renderer
                    |
                    v
Agent Runtime
  QueryEngine.runTurn() -> AgentEvent
  - working conversation history
  - context budget and compaction
  - serial tool loop and approval policy
  - unique terminal event and rollback boundary
          |                         |
          v                         v
Provider Runner                 Tool Runtime
  timeout / retry / usage         Glob / Grep / Read / Patch
  error classification            Git / Diagnostics / Shell
          |                         |
          |                         v
          |                     TS analysis Worker
          |
          v
Protocol Adapters
  OpenAI-compatible streaming
  Anthropic non-streaming

AgentEvent -> CLI renderer / stream-json / metadata-only audit
```

### Runtime 与事件

[`QueryEngine`](src/engine.ts) 保留稳定导入入口，实际事件化实现位于 [`src/runtime-engine.ts`](src/runtime-engine.ts)。`runTurn()` 发出唯一终态事件后返回 `TurnResult`；兼容 `chat()` 消费同一事件流，并在失败或取消时继续抛出异常。

Provider 响应完整结束后才会提交 Assistant 消息并执行工具。每次 Provider 请求前，Context Manager 会结合 system prompt、工具 schema、消息和模型窗口更新预算；达到阈值时优先压缩可安全拆分的旧消息组。最新工具组通常保留，只有它本身阻止下一次安全请求时才作为完整的 Assistant tool call + Tool Results 原子组压缩。自动压缩启用时，三轮后仍达到硬阈值、没有可压缩组或必要摘要失败都会返回 `context_compaction_failed`，不会继续发送已知超预算请求。失败或取消不提交本轮历史；消费者提前关闭 generator 时会关闭嵌套 Provider、压缩、工具 generator，取消内部等待并释放处理锁。

### Provider 层

[`AIProvider`](src/providers/base.ts) 保留 `chat()`，并允许实现可选 `chatStream()`。[`Provider Runner`](src/providers/runner.ts) 是 timeout、有限重试、usage 与 attempt 事件的唯一所有者；两个 SDK 自身均关闭自动重试。

OpenAI-compatible 适配器聚合碎片化正文、tool-call name/arguments、usage、request ID 和 reported model。原始 reasoning 只在 Provider 内部计数或为工具链回放；reasoning-only `stop` 的禁用 thinking 恢复与普通重试共享 3 次 attempt 和 180 秒预算。

普通终端会将 reasoning-only 和 `stream_options` 的 0ms 兼容恢复显示为瞬时状态，不持久输出内部错误码；`stream-json` 仍保留完整事件，footer 仍计入实际重试次数。

Anthropic 当前明确声明 `streaming: false`，继续走非流式 `chat()`，但仍获得统一错误、重试、usage 和事件语义。

## 权限模式

会话级模式，**不写入**用户配置文件；退出进程后恢复为 `safe`。

| 模式 | 只读工具 | Write / Edit / Patch | Shell |
|------|----------|----------------------|-------|
| `safe`（默认） | 自动 | 每次审批 | 每次审批 |
| `acceptEdits` | 自动 | 自动（仍受工作区与校验约束） | 每次审批 |
| `fullAccess` | 自动 | 自动 | 自动（仍非沙箱） |

所有模式下仍保留：Zod 校验、文件工作区边界、Shell 超时/取消/输出上限、工具轮次上限。

普通工具审批不能进入 `fullAccess`。Safe 模式下，`Write`/`Edit`/`Patch` 可返回“仅本次允许”“本会话允许编辑”或“拒绝”；`Shell` 只允许“仅本次允许”或“拒绝”。切换 `fullAccess` 必须单独执行权限命令并输入 `y`，确认期间按 `Ctrl+C` 只会取消切换。

## 工具

### Glob 与 Grep

`Glob` 使用随包提供的 ripgrep 二进制按模式查找文件，`Grep` 支持正则/字面量、上下文、大小写、glob 与 `content | files | count` 输出。二者均不经过 Shell，遵循 ignore 文件，不跟随 symlink，并强制排除 Git 元数据、凭证与私钥等敏感路径；分页、超时、单行和总输出始终有上限。

### RepoMap

按需分析最多 100 个 TS/JS 文件，提取相对 import/export 图和顶层符号签名，并按显式焦点文件、查询、Git 修改状态与图邻接排序。`path` 可以是目录，也可以是单个 TS/JS 文件；单文件输入会分析其所在目录的关系图并确保该文件优先返回。解析结果仅按 mtime/size 在当前进程缓存，不写磁盘索引，也不自动注入每个 prompt。

### ListDirectory

列出工作区内某个目录的文件与子目录（默认工作区根）。只读、无需审批；路径受工作区与敏感路径策略约束；条目过多时截断。

### Shell

在当前工作区执行非交互式 Shell 命令。Safe/`acceptEdits` 下每次执行都要求用户确认；`fullAccess` 下跳过确认。默认超时为 30 秒，分别限制 stdout 和 stderr，并可通过当前 turn 的 `AbortSignal` 取消。Windows 使用 `cmd.exe`，POSIX 使用 `/bin/sh`；终止进程树属于尽力清理，不构成安全沙箱。

### Read

读取工作区内的普通 UTF-8 文本文件，输入为 `{ path, offset?, limit? }`，行号从 1 开始，默认 500 行、最大 2000 行。结果包含总行数、换行格式、SHA-256 版本和下一页位置；模型可见输出上限为 40 KiB。无范围读取仍受 1 MiB 限制，显式范围最多扫描 8 MiB。读取前后会复核文件类型和 stat；路径继续受真实路径、敏感路径、symlink/junction 与 Windows 特殊路径检查。

### Diagnostics

运行 TypeScript Compiler API 的 `noEmit` 诊断，支持源文件、目录或 `tsconfig.json`。分析 Worker 可取消，最长 60 秒、旧生代内存上限 512 MiB，最多返回 200 项和 40 KiB；不会运行 npm scripts、TypeScript plugins、ESLint、测试或构建。

### Patch

基于 `Read` 返回的 `expectedHash` 执行最多 20 个 `{ oldText, newText }` 操作。每个匹配必须在原文件中唯一，多个操作不得重叠；仅支持精确文本和一致的 CRLF/LF 适配，不进行缩进、引号或语义模糊匹配。审批、并发复核和原子替换与 `Write`/`Edit` 共用同一安全路径。

### Write

创建或覆盖工作区内的 UTF-8 文本文件。Safe 模式下执行前展示 diff 并要求确认；自动放行模式仍会生成内部审批元数据。落盘使用同目录唯一临时文件和 `wx` 创建，写入后 flush，保留原文件 mode，并在最终路径/hash 复核通过后原子替换目标；失败或取消会清理临时文件。

### Edit

使用 `old_string` 和 `new_string` 修改工作区文件。`old_string` 必须恰好匹配一次；可传入 `expectedHash` 拒绝基于旧版本修改。Safe 模式下展示 diff，并与 `Write`/`Patch` 复用审批快照、并发冲突检测和同目录原子替换。

### GitStatus 与 GitDiff

只读查看工作区/暂存区状态和 diff，不接受任意 revision 或 Git 命令。`GitDiff` 关闭 ext-diff 与 textconv，先枚举并过滤安全路径，再生成最多 40 KiB 的结果。

## 测试

安装依赖后运行完整套件：

```bash
npm test
```

该命令先构建 TypeScript，再运行 `tests/*.test.mjs`。当前套件包含 158 项离线测试，主要覆盖：

- Phase 1/1.1 的配置、权限、路径、Read 上限、原子 Write/Edit 和 Shell 生命周期；
- `AgentEvent` 顺序、ID/sequence、唯一终态、历史提交与 generator 提前关闭；
- 审批允许、会话编辑、拒绝、非法选择、缺少 handler 和取消；
- OpenAI 文本/reasoning/tool-call 碎片聚合、usage、request ID、reported model；
- Anthropic 非流式兼容事件；
- ProviderError 分类、硬超时、用户取消、Retry-After、预算、jitter 和禁止副作用重放；
- `stream-json` NDJSON、敏感结果剥离、footer 与退出码；
- Slash 注册、动态候选、未知命令、`//` 转义、模型切换和配置持久化；
- TTY 菜单导航、历史、粘贴、EOF、中文宽度、窗口缩放与异步候选过期；
- 审计 allowlist、内容脱敏、保留期、大小上限、当前文件保护和失败降级；
- 配置导入不会加载工作区 `.env`；
- Glob/Grep 分页、ignore、敏感路径、Read Range、hash、Patch 冲突与 Git diff；
- 上下文估算、85% 阈值、50% 目标、动态工具结果预算、有界摘要输入、工具组原子性与紧急压缩、三轮硬后置条件、压缩取消、模型缩窗与 `context_exceeded` 恢复；
- RepoMap 目录/单文件焦点、import 图、符号、缓存、Worker 取消与宿主参数隔离、Diagnostics 隔离，以及中型 TS 仓库完整编辑验证。

Context Manager 可单独运行 27 项确定性门禁：

```bash
npm run test:context
```

使用当前配置的真实 Provider 运行一次可重复压缩 smoke test：

```bash
npm run smoke:context
```

该命令会构建项目，先在测试进程内以 100K 窗口建立合法旧历史，再缩至 16K 并发起摘要与压缩后续接请求，验证压缩事件、预算下降、唯一标记连续性和唯一终态。它不修改用户配置、不启用审计，也不打印测试正文或摘要，但会消耗当前 Provider 配额。

离线测试不连接真实 AI 服务，不能单独证明每个第三方端点都兼容。Phase 2 的真实 DeepSeek/OpenCode 流式、只读工具链、无效 Key 分类和独立 Node 消费 NDJSON 已通过；Phase 3 的真实 Provider smoke test 与长会话 dogfood 结果见 [`CURRENT_STATUS.md`](CURRENT_STATUS.md)。

## 开发

开发模式：

```bash
npm run dev
```

构建：

```bash
npm run build
```

运行构建产物：

```bash
npm start
```

发布前本地验收：

```bash
npm audit --omit=dev
npm pack --dry-run --json
```

`prepack` 会先执行构建；npm 包采用 `dist` 与 `README.md` 白名单（`package.json` 由 npm 固定包含），不会打入 `src`、`tests`、`archive` 或本地配置样例。本阶段只验证包内容，不发布、打 Tag 或调整版本号。

项目结构：

```text
src/
|-- index.ts
|-- interactive.ts
|-- interactive-commands.ts
|-- terminal-input.ts
|-- cli-renderer.ts
|-- engine.ts
|-- runtime-engine.ts
|-- events.ts
|-- audit.ts
|-- config.ts
|-- types.ts
|-- permissions/
|   |-- mode.ts
|   `-- policy.ts
|-- providers/
|   |-- base.ts
|   |-- factory.ts
|   |-- anthropic.ts
|   |-- openai-compatible.ts
|   |-- errors.ts
|   `-- runner.ts
`-- tools/
    |-- index.ts
    |-- runtime.ts
    |-- workspace.ts
    |-- file-changes.ts
    |-- shell-runner.ts
    `-- abort.ts

tests/
|-- cli.test.mjs / terminal-input.test.mjs
|-- interactive-commands.test.mjs / cli-renderer.test.mjs
|-- engine.test.mjs / runtime-events.test.mjs
|-- provider-*.test.mjs / openai-stream.test.mjs
|-- tools.test.mjs / shell-runner.test.mjs
`-- audit.test.mjs / config.test.mjs
```

## 安全限制

使用当前版本前，请理解以下风险：

1. 获批的 `Shell` 命令仍可以执行当前系统账户有权执行的任意操作，工作区约束只适用于文件工具；
2. 文件边界和敏感路径拦截会降低误操作风险，但不是操作系统级隔离；最终路径/hash 复核到 `rename` 之间仍有极小 TOCTOU 窗口；
3. 模型读取到的文件内容和工具结果可能被发送给远程 Provider；
4. API Key 当前明文保存在用户配置文件中；
5. 审批依赖用户审查命令和 diff，不能自动消除提示注入或恶意命令风险；
6. Windows PowerShell/Toolhelp 进程树终止和 POSIX 进程组终止都是尽力清理，不能等同于容器或沙箱；
7. 失败回合不会提交消息历史，但已经发生的外部副作用不会自动撤销；
8. Shell 继承启动进程环境，当前没有凭证过滤、命令 allowlist 或网络隔离。

建议：

- 在临时仓库副本、容器、虚拟机或低权限账户中试用；
- 不要在包含生产凭据、SSH Key 或敏感数据的目录中运行；
- 执行前后检查 `git status` 和 `git diff`；
- 对模型生成的 Shell 命令和代码修改保持人工审查；
- 不要将 `~/.syzzz-code/config.json`、终端录屏或真实 API Key 提交到 Git。

## 后续方向

Phase 1/1.1、Phase 2/2.1 与 Phase 3 均已冻结。Phase 3 完成了有界代码搜索、Range Read、可靠 Patch、Git 只读检查、Context Manager、自动 compaction 与 TS/JS 按需分析。

下一阶段进入 Phase 4：会话、模式与终端产品体验。会话恢复、完整 TUI、MCP、Hooks 与子 Agent 仍不属于当前能力。

## 项目状态

包版本仍为 `1.0.0`，未发布 npm 包、未创建 Tag。Phase 3 工作位于 `codex/phase3-context`，基线为远程 `origin/codex/phase2-runtime` 的 `1bcc967`。

当前 Phase 3 状态为 **Frozen**：完整 158 项自动化测试、生产依赖审计、npm 包内容检查、真实 RepoMap/Diagnostics、CRLF Patch、自动压缩、模型缩窗与压缩取消均已通过；冻结后的 Context Hardening 补丁进一步关闭了小窗口下的工具结果和摘要请求超预算路径。详细证据和残余边界见 [`CURRENT_STATUS.md`](CURRENT_STATUS.md)。

当前版本仍属实验阶段，不代表 Shell 已被沙箱化，也不代表完整的自动化编程 Agent。历史资料保存在 [`archive/pre-v1.0.0`](archive/pre-v1.0.0)，不作为当前功能或安全说明。
