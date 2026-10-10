# Syzzz Code 安全说明

## 支持范围

| 版本      | 安全更新 |
| --------- | -------- |
| `1.0.x`   | 支持     |
| `< 1.0.0` | 不支持   |

安全修复优先进入当前稳定分支。尚未发布的开发分支只提供尽力而为的支持，不应被视为稳定安全版本。

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

## RAG 边界

- RAG 只读取当前工作区和用户显式挂载的外部集合，复用 ignore、敏感路径、realpath 和 symlink/junction 边界。
- 外部集合必须由用户级命令注册，并按工作区显式挂载；项目文件不能自行授权外部目录。
- `rag add` 只能写入用户级受管理 `library`，原文件不修改；`SaveKnowledge` 只在 code 模式下经审批写入该目录，不能选择任意目标或借此提升权限。
- 模型只看到 `rag://<collection>/<relativePath>`，不会得到外部集合绝对路径。
- 首次向远程 Embedding 或 reranker 发送集合正文前必须单独确认；授权绑定 canonical root、endpoint、model 和摄取规则。
- RAG 凭证不会进入 Shell、Hook、MCP、审计、NDJSON 或 Eval 报告。环境变量优先于配置文件中的存储值。
- RAG 索引保存在 `~/.syzzz-code/rag`，其中包含 chunk 正文并且当前不加密。操作系统账户、磁盘和备份的访问者可能读取这些内容。
- `RagSearch` 与 `RagRead` 是只读工具，不能提升模式或权限。`RagVerify` 的 Provider fork 不获得工具。
- citation token 只证明引用指向本轮读取且未过期的本地片段，不等于该片段内容真实、完整或足以支持结论。
- 会话恢复会重新验证持久化 RAG receipt；失效 receipt 只产生重新检索提示，不会被静默视为有效证据。
- 远程 reranker 只重排候选；失败时降级，不会自动重放工具或修改源文件。

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

## Task Composition 与 Skills 边界

- `@` 只能解析当前工作区内的普通 UTF-8 文件或有界目录清单，并复用敏感路径、realpath、symlink/junction 与 Windows 特殊路径校验。
- 显式引用、AGENTS 和 Skill 内容都标记为不可信 user-level 数据，不能覆盖 system 边界，也不能改变模式、权限、审批、Hook 或 MCP policy。
- AGENTS 与项目 Skill 发现采用有界读取，并拒绝 symlink 或解析到允许用户/仓库根之外的路径。
- 显式引用快照会进入模型历史和本地会话；AGENTS 在每次请求和压缩后按当前磁盘版本重新注入。它们都会发送给当前 Provider。
- 项目 Skill 自动发现且不要求 `/trust`，因为它只提供指令与只读资源。`allowed-tools`、内联命令和脚本不会被执行或转换为授权。
- `ReadSkillResource` 只读取 Skill 根目录内的普通 UTF-8 文件，拒绝敏感文件、二进制、symlink 逃逸和超限内容。
- 审计只记录引用和 Skill 的数量、字节及 outcome，不保存路径、正文、参数、资源内容或安装 URL。

公开 Git Skill 安装属于供应链操作：

- 只接受无凭证的公开 HTTPS URL，拒绝 SSH、PAT、`file://`、localhost 和私有 IP 字面量；
- Git 使用固定 argv、`shell:false`、禁用交互凭证、Hooks、submodule 和系统/用户配置，不继承 Provider Key；
- 安装前限制普通文件数量和大小，拒绝 symlink、hardlink、设备文件及路径穿越；
- 安装固定到完整 commit，展示来源、文件清单、脚本数量与目标目录，并要求单独 `y/Y` 或显式 `--yes`；
- 安装不会运行 Skill 中的脚本，也不会改变 workspace trust 或 permission mode。

上述检查降低误安装风险，但不能证明仓库内容没有恶意提示。启用前应使用 `syzzz skills inspect <name>` 审查来源和不支持字段。

## 本地数据

M4 开发切片的项目记忆保存在 `~/.syzzz-code/memory/<canonicalWorkspaceSha256>.json`，本地明文保存，只通过 `/memory` 的预览确认入口管理，不自动保存聊天。普通文件工具拒绝直接访问该目录；已授权的 Shell、扩展或同用户外部进程仍可能修改文件，它不是 OS sandbox。文件来源变化后停止注入，损坏或不安全存储不静默覆盖。记忆正文与确认答案不进入审计或 Composer 历史，但有效记忆会发送给当前 Provider；不要保存秘密。无来源条目只是用户确认的约定，不是已核验事实。完整边界见 [项目记忆](docs/project-memory.md)。

会话快照未加密，可能包含用户提示、代码、工具结果、MCP 返回和 Subagent 报告。审计仅保存 allowlist 元数据，不保存 prompt、URL、认证头、工具输入输出、Hook payload 或 Subagent transcript。

工作区输入历史保存在 `~/.syzzz-code/history/<workspaceHash>.json`，只记录用户从 Composer 主动提交的消息和 Slash 命令。它不记录审批答案、确认 token、`AskUser` 回答、隐藏输入或未提交草稿，但仍可能包含敏感提示，且当前不加密；可使用 `/history off` 停止后续记录，或 `/history clear` 清理当前工作区。

持久化编辑授权保存在 `~/.syzzz-code/permission-grants.json`。它只允许记录 `acceptEdits`，并按已保存会话 ID 或规范化工作区哈希生效；`fullAccess`、Shell 单次批准、确认输入和审批正文永不持久化。`/permissions safe` 会撤销当前会话和工作区的编辑授权。该文件不等于 OS sandbox，拥有本地账户文件权限的程序仍可修改它。

`AskUser` 问题和答案正文不进入审计事件，事件只记录类型、数量、耗时和 outcome。预设选项之外的自定义答案遵循同一边界。答案为了让 Agent 继续工作，会作为普通 ToolResult 发送给当前 Provider，并可进入本地会话快照。fullscreen TUI 的 Markdown renderer 会清除 ANSI 控制序列并把原始 HTML 作为文本处理；它仍只是显示与输入层，不会增强隔离、改变审批语义或隐藏工具副作用。

敏感工作区建议：

- 使用 `sessions.autoSave=false`；
- 使用 `API_KEY_ENV`，不要在配置文件中保存 API Key；
- 定期检查 `~/.syzzz-code/sessions` 与 `~/.syzzz-code/audit`；
- 不对来源不明的项目执行 `/trust`；
- 在 `safe` 或只读模式下先完成检查。

`/terminal-setup install` 是显式的本地配置操作。执行前会显示目标路径并要求精确确认，已有文件先生成备份；它只增加 `Shift+Enter -> ESC+CR` 键位，不覆盖冲突绑定，也不读取或传递 Provider 凭证。

## 已知限制

- Shell、MCP stdio 和 Hooks 都不是 OS sandbox。
- Trust V2 不会对被配置引用的脚本或 executable 做内容锁定。
- Windows ACL 当前只能提示未自动验证，不能证明本地文件仅当前用户可读。
- 文件最终 hash 复核到原子 rename 之间仍有极小 TOCTOU 窗口。
- 当前不支持 OAuth、Keychain、磁盘加密、云端审计、旧 SSE、后台 Hook、写入型 Subagent、私有 Git Skill 凭证、Skill 市场、自动更新或通用 TUI 鼠标控件；鼠标仅用于滚轮、滚动条、正文选区和 sticky 问题导航。正文复制通过有界 OSC 52 发送到当前终端剪贴板，不写入审计或会话。

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

安全问题请优先使用 GitHub 仓库 Security 页面中的私密漏洞报告功能。若该功能暂不可用，可以创建一个不包含漏洞细节的公开 Issue，请求维护者建立私密联系渠道。不要在公开 Issue 中粘贴 API Key、认证头、私有代码、会话快照、完整审计文件或可直接利用的漏洞细节。

报告应包含受影响版本、复现条件、预期边界、实际结果和影响范围，并尽量使用脱敏的最小复现。维护者确认后会通过私密渠道同步进展；修复发布前请避免公开披露。
