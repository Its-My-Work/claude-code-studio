/**
 * Kilo Manager - Manages per-project kilo serve processes
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const getPort = require('get-port').default || require('get-port');

/**
 * @typedef {string} ProjectId
 */

/**
 * @typedef {Object} ProjectConfig
 * @property {ProjectId} id - Unique project identifier
 * @property {string} name - Project name
 * @property {string} rootDir - Absolute path to project root (workdir)
 * @property {string} createdAt - ISO string timestamp
 */

/**
 * @typedef {Object} KiloInstance
 * @property {ProjectId} projectId
 * @property {number} port
 * @property {string} cwd
 * @property {import('child_process').ChildProcess} process
 * @property {Date} startedAt
 */

/**
 * Map of projectId -> KiloInstance
 * @type {Map<ProjectId, KiloInstance>}
 */
const kiloInstances = new Map();

/**
 * Configuration constants
 */
const CONFIG = {
  PORT_RANGE_START: Number(process.env.KILO_PORT_RANGE_START || 4100),
  PORT_RANGE_END: Number(process.env.KILO_PORT_RANGE_END || 4199),
  BINARY: process.env.KILO_BINARY || 'kilo',
  STOP_GRACE_MS: Number(process.env.KILO_STOP_GRACE_MS || 5000),
  HEALTHCHECK_TIMEOUT_MS: Number(process.env.KILO_HEALTHCHECK_TIMEOUT_MS || 1500),
  HEALTHCHECK_PATH: process.env.KILO_HEALTHCHECK_PATH || '/status'
};

/**
 * Persistent storage file path
 */
const KILO_PORTS_FILE = path.join(
  process.env.APP_DIR || require('os').homedir(),
  '.config',
  'claude-code-studio',
  'kilo_ports.json'
);

/**
 * Load persistent port mappings
 * @returns {Object.<ProjectId, number>} projectId -> port mapping
 */
function loadPersistentPorts() {
  try {
    if (fs.existsSync(KILO_PORTS_FILE)) {
      return JSON.parse(fs.readFileSync(KILO_PORTS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to load persistent ports:', err.message);
  }
  return {};
}

/**
 * Save persistent port mappings
 * @param {Object.<ProjectId, number>} ports - projectId -> port mapping
 */
function savePersistentPorts(ports) {
  try {
    const dir = path.dirname(KILO_PORTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(KILO_PORTS_FILE, JSON.stringify(ports, null, 2));
  } catch (err) {
    console.error('Failed to save persistent ports:', err.message);
  }
}

/**
 * Check if a process is alive
 * @param {number} pid - Process ID
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Allocate a free port in the configured range
 * @returns {Promise<number>}
 * @throws {Error} if no free port available
 */
async function allocatePort() {
  const start = CONFIG.PORT_RANGE_START;
  const end = CONFIG.PORT_RANGE_END;

  for (let port = start; port <= end; port++) {
    try {
      const availablePort = await getPort({ port });
      if (availablePort === port) {
        return port;
      }
    } catch (err) {
      // Continue to next port
    }
  }
  throw new Error(`No free port in range ${start}-${end} for Kilo`);
}

/**
 * Health check a kilo instance
 * @param {KiloInstance} instance
 * @returns {Promise<boolean>}
 */
async function healthCheckKilo(instance) {
  try {
    execSync(`curl -sS --max-time 1 http://127.0.0.1:${instance.port} > /dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a kilo serve process is running for the given project
 * @param {ProjectConfig} project
 * @returns {Promise<KiloInstance>}
 */
async function ensureKiloForProject(project) {
  // Check if instance already exists and is healthy
  const existing = kiloInstances.get(project.id);
  if (existing && !existing.process.killed && isProcessAlive(existing.process.pid)) {
    // Optional: do health check
    if (await healthCheckKilo(existing)) {
      return existing;
    }
    // If health check fails, clean up and restart
    await stopKiloForProject(project.id);
  }

  // Allocate port
  const port = await allocatePort();

  // Start new process
  const child = spawn(CONFIG.BINARY, ['serve', '--port', String(port)], {
    cwd: project.rootDir,
    env: {
      ...process.env,
      // Can add PROJECT_ROOT: project.rootDir if needed
    },
    stdio: 'inherit' // or pipe to logs
  });

  const instance = {
    projectId: project.id,
    port,
    cwd: project.rootDir,
    process: child,
    startedAt: new Date()
  };

  // Set up event handlers
  child.on('exit', (code, signal) => {
    console.log(`Kilo process for project ${project.id} exited with code ${code}, signal ${signal}`);
    // Remove from instances if pid matches
    const current = kiloInstances.get(project.id);
    if (current && current.process.pid === child.pid) {
      kiloInstances.delete(project.id);
      // Update persistent storage
      const ports = loadPersistentPorts();
      delete ports[project.id];
      savePersistentPorts(ports);
    }
  });

  child.on('error', (err) => {
    console.error(`Kilo process for project ${project.id} failed to start:`, err.message);
  });

  // Wait for kilo to be ready
  for (let i = 0; i < 30; i++) {
    if (await healthCheckKilo(instance)) {
      // Add to instances
      kiloInstances.set(project.id, instance);

      // Save to persistent storage
      const ports = loadPersistentPorts();
      ports[project.id] = port;
      savePersistentPorts(ports);

      return instance;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // If not ready, kill process and throw error
  instance.process.kill();
  throw new Error(`Kilo serve for project ${project.id} did not start within 10 seconds`);
}

/**
 * Stop kilo serve process for the given project
 * @param {ProjectId} projectId
 * @returns {Promise<void>}
 */
async function stopKiloForProject(projectId) {
  const instance = kiloInstances.get(projectId);
  if (!instance) return;

  if (instance.process.killed) {
    kiloInstances.delete(projectId);
    const ports = loadPersistentPorts();
    delete ports[projectId];
    savePersistentPorts(ports);
    return;
  }

  // Send SIGTERM
  instance.process.kill('SIGTERM');

  // Wait for graceful shutdown with timeout
  const timeout = setTimeout(() => {
    if (!instance.process.killed) {
      console.warn(`Kilo process for project ${projectId} did not exit gracefully, sending SIGKILL`);
      instance.process.kill('SIGKILL');
    }
  }, CONFIG.STOP_GRACE_MS);

  // Wait for exit event (handled above)
  await new Promise(resolve => {
    instance.process.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Get the kilo base URL for a project
 * @param {ProjectId} projectId
 * @returns {string|null}
 */
function getKiloUrlForProject(projectId) {
  const instance = kiloInstances.get(projectId);
  if (instance && !instance.process.killed && isProcessAlive(instance.process.pid)) {
    return `http://127.0.0.1:${instance.port}`;
  }
  return null;
}

/**
 * Restore kilo instances from persistent storage on startup
 * @param {Array<ProjectConfig>} projects
 */
async function restoreKiloInstances(projects) {
  const ports = loadPersistentPorts();
  const projectMap = new Map(projects.map(p => [p.id, p]));

  for (const [projectId, port] of Object.entries(ports)) {
    const project = projectMap.get(projectId);
    if (!project) continue; // Project no longer exists

    // Create instance object (process will be checked via health check)
    const instance = {
      projectId,
      port,
      cwd: project.rootDir,
      process: { killed: true, pid: -1 }, // Dummy process, will be checked
      startedAt: new Date() // Approximate
    };

    // Health check the port
    if (await healthCheckKilo(instance)) {
      // Port is active, create real process object
      // Note: we don't have the actual child process object, but we can assume it's alive
      instance.process = { killed: false, pid: 99999 }; // Dummy pid, but mark as alive
      kiloInstances.set(projectId, instance);
      console.log(`Restored kilo instance for project ${projectId} on port ${port}`);
    } else {
      // Port not responding, remove from persistent storage
      console.log(`Port ${port} for project ${projectId} not responding, removing from persistent storage`);
      const updatedPorts = loadPersistentPorts();
      delete updatedPorts[projectId];
      savePersistentPorts(updatedPorts);
    }
  }
}

/**
 * Stop all kilo instances (for shutdown)
 * @returns {Promise<void>}
 */
async function stopAllKiloInstances() {
  const promises = Array.from(kiloInstances.keys()).map(projectId => stopKiloForProject(projectId));
  await Promise.all(promises);
}

module.exports = {
  CONFIG,
  ensureKiloForProject,
  stopKiloForProject,
  getKiloUrlForProject,
  healthCheckKilo,
  restoreKiloInstances,
  stopAllKiloInstances
};