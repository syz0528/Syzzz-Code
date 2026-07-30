# Syzzz Code 安全说明

## 安全模型

Syzzz Code 的目标是让模型能力始终经过本地 Runtime 的模式、权限、审批、取消、输出限制和审计边界。它不是 OS sandbox，也不能证明外部服务或用户授权的本地程序是可信实现。

安全判断按以下层次执行：

1. `ask | plan | code` 工作模式；
2. 工具输入校验和动态风险解析；
3. ask/plan 执行层硬边界；
4. `PreToolUse` Hook；
5. `safe | acceptEdits | fullAccess` 权限与用户审批；
6. 工具自身的工作区、超时、输出和进程清理约束。

`fullAccess` 只能跳过普通审批，不能绕过 ask/plan、路径边界、Hook 拒绝或输入校验。

## Workspace Trust

项目扩展配置位于：

```text
<workspace>/.mcp.json
<workspace>/.syzzz-code/hooks.json
```

它们在 workspace 未受信时完全不加载。`/trust` 将授权绑定到规范化后的 workspace 路径，并把记录保存在：

```text
~/.syzzz-code/trusted-workspaces.json
```

信任记录 V2 同时绑定规范化 workspace 路径和经过验证、补全默认值后的项目扩展配置 SHA-256。摘要覆盖 MCP、Hook 和项目工具策略定义，但不包含解析后的 Secret。配置变化、损坏、缺失或 legacy V1 信任迁移都会进入 `review-required`：项目 MCP 立即断开，项目 Hooks 立即禁用，重新 `/trust` 后才可恢复。

`/trust` 在显示配置和用户确认后重新读取摘要，避免确认期间配置变化。该机制审查的是扩展定义，不会追踪被引用脚本或 executable 文件内容的后续变化，也不是普通工具审批。它不等于 `acceptEdits` 或 `fullAccess`。

`/untrust` 会立即断开项目 MCP、禁用项目 Hooks 并移除路径信任。用户级 `mcp.json` 和 `hooks.json` 由用户直接维护，因此不依赖 workspace trust。

## MCP 边界

- stdio 使用固定 executable 和 argv，`shell:false`；Windows `.cmd/.bat` 通过显式 `ComSpec` 参数运行。
- stdio 只继承系统运行所需环境变量和配置中明确列出的变量；Provider 配置声明的凭证环境变量即使被扩展显式引用也会拒绝。
- Streamable HTTP 必须使用 HTTPS；只有 loopback 可使用 HTTP；重定向被禁止。
- HTTP 自定义头必须通过 `${ENV_NAME}` 引用环境变量。当前不实现 OAuth。
- 本地 `execute | disabled` 策略只能收紧远端声明；用户与项目冲突时取更严格结果。
- `disabled` 工具不会被发现，直接调用也会 fail closed，任何权限模式都不能绕过。
- 无本地策略时，仅 `readOnlyHint:true` 且 `destructiveHint !== true` 映射为只读工具；缺失、冲突或无法解析时映射为执行型工具并 fail closed。
- `readOnlyHint` 是受信 Server 的声明，不是 Syzzz 对远端实现的证明。
- MCP 调用不自动重试，避免重复副作用；连接或协议错误会丢弃连接，下一次独立操作才惰性重连。
- 工具目录和结果均有硬上限；正常结果和远端错误都会标记为不可信外部数据。
- 图片、音频、二进制和 resource link 不会自动读取。

MCP Server 仍可按照其进程权限访问本机资源，远端 Server 也可能记录收到的参数。只配置你愿意信任的 Server。

## Hooks 边界

Hook 是用户明确授权的本地代码，以当前操作系统用户权限运行。它不是模型工具，也不是 sandbox。

- `PreTurn` 可看到当前用户消息。
- 工具 Hook 可看到对应工具输入。
- `PostToolUse` 只接收 outcome 和脱敏 metadata，不接收原始工具结果。
- `PreCompact | PostCompact` 只接收 reason、token、passes 和耗时；`SubagentStart | SubagentStop` 只接收角色、outcome、耗时、工具数、usage 和停止原因。
- Provider Key 不会进入 Hook payload；Provider 配置声明的凭证环境变量即使被 Hook 显式引用也会拒绝。
- 只有 `PreToolUse` 可以返回 `continue | deny`；压缩与 Subagent Hook 都是不能拒绝或改变状态的被动通知。
- Hook 的拒绝理由只在本地展示，Provider 只收到固定的策略拒绝结果。Hook 不能授权、修改工具输入、注入模型上下文、改变工作模式或提升权限。
- `PreToolUse` 拒绝会关闭当前回合后续工具访问；同批次未执行调用被跳过，Provider 只能在无工具状态下说明拒绝，不能换用其他工具绕过。
- 非 `PreToolUse` Hook 的失败不会改变回合终态；终态 Hook 受 2 秒总预算约束。

由于 Hook 本身可读写操作系统资源，信任项目 Hook 等价于信任该项目指定的本地程序。

## Subagent 边界

`Delegate` 只提供 `explore | review` 两种只读角色：

- 固定 `ask + safe`；
- 不提供 Write、Edit、Patch、Shell、MCP、Hooks 或 Delegate；
- 每个父回合最多 2 次，只允许一层且串行执行；
- 每次最多 6 个工具轮次、16 个工具调用、7 个 Provider 请求、32K context window 和 20 KiB 最终报告；
- 90 秒与 96K 累计 token 是软预算，120 秒与 128K 累计 token 是硬预算；
- 达到软预算时至多保留一次无工具总结，证据不足或预算不足时返回带停止原因的 `partial`；达到硬预算或取消后禁止追加 Provider 请求；
- Delegate 完成后父 Agent 不在同一回合重复同一只读调查，除非报告明确证据不足；
- 与父回合共享取消信号；
- 不保存完整 transcript。

Subagent 使用当前 Provider 和 model 的隔离 fork，因此委派任务和读取到的代码仍会发送给当前 Provider。父历史和本地会话会保留有界的 `Delegate` 调用参数与最终报告，但不会保存子 Agent 的完整 transcript。

## 本地数据

会话快照未加密，可能包含用户提示、代码、工具结果、MCP 返回和 Subagent 报告。审计仅保存 allowlist 元数据，不保存 prompt、URL、认证头、工具输入输出、Hook payload 或 Subagent transcript。

敏感工作区建议：

- 使用 `sessions.autoSave=false`；
- 使用 `API_KEY_ENV`，不要在配置文件中保存 API Key；
- 定期检查 `~/.syzzz-code/sessions` 与 `~/.syzzz-code/audit`；
- 不对来源不明的项目执行 `/trust`；
- 在 `safe` 或只读模式下先完成检查。

## 已知限制

- Shell、MCP stdio 和 Hooks 都不是 OS sandbox。
- Trust V2 不会对被配置引用的脚本或 executable 做内容锁定。
- Windows ACL 当前只能提示未自动验证，不能证明本地文件仅当前用户可读。
- 文件最终 hash 复核到原子 rename 之间仍有极小 TOCTOU 窗口。
- 当前不支持 OAuth、Keychain、磁盘加密、云端审计、旧 SSE、后台 Hook 或写入型 Subagent。

## 供应链与发布

- `package.json` 是版本、CLI 名称和 npm metadata 的唯一事实源。
- 构建前会删除 `dist`，避免已删除源码留下陈旧发布文件。
- tarball 使用 allowlist，不包含 `src`、`tests`、`archive`、Eval fixture、本地配置、日志或会话。
- 普通 CI 不接收 Provider Key，默认权限仅为 `contents: read`；第三方 GitHub Action 固定完整 commit SHA。
- 发布只允许从 `main` 手动触发，并受 `npm-release` Environment 和精确确认短语保护。
- 已存在的 npm 版本只有在 registry integrity 与本地候选 tarball 完全一致时才允许恢复 Tag/Release。
- Eval 报告只记录脱敏指标，不保存 prompt、回答、源码、Shell 输出、Secret、reasoning 或 transcript。
- 当前树和完整可达 Git 历史会执行高置信凭证模式扫描；测试占位符只能通过精确字面量白名单排除。

首次发布计划使用一次性、短期限、最小权限 npm granular token。发布工作流在所有路径的最后尝试撤销该 token；仓库所有者仍必须在 npm 控制台复核撤销结果，并在后续版本切换到 npm Trusted Publishing/OIDC。

## 报告问题

安全问题请通过仓库维护者提供的私密渠道报告，不要在公开 Issue 中粘贴 API Key、认证头、私有代码、会话快照或完整审计文件。报告应包含受影响版本、复现条件、预期边界和实际结果，并尽量使用脱敏的最小复现。
