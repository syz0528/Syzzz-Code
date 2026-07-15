// Historical manual diagnostic only. Not part of the formal test suite.
// This script reads user configuration and makes a real network request.
// 简单的配置测试脚本（不需要依赖）
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 读取配置
const configPath = path.join(os.homedir(), '.syzzz-code', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const provider = config.providers[config.currentProvider];

console.log('📊 当前配置:');
console.log(`Provider: ${config.currentProvider} (${provider.name})`);
console.log(`Type: ${provider.type}`);
console.log(`Model: ${provider.model}`);
console.log(`Base URL: ${provider.env.BASE_URL}`);
console.log(`API Key: ${provider.env.API_KEY ? '✓ 已设置' : '✗ 未设置'}`);

console.log('\n🔌 测试 API 连接...\n');

// 构造请求
const url = new URL('/chat/completions', provider.env.BASE_URL);
const data = JSON.stringify({
  model: provider.model,
  messages: [{ role: 'user', content: '你好，请回复"测试成功"' }],
  max_tokens: 20
});

const options = {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.env.API_KEY}`
  }
};

const req = https.request(url, options, (res) => {
  let responseData = '';
  
  res.on('data', (chunk) => {
    responseData += chunk;
  });
  
  res.on('end', () => {
    if (res.statusCode === 200) {
      const result = JSON.parse(responseData);
      console.log('✅ API 连接成功！\n');
      console.log('回复内容:', result.choices[0].message.content);
      console.log('\n使用情况:');
      console.log(`输入 tokens: ${result.usage.prompt_tokens}`);
      console.log(`输出 tokens: ${result.usage.completion_tokens}`);
      console.log(`总计 tokens: ${result.usage.total_tokens}`);
    } else {
      console.error(`❌ API 返回错误 (状态码: ${res.statusCode})\n`);
      console.error('响应内容:', responseData);
      
      if (res.statusCode === 401) {
        console.error('\n💡 提示: API Key 无效或过期');
      } else if (res.statusCode === 404) {
        console.error('\n💡 提示: 模型名称或 Base URL 可能不正确');
        console.error('请检查:');
        console.error(`  - Base URL: ${provider.env.BASE_URL}`);
        console.error(`  - Model: ${provider.model}`);
      }
    }
  });
});

req.on('error', (error) => {
  console.error('❌ 连接失败！\n');
  console.error('错误信息:', error.message);
  
  if (error.code === 'ENOTFOUND') {
    console.error('\n💡 提示: Base URL 地址无法访问');
    console.error(`请检查: ${provider.env.BASE_URL}`);
  }
});

req.write(data);
req.end();
