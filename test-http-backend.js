const KiloHttpBackend = require('./backends/kilo-http-backend');

async function testBackend() {
  console.log('Testing KiloHttpBackend...');

  const backend = new KiloHttpBackend({
    serverUrl: 'http://127.0.0.1:4097',
    timeout: 10000,
    cwd: process.cwd()
  });

  // Test getStatus
  try {
    const status = await backend.getStatus();
    console.log('Status:', status);
  } catch (error) {
    console.error('Status error:', error.message);
  }

  // Test send (this will create a session and try to send a message)
  const stream = backend.send({
    prompt: 'Hello, can you help me with a simple task?',
    model: 'kilo/kilo-auto/free',
    mode: 'orchestrator'
  });

  let fullText = '';
  let sessionId = null;

  stream
    .onText(text => {
      console.log('Received text:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
      fullText += text;
    })
    .onSessionId(id => {
      console.log('Session ID:', id);
      sessionId = id;
    })
    .onError(error => {
      console.error('Error:', error);
    })
    .onDone(id => {
      console.log('Done! Session:', id);
      console.log('Full text length:', fullText.length);
      process.exit(0);
    });

  // Timeout after 30 seconds
  setTimeout(() => {
    console.log('Test timeout reached');
    process.exit(1);
  }, 30000);
}

testBackend().catch(console.error);