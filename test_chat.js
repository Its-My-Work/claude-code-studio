const WebSocket = require('ws');
const fs = require('fs');

const cookies = fs.readFileSync('cookies.txt', 'utf-8').split('\n').find(line => line.includes('token')).split('\t')[6];
console.log('Token:', cookies);

const ws = new WebSocket('ws://localhost:3000', {
  extraHeaders: {
    'Cookie': `token=${cookies}`,
    'x-auth-token': cookies
  }
});

ws.on('open', () => {
  console.log('Connected to WebSocket');
  // Send chat message directly
  ws.send(JSON.stringify({
    type: 'chat',
    tabId: 'moqakq28ih5afq',
    text: 'Привет, как дела?'
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg);
});

ws.on('error', (error) => {
  console.error('Error:', error);
});

ws.on('close', () => {
  console.log('Connection closed');
});

// Timeout after 30 seconds
setTimeout(() => {
  ws.close();
}, 30000);