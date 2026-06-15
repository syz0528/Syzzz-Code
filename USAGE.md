# Syzzz Code - 使用示例

## 基础使用

### 1. 初始化和配置

```bash
# 初始化
cd claude-code-4.8
node dist/index.js init

# 设置 API Key（二选一）
node dist/index.js config set apiKey YOUR_ANTHROPIC_API_KEY
# 或使用环境变量
export ANTHROPIC_API_KEY=YOUR_API_KEY

# 查看配置
node dist/index.js config list
```

### 2. 单次对话

```bash
# Windows
node dist/index.js chat -m "创建一个 hello.ts 文件"

# Linux/Mac（需要 chmod +x syzzz）
./syzzz chat -m "创建一个 hello.ts 文件"
```

### 3. 交互式对话

```bash
node dist/index.js chat
# 然后输入消息，输入 exit 退出
```

## 测试示例

### 示例1：创建文件

```bash
node dist/index.js chat -m "创建一个名为 test.js 的文件，内容是 console.log('Hello Syzzz')"
```

AI 会使用 Write 工具创建文件。

### 示例2：读取和修改文件

```bash
node dist/index.js chat -m "读取 package.json 文件，然后把版本号改成 2.0.0"
```

AI 会：

1. 使用 Read 工具读取文件
2. 使用 Edit 工具修改版本号

### 示例3：执行命令

```bash
node dist/index.js chat -m "列出当前目录的所有文件"
```

AI 会使用 Shell 工具执行 `dir` 或 `ls` 命令。

### 示例4：Git 操作

```bash
node dist/index.js chat -m "查看 git 状态，如果有修改就提交，commit 信息为 'update version'"
```

AI 会使用 Shell 工具执行 git 命令。

## 架构说明

本项目基于 Claude Code 源码的核心架构理念重构，采用精简设计：

### 核心模块

1. **CLI 入口** (`src/index.ts`)
  - 基于 Commander.js 的命令解析
  - 支持 `chat`、`config`、`init` 命令
  - 交互式和单次对话模式
2. **查询引擎** (`src/engine.ts`)
  - 对话循环管理
  - 工具调用协调
  - 消息历史维护
3. **工具系统** (`src/tools/index.ts`)
  - Shell: 执行命令
  - Read: 读取文件
  - Write: 写入文件
  - Edit: 编辑文件
4. **配置管理** (`src/config.ts`)
  - 配置文件：`~/.syzzz-code/config.json`
  - 支持环境变量

### 与 Claude Code 的对比


| 特性   | Claude Code | Syzzz Code |
| ---- | ----------- | ---------- |
| 代码行数 | 100,000+    | ~500       |
| 核心功能 | ✅           | ✅          |
| 工具系统 | 20+         | 4          |
| 可运行  | ❌ (源码不完整)   | ✅          |
| 适用场景 | 复杂企业级       | 学习和轻量使用    |


## 扩展开发

### 添加新工具

在 `src/tools/index.ts` 中添加：

```typescript
export const myTool: Tool = {
  name: 'MyTool',
  description: '工具描述',
  input_schema: {
    type: 'object',
    properties: {
      param: { type: 'string' }
    },
    required: ['param']
  },
  execute: async (input) => {
    // 实现逻辑
    return 'result';
  }
};

// 添加到导出列表
export const allTools: Tool[] = [shellTool, readTool, writeTool, editTool, myTool];
```

### 修改系统提示词

编辑 `src/engine.ts` 中的 `getSystemPrompt()` 方法。

## 故障排查

### API Key 错误

```bash
# 检查配置
node dist/index.js config get apiKey

# 重新设置
node dist/index.js config set apiKey YOUR_KEY
```

### 找不到命令

```bash
# Windows: 使用完整路径
node d:\AI\VibeCoding\AI_Application\LangChain\claude-code-4.8\dist\index.js chat

# Linux/Mac: 确保 syzzz 脚本有执行权限
chmod +x syzzz
```

## License

MIT