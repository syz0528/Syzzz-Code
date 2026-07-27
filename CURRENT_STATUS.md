# Syzzz Code 当前项目状态

**更新时间：** 2026-07-27
**当前分支：** `codex/phase3-context`
**实现基线：** `1bcc967`（已冻结的 Phase 2.1）
**当前阶段：** Phase 3 已完成验收，状态为 **Frozen**

> 本文档记录当前工作树的真实能力、验证结果和残余风险。Phase 3 仍在工作树中，尚未调整 `1.0.0` 版本号、发布 npm 包或创建 Tag。

## 1. 当前结论

Phase 3 的“代码库上下文与可靠编辑闭环”已经完成，包含三个部分：

1. Phase 3.0：Glob/Grep、Read Range、可靠 Patch、GitStatus/GitDiff；
2. Phase 3.1：Context Manager、自动压缩、上下文事件、失败写入回执；
3. Phase 3.2：TS/JS RepoMap、TypeScript Diagnostics、受限 Worker。

当前完整测试为 **158/158**。生产依赖审计为 **0 vulnerabilities**，npm dry-run 包保持 `dist`、`README.md` 与 npm 固定元数据白名单，真实 `deepseek-v4-flash-free` 已完成新工具、CRLF 编辑、自动压缩、模型缩窗和压缩取消验证。冻结后的克制型 Context Hardening 补丁已关闭小窗口工具结果、摘要输入和压缩后置条件三个明确边界。

Phase 1/1.1 与 Phase 2/2.1 的权限、路径、事件、Provider、流式、CLI 和审计契约继续保留，没有引入 TUI、会话恢复、MCP、并行工具或子 Agent。

## 2. Phase 3.0：搜索、读取与可靠编辑

### 2.1 Glob 与 Grep

- 使用随包提供的 `@vscode/ripgrep` 二进制，固定参数直接 `spawn`，不经过 Shell；
- 遵循 ignore 文件，不跟随 symlink，强制排除 `.git`、`.ssh`、真实 `.env`、凭证与私钥路径；
- `Glob` 默认 200、最大 1000，提供 offset/limit 和明确 truncation；
- `Grep` 支持正则/字面量、大小写、上下文、glob 与 `content | files | count`；
- 正文默认 200、最大 2000，文件/计数默认 500、最大 10000；
- 单行最多 1000 字符、总输出 40 KiB、搜索超时 20 秒。

### 2.2 Read Range

- 输入为 `{ path, offset?, limit? }`，行号从 1 开始；
- 默认 500 行、最大 2000 行；
- 返回总行数、换行格式、SHA-256 版本和下一页位置；
- 无显式范围仍受 1 MiB 限制；显式范围最多扫描 8 MiB；
- 通过文件句柄检查普通文件，严格验证 UTF-8，并在读取后复核 stat；
- 模型可见输出限制为 40 KiB，超限提供 continuation。

### 2.3 Patch 与现有编辑工具

- `Patch` 接受 `expectedHash` 和最多 20 个 `{ oldText, newText }`；
- 每个 oldText 必须在原文件中唯一，多个操作不得重叠；
- 只支持精确匹配与一致的 CRLF/LF 适配，不做模糊缩进、引号或语义匹配；
- `Edit` 可选 `expectedHash`；
- `Write`、`Edit`、`Patch` 成功结果均返回新 hash、变更统计和有界 diff；
- 三者继续复用审批快照、同目录 `wx` 临时文件、flush、mode 保留、最终 hash 复核和原子 rename。

### 2.4 GitStatus 与 GitDiff

- 只读查看工作区或暂存区，不接受任意 revision；
- 关闭 ext-diff 和 textconv；
- 先枚举并过滤敏感路径，再生成 diff；
- 状态和 diff 始终有数量、参数长度、时间与 40 KiB 输出边界。

## 3. Phase 3.1：Context Manager

### 3.1 窗口与估算

- 配置新增 `context.autoCompact`，默认 `true`；
- `context.defaultWindowTokens` 默认 `65536`；
- Provider 可通过 `modelContextWindows` 为单个模型提供窗口覆盖；
- 解析顺序为模型覆盖、Provider 信息、64K 默认值；
- Provider 报告的 input tokens 用作已发生请求的权威值；
- 下一次请求前缺少权威值时，采用保守的 UTF-8 字节数除以 2 估算，并计入 system prompt 与工具 schema。

### 3.2 自动压缩

- 触发阈值为 `min(window * 85%, window - 8192)`；
- 压缩目标为窗口的 50%，单次 Provider 请求最多执行 3 轮压缩；
- 当前用户问题始终保留；
- Assistant tool calls 与随后全部 Tool Results 作为不可拆分原子组；
- 单个工具结果保留 40 KiB 绝对上限，并根据下一次请求的剩余窗口动态收缩；
- 最新工具组默认保留；只有该组本身使下一次请求无法低于安全阈值时，才允许完整整组紧急压缩；
- 已有摘要会与更旧消息一起重新汇总；
- 摘要使用当前 Provider/模型，但不提供工具，也不输出摘要正文；摘要转录按当前窗口预算约束，并设 256 KiB 绝对上限；
- 空摘要、无法缩减、工具调用或协议异常均视为失败；
- 瞬时 Provider 错误最多 2 次 attempt，连续失败 3 次后打开会话级熔断；
- 只有上下文已低于安全阈值、仅继续追求 50% 目标时，后续压缩失败才可恢复；否则返回 `context_compaction_failed`；
- 无安全可压缩组、三轮后仍达到阈值或有界摘要请求仍超预算时 fail closed，不继续调用 Provider；
- `context_exceeded` 且尚未输出正文或 tool-call delta 时，只允许一次强制压缩恢复。

### 3.3 事件、取消和历史

- 新增 `context_usage_updated`、`compaction_started/completed/failed`；
- Provider、Retry、Usage 事件可标记 `purpose: turn | compaction`；
- 审计只记录 token 数、消息数、耗时和脱敏错误，不记录摘要；
- CLI 压缩状态为瞬时显示，footer 统计压缩次数；
- 压缩期间取消会关闭嵌套 Provider stream，产生唯一 `turn_cancelled`；
- 失败或取消的 turn 不提交摘要或当前用户消息；
- 写文件成功后若回合失败，下一 turn 会收到内存级重新读取回执；
- 回执不跨进程持久化，跨进程恢复留在 Phase 4。

### 3.4 真实取消缺陷及修复

真实 Provider 缩窗取消首次验证时，OpenAI SDK 在 `request_started` 后返回了晚到的 `APIUserAbortError`。原因是操作 Promise 已创建，而 `waitForOperation()` 发现 signal 已取消后直接返回，未观察该 Promise 的最终拒绝。

现已在提前取消分支显式观察晚到 rejection，并增加“`request_started` 后取消 + SDK 延迟拒绝”的回归。真实复测结果为：

- 当前 turn 返回 `cancelled`；
- 唯一终态为 `turn_cancelled`；
- 已提交历史保持不变；
- 下一 turn 以 `model_switch` 原因完成压缩；
- 最终产生 `compaction_completed` 与 `turn_completed`；
- 进程不再出现未处理 rejection。

## 4. Phase 3.2：TS/JS 分析

### 4.1 RepoMap

- 接受目录或单个 TS/JS 焦点文件，不自动注入每个 prompt；
- 提取相对 import/export 图与顶层函数、类、接口、类型和变量签名；
- 按显式焦点文件、查询相关度、Git 修改状态和图邻接排序；
- 默认最多 50 个文件、最大 100 个文件、输出 40 KiB；
- 使用 mtime/size 当前进程缓存，不创建磁盘索引；
- 严格 UTF-8，读取前后复核 stat，单文件分析上限 2 MiB。

### 4.2 Diagnostics

- 使用 TypeScript Compiler API 的 `noEmit` 诊断；
- 支持源文件、目录和 `tsconfig.json`；
- 单文件诊断自动查找最近的 `tsconfig.json`，加载安全候选依赖，但只报告目标文件；
- 不执行 npm scripts、TypeScript plugins、ESLint、测试或构建；
- 分析 Worker 支持 Abort，超时 60 秒，旧生代内存上限 512 MiB；
- 最多返回 200 项与 40 KiB；
- ignore 与敏感源文件不会进入候选，也不会出现在诊断结果中。

## 5. 自动化验证

2026-07-27 Context Hardening 后最终执行结果：

- `npm test`：**158/158**；
- `npm run test:context`：**27/27**；
- `npm run smoke:context`：真实 `deepseek-v4-flash-free` 通过；
- `npm audit --omit=dev`：**0 vulnerabilities**；
- `npm pack --dry-run --json`：成功，包含 `dist`、`README.md`、`package.json`，不包含 `src`、`tests`、`archive` 或本地事件文件；
- `git diff --check`：无空白错误，仅报告 Windows 工作树的 LF/CRLF 转换提示；
- 中型 TS 固定仓库完成 `Glob -> Grep -> RepoMap -> Read -> Patch -> GitDiff -> Diagnostics -> tsc` 全链路；
- Windows Shell 进程树清理回归继续通过。

新增或扩展的重点覆盖包括：

- 搜索分页、精确满额、ignore、敏感路径、Windows 路径与 symlink/junction；
- Read 1 MiB/8 MiB 边界、长行、UTF-8、CRLF、hash 与并发变化；
- Patch 多操作、重叠、多匹配、旧 hash、审批后冲突与临时文件清理；
- 85% 触发、50% 目标、工具组原子性、旧摘要再汇总、两次摘要尝试、三次失败熔断、缩窗和强制恢复；
- 16K 窗口动态工具结果预算、256 KiB 摘要硬上限、有界摘要请求、最新工具组紧急压缩和三轮后 fail-closed；
- 压缩中取消、历史回滚、写入后中断回执、事件顺序与审计隐私；
- RepoMap 目录/单文件焦点、图与缓存、Diagnostics 隔离、Worker 主动取消、重启和宿主 Node 参数隔离；
- ASCII-safe `stream-json` 在 Windows PowerShell 5.1 下连续 2000 条中文事件全部成功解析。

## 6. 真实 Provider Dogfood

使用当前配置的 `deepseek-v4-flash-free` 和 OpenCode 端点完成：

1. **架构分析：** 模型依次调用 `RepoMap`、`Diagnostics`，两个 outcome 均为 success，NDJSON sequence 单调，唯一终态为 `turn_completed`；
2. **单文件诊断：** 首次暴露默认编译选项假阳性；修复后自动采用根 `tsconfig.json`，关联 36 个文件，诊断总数为 0；
3. **CRLF 修改：** 在临时工作区完成 `Read -> Patch`，目标值正确更新，CRLF 保留，临时文件数为 0；
4. **自动压缩：** 先以 100K 窗口建立合法历史，再缩至 16K；真实摘要调用将估算输入从 12,905 降至 1,062，唯一标记保留，产生 `compaction_started/completed` 并最终 `turn_completed`；
5. **缩窗取消：** 模拟窗口从 100K 缩至 16K，在 compaction Provider 请求开始时取消，历史回滚；下一 turn 成功完成 `model_switch` 压缩；
6. **机器输出：** 真实中文回复产生 18 条 ASCII-safe NDJSON 事件，Windows PowerShell 5.1 全部经 `ConvertFrom-Json` 成功解析，sequence 单调且唯一终态为 `turn_completed`。

Dogfood 未改动仓库业务文件，临时工作区在验证后清理。

## 7. 已知边界

- Shell 仍不是安全沙箱，继承启动进程环境，也没有命令 allowlist 或凭证隔离；
- 最终路径/hash 复核到 rename 之间仍存在很小的 TOCTOU 窗口；
- token 估算不是 tokenizer，只有 Provider usage 是已发生请求的权威值；
- 自动压缩摘要可能丢失低相关细节；极端超大原子组的摘要输入会确定性保留首尾并省略中段；当前没有 `/compact`、`/status` 或摘要查看命令；
- RepoMap 不是持久化索引、LSP 或全仓引用数据库，仅支持 TS/JS 轻量分析；
- Diagnostics Worker 的资源限制不是 OS sandbox；
- 写入后失败回执仅存在当前进程内；
- Anthropic 仍为非流式兼容路径；
- 不同 OpenAI-compatible 端点仍可能在 tool schema、usage 或 reasoning 行为上存在差异。

## 8. 冻结决定

Phase 3 已满足自动化、发布卫生和真实 Provider 验收条件，状态标记为 **Frozen**。此后除 P0 安全、数据破坏、取消崩溃或明确上下文错误外，不再在 Phase 3 扩展能力。

下一阶段进入 Phase 4。`/compact`、`/status`、会话持久化、完整 TUI、MCP、并行工具、子 Agent 和跨语言语义分析不回填到 Phase 3。

## 9. Git 状态

- 当前分支：`codex/phase3-context`；
- 基线：`1bcc967`；
- 远程 Phase 2.1：`origin/codex/phase2-runtime` 指向 `1bcc967`；
- `main` 为 `8e275c3`，`origin/main` 为 `da6858d`；
- 包版本仍为 `1.0.0`，未发布 npm 包、未创建 Tag；
- `archive/pre-v1.0.0/scripts/*` 的既有行尾工作树变化和未跟踪 `phase2-events.jsonl` 不属于 Phase 3，不纳入本阶段变更。
