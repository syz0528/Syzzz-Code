# Syzzz Code 当前项目状态

**更新时间：** 2026-07-28

**当前分支：** `codex/phase4-sessions`

**Phase 3 冻结基线：** `029e718`

**当前阶段：** Phase 4 已完成全部验收，状态为 **Frozen**

## 1. 当前结论

Phase 4 的“工作模式、可恢复会话与终端产品化”主体已经完成：

1. Phase 4.0：`ask | plan | code` 硬约束工作模式。
2. Phase 4.1：原子会话快照、进程锁、自动保存、恢复和生命周期命令。
3. Phase 4.2：配置 schema v1、旧配置迁移、密钥输入、Provider 环境变量和离线 doctor。

当前完整测试为 **190/190**。Phase 1 至 Phase 3 的安全、事件、Provider、终端、上下文和可靠编辑契约继续通过，没有引入完整 TUI、MCP、Hooks、并行工具或子 Agent。

## 2. 工作模式

- 新增 `AgentMode = ask | plan | code`，新会话默认 `code + safe`。
- ask/plan 只向 Provider 暴露 `risk: read` 的工具。
- 工具执行层再次检查模式，伪造的 Write/Edit/Patch/Shell 调用结构化拒绝。
- `fullAccess` 不能绕过 ask/plan 的只读边界。
- `/ask`、`/plan`、`/code` 支持先切换模式，再提交同一行正文。
- plan 回合完成后保持 plan，只有显式 `/code` 才能进入执行模式。
- `turn_started` 携带 mode；终端 prompt 显示 `You [plan|safe]` 等组合。
- `chat -m` 支持 `--mode ask|plan|code`。

## 3. 状态与手动压缩

- `QueryEngine` 新增 `getMode()`、`setMode()`、`setProvider()`、`getStatus()`、`exportState()`、`restoreState()` 和 `compactContext()`。
- `/status` 显示 session、Provider、configured/reported model、模式、权限、上下文窗口、token、压缩次数和持久化健康状态。
- `/compact` 复用 Phase 3 压缩算法并使用 `reason: manual`。
- 手动压缩为空、无可压缩历史、失败或取消时不提交历史。
- 多轮手动压缩在部分成功后取消，会回滚压缩计数和熔断状态。
- 成功压缩立即进入会话保存路径。

## 4. 会话持久化

存储位置：

```text
~/.syzzz-code/sessions/<workspaceHash>/<sessionId>/
  state.json
  meta.json
  lock.json
```

已实现：

- `state.json` 为恢复真相源，`meta.json` 可从 state 重建。
- 快照写入使用同目录唯一临时文件、`wx`、flush 和原子 rename。
- 单个 state 硬上限 64 MiB，精确边界已有回归。
- 目录和文件尽力设置为 `0700/0600`；doctor 在 Windows 明确提示 ACL 未自动验证。
- 同机存活进程的活动锁始终 fail closed；死亡锁或无法验证且超时的锁可回收。
- 删除会话前必须先取得独占 lease，关闭检查与删除之间的并发窗口。
- 恢复仅限当前规范化 workspace。
- 恢复保留 mode，但 permission 一律重置为 `safe`。
- 保存的 Provider/model 不可用时回退到当前配置并警告；旧 reported model 被清除。
- 快照不包含 Provider 私有 reasoning、API Key、审批状态或 Abort 状态。
- 工具结果继续受 Phase 3 的 40 KiB 模型可见上限。

自动保存发生在：

- 成功、失败或取消回合完成后；
- 模式、模型、Provider 切换后；
- 重命名和手动压缩后；
- Write/Edit/Patch 成功后的即时副作用检查点。

副作用检查点失败不会改写工具结果，但会警告并把 persistence 标记为 degraded。恢复后，未完成回合中的文件写入回执会提醒 Agent 重新读取文件。

## 5. 命令与会话

Slash 命令注册表包含 `work | session | runtime | general` 类别和稳定优先级。裸 `/` 的第一屏优先展示工作模式、状态与运行时控制，输入片段后继续按匹配度过滤；`/help` 按类别分组。新增命令必须明确类别和优先级。

会话命令：

- `/new [title]`，`/clear` 为别名；
- `/resume [id-or-prefix]`；
- `/rename <title>`；
- `/save`；
- `/compact`；
- `/provider [provider]`；
- `/status`。

启动与管理：

```text
syzzz                         新建会话
syzzz --continue              恢复当前工作区最近会话
syzzz --resume <id>           恢复指定会话
syzzz sessions list
syzzz sessions delete <id>
syzzz sessions prune --older-than <days>
```

一次性 `chat -m` 仍不持久化。会话默认永久保留，不存在自动删除。

## 6. 配置与密钥

- 配置新增 `schemaVersion: 1` 和 `sessions.autoSave`。
- 缺少 schemaVersion 的 legacy v0 会先创建权限受限备份，再原子迁移。
- 损坏配置不自动覆盖，`syzzz doctor` 仍可运行。
- 未来 schema 明确拒绝启动；`doctor --repair-config` 也不能覆盖。
- `syzzz config set apiKey` 在 TTY 中隐藏输入。
- `--stdin` 支持自动化。
- `--from-env NAME` 只保存环境变量名。
- 命令行位置参数不接受明文 API Key。
- 凭证解析优先级为环境变量、配置文件、缺失。
- Provider 工厂直接接收解析后的 Key，不把配置文件 Key 注入进程环境。
- BASE_URL 拒绝内嵌用户名、密码、query 和 fragment，减少输出泄漏风险。

`syzzz doctor` 默认完全离线，检查：

- Node.js 版本；
- 配置 schema 和可修复性；
- Provider、模型、凭证来源与 Endpoint；
- 配置、会话和审计目录权限；
- bundled ripgrep；
- TypeScript Worker。

所有输出均不包含 API Key。Windows ACL 当前只能提示“未自动验证”，不虚假宣称为私有。

## 7. 自动化验证

当前结果：

- `npm test`：**190/190**
- Phase 1 至 Phase 3 回归：全部保留
- 工作模式：工具过滤、执行层 fail-closed、`fullAccess` 不绕过
- 会话：原子快照、meta 重建、64 MiB 边界、坏文件隔离
- 锁：活锁、死锁、远端超时锁、删除竞争和 prune
- 恢复：mode 保留、permission 重置、Provider/model 回退
- 检查点：写入后 Provider 失败仍可恢复文件回执
- 配置：legacy 无损迁移、未来版本防覆盖、环境变量优先级
- 密钥：隐藏输入不回显、EOF、Abort、stdin 和位置参数拒绝
- CLI：Slash 生命周期命令、`--continue`、`--resume` 和 autosave-off 丢弃确认

最终发布卫生：

- `npm audit --omit=dev`：**0 vulnerabilities**
- `npm pack --dry-run --json`：166 个文件，全部属于 `dist`、`README.md` 或 `package.json`
- `git diff --check`：通过，仅存在 Windows 行尾转换提示
- `syzzz doctor`：核心检查全部通过；Windows ACL 按设计显示 warning

真实与进程级 dogfood：

- ask + NDJSON：755 条事件全部可解析，mode 为 ask，唯一终态为 `turn_completed`
- plan 保存与恢复：跨进程恢复 mode 为 plan，permission 重置为 safe
- plan → code：显式 `/code` 后只请求 Write 单次审批，未调用 Shell
- 手动压缩：24 条合成历史缩减到 17 条，重启后压缩计数仍为 1
- 双进程锁：并发恢复被拒绝，首进程退出后可立即恢复
- Provider 切换：只在本地配置中切换并成功切回，未使用在线发现
- 所有 dogfood 临时文件、会话和 Provider 配置变更均已清理或恢复

## 8. 已知边界

- Shell 不是 OS sandbox，也没有命令 allowlist 或凭证隔离。
- 会话快照未加密，可能包含代码、提示和工具结果。
- Windows ACL 不能通过当前 Node 检查可靠证明为私有。
- token 估算不是精确 tokenizer。
- 自动和手动摘要可能丢失低相关细节。
- Session lock 是本地文件锁协议，不是分布式锁服务。
- 没有会话 fork/rewind、云同步、跨工作区迁移或持久输入历史。
- Anthropic 仍为非流式兼容路径。
- 没有完整 TUI、MCP、Hooks、后台任务、并行工具或子 Agent。

## 9. Git 状态

- 当前分支：`codex/phase4-sessions`
- Phase 3 冻结提交：`029e718`
- 版本号保持 `1.0.0`
- 未发布 npm 包，未创建 Tag
- 既有 archive 行尾状态、`phase3-manual.ts` 和 `phase2-events.jsonl` 不属于 Phase 4，不纳入本阶段提交

## 10. 冻结条件

Phase 4 已满足自动化、发布卫生、内部 dogfood 和用户手动验收条件。最终手动验收覆盖 ask/plan 只读边界、code 审批、流式切换、取消、会话保存与恢复、权限重置、真实上下文压缩、双进程锁和 NDJSON 消费；手测文件、测试 Session 与锁均已清理。

Phase 4 状态标记为 **Frozen**。此后除 P0 安全、数据破坏或会话恢复错误外，不再在本阶段扩展能力，下一项进入 Phase 5。
