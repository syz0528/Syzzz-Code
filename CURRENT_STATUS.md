# Syzzz Code 当前项目状态

**更新时间：** 2026-07-29

**当前分支：** `codex/phase5-extensions`

**Phase 4 冻结基线：** `3d2b8e6`

**Phase 5.0 Core 检查点：** `000bcaa`

**Phase 5.1 实现验证基线：** `85b2558`

**当前阶段：** Phase 5 与 Phase 5.1 已于 2026-07-29 完成人工验收并标记为 **Frozen**

## 1. 当前结论

Phase 5.0 Core 已完成“可信扩展运行时、MCP Broker 与受限委派”的主体：

1. Phase 5.0-A：路径级 workspace trust、渐进式 MCP Broker、stdio 与 Streamable HTTP。
2. Phase 5.0-B：有序本地 Hooks、失败策略、进程与输出约束。
3. Phase 5.0-C：固定只读工具集、独立上下文和父级取消控制的 `explore | review` Subagent。

Phase 5.1 在此基础上补齐扩展配置复审、MCP 本地收紧策略与断线生命周期、统一扩展状态、压缩/委派 Hook，以及 Subagent 软硬预算和停止语义。

完整自动化测试为 **253/253**。Phase 1 至 Phase 4 的路径、权限、事件、Provider、终端、上下文、可靠编辑和会话恢复契约继续通过。

11 项真实终端 dogfood 已全部通过，覆盖项目 trust 复审、MCP 策略与断线重连、Hook、Subagent 预算、取消清理、隐私恢复和撤销信任。公开 Streamable HTTP MCP 的真实握手、工具发现与只读天气调用也已通过，Phase 5 的扩展信任和传输闭环达到冻结条件。

## 2. 扩展信任

用户配置：

```text
~/.syzzz-code/mcp.json
~/.syzzz-code/hooks.json
```

项目配置：

```text
<workspace>/.mcp.json
<workspace>/.syzzz-code/hooks.json
```

- 未受信 workspace 的项目扩展完全不加载。
- `/trust` 展示命令、参数、URL 与 Hook executable，只有单独输入 `y/Y` 生效。
- 信任记录 V2 原子保存在 `~/.syzzz-code/trusted-workspaces.json`，绑定规范化 workspace 路径和项目扩展配置的规范化 SHA-256。
- 摘要忽略空白、注释、键顺序和等价默认值，但覆盖 MCP、Hook 及项目工具策略的有效定义；不包含解析后的 Secret。
- 项目扩展配置变化、损坏或缺失时进入 `review-required`，立即断开项目 MCP 并禁用项目 Hooks，必须重新 `/trust`。
- legacy V1 信任记录迁移后同样进入 `review-required`，不会静默继续启用项目扩展。
- `/trust` 确认前后会再次读取配置；确认期间发生变化时拒绝建立信任。
- `/untrust` 立即断开项目 MCP、禁用项目 Hooks 并移除信任。
- workspace trust 独立于工作模式和权限，不等于 `acceptEdits` 或 `fullAccess`。
- 信任只审查扩展定义，不能保证配置引用的脚本或 executable 内容不再变化。

## 3. MCP Broker

- 精确依赖 `@modelcontextprotocol/client@2.0.0`；测试 Server 使用 `@modelcontextprotocol/server@2.0.0`。
- 只向模型暴露固定 `McpSearch` 与 `McpCall`，不把完整远端工具目录注入每次请求。
- 支持 stdio 与 Streamable HTTP。
- HTTP 强制 HTTPS，loopback 可用 HTTP；禁止重定向。
- HTTP 自定义头必须通过 `${ENV_NAME}` 解析；不实现 OAuth。
- stdio 采用 executable/argv 与 `shell:false`，Windows `.cmd/.bat` 使用显式 `ComSpec` 封装。
- stdio 只继承系统运行所需环境和显式配置；Provider 凭证环境变量即使被扩展显式引用也会拒绝。
- `protocolMode: legacy` 固定 2025-era initialize；`modern` 固定 MCP v2 `2026-07-28`。
- 无本地策略时，仅 `readOnlyHint:true` 且 `destructiveHint !== true` 映射为 `read/never`；缺失、冲突或无法确认时映射为 `execute/always`。
- `syzzz.toolPolicies` 可把限定工具强制为 `execute` 或 `disabled`；用户与项目策略冲突时取更严格结果。
- `disabled` 工具不可发现、不可直接调用，`fullAccess` 也不能绕过。
- ask/plan 拒绝执行型 MCP；safe/acceptEdits 逐次审批；只有 code + fullAccess 可自动执行。
- 工具目录单 Server 最多 1000、合计最多 5000 或 4 MiB；单个畸形工具隔离。
- 工具结果和远端错误均为有界、不可信外部数据。
- MCP 调用从不自动重试；协议、网络或连接失败会丢弃连接，下一次独立操作才惰性重连。
- `onclose/onerror` 会清除过期目录和连接状态；超时和取消会断开 stdio 并清理进程树。

管理入口：

```text
syzzz mcp list|add|remove|enable|disable|doctor
syzzz mcp policy <server> <tool> execute|disabled|reset --scope user|project
syzzz extensions status [--json]
/extensions
/extensions reload
/mcp
/mcp reload
/mcp reconnect <name>
/mcp inspect <name>
```

普通 `syzzz doctor` 仍完全离线；只有 `mcp doctor` 会实际连接。

## 4. Hooks

已实现事件：

```text
PreTurn
PreToolUse
PostToolUse
PreCompact
PostCompact
SubagentStart
SubagentStop
TurnCompleted
TurnFailed
TurnCancelled
```

- 用户 Hooks 先执行，项目 Hooks 后执行；项目同名项替换用户项。
- matcher 使用 glob；工具事件匹配 `builtin:<name>` 或 `mcp:<qualifiedName>`，压缩事件匹配 reason，委派事件匹配 role。
- Hook 使用 `spawn(command,args,{shell:false})`。
- 普通 Hook 默认 5 秒、最大 30 秒；终态 Hook 受 2 秒总预算约束。
- stdin 最大 64 KiB，stdout 最大 16 KiB，stderr 最大 8 KiB。
- Provider Key 不进入 payload，Provider 凭证环境变量也不能通过显式 Hook 模板重新引入。
- 只有 `PreToolUse` 能返回 `continue | deny`；拒绝理由只在本地展示，不能授权、改写输入、注入上下文或改变模式。
- 顺序固定为：输入校验与动态风险 → 模式硬边界 → Hook → 权限审批 → 工具执行。
- `PostToolUse` 只接收 outcome 和脱敏 metadata。
- 压缩 Hook 只接收 reason、前后 token、passes 和耗时；Subagent Hook 只接收角色、outcome、耗时、工具数、usage 和 stopReason。
- `PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop` 都是被动通知，不能拒绝、授权或改变运行时状态。
- `/extensions` 展示逐 Hook 最近 outcome、耗时和脱敏错误码；reload 后运行统计重置。
- Hook 是以当前用户权限运行的受信本地代码，不是 sandbox。

管理入口：

```text
syzzz hooks list|add|remove|enable|disable|doctor
/hooks
/hooks reload
```

## 5. 只读 Subagent

- `Delegate({role:'explore'|'review',task})` 只在当前 Provider 支持隔离 `fork()` 且配置启用时暴露。
- 子 Agent 固定 `ask + safe`，使用独立上下文。
- `explore` 仅有 Glob、Grep、ListDirectory、Read、GitStatus、RepoMap。
- `review` 额外获得 GitDiff、Diagnostics。
- 不提供 Write、Edit、Patch、Shell、MCP、Hooks 或 Delegate。
- 每个父回合最多 2 次，只允许一层，串行前台运行。
- 每次最多 6 个工具轮次、16 个工具调用、7 个 Provider 请求、32K context window 和 20 KiB 最终报告。
- 90 秒和 96K 累计 token 是软预算；120 秒和 128K 累计 token 是硬预算。
- 达到软期限、软 token、轮次或工具调用上限时，最多保留一次无工具归纳；剩余预算不足时直接返回 `partial`。
- 达到硬预算、硬超时或用户取消后禁止追加 Provider 请求，并携带明确 `stopReason`。
- Delegate 失败后父 Agent 以无工具请求结束，不重复执行相同调查。
- 父取消和 generator 关闭会终止子 Agent。
- usage 汇总到父回合 footer 和累计状态。
- `/agents` 显示固定预算、Provider fork 能力和最近停止原因。
- 终端不显示完整 transcript；审计只记录角色、耗时、工具数、usage、outcome 和错误码。

配置与命令：

```text
subagents.enabled = true
/agents
/agents on
/agents off
```

## 6. 事件、审计与会话

- `AgentEvent` schemaVersion 保持 1。
- `mcp_server_status` 增加连接摘要；`subagent_completed` 支持 `partial`、`stopReason`、`providerCalls` 和 `reportTruncated`。
- Provider purpose 增加 `subagent`。
- Hook 终态事件始终出现在唯一 turn 终态之前。
- NDJSON 不包含工具结果、认证头、Hook payload、Subagent task/report/transcript。
- 审计不记录 URL、MCP 输入输出、认证头、Hook stdin/stdout 或 Subagent transcript。
- 会话仍保存模型继续工作所需的有界上下文，因此可能包含 MCP ToolResult 与 Subagent 最终报告。

## 7. 自动化验证

当前结果：

- `npm test`：**253/253**
- 官方 MCP v2 stdio：legacy 与 modern 均完成真实握手
- Streamable HTTP：真实 loopback 握手、显式认证头和不跟随重定向
- 环境脱敏：MCP 与 Hook 均不继承、也不能通过显式模板重新引入测试 Provider Key
- MCP：惰性连接、分页、list_changed、schema 隔离、目录上限、策略合并、disabled 硬拒绝、调用不重试、异常断线、惰性重连、超时/取消、Windows 后代进程清理及带空格路径的真实 `.cmd` 握手
- 动态风险：annotation 冲突按 execute 处理、ask/plan 拒绝副作用、fullAccess 不绕过模式或 disabled 策略、safe 逐次审批
- Hooks：顺序、matcher、deny、四个被动生命周期事件、失败策略、payload 隐私、输出限制、超时、取消和唯一终态
- Subagent：工具白名单、深度/数量/轮次/工具数/Provider 请求/软硬 token/软收束/上下文/报告上限、partial、usage、父取消、失败后无重复调查和无 transcript 持久化
- 扩展配置：用户/项目覆盖、Trust V2 摘要稳定性、V1 复审、变化立即失效、确认期 TOCTOU、损坏 fail closed 和管理输出脱敏

人工冻结验收：

- Phase 5.1 清单：**11/11**
- 真实 Provider 与 Windows Terminal：Trust V2、策略、Hook、Explore/Review、恢复与取消均通过
- 真实远程 Streamable HTTP：协商 MCP `2025-11-25`，发现 11 个只读工具，地理编码与天气预报调用成功
- 风险闭环：未受信项目扩展不启动，配置变化进入 `review-required`，`disabled` 与 Hook deny 均不能被 `fullAccess` 绕过
- 隐私闭环：NDJSON、审计与会话恢复未泄露认证头、Hook payload 或 Subagent transcript

最终发布卫生已通过：

- `npm audit --omit=dev`：`0 vulnerabilities`
- `npm pack --dry-run --json`：204 个条目，allowlist 外文件 0，`src/tests/archive/.env/phase*` 文件 0
- `git diff --check`：退出码 0；仅有 Windows 工作树 LF→CRLF 提示，无空白错误
- `syzzz doctor`：无 Error；仅保留既有的 Windows ACL 无法自动验证提醒

## 8. 已知边界

- Shell、MCP stdio 与 Hooks 都不是 OS sandbox。
- workspace trust 允许项目配置以当前用户权限运行本地代码。
- MCP `readOnlyHint` 是受信 Server 的声明，无法证明远端实现没有副作用。
- 会话快照未加密，可能包含代码、提示、MCP 结果和 Subagent 报告。
- Windows ACL 当前只能警告未自动验证。
- 当前不支持 OAuth、旧 SSE、MCP Resources/Prompts/Sampling、HTTP/后台 Hooks。
- 当前不支持写入型、并行、后台或嵌套 Subagent。
- 当前没有完整 TUI、`@` 上下文、`$` Skills、Tag 或 npm 发布。

## 9. Git 状态

- 当前分支：`codex/phase5-extensions`
- Phase 4 冻结提交：`3d2b8e6`
- Phase 5.0 Core 非冻结检查点：`000bcaa`
- Phase 5.1 实现验证基线：`85b2558`
- Phase 5 与 Phase 5.1：2026-07-29 标记 Frozen
- 版本号保持 `1.0.0`
- 未发布 npm 包，未创建 Tag
- 既有 archive 行尾状态、`phase3-manual.ts` 和 `phase2-events.jsonl` 不属于 Phase 5，不纳入本阶段提交

## 10. 冻结条件

Phase 5.1 实现、253 项自动化测试、发布卫生、11 项人工 dogfood 与真实远程 MCP smoke test 均已通过。Phase 5.1 和 Phase 5 统一标记为 **Frozen**。

此后除 P0 安全、数据破坏或确定性扩展协议回归外，不再重新打开 Phase 5 增加能力。OAuth、MCP Resources/Prompts/Sampling、写入型或并行 Subagent、Skills 与完整 TUI 继续留在后续独立阶段评估；下一阶段进入 Phase 6。
