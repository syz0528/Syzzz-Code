# 命令参考

本文档列出 Syzzz Code `1.0.0` 的命令行、交互式 Slash 命令、组合语法和常用按键。

## 顶层命令

```text
syzzz [--continue] [--resume <id>] [--ui auto|tui|inline]
syzzz config <action>
syzzz switch
syzzz sessions <action>
syzzz rag <action>
syzzz extensions status
syzzz mcp <action>
syzzz hooks <action>
syzzz skills <action>
syzzz doctor
syzzz chat [options]
syzzz init
```

随时查看当前构建的权威参数：

```bash
syzzz --help
syzzz <command> --help
```

## 交互式启动

| 命令                  | 说明                           |
| --------------------- | ------------------------------ |
| `syzzz`               | 在当前工作区启动交互会话       |
| `syzzz --continue`    | 恢复当前工作区最近会话         |
| `syzzz --resume <id>` | 按完整 ID 或唯一前缀恢复       |
| `syzzz --ui auto`     | 自动选择 TUI 或 inline         |
| `syzzz --ui tui`      | 强制 TUI；终端不支持时返回错误 |
| `syzzz --ui inline`   | 使用滚动式 inline 界面         |

## 一次性聊天

```bash
syzzz chat -m "<message>" --mode ask|plan|code
syzzz chat -m "<message>" --stream on|off
syzzz chat -m "<message>" --output-format text|stream-json
```

一次性 `chat -m` 不创建持久会话，也不启动 TUI。`stream-json` 与显式 `--stream` 不能同时使用。

退出码：

| 结果     | 退出码 |
| -------- | ------ |
| 成功     | `0`    |
| 失败     | `1`    |
| 用户取消 | `130`  |

## 配置

```bash
syzzz config list
syzzz config set apiKey
syzzz config set apiKey --stdin
syzzz config set apiKey --from-env <name>
syzzz config unset apiKey
syzzz config set sessions.autoSave on|off
syzzz switch
syzzz doctor
syzzz doctor --repair-config
```

## 会话管理

```bash
syzzz sessions list
syzzz sessions delete <id-or-prefix>
syzzz sessions delete <id-or-prefix> --yes
syzzz sessions prune --older-than <days>
```

已被其他进程锁定的会话不能恢复、删除或 prune。

## RAG 管理

```bash
syzzz rag status
syzzz rag doctor
syzzz rag add "<document-path>" [--name <filename>]
syzzz rag index [workspace|library|<collection>]
syzzz rag refresh [workspace|library|<collection>]
syzzz rag search "<query>"
syzzz rag inspect <chunk-id>
syzzz rag clear <collection>
syzzz rag collections list
syzzz rag collections add <name> --path "<knowledge-directory>"
syzzz rag collections remove <name>
syzzz rag mount <name>
syzzz rag unmount <name>
```

`--json` 可用于机器可读输出，`--yes` 只跳过命令自身允许跳过的明确确认。

## Skills

```bash
syzzz skills list
syzzz skills inspect <name>
syzzz skills doctor
syzzz skills create <name> --description "<description>"
syzzz skills validate [name|path]
syzzz skills test <name>
syzzz skills install <public-https-git-url>
syzzz skills update <name>
syzzz skills rollback <name>
syzzz skills remove <name>
```

安装支持 `--ref`、`--skill`、`--scope user|project`、`--yes` 和 `--json`。默认安装到用户作用域。

## MCP 与 Hooks

```bash
syzzz extensions status [--json]
syzzz mcp list|add|remove|enable|disable|policy|doctor
syzzz hooks list|add|remove|enable|disable|doctor
```

详细参数使用：

```bash
syzzz mcp --help
syzzz hooks --help
```

## Slash 命令

### 工作模式

| 命令              | 说明                             |
| ----------------- | -------------------------------- |
| `/ask [message]`  | 切换只读问答模式，可同时提交消息 |
| `/plan [message]` | 切换只读规划模式，可同时提交消息 |
| `/code [message]` | 切换执行模式，可同时提交消息     |

### 会话

| 命令              | 说明                                             |
| ----------------- | ------------------------------------------------ |
| `/status`         | 显示会话、Provider、模式、权限、上下文和扩展状态 |
| `/new [title]`    | 保存旧会话并新建会话                             |
| `/clear`          | `/new` 的别名                                    |
| `/resume [id]`    | 选择或恢复当前工作区会话                         |
| `/rename <title>` | 重命名当前会话                                   |
| `/save`           | 显式保存                                         |
| `/compact`        | 手动压缩当前上下文                               |
| `/history status  | on                                               | off | clear` | 管理当前工作区输入历史 |

### Runtime 与界面

| 命令                         | 说明                                         |
| ---------------------------- | -------------------------------------------- |
| `/provider [id]`             | 查看或切换已配置 Provider                    |
| `/model [name]`              | 查看或切换当前 Provider 的模型               |
| `/permissions [mode]`        | 查看或切换权限                               |
| `/stream on                  | off`                                         | 控制终端正文渐进展示            |
| `/context [reload            | 64k                                          | 128k                            | 200k]`           | 管理组合上下文和 fallback window |
| `/language auto              | zh-CN                                        | en`                             | 设置本地界面语言 |
| `/setting [section] [value]` | 集中设置语言、流式、帧率、历史、上下文与 RAG |
| `/ui status`                 | 显示终端和渲染诊断                           |
| `/terminal-setup status      | install`                                     | 检查或安装 Shift+Enter 终端映射 |

### RAG

```text
/rag status
/rag doctor
/rag add "<document-path>"
/rag index workspace
/rag refresh workspace
/rag search <query>
/rag inspect <chunk-id>
/rag clear <collection>
/rag collections list
/rag mount <collection>
/rag unmount <collection>
/rag auto off|ask-plan|all
```

### Skills 与扩展

| 命令                   | 说明                                           |
| ---------------------- | ---------------------------------------------- |
| `/skills ...`          | 列出、检查、重载、创建、验证、测试或管理 Skill |
| `/extensions [reload]` | 查看或重载扩展运行时                           |
| `/mcp [reload          | inspect                                        | reconnect]`             | 查看和管理 MCP 连接 |
| `/hooks [reload]`      | 查看或重载 Hooks                               |
| `/agents on            | off`                                           | 启用或关闭只读 Subagent |
| `/trust`               | 审查并信任当前项目扩展                         |
| `/untrust`             | 撤销项目扩展信任并断开项目 MCP                 |

### 通用命令

| 命令             | 说明               |
| ---------------- | ------------------ |
| `/help`、`/?`    | 按分类显示命令帮助 |
| `/exit`、`/quit` | 保存并退出         |

未知 Slash 命令不会发送给模型。`//text` 会发送字面 `/text`。

## `@` 显式上下文

```text
@path
@"path with spaces"
@path#L10
@path#L10-L40
```

`@@` 转义为普通 `@`。目录引用只提供有界清单，不递归注入全部正文。

## `$` Skills

```text
$skill-name
$skill-name additional arguments
```

`$$` 转义为普通 `$`。显式激活不受隐式调用开关影响，但禁用的 Skill 仍不可用。

## TUI 按键

| 按键                 | 行为                                        |
| -------------------- | ------------------------------------------- |
| `Enter`              | 提交                                        |
| `Shift+Enter`        | 可识别终端中换行                            |
| `Ctrl+J`             | 稳定换行                                    |
| `Up/Down`            | 候选导航、多行光标或终端策略指定的滚动/历史 |
| `Ctrl+P/Ctrl+N`      | 在 arrow-fallback 终端浏览输入历史          |
| `Tab`                | 接受候选但不立即提交                        |
| `Esc`                | 关闭当前非关键面板                          |
| `PageUp/PageDown`    | 滚动 Transcript                             |
| `Ctrl+Home/Ctrl+End` | 跳到 Transcript 顶部或底部                  |
| `Ctrl+O`             | 展开或收起最近工具详情                      |
| `Ctrl+C`             | 关闭、清空、取消或双击退出                  |

审批和 AskUser 回答不会进入 Composer 输入历史。
