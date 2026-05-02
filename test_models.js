const WebSocket = require('ws');
const http = require('http');

// Получаем токен из сессий
const fs = require('fs');
const sessions = JSON.parse(fs.readFileSync('/home/user/Projects/claude-code-studio/data/sessions-auth.json', 'utf8'));
const token = Object.keys(sessions)[0];

console.log('Using token:', token);

// Проверяем API моделей
const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/models',
  method: 'GET',
  headers: {
    'Cookie': `token=${token}`
  }
}, (res) => {
  console.log('Models API status:', res.statusCode);
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    try {
      const models = JSON.parse(data);
      console.log('First 5 models:', models.slice(0, 5));
      console.log('kilo/kilo-auto/free position:', models.indexOf('kilo/kilo-auto/free'));
    } catch (e) {
      console.log('Response:', data);
    }
  });
});

req.on('error', (err) => console.error('API Error:', err.message));
req.end();