# KnowForge 统一服务：Syzzz 接入清单

日期：2026-09-08。状态：规划；尚未实现远程知识后端。

权威方案位于 KnowForge 仓库的 `docs/unified-service-plan.md`。本文只记录 Syzzz 的实施范围；变更接口时先更新权威合同，再同步本清单。完整方案的本地镜像在项目计划文件夹，仓库不记录开发机器绝对路径。

## 目标

Syzzz 仍是 TypeScript Agent 客户端，保留 TUI、会话、文件工具和权限审批。统一 FastAPI 入口提供模型与共享知识；FastAPI 不替客户端执行本地工具。

- 模型调用：入口 `/v1/models`、`/v1/chat/completions`。
- 知识调用：入口 `/knowledge/status|search|read|verify`。
- 原有本地 RAG 不删除；用户显式启用服务并按工作区挂载远程集合。
- 模型与 RAG 可使用同一个 origin，但配置、错误与就绪状态分别显示。

## 接口与所有权

当前 `runtime-engine.ts`、`rag/tools.ts` 和 `rag/management.ts` 依赖具体 RagRuntime。提取搜索/读取/验证/状态/回执的查询侧接口；保留本地摄取与文件管理所有权，不将所有本地方法机械复制进远程接口。

拟新增：

- `src/rag/service-client.ts`：HTTP 合同、取消、错误、认证环境变量和有界响应。
- `src/rag/service-runtime.ts`：远程集合状态、搜索读取、验证、证据回执适配。
- 用户级可选 `rag.service`：enabled、baseUrl、apiKeyEnv、timeoutMs；默认未配置。
- 工作区挂载标记 local/remote；同名冲突必须显式处理，不静默覆盖。
- 模型可调用的 RagSearch/RagRead/RagVerify 不接受远程 URL、凭证或任意服务器路径。

运行时设置 run ID、服务标识和开发身份。搜索只给摘要，读取才交付正文及签名凭据；当前回合未读取的 chunk 不能作为已核实引用。

## 会话与验证

1. 本地回执继续由本地 Runtime 校验，远程回执交给对应服务器，不混用索引。
2. 现有 schemaVersion 保持；新增可选后端、服务与凭据字段，同时更新 session-store 和 engine 的校验。
3. 旧记录按 local 解释；远程证据过期、hash/revision 变化时提示重新检索。
4. 支持确定性检查与按需语义验证，不同时在客户端和服务器重复运行相同验证。
5. 验证超时返回 unverifiable；严格证据模式不能把它当作成功或不加说明地输出结论。
6. 修订答案后必须针对新 draft hash 重新检查，不能复用旧稿结果。
7. 本次不通过抬高虚假的模型上下文上限、统一 128-token 回答或双换行截断来解决预算与可信性问题。

## CLI、TUI 与迁移

以下命令为拟新增，不能作为已可执行的操作手册：

```text
syzzz rag export <collection> --output <directory> --dry-run
syzzz rag export <collection> --output <directory>
syzzz rag mount techdocs --remote
syzzz rag unmount techdocs --remote
```

- 导出只包含核实过的已索引文档、hash、切片与清单。路径逃逸、敏感文件、源漂移或缺失必须报告。
- 远程集合只允许服务器已登记集合；挂载不构成新增服务器权限。
- Provider 指向服务的 /v1，知识客户端使用 /knowledge。
- /rag status、doctor、inspect 和工具事件标明 local/remote、服务健康、revision、引用警告，不展示服务器绝对目录。
- 远程 index/refresh/clear 首版提示管理员命令，不误操作本地同名集合。
- autoRetrieve、Subagent 只读检索、恢复会话与 NDJSON 共用后端路由。
- 断连明确报错，不自动查旧本地库、不切换外部模型。
- 未接入远程写入或同步前，不宣称 SaveKnowledge 已可写共享知识库。

## 验证门槛

- Mock API 覆盖正常、超限、畸形、401/429/5xx、取消、SSE 半途断开。
- 同 corpus/profile 的 HTTP 与服务内检索结果一致；MiniSearch → BM25 的差异另报。
- 两进程不会串用工具结果、证据回执、历史或取消。
- 测试配置不挂载源文档目录仍完成远程 search/read。
- 伪造、未读、跨 run、过期与源漂移引用被拒；错误日志不泄漏正文/密钥。
- 保留原有本地 RAG、权限/Hook/MCP、会话和工具回归，执行现有 check/coverage/offline eval/pack smoke。
- 客户端 Windows/Ubuntu × Node 22/24；服务 Ubuntu；真实 WSL 联调与协议 Mock 分开报告。
- 已知 lifespan 和合同价格两题只作为冒烟，不当作新的独立质量评测。

## 版本管理

- 实施分支：`codex/knowforge-unified-service`。
- 原 HEAD：`4ee1e598b05a4257ae455b4316acf92590d52672`。
- 本地检查点：`codex/checkpoint-knowforge-service-20260908`，提交 `5f928e3cc7ac1c1bf08b5e74d8b673255531a15b`。
- 检查点保存既有 tracked 改动及 query-rewriter.ts，不包含临时简历输出或私有残留；不是通过完整测试的 release。
- 当前计划提交只包含本文。原有工作树改动保留，需要另行审阅并分提交整理。
- 版本保持 1.0.0。本期不自动 push、Tag 或 npm publish。
