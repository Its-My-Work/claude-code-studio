#!/usr/bin/env node

// Тест чата через веб-интерфейс
const WebSocket = require('ws');
const crypto = require('crypto');

async function testChat() {
  // Сначала авторизуемся
  const auth = require('./auth');
  const token = await auth.login('2nn3b2nn3b');
  console.log('Auth token:', token.substring(0, 20) + '...');

  // Создаем WebSocket соединение
  const ws = new WebSocket('ws://localhost:3000', {
    headers: {
      'Cookie': `session=${token}`
    }
  });

  ws.on('open', () => {
    console.log('WebSocket connected');

    // Отправляем тестовое сообщение
    const testMessage = {
      type: 'chat',
      text: 'Hello from test',
      tabId: 'test-' + Date.now(),
      workdir: './workspace'
    };

    console.log('Sending message:', testMessage);
    ws.send(JSON.stringify(testMessage));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Received:', msg.type, msg);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });

  ws.on('close', () => {
    console.log('WebSocket closed');
  });

  // Закрываем через 10 секунд
  setTimeout(() => {
    ws.close();
  }, 10000);
}

testChat().catch(console.error);