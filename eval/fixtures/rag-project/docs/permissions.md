# 权限与模式

## 只读边界

ask 和 plan 模式只允许只读工具。RAG 工具属于 `read/never`，不能改变权限、执行脚本或绕过 Hook。

## 远程授权

首次向远程 embedding 或 reranker 发送集合正文前，用户必须看到 endpoint、model、文件数和字节数，并单独输入 y 确认。
