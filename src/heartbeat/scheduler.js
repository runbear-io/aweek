/**
 * Heartbeat scheduler — runtime module that executes agent heartbeat callbacks.
 *
 * Responsibilities:
 * - Lock-based execution isolation: only one heartbeat runs per agent at a time
 * - Idempotent: repeated triggers while a lock is held are no-ops
 * - Stale lock detection: locks older than maxLockAge are considered abandoned
 * - Configurable callback invocation per agent
 * - File-based lock state (source of truth on disk)
 *
 * The project-level heartbeat installer in `src/skills/init.js` handles
 * *scheduling* (installing/removing the single project cron entry). This
 * module handles *execution* (what happens when a heartbeat fires).
 */
import { writeFile, readFile, rm, mkdir, access, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Default lock directory */
const DEFAULT_LOCK_DIR = '.aweek/.locks';

/** Default max lock age in ms (2 hours — generous for long-running sessions) */
const DEFAULT_MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Create a heartbeat scheduler instance.
 *
 * @param {object} opts
 * @param {string} [opts.lockDir='.aweek/.locks'] - Directory for lock files
 * @param {number} [opts.maxLockAgeMs=7200000] - Max age (ms) before a lock is stale
 * @returns {object} Scheduler API
 */
export function createScheduler(opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  return {
    lockDir,
    maxLockAgeMs,
    lockPathFor: (agentId) => lockPathFor(agentId, lockDir),
    acquireLock: (agentId) => acquireLock(agentId, { lockDir, maxLockAgeMs }),
    releaseLock: (agentId) => releaseLock(agentId, { lockDir }),
    isLocked: (agentId) => isLocked(agentId, { lockDir, maxLockAgeMs }),
    runHeartbeat: (agentId, callback) =>
      runHeartbeat(agentId, callback, { lockDir, maxLockAgeMs }),
  };
}

/**
 * Get the lock file path for an agent.
 * @param {string} agentId
 * @param {string} lockDir
 * @returns {string}
 */
export function lockPathFor(agentId, lockDir = DEFAULT_LOCK_DIR) {
  if (!agentId) throw new Error('agentId is required');
  return join(lockDir, `${agentId}.lock`);
}

/**
 * Read lock file contents, or null if it doesn't exist.
 * @param {string} lockPath
 * @returns {Promise<object|null>}
 */
async function readLockFile(lockPath) {
  try {
    const raw = await readFile(lockPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Check if a lock is stale based on its createdAt timestamp.
 * @param {object} lockData - Parsed lock file contents
 * @param {number} maxAgeMs - Maximum allowed age
 * @returns {boolean}
 */
export function isLockStale(lockData, maxAgeMs) {
  if (!lockData || !lockData.createdAt) return true;
  const age = Date.now() - new Date(lockData.createdAt).getTime();
  return age > maxAgeMs;
}

/**
 * Attempt to acquire a lock for an agent.
 * Returns { acquired: true, lockData } on success,
 * or { acquired: false, reason, existingLock } if already locked.
 *
 * Idempotent: if a stale lock exists, it's replaced.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @param {number} [opts.maxLockAgeMs]
 * @returns {Promise<{acquired: boolean, lockData?: object, reason?: string, existingLock?: object}>}
 */
export async function acquireLock(agentId, opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  if (!agentId) throw new Error('agentId is required');

  await mkdir(lockDir, { recursive: true });
  const lockPath = lockPathFor(agentId, lockDir);

  // Check for existing lock
  const existing = await readLockFile(lockPath);

  if (existing && !isLockStale(existing, maxLockAgeMs)) {
    return {
      acquired: false,
      reason: 'already_locked',
      existingLock: existing,
    };
  }

  // Create lock (stale lock or no lock — safe to acquire)
  const lockData = {
    agentId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    staleAfter: new Date(Date.now() + maxLockAgeMs).toISOString(),
  };

  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + '\n', 'utf-8');
  return { acquired: true, lockData };
}

/**
 * Release the lock for an agent.
 * Idempotent: no error if lock doesn't exist.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @returns {Promise<{released: boolean}>}
 */
export async function releaseLock(agentId, opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  if (!agentId) throw new Error('agentId is required');

  const lockPath = lockPathFor(agentId, lockDir);
  try {
    await rm(lockPath, { force: true });
    return { released: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { released: false };
    throw err;
  }
}

/**
 * Check if an agent is currently locked (active heartbeat in progress).
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @param {number} [opts.maxLockAgeMs]
 * @returns {Promise<{locked: boolean, lockData?: object, stale?: boolean}>}
 */
export async function isLocked(agentId, opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  const lockPath = lockPathFor(agentId, lockDir);
  const lockData = await readLockFile(lockPath);

  if (!lockData) return { locked: false };

  const stale = isLockStale(lockData, maxLockAgeMs);
  if (stale) return { locked: false, lockData, stale: true };

  return { locked: true, lockData, stale: false };
}

/**
 * Run a heartbeat for an agent with lock-based isolation.
 *
 * This is the main entry point invoked by cron triggers.
 * - Acquires a lock (or skips if already locked)
 * - Invokes the callback
 * - Releases the lock on completion (success or error)
 * - Returns a result object describing what happened
 *
 * Idempotent: if the agent is already executing, returns skipped status.
 *
 * @param {string} agentId
 * @param {function(string): Promise<*>} callback - Async function receiving agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @param {number} [opts.maxLockAgeMs]
 * @returns {Promise<{status: 'completed'|'skipped'|'error', agentId: string, result?: *, error?: Error, lockData?: object, startedAt?: string, completedAt?: string, durationMs?: number}>}
 */
export async function runHeartbeat(agentId, callback, opts = {}) {
  if (!agentId) throw new Error('agentId is required');
  if (typeof callback !== 'function') throw new Error('callback must be a function');

  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  // Attempt to acquire lock
  const lockResult = await acquireLock(agentId, { lockDir, maxLockAgeMs });

  if (!lockResult.acquired) {
    return {
      status: 'skipped',
      agentId,
      reason: lockResult.reason,
      existingLock: lockResult.existingLock,
    };
  }

  const startedAt = new Date().toISOString();

  try {
    const result = await callback(agentId);
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    return {
      status: 'completed',
      agentId,
      result,
      lockData: lockResult.lockData,
      startedAt,
      completedAt,
      durationMs,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    return {
      status: 'error',
      agentId,
      error,
      lockData: lockResult.lockData,
      startedAt,
      completedAt,
      durationMs,
    };
  } finally {
    // Always release the lock
    await releaseLock(agentId, { lockDir });
  }
}

/**
 * Run heartbeats for multiple agents in parallel.
 * Each agent runs independently with its own lock.
 *
 * @param {string[]} agentIds
 * @param {function(string): Promise<*>} callback
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @param {number} [opts.maxLockAgeMs]
 * @returns {Promise<Array<{status: string, agentId: string, ...}>>}
 */
export async function runHeartbeatAll(agentIds, callback, opts = {}) {
  if (!Array.isArray(agentIds)) throw new Error('agentIds must be an array');
  if (typeof callback !== 'function') throw new Error('callback must be a function');

  return Promise.all(
    agentIds.map((agentId) => runHeartbeat(agentId, callback, opts))
  );
}
