# 使用 KnowForge 统一服务

适用于 `codex/knowforge-unified-service` 开发分支，未随 npm `1.0.0` 发布。

## 链路

Syzzz 保留本地 Agent、TUI、会话和审批，通过同一 FastAPI origin 访问 `/v1` 模型接口及 `/knowledge` 知识接口。服务器不执行客户端工具。配置可选，默认用户仍使用原本地 RAG。

在用户配置的 `providers` 增加 `knowforge-server`（保留其他 Provider）：

```json
{
  "name": "KnowForge Server",
  "type": "openai-compatible",
  "model": "knowforge-qwen3-4b-base",
  "models": ["knowforge-qwen3-4b-base"],
  "modelContextWindows": { "knowforge-qwen3-4b-base": 16384 },
  "env": { "BASE_URL": "http://127.0.0.1:18080/v1", "API_KEY": "local-only" }
}
```

将 `currentProvider` 设为 `knowforge-server`。在原 `rag` 中添加 `service`：

```json
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:18080",
  "collections": ["techdocs", "juststudy", "library"],
  "timeoutMs": 30000
}
```

`local-only` 仅是本机无密钥模拟用占位，不是真实认证。服务器设置开发 key 时，Provider 使用 `API_KEY_ENV`，`rag.service.apiKeyEnv` 使用对应环境变量名；不要提交实际 key。

模型与 RAG 是两个独立配置项。切换其他 Provider 不会自动关闭远程 RAG；证据可能发送给新 Provider，处理私人知识前务必核对。

## 验证

WSL KnowForge：

```bash
cd ~/work/KnowForge
bash scripts/start_day6_base_service.sh
bash scripts/unified-service.sh start
```

Windows：

```powershell
Invoke-RestMethod http://127.0.0.1:18080/healthz
syzzz rag status
syzzz
```

状态应显示 remote (FastAPI) 和已配置集合。重开客户端、新建会话后发送：

```text
/ask 只使用 techdocs。先调用 RagSearch，query 为 TestClient lifespan with statement；再 RagRead 最相关片段。请用中文一句话说明如何在测试中运行 lifespan，必须包含准确的 [[rag:...]] 引用，不要写代码，不要补充其他方法。
```

检查 RagSearch、RagRead 均成功且引用有效。再问商业支持价格、SLA、退款条款，材料没有证据时必须拒答。长任务中按 Ctrl+C，确认能取消并继续下一轮。

开发者在 Syzzz 源码目录运行 `npm test` 和 `node scripts/knowforge-service-smoke.mjs`。后者真实调用本地模型、使用独立空工作区，报告位于被忽略的 `artifacts/knowforge-service/`；不把小规模冒烟当作质量评测。

## 16K 上下文与排错

模型窗口是单次请求的总预算，包含指令、工具定义、历史、检索证据以及生成输出，不是只计算用户输入。`/status` 的“上下文”是已保存消息与基础提示的估算，不包含所有当轮动态指令，也不保留失败回合的临时工具结果；累计“用量”更不是当前窗口占用。

当前开发版额外显示“上次完整请求”：估算输入 / 安全输入上限，以及对应模型窗口。该数字包含当次的工具定义、AGENTS、Skill 元数据和动态规则，仅保存在运行内存中。它仍是保守估算，不是服务端 tokenizer 的精确结果；重启或切换模型后须先执行一次请求才会显示。

2026-09-08 修复了两个预算不一致：

- 工具完成后可能增加 RAG 引用规则或嵌套项目指令。现在依据下一次完整请求重新限制刚产生的工具结果，保留截断标记和调用/结果配对，不改用户原文或已提交历史。
- RagRead 后已有的简短回答合同限制输出最多 128 tokens，但旧预算仍预留 4,096 tokens。现在预算与请求实际输出上限一致；普通请求仍使用默认预留，16K 模型窗口和安全余量均保留。128 是已有输出限制，不是本次新增限制。

例如，旧逻辑曾在估算 12,311 tokens、输入上限 12,288 时拦截请求，尽管静态状态只显示约 50%。这是客户端预算错误，不是服务端显存溢出。短历史又不足以生成有意义的更短摘要，因此同时出现“没有可安全压缩的消息组”。

更新源码并构建后，退出正在运行的客户端再启动；原会话可继续，不必清空会话。纯资料问答建议使用 `/ask` 减少无关工具定义，但修复也覆盖 `code` 模式。仍不应把配置直接改成 64K 来绕过服务端实际 16K 限制。真正过大的固定指令或不可压缩消息仍会拒绝发送，错误会列出估算值、输入上限和模型窗口。

`rag.autoRetrieve: off` 不保证自然语言提问一定触发工具。验收时使用上方明确的 RagSearch → RagRead 提问；没有检索或引用的泛泛回答，不属于证据闭环成功。

## 边界与回退

- 远程 RagSearch 返回摘要；本轮 RagRead 后才能引用。服务器核对来源、客户端核对本轮读取，现有语义验证继续走 Provider。
- 来源检查与模型裁判都不是事实正确的充分保证；不存在于证据中的行内可执行示例也会进入确定性检查。
- 无网络、缺集合、超时或不合法回执会报错，不静默使用本地同名索引。
- 远程只读：index、refresh、mount、clear、SaveKnowledge 等本地管理/写入入口拒绝执行，不能用它们更新服务器。
- 当前服务迁移快照沿用 Syzzz 片段、重建 BM25；不带向量检索、不自动同步。详细资料更新限制见 KnowForge 的 `docs/unified-service-usage.md`。
- 16K 模型窗口未伪装成 64K；Adapter 没有在本次真实联调中启用，Base 为默认。
- 回退只需恢复原 Provider，并将 `rag.service.enabled` 设为 false。原本地集合、索引、挂载没有删除。
- 仅验证 Windows 到 WSL localhost，不声称跨机器内网、TLS、SSO、多租户或生产容量已验收。
