# 参与 Syzzz Code 开发

感谢你愿意帮助改进 Syzzz Code。提交修改前，请先阅读 [安全说明](SECURITY.md) 和 [测试指南](TESTING.md)。

## 开发环境

- Node.js 22 或 24
- npm
- Git
- Windows、macOS 或 Linux 终端

获取源码并安装依赖：

```bash
git clone https://github.com/syz0528/Syzzz-Code.git
cd Syzzz-Code
npm ci
npm run build
```

不要把真实 API Key、私有配置、会话、审计、RAG 索引或 Eval 报告提交到仓库。Provider 联网测试只应使用你明确提供的临时凭证。

## 修改原则

1. 优先复用现有 Runtime、工具、权限和事件边界。
2. 保持改动范围清晰，不混入无关格式化或重构。
3. 新能力必须保留 `ask | plan | code`、权限审批、取消、审计和工作区边界。
4. 涉及公开接口、配置或安全语义时，同步更新测试和文档。
5. 不依赖提示词实现本应由执行层保证的安全限制。

## 本地验证

常规修改至少运行：

```bash
npm run build
npm test
npm run lint
npm run format:check
git diff --check
```

涉及 TUI 时增加：

```bash
npm run test:tui
```

涉及 Provider、RAG、打包或发布时，按照 [测试指南](TESTING.md) 运行对应专项门槛。完整综合检查为：

```bash
npm run check
```

## 提交 Pull Request

- 使用简洁、可审查的提交。
- 在说明中写清问题、解决方式、安全影响和验证结果。
- 界面修改应附上实际终端环境和必要的截图。
- 行为变化应补充回归测试；无法自动测试的部分应列出人工验证步骤。
- 不要在 Issue、PR、日志或截图中公开凭证、私有代码和本机绝对路径。

## 报告安全问题

不要通过公开 Issue 报告未修复漏洞。请按照 [SECURITY.md](SECURITY.md) 中的说明联系维护者，并提供脱敏的最小复现、受影响版本和预期安全边界。
