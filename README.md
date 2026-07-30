# Syzzz Code

Syzzz Code 是一个使用 TypeScript 构建的实验性命令行 AI 编程 Agent。它提供统一的 Provider 接口、事件化 Agent Runtime、受约束的代码库工具、可靠编辑、上下文压缩、可恢复的本地会话，以及受信任边界约束的 MCP、Hooks 和只读 Subagent。

Phase 1 至 Phase 5.1 已完成并保持 **Frozen**。Phase 6 的本地实现和自动化已完成，当前状态为 **Implemented**；跨平台 CI、人工候选包验收与公开注册表发布尚未完成，因此不标记 Frozen。

> [!WARNING]
> Syzzz Code 仍处于实验阶段。文件工具受工作区边界、敏感路径和并发 hash 校验保护，但 Shell 不是 OS sandbox。获批或在 `fullAccess` 下自动执行的命令仍可产生工作区外副作用。

> [!IMPORTANT]
> 自动保存的会话包含完整但有界的模型可见上下文，其中可能包含用户提示、代码和工具结果。会话仅保存在本机 `~/.syzzz-code/sessions`，但当前版本不提供 Keychain、磁盘加密或云端同步。

## 核心能力

### Agent Runtime

- `QueryEngine.runTurn()` 以 `AsyncGenerator<AgentEvent, TurnResult>` 输出版本化事件流。
- OpenAI-compatible Provider 支持真实流式文本、reasoning 状态、tool call 聚合和 usage。
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
- `acceptEdits`：本会话自动允许编辑，Shell 仍逐次审批。
- `fullAccess`：本会话跳过普通审批，但不能绕过 ask/plan 的只读边界。

新会话默认使用 `code + safe`。从 plan 进入执行必须显式输入 `/code`。

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
- 默认在 `min(window * 85%, window - 8192)` 触发自动压缩，目标降到窗口的 50%。
- Assistant tool call 与对应 Tool Result 作为不可拆分原子组。
- `/compact` 可手动压缩；失败、取消、空历史或无可压缩内容不会修改会话历史。
- Provider 返回 `context_exceeded` 且尚未输出正文或工具碎片时，可进行一次强制压缩恢复。
- 文件写入成功后若回合失败或取消，会保存重新读取回执，并在恢复后的下一回合提醒 Agent。

### 会话恢复

- 交互模式默认自动保存，新启动默认创建新会话。
- `syzzz --continue` 恢复当前工作区最近会话。
- `syzzz --resume <id>` 按完整 ID 或唯一前缀恢复。
- `/new` 创建新会话；`/clear` 是其别名，旧会话不会删除。
- `/resume`、`/rename`、`/save` 和 `/compact` 管理当前会话。
- 恢复时保留工作模式，权限始终重置为 `safe`。
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
- 一个 Anthropic 或 OpenAI-compatible API 服务

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
    "streamOutput": true
  },
  "context": {
    "autoCompact": true,
    "defaultWindowTokens": 65536
  },
  "sessions": {
    "autoSave": true
  },
  "subagents": {
    "enabled": true
  }
}
```

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
syzzz --continue
syzzz --resume <id-or-prefix>
```

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

Runtime
/permissions [mode]                    查看或切换权限
/model [model]                         切换当前 Provider 的配置模型
/provider [provider]                   切换本地已配置 Provider
/stream on|off                         控制正文是否逐段显示

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

裸 `/` 按稳定优先级展示常用命令，输入命令片段后按匹配度过滤；`/help` 按上述类别分组。`/?`、`/quit` 是别名。以 `//` 开头可向模型发送字面 Slash 消息。

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
```

`syzzz doctor` 与 `syzzz extensions status` 始终离线；只有 `syzzz mcp doctor` 会连接服务器。项目范围使用 `--scope project`，配置变更后必须重新 `/trust`。HTTP 自定义头必须引用 `${ENV_NAME}`，不会把认证值写入扩展配置；被 Provider 配置声明为凭证来源的环境变量不能再被 MCP 或 Hook 模板引用。

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

审计只记录 turn、Provider、retry、usage、审批结果、工具 outcome、MCP/Hook/Subagent 健康元数据、压缩状态和终态，不记录 prompt、正文、URL、认证头、文件路径、diff、工具输入输出、Shell 输出、Hook payload、Subagent transcript 或原始 reasoning。

会话快照与审计的隐私边界不同。会话为了恢复模型上下文，会保存有界的用户消息、Assistant 消息、MCP 工具结果和 Subagent 最终报告。通过 `sessions.autoSave=false` 可关闭后续自动保存，但 `/save` 仍可显式保存。

## 开发与验证

```bash
npm run build
npm test
npm run lint
npm run format:check
npm run test:coverage
npm run test:providers
npm run eval:offline
npm run pack:check
npm run smoke:package
npm audit --omit=dev --audit-level=high
git diff --check
```

自动化套件覆盖 Phase 1 至 Phase 5.1 的路径与权限安全、事件 Runtime、Provider 可靠性、终端交互、代码库上下文、压缩、会话恢复、配置迁移、Trust V2、MCP 传输与策略、Hooks 和只读 Subagent 预算。Phase 6 另增加四种离线 Provider 协议 Profile、七项固定 Coding Agent Eval、覆盖率门槛、Git 历史 Secret 扫描、依赖许可证检查和候选包安装测试。

当前本地基线为 277/277 项测试通过，覆盖率最新测得 Lines 83.61%、Branches 76.04%、Functions 86.57%，离线 Eval 7/7 通过；真实 DeepSeek/OpenCode Live Eval 同样以 7/7、功能成功率 100%、安全项通过且无基础设施错误完成。

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
- 当前没有完整 TUI、并行工具、后台任务、`@` 上下文或 `$` Skills。

## 当前阶段

Phase 1 至 Phase 5.1 均保持 **Frozen**。Phase 6 位于 `codex/phase6-quality-release`，当前状态为 **Implemented**；只有跨平台 CI 和候选包 job 实际通过后才进入 **Validated**。人工 dogfood、npm、annotated Tag、GitHub Release 与 registry 安装复验完成前，版本 `1.0.0` 仍不是 Frozen。
