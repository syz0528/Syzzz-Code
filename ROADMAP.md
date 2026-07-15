# Syzzz Code 路线图

**制定日期：** 2026-07-15  
**适用基线：** `1.0.0` / 远程提交 `6aa1cc5`  
**当前入口：** 多 Provider CLI Agent MVP 已贯通，下一阶段进入 Tool Runtime 安全与可靠性升级

> 本文档只描述尚未完成的工作、实施顺序和验收标准。当前已经实现的能力以 [`README.md`](README.md) 和 [`CURRENT_STATUS.md`](CURRENT_STATUS.md) 为准。

## 1. 产品方向

Syzzz Code 的目标不是复制某个现有编程助手的全部功能，也不是通过堆叠模型、供应商和工具数量制造功能列表。

项目的长期定位是：

> 一个轻量、自研核心、多 Provider、本地优先、执行可审计的终端编程 Agent。

它应当能够完成以下完整闭环：

```text
理解用户任务
  -> 获取必要的代码库上下文
  -> 形成可解释的行动计划
  -> 在权限边界内调用工具
  -> 展示和记录产生的副作用
  -> 运行构建、测试或诊断
  -> 根据真实结果修正方案
  -> 给出可验证的最终结论
```

衡量项目成熟度时，优先考虑：

1. 工具是否安全、可取消、可追溯；
2. 修改是否准确、可审查、可验证；
3. 上下文是否相关、受预算控制；
4. 错误是否保留真实语义并支持恢复；
5. 架构是否便于添加协议、工具和界面；
6. 文档、测试和实现是否保持一致。

## 2. 路线原则

### 2.1 保留自研核心

继续维护以下核心边界：

- `QueryEngine` / 后续 `AgentRuntime`：任务与工具循环；
- `AIProvider`：模型协议抽象；
- Provider adapters：Anthropic 与 OpenAI-compatible 协议转换；
- Tool Runtime：工具注册、权限、执行和结果；
- Context Manager：上下文预算、代码库信息和会话历史。

不计划为了快速增加功能而整体迁移到 LangChain、Mastra 或其他大型 Agent 框架。可以引入小型、职责明确的库，但不应让框架替代项目最有学习和展示价值的核心设计。

### 2.2 安全先于自主性

在完成工具权限、工作区边界、取消和审计之前，不增加以下能力：

- 无人监督长任务；
- MCP 工具自动执行；
- 子 Agent；
- 远程执行；
- 后台任务；
- 自动 Git commit、push 或发布。

### 2.3 专用工具优于无限制 Shell

对于文件搜索、代码读取、诊断和 Git 状态等常见操作，优先提供结构化专用工具。Shell 保留为补充能力，但应具有风险分类、超时、取消、输出限制和审批策略。

### 2.4 用户配置是运行时事实源

供应商、Base URL、模型列表和当前模型继续由用户配置文件决定。

源码中的静态 Registry 不再作为持续更新的模型真相来源。后续可以：

- 删除旧 Registry；或
- 将其降级为首次初始化时使用的 Provider 模板。

### 2.5 每个阶段必须可验证

每个阶段必须同时交付：

- 实现代码；
- 自动化测试；
- 必要的人工验证步骤；
- 文档更新；
- 明确的已知限制。

未达到退出条件的阶段不应被标记为完成。

## 3. 优先级定义

### P0：阻止安全使用或破坏正确性

必须优先修复，否则新增能力会放大风险：

- 任意 Shell 和任意路径文件访问；
- 工具错误被伪装成普通成功字符串；
- 缺少运行时输入校验；
- Shell 无超时、取消和输出治理；
- 危险副作用未经用户确认。

### P1：影响长任务可靠性和真实使用

- Provider 超时、取消和错误分类；
- 事件流与执行审计；
- 上下文预算和 compaction；
- 可靠 Patch 和修改冲突检测；
- 会话保存与恢复。

### P2：显著提升编程能力和产品体验

- Repo map；
- ask/plan/code 模式；
- 更成熟的终端 UI；
- token、成本和状态展示；
- 配置迁移与诊断。

### P3：生态和平台能力

- MCP；
- Hooks；
- 子 Agent；
- 远程 Runtime；
- 图形界面和团队能力。

## 4. 阶段总览

```text
Phase 0  基线文档与版本冻结
   |
   v
Phase 1  Tool Runtime 安全与正确性
   |
   v
Phase 2  事件化 Agent Runtime 与 Provider 可靠性
   |
   v
Phase 3  代码库上下文与可靠编辑闭环
   |
   v
Phase 4  会话、模式与终端产品体验
   |
   v
Phase 5  MCP、Hooks 与受限子 Agent
   |
   v
Phase 6  持续评测、发布与工程治理
```

后续阶段可以提前研究，但不能绕过前置阶段直接进入生产路径。

## 5. Phase 0：基线文档与版本冻结

### 目标

为已经推送的多 Provider MVP 建立可信、可恢复的版本基线，使后续大改拥有清晰起点。

### 交付内容

- [x] 将 Provider、CLI、配置和正式测试推送到远程 `main`；
- [x] 将过时规划和历史测试脚本归档；
- [x] 重写 `README.md`；
- [x] 重写 `CURRENT_STATUS.md`；
- [x] 创建 `ROADMAP.md`；
- [ ] 用户审阅当前三份活跃文档；
- [ ] 提交并推送文档；
- [ ] 创建 annotated `v1.0.0` Git Tag；
- [ ] 确认远程 `main` 和 `v1.0.0` 指向同一文档基线提交。

### 退出条件

- 根目录存在准确的 README、当前状态和路线图；
- 文档不再声称 OAuth fallback、流式输出、四厂商开箱即用等未实现能力；
- 正式测试范围和人工真实验证范围被清楚区分；
- 安全限制在入口文档中可见；
- Git Tag 可以作为后续大改的恢复点。

## 6. Phase 1：Tool Runtime 安全与正确性

### 目标

将当前“模型直接调用四个高权限函数”的工具层，升级为具有类型、权限、取消和审计基础的 Tool Runtime。

这是下一阶段最高优先级，也是后续流式 UI、MCP、子 Agent 和自主执行的共同基础。

### 6.1 统一工具契约

设计并实现统一的泛型工具接口，例如：

```ts
interface ToolDefinition<Input, Output> {
  name: string;
  description: string;
  inputSchema: RuntimeSchema<Input>;
  risk: ToolRisk;
  execute(input: Input, context: ToolContext): Promise<ToolResult<Output>>;
}
```

需要包含：

- `ToolContext`：workspace root、当前目录、`AbortSignal`、权限和 execution ID；
- `ToolResult`：成功状态、结构化数据、stdout、stderr、exit code、耗时和截断状态；
- `ToolError`：错误代码、用户提示、是否可重试和原始 cause；
- `ToolRisk`：只读、写入、命令执行、网络、Git 写操作等风险等级。

候选库：

- Zod：运行时 schema 与 TypeScript 类型推导；
- Node 原生错误 `cause`：保留底层错误链。

最终依赖应在实现前通过小型原型确认，不因路线图直接锁定。

### 6.2 工具输入运行时校验

- 在任何副作用发生前验证模型生成的工具参数；
- 拒绝缺失字段、错误类型、超长参数和未知属性；
- 把 schema 错误作为结构化 Tool Result 返回模型；
- 对 OpenAI-compatible 和 Anthropic 使用同一内部错误语义。

### 6.3 工作区路径边界

- 解析并规范化所有文件路径；
- 默认只允许访问启动时确定的 workspace root；
- 阻止 `..` 和绝对路径越界；
- 处理 Windows drive、UNC、junction 和大小写差异；
- 解析真实路径并防止 symlink/junction 逃逸；
- 为确实需要的工作区外访问提供显式审批，而不是静默放行。

### 6.4 异步 Shell

- 使用异步子进程替换 `execSync`；
- 支持 timeout；
- 支持 `AbortSignal`；
- 分离 stdout 与 stderr；
- 记录 exit code、signal 和 duration；
- 对总输出实施明确上限；
- 超限时保留必要头尾并标记 truncated；
- 子进程终止后清理监听器和资源。

### 6.5 权限策略与审批

初始策略建议：

- Read、Glob、Grep：工作区内可自动执行；
- Write、Edit、Patch：显示 diff 后确认；
- Shell：根据命令风险决定自动执行或确认；
- 删除、覆盖、安装、网络上传、Git commit/push：强制确认；
- 工作区外操作：默认拒绝，必要时逐次授权。

策略必须由本地代码执行，不能只依赖 system prompt 要求模型自律。

### 6.6 真实工具测试

新增测试应覆盖：

- 合法与非法输入；
- 文件不存在；
- 工作区路径越界；
- symlink/junction 逃逸；
- Write 覆盖；
- Edit 零匹配、唯一匹配和多匹配；
- Shell 成功、非零退出、超时、取消和输出超限；
- 审批通过、拒绝和超时；
- Tool Result 在两个 Provider 协议中的错误转换。

### Phase 1 退出条件

- 工具失败不会再伪装为成功字符串；
- 每次执行前都完成运行时参数校验；
- 默认不能访问工作区外路径；
- Shell 不再阻塞 Node.js 事件循环；
- Shell 可超时、取消并返回结构化结果；
- 危险操作没有批准就不会发生；
- 写文件前能够展示可审查的修改；
- 关键安全行为具有自动化测试；
- README 和状态文档同步更新。

## 7. Phase 2：事件化 Agent Runtime 与 Provider 可靠性

### 目标

把当前 `chat(): Promise<string>` 演进为可流式、可观察、可取消的 Agent Runtime，同时保持 CLI、Provider 和工具层解耦。

### 7.1 Agent Event Stream

定义统一事件联合类型：

- turn started；
- text delta；
- reasoning delta（Provider 支持时）；
- tool requested；
- approval requested/resolved；
- tool started/output/completed；
- usage updated；
- retry scheduled；
- turn completed/failed/cancelled。

CLI 只消费事件并负责展示，不再依赖 Engine 内部直接 `console.log`。

### 7.2 Provider 能力与错误模型

扩展 Provider 接口以表达：

- streaming；
- `AbortSignal`；
- context window；
- maximum output；
- tool calling；
- parallel tool calls；
- reasoning content；
- structured output。

建立 Provider typed errors：

- authentication；
- permission；
- model not found；
- rate limit；
- timeout；
- network；
- malformed response；
- context exceeded；
- provider internal error。

保留 HTTP 状态、request ID、retry-after 和原始 cause。

### 7.3 有限重试策略

只对明确可重试的错误执行有限重试：

- 尊重 `Retry-After`；
- 指数退避与随机抖动；
- 设定最大次数和总时间预算；
- 工具副作用不得被 Provider 重试重复执行；
- CLI 清楚显示重试原因和次数。

### 7.4 可观测性

每轮记录：

- turn ID 和 tool execution ID；
- Provider 与 configured model；
- API reported model（可获得时）；
- input/output/total tokens；
- Provider 和工具耗时；
- finish reason；
- 重试次数；
- 最终状态。

日志必须对 API Key、Authorization header 和疑似凭据进行脱敏。

### Phase 2 退出条件

- 文本能够流式输出；
- Ctrl+C 可以取消当前 Provider 请求和工具执行；
- CLI 不再因 spinner 与工具日志产生混乱输出；
- 401、404、429、超时和网络错误有明确类别；
- usage 与 finish reason 不再被 Engine 丢弃；
- 每轮执行具有可追踪事件记录；
- 非交互调用可以选择机器可读的 JSON 事件输出。

## 8. Phase 3：代码库上下文与可靠编辑闭环

### 目标

让 Agent 能够高效理解中型代码库，并以可验证、低冲突的方式修改代码，而不是依赖无限制 Shell 和全文件读取。

### 8.1 专用代码工具

优先新增：

1. Glob：按文件模式发现候选文件；
2. Grep：按内容和正则搜索；
3. Read Range：按行范围读取文件；
4. List Directory：结构化目录浏览；
5. Patch：上下文感知的局部修改；
6. Diagnostics：读取 TypeScript、lint 或 IDE 诊断；
7. Git Status/Diff：只读查看工作区变化。

这些工具必须复用 Phase 1 的权限、路径和审计机制。

### 8.2 可靠 Patch

- 修改前要求文件版本或内容 hash；
- 上下文必须唯一匹配；
- 多匹配时拒绝并要求更多上下文；
- 使用临时文件和原子替换；
- 检测用户或其他进程的并发修改；
- 修改后生成 diff；
- 支持用户拒绝和后续撤销策略。

### 8.3 Context Manager

管理：

- 模型上下文窗口；
- 当前 turn token 预算；
- 对话历史；
- 工具结果；
- 已读取文件；
- repo map；
- compaction summary；
- Provider 切换后的兼容性。

工具结果不再只按字符截断，应按 token 预算和内容类型处理。命令错误通常需要保留尾部，代码定义通常需要保留相关范围。

### 8.4 Repo Map

第一阶段优先为 TypeScript/JavaScript 项目实现：

- 文件列表；
- import/export 关系；
- 类型、类、函数和方法签名；
- 符号引用关系；
- Git 状态；
- 当前任务相关度排序。

候选实现：

- TypeScript Compiler API；
- ts-morph；
- 跨语言阶段再评估 Tree-sitter。

Repo map 必须受独立 token 预算约束，不把整个仓库直接塞入 prompt。

### 8.5 修改验证

代码任务完成前，根据项目类型选择最小必要检查：

- type check；
- targeted tests；
- lint；
- build；
- Git diff 检查。

Agent 只能根据真实工具结果宣称完成，不允许把“建议运行”写成“已经通过”。

### Phase 3 退出条件

- Agent 能先搜索再读取相关文件；
- 中型仓库上下文不会无限增长；
- 长会话可以自动 compact；
- 文件编辑能检测多匹配和并发变化；
- 每次代码改动都有 diff；
- 任务完成报告包含实际执行的验证命令和结果；
- 建立固定样例仓库的 coding-task 回归测试。

## 9. Phase 4：会话、模式与终端产品体验

### 目标

在运行时和工具系统稳定后，将基础 REPL 升级为可长期使用的终端产品。

### 9.1 工作模式

实现三种清晰模式：

- `/ask`：只读分析，不允许副作用工具；
- `/plan`：分析并生成计划，等待用户批准；
- `/code`：在权限策略下执行已确认任务。

模式限制由 Tool Policy 强制执行，不只改变提示词。

### 9.2 会话命令

优先支持：

- `/status`：Provider、模型、模式、权限和上下文；
- `/model`：当前会话切换模型；
- `/clear`：清空当前历史；
- `/compact`：主动压缩上下文；
- `/cost`：显示 token 和可用成本信息；
- `/save`、`/resume`：保存与恢复会话；
- `/help`：显示会话内命令。

### 9.3 会话持久化

最小版本保存：

- 会话 ID 和时间；
- 用户与 Assistant 消息；
- 工具调用与结果摘要；
- Provider 和模型；
- workspace；
- compaction summary；
- execution log 引用。

优先评估 JSONL 或 SQLite，不在第一版引入向量数据库。

### 9.4 配置体验

增加：

- 安全的隐藏 API Key 输入；
- Provider 专属环境变量解析；
- 配置 schema 版本；
- 旧配置迁移；
- `syzzz doctor`；
- configured model 与 API reported model 区分；
- 无效配置时允许 `switch` 或 doctor 帮助修复。

### 9.5 TUI

Event Stream 稳定后，再评估：

- `@ai-sdk/tui`；
- Ink；
- 自研轻量终端渲染。

选择标准包括：Windows 兼容性、输入控制、工具审批、diff 展示、滚动、流式渲染和维护成本。TUI 不应反向控制 Agent 核心。

### Phase 4 退出条件

- 用户能够明确识别当前模式和权限；
- ask/plan 模式不能执行写入或 Shell 副作用；
- 会话关闭后可以恢复；
- 上下文、token 和执行状态可查看；
- API Key 不再必须通过命令行明文参数输入；
- 损坏或旧版配置有可操作的迁移/修复路径；
- Windows 终端连续交互具有稳定回归测试。

## 10. Phase 5：MCP、Hooks 与受限子 Agent

### 目标

在统一权限和事件系统之上扩展生态，而不是让外部能力绕过安全边界。

### 10.1 MCP Client

- 使用标准 MCP SDK；
- 支持 stdio 和必要的远程 transport；
- MCP 工具转换为内部 `ToolDefinition`；
- 复用同一个输入校验、权限、审批、取消和审计系统；
- 对 MCP Server 实施信任等级和独立权限；
- 默认不允许外部工具静默获取工作区外数据。

### 10.2 Hooks

支持有限生命周期：

- pre-turn；
- pre-tool；
- post-tool；
- turn-complete；
- error/cancel。

Hooks 不能绕过 Tool Policy，也不能默认访问密钥。

### 10.3 受限子 Agent

只有在单 Agent 长任务稳定后再实现。每个子 Agent 必须拥有：

- 独立任务目标；
- 独立上下文预算；
- 独立工具权限；
- 独立取消信号；
- 最大运行步数；
- 可追踪事件；
- 明确返回结果。

不在第一版实现开放式、自复制或无限递归的 Agent 层级。

### Phase 5 退出条件

- MCP 工具无法绕过本地权限策略；
- 外部 Server 的错误、超时和取消能够正确传播；
- Hooks 具有明确执行顺序和失败策略；
- 子 Agent 的预算、权限和生命周期受父任务控制；
- 生态扩展具有隔离测试和安全说明。

## 11. Phase 6：持续评测、发布与工程治理

该阶段不是最后才开始的单次工作，而是随着前述阶段逐步完善。

### 11.1 测试金字塔

持续建立：

1. Config、Tool、Context 等纯单元测试；
2. Provider mock 合约测试；
3. Engine/Runtime 状态机测试；
4. CLI PTY 集成测试；
5. 固定仓库 coding-task eval；
6. 少量、明确隔离的真实 Provider 冒烟测试。

真实 API 测试必须：

- 默认不在 `npm test` 中执行；
- 不读取用户正式配置；
- 不打印密钥；
- 明确 Provider、模型、费用和日期；
- 分别覆盖 Anthropic 与 OpenAI-compatible 协议。

### 11.2 CI 与发布

- Windows 和 Linux CI；
- 支持的 Node.js 版本矩阵；
- build、test、lint 和 format check；
- coverage；
- dependency audit；
- secret scanning；
- `npm pack --dry-run`；
- 安装后 `syzzz --help` smoke test；
- 版本号、CLI、CHANGELOG 和 Git Tag 单一来源。

### 11.3 Coding Agent 评测

建立可重复任务集，例如：

- 定位一个跨文件 bug；
- 添加带测试的小功能；
- 修复 TypeScript 类型错误；
- 在不修改文件的情况下解释架构；
- 拒绝工作区外写入；
- 在测试失败后继续修正；
- 在上下文接近上限时 compact 并完成任务。

记录：

- 成功率；
- 工具调用次数；
- token 使用；
- 总耗时；
- 用户审批次数；
- 错误恢复情况；
- 最终 diff 和测试结果。

### 11.4 文档治理

长期活跃文档保持精简：

- `README.md`：用户入口和当前能力；
- `CURRENT_STATUS.md`：当前事实、验证和技术债；
- `ROADMAP.md`：未来阶段和验收标准；
- `ARCHITECTURE.md`：稳定架构与 ADR；
- `TESTING.md`：测试方法和覆盖边界；
- `SECURITY.md`：威胁模型与安全使用方式；
- `CHANGELOG.md`：版本变化。

历史规划和旧报告进入 archive，不继续以“当前状态”形式维护。

## 12. 暂不进入近期范围

以下能力可能有长期价值，但在 Tool Runtime、上下文和会话稳定前不进入近期开发：

- Browser 自动化；
- Web UI；
- Electron 客户端；
- VS Code 插件；
- 插件市场；
- 团队共享与协作；
- 云端 Agent 托管；
- 企业审计平台；
- 多模态图像与语音；
- 大规模向量数据库/RAG 平台；
- 无人监督的软件发布流水线。

这些项目只有在出现真实用户需求、并且核心 CLI 能力稳定后才重新评估。

## 13. 建议版本里程碑

版本号表达交付边界，不代表日期承诺：

### v1.0.0：多 Provider CLI 基线

- 多 Provider 协议适配；
- 连续 CLI 对话；
- 基础 Tool Loop；
- 用户配置驱动的 Provider/模型切换；
- 15 项离线测试；
- 真实能力与安全限制文档。

### v1.1.0：安全 Tool Runtime

- 结构化工具契约和错误；
- 运行时输入校验；
- 工作区路径边界；
- 异步 Shell；
- 超时、取消和审批；
- 文件 diff 与工具安全测试。

### v1.2.0：事件与 Provider 可靠性

- Agent Event Stream；
- 流式输出；
- Provider typed errors；
- usage、finish reason 和延迟；
- 有限重试与执行审计。

### v1.3.0：代码库上下文与可靠编辑

- Glob/Grep/Range Read/Patch/Diagnostics；
- Context Manager；
- compaction；
- TypeScript repo map；
- coding-task eval。

### v1.4.0：会话与终端产品化

- ask/plan/code 模式；
- 会话保存和恢复；
- 状态、成本和上下文命令；
- 配置迁移与 doctor；
- 稳定 TUI。

### v2.0.0 候选方向

只有 MCP、Hooks、受限子 Agent、长期任务恢复和跨平台发布均达到稳定验收后，才评估 `v2.0.0`。

## 14. 最近行动清单

### 当前文档基线

- [x] 完成 `README.md` 本地重写；
- [x] 完成 `CURRENT_STATUS.md` 本地重写；
- [x] 完成 `ROADMAP.md` 本地编写；
- [ ] 用户审阅三份文档；
- [ ] 根据反馈修订；
- [ ] 提交并推送文档；
- [ ] 创建和推送 `v1.0.0` Tag。

### 下一开发迭代

- [ ] 设计 Tool Runtime 类型和模块边界；
- [ ] 选择并验证运行时 schema 方案；
- [ ] 先修复工具错误语义；
- [ ] 实现路径边界；
- [ ] 实现异步 Shell、timeout 和 cancellation；
- [ ] 实现最小权限审批；
- [ ] 补充真实工具测试；
- [ ] 更新安全与架构文档。

## 15. 路线图完成标准

当项目最终达到本路线图所描述的成熟状态时，应具备以下特征：

- 模型不能绕过本地权限策略；
- 所有副作用都可确认、可取消、可追踪；
- 对代码库的理解受 token 预算控制；
- 修改具有冲突检测、diff 和真实验证；
- 长会话可以压缩、保存和恢复；
- Provider 差异被限制在协议适配层；
- MCP 和子 Agent 复用相同的安全边界；
- 自动化测试能够证明核心状态机和安全属性；
- 文档不会把未来目标写成当前能力；
- 项目既可用于个人真实任务，也能够作为可信的工程和架构展示。

---

路线图的核心顺序始终是：先让执行可信，再让 Agent 更自主；先让修改可验证，再扩大工具和生态。
