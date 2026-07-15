# Syzzz Code - 快速使用指南

## 当前状态

✅ **单次命令模式** - 自动使用 Claude Code 认证  
⚠️ **交互模式** - 需要配置 API Key（技术限制）

## 推荐使用

### 方式 1：单次命令（推荐，无需配置）

```bash
cd claude-code-4.8
node dist/index.js chat -m "创建一个 test.txt 文件"
```

✅ 自动使用你的 Claude Code 认证  
✅ 无需任何配置  
✅ 立即可用

### 方式 2：交互模式（需要 API Key）

```bash
# 1. 配置 API Key
node dist/index.js config set apiKey YOUR_ANTHROPIC_API_KEY

# 2. 启动交互模式
node dist/index.js chat
```

## 技术说明

由于 Claude Code 使用 `execSync` 调用会占用 stdin，导致交互模式的 readline 无法正常工作。

**解决方案**：
- 单次命令：使用 Claude Code 认证 ✅
- 交互模式：需要配置 API Key

这是 Syzzz Code 当前的实现方式。
