// Environment for a test server whose runs must go HEADLESS (the fake `claude` on PATH).
//
// The engine follows the model's provider (server.js runEngineFor): on an install with no
// gateway the default provider is the CLI login, whose models run on the tmux Subscription
// engine whenever tmux exists — which it does in CI. A suite that drives chats or tasks
// through a fake headless `claude` would then silently run somewhere else, and only on
// machines that have tmux and no ANTHROPIC_BASE_URL of their own. Seeding an API gateway as
// the default provider pins the engine for everyone. The address is never contacted: the
// fake CLI ignores it.
module.exports = {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  ANTHROPIC_AUTH_TOKEN: 'test-gateway-token',
};
