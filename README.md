# Syzzz Code

一个基于 Claude Opus 4.8 的命令行 AI 编程助手，参考 Claude Code 架构设计。

## 特性

- 🤖 基于 Claude Opus 4 (20250514) 模型
- 🛠️ 内置工具：Shell、Read、Write、Edit
- 💬 交互式对话模式
- ⚙️ 灵活的配置管理
- 🎯 专注于代码任务

## 安装

```bash
cd claude-code-4.8
npm install
npm run build
npm link  # 全局安装
```

## 配置

首次使用需要设置 API Key：

```bash
# 方式1：使用配置命令
syzzz config set apiKey YOUR_ANTHROPIC_API_KEY

# 方式2：设置环境变量
export ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY
```

## 使用

### 初始化
```bash
syzzz init
```

### 交互式对话
```bash
syzzz chat
```

### 单条消息
```bash
syzzz chat -m "帮我创建一个 TypeScript 项目"
```

### 配置管理
```bash
# 查看所有配置
syzzz config list

# 获取配置项
syzzz config get model

# 设置配置项
syzzz config set model claude-opus-4-8
syzzz config set maxTokens 4096
```

## 架构

```
src/
├── index.ts          # CLI 入口
├── engine.ts         # 查询引擎（核心对话循环）
├── config.ts         # 配置管理
├── types.ts          # 类型定义
└── tools/
    └── index.ts      # 工具实现（Shell, Read, Write, Edit）
```

## 工具说明

- **Shell**: 执行 shell 命令（git, npm, 文件操作等）
- **Read**: 读取文件内容
- **Write**: 创建或覆写文件
- **Edit**: 通过查找替换编辑文件

## 开发

```bash
# 开发模式运行
npm run dev

# 构建
npm run build

# 启动
npm start
```

## 示例

```bash
# 创建新文件
syzzz chat -m "创建一个 hello.ts 文件，内容是一个简单的 Hello World"

# 代码调试
syzzz chat -m "帮我检查 app.ts 中的错误"

# Git 操作
syzzz chat -m "提交当前所有改动，commit 信息为 'feat: add new feature'"
```

## License

MIT
