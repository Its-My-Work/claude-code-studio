#!/usr/bin/env node

// Test script for KiloAgentBackend in prompt mode (default behavior)
const BackendFactory = require('./backends/backend-factory');

async function testPromptMode() {
  console.log('Testing KiloAgentBackend in prompt mode...');

  const backend = await BackendFactory.createBackend('kilo-agent', {
    streamMode: 'prompt',
    debug: true,
  });

  const abortController = new AbortController();

  const result = backend.send({
    prompt: 'Say hello world and explain what you are.',
    model: 'kilo/kilo-auto/free',
    abortController,
  });

  let sessionId = null;
  let textChunks = [];
  let reasoningChunks = [];
  let tools = [];
  let stepStarts = [];
  let stepFinishes = [];
  let resultData = null;

  result
    .onText((text) => {
      console.log('[onText]', text);
      textChunks.push(text);
    })
    .onReasoning((reasoning) => {
      console.log('[onReasoning]', reasoning);
      reasoningChunks.push(reasoning);
    })
    .onTool((tool, input) => {
      console.log('[onTool]', tool, input);
      tools.push({ tool, input });
    })
    .onStepStart((data) => {
      console.log('[onStepStart]', data);
      stepStarts.push(data);
    })
    .onStepFinish((data) => {
      console.log('[onStepFinish]', data);
      stepFinishes.push(data);
    })
    .onSessionId((id) => {
      console.log('[onSessionId]', id);
      sessionId = id;
    })
    .onResult((data) => {
      console.log('[onResult]', data);
      resultData = data;
    })
    .onDone((id) => {
      console.log('[onDone]', id);
      console.log('\n=== PROMPT MODE TEST RESULTS ===');
      console.log('Session ID:', sessionId);
      console.log('Text chunks:', textChunks.length, 'total length:', textChunks.join('').length);
      console.log('Reasoning chunks:', reasoningChunks.length);
      console.log('Tools called:', tools.length);
      console.log('Step starts:', stepStarts.length);
      console.log('Step finishes:', stepFinishes.length);
      console.log('Result data:', resultData);
      console.log('Full text preview:', textChunks.join('').substring(0, 200) + '...');
      process.exit(0);
    })
    .onError((error) => {
      console.error('[onError]', error);
      process.exit(1);
    });

  // Timeout after 2 minutes
  setTimeout(() => {
    console.error('Test timed out');
    abortController.abort();
    process.exit(1);
  }, 120000);
}

testPromptMode().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});