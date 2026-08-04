# Syzzz Code 当前项目状态

**更新时间：** 2026-08-04

**当前分支：** `codex/phase7.1-skills`

**Phase 4 冻结基线：** `3d2b8e6`

**Phase 5.0 Core 检查点：** `000bcaa`

**Phase 5.1 实现验证基线：** `85b2558`

**Phase 5 冻结基线：** `64789ec`

**Phase 7 起始基线：** `161391a`

**当前阶段：** Phase 7 与 Phase 7.1 已 **Frozen**；Phase 6 保持 **Release Candidate Accepted**；Phase 1 至 Phase 5.1 保持 **Frozen**

## 1. 当前结论

Phase 5.0 Core 已完成“可信扩展运行时、MCP Broker 与受限委派”的主体：

1. Phase 5.0-A：路径级 workspace trust、渐进式 MCP Broker、stdio 与 Streamable HTTP。
2. Phase 5.0-B：有序本地 Hooks、失败策略、进程与输出约束。
3. Phase 5.0-C：固定只读工具集、独立上下文和父级取消控制的 `explore | review` Subagent。

Phase 5.1 在此基础上补齐扩展配置复审、MCP 本地收紧策略与断线生命周期、统一扩展状态、压缩/委派 Hook，以及 Subagent 软硬预算和停止语义。

当前完整自动化测试为 **319/319**。Phase 1 至 Phase 7.1 的路径、权限、事件、Provider、终端、上下文、可靠编辑、会话恢复、扩展、任务组合和发布契约继续通过。

11 项真实终端 dogfood 已全部通过，覆盖项目 trust 复审、MCP 策略与断线重连、Hook、Subagent 预算、取消清理、隐私恢复和撤销信任。公开 Streamable HTTP MCP 的真实握手、工具发现与只读天气调用也已通过，Phase 5 的扩展信任和传输闭环达到冻结条件。

Phase 6 不增加 Agent 自治能力，当前改造集中在：

- Node 22/24、版本单一来源、ESLint、Prettier 和覆盖率门槛；
- 五种离线 Provider 协议 Profile；
- 七项固定 Coding Agent Eval 与只保存元数据的报告；
- Windows/Ubuntu CI、生产依赖审计、许可证与完整 Git 历史 Secret 扫描；
- npm tarball allowlist、全新 prefix 安装、配置迁移、文本与 NDJSON smoke；
- Apache-2.0、架构/测试/变更日志以及人工门控发布工作流。

Phase 6 本地自动化、真实 DeepSeek/OpenCode Live Eval、候选 tarball、GitHub 跨平台 CI 和人工 dogfood 已经通过，当前标记为 **Release Candidate Accepted**。Live Eval 完成全部七项隔离任务，结果为 7/7、功能成功率 100%、安全项通过且无基础设施错误；提交 `014e182` 的 CI 共 10 个 job 全绿，覆盖 Windows/Ubuntu 与 Node 22/24。人工验收使用真实 tarball 的隔离安装，覆盖 Node 22/24、doctor、模式与权限、会话恢复、取消、NDJSON、MCP、Hook 和只读 Subagent；npm、Tag 与 GitHub Release 尚未创建，因此不能标记为 Frozen。

完整 Phase 2–6 历史已于 2026-07-31 fast-forward 到远程 `main`，`main` 与 Phase 6 分支指向同一发布准备提交。仓库继续保持 Private；当前个人 GitHub Free 套餐不支持私有仓库的 protected branches、required checks、Environment 保护、Secret Scanning 或 Push Protection，因此这些设置保留到公开前的最后一步。私有阶段可用的 Dependabot vulnerability alerts、自动安全修复和分组更新已经启用。

Phase 7 从 `161391a` 新建 `codex/phase7-task-composition`，聚焦无权限的任务组合层：

- `@path`、引号路径、行范围、目录清单与字面转义；
- 用户、workspace 和嵌套 `AGENTS.md` 的分层、按需加载与重新注入；
- Agent Skills 规范 frontmatter、确定性覆盖、显式 `$skill` 和受控 `ActivateSkill`；
- `ReadSkillResource` 的 Skill 根路径与 UTF-8/大小边界；
- 公开 HTTPS Git Skill 的固定 commit 安装、更新、单版本回滚和移除；
- `/context`、`/skills`、`syzzz skills`、`@/$` 候选、版本化事件和隐私审计；
- 五项新增固定 Eval：显式证据、嵌套指令、Skill 工作流、恶意 Skill 不越权和安装后调用。

这些能力不能改变工作模式、权限、审批、Hook、MCP policy 或路径边界。项目 Skill 不要求 `/trust`，因为它只提供无权限指令和只读资源；Skill 中的 `allowed-tools` 与脚本不会自动执行或转换为授权。

Phase 7.1 从 `9bb4e62` 新建 `codex/phase7.1-skills`，只做 Skills 产品化加固：

- 新用户安装目录改为 `~/.agents/skills`，旧来源和旧安装锁继续兼容；
- `agents/openai.yaml` 的 interface、隐式调用策略和 MCP dependency 诊断；
- 每回合自动刷新、按模型窗口 2% 限制的 catalog、8 个激活与 128 KiB 正文预算；
- 用户 Skill symlink、仓库内项目 symlink、canonical target 复核与有界资源清单；
- 已激活 Skill 的显式 Shell cwd，继续服从 mode、审批、Hook、取消和审计；
- `skills create|validate|test`，其中 Live activation eval 使用隔离 ask+safe Engine 且只暴露 `ActivateSkill`；
- `$` 候选单行压缩、来源标记和预留行复用，完整 TUI 留给 Phase 8。

冻结门禁为 319/319、coverage 82.34%/75.91%/86.41%、offline Eval 12/12；生产依赖审计、包内容检查、候选包安装 smoke 与 Windows/Ubuntu Node 22/24 CI 全部通过。用户 dogfood 已覆盖全局与 Legacy Skill、自动刷新、显式/隐式激活、资源读取、Skill cwd 脚本审批、activation eval、Git 安装生命周期、供应链拒绝、`$` 菜单和 Windows junction 边界。Phase 7 与 Phase 7.1 已达到冻结条件。

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

- `npm test`：**319/319**
- `npm run test:coverage`：综合门槛测得 Lines **82.34%**、Branches **75.91%**、Functions **86.41%**，均高于 82%/74%/84% 门槛
- `npm run eval:offline`：十二项固定任务 **12/12**
- `npm run test:providers`：五种离线 Provider Profile 与共享 Runner 契约 **46/46**
- `npm run test:stability`：Windows Shell、会话和 MCP/Hook 生命周期连续三轮通过
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

Phase 6/7 本地发布前卫生已通过：

- `npm audit --omit=dev --audit-level=high`：`0 vulnerabilities`
- `npm run license:check`：90 个生产依赖条目均为已审查的宽松许可证
- `npm run secret:scan`：168 个工作树文件、完整可达补丁历史与提交信息通过高置信扫描
- `npm run pack:check`：244 个条目，压缩与解压大小均在门槛内，allowlist 外文件 0
- `npm run smoke:package`：真实 tarball 在全新 prefix 中完成全局 CLI、配置迁移、文本、NDJSON 与 doctor 验证
- `syzzz doctor`：Node 22 要求、配置、Provider、模型、扩展配置、ripgrep 与 TypeScript Worker 均通过；仅保留 Windows ACL 无法自动验证的提醒
- `git diff --check`：退出码 0；仅有 Windows 工作树 LF→CRLF 提示，无空白错误
- 当前 DeepSeek/OpenCode Live Eval：**7/7**，功能成功率 100%，安全项通过，0 个基础设施错误；完整套件一次运行通过
- OpenCode `gpt-5.6-luna` Responses 真实 smoke：文本流以 `response.completed` 正常结束；function call、私有 output items 续接与最终回答往返通过
- GitHub Actions：提交 `014e182` 的完整流水线 **10/10 jobs** 通过，包括 Windows/Ubuntu × Node 22/24、quality、Provider contracts、offline Eval、双平台 package smoke 与 security
- Phase 7/7.1 GitHub Actions：提交 `75c3967` 在两个同步分支上的流水线均为 **10/10 jobs** 通过；Ubuntu 覆盖率、Windows canonical path、Node 22/24 与双平台 package smoke 全绿
- Phase 6 候选包人工验收：真实 tarball 隔离安装、Node 22/24、doctor、会话恢复、取消、NDJSON、MCP、Hook 与只读 Subagent 均通过；上游 Provider 的瞬时 503 按有限重试和结构化失败规则处理，后续请求恢复成功

## 8. 已知边界

- Shell、MCP stdio 与 Hooks 都不是 OS sandbox。
- workspace trust 允许项目配置以当前用户权限运行本地代码。
- MCP `readOnlyHint` 是受信 Server 的声明，无法证明远端实现没有副作用。
- 会话快照未加密，可能包含代码、提示、MCP 结果和 Subagent 报告。
- Windows ACL 当前只能警告未自动验证。
- 当前不支持 OAuth、旧 SSE、MCP Resources/Prompts/Sampling、HTTP/后台 Hooks。
- 当前不支持写入型、并行、后台或嵌套 Subagent。
- `@` 不支持工作区外路径、URL、图片、PDF 或多模态附件。
- Skill 不支持私有 Git 凭证、市场、自动更新、安装后自动执行或 `allowed-tools` 授权。
- 当前没有完整 TUI、多行 Composer、结构化问题弹窗、鼠标交互、LSP、持久化索引、Tag 或 npm 发布。完整 TUI 进入 Phase 8。

## 9. Git 状态

- 当前分支：`codex/phase7.1-skills`
- Phase 4 冻结提交：`3d2b8e6`
- Phase 5.0 Core 非冻结检查点：`000bcaa`
- Phase 5.1 实现验证基线：`85b2558`
- Phase 5 冻结提交：`64789ec`
- Phase 6 候选实现提交：`82cc673`
- Phase 6 跨平台修复提交：`239bc7b`
- Phase 6 Windows 稳定性修复提交：`014e182`
- Phase 7 起始基线：`161391a`
- Phase 7.1 起始基线：`9bb4e62`
- Phase 7/7.1 跨平台验证提交：`75c3967`
- 远程 `codex/phase7-task-composition` 与 `codex/phase7.1-skills` 已同步到同一历史
- 版本号保持 `1.0.0`
- 未发布 npm 包，未创建 Tag
- 本地 `main`、远程 `main` 与 Phase 6 分支指向同一发布准备提交
- GitHub 仓库仍为 Private；尚未创建 `npm-release` Environment
- 既有 archive 行尾状态、`hook-should-not-exist-2.txt`、`phase3-manual.ts`、`phase2-events.jsonl` 和 `temp.txt` 不属于 Phase 7，不纳入本阶段提交

## 10. 冻结条件

Phase 5.1 实现、253 项自动化测试、发布卫生、11 项人工 dogfood 与真实远程 MCP smoke test 均已通过，Phase 5 保持 **Frozen**。

Phase 6 使用四级状态：

1. 本地实现和自动化通过：**Implemented**。
2. Windows/Linux CI、审计、离线 Eval 与候选 tarball 通过：**Validated**。
3. 用户完成人工 dogfood：**Release Candidate Accepted**。
4. npm、annotated `v1.0.0` Tag、GitHub Release 和 registry 安装验证完成：**Frozen**。

Phase 6 继续停留在 **Release Candidate Accepted**，不越过公开发布门槛。Phase 7 与 Phase 7.1 的本地测试、覆盖率、审计、离线 Eval、包检查、tarball smoke、用户 dogfood 和 Windows/Ubuntu Node 22/24 CI 已全部通过，现标记为 **Frozen**。OpenAI Responses 协议与显式 Provider 路由已经实现，并通过离线契约及 OpenCode Luna 真实文本与 function call smoke。Anthropic 真流式、MCP OAuth、完整 TUI、LSP、持久索引、并行或写入型 Subagent 继续留在后续独立阶段评估。
