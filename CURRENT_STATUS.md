# Syzzz Code 当前项目状态

**状态日期：** 2026-06-16  
**包版本：** 1.0.0  
**当前阶段：** Phase 1 安全与执行正确性底座已在本地完成，等待审阅和版本化  
**远程仓库：** https://github.com/syz0528/Syzzz-Code  
**远程基线提交：** `7ea3aa1`（`完善当前状态与后续升级路线文档`）

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

> 多 Provider、连续对话和 Tool Loop 已经可运行；Phase 1 已补齐工具输入校验、工作区边界、审批、diff、异步 Shell 与端到端取消，但执行隔离、事件审计、上下文治理和长期会话仍待后续阶段完成。

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
- 审批提示只接受 `y` 或 `yes`，其他输入默认拒绝；
- 执行中按一次 `Ctrl+C` 取消当前 turn；
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
- 使用 Zod 在副作用发生前校验工具输入；
- 写入和命令工具缺少审批处理器时默认拒绝；
- 取消信号贯穿 CLI、Engine、Provider 和工具上下文；
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

- `Shell`：审批后异步执行非交互命令，支持超时、取消、进程树终止、stdout/stderr 分离与输出限制；
- `Read`：读取工作区内通过真实路径与敏感路径检查的 UTF-8 文件；
- `Write`：审批前生成 diff，审批后校验内容 hash 再创建或覆盖文件；
- `Edit`：要求 `old_string` 唯一匹配，审批前生成 diff，并检测审批后的并发变化。

工具使用统一的 `ToolDefinition`、`ToolContext` 和 `ToolResult` 契约。工具调用与结构化错误在 OpenAI-compatible 和 Anthropic 两类协议下均有对应转换；Anthropic 错误结果会设置 `is_error: true`。

文件工具默认拒绝：

- 工作区外路径；
- `.git`、`.ssh`、`.env`、私钥和常见凭据文件；
- 通过 symlink 或 Windows junction 产生的越界；
- 通过链接别名访问工作区内敏感目录。

## 4. 测试与验证状态

### 4.1 正式自动化测试

正式测试命令：

```bash
npm test
```

该命令先执行 TypeScript 构建，再运行 `tests/*.test.mjs`。

当前正式测试套件包含 37 项离线测试：

- `tests/config.test.mjs`：4 项；
- `tests/provider-protocol.test.mjs`：5 项；
- `tests/engine.test.mjs`：10 项；
- `tests/cli.test.mjs`：4 项；
- `tests/tools.test.mjs`：7 项；
- `tests/shell-runner.test.mjs`：7 项。

覆盖范围包括：

- 配置校验和 Base URL 规范化；
- 非法 Provider 类型；
- 当前模型不在模型列表中；
- 当前 Provider 不存在；
- OpenAI-compatible 工具消息转换；
- Anthropic 工具消息转换；
- 两类 Provider 的工具错误语义；
- Engine 工具调用历史；
- Zod 工具输入校验；
- 审批通过、拒绝和缺少审批处理器时的 fail-closed 行为；
- 取消后消息历史回滚和下一轮恢复；
- 失败回合的消息历史回滚；
- 并发消息保护；
- 工具循环上限；
- 路径越界、敏感路径、symlink 和 Windows junction；
- Write/Edit diff、唯一匹配和审批后冲突检测；
- Shell 正常退出、非零退出、超时、取消和输出超限；
- CLI 命令注册；
- Provider 与模型切换持久化；
- 连续消息分别只处理一次；
- 审批输入不会泄漏成下一条聊天消息。

最近一次完整结果：

```text
tests 37
pass 37
fail 0
```

这些测试均为离线测试，不会调用真实模型服务。

### 4.2 已完成人工真实验证

在 Phase 1 之前，项目已在 Windows PowerShell 环境中完成过一次人工验证，使用用户配置中的 OpenAI-compatible 中转服务和 `deepseek-v4-flash-free` 模型标识。

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

### 6.1 P0：Shell 仍不是安全沙箱

- 所有 Shell 命令都会请求确认，但获批命令仍拥有当前账户权限；
- 文件工具的工作区边界不会限制 Shell 命令自身的路径、网络或系统副作用；
- 当前没有容器、系统调用过滤、网络隔离或资源配额；
- 提示注入仍可能诱导模型提出危险命令，安全性依赖用户审查审批预览。

因此当前版本仍不适合在生产目录、包含敏感凭据的目录或不可恢复环境中无人监督运行。

### 6.2 P1：文件写入尚非原子替换

- Write/Edit 已有 diff、唯一匹配和审批后 hash 冲突检测；
- 最终落盘仍使用直接 `writeFile`，进程在写入中途崩溃时可能留下部分内容；
- 尚无通用 Patch、临时文件原子替换、备份或自动回滚；
- 路径检查与真正写入之间仍存在操作系统层面的 TOCTOU 窗口。

### 6.3 P1：Provider 可靠性仍不完整

- `AbortSignal` 已贯穿 Provider SDK 请求，但尚无统一请求 timeout；
- 401、404、429、5xx、网络和上下文超限仍没有分类错误；
- 尚无遵循 `Retry-After` 的有限重试；
- usage、finish reason、延迟和 request ID 尚未进入统一事件与审计记录。

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

- Provider SDK 转换中仍有 `as any`；
- 部分异常捕获仍使用显式 `any`，尚未完全收敛为 `unknown`；
- ProviderConfig 和消息类型曾存在多套定义，仍需继续收敛；
- 完整的 typed Provider error 与 typed ToolError 分类尚未建立。

## 7. 安全使用建议

即使 Phase 1 已完成，当前版本仍应遵循以下安全建议：

1. 只在可恢复的 Git 仓库副本中运行；
2. 使用低权限账户、容器或虚拟机；
3. 不要在包含生产凭据、SSH Key 或个人隐私文件的目录中运行；
4. 每次操作后检查 `git status` 和 `git diff`；
5. 不要让模型无人监督执行删除、安装、发布、提交或推送操作；
6. 不要把 `~/.syzzz-code/config.json` 提交到仓库；
7. 及时轮换曾经出现在日志、录屏或对话中的 API Key。

## 8. 文档与版本状态

### 8.1 已推送基线

当前文档化基线已经推送到远程 `main`：

```text
commit: 7ea3aa1
title:  完善当前状态与后续升级路线文档
```

该远程基线包含：

- 多 Provider 核心实现；
- CLI 连续交互修复；
- 配置切换；
- 15 项正式测试；
- 历史文档和旧测试脚本归档；
- 重建后的 README、当前状态与路线图。

### 8.2 当前本地文档工作

Phase 1 的实现、37 项测试和本轮文档同步目前只存在于本地工作区，尚未提交或推送。包版本也仍为 `1.0.0`；是否发布为 `v1.1.0` 应在用户审阅和人工试用后决定。

### 8.3 Tag 状态

虽然 `package.json` 和 CLI 当前版本号是 `1.0.0`，但远程仓库尚未创建 `v1.0.0` Git Tag。正式 Tag 应在活跃文档审核完成并提交后创建。

## 9. 下一阶段目标

Phase 1 已完成本地实现和自动化验收。下一阶段按路线进入 Phase 2，不优先增加更多模型、供应商、代码工具或高级 UI：

1. 定义统一 Agent Event Stream；
2. 支持文本流式输出和事件驱动 CLI；
3. 建立 Provider 分类错误、请求 timeout 和有限重试；
4. 消费并记录 usage、finish reason、延迟和 request ID；
5. 建立可脱敏、可追踪的逐轮执行审计。

Phase 3 的专用代码工具、Context Manager 与 repo map，Phase 4 的会话和模式，以及 Phase 5 的 MCP、Hooks 与子 Agent，均不在下一轮实现范围内。

Browser、Web UI、Electron、VS Code 插件、插件市场和团队协作暂不进入近期范围。

## 10. 下一里程碑验收标准

Phase 2 完成时，至少应满足：

- 文本响应可以流式展示；
- CLI 由事件流驱动，不再由 Engine 直接打印工具状态；
- 401、404、429、超时、网络错误和上下文超限具有稳定分类；
- 重试有最大次数和总时间预算，且不会重复工具副作用；
- 每轮可以追踪模型、token、耗时、工具、重试和最终状态；
- 日志对 API Key、Authorization 和疑似凭据脱敏；
- 非交互调用可以选择机器可读事件输出；
- Phase 1 的 37 项安全回归继续保持通过。

---

当前最重要的判断是：Provider 主链路和安全 Tool Runtime 已证明可行。下一步决定项目质量的，是能否把这一执行底座演进为可观察、可分类恢复且可供多个界面消费的事件化 Runtime。
