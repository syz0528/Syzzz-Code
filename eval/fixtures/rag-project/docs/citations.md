# 证据引用

## 引用格式

RagRead 返回 `[[rag:<chunkId>]]` token。终态检查确认该 chunk 在本轮已经读取、revision 存在、hash 未过期且行范围一致。

## 语义验证

RagVerify 在隔离 Provider fork 中检查 draft 与已引用证据，输出 supported、partial、unsupported 或 unverifiable。
