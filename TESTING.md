# Syzzz Code 测试与发布验证

## 本地命令

```bash
npm ci
npm run format:check
npm run lint
npm test
npm run test:tui
npm run test:coverage
npm run test:providers
npm run eval:offline
npm run eval:rag:offline
npm run pack:check
npm run smoke:package
npm audit --omit=dev --audit-level=high
npm run check
```

`npm run check` 是本地综合门槛；`smoke:package` 额外安装真实 tarball，耗时更长。Windows 进程、会话锁与 MCP 生命周期可用 `npm run test:stability` 连续执行三轮，任一轮失败都会立即终止。

`1.0.0` 最终候选在 2026-08-10 的本地基线为：完整回归 398/398、TUI/Interaction 专项 51/51、离线 Agent Eval 12/12、离线 RAG Eval 通过，覆盖率 Lines 82.57% / Branches 75.60% / Functions 86.11%。生产依赖审计为 0 vulnerability，102 文件候选包和全新 prefix 安装 smoke 通过。发布前仍必须在最终提交上通过 Windows/Ubuntu × Node 22/24 CI。

Phase 9 的 `npm run eval:rag:offline` 使用独立临时目录、Mock Embedding 和 Mock reranker 验证 10 个固定 case。门槛包括 evidence label resolution 100%、敏感文件负例、hybrid Recall@10/MRR@10 不低于 0.9，并要求 hybrid 至少改善一个 lexical 指标。报告只保存 case ID 和指标。

真实集合评测使用 `npm run eval:rag:live`，通过 `SYZZZ_RAG_LIVE_ROOT` 指定集合。默认只运行本地词法路径；只有显式传入 `--approve-remote` 才使用当前 RAG 远程配置。若数据集提供 `corpus_profiles.source_paths`，Runner 会在隔离临时目录中只物化这些声明文件，防止评测题和旧答案日志污染检索。`JustStudy` 历史原始基线是 Recall@10 `0.6667`、MRR@10 `0.5407`；Phase 9 本地结果为 22/22 evidence labels、Recall@10 `0.90`、MRR@10 `0.82`，敏感负例通过。

Phase 9.1 专项覆盖个人 `library` 的保留名称、原子文档导入、CLI 检索闭环、`SaveKnowledge` 审批快照、持久副作用检查点，以及恢复会话后对 RAG revision、source hash 和行范围的复核。远程未授权场景必须保持本地保存并明确报告索引待刷新。

2026-08-07 的 Phase 8.2 冻结基线为：完整回归 370/370、TUI/Interaction 专项 46/46、离线 Eval 12/12；本地覆盖率 Lines 82.33%/Branches 76.38%/Functions 85.45%，Ubuntu CI 为 82.03%/76.25%/85.84%。除 Phase 8.1 的 headless VT/ANSI 屏幕回放、source-backed 流式中间帧、Markdown、sticky 问题、鼠标、grapheme、`/ @ $`、启动续聊、可见确认、活动计时、中文界面和结构化 AskUser 外，本轮新增拆分 SGR 输入、有状态鼠标解码、embedded Windows conservative profile、首个正文 delta 立即显示、后续 delta 帧合并、自动复制提示、`/setting`、30/60 FPS 配置、中英文帮助、终端配置失败路径和本地化回归。生产依赖审计、许可证、Secret 扫描、320 文件候选包检查和全新 prefix 安装 smoke 均通过；[CI 31142878469](https://github.com/syz0528/Syzzz-Code/actions/runs/31142878469) 的 10 个作业全部通过，覆盖率门槛继续保持 Lines 82%、Branches 74%、Functions 84%。

Windows PowerShell 5.1 手工创建包含中文的 `AGENTS.md` 或 `SKILL.md` 时，必须使用 `Set-Content -Encoding UTF8`；默认 `Set-Content` 会使用当前 ANSI 代码页并被 UTF-8 安全校验拒绝。`@@name` 的模型可见结果是字面量 `@name`，并附带“已显式转义”的组合证据，模型不应把它当作缺失路径继续搜索。

## 自动化层级

1. 单元测试：配置、路径、权限、上下文、事件和工具。
2. Runtime 集成：流式、取消、重试、会话、扩展和终端渲染。
3. Provider 契约：真实 loopback HTTP/SSE，不依赖外网或正式 Key。
4. 固定 Agent Eval：真实 QueryEngine、工具、审批和外部 grader。
5. tarball smoke：从 npm 生成的 `.tgz` 安装到全新 prefix 后运行 CLI。
6. Live Eval 与人工 dogfood：只在明确配置凭证时执行。
7. RAG Eval：固定 label resolution、lexical/hybrid 对照、安全负例和真实外部集合 dogfood。

## TUI 验证

`npm run test:tui` 覆盖 InteractionController、语义 ConversationBlock、`AskUser`、UI 自动路由、grapheme Composer、工作区历史、source-backed 流式 Presenter、Markdown、滚动锚点、候选刷新、Ink 布局、审批和 alternate screen/raw mode 恢复。真实屏幕断言通过 `@xterm/headless` 回放 ANSI，不依赖原生 PTY。

人工 dogfood 使用 Windows Terminal，至少验证：

1. `syzzz` 自动进入 fullscreen，`syzzz --ui inline` 保持滚动式界面；
2. 中文 IME、Emoji、原生 Kitty `Shift+Enter`、`/terminal-setup install` 后的 `ESC+CR` 映射和 `Ctrl+J` 后备、一次性多行粘贴及频繁缩放；确认不支持增强按键的终端不会被强制启用协议；
3. 同一工作区已有会话时出现“继续最近对话 / 新建对话”，显式 `--continue` 与 `--resume` 仍直接执行；
4. `/`、`@`、`$` 候选不会写入 scrollback，`/model`、`/provider`、`/permissions` 和 `/resume` 使用选择面板；`/language zh-CN|en` 改变本地描述，`/setting` 可集中选择语言、流式展示、帧率、历史与上下文；
5. Write/Edit/Patch 的 `y/a/N`、Shell 的 `y/N`、fullAccess 与 Trust 精确确认；确认字符在面板输入区可见，只有 Enter 提交；
6. 分别把 `acceptEdits` 保存到当前对话和工作区，重启或恢复后编辑免审批但 Shell 仍审批；`fullAccess` 重启后消失，`/permissions safe` 清除授权；
7. `/context 64k|128k|200k` 后 Footer 显示 `used/window`，模型专属 context window 配置仍优先；
8. 单选、多选和短文本 `AskUser`，以及模型不可关闭的自定义答案；取消后当前回合终止，答案不进入输入历史；
9. 长流式逐步可见、Markdown 不暴露原始标记、鼠标滚轮、可拖动右侧滚动条与 `PageUp/PageDown` 全文回看、sticky 问题和新输出提示；
10. 直接左键拖选 Transcript 并在松开时写入有界 OSC 52 剪贴板，覆盖中文、宽字符和反向选区；
11. 等待期间 spinner 与有效工作耗时、`Ctrl+O` 工具详情、MCP/Hook/Subagent 状态、会话恢复和异常退出后的终端恢复；
12. 同时在 Windows Terminal 与 Codex 内嵌终端观察普通输入、spinner 和流式输出不出现整屏闪烁。
13. 在 fullscreen 中运行 `/ui status`，确认 Windows Terminal 通常使用 `standard`，Codex/VS Code 类内嵌终端使用 `conservative`；用 `SYZZZ_TUI_PROFILE=standard|conservative` 可仅为诊断显式覆盖。
14. 运行 `/setting fps 60` 后重启 TUI，确认 `/ui status` 显示 60 FPS；拖选 Transcript 后确认文本自动进入剪贴板，Footer 右侧短暂显示复制成功提示。

将 stdout 重定向、设置 `CI=1`、`TERM=dumb` 或 `INK_SCREEN_READER=true` 时应稳定选择 inline。`chat -m` 与 `stream-json` 永不启动 TUI；显式 `chat -m --ui tui` 应返回参数错误。

## Provider 契约

`npm run test:providers` 强制覆盖：

- `openai-chat-completions`
- `openai-compatible-minimal`
- `openai-responses`
- `deepseek-reasoning`
- `anthropic-messages`

契约包含 UTF-8 多字节增量、Chat Completions 与 Responses 工具调用碎片、usage、请求元数据、Responses 私有 output 续接、错误映射、有限重试、提前 EOF、畸形 SSE、reasoning 隔离和 Anthropic 非流式工具调用。它证明协议行为，不等于已对所有兼容厂商做真实联网验证。

## 固定 Agent Eval

`npm run eval:offline` 在十二个独立临时 Git 仓库中验证：

1. 只读架构分析；
2. 跨文件 Bug 修复；
3. 添加小功能及测试；
4. 修复 TypeScript 类型错误；
5. 首次测试失败后继续修正；
6. 拒绝越界写入；
7. 接近上下文上限时压缩并完成任务。
8. 通过显式文件引用使用确定版本的证据；
9. 按嵌套目录加载项目指令；
10. 激活 Skill 并遵循工作流；
11. 恶意 Skill 不能获得写入权限；
12. 安装后的 Skill 可以被发现和调用。

Shell 审批只接受任务清单中完全一致的命令和 cwd。语义 grader 位于 Agent 可修改的仓库之外，使用 `spawn(..., shell:false)` 独立执行，并通过回归测试确认替换仓库内测试不能绕过评分。TypeScript 任务按导出值的类型和静态运行语义评分，不要求模型生成某一种固定语法。外部 grader 与批准的 fixture 测试还使用 Node Permission Model 限制文件访问；这是一层进程级防误用约束，不是隔离恶意代码的 OS sandbox。报告写入 `eval-results`，只包含平台、提交、协议、模型、耗时、usage、工具数、审批、重试、压缩、终态、脱敏停止原因、工具与审批结果计数、变更计数、diff 哈希和 grader 结果；不保存 prompt、回答、源码、Shell 输出、Secret、reasoning 或 transcript。

## Live Eval

Live Eval 不属于普通 CI。`npm run eval:live` 默认使用当前 Syzzz 配置中的 Provider 和模型，读取凭证后会在执行 Agent Shell 前剥离进程中的凭证类环境变量，报告也不会保存凭证。Phase 6 Live Eval 继续使用原有七项联网任务，要求安全任务 100% 通过、功能任务成功率至少 80%。Phase 7 新增的五项任务组合 Eval 当前为强制离线门槛，避免安装来源与项目指令测试依赖外网。

验证另一个 OpenAI-compatible、OpenAI Responses 或 Anthropic 端点时，可用显式环境变量覆盖当前配置：

```bash
SYZZZ_EVAL_PROVIDER_TYPE=openai-compatible
SYZZZ_EVAL_BASE_URL=https://example.com/v1
SYZZZ_EVAL_API_KEY=...
SYZZZ_EVAL_MODEL=model-name
npm run eval:live
```

`SYZZZ_EVAL_PROVIDER_TYPE` 可为 `openai-compatible`、`openai-responses` 或 `anthropic`。Responses 的 `SYZZZ_EVAL_BASE_URL` 可使用 API 根路径或以 `/responses` 结尾的完整端点。只提供部分显式变量会 fail closed；当前配置也没有可用凭证时结果明确为 `skipped`。Phase 6 人工验收要求当前 DeepSeek/OpenCode 配置通过；官方 OpenAI 与 Anthropic 只有在提供独立凭证时才执行，并在记录中区分“实测”和“协议兼容”。

Provider 在首个任务前发生认证、限流、网络或服务端基础设施错误时，Runner 会终止整套 Live Eval 并把其余任务标为 `skipped`。2026-07-30 的当前 DeepSeek/OpenCode 完整套件一次运行通过：7/7、功能成功率 100%、安全项通过、0 个基础设施错误；报告只保留脱敏指标。

### Skill 激活评测

`syzzz skills test <name>` 读取 `<skill>/evals/activation.yaml`。格式使用 `schemaVersion: 1`，每个 case 包含 `id`、`prompt` 和 `expect: activate|not-activate`。每个 case 最多 4 KiB，单个文件最多 20 个 case。

每个 case 使用新的 ask+safe Engine，只暴露 `ActivateSkill`，不提供文件、Shell、MCP、Hook、Delegate 或持久化会话。默认使用当前 Provider 和模型，单 case 最长 60 秒；Provider/网络错误归类为 infrastructure failure，取消退出码为 130。输出只包含 case id、预期/实际、Provider/model、耗时和 usage。

## CI

GitHub Actions 包含以下 required job 候选：

- Windows/Ubuntu × Node 22/24 全量测试；
- format、lint、build、coverage；
- Provider 离线契约；
- 固定离线 Eval；
- Windows/Ubuntu tarball 安装；
- npm audit、许可证、Git 历史 Secret 扫描和 CodeQL。

第三方 Action 固定完整 commit SHA，普通 CI 权限为 `contents: read`，不接收 Provider Key，PR 更新会取消旧流水线。

## 状态门槛

- **Implemented**：实现与本地自动化完成。
- **Validated**：跨平台 CI、审计、离线 Eval 和候选包均通过。
- **Release Candidate Accepted**：产品所有者完成人工 dogfood。
- **Frozen**：npm、annotated Tag、GitHub Release 和 registry 安装复验全部完成。

在最后一级之前，不应在 README 或状态文档中宣称 `1.0.0` 已正式发布或整体 Frozen。
