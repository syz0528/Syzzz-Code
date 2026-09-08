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

## 边界与回退

- 远程 RagSearch 返回摘要；本轮 RagRead 后才能引用。服务器核对来源、客户端核对本轮读取，现有语义验证继续走 Provider。
- 来源检查与模型裁判都不是事实正确的充分保证；不存在于证据中的行内可执行示例也会进入确定性检查。
- 无网络、缺集合、超时或不合法回执会报错，不静默使用本地同名索引。
- 远程只读：index、refresh、mount、clear、SaveKnowledge 等本地管理/写入入口拒绝执行，不能用它们更新服务器。
- 当前服务迁移快照沿用 Syzzz 片段、重建 BM25；不带向量检索、不自动同步。详细资料更新限制见 KnowForge 的 `docs/unified-service-usage.md`。
- 16K 模型窗口未伪装成 64K；Adapter 没有在本次真实联调中启用，Base 为默认。
- 回退只需恢复原 Provider，并将 `rag.service.enabled` 设为 false。原本地集合、索引、挂载没有删除。
- 仅验证 Windows 到 WSL localhost，不声称跨机器内网、TLS、SSO、多租户或生产容量已验收。
