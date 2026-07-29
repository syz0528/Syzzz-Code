# Syzzz Code 扩展使用指南

## 1. 配置范围

用户级配置：

```text
~/.syzzz-code/mcp.json
~/.syzzz-code/hooks.json
```

项目级配置：

```text
<workspace>/.mcp.json
<workspace>/.syzzz-code/hooks.json
```

同名项目项覆盖用户项。用户 Hooks 先执行，项目 Hooks 后执行；项目同名 Hook 替换用户项。项目配置在 `/trust` 前完全不加载。

`/trust` 会完整展示项目 stdio 命令与参数、HTTP URL、Hook executable、参数、工具策略及配置摘要前缀。只有单独输入 `y` 或 `Y` 才会生效。信任同时绑定规范化 workspace 路径与当前项目扩展配置摘要。

摘要基于验证并补全默认值后的 MCP、Hook 和项目工具策略生成，忽略空白、注释、键顺序和等价默认值，不保存解析后的 Secret。项目配置发生有效变化、损坏或缺失后，状态会变为 `review-required`，项目 MCP 立即断开、项目 Hooks 立即禁用，必须重新 `/trust`。legacy V1 信任记录也必须重新审查。

确认过程中 Syzzz 会再次读取配置；若摘要变化则拒绝授权。信任校验只覆盖扩展定义，不能保证配置引用的脚本或 executable 内容不再变化，也不是 OS sandbox。

## 2. MCP

### 2.1 stdio 配置

```json
{
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/server.mjs"],
      "env": {
        "SERVICE_TOKEN": "${LOCAL_SERVICE_TOKEN}"
      },
      "enabled": true,
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 60000,
      "protocolMode": "legacy"
    }
  }
}
```

`command` 与 `args` 分离执行，不接受拼接 Shell 字符串。Windows `.cmd/.bat` 会通过受测的 `ComSpec` 参数封装；需要 PowerShell 时应把 `powershell.exe` 配为 executable，并把脚本参数放入 `args`。

MCP 与 Hook 只继承运行所需的少量系统环境变量及显式模板。任何已在 Provider 配置中声明为 `API_KEY_ENV` 的变量，即使被显式写入扩展模板，也会在连接或执行前拒绝。

### 2.2 Streamable HTTP 配置

```json
{
  "mcpServers": {
    "remote-tools": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${REMOTE_MCP_TOKEN}"
      },
      "enabled": true,
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 60000,
      "protocolMode": "legacy"
    }
  }
}
```

HTTP 自定义头必须包含 `${ENV_NAME}`；实际值仅在连接时解析。HTTPS 是默认硬要求，`localhost`、`127.0.0.1` 和 `::1` 可使用 HTTP。客户端不跟随重定向，也不实现 OAuth 或旧 SSE。

`protocolMode`：

- `legacy`：默认，固定走 2025-era initialize，不进行可能重复启动 stdio 进程的自动探测。
- `modern`：固定到 MCP v2 的 `2026-07-28` modern 协议。

### 2.3 管理命令

```text
syzzz mcp list
syzzz mcp add <name> <executable> [args...]
syzzz mcp add <name> --url <https-url> --header 'Authorization=Bearer ${TOKEN}'
syzzz mcp remove <name>
syzzz mcp enable <name>
syzzz mcp disable <name>
syzzz mcp doctor [name]
syzzz mcp policy <server> <tool> execute|disabled|reset --scope user|project
syzzz extensions status [--json]
```

增加 `--scope project` 可写入项目配置。`syzzz mcp doctor` 会真实连接；普通 `syzzz doctor` 始终离线。

交互命令：

```text
/mcp
/mcp reload
/mcp reconnect <name>
/mcp inspect <name>
/extensions
/extensions reload
```

### 2.4 风险矩阵

| 本地策略或 MCP 声明 | 动态风险 | ask/plan | code + safe/acceptEdits | code + fullAccess |
| --- | --- | --- | --- | --- |
| `disabled` | 不可用 | 拒绝且不可发现 | 拒绝且不可发现 | 拒绝且不可发现 |
| `execute` | `execute/always` | 拒绝 | 逐次审批 | 自动执行 |
| 无策略；`readOnlyHint:true` 且非 destructive | `read/never` | 允许 | 允许 | 允许 |
| 无策略；声明缺失、冲突或无法确认 | `execute/always` | 拒绝 | 逐次审批 | 自动执行 |

用户与项目策略冲突时取更严格结果：`disabled > execute > remote annotation`。项目策略只有在项目摘要受信时生效。风险解析失败、schema 无效、Server 不可用或审批 handler 缺失时一律 fail closed。

MCP 工具调用不会自动重试。Server 意外关闭、网络或协议错误会清除连接和目录，不会重放当前调用；下一次独立搜索或调用才会惰性重连。`/mcp inspect <server>` 可查看协议、连接状态、工具风险来源和本地策略。

`McpSearch` 默认返回 10 项、最多 20 项，并支持分页。工具名固定为 `<server>__<tool>`，因此 Server 名不能包含 `__`。文本、structured JSON 和 UTF-8 embedded resource 会进入有界结果；图片、音频、二进制与 resource link 只返回占位说明。

## 3. Hooks

Hook 配置使用有序数组：

```json
{
  "schemaVersion": 1,
  "hooks": [
    {
      "name": "block-shell",
      "event": "PreToolUse",
      "matcher": "builtin:Shell",
      "command": "node",
      "args": ["path/to/policy-hook.mjs"],
      "timeoutMs": 5000,
      "onError": "deny",
      "env": {},
      "enabled": true
    }
  ]
}
```

支持事件：

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

`matcher` 使用 glob。工具事件目标为 `builtin:<name>` 或 `mcp:<server>__<tool>`；压缩事件匹配 reason；Subagent 事件匹配 `explore | review`。只有 `PreToolUse` 可以使用 `onError:"deny"` 并在 stdout 返回：

```json
{"decision":"deny","reason":"blocked by local policy"}
```

空 stdout 等价于 continue。输出包含其他字段、无效 JSON 或非法 decision 时按 Hook 失败处理。`reason` 只用于本地终端展示，不进入 Provider 的 ToolResult。Hook 不能通过返回值授权、修改工具调用或向模型注入上下文。

`PreToolUse` 返回 deny 后，本回合工具访问立即关闭：同一批次中尚未执行的工具会被跳过，下一次 Provider 请求不再提供工具。这样既不会重复运行已拒绝的命令，也不会用 Write 或其他工具绕过同一被拒绝操作。

`PreCompact`、`PostCompact`、`SubagentStart` 和 `SubagentStop` 是被动通知：stdout 决策会被忽略，失败只降级为状态警告。压缩 Hook 只接收 reason、前后 token、passes 和耗时；Subagent Hook 只接收角色、outcome、耗时、工具数、usage 和 stopReason。摘要、任务、报告和 transcript 不进入 payload。

管理命令：

```text
syzzz hooks list
syzzz hooks add <name> <executable> [args...] --event <event>
syzzz hooks remove <name>
syzzz hooks enable <name>
syzzz hooks disable <name>
syzzz hooks doctor

/hooks
/hooks reload
```

`hooks doctor` 只检查配置与 executable 形状，不运行 Hook。

## 4. 只读 Subagent

配置默认启用：

```json
{
  "subagents": {
    "enabled": true
  }
}
```

交互中使用：

```text
/agents
/agents on
/agents off
```

只有当前 Provider 实现隔离 `fork()` 时才向模型暴露 `Delegate`。`explore` 可使用 Glob、Grep、ListDirectory、Read、GitStatus 和 RepoMap；`review` 额外获得 GitDiff 与 Diagnostics。两种角色都没有写入、Shell、MCP、Hooks 或继续委派能力。

固定预算如下：

- 每个父回合最多委派 2 次，只允许一层，串行前台执行；
- 每次最多 6 个工具轮次、16 个工具调用和 7 个 Provider 请求；
- 90 秒软期限、120 秒硬期限；
- 96K 累计 token 软预算、128K 硬预算；
- 32K context window 和 20 KiB 最终报告。

达到软期限、软 token、轮次或工具调用上限时，工具目录被移除，最多允许一次基于现有证据的无工具归纳；时间或 token 不足时直接返回 `partial`。达到硬预算、硬超时或用户取消后不再发起 Provider 请求，并返回明确 `stopReason`。父 Agent 应直接使用成功报告，除非报告明确证据不足，否则不得重复同一轮只读遍历。

## 5. 人工验收

自动化通过后，在临时工作区完成以下 Phase 5.1 dogfood；通过前只能标记 `Validated`，不能标记 Frozen。

1. **未信任边界**

   在临时 workspace 放置项目 `.mcp.json` 和 Hook 配置，启动 `syzzz`。`/status` 应显示项目配置存在但未受信；`/mcp` 不应启动项目 Server。

2. **信任提示与配置复审**

   执行 `/trust`，确认终端完整显示命令、参数、URL、Hook executable、工具策略和 digest 前缀。输入 `yes` 应取消；再次执行并输入 `y` 才生效。

   信任后修改项目 `.mcp.json` 或 Hook 有效字段并执行 `/extensions reload`。状态必须变为 `review-required`，项目 MCP/Hook 立即失效；重新 `/trust` 后才恢复。只改空白或键顺序不应触发复审。

3. **MCP 渐进发现**

   在源码仓库可用测试 Server：

   ```text
   syzzz mcp add phase5-fixture node tests/fixtures/mcp-stdio-server.mjs
   syzzz mcp doctor phase5-fixture
   ```

   在 ask 模式要求 Agent 先 `McpSearch` 再调用只读 `echo`。终端不应显示认证值，结果应标记为外部不可信数据。

4. **本地策略与动态权限**

   将 fixture 的 `echo` 设为 `execute`，确认 ask/plan 拒绝、code + safe 逐次审批。再设为 `disabled`，确认 `McpSearch` 不返回该工具，直接调用和 code + fullAccess 同样拒绝。`reset` 后恢复远端 annotation。

5. **断线与惰性重连**

   在一次 MCP 调用中让 stdio Server 异常退出。当前调用不得自动重放；`/mcp inspect` 应显示断开或错误。下一次独立搜索或调用才应启动新进程并重新连接。

6. **Hook 拒绝**

   配置一个匹配 `builtin:Shell` 的 `PreToolUse` Hook 返回 deny。即使 code + fullAccess，Shell 也必须被 Hook 阻止，并且本回合不得再尝试 Write 等替代工具；Hook 不应收到 Provider Key。

   若要使用文件验证副作用，请让 Shell 写入工作区外的唯一临时路径，因为工作区内文件原本可由 Write 创建。另一种做法是让测试 Hook 匹配 `builtin:*`。不要用“仅匹配 Shell + 工作区内文件存在性”推断所有写入工具都被禁止。

7. **压缩与 Subagent Hook**

   配置 `PreCompact/PostCompact/SubagentStart/SubagentStop` Hook，将 stdin 脱敏记录到临时文件。执行 `/compact` 及一次 Delegate，确认事件顺序正确，payload 不含摘要、任务、最终报告或 transcript，Hook 返回 deny 也不能改变结果。

8. **取消与清理**

   在 MCP 连接、MCP 调用、Hook 执行和 Subagent 运行中分别按一次 Ctrl+C。当前回合应取消，CLI 保持可用，stdio/Hook 后代进程不应残留。

9. **只读委派与预算**

   使用真实 Provider 要求一次架构探索和一次只读 review。终端只显示紧凑状态与最终报告；Subagent 不应调用 Shell、写文件、MCP 或 Delegate。构造足够长的调查，确认软预算会收束为成功或 `partial`，并显示明确停止原因；硬停止后不得出现追加 Provider 请求。

10. **隐私与恢复**

   检查 `stream-json`、审计和会话快照。NDJSON 与审计不得包含 MCP 认证头、Hook payload 或 Subagent transcript；会话可以包含有界 MCP 结果和 Subagent 最终报告。重启恢复后权限必须仍重置为 safe。

11. **撤销信任**

   执行 `/untrust`。项目 MCP 应立即断开，项目 Hooks 应停止生效；用户级扩展保持可用。

测试结束后移除 fixture：

```text
syzzz mcp remove phase5-fixture
```
