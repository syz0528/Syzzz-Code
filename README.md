# Syzzz Code

Syzzz Code 是一个使用 TypeScript 构建的实验性命令行 AI 编程助手。它提供统一的 Provider 抽象、多轮对话和本地工具调用能力，可通过用户配置连接 Anthropic 协议或 OpenAI-compatible 协议的模型服务。

该项目受现代终端编程 Agent 的架构理念启发，但拥有独立实现的 CLI、对话引擎、Provider 适配层和工具循环。当前目标是将一个已经跑通核心链路的 MVP，逐步升级为安全、可观察、可恢复的本地编程 Agent。

> [!WARNING]
> 当前版本仍处于实验阶段。文件工具已经限制在工作区内；默认 Safe 模式下写入和 Shell 执行要求用户逐次确认。`fullAccess` 可在**当前会话**内跳过审批提示，但 **Shell 仍不是安全沙箱**，获批或自动放行的命令可以产生工作区外副作用。请只在可恢复、低权限且不包含敏感数据的环境中使用，并在执行前后检查文件和 Git 变更。

## 当前能力

- 直接运行 `syzzz` 进入连续对话模式；
- 支持单次消息和交互式多轮对话；
- 支持 Anthropic Messages API 协议；
- 支持 OpenAI-compatible Chat Completions 协议；
- 供应商、Base URL、模型和 API Key 由用户配置文件管理；
- 通过 `syzzz switch` 交互选择已配置的供应商和模型；
- 支持模型发起结构化工具调用；
- 内置 `ListDirectory`、`Read`、`Write`、`Edit` 和 `Shell` 五种工具；
- 会话级权限模式：`safe`（默认）、`acceptEdits`、`fullAccess`，通过 `/permissions` 查看或切换；
- 使用 Zod 在工具执行前校验模型生成的参数，并将失败作为结构化错误返回；
- 文件工具默认只能访问启动时确定的工作区，并拦截路径越界、敏感文件及 symlink/junction 逃逸；
- `Write` 和 `Edit` 在 Safe 模式下展示 diff 并要求确认；`acceptEdits`/`fullAccess` 可自动写入，但仍做工作区校验与审批后 hash 检测；
- `Shell` 使用异步子进程，支持超时、取消、stdout/stderr 分离和输出上限；Safe/`acceptEdits` 下仍要求确认；
- system prompt 注入 Platform、真实 Shell executor 与工具偏好，减少 Windows 下错误的 `ls` 类命令；
- 执行过程中按 `Ctrl+C` 可取消当前 Provider 请求或工具执行；
- 工具调用最多执行 10 轮，避免无限循环；
- 单个工具结果超过 100,000 个字符时会被截断；
- Provider 请求失败时不会把未完成回合提交到正式对话历史；
- 提供 44 项离线自动化测试，覆盖配置、CLI、Engine、权限模式、Provider 协议、路径策略、目录列表、文件编辑和 Shell 生命周期。

## 当前不具备的能力

以下内容尚未实现，不应视为当前版本能力：

- 流式模型输出；
- 会话保存、恢复和跨进程记忆；
- 上下文 token 预算和自动压缩；
- Provider 请求超时、分类错误和有限重试；
- Shell 沙箱和基于命令语义的细粒度风险判定；
- 永久写入配置文件的权限模式（当前权限仅会话有效）；
- 工作区外路径的逐次授权；
- 原子文件替换、通用 Patch 和自动回滚；
- 持久化执行审计与事件流；
- Glob、Grep、Diagnostics 和 Git 专用工具；
- MCP、Hooks、插件和子 Agent；
- Web、Electron 或 VS Code 图形界面；
- 从环境变量自动解析不同 Provider 的 API Key。

## 环境要求

- Node.js
- npm
- 一个可用的 Anthropic 或 OpenAI-compatible API 服务

建议使用当前 Node.js LTS 版本。

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
- 输入 `exit` 退出；
- 输入 `/permissions` 查看当前会话权限模式；
- 输入 `/permissions safe|acceptEdits|fullAccess` 切换模式（仅当前进程有效）；
- 启用 `fullAccess` 需输入确认短语 `I understand`；
- 工具要求审批时，输入 `y` 或 `yes` 批准，其他输入默认拒绝；
- Provider 或工具执行期间按一次 `Ctrl+C` 取消当前操作；
- 在两秒内连续按两次 `Ctrl+C` 退出。

### 4. 发送单次消息

```bash
syzzz chat -m "请解释 package.json 中的依赖"
```

## CLI 命令

```text
syzzz                              启动交互式对话
syzzz chat                         启动交互式对话
syzzz chat -m "<message>"           发送一条消息并退出
syzzz init                         初始化用户配置
syzzz config list                  查看当前供应商配置摘要
syzzz config set apiKey <value>    设置当前供应商的 API Key
syzzz switch                       交互选择已配置的供应商和模型
syzzz --help                       查看帮助
syzzz --version                    查看版本
```

`syzzz config list` 只显示 API Key 是否已设置，不会打印完整密钥。

## Provider 配置

配置文件是运行时供应商和模型列表的唯一数据源。默认配置只包含 DeepSeek：

```json
{
  "currentProvider": "deepseek",
  "providers": {
    "deepseek": {
      "name": "Deepseek",
      "type": "openai-compatible",
      "model": "deepseek-chat",
      "models": [
        "deepseek-chat",
        "deepseek-reasoner"
      ],
      "env": {
        "BASE_URL": "https://api.deepseek.com",
        "API_KEY": ""
      }
    }
  }
}
```

### 配置字段

- `currentProvider`：当前供应商 ID，必须存在于 `providers` 中；
- `name`：CLI 中显示的供应商名称；
- `type`：API 协议，目前只接受 `anthropic` 或 `openai-compatible`；
- `model`：该供应商当前选中的模型；
- `models`：允许通过 `syzzz switch` 选择的模型列表；
- `BASE_URL`：API 基地址，而不是完整的 `/chat/completions` 地址；
- `API_KEY`：供应商密钥，当前以明文保存在配置文件中。

配置校验要求 `model` 必须包含在同一供应商的 `models` 数组中。例如，以下配置是无效的：

```json
{
  "model": "model-a",
  "models": ["model-b"]
}
```

此类错误会阻止聊天和 `switch` 命令启动，必须先手工修正配置文件。

### 配置多个供应商

下面的示例同时配置一个 OpenAI-compatible 服务和一个 Anthropic 服务。模型名称与 Base URL 仅为结构示例，请以实际供应商文档和账户权限为准：

```json
{
  "currentProvider": "custom-openai",
  "providers": {
    "custom-openai": {
      "name": "Custom OpenAI-compatible",
      "type": "openai-compatible",
      "model": "model-a",
      "models": [
        "model-a",
        "model-b"
      ],
      "env": {
        "BASE_URL": "https://api.example.com/v1",
        "API_KEY": "YOUR_API_KEY"
      }
    },
    "anthropic": {
      "name": "Anthropic",
      "type": "anthropic",
      "model": "YOUR_ANTHROPIC_MODEL",
      "models": [
        "YOUR_ANTHROPIC_MODEL"
      ],
      "env": {
        "BASE_URL": "https://api.anthropic.com",
        "API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

保存后运行：

```bash
syzzz switch
```

CLI 会先列出配置文件中的供应商，再列出所选供应商的 `models`。选择结果会写回配置文件并在后续会话中继续使用。

## 架构概览

```text
CLI Layer
  src/index.ts
  src/interactive.ts
        |
        v
Query Engine
  src/engine.ts
  - 对话历史
  - 工具循环
  - 回合提交
        |
        +---------------------+
        |                     |
        v                     v
Provider Layer            Tool Layer
  AnthropicProvider         Shell
  OpenAICompatibleProvider  Read
  ProviderFactory           Write
                             Edit
```

### Provider 层

[`AIProvider`](src/providers/base.ts) 定义统一的消息、工具调用、工具结果和响应接口：

- [`AnthropicProvider`](src/providers/anthropic.ts) 负责 Anthropic Messages API 的消息与 `tool_use` 转换；
- [`OpenAICompatibleProvider`](src/providers/openai-compatible.ts) 负责 OpenAI Chat Completions 的 message、function tools 和 `tool_calls` 转换；
- [`createProvider`](src/providers/factory.ts) 根据配置中的 `type` 创建协议适配器。

Provider 按 API 协议划分，而不是为每个供应商品牌重复实现一套客户端。DeepSeek、OpenAI-compatible 中转服务以及其他兼容端点可以复用同一个适配器。

### Query Engine

[`QueryEngine`](src/engine.ts) 不依赖具体 SDK，主要负责：

1. 维护当前进程内的对话消息；
2. 调用当前 Provider；
3. 接收结构化工具调用；
4. 执行工具并保存对应的 `toolCallId`；
5. 把工具结果发回 Provider；
6. 在模型不再请求工具时返回最终文本。

每轮对话先在工作副本中执行，只有完整成功后才提交到正式历史。需要注意，这只能回滚对话历史，不能回滚已经发生的文件修改或 Shell 副作用。

## 权限模式

会话级模式，**不写入**用户配置文件；退出进程后恢复为 `safe`。

| 模式 | Read / ListDirectory | Write / Edit | Shell |
|------|----------------------|--------------|-------|
| `safe`（默认） | 自动 | 每次审批 | 每次审批 |
| `acceptEdits` | 自动 | 自动（仍受工作区与校验约束） | 每次审批 |
| `fullAccess` | 自动 | 自动 | 自动（仍非沙箱） |

所有模式下仍保留：Zod 校验、文件工作区边界、Shell 超时/取消/输出上限、工具轮次上限。

## 工具

### ListDirectory

列出工作区内某个目录的文件与子目录（默认工作区根）。只读、无需审批；路径受工作区与敏感路径策略约束；条目过多时截断。

### Shell

在当前工作区执行非交互式 Shell 命令。Safe/`acceptEdits` 下每次执行都要求用户确认；`fullAccess` 下跳过确认。默认超时为 30 秒，分别限制 stdout 和 stderr，并可通过当前 turn 的 `AbortSignal` 取消。Windows 使用 `cmd.exe`，POSIX 使用 `/bin/sh`；终止进程树属于尽力清理，不构成安全沙箱。

### Read

读取工作区内的 UTF-8 文本文件。路径会经过规范化、真实路径和敏感路径检查，默认拒绝工作区外访问及 symlink/junction 逃逸。

### Write

创建或覆盖工作区内的 UTF-8 文本文件。Safe 模式下执行前展示 diff 并要求确认；自动放行模式仍会生成内部审批元数据并在落盘前检测内容变化。

### Edit

使用 `old_string` 和 `new_string` 修改工作区文件。`old_string` 必须恰好匹配一次；Safe 模式下展示 diff，并使用内容 hash 检测审批后的并发变化。

## 测试

安装依赖后运行：

```bash
npm test
```

该命令会先执行 TypeScript 构建，再运行 `tests/*.test.mjs`。

当前正式测试套件包含 44 项离线测试：

- 配置校验与 Base URL 规范化；
- CLI 命令注册；
- Provider 和模型切换持久化；
- 连续交互消息只处理一次；
- `/permissions` 不进入聊天且可切换模式；
- QueryEngine 工具调用历史；
- 权限模式矩阵（safe / acceptEdits / fullAccess）；
- 工具 Zod 输入校验、结构化错误和审批通过/拒绝；
- 工作区越界、敏感路径和 symlink/junction 逃逸；
- ListDirectory 列表与越界拦截；
- Write/Edit diff、唯一匹配和审批后冲突检测；
- Shell 成功、非零退出、超时、取消和输出超限；
- 交互审批输入不会泄漏为下一条聊天消息；
- Provider 失败后的消息历史回滚；
- 并发消息保护；
- 工具调用轮次上限；
- OpenAI-compatible 消息与 function tools 转换；
- Anthropic 消息与工具定义转换。

这些测试不会连接真实 AI 服务，因此不能单独证明每个第三方供应商、模型或中转服务都能正常工作。真实 Provider 验证仍需要有效凭据、网络和供应商侧模型权限。

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

项目结构：

```text
src/
|-- index.ts
|-- interactive.ts
|-- engine.ts
|-- config.ts
|-- types.ts
|-- permissions/
|   |-- mode.ts
|   `-- policy.ts
|-- providers/
|   |-- base.ts
|   |-- factory.ts
|   |-- anthropic.ts
|   `-- openai-compatible.ts
`-- tools/
    |-- index.ts
    |-- runtime.ts
    |-- workspace.ts
    |-- file-changes.ts
    |-- shell-runner.ts
    `-- abort.ts

tests/
|-- cli.test.mjs
|-- config.test.mjs
|-- engine.test.mjs
|-- provider-protocol.test.mjs
|-- tools.test.mjs
`-- shell-runner.test.mjs
```

## 安全限制

使用当前版本前，请理解以下风险：

1. 获批的 `Shell` 命令仍可以执行当前系统账户有权执行的任意操作，工作区约束只适用于文件工具；
2. 文件边界和敏感路径拦截会降低误操作风险，但不是操作系统级隔离；
3. 模型读取到的文件内容和工具结果可能被发送给远程 Provider；
4. API Key 当前明文保存在用户配置文件中；
5. 审批依赖用户审查命令和 diff，不能自动消除提示注入或恶意命令风险；
6. Windows `taskkill` 和 POSIX 进程组终止是尽力而为，不能等同于容器或沙箱；
7. 失败回合不会提交消息历史，但已经发生的外部副作用不会自动撤销。

建议：

- 在临时仓库副本、容器、虚拟机或低权限账户中试用；
- 不要在包含生产凭据、SSH Key 或敏感数据的目录中运行；
- 执行前后检查 `git status` 和 `git diff`；
- 对模型生成的 Shell 命令和代码修改保持人工审查；
- 不要将 `~/.syzzz-code/config.json`、终端录屏或真实 API Key 提交到 Git。

## 后续方向

Phase 1 Tool Runtime 与 Phase 1.1 稳定化（权限模式、ListDirectory、环境 prompt）已落地。接下来的重点不是继续堆叠模型和工具数量，而是进入事件化 Runtime 与 Provider 可靠性建设：

1. 事件化运行时、流式输出和持久化执行审计；
2. Provider 分类错误、请求超时、有限重试和 usage 展示；
3. 上下文预算、会话压缩和代码仓库映射；
4. 更多专用代码工具（Glob/Grep 等）、可靠 Patch 和修改验证；
5. 会话持久化与 ask/plan/code 模式；
6. 在上述基础稳定后接入 MCP、Hooks 和受限子 Agent。

## 项目状态

当前包版本仍为 `1.0.0`。Phase 1 已推送至远程；Phase 1.1 为在其之上的会话权限与可用性稳定化，仍属实验阶段，不代表生产安全级或完整的自动化编程 Agent。

历史规划和旧测试资料保存在 [`archive/pre-v1.0.0`](archive/pre-v1.0.0)，仅用于记录项目演进，不应作为当前功能、测试或安全说明。
