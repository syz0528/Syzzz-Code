# Syzzz Code 当前项目状态

**更新时间：** 2026-07-23
**当前分支：** `codex/phase2-runtime`
**当前阶段：** Phase 2.1 已冻结，准备进入 Phase 3
**Phase 1.1 本地冻结提交：** `8e275c3`
**远程 `origin/main`：** `da6858d`
**包版本：** `1.0.0`（未发布、未创建 Tag）

> 本文档记录当前工作树的真实状态。2026-07-23，产品所有者基于完整自动化、真实 Provider、真实 PowerShell 与机器输出验收结果，批准将 Phase 2.1 标记为 Frozen。

## 1. 当前结论

Phase 1/1.1 的 Tool Runtime 与安全边界已经冻结。当前分支已完成 Phase 2 的事件化 Agent Runtime、OpenAI-compatible 真流式、Provider 可靠性、NDJSON 与元数据审计，也完成了 Phase 2.1 的 Slash 发现、展示流开关、当前 Provider 模型切换、工具输出降噪和轻量终端输入。

当前状态定义为 **Frozen**。代码构建和完整 114 项自动化测试通过；生产依赖审计、npm 包内容检查、真实 Provider、中文流式、只读工具链、兼容恢复、无效 Key 分类、紧凑工具展示和独立 NDJSON 消费均有通过记录。此后除 P0 安全或数据破坏问题外，不再回到 Phase 2 增加能力。

本阶段没有增加新的 Agent 工具、TUI、上下文治理、会话恢复、MCP、并行工具或自动审批。

## 2. Phase 2 已实现内容

### 2.1 事件化 Runtime

- 新增版本化 `AgentEvent` 判别联合类型；
- 所有事件包含 `schemaVersion: 1`、`sessionId`、`turnId`、单调递增 `sequence` 和 ISO 时间戳；
- 固定事件类型包括 turn、phase、provider、reasoning 状态、text delta、retry、usage、tool、approval 与唯一终态；
- `runTurn(message, options)` 返回 `AsyncGenerator<AgentEvent, TurnResult>`；
- `chat(message, options)` 只消费同一事件流，保持原有 Promise 契约；
- 成功回合在 `turn_completed` 终态边界提交完整工作历史；
- 失败或取消不提交消息历史，但已经发生的外部副作用仍通过工具 outcome 审计；
- 消费者提前关闭 generator 时会关闭嵌套 Provider/工具 generator、取消内部等待并释放处理锁；
- 多工具调用继续串行执行，Phase 1.1 的权限模式、审批快照和 10 轮工具上限不变。

### 2.2 Provider Runner

- 两个 SDK 均设置 `maxRetries: 0`，Runner 是唯一重试所有者；
- 单次 attempt 最长 120 秒，每次 Provider 调用最多 3 次，总预算 180 秒；
- Runner 自身使用可中断等待，即使 Provider 忽略 `AbortSignal`，硬超时仍能结束调用；
- 只重试 rate limit、timeout、network、500/502/503/504；
- 退避为 500ms 起步、指数增长、正负 20% jitter，单次最多 10 秒；
- 尊重 `Retry-After`，但不等待超过 30 秒或剩余总预算；
- 一旦已发出正文 delta 或收到任何 tool-call delta 就不再重试；
- 用户 Abort 优先于 timeout/retry，并映射为 `turn_cancelled`；
- ProviderError 对外只暴露分类、状态码、request ID 和安全文案，内部保留 cause。

错误分类已覆盖 authentication、permission、model_not_found、not_found、rate_limit、timeout、network、context_exceeded、malformed_response、unsupported_feature、provider_internal 和 unknown。

### 2.3 Provider 协议

- OpenAI-compatible 使用 `stream: true` 与 `stream_options.include_usage`；
- 按 tool-call index 聚合碎片化 id、name 和 arguments，流完成后才解析 JSON；
- 端点显式拒绝 `stream_options` 时仅允许一次不带该参数的兼容恢复；
- `reasoning_content` 不进入正文、NDJSON 或审计，只产生 started/completed、耗时和字符数；
- 工具链需要时才在 Provider 内部回放 reasoning；
- reasoning-only `stop` 的禁用 thinking 恢复与通用重试共享 attempt 和总预算；
- Provider 响应可携带 request ID、reported model、usage 和 finish reason；
- Anthropic 明确声明 `streaming: false`，继续走非流式 `chat()`，但使用统一事件、错误、重试和 usage 语义。

### 2.4 CLI 与机器输出

- interactive 与 `chat -m` 都消费 `runTurn()`；
- 首个正文 delta 前显示 Thinking/reasoning 状态，正文开始后停止 spinner；
- 工具、审批和重试使用独立状态行，不与正文直接混排；
- 完成 footer 显示可获得的 input/output tokens、耗时和 finish reason；
- `chat -m` 支持 `--output-format text|stream-json`，默认 text；
- `stream-json` stdout 只输出逐行 `AgentEvent` JSON，不含 ANSI、spinner、Provider 启动文本、工具结果正文或 metadata；
- 退出码固定为成功 0、失败 1、取消 130；
- 普通审批仍通过 Promise callback 决策，事件只负责展示、机器输出和审计。

### 2.5 本地元数据审计

- 默认路径为 `~/.syzzz-code/audit/YYYY/MM/DD/<sessionId>.jsonl`；
- `audit.retentionDays` 默认 30，设为 0 时停止后续审计；
- `audit.maxBytes` 默认 20 MiB；
- 启动时尽力删除过期文件，再按 mtime 清理非当前会话文件；
- workspace 只记录规范化路径的 16 字符 SHA-256 标识；
- 只记录 turn/provider/retry/usage/approval 结果/tool outcome/终态元数据；
- 不记录 prompt、text delta、文件路径、diff、工具输入输出、Shell 输出或原始 reasoning；
- 审计失败不会中断 Agent，当前进程只警告一次。

### 2.6 Phase 1.1 安全契约保持不变

- 权限模式仍为 `safe | acceptEdits | fullAccess`；
- Write/Edit 审批支持本次允许、本会话允许编辑、拒绝；Shell 只支持本次允许或拒绝；
- `fullAccess` 只能通过权限命令并单独输入 `y`/`Y` 启用；
- Read 只接受 1 MiB 以内普通 UTF-8 文件；
- 文件工具保留 lexical/realpath/symlink/junction/敏感路径/Windows 特殊路径检查；
- Write/Edit 保留 hash 快照、冲突检测、同目录临时文件、flush、mode 和原子替换；
- Shell 仍不是沙箱，继续继承 Syzzz 启动时的正常进程环境。

### 2.7 Phase 2.1 交互发现与终端 UX

- 建立声明式 `CommandDefinition` 注册表，首批主命令为 `/stream`、`/permissions`、`/model`、`/help`、`/exit`；别名为 `/quit`、`/?`；
- 未知 Slash 命令只在本地报错并给出近似候选，`//` 转义后才作为普通消息发送；
- TTY 下输入 `/` 即时显示最多 8 行候选，支持过滤、Up/Down、Enter、Tab、Esc、历史、粘贴、中文宽度和窗口缩放；
- 非 TTY 或 raw mode 不可用时回退逐行模式，完整 Slash 命令仍可执行；
- `SuggestionProvider` 支持异步候选、`AbortSignal` 与过期结果丢弃，本期只注册 `/`；
- `/stream on|off` 持久化 `ui.streamOutput`；`chat --stream on|off` 仅覆盖当前进程，且不影响 Provider/Event 流；
- `/model` 只允许当前 Provider 的配置模型；切换期间保留通用历史并清理 Assistant 私有 reasoning metadata；
- interactive 与 `chat -m` 共用 `HumanEventRenderer`；Read/List 成功瞬时展示，Write/Edit/Shell 成功保留一行，异常始终保留；
- footer 增加工具调用、失败与重试计数；`stream-json` 保持完整实时事件，不受 UI 展示配置影响；
- reasoning-only 与 `stream_options` 的 0ms 兼容恢复在普通终端只显示瞬时友好状态，不再持久输出内部错误码；NDJSON 与审计语义不变；
- 系统提示减少无目的遍历、重复 Shell 查询和仅为格式重跑成功工具的行为，并要求核实精确计数、准确描述抽样与穷尽审查的边界。

## 3. 自动化测试状态

当前测试套件共有 114 项：

| 文件 | 数量 | 主要范围 |
|---|---:|---|
| `tests/cli.test.mjs` | 11 | CLI、Slash、配置持久化、权限输入、Ctrl+C |
| `tests/config.test.mjs` | 8 | 配置、UI/audit 默认值、`.env` 隔离 |
| `tests/engine.test.mjs` | 17 | 工具循环、审批、权限、取消 |
| `tests/provider-protocol.test.mjs` | 8 | 两类协议转换与兼容恢复 |
| `tests/shell-runner.test.mjs` | 8 | Shell 生命周期与进程树 |
| `tests/tools.test.mjs` | 11 | 路径、Read、原子 Write/Edit |
| `tests/runtime-events.test.mjs` | 9 | 事件顺序、终态、历史、关闭、模型切换 |
| `tests/provider-runner.test.mjs` | 14 | error、timeout、retry、预算 |
| `tests/openai-stream.test.mjs` | 5 | 流式碎片聚合、模型与 DeepSeek V4 capability |
| `tests/anthropic-provider.test.mjs` | 2 | 非流式统一语义、模型切换 |
| `tests/audit.test.mjs` | 4 | allowlist、脱敏、清理、降级 |
| `tests/cli-renderer.test.mjs` | 6 | NDJSON、footer、紧凑工具状态、流式显示 |
| `tests/interactive-commands.test.mjs` | 4 | 命令注册、别名、动态候选、未知命令建议 |
| `tests/terminal-input.test.mjs` | 7 | TTY 菜单、历史、粘贴、中文宽度、异步候选 |

当前环境已完成：

- `npm run build`：通过；
- `npm test`：114/114 通过；
- Windows 后代进程清理定向压力复测：20/20 通过；
- `npm audit --omit=dev`：0 vulnerabilities；
- `npm pack --dry-run --json`：通过，包内只含 `dist`、`README.md` 和 npm 必需的 `package.json`；
- `git diff --check`：通过，只有既有 archive/行尾提示。

Windows Shell 清理曾受 `taskkill /T` 超时、辅助进程残留和系统“不支持该请求”影响。现先用 Node 原生终止根 shell，再由带 4 秒硬截止的 PowerShell 辅助进程通过 Windows Toolhelp API 快照父子 PID，从叶到根执行 `Stop-Process -Force`，并短轮询确认目标 PID 全部消失。该路径不依赖 WMI/CIM；后代延迟写入与 PID 存活断言保持不变，最终版本 20 次定向压力复测已全部通过。

## 4. 真实 Provider 验证

2026-07-22 使用用户配置中现存的 `deepseek-v4-flash-free`，在不改写当前 Provider 选择、不输出 API Key、关闭测试审计的条件下完成：

1. 纯文本流式：完成，49 个 `text_delta`，finish reason 为 `stop`，usage 为 282 input / 448 output / 730 total，reported model 正确；
2. reasoning 可观测性：只输出 started/completed 和 1772 字符计数，未输出原始推理；
3. 只读工具链：`ListDirectory -> Read -> 最终回答` 完成，两次工具 outcome 均为 success，最终正文与文件内容一致；
4. 工具执行发生在完整 tool-call 聚合之后，三个 Provider 回合均正常完成。

因此，用户此前遇到的 `Provider returned an empty response (finish reason: stop)` 已不再阻塞当前流式 Runtime 主链路。真实 Provider 仍可能因模型决策质量、提示编码或第三方端点差异产生行为偏航，这与协议层空响应错误应分开判断。

同日使用 OpenCode `deepseek-v4-flash` 复核中文流式输出：20 个正文增量可无损拼接为完整中文回答。交互终端曾因对已停止的 ora spinner 重复调用 `stop()` 而将光标移回行首、覆盖先前增量；现已改为只停止仍在运行的 spinner，并增加对应回归测试。

同一 OpenCode 端点已验证接受 `thinking: { type: "disabled" }` 且不再返回 reasoning delta。适配器现在同时依据 Provider 名称和明确的 `deepseek-v4-*` 模型 ID 判断 capability，避免 OpenCode 等中立网关名称使 reasoning-only 恢复被错误关闭。

2026-07-23 的真实 PowerShell 复核进一步确认：

1. `/stream off` 缓冲正文、`/stream on` 恢复实时展示，中文增量无乱码；
2. 一次只读项目分析完成 5 次 ListDirectory 和 16 次 Read，成功状态未刷屏，footer 正确显示 `tools 21`；
3. 真实 CLI 的 NDJSON 经独立 Node 消费者解析 10 个连续事件，首事件为 `turn_started`、唯一终态为 `turn_completed`，未发现 API Key、system prompt、原始 reasoning、工具输入或 diff 字段；
4. 使用隔离无效 Key 的真实请求被 Provider Runner 和公共失败事件一致归类为 `authentication`，只发起 1 次 attempt 且未重试；
5. reasoning-only 恢复能够自动成功；普通终端现只显示瞬时响应模式调整状态，完整诊断仍保留在机器事件中。

## 5. Phase 2.1 冻结决定

2026-07-23，产品所有者确认当前自动化与真实终端结果足以冻结 Phase 2.1。冻结依据包括：

- 114/114 自动化测试、生产依赖审计、npm 包 allowlist 和 diff 检查通过；
- DeepSeek/OpenCode 中文流式、reasoning-only 恢复和只读工具链通过；
- `/stream on|off`、Provider 切换、紧凑工具输出和双 `Ctrl+C` 退出经过真实 PowerShell 复核；
- 独立 Node 消费真实 NDJSON、敏感字段检查和无效 Key authentication 分类通过；
- 权限输入、模型热切换、TTY 菜单、审批取消与 Shell 进程树具有自动化回归覆盖。

Slash 菜单的全部按键组合、同一 Provider 多模型实切以及 sampling/审批/Shell 三处取消仍可作为日常非阻塞 smoke test 继续观察，但不再阻止冻结。只有发现 P0 安全、数据破坏或明确交互阻塞问题时才重新打开 Phase 2。

## 6. 已知限制与风险

### P0/P1

- Shell 不是 OS sandbox，获批命令可能修改工作区外状态；
- Write/Edit 最终复核到 rename 之间仍有极小 TOCTOU 窗口；
- API Key 仍明文存储在用户配置中；
- 会话历史仍随进程内对话无限增长，没有 token 预算或 compaction；
- 审计是本地元数据追踪，不是防篡改事务日志，也不能回滚副作用。

### 有意留到后续阶段

- Anthropic 真流式；
- Glob/Grep/Range Read/Patch/Diagnostics；
- Context Manager、repo map 与 compaction；
- 会话保存恢复、ask/plan/code 模式和稳定 TUI；
- MCP、Hooks、插件、子 Agent、并行工具与后台任务。
- 真正的 `@` 文件/上下文选择器和 `$` Skill 选择器；当前只有可扩展候选接口。

## 7. 下一步决策

Phase 2.1 已冻结。下一项工作直接进入 Phase 3 的代码库上下文与可靠编辑闭环，优先处理 Glob/Grep/Range Read、Context Manager、compaction、可靠 Patch/Diagnostics 与修改验证，不再继续扩展 Phase 2 的终端或 Provider 能力。
