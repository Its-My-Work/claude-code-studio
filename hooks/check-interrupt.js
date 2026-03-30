#!/usr/bin/env node
// PreToolUse hook: checks for pending user clarifications sent mid-task.
// Only active in CCS subprocess context (requires CCS_INTERRUPT_* env vars).
// When pending messages exist, blocks the current tool call and delivers the
// message to Claude as the block reason. Messages are consumed (one-shot delivery).

const url = process.env.CCS_INTERRUPT_URL;
const sessionId = process.env.CCS_INTERRUPT_SESSION;
const secret = process.env.CCS_INTERRUPT_SECRET;

function approve() {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// Not a CCS subprocess — approve immediately (noop for user's own sessions)
if (!url || !sessionId || !secret) approve();

const http = require('http');

const body = JSON.stringify({ sessionId });
const parsed = new URL(url + '/api/internal/user-interrupt');

const req = http.request({
  hostname: parsed.hostname,
  port: parsed.port || 80,
  path: parsed.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Authorization': `Bearer ${secret}`,
  },
  timeout: 2000,
}, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      const messages = result.messages || [];
      if (messages.length === 0) return approve();

      const content = messages.map(m => m.content).join('\n\n');
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `USER CLARIFICATION (sent while you were working):\n\n${content}\n\nAcknowledge this, adjust your approach if needed, then continue.`,
      }));
      process.exit(0);
    } catch {
      approve();
    }
  });
});

req.on('error', () => approve());
req.on('timeout', () => { req.destroy(); approve(); });
req.write(body);
req.end();
