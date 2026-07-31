# Changelog

本项目遵循语义化版本。`package.json` 是版本号的唯一事实源。

## [1.0.0] - Unreleased

发布候选包已于 2026-07-31 完成人工验收，当前状态为 **Release Candidate Accepted**；npm、Tag、GitHub Release 和 registry 安装复验尚未完成。

### Added

- 工作区受限的读取、搜索、原子写入、Patch、Git Diff、RepoMap 与 TS/JS Diagnostics。
- 事件化 Agent Runtime、OpenAI-compatible 流式、Provider 错误分类、有限重试和 NDJSON。
- `ask | plan | code` 模式、会话保存/恢复、上下文压缩、Slash 命令发现和本地审计。
- Trust V2、渐进式 MCP Broker、本地 Hooks 和受预算限制的只读 Subagent。
- Provider 协议契约、固定 Coding Agent Eval、跨平台 CI、覆盖率和 tarball 安装验证。

### Security

- 路径、敏感文件、Windows 特殊命名、symlink/junction、审批后冲突和工具输入均 fail closed。
- `fullAccess` 不能绕过工作模式、工作区边界、Hook deny 或 MCP disabled 策略。
- 凭证不注入模型可执行 Shell、MCP/Hook 默认环境、NDJSON、审计或 Eval 报告。

### Known Limitations

- Shell、MCP stdio 与 Hooks 不是 OS sandbox。
- Anthropic 当前为非流式；尚未实现 Responses API、MCP OAuth、LSP、完整 TUI 或写入型 Subagent。

[1.0.0]: https://github.com/syz0528/Syzzz-Code/releases/tag/v1.0.0
