# 导入规范

导入函数 `parse(text)` 接收以换行分隔的 UTF-8 文本，返回非空行数组，保持原顺序。不得修改输入文件 `raw.txt`。

目前脚本会把空行也作为数据，需要修订。请在 `importer.test.mjs` 中使用 `node:assert/strict` 的 `assert.deepEqual` 检查空行过滤、正常行顺序和空文本；所有断言通过后输出 `IMPORTER_TEST_OK`。

在工作区根目录执行 `node importer.test.mjs`。`MIGRATION.md` 应包含“适用范围”和“验证”，说明行为变化、测试命令及仍未覆盖的情况。不要声称此例已经覆盖任意 CSV、编码或大型文件。
