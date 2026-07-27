# Syzzz Code 路线图

**制定日期：** 2026-06-16
**最近更新：** 2026-07-23
**适用基线：** `1.0.0` / Phase 1.1 本地冻结提交 `8e275c3`
**当前入口：** Phase 3 已冻结，下一项进入 Phase 4 会话、模式与终端产品体验

> 路线图描述实施顺序和验收边界。当前代码事实以 [`README.md`](README.md) 和 [`CURRENT_STATUS.md`](CURRENT_STATUS.md) 为准。

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
Phase 1.1  稳定化（权限模式 / ListDirectory / 环境 prompt）
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
- [x] 用户审阅当前三份活跃文档；
- [x] 提交并推送文档；
- [ ] 创建 annotated `v1.0.0` Git Tag；
- [ ] 确认远程 `main` 和 `v1.0.0` 指向同一文档基线提交。

### 退出条件

- 根目录存在准确的 README、当前状态和路线图；
- 文档不再声称 OAuth fallback、流式输出、四厂商开箱即用等未实现能力；
- 正式测试范围和人工真实验证范围被清楚区分；
- 安全限制在入口文档中可见；
- Git Tag 可以作为后续大改的恢复点。

## 6. Phase 1：Tool Runtime 安全与正确性

**状态：** 已推送到远程 `main`（`63ad76c`），37 项离线测试通过。

### 目标

将当前“模型直接调用四个高权限函数”的工具层，升级为具有类型、权限、取消和审计基础的 Tool Runtime。

这是下一阶段最高优先级，也是后续流式 UI、MCP、子 Agent 和自主执行的共同基础。

### 已交付

- [x] 统一 `ToolDefinition`、`ToolContext`、`ToolResult` 和风险元数据；
- [x] 使用 Zod 校验输入并生成 Provider JSON Schema；
- [x] 建立工作区路径边界、敏感路径策略和 symlink/junction 防逃逸；
- [x] Write/Edit 写入前展示 diff，并以内容 hash 检测审批后的变化；
- [x] Write/Edit/Shell 在缺少审批或用户拒绝时 fail closed；
- [x] 使用异步 Shell，支持 timeout、取消、进程树终止和输出限制；
- [x] 贯通 CLI、Engine、Provider 与工具的 `AbortSignal`；
- [x] 扩展到 37 项离线回归测试并同步活跃文档；
- [x] 提交并推送 Phase 1 基线。

该基线的已知限制包括 Shell 非沙箱和文件非原子落盘；其中原子替换已在 Phase 1.1 最终稳定化中闭合。Provider typed errors、请求 timeout、事件审计仍属于后续阶段。

## 6A. Phase 1.1：Tool Runtime 稳定化

**状态：** 最终稳定化实现、57 项自动化测试、生产依赖审计、npm 包内容检查与真实 Provider dogfood 已通过；状态为 **Frozen**。

### 目标

在不进入 Phase 2 的前提下，修复真实试用暴露的审批疲劳与探索依赖 Shell 的问题，使 Phase 1 从 Validated 进入 Stabilized，再冻结进入 Phase 2。

### 交付内容

- [x] 会话级权限模式 `safe` / `acceptEdits` / `fullAccess`；
- [x] `/permissions` 查看与切换；`fullAccess` 只有单独输入 `y`/`Y` 才启用，确认可由 `Ctrl+C` 单独取消；
- [x] 结构化审批选择：`allow-once` / `allow-edits-session` / `deny`，由 Engine 提供允许选项并对非法返回 fail closed；
- [x] Write/Edit 可授权本会话后续编辑，Shell 只能逐次允许且不能间接升级权限；
- [x] 策略求值：自动放行时仍运行 `prepareApproval` 以保留 Write/Edit `executionData`；
- [x] system prompt 注入 Platform、Shell executor 与专用工具偏好；
- [x] 最小只读工具 `ListDirectory`；
- [x] Read 通过文件句柄限制为 1 MiB 普通 UTF-8 文件，并补充 Windows 特殊路径词法拦截；
- [x] Write/Edit 使用同目录临时文件、flush、mode 保留、最终复核和原子替换；
- [x] 移除 dotenv 自动加载，Shell 仅继承启动进程环境；
- [x] npm 包采用 `dist`/`README.md` 白名单、Node.js `>=20` 与构建型 `prepack`；
- [x] `form-data` 更新到 `4.0.6`，生产依赖审计为 0 漏洞；
- [x] OpenAI-compatible 工具链保留 `reasoning_content`，并对 reasoning-only `stop` 进行一次同模型、禁用 thinking 的受限恢复；
- [x] 扩展离线测试至 57 项并同步 README / CURRENT_STATUS / ROADMAP。

### 明确不做

- Shell 语义分类器、命令 allowlist、沙箱、凭证隔离或后台任务；
- 永久权限配置、完整输入路由/TUI 状态机、文件锁或事务日志；
- Glob/Grep/Read Range/Patch、Event Stream 或新的 Agent 能力。

### 退出条件

- [x] 三模式行为符合矩阵，且 `fullAccess` 下文件边界仍生效；
- [x] `/permissions` 与审批输入不泄漏为聊天消息；
- [x] `npm test` 57/57 全绿；
- [x] `npm audit --omit=dev` 无 High/Critical（当前实际为 0 漏洞）；
- [x] `npm pack --dry-run --json` 内容符合 allowlist；
- [x] dogfood：Safe 会话编辑、Full Access 严格确认、冲突/临时文件、Shell 子进程和重启恢复；
- [x] 使用真实 Provider 完成一次“查看结构、修改文件、运行测试”的小任务；
- [x] 标记 **Frozen**，此后除 P0 安全或数据破坏问题外直接进入 Phase 2。

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

**状态：** Phase 2 与 Phase 2.1 已于 2026-07-23 标记为 **Frozen**。

### 目标

把 `chat(): Promise<string>` 演进为可流式、可观察、可取消、可供 CLI 与机器消费者复用的 Agent Runtime，同时保持 Phase 1.1 的权限和文件安全边界。

### 7.1 已实现的 Agent Event Stream

- [x] `AgentEvent` 使用 `schemaVersion: 1`、session/turn ID、sequence 与 timestamp；
- [x] 固定 turn、phase、provider、reasoning status、text delta、retry、usage、tool、approval 和终态事件；
- [x] `runTurn()` 返回 AsyncGenerator，`chat()` 保持兼容；
- [x] 只允许一个 completed/failed/cancelled 终态；
- [x] 失败/取消不提交会话历史；提前关闭消费者执行统一清理；
- [x] 当前 Promise 工具只产生 started/completed，不伪造实时 tool output；
- [x] 不公开 reasoning delta，只报告开始、结束、耗时和字符数。

### 7.2 已实现的 Provider 可靠性

- [x] OpenAI-compatible 真流式与 tool-call 碎片聚合；
- [x] Anthropic 保持非流式，并明确 `streaming: false`；
- [x] 最小 capabilities 只包含 streaming 与 reasoning toggle；
- [x] ProviderError 分类与脱敏公共形状；
- [x] SDK 自动重试关闭，由 Runner 统一管理 attempt；
- [x] 120 秒 attempt、3 次上限、180 秒总预算；
- [x] 指数退避、正负 20% jitter、Retry-After 与 30 秒等待上限；
- [x] 正文或 tool-call delta 后禁止重试；
- [x] Provider 忽略 AbortSignal 时仍由 Runner 硬超时；
- [x] reasoning-only 与 stream_options 兼容恢复共享 attempt 和预算；
- [x] request ID、reported model、usage 与 finish reason 进入事件。

### 7.3 已实现的 CLI 与审计

- [x] interactive 与 `chat -m` 统一消费事件；
- [x] 正文、spinner、工具、审批和重试状态分离；
- [x] footer 展示可获得的 token、耗时与 finish reason；
- [x] `--output-format text|stream-json`；
- [x] NDJSON stdout 不含 ANSI、启动文本、工具结果正文或 metadata；
- [x] 退出码固定为 0/1/130；
- [x] 本地 JSONL 审计默认保留 30 天、上限 20 MiB；
- [x] 审计只记录元数据和 workspace 短 hash，不记录 prompt、正文、路径、diff、工具输入输出、Shell 输出或 reasoning；
- [x] 审计失败 fail open，并且每进程只警告一次。

### 7.4 Phase 2.1 已实现的交互发现与 UX 收尾

- [x] `CommandDefinition` 注册表统一名称、别名、描述、参数、动态选项、可用性和执行函数；
- [x] 首批 `/stream`、`/permissions`、`/model`、`/help`、`/exit`，以及 `/quit`、`/?` 别名；
- [x] 未知 Slash 本地报错并给出近似候选，`//` 转义为普通消息；
- [x] 轻量单行 TTY 输入支持 `/` 即时候选、过滤、导航、历史、粘贴、中文宽度、缩放和最多 8 行滚动；
- [x] 非 TTY/raw mode 不可用时回退逐行模式；
- [x] 可扩展异步 `SuggestionProvider` 支持 Abort 与过期结果丢弃，本期只注册 `/`；
- [x] `ui.streamOutput`、`/stream on|off` 和进程级 `chat --stream on|off`；
- [x] 展示关闭不改变 Provider/Event 实时流，`stream-json` 不受影响且禁止与 `--stream` 混用；
- [x] 当前 Provider 配置列表内 `/model` 热切换、持久化与 reasoning metadata 清理；
- [x] interactive/`chat -m` 统一 `HumanEventRenderer`，压缩 Read/List 成功状态并扩展 footer 统计；
- [x] 0ms 兼容恢复在普通终端只显示瞬时友好状态，机器事件保持完整；
- [x] 系统提示减少盲目遍历、重复 Shell 查询和仅为格式重跑工具，并约束精确计数与审查范围表述。

### 明确不做

- Anthropic 真流式；
- 完整 capability 数据库或费用估算；
- TUI、上下文治理、会话恢复、MCP、并行工具、新 Agent 能力；
- 真正的 `@` 上下文和 `$` Skill 选择器；
- Shell allowlist、AST、后台任务或自动审批。

### Phase 2/2.1 退出条件

- [x] TypeScript 构建通过；
- [x] 新增事件、Provider、流式、审计、命令、终端输入与 renderer 自动化测试；当前套件共 114 项；
- [x] `npm audit --omit=dev` 为 0 vulnerabilities；
- [x] `npm pack --dry-run --json` 内容符合 allowlist；
- [x] 真实 `deepseek-v4-flash-free` 纯文本流式通过；
- [x] 真实 `ListDirectory -> Read -> 最终回答` 工具链通过；
- [x] 在普通本机终端完成 `npm test` 114/114；
- [x] 真实 PowerShell 完成 `/stream`、中文流式、Provider 切换、紧凑工具展示和退出交互复核；
- [x] 权限、模型切换、Slash 菜单、取消和 Shell 进程树具备自动化回归，产品所有者接受剩余非阻塞人工 smoke test；
- [x] 用独立 Node 消费真实 CLI `stream-json` 并检查敏感内容不存在；
- [x] 产品所有者批准标记 **Frozen**，直接进入 Phase 3。

## 8. Phase 3：代码库上下文与可靠编辑闭环

**状态：** 2026-07-24 完成自动化、发布卫生与真实 Provider 验收并标记为 **Frozen**；2026-07-27 完成克制型 Context Hardening。

### 目标

让 Agent 能够高效理解中型代码库，并以可验证、低冲突的方式修改代码，而不是依赖无限制 Shell 和全文件读取。

### 8.1 专用代码工具

已完成：

1. [x] Glob：使用随包 ripgrep 按文件模式发现候选文件；
2. [x] Grep：有界正则/字面量搜索、上下文、分页与多种输出模式；
3. [x] Read Range：按行范围读取并返回 hash、换行格式与 continuation；
4. [x] Patch：基于 expectedHash 的唯一、非重叠精确修改；
5. [x] Diagnostics：受限 Worker 中的 TypeScript Compiler API `noEmit`；
6. [x] GitStatus/GitDiff：只读查看工作区和暂存区变化；
7. [x] RepoMap：支持目录或单文件焦点的 TS/JS import 图、顶层符号与相关度排序。

这些工具必须复用 Phase 1 的权限、路径和审计机制。

### 8.2 可靠 Patch

- [x] 修改前要求文件版本或内容 hash；
- [x] 上下文必须唯一匹配；
- [x] 多匹配时拒绝并要求更多上下文；
- [x] 复用 Phase 1.1 的同目录临时文件和原子替换；
- [x] 检测用户或其他进程的并发修改；
- [x] 修改后生成 diff 与新 hash；
- [x] 支持用户拒绝；撤销、文件锁与事务日志继续留在后续阶段。

### 8.3 Context Manager

已完成：

- [x] 模型 context window 与单模型配置覆盖；
- [x] 当前 turn 预算估算与 Provider usage 事件；
- [x] 85% 自动压缩阈值与 50% 目标；
- [x] 对话历史、当前用户和工具组原子性；
- [x] 40 KiB 工具结果硬上限，并按当前模型窗口剩余预算动态收缩；Shell 错误保留头尾；
- [x] 摘要输入受当前安全阈值与 256 KiB 双重约束；
- [x] 最新工具组仅在阻塞下一次安全请求时进行原子级紧急压缩；
- [x] 无可压缩组、三轮后仍超阈值或必要摘要失败时 fail closed；
- [x] compaction summary 的旧摘要再汇总、两次尝试、三次失败熔断、取消和隐私边界；
- [x] Provider 模型切换后的窗口重新评估；
- [x] `context_exceeded` 单次强制压缩恢复；
- [x] 写入成功后回合中断的内存级重新读取回执。

当前没有手动 `/compact`、`/status`、摘要查看或跨进程回执；这些能力不回填 Phase 3。

### 8.4 Repo Map

TypeScript/JavaScript 第一版已实现：

- [x] ignore 与敏感路径过滤后的文件候选；
- [x] 相对 import/export 关系；
- [x] 顶层类型、类、函数和变量签名；
- [x] Git 修改状态；
- [x] 查询相关度与一跳图邻接排序；
- [x] mtime/size 当前进程缓存；
- [x] 最多 100 个文件和 40 KiB 输出。

实现采用 TypeScript Compiler API。真正的全仓引用数据库、方法级语义索引、LSP、持久化索引与跨语言 Tree-sitter 未实现。

RepoMap 按需调用，不自动注入每个 prompt。

### 8.5 修改验证

系统提示要求代码任务完成前，根据项目类型选择最小必要检查：

- [x] TypeScript `Diagnostics`；
- [x] GitDiff；
- [x] 通过现有 Shell 审批执行 targeted tests、lint 或 build；
- [x] 只能依据真实 Tool Result 声明通过、失败或未运行。

固定中型 TS 仓库已完成 `Glob -> Grep -> RepoMap -> Read -> Patch -> GitDiff -> Diagnostics -> tsc` 回归。

### Phase 3 退出条件

- [x] Agent 能先搜索再读取相关文件；
- [x] 中型仓库上下文有窗口预算与有界工具结果；
- [x] 长会话可以自动 compact；
- [x] 文件编辑能检测多匹配、旧 hash 和并发变化；
- [x] 写入结果包含 diff 与新版本；
- [x] 任务完成报告只能包含实际执行的验证和结果；
- [x] 建立固定中型 TS 仓库 coding-task 回归；
- [x] `npm test` 158/158，Context Manager 专项 27/27；
- [x] `npm audit --omit=dev` 为 0 vulnerabilities；
- [x] npm pack allowlist 与 `git diff --check` 通过；
- [x] 真实 Provider 完成 RepoMap/Diagnostics、CRLF Patch、自动压缩、模型缩窗与压缩取消；
- [x] 标记 **Frozen**，下一项进入 Phase 4。

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

Phase 2.1 已提供 `/model`、`/help`、`/permissions`、`/stream` 与 `/exit` 的注册式基础。Phase 4 在同一注册表上继续增加：

- `/status`：Provider、模型、模式、权限和上下文；
- `/clear`：清空当前历史；
- `/compact`：主动压缩上下文；
- `/cost`：显示 token 和可用成本信息；
- `/save`、`/resume`：保存与恢复会话；
- `/provider`：切换 Provider；是否接入在线模型发现另行评估。

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

### 已完成

- [x] 冻结 Phase 1.1 安全 Tool Runtime；
- [x] 建立 AgentEvent 与 `runTurn()`；
- [x] 实现 OpenAI-compatible 真流式和 Anthropic 非流式兼容；
- [x] 实现 ProviderError、硬 timeout、有限重试和 usage；
- [x] 实现 CLI 事件渲染与 stream-json；
- [x] 实现元数据审计与清理；
- [x] 完成交互命令注册表、Slash 菜单、流式展示开关与当前 Provider 模型切换；
- [x] 完成紧凑工具渲染、footer 统计和系统提示收尾；
- [x] 扩展正式测试套件到 114 项；
- [x] 完成生产依赖审计和 npm 包内容检查；
- [x] 完成真实 DeepSeek 纯文本与只读工具 dogfood。

### 冻结结果

- [x] 普通 PowerShell 执行 `npm test` 114/114；
- [x] 真实 PowerShell 完成展示开关、中文流式、Provider 切换和降噪 dogfood；
- [x] 权限、模型、菜单、取消和 Shell 生命周期回归覆盖通过，剩余人工按键组合被接受为非阻塞观察；
- [x] 独立消费者验证真实 CLI NDJSON 及脱敏；
- [x] 提交 Phase 2/2.1 冻结状态。

### 下一阶段入口

Phase 3 已冻结。下一阶段进入 Phase 4，会话持久化、工作模式与终端产品体验继续建立在现有 Runtime、Context Manager 和工具边界上。

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
