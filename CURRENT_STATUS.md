# Syzzz Code 当前项目状态

**更新时间：** 2026-07-29

**当前分支：** `codex/phase5-extensions`

**Phase 4 冻结基线：** `3d2b8e6`

**当前阶段：** Phase 5 已完成实现与自动化验证，状态为 **Validated，等待人工 dogfood**

## 1. 当前结论

Phase 5 的“可信扩展运行时、MCP Broker 与受限委派”主体已经完成：

1. Phase 5.0：路径级 workspace trust、渐进式 MCP Broker、stdio 与 Streamable HTTP。
2. Phase 5.1：有序本地 Hooks、失败策略、进程与输出约束。
3. Phase 5.2：固定只读工具集、独立上下文和父级取消控制的 `explore | review` Subagent。

完整自动化测试为 **238/238**。Phase 1 至 Phase 4 的路径、权限、事件、Provider、终端、上下文、可靠编辑和会话恢复契约继续通过。

Phase 5 尚未标记 Frozen。必须先完成真实 Provider、真实终端、项目 trust、MCP、Hook 和 Subagent 人工验收。

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
- 信任记录原子保存在 `~/.syzzz-code/trusted-workspaces.json`，并绑定规范化 workspace 路径。
- 信任后的项目配置变化在重启或 reload 后直接生效，不再次确认。
- `/untrust` 立即断开项目 MCP、禁用项目 Hooks 并移除信任。
- workspace trust 独立于工作模式和权限，不等于 `acceptEdits` 或 `fullAccess`。

## 3. MCP Broker

- 精确依赖 `@modelcontextprotocol/client@2.0.0`；测试 Server 使用 `@modelcontextprotocol/server@2.0.0`。
- 只向模型暴露固定 `McpSearch` 与 `McpCall`，不把完整远端工具目录注入每次请求。
- 支持 stdio 与 Streamable HTTP。
- HTTP 强制 HTTPS，loopback 可用 HTTP；禁止重定向。
- HTTP 自定义头必须通过 `${ENV_NAME}` 解析；不实现 OAuth。
- stdio 采用 executable/argv 与 `shell:false`，Windows `.cmd/.bat` 使用显式 `ComSpec` 封装。
- stdio 只继承系统运行所需环境和显式配置；Provider 凭证环境变量即使被扩展显式引用也会拒绝。
- `protocolMode: legacy` 固定 2025-era initialize；`modern` 固定 MCP v2 `2026-07-28`。
- `readOnlyHint:true` 映射为 `read/never`；缺失或 false 映射为 `execute/always`。
- ask/plan 拒绝执行型 MCP；safe/acceptEdits 逐次审批；只有 code + fullAccess 可自动执行。
- 工具目录单 Server 最多 1000、合计最多 5000 或 4 MiB；单个畸形工具隔离。
- 工具结果和远端错误均为有界、不可信外部数据。
- MCP 调用从不自动重试；超时和取消会断开 stdio 并清理进程树。

管理入口：

```text
syzzz mcp list|add|remove|enable|disable|doctor
/mcp
/mcp reload
/mcp reconnect <name>
```

普通 `syzzz doctor` 仍完全离线；只有 `mcp doctor` 会实际连接。

## 4. Hooks

已实现事件：

```text
PreTurn
PreToolUse
PostToolUse
TurnCompleted
TurnFailed
TurnCancelled
```

- 用户 Hooks 先执行，项目 Hooks 后执行；项目同名项替换用户项。
- matcher 使用 glob，目标为 `builtin:<name>` 或 `mcp:<qualifiedName>`。
- Hook 使用 `spawn(command,args,{shell:false})`。
- 普通 Hook 默认 5 秒、最大 30 秒；终态 Hook 受 2 秒总预算约束。
- stdin 最大 64 KiB，stdout 最大 16 KiB，stderr 最大 8 KiB。
- Provider Key 不进入 payload，Provider 凭证环境变量也不能通过显式 Hook 模板重新引入。
- 只有 `PreToolUse` 能返回 `continue | deny`；拒绝理由只在本地展示，不能授权、改写输入、注入上下文或改变模式。
- 顺序固定为：输入校验与动态风险 → 模式硬边界 → Hook → 权限审批 → 工具执行。
- `PostToolUse` 只接收 outcome 和脱敏 metadata。
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
- 每次最多 6 个工具轮次、120 秒、32K context window 和 20 KiB 最终报告。
- 第 6 轮或约 90 秒时关闭工具并执行最终总结，不再以工具上限错误丢弃已有调查。
- Delegate 失败后父 Agent 以无工具请求结束，不重复执行相同调查。
- 父取消和 generator 关闭会终止子 Agent。
- usage 汇总到父回合 footer 和累计状态。
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
- 新增 `mcp_server_status`、`hook_started/completed`、`subagent_started/progress/completed`。
- Provider purpose 增加 `subagent`。
- Hook 终态事件始终出现在唯一 turn 终态之前。
- NDJSON 不包含工具结果、认证头、Hook payload、Subagent task/report/transcript。
- 审计不记录 URL、MCP 输入输出、认证头、Hook stdin/stdout 或 Subagent transcript。
- 会话仍保存模型继续工作所需的有界上下文，因此可能包含 MCP ToolResult 与 Subagent 最终报告。

## 7. 自动化验证

当前结果：

- `npm test`：**238/238**
- 官方 MCP v2 stdio：legacy 与 modern 均完成真实握手
- Streamable HTTP：真实 loopback 握手、显式认证头和不跟随重定向
- 环境脱敏：MCP 与 Hook 均不继承、也不能通过显式模板重新引入测试 Provider Key
- MCP：惰性连接、分页、list_changed、schema 隔离、目录上限、调用不重试、超时/取消、Windows 后代进程清理及带空格路径的真实 `.cmd` 握手
- 动态风险：ask/plan 拒绝副作用、fullAccess 不绕过模式、safe 逐次审批
- Hooks：顺序、matcher、deny、失败策略、输出限制、超时、取消和唯一终态
- Subagent：工具白名单、深度/数量/轮次/软收束/上下文/报告上限、usage、父取消、失败后无重复调查和无 transcript 持久化
- 扩展配置：用户/项目覆盖、路径 trust、变化后 reload、损坏范围隔离和管理输出脱敏

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
- 版本号保持 `1.0.0`
- 未发布 npm 包，未创建 Tag
- 既有 archive 行尾状态、`phase3-manual.ts` 和 `phase2-events.jsonl` 不属于 Phase 5，不纳入本阶段提交

## 10. 冻结条件

代码和自动化验证已经达到 **Validated**。下一步按照 [扩展使用指南](docs/EXTENSIONS.md) 完成以下人工 dogfood：

- 未信任项目扩展不启动；
- `yes` 不接受、单独 `y` 才建立 trust；
- ask 调用只读 MCP，副作用 MCP 服从模式与审批；
- Hook 在 fullAccess 下仍能阻止 Shell，并关闭本回合后续替代工具；
- MCP、Hook 与 Subagent 中按 Ctrl+C 能取消并清理；
- 真实 Provider 完成一次架构探索和一次只读 review；
- NDJSON、审计与会话恢复符合各自隐私边界；
- `/untrust` 立即停用项目扩展。

只有人工验收通过后，才把 Phase 5 标记为 **Frozen** 并推送分支。
