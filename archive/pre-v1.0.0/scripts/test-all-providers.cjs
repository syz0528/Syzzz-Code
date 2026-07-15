// Historical manual diagnostic only. Not part of the formal test suite.
// This script reads user configuration and makes real network requests.
// 测试所有配置的供应商
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const configPath = path.join(os.homedir(), '.syzzz-code', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

console.log('🧪 测试所有供应商\n');

const providerIds = Object.keys(config.providers);

async function testProvider(providerId) {
  const provider = config.providers[providerId];
  
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 ${providerId} (${provider.name})`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Type: ${provider.type}`);
  console.log(`Model: ${provider.model}`);
  console.log(`Base URL: ${provider.env.BASE_URL}`);
  console.log(`API Key: ${provider.env.API_KEY ? '✓ 已设置' : '✗ 未设置'}`);
  
  if (!provider.env.API_KEY) {
    console.log('⏭️  跳过（未设置 API Key）\n');
    return;
  }
  
  console.log('\n🔌 测试连接...');
  
  return new Promise((resolve) => {
    const url = new URL('/chat/completions', provider.env.BASE_URL);
    const data = JSON.stringify({
      model: provider.model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10
    });
    
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.env.API_KEY}`
      }
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ 连接成功');
          try {
            const result = JSON.parse(responseData);
            console.log(`Tokens: ${result.usage.total_tokens}`);
          } catch (e) {}
        } else {
          console.log(`❌ 失败 (${res.statusCode})`);
          console.log(responseData.substring(0, 200));
        }
        resolve();
      });
    });
    
    req.on('error', (error) => {
      console.log(`❌ 错误: ${error.message}`);
      resolve();
    });
    
    req.setTimeout(10000, () => {
      console.log('❌ 超时');
      req.destroy();
      resolve();
    });
    
    req.write(data);
    req.end();
  });
}

(async () => {
  for (const id of providerIds) {
    await testProvider(id);
  }
  console.log('\n✨ 测试完成\n');
})();
