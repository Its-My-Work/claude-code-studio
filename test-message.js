const WebSocket = require('ws');

// Попробуем отправить сообщение с токеном аутентификации
const token = '9b1cf1a6fdb7b557762a7e4a205e30826ddcc54c18037cb620ed742e3d74e9af';
const ws = new WebSocket('ws://localhost:3000', {
  headers: {
    'Cookie': `token=${token}`
  }
});

ws.on('open', () => {
  console.log('Connected, sending chat message...');
  ws.send(JSON.stringify({
    type: 'chat',
    text: 'Test message from script',
    sessionId: 'mon84dofql0p5v',
    tabId: 'mon84dofql0p5v'
  }));
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
});

ws.on('close', () => {
  console.log('Closed');
});