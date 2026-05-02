#!/usr/bin/env node

// Простой тест Native Streaming через веб-интерфейс
const WebSocket = require('ws');

async function testNativeStreaming() {
  console.log('Testing Native Streaming via Web Interface...');

  // Получаем токен аутентификации
  const auth = require('./auth');
  const token = await auth.login('2nn3b2nn3b');
  console.log('🔐 Authenticated with token');

  // Создаем WebSocket соединение с cookie аутентификации
  const ws = new WebSocket('ws://localhost:3000', {
    headers: {
      'Cookie': `session=${token}`
    }
  });

  let sessionId = null;
  let messageCount = 0;

  ws.on('open', () => {
    console.log('✅ WebSocket connected');

    // Сначала создаем сессию
    const startSessionMsg = {
      type: 'start_session',
      sessionId: 'test-session-' + Date.now()
    };
    console.log('📤 Sending start_session:', startSessionMsg);
    ws.send(JSON.stringify(startSessionMsg));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      messageCount++;

      if (msg.type === 'session_started') {
        console.log('📨 Session started:', msg.sessionId);
        sessionId = msg.sessionId;

        // Теперь отправляем сообщение чата
        const chatMsg = {
          type: 'chat',
          text: 'Hello! Can you help me with a simple coding task?',
          tabId: 'test-tab',
          sessionId: sessionId,
          workdir: './workspace',
          mode: 'code',
          model: 'kilo/kilo-auto/free'
        };
        console.log('📤 Sending chat message:', chatMsg.text);
        ws.send(JSON.stringify(chatMsg));

      } else if (msg.type === 'ai_chunk') {
        console.log('🤖 AI chunk received:', msg.payload.kind, ':', msg.payload.text?.substring(0, 50) + '...');
        if (msg.payload.kind === 'answer' && msg.payload.text) {
          process.stdout.write(msg.payload.text);
        }

      } else if (msg.type === 'done') {
        console.log('✅ Chat completed');
        console.log('📊 Total messages received:', messageCount);
        ws.close();

      } else if (msg.type === 'error') {
        console.log('❌ Error received:', msg.error);
        ws.close();
      }
    } catch (err) {
      console.log('📨 Raw message:', data.toString());
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.log('🔚 WebSocket closed');
    console.log('✅ Test completed');
  });

  // Таймаут через 30 секунд
  setTimeout(() => {
    console.log('⏰ Timeout reached');
    ws.close();
  }, 30000);
}

testNativeStreaming().catch(console.error);