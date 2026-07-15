# Syzzz Code

Syzzz Code 是一个使用 TypeScript 构建的实验性命令行 AI 编程助手。它提供统一的 Provider 抽象、多轮对话和本地工具调用能力，可通过用户配置连接 Anthropic 协议或 OpenAI-compatible 协议的模型服务。

该项目受现代终端编程 Agent 的架构理念启发，但拥有独立实现的 CLI、对话引擎、Provider 适配层和工具循环。当前目标是将一个已经跑通核心链路的 MVP，逐步升级为安全、可观察、可恢复的本地编程 Agent。

> [!WARNING]
> 当前版本仍处于实验阶段。模型可以调用 `Shell`、`Read`、`Write` 和 `Edit`，而这些工具目前没有沙箱、用户审批或工作区路径限制。请只在可恢复、低权限且不包含敏感数据的环境中使用，并在执行前后检查文件和 Git 变更。

## 当前能力

- 直接运行 `syzzz` 进入连续对话模式；
- 支持单次消息和交互式多轮对话；
- 支持 Anthropic Messages API 协议；
- 支持 OpenAI-compatible Chat Completions 协议；
- 供应商、Base URL、模型和 API Key 由用户配置文件管理；
- 通过 `syzzz switch` 交互选择已配置的供应商和模型；
- 支持模型发起结构化工具调用；
- 内置 `Shell`、`Read`、`Write` 和 `Edit` 四种工具；
- 工具调用最多执行 10 轮，避免无限循环；
- 单个工具结果超过 100,000 个字符时会被截断；
- Provider 请求失败时不会把未完成回合提交到正式对话历史；
- 提供 15 项离线自动化测试，覆盖配置、CLI、Engine 和 Provider 协议转换。

## 当前不具备的能力

以下内容尚未实现，不应视为当前版本能力：

- 流式模型输出；
- 会话保存、恢复和跨进程记忆；
- 上下文 token 预算和自动压缩；
- Provider 请求超时、取消和分类重试；
- Shell 命令审批、沙箱和风险分级；
- 文件访问的工作区边界和符号链接逃逸防护；
- 写入前 diff 预览和文件修改冲突检测；
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

## 工具

### Shell

在当前工作目录执行 Shell 命令。当前使用同步子进程，尚无执行超时、命令审批和沙箱。

### Read

读取指定文本文件。当前没有工作区路径限制。

### Write

创建或覆盖指定文件。当前没有 diff 预览、备份或覆盖确认。

### Edit

使用 `old_string` 和 `new_string` 修改文件。当前只替换第一个匹配项，尚无唯一性检查和并发修改保护。

## 测试

安装依赖后运行：

```bash
npm test
```

该命令会先执行 TypeScript 构建，再运行 `tests/*.test.mjs`。

当前正式测试套件包含 15 项离线测试：

- 配置校验与 Base URL 规范化；
- CLI 命令注册；
- Provider 和模型切换持久化；
- 连续交互消息只处理一次；
- QueryEngine 工具调用历史；
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
|-- providers/
|   |-- base.ts
|   |-- factory.ts
|   |-- anthropic.ts
|   `-- openai-compatible.ts
`-- tools/
    `-- index.ts

tests/
|-- cli.test.mjs
|-- config.test.mjs
|-- engine.test.mjs
`-- provider-protocol.test.mjs
```

## 安全限制

使用当前版本前，请理解以下风险：

1. `Shell` 可以执行当前系统账户有权执行的任意命令；
2. 文件工具可以访问当前系统账户有权访问的任意路径；
3. 模型读取到的文件内容和工具结果可能被发送给远程 Provider；
4. API Key 当前明文保存在用户配置文件中；
5. 工具没有执行前审批，模型可能因错误判断或提示注入产生危险操作；
6. 工具异常目前可能以普通错误文本返回，错误语义仍需进一步结构化；
7. 失败回合不会提交消息历史，但已经发生的外部副作用不会自动撤销。

建议：

- 在临时仓库副本、容器、虚拟机或低权限账户中试用；
- 不要在包含生产凭据、SSH Key 或敏感数据的目录中运行；
- 执行前后检查 `git status` 和 `git diff`；
- 对模型生成的 Shell 命令和代码修改保持人工审查；
- 不要将 `~/.syzzz-code/config.json`、终端录屏或真实 API Key 提交到 Git。

## 后续方向

接下来的重点不是继续堆叠模型和工具数量，而是完善 Agent 的可信执行底座：

1. 结构化工具结果和运行时输入校验；
2. 工作区边界和工具权限策略；
3. 异步 Shell、超时和端到端取消；
4. 事件化运行时、流式输出和执行审计；
5. 上下文预算、会话压缩和代码仓库映射；
6. 可靠 Patch、diff 预览和修改验证；
7. 会话持久化与 ask/plan/code 模式；
8. 在安全底座稳定后接入 MCP、Hooks 和受限子 Agent。

## 项目状态

当前版本为 `1.0.0`，代表多 Provider、连续 CLI 对话和基础 Tool Loop 已经贯通的实验性基线，不代表生产安全级或完整的自动化编程 Agent。

历史规划和旧测试资料保存在 [`archive/pre-v1.0.0`](archive/pre-v1.0.0)，仅用于记录项目演进，不应作为当前功能、测试或安全说明。
