# Changelog

本项目遵循语义化版本。`package.json` 是版本号的唯一事实源。

## [1.0.0] - 2026-08-10

`1.0.0` 汇总了 Phase 1 至 Phase 9.1 的可信 Agent CLI 改造，形成首个面向公开安装的稳定版本。

### Added

- Phase 9 工作区 RAG：版本化本地索引、词法/向量混合检索、RRF、可选 reranker、外部集合挂载、citation 校验、隔离验证和固定评测。
- Phase 9.1 个人知识闭环：受管理 `library`、`rag add`、经审批的 `SaveKnowledge`、索引刷新和会话恢复 receipt 校验。
- 全屏 TUI、真实流式 Markdown、结构化审批与提问、多行输入、历史滚动和中英文界面。
- 工作区受限的读取、搜索、原子写入、Patch、Git Diff、RepoMap 与 TS/JS Diagnostics。
- 事件化 Agent Runtime、OpenAI-compatible 流式、Provider 错误分类、有限重试和 NDJSON。
- OpenAI Chat Completions、OpenAI Responses、DeepSeek reasoning 和 Anthropic Messages 协议适配。
- `ask | plan | code` 模式、会话保存/恢复、上下文压缩、Slash 命令发现和本地审计。
- Trust V2、渐进式 MCP Broker、本地 Hooks 和受预算限制的只读 Subagent。
- Provider 协议契约、固定 Coding Agent Eval、跨平台 CI、覆盖率和 tarball 安装验证。
- `@` 显式文件/目录证据、分层 `AGENTS.md`、`$skill` 与受控隐式 Skill 激活。
- 公开 HTTPS Git Skill 的 commit 固定安装、更新、单版本回滚和安全移除。

### Security

- 路径、敏感文件、Windows 特殊命名、symlink/junction、审批后冲突和工具输入均 fail closed。
- `fullAccess` 不能绕过工作模式、工作区边界、Hook deny 或 MCP disabled 策略。
- 凭证不注入模型可执行 Shell、MCP/Hook 默认环境、NDJSON、审计或 Eval 报告。
- AGENTS 与 Skills 不能授予工具或绕过工作模式、审批、Hook、MCP policy 和路径边界。

### Known Limitations

- Shell、MCP stdio 与 Hooks 不是 OS sandbox。
- Anthropic 当前为非流式；尚未实现 MCP OAuth、LSP、云端 RAG、并行或写入型 Subagent。
- `@` 不支持工作区外路径、URL、图片、PDF 或多模态；RAG 也暂不摄取 PDF、Office、图片或网页。
- Skill 不支持私有 Git、市场、自动更新或脚本自动执行；本地会话、索引与知识库内容当前不加密。

[1.0.0]: https://github.com/syz0528/Syzzz-Code/releases/tag/v1.0.0
