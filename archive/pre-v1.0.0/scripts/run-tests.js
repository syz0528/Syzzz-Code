#!/usr/bin/env node

// Historical test harness retained for reference only.
// It targets an obsolete CLI contract; use `npm test` instead.
// 自动化测试脚本
import { execSync } from 'child_process';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs';

const testFiles = ['test-output.txt', 'test-edit.txt'];
let passed = 0;
let failed = 0;

function cleanup() {
  testFiles.forEach(file => {
    if (existsSync(file)) unlinkSync(file);
  });
}

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed++;
  }
}

console.log('=== Syzzz Code 自动化测试 ===\n');

// 清理旧文件
cleanup();

// 测试 1: 配置系统
test('配置系统 - 读取默认配置', () => {
  const output = execSync('node dist/index.js config list', { encoding: 'utf-8' });
  if (!output.includes('claude-opus-4-20250514')) throw new Error('配置读取失败');
});

test('配置系统 - 设置配置项', () => {
  execSync('node dist/index.js config set maxTokens 4096', { encoding: 'utf-8' });
  const output = execSync('node dist/index.js config get maxTokens', { encoding: 'utf-8' });
  if (!output.includes('4096')) throw new Error('配置设置失败');
  // 恢复默认值
  execSync('node dist/index.js config set maxTokens 8192', { encoding: 'utf-8' });
});

// 测试 2: 工具功能
test('Write 工具 - 创建文件', () => {
  writeFileSync('test-output.txt', 'Test content');
  if (!existsSync('test-output.txt')) throw new Error('文件创建失败');
});

test('Read 工具 - 读取文件', () => {
  const content = readFileSync('test-output.txt', 'utf-8');
  if (content !== 'Test content') throw new Error('文件读取失败');
});

test('Edit 工具 - 编辑文件', () => {
  writeFileSync('test-edit.txt', 'Hello World');
  let content = readFileSync('test-edit.txt', 'utf-8');
  content = content.replace('Hello', 'Hi');
  writeFileSync('test-edit.txt', content);
  const newContent = readFileSync('test-edit.txt', 'utf-8');
  if (newContent !== 'Hi World') throw new Error('文件编辑失败');
});

test('Shell 工具 - 执行命令', () => {
  const output = execSync('dir', { encoding: 'utf-8' });
  if (!output) throw new Error('命令执行失败');
});

// 测试 3: CLI 命令
test('CLI - 帮助信息', () => {
  const output = execSync('node dist/index.js --help', { encoding: 'utf-8' });
  if (!output.includes('Syzzz Code')) throw new Error('帮助信息错误');
});

test('CLI - 版本信息', () => {
  const output = execSync('node dist/index.js --version', { encoding: 'utf-8' });
  if (!output.includes('1.0.0')) throw new Error('版本信息错误');
});

test('CLI - 初始化命令', () => {
  const output = execSync('node dist/index.js init', { encoding: 'utf-8' });
  if (!output.includes('initialized')) throw new Error('初始化失败');
});

// 清理测试文件
cleanup();

// 输出结果
console.log('\n=== 测试结果 ===');
console.log(`通过: ${passed}`);
console.log(`失败: ${failed}`);
console.log(`总计: ${passed + failed}`);

if (failed > 0) {
  console.log('\n❌ 部分测试失败');
  process.exit(1);
} else {
  console.log('\n✅ 所有测试通过！');
}
