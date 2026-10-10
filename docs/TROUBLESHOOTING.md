# 故障排查

遇到问题时，先在项目目录运行：

```bash
syzzz doctor
syzzz config list
syzzz --version
```

分享诊断输出前，请删除项目名、路径、Provider request ID 和任何可能的凭证。`doctor` 本身不会输出 API Key。

## 安装与启动

### 安装后找不到 `syzzz`

症状：PowerShell、cmd 或 shell 提示 `syzzz` 不是命令。

检查：

```bash
npm prefix --global
npm list --global --depth=0
```

重新打开终端，让 `PATH` 变化生效。仍不工作时重新安装：

```bash
npm uninstall --global syzzz-code
npm install --global syzzz-code@1.0.0
```

### Node.js 版本不支持

Syzzz Code 要求 Node.js 22 或更高版本：

```bash
node --version
```

建议使用当前 Node.js 22 LTS 或经过 CI 验证的 Node.js 24。

### `Cannot find module .../dist/index.js`

源码运行前必须构建：

```bash
npm ci
npm run build
node ./dist/index.js --help
```

PowerShell 变量只在当前终端会话中存在。使用 `$Repo` 等变量前先赋值，或者直接在仓库根目录运行相对路径。

## 配置

### 没有 API Key

```bash
syzzz config set apiKey
```

或引用环境变量：

```bash
syzzz config set apiKey --from-env <ENVIRONMENT_VARIABLE>
```

确认启动 Syzzz Code 的同一进程环境中确实存在该变量。

### 配置损坏

```bash
syzzz doctor
syzzz doctor --repair-config
```

修复会先备份原文件。未知未来 schema 不会被当前版本覆盖，应先升级 Syzzz Code。

### 修改配置后没有生效

退出并重新启动当前会话。Provider、model、RAG 远程服务或扩展配置变化可能需要重新评估上下文、连接或授权。

## Provider 与模型

### `provider returned an empty response`

含义：服务返回了终止状态，但没有正文和可执行工具调用。

检查：

1. 模型名称是否真实存在且当前账号可用。
2. Base URL 是否对应正确协议。
3. 服务是否把全部内容放入私有 reasoning 字段。
4. 是否有网关过滤了正文或 tool call。

DeepSeek reasoning-only 响应具有一次受限恢复；恢复仍为空时会明确失败，不会无限重试。

### `provider returned only reasoning content`

服务只返回了 reasoning，没有用户可见正文或工具调用。Syzzz Code 不会把原始 reasoning 当作回答公开。这可能来自模型端的偶发行为，也可能是协议字段映射不正确。

先重试一个新回合；若稳定复现，核对 Provider `type`、模型和端点，并保存脱敏 request ID 用于报告。

### `Provider stream ended before a finish reason was received`

流在协议终态前结束。常见原因：

- 把 Responses 端点配置成 `openai-compatible`。
- 把 Chat Completions 端点配置成 `openai-responses`。
- 网关或网络连接提前关闭。
- 服务实现没有发送标准终止事件。

Chat Completions 和 Responses 必须使用独立 Provider 配置。详见 [Provider 配置指南](PROVIDERS.md)。

### 401、403、404 或 model not found

- 401：检查 Key 是否属于该 endpoint。
- 403：账号、组织或模型权限不足。
- 404：Base URL、协议路径或模型名称不正确。
- model not found：模型未配置、已下线或当前账户不可见。

### 429、timeout 或 network

Syzzz Code 只对安全的瞬时错误进行有限重试，并尊重有界 `Retry-After`。一旦已显示正文或收到工具碎片，不会重放请求，避免重复副作用。

先区分错误发生在哪一层：

- 尚未收到 HTTP 响应，约 10 秒报连接超时：可能是 DNS、TCP、代理隧道或 TLS 握手问题；不能据此判断模型生成慢、上下文不足或被限流。
- 已收到 HTTP 429 或 5xx：根据状态码、服务商状态与 `Retry-After` 排查，不把它归为本地连接错误。
- 等到整次请求截止时间仍未返回：表示本次请求预算耗尽；若没有 HTTP 状态，还不足以区分服务端等待与网络停滞。
- 已有流式正文后失败：保留已产生的内容与执行回执，核对是否存在未决操作，不盲目重放工具。

增加整次请求超时，不等于自动延长底层连接超时。一次短探针成功也不能证明完整多请求任务稳定；应保留失败记录，再用独立任务验证。

如果网络确实需要你信任的本地 HTTP 代理，可在新的 PowerShell 窗口中临时启用 Node 原生代理支持。下面示例适用于 Node 24.13.0；端口请替换为自己的实际配置，其他 Node 版本先核对其官方说明：

```powershell
node --version
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1,::1"
$env:NODE_USE_ENV_PROXY = "1"
syzzz
```

这些设置仅影响该窗口启动的进程，关闭窗口即可结束，不需要修改注册表。`NO_PROXY` 保持本地模型服务直连；使用自定义内网服务时，按实际地址补充。浏览器或 Windows 的代理设置不保证 Node 请求自动使用同一代理。[Node 24.13.0 原生代理说明](https://nodejs.org/download/release/v24.13.0/docs/api/cli.html#--use-env-proxy)。

若本地代理能连接，但经代理访问服务端仍偶发 TLS 失败，先检查代理节点、分流规则和服务商可用性。不要关闭证书验证、全局降低 TLS 配置或无限重试。本地诊断中限制单个进程使用 TLS 1.2 曾让短探针通过，但后续完整任务仍出现请求超时，因此这不是已验证的正式修复，也不作为产品默认设置。

## TUI 与终端

### TUI 闪烁、残留或重复刷新

先查看：

```text
/ui status
```

临时切换 inline：

```bash
syzzz --ui inline
```

Windows 内嵌终端通常自动使用 conservative renderer。也可在启动前设置诊断覆盖：

```powershell
$env:SYZZZ_TUI_PROFILE = "conservative"
syzzz
```

该变量只用于排查，不建议长期覆盖一个工作正常的终端策略。

### 滚轮把旧命令放进输入框

某些 Windows 内嵌终端会把滚轮转换为与方向键完全相同的字节。Syzzz Code 在识别为 `codex` 或 Windows `unknown` 主机时启用 arrow-fallback：

- 滚轮和裸 `Up/Down` 滚动对话。
- `Ctrl+P/Ctrl+N` 浏览输入历史。
- 多行 Composer、候选菜单和 AskUser 仍保留方向键语义。

通过 `/ui status` 检查 `Wheel input`。

### 鼠标事件出现为奇怪文字

当前输入解码器支持 SGR、URXVT、X10 和部分内嵌终端变体。若仍出现控制序列：

1. 记录 `/ui status`。
2. 使用 `syzzz --ui inline` 完成当前任务。
3. 报告终端名称、操作系统和最小复现步骤，不要附带敏感对话正文。

### `Shift+Enter` 直接提交

部分旧终端无法区分 Enter 与 Shift+Enter。使用：

```text
Ctrl+J
```

或检查终端映射：

```text
/terminal-setup status
/terminal-setup install
```

安装会备份设置，并拒绝覆盖已有冲突键位。

### 中文或 Emoji 光标错位

优先使用 Windows Terminal 或现代支持 Unicode 的终端，确认字体同时支持中文和 Emoji。频繁发生时提供终端尺寸、字体和 `/ui status`，并用 `--ui inline` 判断是否仅为 fullscreen 渲染问题。

### 无法复制正文

TUI 支持左键拖选后自动复制，并显示短暂提示。终端必须允许 OSC 52 或对应剪贴板机制。终端策略阻止自动复制时，可改用 inline 界面和终端原生选择。

## 会话

### `--continue` 被 PowerShell 当作错误命令

`--continue` 是 `syzzz` 的参数，不能单独运行：

```powershell
syzzz --continue
```

在 Syzzz 交互界面内使用 `/resume`，在 PowerShell 提示符中使用 `syzzz --resume <id>`。

### `/resume` 只看到少量会话

会话按规范化工作区隔离。请确认当前目录与创建会话时相同：

```bash
syzzz sessions list
```

跨工作区会话不会自动显示或恢复。

### `No session matches`

可能原因：

- 当前目录不是原工作区。
- 会话已删除。
- 输入的前缀不唯一或不存在。
- 使用了另一个临时测试工作区的 Session ID。

### 会话被锁定

另一个进程正在使用该会话时，Syzzz Code 会拒绝并发恢复或删除。先正常退出另一进程。死亡进程或过期锁会在安全验证后回收。

## 文件与编码

### `is not valid UTF-8`

AGENTS、SKILL 和普通文本工具只接受 UTF-8。Windows PowerShell 创建中文文件时明确指定编码：

```powershell
Set-Content -LiteralPath .\AGENTS.md -Encoding UTF8 -Value '项目规则'
```

### `Path is outside the workspace`

文件工具只访问当前工作区。需要处理外部知识目录时，应由用户显式注册 RAG 外部集合；不要通过 symlink 或路径别名绕过工作区边界。

### 文件在审批后发生变化

Write、Edit 和 Patch 会复核审批快照与当前 hash。外部程序在审批后修改文件时，操作会冲突失败。重新 Read，再根据新版本生成修改。

## MCP、Hooks 与 Skills

### 项目 MCP 或 Hook 没有加载

```text
/extensions
/trust
/extensions reload
```

项目配置摘要变化后必须重新信任。信任扩展不等于授予 Agent 文件编辑或 `fullAccess`。

### Hook 拒绝 Shell

Hook 拒绝优先于权限审批，`fullAccess` 也不能绕过。检查：

```bash
syzzz hooks list
syzzz hooks doctor
```

### MCP 工具不可见

```bash
syzzz mcp list
syzzz mcp doctor <name>
```

确认 Server enabled、项目已信任、工具未被本地 policy 设为 `disabled`，以及协议模式与 Server 一致。

### Skill 不可用

```bash
syzzz skills list
syzzz skills inspect <name>
syzzz skills validate <name>
syzzz skills doctor
```

检查 `SKILL.md` 是否为 UTF-8、frontmatter 是否包含合法 name/description，以及 `agents/openai.yaml` 是否损坏。损坏 OpenAI metadata 不妨碍显式调用，但会关闭隐式激活。

## RAG

### RAG 显示 `stale`

```bash
syzzz rag refresh workspace
```

外部集合则替换为集合名。大量文件变化不会在检索前自动执行昂贵刷新。

### RAG 显示 `degraded`

```bash
syzzz rag doctor
```

LanceDB 或远程 Embedding 不可用时，MiniSearch 词法检索继续工作。向量维度或模型不匹配的旧索引不会与新向量混用。

### 导入文档后检索不到

```bash
syzzz rag status
syzzz rag refresh library
syzzz rag search "<query>"
```

确认文件是受支持的普通 UTF-8 文本，未超过大小限制，也没有被 ignore 或敏感路径规则排除。

### 引用警告

`[[rag:<chunkId>]]` 必须来自本轮 `RagRead`，并匹配 revision、source hash 和行范围。源文件变化或会话恢复后 receipt 过期时，应重新检索和读取。

## NDJSON 与 PowerShell

推荐逐行解析：

```powershell
$events = @(
  syzzz chat -m "只回复 OK" --mode ask --output-format stream-json |
    ForEach-Object { $_ | ConvertFrom-Json }
)
```

当前 NDJSON 使用 ASCII-safe JSON，中文会安全转义。不要把 TUI 或普通 text 输出送给 `ConvertFrom-Json`。

## 报告问题

请包含：

- Syzzz Code 与 Node.js 版本。
- 操作系统和终端名称。
- `/ui status` 或 `syzzz doctor` 的脱敏输出。
- 最小复现步骤。
- 实际行为和期望行为。

不要提交 API Key、配置全文、用户提示、项目源码、会话快照、审计文件或 RAG 正文。
