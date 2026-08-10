# Syzzz Code 新手入门

本指南假设你以前没有使用过编程 Agent。完成后，你将能够安全地让 Syzzz Code 了解一个项目、制定计划、修改文件、运行测试并恢复会话。

## 1. 先理解四个概念

### 工作区

启动 Syzzz Code 时所在的目录就是当前工作区。文件工具默认只能访问这个目录及其子目录。

```bash
cd <project-directory>
syzzz
```

在正确目录启动非常重要：会话、输入历史、工作区权限和 RAG 挂载都按规范化工作区隔离。

### Provider

Provider 是提供模型 API 的服务。Syzzz Code 本身不附带模型额度，需要配置一个可用 Provider 和 API Key。

### 模型

模型属于 Provider。`/model` 只在当前 Provider 已配置的模型列表中切换，`/provider` 才会切换服务和协议。

### Agent

普通聊天模型只返回文本；Agent 还能调用工具读取文件、搜索代码、修改内容或执行命令。工具能力更强，因此 Syzzz Code 使用工作模式、权限、审批、Hook 和路径边界共同约束执行。

## 2. 安装

确认 Node.js 版本不低于 22：

```bash
node --version
```

安装正式版：

```bash
npm install --global syzzz-code@1.0.0
```

确认命令可用：

```bash
syzzz --version
syzzz --help
```

如果终端提示找不到 `syzzz`，请阅读 [故障排查](TROUBLESHOOTING.md#安装后找不到-syzzz)。

## 3. 配置第一个 Provider

初始化默认配置：

```bash
syzzz init
```

默认 Provider 是 DeepSeek。使用隐藏输入保存 API Key：

```bash
syzzz config set apiKey
```

更推荐让配置引用一个已经存在的环境变量：

```bash
syzzz config set apiKey --from-env DEEPSEEK_API_KEY
```

离线检查配置：

```bash
syzzz config list
syzzz doctor
```

使用 OpenAI Responses、Anthropic 或其他 OpenAI-compatible 服务时，请参考 [Provider 配置指南](PROVIDERS.md)。

## 4. 在一个项目里启动

```bash
cd <project-directory>
syzzz
```

首次进入工作区会创建新会话。以后启动时，TUI 可以选择继续最近会话或新建会话。

建议先发送一条只读任务：

```text
/ask 请只读分析当前项目，告诉我它的用途、主要目录、入口文件和测试命令。不要修改文件，不要执行 Shell。
```

观察 Agent 是否使用 Glob、Grep、Read、RepoMap 或 Diagnostics 等只读工具，并核对结论是否来自真实工具结果。

## 5. 制定计划

```text
/plan 请规划增加一个版本检查命令。列出目标、要修改的文件、风险和验证步骤，不要执行。
```

计划模式不会自动进入执行。你可以继续追问：

```text
请缩小范围，只修改 CLI 入口和相关测试。
```

确认计划后显式切换：

```text
/code 按当前计划实施。
```

## 6. 理解审批

默认 `safe` 权限下，文件修改会显示差异，Shell 会显示完整命令、工作目录和超时。

### 文件编辑

- `y`：只允许当前编辑。
- `a`：允许当前会话后续文件编辑。
- `N`、空行或其他输入：拒绝。

### Shell

- `y`：只允许当前命令。
- `N`、空行或其他输入：拒绝。

请不要因为命令看起来熟悉就跳过阅读。Shell 可能访问网络、修改工作区外文件或启动长期进程。

## 7. 查看结果

完成修改后，可以要求：

```text
请使用 GitDiff 检查修改，只运行与本次任务直接相关的测试，然后如实报告通过、失败或未运行。
```

Syzzz Code 不会把模型猜测当成测试结果；只有真实 Tool Result 才能作为验证依据。

## 8. 保存和恢复会话

```text
/rename first-task
/save
/status
```

退出后恢复最近会话：

```bash
syzzz --continue
```

查看所有当前工作区会话：

```bash
syzzz sessions list
```

按 ID 或唯一前缀恢复：

```bash
syzzz --resume <session-id-or-prefix>
```

恢复会话时 `fullAccess` 永远不会恢复。已明确保存到会话或工作区的编辑授权可以恢复，其他权限回到 `safe`。

## 9. 添加显式文件证据

```text
/ask 根据 @README.md 说明安装流程。
```

指定行范围：

```text
/ask 解释 @src/index.ts#L100-L180。
```

路径包含空格：

```text
/ask 总结 @"docs/design notes.md"。
```

显式上下文会保存当时读取的有界快照，恢复会话后仍能看到同一份证据。

## 10. 使用一个 Skill

输入 `$` 浏览当前 Skills：

```text
$skill-name 检查当前项目
```

Skill 是可渐进加载的工作流说明，不是权限包。它不能绕过工作模式、审批、Hook 或 MCP policy。

## 11. 建立第一个本地 RAG 索引

```bash
syzzz rag index workspace
syzzz rag search "项目如何处理权限"
```

也可以导入一份独立文档：

```bash
syzzz rag add "<document-path>"
```

默认词法检索不需要远程服务。配置 Embedding 后，首次发送集合正文前仍会要求明确确认。详见 [本地 RAG 使用说明](RAG.md)。

## 12. 推荐的日常流程

1. 在正确项目目录启动。
2. 用 `ask` 只读了解现状。
3. 用 `plan` 缩小目标和修改范围。
4. 用 `code + safe` 执行。
5. 阅读每次审批。
6. 检查 GitDiff。
7. 运行最小必要测试。
8. 需要继续时保存或恢复会话。

## 下一步

- [命令参考](COMMANDS.md)
- [Provider 配置](PROVIDERS.md)
- [故障排查](TROUBLESHOOTING.md)
- [扩展使用指南](EXTENSIONS.md)
- [安全策略](../SECURITY.md)
