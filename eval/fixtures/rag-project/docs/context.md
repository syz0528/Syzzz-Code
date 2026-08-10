# 上下文治理

## 渐进证据

RagSearch 只返回摘要和 chunk ID，RagRead 才把正文放入模型上下文。每个读取结果都带有 revision、hash 和行号。

## 压缩关系

上下文压缩可以保留已经进入会话的有界 RAG ToolResult，但索引版本变化后必须重新检索，不能把旧摘要当成当前事实。
