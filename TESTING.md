# Syzzz Code 实测指南

## 前置准备

1. **获取 Anthropic API Key**
   - 访问 https://console.anthropic.com/
   - 创建 API Key
   - 保存好密钥

2. **安装依赖（已完成）**
   ```bash
   cd claude-code-4.8
   npm install
   npm run build
   ```

## 实测步骤

### 测试 1: 基础配置

```bash
# 初始化
node dist/index.js init

# 设置 API Key
node dist/index.js config set apiKey YOUR_ANTHROPIC_API_KEY

# 验证配置
node dist/index.js config list
```

**预期输出:**
```json
{
  "model": "claude-opus-4-8",
  "maxTokens": 8192,
  "temperature": 1,
  "apiKey": "sk-ant-..."
}
```

### 测试 2: 创建文件

```bash
node dist/index.js chat -m "创建一个 hello.txt 文件，内容是 Hello Syzzz"
```

**预期行为:**
- AI 调用 Write 工具
- 创建 hello.txt 文件
- 返回成功消息

**验证:**
```bash
type hello.txt  # Windows
# 或
cat hello.txt   # Linux/Mac
```

### 测试 3: 读取和修改文件

```bash
node dist/index.js chat -m "读取 package.json，告诉我项目名称"
```

**预期行为:**
- AI 调用 Read 工具
- 解析 JSON
- 返回项目名称: "syzzz-code"

### 测试 4: Shell 命令

```bash
node dist/index.js chat -m "列出当前目录的所有文件"
```

**预期行为:**
- AI 调用 Shell 工具
- 执行 dir (Windows) 或 ls (Linux/Mac)
- 返回文件列表

### 测试 5: 交互式对话

```bash
node dist/index.js chat
```

然后输入:
```
You: 创建一个 test.js 文件，内容是 console.log('测试')
```

```
You: 现在读取这个文件并告诉我内容
```

```
You: exit
```

### 测试 6: 复杂任务

```bash
node dist/index.js chat -m "创建一个简单的 Node.js HTTP 服务器文件 server.js，监听 3000 端口"
```

**预期行为:**
- AI 理解需求
- 调用 Write 工具
- 创建包含完整代码的 server.js

**验证:**
```bash
node server.js
# 访问 http://localhost:3000
```

## 常见问题排查

### 问题 1: API Key 错误

**错误信息:**
```
Error: No API key found
```

**解决方法:**
```bash
# 方法 1: 配置文件
node dist/index.js config set apiKey YOUR_KEY

# 方法 2: 环境变量
export ANTHROPIC_API_KEY=YOUR_KEY  # Linux/Mac
set ANTHROPIC_API_KEY=YOUR_KEY     # Windows
```

### 问题 2: 模型不存在

**错误信息:**
```
Error: model: 'claude-opus-4-8' not found
```

**解决方法:**
```bash
# 更改为可用模型
node dist/index.js config set model claude-3-5-sonnet-20241022
```

### 问题 3: 工具调用失败

**检查:**
1. 确认文件路径正确
2. 检查文件权限
3. 查看错误详情

## 性能验证

### 响应时间测试

```bash
# Windows PowerShell
Measure-Command { node dist/index.js chat -m "创建 test.txt" }

# Linux/Mac
time node dist/index.js chat -m "创建 test.txt"
```

**预期:** 首次调用 3-10 秒（API 延迟）

### 并发测试

创建 `concurrent-test.js`:
```javascript
import { QueryEngine } from './dist/engine.js';

async function test() {
  const engine = new QueryEngine();
  console.time('API Call');
  await engine.chat('列出当前目录文件');
  console.timeEnd('API Call');
}

test();
```

```bash
node concurrent-test.js
```

## 真实场景测试

### 场景 1: 代码调试

```bash
node dist/index.js chat -m "创建一个有 bug 的 JavaScript 函数，然后帮我修复它"
```

### 场景 2: Git 操作

```bash
node dist/index.js chat -m "查看 git 状态，如果有修改就创建 commit"
```

### 场景 3: 项目初始化

```bash
node dist/index.js chat -m "创建一个 TypeScript 项目的 tsconfig.json"
```

## 清理测试文件

```bash
Remove-Item hello.txt, test.txt, test.js, server.js, demo.txt -ErrorAction SilentlyContinue
```

## 测试检查清单

- [ ] 配置系统正常工作
- [ ] Write 工具能创建文件
- [ ] Read 工具能读取文件
- [ ] Edit 工具能修改文件
- [ ] Shell 工具能执行命令
- [ ] 交互式模式正常
- [ ] 单次消息模式正常
- [ ] 错误提示清晰
- [ ] API 调用成功
- [ ] 工具调用流程完整

## 下一步

测试通过后，可以:
1. 添加更多工具（Glob, Grep 等）
2. 实现会话保存功能
3. 增强错误处理
4. 添加进度显示
5. 支持流式输出
