# Syzzz Code 文档导航

安装与第一次使用请从[项目 README](../README.md)和[入门指南](GETTING_STARTED.md)开始。这里按用途列出已有文档，不改变应用配置或执行行为。

## 日常使用

| 需求                               | 文档                                   |
| ---------------------------------- | -------------------------------------- |
| 交互命令与模式                     | [命令说明](COMMANDS.md)                |
| 配置模型提供商与协议               | [Provider 配置](PROVIDERS.md)          |
| 使用本地 RAG、集合和证据引用       | [RAG 使用说明](RAG.md)                 |
| 连接 KnowForge 服务                | [KnowForge 服务](knowforge-service.md) |
| 使用 Skills、MCP、Hooks 和子智能体 | [扩展机制](EXTENSIONS.md)              |
| 排查连接、上下文与终端问题         | [常见问题](TROUBLESHOOTING.md)         |

## 开发分支新增能力

这些文档对应当前开发分支，不表示已经发布到 npm。安装历史公开版本时，请先核对版本与命令是否一致。

- [任务交付记录](task-delivery.md)：显式 `/task`、文件与检查回执、中断后的未决操作保护。
- [Skills 渐进发现](skill-discovery.md)：目录模式、候选发现、分页及实际加载的区别。
- [项目记忆](project-memory.md)：显式记忆、工作区隔离、来源变化和关闭边界。
- [当前项目状态](../CURRENT_STATUS.md)：最新实现与验收范围，以及旧阶段记录。

## 历史诊断与实验

下列记录解释当时的修订、评测与限制，不应只凭文件标题判断当前默认行为。

- [任务理解与决策评测](DECISION_EVAL.md)
- [Prompt 收敛](PROMPT_CONSOLIDATION.md)
- [Prompt 真实评测](PROMPT_LIVE_EVAL.md)
- [Prompt 评测复核](PROMPT_LIVE_REVIEW.md)
- [空检索恢复](RAG_EMPTY_SEARCH_RECOVERY.md)
- [RAG 参数与本地证据](RAG_PARAMETER_AND_LOCAL_EVIDENCE.md)
- [紧凑证据交付](COMPACT_EVIDENCE_DELIVERY.md)
- [任务遗漏检查实验](TASK_COMPLETION_REVIEW.md)

Jev 的可选实验接口不等于默认启用或已证明全链路收益。研究报告不搬入产品发布文档；本地实验数据与机器回执也不在此复制。

## 开发与安全

- [架构](../ARCHITECTURE.md)
- [测试](../TESTING.md)
- [安全边界](../SECURITY.md)
- [贡献指南](../CONTRIBUTING.md)
- [版本变更](../CHANGELOG.md)
- [路线图](../ROADMAP.md)
- [发布前历史归档](../archive/pre-v1.0.0/README.md)
