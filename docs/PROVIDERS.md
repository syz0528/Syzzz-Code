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

| `type`              | 使用场景                         | 流式状态                       |
| ------------------- | -------------------------------- | ------------------------------ |
| `openai-compatible` | OpenAI Chat Completions 兼容服务 | 真流式                         |
| `openai-responses`  | OpenAI Responses 兼容服务        | 真流式                         |
| `anthropic`         | Anthropic Messages API           | SSE 真流式，保留直接非流式调用 |

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

## 自定义请求头

Provider 的 `name` 只是显示名称，不应当作实际模型身份。切换模型后请同时核对 `type`、`model` 和 `BASE_URL`；例如名为 Deepseek 的配置也可能实际调用其他服务商的模型。

在需要额外请求头的 Provider 对象中增加 `headers`，与 `env` 同级；三类协议均支持。例如：

```json
{
  "name": "My Gateway",
  "type": "openai-compatible",
  "model": "your-model",
  "models": ["your-model"],
  "headers": {
    "x-client-name": "syzzz-code",
    "x-project-id": "my-project"
  },
  "env": {
    "BASE_URL": "https://gateway.example.com/v1",
    "API_KEY": "",
    "API_KEY_ENV": "MY_MODEL_API_KEY"
  }
}
```

只合并需要的字段，不用此示例覆盖完整配置。修改后重启 CLI 生效。普通请求、流式请求、重试和 Provider 隔离调用均使用同一组头；不会自动传给其他 Provider、RAG 服务、Embedding 或 MCP。

| 配置                                                   | 行为                             |
| ------------------------------------------------------ | -------------------------------- |
| 不填写、`null` 或 `{}`                                 | 保持原行为，不添加自定义头       |
| 某项为空字符串或全空格                                 | 忽略该项                         |
| 非空字符串                                             | 去掉两端空格后发送；名称转为小写 |
| 重复名称（不区分大小写）、非字符串、非法名称或控制字符 | 报配置错误，不发送请求           |

最多 64 项，规范化后名称和值合计最多 16 KiB。值须符合 HTTP 请求头字符限制，中文等内容需要按服务端协议编码；不自动编码。`${TOKEN}` 是字面内容，不支持环境变量展开、脚本或动态签名。额外密钥会明文保存在配置文件及备份中，不要公开配置。

认证仍由 `env.API_KEY` / `API_KEY_ENV` 管理，不允许覆盖 `Authorization`、`Proxy-Authorization` 或 `x-api-key`。HTTP/SDK 管理的头也不允许覆盖，包括 `Host`、`Content-Length`、`Content-Type`、`Content-Encoding`、`Accept`、`Accept-Encoding`、`Connection`、`Transfer-Encoding`、`TE`、`Trailer`、`Upgrade`、`Keep-Alive`、`Expect`、`anthropic-version`、`anthropic-beta` 和 `x-stainless-*`。

有有效自定义头时，客户端拒绝自动重定向，包括同站点重定向；请填写最终 API 地址，避免凭证被转发。没有有效自定义头时保留原 SDK 行为。请求头在 SDK 构造请求之后注入，避免 SDK 请求调试日志输出这些值；错误回显和请求 ID 中的已知头值会脱敏，公开错误不保留原始 SDK cause。可信服务仍会收到这些值，不应将头用作承载用户文档的渠道。

此能力不代表服务商授权或保证放行。请按服务商允许的接入方式配置；经代理访问时，后续转发由代理控制，不能假定这些头一定到达上游。

### 空响应与仅有思考内容

`finish_reason: stop` 只说明流结束，不代表存在有效答案。Chat Completions 适配器识别 `reasoning_content`，也将网关的字符串 `reasoning` 字段用于活动状态，但不把思考内容当正文，也不把后者改名为 `reasoning_content` 回传。
只有思考而没有正文或工具时会明确报错；真正空流仍然报错，消息附带实际配置模型便于定位。不会为未知模型猜测关闭思考的参数，也不会仅因显示名称包含 Deepseek 就开启 DeepSeek 专属恢复。

已验证的兼容例外：`https://opencode.ai/zen/v1` 的 `ling-3.0-flash-fin-free` 如果以 `stop` 结束却只有 `reasoning`，会在现有重试与超时预算内，用 `reasoning: { enabled: false }` 恢复一次。它与 DeepSeek 的 `thinking: { type: "disabled" }` 不是同一个协议参数。恢复仍失败就报错；已输出正文或工具片段、取消、截断或缺少结束标记时，不触发这项恢复。默认请求不关闭思考，不修改用户配置，不将思考文本作为答案或会话正文。
若出现此错误，记录当前模型、协议、是否连续对话及错误类别；不要公开完整凭证、请求头值或私有上下文。切换 `/stream off` 只影响显示，不会切换成非流式 HTTP 请求。

### OpenCode 免费模型访问限制

若服务端返回 HTTP 403，并说明 `OpenCode's free tier can only be used from within OpenCode`，Syzzz 会明确提示免费模型的客户端访问限制，不自动重试或切换模型。这与 404 路径错误、503 服务不可用、200 但只有思考内容是不同问题。自定义 `headers` 被正确发送不代表服务端授权通过，过去成功的请求也不能保证后续可用；应使用服务商允许的客户端或获准外部调用的 API，不依靠伪装请求头保证可用性。

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

交互会话和统一 Provider Runner 使用 Anthropic Messages SSE 真流式：正文增量即时进入统一 AgentEvent，工具参数按内容块聚合，完整结束后才提交可执行的工具调用。直接 `provider.chat()` 仍保留非流式兼容能力。

适配器要求完整的内容块、`message_stop` 和结束原因；提前断流、损坏的工具 JSON、空回答及只有 reasoning 的回答均报错，不把半截响应当作成功。reasoning 仅用于活动状态，不作为回答正文输出。`/stream off` 只关闭渐进展示，不关闭协议层流式。

SDK 内部重试和原始请求日志均关闭。重试由 Runtime 统一管理：HTTP 429、可重试的服务端错误（含 529）及 SSE 中的限流/过载错误只在尚未输出正文或工具片段时重试，遵守现有次数和时间预算。401/403 不重试，也不会静默改走非流式来重放请求。取消或关闭迭代器会释放当前 HTTP 流。

本次适配不自动启用 extended thinking、缓存断点、专属代理或额外身份请求头；协议兼容不代表服务端授予调用许可。Anthropic SDK 固定为 `0.126.0`，通过本地 HTTP/SSE 回放验证；远程网关仍需使用获准调用的接口单独验收。

`BASE_URL` 接受服务根地址、以 `/v1` 结尾的 API 地址或完整 `/v1/messages` 端点。适配器会保留网关前缀并规范化地址，避免 Anthropic SDK 自动追加 `/v1/messages` 时产生重复的 `/v1/v1/messages`。
例如 OpenCode 的 `https://opencode.ai/zen`、`https://opencode.ai/zen/v1` 和 `https://opencode.ai/zen/v1/messages` 均请求 `https://opencode.ai/zen/v1/messages`。模型是否支持此协议仍以服务商说明为准；地址规范化不会自动切换协议或模型。

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

公共错误会分类为 authentication、permission、model_not_found、model_unavailable、invalid_request、rate_limit、timeout、network、context_exceeded、malformed_response、unsupported_feature、provider_internal 或 unknown，且不会输出 API Key。

HTTP 400/422 不再笼统显示 `provider request failed`：上游明确报告 `Model is unavailable` 时提示切换模型或稍后重试；其他参数拒绝提示检查模型、协议及请求配置。不会原样显示上游错误正文，也不会自动重试这些请求。模型不可用不等于鉴权失败，不能通过补请求头保证恢复。

`/stream off` 只关闭渐进展示，界面会等待 Provider 完成后再显示回答；Provider 的 SSE 传输仍保持开启。因此等待期间的 Provider 计时不代表 TUI 卡住。开启展示后，已呈现完的回答不会因输入、状态更新或重排而重新排入展示队列。

## 验证配置

```bash
syzzz config list
syzzz doctor
syzzz chat -m "只回复 PROVIDER_OK" --mode ask
```

Provider 协议相关问题见 [故障排查](TROUBLESHOOTING.md#provider-与模型)。
