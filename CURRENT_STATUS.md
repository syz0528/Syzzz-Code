# Syzzz Code 当前项目状态

**更新时间：** 2026-08-10

**当前分支：** `codex/phase9-rag`

**Phase 4 冻结基线：** `3d2b8e6`

**Phase 5.0 Core 检查点：** `000bcaa`

**Phase 5.1 实现验证基线：** `85b2558`

**Phase 5 冻结基线：** `64789ec`

**Phase 7 起始基线：** `161391a`

**Phase 7/7.1 冻结基线：** `465f0bf`

**Phase 8 TUI Spike：** `64ecaf2`

**Phase 8 回退检查点：** `a4e93d4`

**Phase 8 冻结验收基线：** `7b1d39c`

**Phase 9 起始基线：** `204fe5b`

**当前阶段：** `1.0.0` 最终发布准备。Phase 9/9.1 的实现与本地人工验收已经完成；发布前仍需完成格式门槛、当前提交的跨平台 CI、`main` 推进、公开仓库、npm、Tag、GitHub Release 和 registry 安装复验，因此尚未标记 **Frozen**。

## 1. 当前结论

Phase 9 已完成独立 `RagRuntime`、版本化本地索引、MiniSearch 词法检索、LanceDB 向量降级后端、OpenAI-compatible Embedding、Jina-compatible reranker、RRF 多查询融合、外部集合挂载、渐进式 `RagSearch/RagRead`、确定性 citation 校验与隔离 `RagVerify`。Phase 9.1 进一步加入用户级受管理 `library`、`rag add` 文档导入、经审批的 `SaveKnowledge`、自动/待授权索引刷新，以及会话恢复时的 RAG receipt 复核。默认不自动索引工作区、不发送远程文件、不开启自动预检索；索引和个人库正文保存在本地且不加密。

固定离线 RAG Eval 使用 10 个 case 和 9 个 evidence label，结果为 label resolution 100%、lexical Recall@10/MRR@10 `1.00/0.95`、hybrid `1.00/1.00`，敏感文件负例通过。`JustStudy` 真实外部语料按数据集声明的 15 个 profile 文件隔离评测，22/22 evidence labels 可解析，lexical Recall@10/MRR@10 为 `0.90/0.82`，高于历史 `0.667/0.541` 与计划门槛。当前本地门槛为 398/398、TUI 51/51、coverage `82.57%/75.60%/86.11%`、生产审计 0 vulnerability，102 文件候选包与全新 prefix smoke 通过；当前 Phase 9 提交的 Windows/Ubuntu Node 22/24 CI 与正式 registry 安装仍待发布流程验证，因此不得标记 Frozen。

Phase 5.0 Core 已完成“可信扩展运行时、MCP Broker 与受限委派”的主体：

1. Phase 5.0-A：路径级 workspace trust、渐进式 MCP Broker、stdio 与 Streamable HTTP。
2. Phase 5.0-B：有序本地 Hooks、失败策略、进程与输出约束。
3. Phase 5.0-C：固定只读工具集、独立上下文和父级取消控制的 `explore | review` Subagent。

Phase 5.1 在此基础上补齐扩展配置复审、MCP 本地收紧策略与断线生命周期、统一扩展状态、压缩/委派 Hook，以及 Subagent 软硬预算和停止语义。

Phase 8 在 319 项冻结回归上新增 fullscreen TUI、InteractionController、多行 Composer、结构化审批与选择、`AskUser` 和工作区输入历史。Phase 8.1 针对真实终端暴露的问题，将扁平 Transcript 改为语义 `ConversationBlock`，启用 Windows 可用的 changed-line 增量提交，加入 source-backed stable/mutable 流式展示、Markdown、活动耗时、语义滚动锚点、sticky 问题和结构化 Skill 提问。本轮继续补齐启动续聊选择、会话/工作区级编辑授权、64K/128K/200K fallback context、本地中英文描述、显式确认输入、客户端强制的 AskUser 自定义答案、直接拖选复制和可拖动滚动条；终端输入层现在会分离同批到达的 SGR 鼠标事件与真实文字，AskUser 不再被点击或滚轮控制码污染。增强键盘改为 fullscreen 首帧前探测，只有终端明确响应才启用 Kitty 协议；旧 Windows Terminal 与 IDE 内嵌终端可通过 `/terminal-setup install` 安装有备份、冲突拒绝的 `ESC+CR` 映射，未设置时使用 `Ctrl+J`。Header 展示工作区与会话 ID，Footer 集中展示 Provider/model、模式/权限、`used/window` context 和工具数。

Phase 8.2 以 `a4e93d4` 为可回退检查点，借鉴 Codex 的稳定区域/可变尾部与源码重排、Claude 的 retained frame 思路，以及 Grok 的显式 viewport 和输入解码边界，继续收紧显示层：完成块按对象、宽度和语言缓存，不再随每个 delta 重算；Transcript 独立 memo；首个正文 delta 立即提交，后续更新按终端 profile 合并；SGR 鼠标序列使用有状态解码器跨读取拼接，避免碎片进入 Composer 或 AskUser；Windows IDE 内嵌终端自动采用 20 FPS 的 conservative profile，标准终端保持 30 FPS，也可通过 `/setting fps auto|30|60` 持久化选择。`/help`、二级选项、高频本地 notice 和状态标签已补齐中英文路径；Transcript 松开拖选后会自动复制并在 Footer 显示短暂成功提示。`/ui status` 可查看主机、键盘、帧节奏与渲染耗时。Ink 已提供 DEC synchronized frame commit，本期不维护第二套终端后端或 fork Ink。Windows Terminal 与 Codex 内嵌终端多轮复验、完整本地门槛和跨平台 CI 均已通过，Phase 8 现标记为 **Frozen**。

Phase 8 冻结回归为 **370/370**、TUI 专项 **46/46**、离线 Eval **12/12**；本地覆盖率为 Lines **82.33%**、Branches **76.38%**、Functions **85.45%**，Ubuntu CI 为 **82.03% / 76.25% / 85.84%**。生产依赖审计为 0 vulnerability，候选包包含 320 个 allowlist 文件并通过全新 prefix 安装 smoke；[CI 31142878469](https://github.com/syz0528/Syzzz-Code/actions/runs/31142878469) 的 Windows/Ubuntu × Node 22/24 等 10 个作业全部通过。

11 项真实终端 dogfood 已全部通过，覆盖项目 trust 复审、MCP 策略与断线重连、Hook、Subagent 预算、取消清理、隐私恢复和撤销信任。公开 Streamable HTTP MCP 的真实握手、工具发现与只读天气调用也已通过，Phase 5 的扩展信任和传输闭环达到冻结条件。

Phase 6 不增加 Agent 自治能力，当前改造集中在：

- Node 22/24、版本单一来源、ESLint、Prettier 和覆盖率门槛；
- 五种离线 Provider 协议 Profile；
- 七项固定 Coding Agent Eval 与只保存元数据的报告；
- Windows/Ubuntu CI、生产依赖审计、许可证与完整 Git 历史 Secret 扫描；
- npm tarball allowlist、全新 prefix 安装、配置迁移、文本与 NDJSON smoke；
- Apache-2.0、架构/测试/变更日志以及人工门控发布工作流。

Phase 6 建立的发布工程基线已经通过本地自动化、真实 DeepSeek/OpenCode Live Eval、候选 tarball、GitHub 跨平台 CI 和人工 dogfood。Live Eval 完成全部七项隔离任务，结果为 7/7、功能成功率 100%、安全项通过且无基础设施错误；提交 `014e182` 的 CI 共 10 个 job 全绿，覆盖 Windows/Ubuntu 与 Node 22/24。该阶段的旧 **Release Candidate Accepted** 是历史里程碑，现已由包含 Phase 7 至 Phase 9.1 的 `1.0.0` 最终候选整体接替，不再作为独立发布状态推进。

完整 Phase 2–6 历史已于 2026-07-31 fast-forward 到远程 `main`；当前 Phase 7 至 Phase 9.1 历史仍位于开发分支。仓库继续保持 Private；公开前将先把最终候选以 fast-forward 推进到 `main`，再启用可用的 required checks、Secret Scanning、Push Protection、Dependabot 和 CodeQL 设置。

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

Phase 8 从 `64ecaf2` 的 Ink Spike 建立 `codex/phase8-tui`：

- TTY 默认 fullscreen，能力不足、CI、screen reader 或 `--ui inline` 确定性使用 inline；
- `InteractionController` 与 `InteractionPort` 统一命令、notice、选择、确认、审批、Agent 提问和取消；
- Ink TUI 提供 Header、Transcript、Activity、Interaction、Composer 与 Footer，并对窄终端降级；
- Composer 按 grapheme 支持中文、Emoji、多行、粘贴、历史和 `/ @ $` 固定候选；
- Composer 使用 `>` 前缀和真实 Ink 布局坐标定位光标，候选和底栏保持稳定高度；
- Windows 预留最后一个物理行并启用 incremental rendering，普通输入、spinner 和 text delta 不再触发每帧全屏清除；
- Transcript 使用语义块、Markdown 与 stable/mutable 流式 Presenter，支持鼠标滚轮、分页、sticky 问题、新输出提示和 resize 后源文本重排；
- 同一工作区存在历史时默认结构化选择继续最近会话或新建会话；显式启动参数仍可直接恢复；
- `acceptEdits` 可跟随已保存对话或工作区，Shell 仍逐次审批；`fullAccess` 永不持久化，`safe` 可撤销已有编辑授权；
- `/context` 提供 64K/128K/200K fallback 预设，Footer 显示实际 `used/window`；`/language` 本地化内置命令、二级选项、高频状态和上下文候选描述；`/setting` 集中管理语言、流式展示、帧率、历史与上下文；
- `/stream` 立即更新 TUI 流式策略，首个正文 delta 直接可见，长回复按 40ms 稳定行节奏展示并在积压时有界追平；
- 活动栏展示 phase、spinner、等待状态和有效工作耗时，回答尾部保留最终 token、工具、重试与耗时摘要；
- `AskUser` 支持单选、多选、短文本和预设外自定义答案；激活 Skill 需要用户作答时明确要求使用结构化面板，答案不进入审计正文或 Composer 历史；
- 确认与审批先在交互输入区显示 token，按 Enter 后提交；Transcript 支持直接左键拖选并在松开时自动复制、显示成功提示，右侧滚动条支持点击和按住拖动；
- 输入历史按工作区原子保存，可通过 `/history` 控制；
- inline 与 NDJSON 保持长期兼容，React 不进入 Agent Runtime。

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

- `npm test`：**398/398**
- `npm run test:tui`：**51/51**，覆盖语义 Transcript、流式 Markdown、Composer、会话选择、结构化审批与提问、滚动、鼠标输入解码、中英文界面和终端恢复
- `npm run test:coverage`：Lines **82.57%**、Branches **75.60%**、Functions **86.11%**，高于 82%/74%/84% 门槛
- `npm run eval:offline`：十二项固定 Agent 任务 **12/12**
- `npm run eval:rag:offline`：label resolution 100%，hybrid Recall@10/MRR@10 `1.00/1.00`，敏感文件负例通过
- 真实外部语料评测：22/22 evidence labels，Recall@10 `0.90`，MRR@10 `0.82`
- `npm run test:providers`：OpenAI Chat Completions、OpenAI Responses、DeepSeek reasoning 与 Anthropic Messages 离线协议契约通过
- `npm audit --omit=dev --audit-level=high`：`0 vulnerabilities`
- `npm run license:check`：231 个生产依赖条目通过许可证检查
- `npm run secret:scan`：216 个工作树文件、完整可达补丁历史与提交信息通过高置信扫描
- `npm run pack:check`：102 个 allowlist 文件，packed/unpacked size 低于发布门槛
- `npm run smoke:package`：真实 tarball 在全新 prefix 中完成全局 CLI、配置迁移、文本、NDJSON 与 doctor 验证
- 当前 DeepSeek/OpenCode Live Eval：**7/7**，功能成功率 100%，安全项通过，0 个基础设施错误
- OpenCode Responses 真实 smoke：文本流、function call、私有 output items 续接与最终回答往返通过
- Phase 8 冻结提交的 GitHub Actions 在 Windows/Ubuntu × Node 22/24 等 10 个作业全部通过；Phase 9 最终提交仍需重新运行同一矩阵

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
- 当前 TUI 的鼠标交互覆盖滚轮、可拖动滚动条、正文拖选复制和 sticky 问题，不支持通用点击控件、主题/插件系统、交互式 Shell、后台任务或 LSP。
- RAG 提供本地持久化索引，但暂不支持云端 RAG、PDF/Office/图片摄取、网页抓取、跨设备同步或任意历史 as-of 查询。
- Tag 与 npm 发布仍未进行。

## 9. Git 状态

- 当前分支：`codex/phase9-rag`
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
- Phase 7/7.1 冻结提交：`465f0bf`
- Phase 8 TUI Spike：`64ecaf2`
- Phase 8 冻结提交：`204fe5b`
- 版本号保持 `1.0.0`
- 未发布 npm 包，未创建 Tag
- 远程 `main` 当前仍停留在 Phase 6 发布工程基线，Phase 7 至 Phase 9.1 尚未推进
- GitHub 仓库仍为 Private；尚未创建 `npm-release` Environment

## 10. 冻结条件

Phase 5.1 实现、253 项自动化测试、发布卫生、11 项人工 dogfood 与真实远程 MCP smoke test 均已通过，Phase 5 保持 **Frozen**。

Phase 6 使用四级状态：

1. 本地实现和自动化通过：**Implemented**。
2. Windows/Linux CI、审计、离线 Eval 与候选 tarball 通过：**Validated**。
3. 用户完成人工 dogfood：**Release Candidate Accepted**。
4. npm、annotated `v1.0.0` Tag、GitHub Release 和 registry 安装验证完成：**Frozen**。

Phase 6 的发布工程能力已经并入当前 `1.0.0` 最终候选，不再保留一个与现状分离的 RC。Phase 7、Phase 7.1 与 Phase 8 的本地测试、覆盖率、审计、离线 Eval、包检查、tarball smoke、用户 dogfood 和 Windows/Ubuntu Node 22/24 CI 已全部通过并标记为 **Frozen**。Phase 9/9.1 已完成本地实现、固定评测和人工验收，待当前提交的跨平台 CI 与正式发布链路完成后统一冻结。OpenAI Responses 协议与显式 Provider 路由已经实现，并通过离线契约及 OpenCode Luna 真实文本与 function call smoke。Anthropic 真流式、MCP OAuth、云端 RAG、LSP、并行或写入型 Subagent 继续留在后续独立阶段评估。
