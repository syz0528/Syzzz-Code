# Syzzz Code

[![CI](https://github.com/syz0528/Syzzz-Code/actions/workflows/ci.yml/badge.svg)](https://github.com/syz0528/Syzzz-Code/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Syzzz Code 是一个本地优先、可扩展的命令行 AI 编程 Agent。你可以在终端中让它阅读项目、解释代码、制定计划、修改文件、运行测试、恢复历史会话，并通过 Skills、MCP、Hooks 和本地 RAG 扩展工作流。

本文档面向第一次接触编程 Agent 的用户，也适用于准备部署 Syzzz Code `1.0.0` 的开发者。

开发分支中的 [KnowForge 统一模型与知识服务接入](docs/knowforge-service.md) 为可选功能，尚未发布到 npm；正式版用户仍按下方本地 RAG 说明使用。

> [!WARNING]
> Syzzz Code 可以修改文件和执行 Shell 命令。文件工具具有工作区边界、敏感路径检查、并发 hash 校验和原子写入保护，但 Shell 不是操作系统沙箱。请在审批前阅读命令和文件差异，不要在不受信任的项目中启用 `fullAccess`。

## 目录

- [五分钟快速开始](#五分钟快速开始)
- [第一次使用](#第一次使用)
- [理解工作模式与权限](#理解工作模式与权限)
- [终端界面](#终端界面)
- [常用工作流](#常用工作流)
- [会话与上下文](#会话与上下文)
- [项目指令、显式上下文与 Skills](#项目指令显式上下文与-skills)
- [MCP、Hooks 与 Subagent](#mcphooks-与-subagent)
- [本地 RAG](#本地-rag)
- [Provider 配置](#provider-配置)
- [数据、隐私与安全](#数据隐私与安全)
- [故障排查](#故障排查)
- [卸载](#卸载)

## 五分钟快速开始

### 1. 环境要求

- Node.js 22 或更高版本；自动化验证 Node.js 22 和 24。
- npm。
- Windows Terminal、PowerShell、macOS Terminal 或常见 Linux 终端。
- 至少一个可用的 Anthropic、OpenAI-compatible Chat Completions 或 OpenAI Responses 服务。
- Git 为推荐依赖；Skill 安装和部分项目工作流需要它。

确认 Node.js 版本：

```bash
node --version
npm --version
```

### 2. 安装正式版

```bash
npm install --global syzzz-code@1.0.0
```

验证安装：

```bash
syzzz --version
syzzz --help
```

从源码构建仅适合开发和排查：

```bash
git clone https://github.com/syz0528/Syzzz-Code.git
cd Syzzz-Code
npm ci
npm run build
npm link
```

### 3. 初始化配置

Syzzz Code 默认创建一个 DeepSeek Provider。首次使用可运行：

```bash
syzzz init
syzzz config set apiKey
syzzz doctor
```

`syzzz config set apiKey` 会隐藏终端输入，但密钥仍以明文保存在本机 `~/.syzzz-code/config.json`。更推荐只保存环境变量名：

```bash
syzzz config set apiKey --from-env DEEPSEEK_API_KEY
```

此时应由操作系统、终端配置或 Secret Manager 提供 `DEEPSEEK_API_KEY`。Syzzz Code 不会把配置文件中的 Provider Key 注入 Shell 工具环境。

查看当前配置时不会输出密钥：

```bash
syzzz config list
```

### 4. 在项目中启动

```bash
cd <project-directory>
syzzz
```

交互式 TTY 默认打开全屏 TUI。非 TTY、无障碍模式或不兼容终端会使用 inline 界面。可显式指定：

```bash
syzzz --ui tui
syzzz --ui inline
```

## 第一次使用

### 先让 Agent 只读了解项目

在输入框中发送：

```text
/ask 请只读分析当前项目，说明主要目录、启动入口和测试方式，不要修改文件。
```

`ask` 模式只提供只读工具，即使当前权限是 `fullAccess`，Agent 也不能写文件或执行 Shell。

### 让 Agent 制定计划

```text
/plan 请规划为这个项目增加一个健康检查命令，列出要修改的文件和验证步骤。
```

`plan` 模式完成后仍保持只读。阅读计划并确认方向后，再显式进入执行模式：

```text
/code 按刚才的计划实施，完成后运行最小必要测试。
```

### 审批一次修改

在默认 `safe` 权限下，Write、Edit、Patch 和 Shell 会先展示操作内容：

```text
[y] 本次允许
[a] 本会话允许文件编辑
[N] 拒绝
```

Shell 始终使用 `[y/N]` 单次确认，除非当前进程明确启用了 `fullAccess`。

## 理解工作模式与权限

工作模式和权限是两套独立边界。

### 工作模式

| 模式   | 用途                   | 可写文件   | 可执行 Shell |
| ------ | ---------------------- | ---------- | ------------ |
| `ask`  | 只读问答和代码解释     | 否         | 否           |
| `plan` | 只读探索并制定实施计划 | 否         | 否           |
| `code` | 修改代码和执行验证     | 取决于权限 | 取决于权限   |

切换方式：

```text
/ask
/plan
/code
```

也可以在切换模式的同时提交任务：

```text
/plan 分析登录流程并给出修复方案
```

### 权限模式

| 权限          | 文件编辑                     | Shell    | 是否持久化             |
| ------------- | ---------------------------- | -------- | ---------------------- |
| `safe`        | 每次审批                     | 每次审批 | 默认状态               |
| `acceptEdits` | 可允许当前会话或工作区的编辑 | 每次审批 | 仅持久化编辑授权       |
| `fullAccess`  | 自动执行                     | 自动执行 | 永不持久化，仅当前进程 |

```text
/permissions
/permissions safe
/permissions acceptEdits
/permissions fullAccess
```

启用 `fullAccess` 时只接受单独输入的 `y` 或 `Y`。`yes`、空行、EOF 和其他输入都会取消。

## 终端界面

### 输入和导航

- `Enter`：提交消息。
- `Shift+Enter`：终端能够区分时插入换行。
- `Ctrl+J`：所有支持终端中的稳定换行方式。
- `/`：浏览本地命令。
- `@`：选择工作区文件或目录作为显式上下文。
- `$`：选择并激活 Skill。
- `PageUp` / `PageDown`、鼠标滚轮或右侧滚动条：浏览对话历史。
- `Ctrl+Home` / `Ctrl+End`：跳到历史顶部或底部。
- `Ctrl+O`：展开或收起最近一项工具详情。
- `Esc`：关闭候选、详情或当前选择。
- `Ctrl+C`：先关闭面板或取消当前操作；空闲输入框中两秒内按两次退出。

在把鼠标滚轮转换为方向键的 Windows 内嵌终端中，滚轮和裸 `Up/Down` 用于滚动对话，`Ctrl+P/Ctrl+N` 用于浏览输入历史。运行 `/ui status` 可以查看当前终端策略。

### 流式显示

```text
/stream on
/stream off
/setting fps auto
/setting fps 30
/setting fps 60
```

`/stream off` 只关闭终端中的渐进正文显示，Provider 和 `AgentEvent` 仍保持流式。Provider 本身只返回完整文本块时，Syzzz Code 不会伪造逐字符动画。

### 中文与英文界面

```text
/language auto
/language zh-CN
/language en
```

语言设置只影响 Syzzz Code 自带命令、选项和本地状态。模型名、第三方 MCP 输出和 Skill 作者提供的文字保持原文。

完整按键和命令表见 [命令参考](docs/COMMANDS.md)。

## 常用工作流

### 解释代码

```text
/ask 请解释 @src/index.ts 的职责，以及它如何创建 Provider。
```

### 修复 Bug

```text
/code 定位这个测试失败的根因，进行最小修改，并运行相关测试。不要修改无关文件。
```

### 审查当前变更

```text
/ask 使用 GitDiff 和必要的只读工具审查当前修改，优先报告安全回归和遗漏测试。
```

### 一次性非交互调用

```bash
syzzz chat -m "只读说明这个项目如何运行测试" --mode ask
```

机器消费的 NDJSON：

```bash
syzzz chat -m "分析当前项目" --mode ask --output-format stream-json
```

`stream-json` 的标准输出只包含一行一个 `AgentEvent`，不包含 ANSI、spinner 或 Provider 启动文字。

## 会话与上下文

交互会话默认自动保存，并按规范化工作区隔离。启动时可以选择继续最近会话或新建会话。

```bash
syzzz --continue
syzzz --resume <session-id-or-prefix>
syzzz sessions list
syzzz sessions delete <session-id-or-prefix>
syzzz sessions prune --older-than 30
```

交互命令：

```text
/status
/new [title]
/resume [id-or-prefix]
/rename <title>
/save
/compact
```

上下文窗口由模型专属配置优先决定，没有专属配置时使用 fallback：

```text
/context 64k
/context 128k
/context 200k
/context reload
```

默认自动压缩会在接近窗口上限时保留最新问题和完整工具调用组，再总结旧历史。压缩失败或取消不会提交不完整摘要。

## 项目指令、显式上下文与 Skills

### 显式上下文

```text
请根据 @README.md 回答安装要求。
请检查 @src/runtime-engine.ts#L100-L180。
请比较 @"docs/design notes.md" 和 @docs/decisions.md。
```

`@@` 表示普通 `@` 字符。文件必须位于工作区内，是普通 UTF-8 文件，并通过敏感路径和 symlink 检查。

### AGENTS.md

Syzzz Code 支持：

- 用户级 `~/.syzzz-code/AGENTS.md`。
- 从 Git 根目录到当前目录的分层 `AGENTS.md`。
- 接触嵌套目录时按需加载更近的 `AGENTS.md`。

AGENTS 内容属于 user-level 指令，不能提升权限或绕过工具执行边界。

### Skills

输入 `$` 可以浏览当前可用 Skill：

```text
$skill-name 任务说明
```

常用管理命令：

```bash
syzzz skills list
syzzz skills inspect <name>
syzzz skills doctor
syzzz skills install <public-https-git-url>
syzzz skills create <name> --description "Skill description"
syzzz skills validate <name>
syzzz skills test <name>
```

用户级 Skill 默认安装到 `~/.agents/skills`。Skill 可以提供说明、资源和脚本，但不能自行授权工具；脚本只有在 `code` 模式中由 Shell 明确调用并经过现有审批后才会运行。

## MCP、Hooks 与 Subagent

### MCP

```bash
syzzz mcp list
syzzz mcp add <name> <command> [args...]
syzzz mcp add <name> --url <https-endpoint>
syzzz mcp doctor <name>
```

项目 MCP 和 Hooks 必须先经过 `/trust`。项目配置变化后会进入 `review-required` 并要求重新确认。MCP 工具按远端 annotation 和本地 policy 映射风险，`disabled` 工具无法被 `fullAccess` 绕过。

### Hooks

Hooks 是用户授权的本地进程。`PreToolUse` 可以拒绝工具调用，但不能授权、改写输入或提升权限。

```bash
syzzz hooks list
syzzz hooks doctor
```

### 只读 Subagent

```text
/agents on
/agents off
```

`Delegate` 只支持 `explore` 和 `review`，使用隔离上下文和只读工具，并受时间、token、工具轮次和调用次数限制。

扩展配置和信任边界见 [扩展使用指南](docs/EXTENSIONS.md)。

## 本地 RAG

RAG 用于从工作区或用户指定的知识目录中检索长期资料。默认不自动建立索引，不会在未确认时把文件发送给远程 Embedding 或 reranker。

### 索引当前工作区

```bash
syzzz rag status
syzzz rag index workspace
syzzz rag search "权限审批如何工作"
```

文件变化后：

```bash
syzzz rag refresh workspace
```

### 添加一份文档到个人知识库

```bash
syzzz rag add "<document-path>"
syzzz rag add "<document-path>" --name architecture-notes.md
```

Syzzz Code 会先显示目标文件和差异，确认后才复制到用户级受管理知识库。也可以在 `code` 模式要求 Agent 整理当前讨论并通过 `SaveKnowledge` 保存，写入仍需要审批。

### 外部知识集合

```bash
syzzz rag collections add team-docs --path "<knowledge-directory>"
syzzz rag mount team-docs
syzzz rag index team-docs
syzzz rag search "部署规范"
```

未配置 Embedding 时，MiniSearch 词法检索仍可使用。完整的切片、向量检索、RRF、reranker、引用验证、隐私和更新流程见 [本地 RAG 使用说明](docs/RAG.md)。

## Provider 配置

配置文件位于：

```text
~/.syzzz-code/config.json
```

Provider 必须明确选择协议：

| `type`              | 对应接口                         |
| ------------------- | -------------------------------- |
| `openai-compatible` | OpenAI Chat Completions 兼容接口 |
| `openai-responses`  | OpenAI Responses 兼容接口        |
| `anthropic`         | Anthropic Messages 接口          |

Chat Completions 和 Responses 不能放在同一个 Provider 配置中自动猜测。若同一服务同时提供两种协议，应建立两个 Provider，再用 `/provider` 切换。

凭证优先从 `API_KEY_ENV` 指向的环境变量读取，其次才读取配置文件中的 `API_KEY`。命令行位置参数不接受明文 Key。

完整示例和常见协议错误见 [Provider 配置指南](docs/PROVIDERS.md)。

## 数据、隐私与安全

Syzzz Code 默认在本机保存以下数据：

| 目录或文件                  | 内容                                                  |
| --------------------------- | ----------------------------------------------------- |
| `~/.syzzz-code/config.json` | Provider、界面、会话与 RAG 配置；可能包含明文 API Key |
| `~/.syzzz-code/sessions`    | 有界的模型可见会话上下文                              |
| `~/.syzzz-code/history`     | 按工作区隔离的输入历史                                |
| `~/.syzzz-code/audit`       | 不含 prompt、正文和工具结果的元数据审计               |
| `~/.syzzz-code/rag`         | 本地索引和 chunk 数据                                 |
| `~/.syzzz-code/knowledge`   | 用户明确导入或保存的知识正文                          |
| `~/.agents/skills`          | 用户级 Skills                                         |

会话、个人知识库和 RAG 索引当前不加密。不要在共享账户、未加密磁盘或不可信设备上保存敏感项目内容。

以下内容不会写入审计正文：prompt、Assistant 正文、文件路径、diff、Shell 输出、API Key、原始 reasoning、Hook payload 和 Subagent transcript。会话为了恢复上下文，会保存有界的用户消息、Assistant 消息和工具结果；这与审计的隐私边界不同。

完整威胁模型、报告漏洞方式和扩展边界见 [SECURITY.md](SECURITY.md)。

## 故障排查

先运行：

```bash
syzzz doctor
syzzz config list
```

常见快速处理：

- 找不到 `syzzz`：重新打开终端，检查 npm 全局可执行目录是否在 `PATH`。
- Node.js 版本过低：升级到 Node.js 22 或 24。
- Provider 返回空响应或流提前结束：确认 Provider `type` 与真实端点协议一致。
- TUI 显示异常：运行 `syzzz --ui inline`；再通过 `/ui status` 收集终端诊断。
- `Shift+Enter` 仍提交：使用 `Ctrl+J`，或运行 `/terminal-setup status` 查看终端能力。
- PowerShell 创建的中文 AGENTS/Skill 无法读取：保存时明确使用 UTF-8。
- 会话无法恢复：运行 `syzzz sessions list`，确认当前工作区和会话锁状态。
- RAG 显示 `stale`：运行 `syzzz rag refresh <collection>`。
- LanceDB 不可用：运行 `syzzz rag doctor`；词法检索仍会继续工作。

更多错误原因和处理命令见 [故障排查](docs/TROUBLESHOOTING.md)。报告问题前请删除输出中的项目名、路径和任何凭证。

## 卸载

卸载 CLI：

```bash
npm uninstall --global syzzz-code
```

卸载不会自动删除用户数据。确认不再需要历史后，可手动删除 `~/.syzzz-code` 和 `~/.agents/skills` 中由你安装的 Syzzz Code 数据。删除前建议备份需要保留的会话、配置和知识库。

## 开发与贡献

```bash
npm ci
npm run build
npm test
npm run check
```

- [新手入门](docs/GETTING_STARTED.md)
- [Provider 配置](docs/PROVIDERS.md)
- [命令参考](docs/COMMANDS.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [本地 RAG](docs/RAG.md)
- [扩展使用指南](docs/EXTENSIONS.md)
- [架构说明](ARCHITECTURE.md)
- [安全策略](SECURITY.md)
- [测试与发布](TESTING.md)
- [当前工程状态](CURRENT_STATUS.md)
- [路线图](ROADMAP.md)
- [变更日志](CHANGELOG.md)
- [参与开发](CONTRIBUTING.md)

Syzzz Code 使用 [Apache-2.0](LICENSE) 许可证。项目与 OpenAI、Anthropic、DeepSeek、OpenCode 及其他 Provider 服务商不存在隶属或官方背书关系。
