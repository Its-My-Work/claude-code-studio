const WebSocket = require('ws');

const token = '512733a8f6bffa1eb45e8b87a425b49846cd9f30b7edb8e41b98f8840c27d8f6';
const sessionId = 'moqa5ryglqv9ei';
const message = 'Привет, как дела?';

const ws = new WebSocket('ws://localhost:3000/ws', {
  headers: {
    'Cookie': `token=${token}`,
  },
});

ws.on('open', function open() {
  console.log('Connected');
  ws.send(JSON.stringify({
    type: 'chat',
    text: message,
    tabId: sessionId,
    sessionId: sessionId,
    mode: 'code',
    agentMode: 'single',
    model: 'kilo/x-ai/grok-code-fast-1:optimized:free',
  }));
  console.log('Message sent');
});

ws.on('message', function incoming(data) {
  console.log('Received:', data.toString());
});

ws.on('error', function error(err) {
  console.error('Error:', err);
});

ws.on('close', function close() {
  console.log('Closed');
});