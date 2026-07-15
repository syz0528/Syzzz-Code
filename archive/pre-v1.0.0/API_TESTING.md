# 真实 API 测试说明

## ⚠️ 重要更新

### 修正的问题

1. **模型名称已修正**
   - ❌ 旧: `claude-opus-4-8` (不存在)
   - ✅ 新: `claude-opus-4-20250514` (真实可用)

2. **需要真实 API Key**
   - 从 https://console.anthropic.com/ 获取
   - 或使用环境变量 `ANTHROPIC_API_KEY`

## 如何进行真实 API 测试

### 步骤 1: 设置 API Key

```bash
# 获取 API Key
# 1. 访问 https://console.anthropic.com/
# 2. 创建 API Key
# 3. 设置到配置

cd claude-code-4.8

# 方法1: 配置文件
node dist/index.js config set apiKey sk-ant-api03-YOUR-KEY-HERE

# 方法2: 环境变量（推荐）
export ANTHROPIC_API_KEY=sk-ant-api03-YOUR-KEY-HERE  # Linux/Mac
set ANTHROPIC_API_KEY=sk-ant-api03-YOUR-KEY-HERE     # Windows
```

### 步骤 2: 测试简单命令

```bash
node dist/index.js chat -m "创建一个 test.txt 文件，内容是 Hello World"
```

**预期行为:**
1. AI 理解需求
2. 调用 Write 工具
3. 创建文件
4. 返回成功消息

**验证:**
```bash
type test.txt  # 应该看到 "Hello World"
```

### 步骤 3: 测试工具调用

```bash
node dist/index.js chat -m "读取 package.json 并告诉我项目名称"
```

**预期行为:**
1. AI 调用 Read 工具读取文件
2. 解析 JSON
3. 返回 "syzzz-code"

### 步骤 4: 测试多轮对话

```bash
node dist/index.js chat
```

然后依次输入:
```
You: 创建一个 demo.js 文件，内容是 console.log('test')
# 等待 AI 响应

You: 现在读取这个文件
# 等待 AI 响应

You: exit
```

## 可用的模型

根据 Anthropic 官方文档，可用的模型包括：

1. **Claude Opus 4** (推荐)
   - `claude-opus-4-20250514`
   - 最强大的模型

2. **Claude Sonnet 3.5**
   - `claude-3-5-sonnet-20241022`
   - 平衡性能和成本

3. **Claude Haiku 3.5**
   - `claude-3-5-haiku-20241022`
   - 快速且经济

### 切换模型

```bash
# 使用 Sonnet 3.5
node dist/index.js config set model claude-3-5-sonnet-20241022

# 使用 Haiku 3.5
node dist/index.js config set model claude-3-5-haiku-20241022

# 恢复 Opus 4
node dist/index.js config set model claude-opus-4-20250514
```

## 常见错误

### 错误 1: 认证失败
```
Error: 401 - Authentication error
```
**解决:** 检查 API Key 是否正确设置

### 错误 2: 模型不可用
```
Error: model 'xxx' not found
```
**解决:** 使用上述列出的真实模型名称

### 错误 3: 超出配额
```
Error: 429 - Rate limit exceeded
```
**解决:** 等待或升级 API 计划

## 测试检查清单

在真实 API 测试前确认:
- [ ] 已获取有效的 Anthropic API Key
- [ ] 已设置 API Key (config 或环境变量)
- [ ] 模型名称正确 (`claude-opus-4-20250514`)
- [ ] 网络连接正常
- [ ] API 配额充足

## 性能预期

- **首次响应**: 2-5 秒 (取决于网络)
- **工具调用**: 每次 +1-2 秒
- **多轮对话**: 累加响应时间

## 成本估算

以 Claude Opus 4 为例:
- Input: ~$15 / 1M tokens
- Output: ~$75 / 1M tokens

简单任务 (100-500 tokens): < $0.01 / 次

## 下一步

真实 API 测试通过后:
1. 测试更复杂的任务
2. 验证错误处理
3. 测试并发请求
4. 优化 token 使用
