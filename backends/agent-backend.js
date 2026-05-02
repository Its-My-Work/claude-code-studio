export default class AgentBackend {
  send(options) {
    throw new Error('send() must be implemented by subclass');
  }

  async getStatus() {
    throw new Error('getStatus() must be implemented by subclass');
  }

  async setMode(mode) {
    throw new Error('setMode() must be implemented by subclass');
  }

  async setModel(model) {
    throw new Error('setModel() must be implemented by subclass');
  }

  async manageSession(sessionId, action) {
    throw new Error('manageSession() must be implemented by subclass');
  }
}