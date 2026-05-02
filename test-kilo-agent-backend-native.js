const KiloAgentBackend = require('./backends/kilo-agent-backend.mjs').default;

async function main() {
  const backend = new KiloAgentBackend({
    serverUrl: process.env.KILO_SERVER_URL || 'http://127.0.0.1:4098',
    directory: process.cwd(),
    debug: true,
    timeout: 60000,
    streamMode: 'native',
  });

  const result = backend.send({
    prompt: 'Hello, can you help me with a simple task? Please give me a detailed response.',
    model: 'kilo/kilo-auto/free',
    maxTurns: 10,
  });

  result
    .onSessionId((id) => console.log('SESSION ID:', id))
    .onStepStart((s) => console.log('STEP START:', JSON.stringify(s)))
    .onStepFinish((s) => console.log('STEP FINISH:', JSON.stringify(s)))
    .onReasoning((r) => console.log('REASONING:', r))
    .onText((t) => process.stdout.write(t))
    .onResult((r) => console.log('\nRESULT META:', JSON.stringify(r)))
    .onError((e) => console.error('\nERROR:', e))
    .onDone((sid) => {
      console.log('\nDONE, SESSION:', sid);
      process.exit(0);
    });
}

main().catch((e) => {
  console.error('FATAL ERROR:', e);
  process.exit(1);
});