#!/usr/bin/env node

// Тест для проверки корректности порта и конфигурации
import BackendFactory from './backends/backend-factory.mjs';

async function main() {
  console.log('Testing port configuration...');

  // Проверяем переменную окружения
  console.log('KILO_SERVER_URL from env:', process.env.KILO_SERVER_URL);

  // Проверяем создание backend
  const backend = await BackendFactory.createBackend('kilo-agent', {
    streamMode: 'native',
    debug: true
  });

  console.log('Backend serverUrl:', backend.serverUrl);
  console.log('Backend streamMode:', backend.streamMode);

  // Проверяем подключение
  try {
    const status = await backend.getStatus();
    console.log('Server status:', status);
  } catch (error) {
    console.log('Server status error (expected if kilo serve not running):', error.message);
  }
}

main().catch(console.error);