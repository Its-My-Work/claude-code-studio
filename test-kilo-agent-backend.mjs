const KiloAgentBackend = (await import('./backends/kilo-agent-backend.mjs')).default;

async function main() {
  const backend = new KiloAgentBackend({
    serverUrl: process.env.KILO_SERVER_URL || 'http://127.0.0.1:4098',
    directory: process.cwd(),
    debug: true,
    timeout: 60000,
  });

  const result = backend.send({
    prompt: 'Hello, can you help me with a simple task?',
    model: 'kilo/kilo-auto/free',
    mode: 'orchestrator',
    maxTurns: 10,
  });

  result
    .onSessionId((id) => console.log('SESSION ID:', id))
    .onStepStart((s) => console.log('STEP START:', s))
    .onStepFinish((s) => console.log('STEP FINISH:', s))
    .onReasoning((r) => console.log('REASONING:', r))
    .onText((t) => process.stdout.write(t))
    .onResult((r) => console.log('\nRESULT META:', r))
    .onError((e) => console.error('\nERROR:', e))
    .onDone((sid) => {
      console.log('\nDONE, SESSION:', sid);
      process.exit(0);
    });

  // Add a manual timeout
  setTimeout(() => {
    console.log('\nTIMEOUT: No events received');
    process.exit(1);
  }, 10000);
}

main().catch((e) => {
  console.error('FATAL ERROR:', e);
  process.exit(1);
});