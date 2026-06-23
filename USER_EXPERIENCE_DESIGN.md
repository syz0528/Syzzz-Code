# 🎨 Syzzz Code - 用户体验设计方案

## 设计理念

**核心原则**：
1. **开箱即用** - 默认配置就能工作（Deepseek）
2. **一键切换** - 切换 AI 厂商只需一条命令
3. **清晰提示** - 错误信息告诉用户怎么修复
4. **灵活配置** - 支持命令行、环境变量、配置文件

---

## 📋 用户交互流程

### 场景1：新用户首次使用

```bash
$ syzzz init

🚀 Syzzz Code Initialization

✓ Configuration created: ~/.syzzz-code/config.json
✓ Default provider: Deepseek (deepseek-chat)

⚠ No API key found

📚 Quick Setup:
  1. Get key: https://platform.deepseek.com
  2. Set key: syzzz config set apiKey YOUR_KEY
  
📖 Or try another provider:
  syzzz providers         # View all
  syzzz switch anthropic  # Switch to Claude
```

### 场景2：查看所有厂商

```bash
$ syzzz providers

🤖 Available AI Providers

  1. deepseek ✓  - Deepseek - 性价比最高的中文 AI
  2. anthropic   - Anthropic Claude - 最强大的 AI 模型
  3. openai      - OpenAI - GPT 系列模型
  4. moonshot    - 月之暗面 Moonshot - 国产长文本 AI

✓ = Current provider

Commands:
  syzzz switch <provider>   # Switch provider
  syzzz models              # View current models
```

### 场景3：一键切换厂商

```bash
$ syzzz switch anthropic

🔄 Switching to Anthropic Claude...

Available models:
  1. claude-opus-4 - Most powerful ($90/M)
  2. claude-sonnet - Balanced (Recommended) ($18/M) ⭐
  3. claude-haiku - Fast & cheap ($4.8/M)

Select model [2]: <Enter>

✓ Provider: anthropic
✓ Model: claude-3-5-sonnet-20241022

⚠ Set your API key:
  syzzz config set apiKey YOUR_KEY
  Get key: https://console.anthropic.com
```

### 场景4：查看配置

```bash
$ syzzz config list

📊 Current Configuration

Provider:    deepseek (Deepseek)
Model:       deepseek-chat
API Key:     sk-****abc (set ✓)
Base URL:    https://api.deepseek.com
Max Tokens:  8192
Temperature: 1.0

💰 Cost: $3/M tokens
```

### 场景5：开始对话

```bash
$ syzzz chat -m "创建一个test.txt文件"

✓ Using Deepseek (deepseek-chat)

[Tool: Write]
Creating file: test.txt

✓ File created successfully

💰 Cost: $0.0002 | Tokens: 150
```

---

## 🎮 CLI 命令完整列表

### 基础命令

```bash
syzzz init                    # 初始化配置
syzzz providers               # 列出所有厂商
syzzz models [provider]       # 列出模型
syzzz switch <provider>       # 切换厂商（交互式）
```

### 对话命令

```bash
syzzz chat                    # 交互式对话
syzzz chat -m "message"       # 单次对话
syzzz chat --model <model>    # 临时使用指定模型
```

### 配置命令

```bash
syzzz config list             # 查看所有配置
syzzz config get <key>        # 获取配置项
syzzz config set <key> <val>  # 设置配置项
```

### 工具命令

```bash
syzzz info                    # 显示详细信息
syzzz test                    # 测试 API 连接
syzzz --help                  # 帮助
syzzz --version               # 版本
```

---

## ⚠️ 错误提示设计

### 无API Key

```bash
❌ No API key found

Current provider: deepseek

Fix:
  1. syzzz config set apiKey YOUR_KEY
  2. export DEEPSEEK_API_KEY=YOUR_KEY
  3. Add to .env file

Get key: https://platform.deepseek.com
```

### 模型不存在

```bash
❌ Model 'wrong-model' not found

Available for deepseek:
  • deepseek-chat
  • deepseek-reasoner

Fix:
  syzzz config set model deepseek-chat
```

### API调用失败

```bash
❌ API call failed (401 Unauthorized)

Causes:
  1. Invalid API key
  2. Expired key
  3. Insufficient balance

Fix:
  1. Check: syzzz config list
  2. Verify: https://platform.deepseek.com
  3. Reset: syzzz config set apiKey NEW_KEY
```

---

## 📄 配置文件

### 格式：`~/.syzzz-code/config.json`

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiKey": "sk-xxx",
  "maxTokens": 8192,
  "temperature": 1.0
}
```

### 自定义 baseURL（可选）

```json
{
  "provider": "custom",
  "model": "my-model",
  "apiKey": "sk-xxx",
  "baseURL": "https://my-api.com/v1"
}
```

---

## 🌍 环境变量支持

优先级（从高到低）：

```bash
# 1. 配置文件
~/.syzzz-code/config.json

# 2. 厂商专属
DEEPSEEK_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
MOONSHOT_API_KEY=sk-xxx

# 3. 通用变量
AI_API_KEY=sk-xxx

# 4. .env 文件
./.env
```

---

## 🎯 用户便利性设计

### 1. 智能默认值
- 默认使用 Deepseek（性价比最高）
- 推荐模型自动高亮
- 常用设置预配置

### 2. 交互式选择
- 切换厂商时自动列出模型
- 显示价格帮助决策
- 默认选择推荐项

### 3. 多种配置方式
- 命令行：快速临时设置
- 环境变量：CI/CD友好
- 配置文件：持久化存储

### 4. 清晰的反馈
- 每步操作有确认提示
- 错误信息附带解决方案
- 成本实时显示

---

## 🚀 完整使用流程示例

```bash
# 1. 安装和初始化
git clone https://github.com/syz0528/Syzzz-Code
cd Syzzz-Code
npm install && npm run build
npm link
syzzz init

# 2. 获取 API Key
# 访问 https://platform.deepseek.com
# 复制 API Key

# 3. 设置 Key
syzzz config set apiKey sk-abc123

# 4. 开始使用
syzzz chat -m "你好，创建一个hello.txt文件"

# 5. 切换到 Claude（可选）
syzzz switch anthropic
syzzz config set apiKey sk-ant-xyz789
syzzz chat -m "用Claude重新生成"

# 6. 查看配置
syzzz config list

# 7. 对话
syzzz chat
You: 帮我写一个快速排序
Assistant: [AI回复...]
You: exit
```

---

## 📊 面试展示要点

### 用户体验设计
1. **开箱即用** - 零配置启动
2. **渐进式复杂度** - 简单任务简单，高级功能可选
3. **清晰的错误提示** - 每个错误都有解决方案
4. **多种配置方式** - 适应不同使用场景

### 架构亮点
1. **厂商注册表** - 集中管理所有 AI 配置
2. **Provider 抽象** - 一个接口支持多厂商
3. **智能验证** - 配置保存时自动校验
4. **灵活扩展** - 添加新厂商只需加配置

---

**设计原则：让用户少思考，多创造！** 🎯
