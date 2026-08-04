# Phase 8 TUI 技术 Spike

该目录验证 Phase 8 全屏 TUI 的关键技术风险，不接入真实 Agent Runtime，也不进入 npm 发布包。

## 运行

```bash
npm run spike:tui:test
npm run spike:tui:probe
npm run spike:tui
```

交互演示必须在真实 TTY 中运行。输入 `/`、`@` 或 `$` 查看候选；提交 `/approve-demo` 可打开审批面板；`Ctrl+C` 退出并恢复原终端。

## 验证范围

- Ink alternate screen 的进入和恢复；
- raw mode 的启用和清理；
- Windows/窄终端布局与中文宽度；
- `/`、`@`、`$` 共用稳定候选区域；
- bracketed paste 与多行 Unicode；
- 结构化审批和 Ctrl+C 决策；
- 高频流式内容重渲染；
- resize 对同一组件树的确定性重排。
- TUI 暂停时释放 alternate screen，将终端交给子进程后重新接管；
- `auto | tui | inline` 在非 TTY 与 screen-reader 环境中的降级。

## 非目标

- 不改变 `AgentEvent`、Provider、工具、会话或配置协议；
- 不执行真实 Shell、文件写入、MCP、Hook 或 Subagent；
- 不决定最终主题、快捷键和组件视觉规范；
- 不替代现有 inline 与 NDJSON renderer。

## 验证结果

2026-08-04 在 Windows、Node 24 上完成自动化验证：

- Spike 风险探针：8/8 通过；
- 1000 次真实 Ink 增量更新：分发约 18ms，完成 flush 约 30ms，终端写出 6249 bytes；
- 现有项目回归：319/319 通过；
- 覆盖率通过既有门槛：Lines 82.29%、Branches 75.82%、Functions 86.41%；
- 离线 Eval 12/12、ESLint、Prettier、完整依赖审计、包 allowlist、安装包 smoke 和 `git diff --check` 通过；
- npm 发布包仍为 244 个 allowlist 文件，不包含 `spikes` 或测试依赖。

首轮探针真实暴露并修复了窄终端 Header、Composer 和 Footer 挤压问题。最终探针确认：

- alternate screen 退出后恢复主屏幕与 raw mode；
- resize 会触发紧凑布局，中文内容不会越过终端列宽；
- `/`、`@`、`$` 使用同一候选区域，不依赖追加 scrollback 行；
- bracketed paste 不会被拆成多次提交；
- 审批答案和 Ctrl+C 产生结构化 action，不进入 Composer；
- `suspendTerminal()` 会在子进程期间退出 alternate screen、释放输入状态，并在结束后重新接管；
- `auto` 在非 TTY 与 screen-reader 环境中确定性降级到 inline。

## 初步技术决策

- Phase 8 可以采用 Ink 7 + React 19，不再扩展当前手写 ANSI 光标状态机；
- 正式实现使用 `TUI | inline | stream-json` 三种前端，共享 Interaction Controller；
- TTY 默认 `auto -> tui`，显式 `--ui inline` 保留兼容路径；
- Agent Runtime、权限和工具协议不应依赖 React 或 TUI；
- 流式事件进入 UI 前需要批处理，正式 renderer 使用帧率上限与增量渲染；
- Shell 等需要终端控制权的前台任务必须通过 `suspendTerminal()` 执行。

## 正式阶段仍需验证

- Windows Terminal 中的中文 IME、超长组合字符和真实鼠标/键盘体验；
- Node 22/24 与 Ubuntu 的跨平台 CI；
- screen-reader 模式和 inline 降级的人工可用性；
- 极小终端、窗口频繁缩放、长会话滚动和十万级事件的内存上限；
- TUI 崩溃、进程信号和强制退出时的最终终端恢复。
