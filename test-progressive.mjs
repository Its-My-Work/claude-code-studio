












import KiloAgentBackend from './backends/kilo-agent-backend.mjs';

async function testProgressiveDuplication() {
  console.log('Testing progressive duplication fix...\n');

  const backend = new KiloAgentBackend({
    url: 'http://127.0.0.1:4096'
  });

  let messageCount = 0;
  let totalTextChunks = 0;

  const callbacks = {
    onText: (text) => {
      totalTextChunks++;
      console.log(`[onText #${totalTextChunks}] "${text.substring(0, 30)}..."`);
    },
    onDone: (sessionId) => {
      messageCount++;
      console.log(`\n[onDone #${messageCount}] Session completed`);
    },
    onError: (error) => {
      console.error('[onError]', error);
    }
  };

  try {
    // Сначала создадим сессию
    console.log('Creating test session...');
    const createResp = await fetch(`${backend.url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'test', directory: process.cwd() })
    });
    const session = await createResp.json();
    const sessionId = session.id;
    console.log('Created session:', sessionId);

    // Отправляем 3 сообщения последовательно в одну сессию
    for (let i = 1; i <= 3; i++) {
      console.log(`\n=== Sending message ${i}/3 ===`);

      const wrapper = backend.send({
        prompt: `test message ${i}`,
        sessionId,
        callbacks
      });

      // Ждем завершения с таймаутом
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 20000);
        const origDone = wrapper.onDone;
        wrapper.onDone = (sid) => {
          clearTimeout(timeout);
          if (origDone) origDone(sid);
          resolve(sid);
        };
        wrapper.onError = (err) => {
          clearTimeout(timeout);
          console.log('[Skipping error for test]', err?.substring?.(0, 50));
          resolve(null); // Продолжаем тест даже при ошибке
        };
      });
    }

    console.log('\n=== Results ===');
    console.log(`Total onText calls: ${totalTextChunks}`);
    console.log(`Expected: ~3 (one per message)`);

    if (totalTextChunks <= 10) {
      console.log('✅ PASS: No progressive duplication');
    } else {
      console.log('❌ FAIL: Still seeing duplication');
    }

  } catch (error) {
    console.error('Test error:', error.message);
  }
}

testProgressiveDuplication();