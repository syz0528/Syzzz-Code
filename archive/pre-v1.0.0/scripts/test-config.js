// Historical manual diagnostic only. Not part of the formal test suite.
// This script reads user configuration and makes a real network request.
// 测试配置文件和API连接
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 读取配置
const configPath = join(homedir(), '.syzzz-code', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

console.log('📊 当前配置:');
console.log(`Provider: ${config.currentProvider}`);

const currentProvider = config.providers[config.currentProvider];
console.log(`Model: ${currentProvider.model}`);
console.log(`Base URL: ${currentProvider.env.BASE_URL}`);
console.log(`API Key: ${currentProvider.env.API_KEY ? '✓ 已设置' : '✗ 未设置'}`);

// 测试API连接
console.log('\n🔌 测试API连接...\n');

const client = new OpenAI({
  apiKey: currentProvider.env.API_KEY,
  baseURL: currentProvider.env.BASE_URL
});

try {
  const response = await client.chat.completions.create({
    model: currentProvider.model,
    messages: [
      { role: 'user', content: '你好，请回复"测试成功"' }
    ],
    max_tokens: 50
  });
  
  console.log('✅ API 连接成功！');
  console.log('\n回复内容:');
  console.log(response.choices[0].message.content);
  console.log('\n使用情况:');
  console.log(`输入 tokens: ${response.usage.prompt_tokens}`);
  console.log(`输出 tokens: ${response.usage.completion_tokens}`);
  console.log(`总计 tokens: ${response.usage.total_tokens}`);
  
} catch (error) {
  console.error('❌ API 连接失败！');
  console.error('错误信息:', error.message);
  
  if (error.status === 401) {
    console.error('\n💡 提示: API Key 无效或过期');
  } else if (error.status === 404) {
    console.error('\n💡 提示: 模型名称或 Base URL 可能不正确');
  } else if (error.code === 'ENOTFOUND') {
    console.error('\n💡 提示: Base URL 地址无法访问');
  }
}
