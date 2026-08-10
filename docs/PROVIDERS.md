# Provider 配置指南

Syzzz Code 通过 Provider 连接模型服务。每个 Provider 配置项必须明确协议、模型列表、Base URL 和凭证来源。

## 配置文件

默认位置：

```text
~/.syzzz-code/config.json
```

首次运行 `syzzz init` 会创建 schema v1 配置。缺少 `schemaVersion` 的旧配置会先备份再迁移；未知未来版本会拒绝启动，损坏配置不会被静默覆盖。

```bash
syzzz doctor
syzzz doctor --repair-config
```

修复操作会先创建备份，并要求确认。

## 协议类型

| `type`              | 使用场景                         | 流式状态             |
| ------------------- | -------------------------------- | -------------------- |
| `openai-compatible` | OpenAI Chat Completions 兼容服务 | 真流式               |
| `openai-responses`  | OpenAI Responses 兼容服务        | 真流式               |
| `anthropic`         | Anthropic Messages API           | 当前为非流式兼容路径 |

协议不会自动猜测或在失败后静默切换。一个模型只能放入真正支持该 Provider 协议的配置项中。

## 凭证配置

### 隐藏输入

```bash
syzzz config set apiKey
```

输入不会回显，也不会进入 Shell 历史。但 Key 会以明文保存在本机配置文件中，当前没有 Keychain 集成。

### 环境变量

推荐只保存变量名：

```bash
syzzz config set apiKey --from-env <ENVIRONMENT_VARIABLE>
```

解析优先级：

1. `API_KEY_ENV` 指向且非空的进程环境变量。
2. 配置文件中的 `API_KEY`。
3. 未配置。

删除当前 Provider 的凭证：

```bash
syzzz config unset apiKey
```

Syzzz Code 不接受命令行位置参数中的明文 Key，避免凭证进入 Shell 历史。

## 默认 DeepSeek 配置

`syzzz init` 创建的默认 Provider：

```json
{
  "currentProvider": "deepseek",
  "providers": {
    "deepseek": {
      "name": "Deepseek",
      "type": "openai-compatible",
      "model": "deepseek-chat",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "env": {
        "BASE_URL": "https://api.deepseek.com",
        "API_KEY": "",
        "API_KEY_ENV": "DEEPSEEK_API_KEY"
      }
    }
  }
}
```

这段内容只是完整配置中的 Provider 部分，不应删除 `audit`、`ui`、`context`、`sessions`、`subagents`、`skills` 或 `rag` 等其他顶层字段。

## OpenAI-compatible Chat Completions

适用于实现 `/chat/completions` 的服务：

```json
{
  "chat-provider": {
    "name": "Chat Provider",
    "type": "openai-compatible",
    "model": "<model-name>",
    "models": ["<model-name>"],
    "modelContextWindows": {
      "<model-name>": 128000
    },
    "env": {
      "BASE_URL": "<chat-completions-base-url>",
      "API_KEY": "",
      "API_KEY_ENV": "CHAT_PROVIDER_API_KEY"
    }
  }
}
```

`BASE_URL` 应填写 SDK 根路径，而不是把凭证放入 URL。URL 不允许包含用户名、密码、查询参数或 fragment。

Syzzz Code 会请求流式输出并聚合碎片化 tool call。仅当服务明确拒绝 `stream_options` 时，会执行一次不带该参数的兼容恢复；收到正文或工具碎片后不再重试。

## OpenAI Responses

适用于实现 Responses API 的服务：

```json
{
  "responses-provider": {
    "name": "Responses Provider",
    "type": "openai-responses",
    "model": "<model-name>",
    "models": ["<model-name>"],
    "modelContextWindows": {
      "<model-name>": 200000
    },
    "env": {
      "BASE_URL": "https://api.openai.com/v1",
      "API_KEY": "",
      "API_KEY_ENV": "OPENAI_API_KEY"
    }
  }
}
```

`BASE_URL` 可以是 API 根路径，也可以是以 `/responses` 结尾的完整端点；运行时会规范化为 Provider 所需根路径。

Responses Provider 处理文本、reasoning 状态、function call、usage、reported model 和 request ID。Provider 私有 continuation 只用于同一工具链往返，不会混入其他 Provider 历史。

## Anthropic Messages

```json
{
  "anthropic": {
    "name": "Anthropic",
    "type": "anthropic",
    "model": "<model-name>",
    "models": ["<model-name>"],
    "env": {
      "BASE_URL": "https://api.anthropic.com",
      "API_KEY": "",
      "API_KEY_ENV": "ANTHROPIC_API_KEY"
    }
  }
}
```

当前 Anthropic 路径使用非流式 Messages API，然后映射到统一 AgentEvent。它支持文本、tool use、usage 和统一错误语义，但不应被描述为 Anthropic 真流式。

## 同一服务的不同协议

如果一个服务同时提供 Chat Completions 和 Responses，应配置两个 Provider：

```json
{
  "gateway-chat": {
    "name": "Gateway Chat",
    "type": "openai-compatible",
    "model": "<chat-model>",
    "models": ["<chat-model>"],
    "env": {
      "BASE_URL": "<gateway-chat-base-url>",
      "API_KEY": "",
      "API_KEY_ENV": "GATEWAY_API_KEY"
    }
  },
  "gateway-responses": {
    "name": "Gateway Responses",
    "type": "openai-responses",
    "model": "<responses-model>",
    "models": ["<responses-model>"],
    "env": {
      "BASE_URL": "<gateway-responses-base-url>",
      "API_KEY": "",
      "API_KEY_ENV": "GATEWAY_API_KEY"
    }
  }
}
```

交互中切换：

```text
/provider
/model
```

非交互式本地选择：

```bash
syzzz switch
```

切换 Provider 或模型时会保留可移植会话历史，并删除不应跨 Provider 复用的私有 reasoning 元数据。

## Context Window

Provider 可按模型明确配置窗口：

```json
{
  "modelContextWindows": {
    "<small-model>": 65536,
    "<large-model>": 200000
  }
}
```

解析顺序：

1. `modelContextWindows` 的模型覆盖。
2. Provider 上报的窗口。
3. `context.defaultWindowTokens` fallback。

交互中可以调整 fallback：

```text
/context 64k
/context 128k
/context 200k
```

## 错误、重试与取消

Provider Runner 是唯一重试所有者：

- SDK 内部自动重试关闭。
- 每次 Provider 调用最多 3 个 attempt。
- 只重试 rate limit、timeout、network 和特定 5xx。
- 尊重有界 `Retry-After`。
- 已出现正文或 tool-call delta 后不重试。
- 用户 Abort 优先于 timeout 和 retry。

公共错误会分类为 authentication、permission、model_not_found、rate_limit、timeout、network、context_exceeded、malformed_response、unsupported_feature、provider_internal 或 unknown，且不会输出 API Key。

## 验证配置

```bash
syzzz config list
syzzz doctor
syzzz chat -m "只回复 PROVIDER_OK" --mode ask
```

Provider 协议相关问题见 [故障排查](TROUBLESHOOTING.md#provider-与模型)。
