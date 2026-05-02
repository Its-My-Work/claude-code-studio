const WebSocket = require('ws');
const http = require('http');

// Сначала попробуем получить сессию
const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/auth/status',
  method: 'GET'
}, (res) => {
  console.log('Auth status:', res.statusCode);
  res.on('data', (chunk) => console.log(chunk.toString()));
});

// Попробуем подключиться к WebSocket
setTimeout(() => {
  const ws = new WebSocket('ws://localhost:3000');
  ws.on('open', () => console.log('WS Connected'));
  ws.on('message', (data) => console.log('WS Message:', data.toString()));
  ws.on('error', (err) => console.log('WS Error:', err.message));
}, 1000);