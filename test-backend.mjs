// Test script for KiloAgentBackend
import('./backends/kilo-agent-backend.mjs').then(async (m) => {
  const KiloAgentBackend = m.default;
  const backend = new KiloAgentBackend({ url: process.env.KILO_SERVER_URL || 'http://127.0.0.1:4098' });
  
  console.log('Testing KiloAgentBackend...');
  
  // Test getStatus
  const status = await backend.getStatus();
  console.log('Status:', status);
  
  // Test send
  let fullText = '';
  let textCount = 0;
  let reasoningCount = 0;
  let toolCalls = [];
  
  console.log('Starting send...');
  
  try {
    const stream = backend.send({
      prompt: 'Привет! Как дела? Краткий ответ.',
      model: 'kilo/kilo-auto/free',
      maxTurns: 5,
    });
    
    console.log('Stream object:', Object.keys(stream));
    
    stream
      .onText(t => { 
        fullText += t;
        textCount++;
        console.log('Text chunk received, total:', fullText.length, 'preview:', t);
      })
      .onReasoning(r => {
        reasoningCount++;
        console.log('Reasoning chunk received');
      })
      .onTool((name, input) => {
        toolCalls.push({ name, input: input.substring(0, 100) });
        console.log('Tool call:', name);
      })
      .onSessionId(sid => {
        console.log('Session ID:', sid);
      })
      .onDone(sid => {
        console.log('Done! Session:', sid);
        console.log('Full text:', fullText);
        console.log('Text chunks:', textCount);
        console.log('Reasoning chunks:', reasoningCount);
        console.log('Tool calls:', toolCalls);
        process.exit(0);
      })
      .onError(err => {
        console.error('Error:', err);
        process.exit(1);
      });
  } catch (e) {
    console.error('Exception:', e);
    process.exit(1);
  }
  
  // Timeout after 30 seconds
  setTimeout(() => {
    console.log('Timeout reached');
    console.log('Full text so far:', fullText);
    process.exit(0);
  }, 30000);
}).catch(err => {
  console.error('Failed to load:', err);
  process.exit(1);
});