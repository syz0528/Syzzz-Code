# Syzzz Code

Syzzz Code 是一个使用 TypeScript 构建的实验性命令行 AI 编程 Agent。它提供统一的 Provider 接口、事件化 Agent Runtime、受约束的代码库工具、可靠编辑、上下文压缩，以及可恢复的本地会话。

当前实现已完成 Phase 1 至 Phase 4 的主体能力，目标是成为一个安全边界清晰、可观察、可恢复，并适合在真实代码库中持续使用的本地编程助手。

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

## 环境要求

- Node.js 20 或更高版本
- npm
- 一个 Anthropic 或 OpenAI-compatible API 服务

## 安装

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

审计只记录 turn、Provider、retry、usage、审批结果、工具 outcome、压缩状态和终态等元数据，不记录 prompt、正文、文件路径、diff、工具输入输出、Shell 输出或原始 reasoning。

会话快照与审计的隐私边界不同。会话为了恢复模型上下文，会保存有界的用户消息、Assistant 消息和工具结果。通过 `sessions.autoSave=false` 可关闭后续自动保存，但 `/save` 仍可显式保存。

## 开发与验证

```bash
npm run build
npm test
npm audit --omit=dev
npm pack --dry-run --json
git diff --check
```

当前自动化套件包含 190 项测试，覆盖 Phase 1 至 Phase 4 的路径与权限安全、事件 Runtime、Provider 可靠性、终端交互、代码库上下文、压缩、会话恢复、配置迁移和凭证输入。

npm 包使用 allowlist，只包含 `dist`、`README.md` 和 npm 固定元数据，不包含 `src`、`tests`、`archive`、本地配置或历史报告。

## 已知边界

- Shell 不是 OS sandbox，也没有凭证隔离、命令 allowlist 或语义安全分类器。
- 文件最终 hash 复核到 rename 之间仍有极小 TOCTOU 窗口。
- token 估算不是精确 tokenizer；只有 Provider 上报 usage 是已发生请求的权威值。
- 压缩摘要可能丢失低相关细节。
- Anthropic 尚未实现真实流式。
- RepoMap 与 Diagnostics 仅提供 TS/JS 按需轻量分析，不是 LSP 或持久化语义索引。
- 会话没有加密、云同步、fork/rewind 或跨工作区迁移。
- 当前没有完整 TUI、MCP、Hooks、并行工具、后台任务或子 Agent。

## 当前阶段

Phase 4 已完成实现、自动化验证、内部 dogfood 和用户手动验收，当前状态为 **Frozen**。后续除 P0 安全、数据破坏或会话恢复错误外，不再向 Phase 4 增加能力，下一项进入 Phase 5 规划。版本号保持 `1.0.0`，尚未发布 npm 包或创建 Tag。
