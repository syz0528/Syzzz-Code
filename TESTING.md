# Syzzz Code 测试与发布验证

## 本地命令

```bash
npm ci
npm run format:check
npm run lint
npm test
npm run test:coverage
npm run test:providers
npm run eval:offline
npm run pack:check
npm run smoke:package
npm audit --omit=dev --audit-level=high
npm run check
```

`npm run check` 是本地综合门槛；`smoke:package` 额外安装真实 tarball，耗时更长。Windows 进程、会话锁与 MCP 生命周期可用 `npm run test:stability` 连续执行三轮，任一轮失败都会立即终止。

2026-08-03 的 Phase 7 本地实现基线为：293/293 项测试、覆盖率 Lines 82.31%/Branches 75.28%/Functions 85.99%、离线 Eval 12/12 与真实 tarball smoke 通过。Windows/Ubuntu Node 22/24 CI 仍待执行；Phase 6 发布候选的跨平台 CI 与人工验收结论保持不变。

Windows PowerShell 5.1 手工创建包含中文的 `AGENTS.md` 或 `SKILL.md` 时，必须使用 `Set-Content -Encoding UTF8`；默认 `Set-Content` 会使用当前 ANSI 代码页并被 UTF-8 安全校验拒绝。`@@name` 的模型可见结果是字面量 `@name`，并附带“已显式转义”的组合证据，模型不应把它当作缺失路径继续搜索。

## 自动化层级

1. 单元测试：配置、路径、权限、上下文、事件和工具。
2. Runtime 集成：流式、取消、重试、会话、扩展和终端渲染。
3. Provider 契约：真实 loopback HTTP/SSE，不依赖外网或正式 Key。
4. 固定 Agent Eval：真实 QueryEngine、工具、审批和外部 grader。
5. tarball smoke：从 npm 生成的 `.tgz` 安装到全新 prefix 后运行 CLI。
6. Live Eval 与人工 dogfood：只在明确配置凭证时执行。

## Provider 契约

`npm run test:providers` 强制覆盖：

- `openai-chat-completions`
- `openai-compatible-minimal`
- `deepseek-reasoning`
- `anthropic-messages`

契约包含 UTF-8 多字节增量、工具调用碎片、usage、请求元数据、错误映射、有限重试、提前 EOF、畸形 SSE、reasoning 隔离和 Anthropic 非流式工具调用。它证明协议行为，不等于已对所有兼容厂商做真实联网验证。

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

验证另一个 OpenAI-compatible 或 Anthropic 端点时，可用显式环境变量覆盖当前配置：

```bash
SYZZZ_EVAL_PROVIDER_TYPE=openai-compatible
SYZZZ_EVAL_BASE_URL=https://example.com/v1
SYZZZ_EVAL_API_KEY=...
SYZZZ_EVAL_MODEL=model-name
npm run eval:live
```

`SYZZZ_EVAL_PROVIDER_TYPE` 可为 `openai-compatible` 或 `anthropic`。只提供部分显式变量会 fail closed；当前配置也没有可用凭证时结果明确为 `skipped`。Phase 6 人工验收要求当前 DeepSeek/OpenCode 配置通过；官方 OpenAI 与 Anthropic 只有在提供独立凭证时才执行，并在记录中区分“实测”和“协议兼容”。

Provider 在首个任务前发生认证、限流、网络或服务端基础设施错误时，Runner 会终止整套 Live Eval 并把其余任务标为 `skipped`。2026-07-30 的当前 DeepSeek/OpenCode 完整套件一次运行通过：7/7、功能成功率 100%、安全项通过、0 个基础设施错误；报告只保留脱敏指标。

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

在最后一级之前，不应在 README 或状态文档中宣称 Phase 6 Frozen。
