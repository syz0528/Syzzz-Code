# 本地 RAG 使用说明

Syzzz Code 1.0.0 提供本地优先、证据可追踪的 RAG。检索、读取、保存和验证仍经过现有 `QueryEngine`、权限审批、事件、取消、审计、上下文压缩与会话边界，不存在第二套聊天 Runtime。

## 三种资料入口

### 1. 索引当前工作区

```powershell
syzzz rag status
syzzz rag index workspace
syzzz rag search "权限与审批如何工作"
```

工作区内容仍留在原目录，RAG 只建立版本化索引。源文件变化后执行：

```powershell
syzzz rag refresh workspace
```

### 2. 把一份文档加入个人知识库

```powershell
syzzz rag add "<document-path>"
syzzz rag add "<document-path>" --name architecture-notes.md
syzzz rag search "设计决策"
```

交互界面使用：

```text
/rag add "<document-path>"
```

Syzzz 会先展示目标 `rag://library/<filename>` 和差异，只有确认后才把原文复制到受管理的用户级目录：

```text
~/.syzzz-code/knowledge/library
```

原文件不会被修改。`library` 是保留集合，会自动挂载到当前工作区，不能通过普通外部集合命令删除。导入成功后立即刷新索引；若已配置远程 Embedding 或 reranker，首次发送正文前仍需单独确认。

### 3. 在对话中整理并保存知识

切换到 `code` 模式后，可以明确要求：

```text
请把我们刚刚确认的发布流程整理成一篇长期知识笔记，并保存到本地 RAG 库。
```

Agent 可调用 `SaveKnowledge`，但必须展示 Markdown 预览并经过写入审批。它只能写入受管理的 `library`，不能写入任意外部集合，不能绕过 ask/plan 只读模式、Hook 或权限。若要求基于本轮 RAG 证据保存，可携带已经通过 `RagRead` 读取的 chunk receipt；过期或伪造 receipt 会被拒绝。

没有远程配置时，保存后自动刷新本地词法索引。远程配置存在但尚未授权时，正文只保存到本地，并提示运行：

```text
/rag refresh library
```

## 检索与引用链路

1. 摄取层扫描受支持的普通 UTF-8 文件，应用 ignore、敏感路径、realpath 与 symlink/junction 检查。
2. Markdown 按 heading breadcrumb，TS/JS/Python 按顶层符号，其他文本按段落和行窗口切片。
3. MiniSearch 始终提供词法召回；配置可用时增加 LanceDB 向量召回。
4. 单查询或最多四个子查询分别召回，再通过 RRF 融合；可选 reranker 只重排前 20 个候选。
5. `RagSearch` 只返回摘要和 chunk ID；`RagRead` 才把正文送入模型上下文。
6. `RagRead` 生成 `[[rag:<chunkId>]]`，回合结束前检查本轮读取、revision、source hash 和行范围。
7. 可选 `RagVerify` 使用隔离 Provider fork 做 claim/evidence 复核，不获得任何工具。
8. 会话保存有界 receipt；恢复后会重新验证旧证据。源文档或 revision 已变化时，下一轮明确要求重新检索。

引用只证明回答指向一个本轮读取且未过期的片段，不证明来源本身真实、完整或足以支持结论。

## 外部集合

外部目录不会被复制，需先注册，再按工作区挂载：

```powershell
syzzz rag collections add team-docs --path "<knowledge-directory>"
syzzz rag mount team-docs
syzzz rag index team-docs
syzzz rag collections list
```

模型只看到 `rag://team-docs/<relative-path>`，不看到绝对目录。项目文件不能自行注册或挂载外部集合。

```powershell
syzzz rag unmount team-docs
syzzz rag collections remove team-docs
```

## Embedding 与 reranker

未配置远程服务时，词法检索始终可用。可在 `~/.syzzz-code/config.json` 配置 OpenAI-compatible Embedding 和可选 Jina-compatible reranker：

```json
{
  "rag": {
    "enabled": true,
    "autoRetrieve": "off",
    "autoRefresh": true,
    "embedding": {
      "type": "openai-compatible",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "env": {
        "BASE_URL": "https://api.openai.com/v1",
        "API_KEY": "",
        "API_KEY_ENV": "OPENAI_API_KEY"
      }
    },
    "reranker": {
      "type": "jina-compatible",
      "model": "jina-reranker-v2-base-multilingual",
      "env": {
        "BASE_URL": "https://api.jina.ai/v1",
        "API_KEY": "",
        "API_KEY_ENV": "JINA_API_KEY"
      }
    }
  }
}
```

首次发送正文时，CLI 显示 endpoint、model、文件数与字节数，只接受单独的 `y/Y`。授权绑定集合 canonical root、endpoint、model 和摄取规则；相关配置变化后必须重新确认。远程失败时保留可用的本地检索，不把失败描述成成功。

## 自动检索

默认 `autoRetrieve` 为 `off`，Agent 仍可显式调用 RAG 工具：

```text
/rag auto off
/rag auto ask-plan
/rag auto all
/setting rag ask-plan
```

自动检索只使用已 ready 的索引，不会隐式建库；最多注入 4 个候选和 16 KiB 正文。用户已提供显式 `@` 文件证据时会跳过。

## 索引与隐私

- 索引位于 `~/.syzzz-code/rag/indexes/<collectionId>/<revision>`。
- `CURRENT` 原子切换；失败或取消不会覆盖最后可用 revision，并保留上一版用于恢复。
- 未变化文件按 source hash 复用 chunk 与 embedding。
- 索引和个人库正文都保存在本机，当前不加密。
- 审计不保存 query、绝对路径、chunk 正文、draft 或 Provider 原始响应。
- 不应索引未加密共享账户或不可信磁盘中的敏感资料。

## 评测

```powershell
npm run eval:rag:offline

$env:SYZZZ_RAG_LIVE_ROOT = "<rag-eval-directory>"
npm run eval:rag:live
```

只有明确同意使用远程配置时才增加 `--approve-remote`。报告只保存平台、提交、case ID、排名和聚合指标，不保存 query、回答、源码、chunk 正文、Secret 或完整响应。

## 后续路线

云端 RAG 尚未进入 1.0.0。后续候选范围包括统一 `RagBackend`、OpenAI 托管 Vector Stores/File Search、xAI Collections 或兼容服务、远程 MCP 知识源，以及上传、同步、删除、配额、成本、授权撤销和数据保留治理。

在 Keychain、远程资源生命周期、删除一致性、SSRF/凭证边界和供应商契约没有完整设计与跨平台验证前，不提供半成品云 RAG。当前版本不支持 PDF、Office、图片、网页抓取、知识图谱、跨设备同步或任意历史 as-of 查询。
