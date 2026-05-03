const WebSocket = require('ws');

const token = '512733a8f6bffa1eb45e8b87a425b49846cd9f30b7edb8e41b98f8840c27d8f6';
const sessionId = 'moqa5ryglqv9ei';
const messages = [
  'Привет, как дела?',
  'Расскажи о себе кратко',
  'Что такое Node.js?',
  'Напиши функцию для сортировки массива на JavaScript'
];

function sendMessage(ws, message, callback) {
  ws.send(JSON.stringify({
    type: 'chat',
    text: message,
    sessionId: sessionId,
    mode: 'code',
    agentMode: 'single',
    model: 'kilo/x-ai/grok-code-fast-1:optimized:free',
  }));
  console.log(`Sent: ${message}`);
  setTimeout(callback, 5000); // wait 5 seconds for response
}

const ws = new WebSocket('ws://localhost:3000/ws', {
  headers: {
    'Cookie': `token=${token}`,
  },
});

ws.on('open', function open() {
  console.log('Connected');
  let i = 0;
  function next() {
    if (i < messages.length) {
      sendMessage(ws, messages[i], next);
      i++;
    } else {
      ws.close();
    }
  }
  next();
});

ws.on('error', function error(err) {
  console.error('Error:', err);
});

ws.on('close', function close() {
  console.log('Closed');
});