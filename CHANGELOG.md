# Changelog

本项目遵循语义化版本。`package.json` 是版本号的唯一事实源。

## [1.0.0] - Unreleased

发布候选包已于 2026-07-31 完成人工验收，当前状态为 **Release Candidate Accepted**；npm、Tag、GitHub Release 和 registry 安装复验尚未完成。

Phase 7 的任务组合层当前为 **Implemented**，尚未完成跨平台 CI 与人工 dogfood，不改变上述 Phase 6 发布候选状态。

### Added

- 工作区受限的读取、搜索、原子写入、Patch、Git Diff、RepoMap 与 TS/JS Diagnostics。
- 事件化 Agent Runtime、OpenAI-compatible 流式、Provider 错误分类、有限重试和 NDJSON。
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
- Anthropic 当前为非流式；尚未实现 Responses API、MCP OAuth、LSP、完整 TUI 或写入型 Subagent。
- `@` 不支持工作区外路径、URL、图片、PDF 或多模态；Skill 不支持私有 Git、市场、自动更新或脚本自动执行。

[1.0.0]: https://github.com/syz0528/Syzzz-Code/releases/tag/v1.0.0
