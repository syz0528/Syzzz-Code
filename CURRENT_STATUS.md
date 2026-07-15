# Syzzz Code 当前项目状态

**状态日期：** 2026-07-15  
**包版本：** 1.0.0  
**当前阶段：** 多 Provider CLI Agent MVP 已贯通，准备进入 Tool Runtime 安全与可靠性升级  
**远程仓库：** https://github.com/syz0528/Syzzz-Code  
**远程基线提交：** `6aa1cc5`（`实现多厂商 Provider 架构与交互式 CLI`）

> 本文档描述当前代码的真实状态，而不是未来设计目标。历史规划和旧测试报告已归档到 [`archive/pre-v1.0.0`](archive/pre-v1.0.0)。

## 1. 项目定位

Syzzz Code 是一个使用 TypeScript 构建的实验性命令行 AI 编程助手，当前服务于三个目标：

1. 学习 AI Agent、工具调用和多 Provider 协议适配；
2. 作为自己和朋友可以实际试用的本地编程工具；
3. 作为求职展示项目，体现架构设计、工程质量、安全意识和产品迭代能力。

目标岗位方向包括：

- 后端与基础架构工程师；
- AI 工程师与 AI 应用开发工程师；
- 创业公司全栈或全能型工程师。

项目不再以绑定某个模型或堆叠供应商数量为主要目标。当前长期方向是：

> 构建一个轻量、自研核心、多 Provider、本地优先、执行可审计的终端编程 Agent。

## 2. 当前里程碑结论

当前版本已经从最初的 Anthropic SDK 单体原型，演进为具有统一 Provider 层和结构化工具调用循环的 CLI Agent MVP。

以下主链路已经贯通：

```text
用户配置
  -> Provider Factory
  -> Anthropic 或 OpenAI-compatible Provider
  -> QueryEngine 对话循环
  -> 模型发起结构化 Tool Call
  -> 本地工具执行
  -> Tool Result 回传模型
  -> 最终回复
```

当前可以定义为：

> 多 Provider、连续对话和基础 Tool Loop 已经可运行，但权限控制、执行隔离、上下文治理和长期会话仍处于原型阶段。

## 3. 已实现能力

### 3.1 CLI 与交互模式

当前支持：

```text
syzzz                              启动交互式对话
syzzz chat                         启动交互式对话
syzzz chat -m "<message>"           发送单条消息
syzzz init                         初始化用户配置
syzzz config list                  查看当前配置摘要
syzzz config set apiKey <value>    设置当前 Provider 的 API Key
syzzz switch                       交互选择 Provider 和模型
syzzz --help                       查看帮助
syzzz --version                    查看版本
```

交互模式已经支持：

- 连续发送多条消息；
- 每条输入只处理一次；
- 回答一轮后继续等待下一条输入；
- 输入 `exit` 退出；
- 两秒内连续按两次 `Ctrl+C` 退出；
- 默认命令和 `chat` 子命令复用同一个交互循环。

### 3.2 Provider 架构

当前实现两类协议适配器：

- `AnthropicProvider`：适配 Anthropic Messages API；
- `OpenAICompatibleProvider`：适配 OpenAI-compatible Chat Completions API。

当前架构按 API 协议划分 Provider，而不是为每个供应商品牌重复实现 Provider。DeepSeek、OpenAI 以及兼容 OpenAI 协议的中转服务可以复用同一个适配器。

统一协议已经能够表达：

- 用户消息；
- Assistant 文本消息；
- Assistant 工具调用；
- Tool Result；
- `toolCallId` 与工具结果对应关系；
- Provider finish reason；
- Provider token usage。

其中 finish reason 和 usage 已由 Provider 返回，但 Engine 和 CLI 尚未完整消费和展示。

### 3.3 QueryEngine

当前 `QueryEngine` 负责：

- 当前进程内的对话历史；
- Provider 调用；
- 工具定义转换；
- 工具调用循环；
- 工具结果写回；
- 回合成功后的历史提交。

已经实现的可靠性保护包括：

- 同一 Engine 实例拒绝并发处理第二条消息；
- 工具调用最多执行 10 轮；
- 单个工具结果最多保留 100,000 个字符；
- 未知工具返回显式错误结果；
- Provider 或工具循环失败时，不把未完成回合提交到正式消息历史；
- Provider 和 Tool 可以通过构造参数注入，便于隔离测试。

需要注意：对话历史回滚不等于外部副作用回滚。已经发生的文件写入或 Shell 命令不会因为 Provider 后续失败而自动撤销。

### 3.4 配置系统

配置文件位于：

```text
~/.syzzz-code/config.json
```

Windows 通常对应：

```text
C:\Users\<用户名>\.syzzz-code\config.json
```

当前配置支持：

- 多个 Provider；
- 每个 Provider 独立的名称、协议类型、Base URL、API Key；
- 每个 Provider 独立的模型列表和当前模型；
- 持久化当前 Provider 和模型选择；
- 配置结构运行时校验；
- Base URL 格式校验和尾部斜杠规范化；
- 临时文件写入后重命名，降低配置部分写入风险。

当前重要约束：

- `type` 只能是 `anthropic` 或 `openai-compatible`；
- `currentProvider` 必须存在于 `providers`；
- 每个 Provider 的 `model` 必须包含在其 `models` 数组中；
- 模型列表完全来自用户配置文件，不通过网络获取；
- `syzzz switch` 只显示配置文件中已经存在的 Provider 和模型。

### 3.5 本地工具

当前内置四种工具：

- `Shell`：执行 Shell 命令；
- `Read`：读取文本文件；
- `Write`：创建或覆盖文件；
- `Edit`：使用字符串查找替换修改文件。

工具调用在 OpenAI-compatible 和 Anthropic 两类协议下均有对应的消息转换实现。

## 4. 测试与验证状态

### 4.1 正式自动化测试

正式测试命令：

```bash
npm test
```

该命令先执行 TypeScript 构建，再运行 `tests/*.test.mjs`。

当前正式测试套件包含 15 项离线测试：

- `tests/config.test.mjs`：4 项；
- `tests/provider-protocol.test.mjs`：4 项；
- `tests/engine.test.mjs`：4 项；
- `tests/cli.test.mjs`：3 项。

覆盖范围包括：

- 配置校验和 Base URL 规范化；
- 非法 Provider 类型；
- 当前模型不在模型列表中；
- 当前 Provider 不存在；
- OpenAI-compatible 工具消息转换；
- Anthropic 工具消息转换；
- Engine 工具调用历史；
- 失败回合的消息历史回滚；
- 并发消息保护；
- 工具循环上限；
- CLI 命令注册；
- Provider 与模型切换持久化；
- 连续消息分别只处理一次。

最近一次完整结果：

```text
tests 15
pass 15
fail 0
```

这些测试均为离线测试，不会调用真实模型服务。

### 4.2 已完成人工真实验证

2026-07-15 在 Windows PowerShell 环境中完成过一次人工验证，使用用户配置中的 OpenAI-compatible 中转服务和 `deepseek-v4-flash-free` 模型标识。

已观察到：

- `syzzz switch` 能列出配置中的 Provider 和模型；
- 选择结果能够持久化；
- `syzzz` 能初始化当前 Provider；
- 多轮文本对话能够连续运行；
- 输入没有重复处理；
- 回答一轮后进程没有提前退出；
- 模型能够发起 `Shell` 工具调用；
- 工具结果能够返回模型并生成最终回答；
- 同一个用户问题中可以发生多轮工具调用。

这次人工验证证明了当前 OpenAI-compatible 主链路在该具体配置下能够工作，但它不是可重复的自动化 E2E 测试。

### 4.3 尚未完成的真实验证

当前不能声称以下内容已经正式验证：

- Anthropic 官方 API 的完整端到端调用；
- OpenAI 官方 API 的完整端到端调用；
- GLM、Gemini 和其他中转服务的完整兼容性；
- 所有 Provider 的真实工具调用；
- 401、404、429、5xx、断网和超时处理；
- Windows、Linux 和 macOS 的 CI 兼容矩阵；
- 干净环境下的全局安装与发布包验收；
- 长会话的 token、内存和成本表现。

## 5. 当前架构

```text
CLI Layer
  src/index.ts
  src/interactive.ts
        |
        v
Query Engine
  src/engine.ts
        |
        +------------------------+
        |                        |
        v                        v
Provider Layer               Tool Layer
  providers/base.ts            Shell
  providers/factory.ts         Read
  providers/anthropic.ts       Write
  providers/openai-compatible  Edit
        |
        v
Remote Model API
```

主要设计决策：

1. Engine 依赖 `AIProvider`，不依赖具体 SDK；
2. Provider 按协议划分，而不是按供应商品牌划分；
3. 用户配置文件是运行时 Provider 和模型列表的唯一事实源；
4. 工具调用在内部使用统一结构，再由 Provider 转换为不同 API 协议；
5. 当前核心循环保持自研，不整体迁移到大型 Agent 框架。

## 6. 已知问题与技术债

### 6.1 P0：工具权限和执行安全

当前最严重的问题是工具拥有过高权限：

- `Shell` 可以执行当前账户有权执行的任意命令；
- `Read`、`Write`、`Edit` 可以访问当前账户有权访问的任意路径；
- 没有工作区边界；
- 没有命令审批；
- 没有写入前 diff；
- 没有沙箱；
- 没有提示注入防护；
- 没有 symlink/junction 逃逸防护。

当前版本不适合在生产目录、包含敏感凭据的目录或不可恢复环境中无人监督运行。

### 6.2 P0：工具错误语义不完整

内置工具通常在内部捕获异常，然后返回 `Error: ...` 普通字符串。Engine 只有在工具抛出异常时才会设置结构化错误状态。

因此当前可能出现：

- 工具实际失败，但协议层收到普通工具结果；
- 模型需要通过解析字符串判断是否失败；
- Anthropic `is_error` 语义无法始终可靠表达。

### 6.3 P1：缺少超时和取消

- Shell 仍使用同步 `execSync`；
- Shell 没有 timeout；
- Provider 请求没有统一的 `AbortSignal`；
- Ctrl+C 主要控制交互界面，不能可靠取消底层网络请求和子进程；
- 长命令可能阻塞整个 CLI。

### 6.4 P1：上下文无限增长

当前消息历史只保存在内存数组中，没有：

- token 预算；
- 自动裁剪；
- compaction；
- 会话摘要；
- repo map；
- 工具 artifact 引用；
- 跨进程保存和恢复。

长时间会话可能超过模型上下文窗口或产生不可控成本。

### 6.5 P1：密钥管理

- API Key 当前明文保存在 JSON 配置中；
- `config set apiKey` 会把密钥作为命令参数，可能进入 Shell 历史；
- Windows 上不能仅依赖 POSIX `0600` 文件模式作为安全保障；
- 当前没有系统凭据存储；
- 虽然加载了 dotenv，但尚未实现 Provider 环境变量到运行时配置的映射。

此前在调试和对话中展示过的真实 API Key 应视为已暴露并进行轮换。

### 6.6 P2：配置与 Registry 重叠

`src/providers/registry.ts` 是早期内置厂商设计遗留，目前没有接入主要运行路径。当前用户配置文件才是 Provider 和模型列表的事实源。

后续应当：

- 删除 Registry；或
- 明确将其降级为不含用户密钥、不过度维护模型真相的初始化模板。

不能继续让 Registry 和用户配置同时充当模型事实源。

### 6.7 P2：类型和协议遗留

- 工具协议仍使用 `input_schema`，Provider 中间协议使用 `inputSchema`；
- 工具执行输入仍存在 `any`；
- Provider SDK 转换中仍有 `as any`；
- ProviderConfig 和消息类型曾存在多套定义，仍需继续收敛。

## 7. 安全使用建议

在 Tool Runtime 完成安全升级前：

1. 只在可恢复的 Git 仓库副本中运行；
2. 使用低权限账户、容器或虚拟机；
3. 不要在包含生产凭据、SSH Key 或个人隐私文件的目录中运行；
4. 每次操作后检查 `git status` 和 `git diff`；
5. 不要让模型无人监督执行删除、安装、发布、提交或推送操作；
6. 不要把 `~/.syzzz-code/config.json` 提交到仓库；
7. 及时轮换曾经出现在日志、录屏或对话中的 API Key。

## 8. 文档与版本状态

### 8.1 已推送基线

当前核心实现已经推送到远程 `main`：

```text
commit: 6aa1cc5
title:  实现多厂商 Provider 架构与交互式 CLI
```

该提交包含：

- 多 Provider 核心实现；
- CLI 连续交互修复；
- 配置切换；
- 15 项正式测试；
- 历史文档和旧测试脚本归档。

### 8.2 当前本地文档工作

当前正在本地重新建立活跃文档：

- `README.md`：已完成本地重写，尚未提交和推送；
- `CURRENT_STATUS.md`：本文档，尚未提交和推送；
- 其他架构、安全和路线文档：待用户确认后继续编写。

### 8.3 Tag 状态

虽然 `package.json` 和 CLI 当前版本号是 `1.0.0`，但远程仓库尚未创建 `v1.0.0` Git Tag。正式 Tag 应在活跃文档审核完成并提交后创建。

## 9. 下一阶段目标

下一阶段不优先增加更多模型、供应商或高级 UI，而是建设可信执行底座。

### Phase 1：Tool Runtime 安全与正确性

优先实施：

1. 统一 `ToolDefinition`、`ToolContext`、`ToolResult` 和类型化错误；
2. 为工具输入增加运行时 schema 校验；
3. 实现工作区路径边界和 symlink/junction 防逃逸；
4. 将 Shell 改为异步执行；
5. 增加超时、取消和输出限制；
6. 建立工具风险分级和用户审批；
7. 写入前展示 diff；
8. 增加真实工具的安全与错误测试。

### 后续阶段

在 Phase 1 稳定后，再按顺序考虑：

1. Agent Event Stream 和流式输出；
2. token usage、延迟、成本和执行审计；
3. Glob、Grep、范围 Read、Patch、Diagnostics 等专用代码工具；
4. 上下文预算、自动压缩和 repo map；
5. ask/plan/code 模式；
6. 会话持久化和 checkpoint；
7. MCP、Hooks 和受限子 Agent。

Browser、Web UI、Electron、VS Code 插件、插件市场和团队协作暂不进入近期范围。

## 10. 下一里程碑验收标准

下一阶段完成时，至少应满足：

- 工具非法输入在执行前被拒绝；
- 工具失败具有可靠的结构化错误语义；
- 默认不能访问工作区外文件；
- Shell 可以超时和取消；
- 危险操作未经确认不会执行；
- 文件写入前可以查看 diff；
- 关键安全路径具有自动化测试；
- CLI 可以清楚展示工具执行状态和失败原因；
- 文档、代码和测试对当前能力的描述保持一致。

---

当前最重要的判断是：Provider 主链路已经证明可行。接下来决定项目质量的，不是再增加多少模型，而是能否把工具执行、权限、上下文和验证过程建设成可信的工程系统。
