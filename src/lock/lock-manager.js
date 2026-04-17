/**
 * Lock manager — file-based locks with PID tracking and stale lock detection.
 *
 * Provides execution isolation for agent sessions:
 * - Only one session runs per agent at a time
 * - PID tracking detects orphaned locks from crashed processes
 * - Stale lock detection based on configurable max age
 * - Idempotent: repeated acquire while held is a no-op
 * - All state persisted as JSON files (source of truth on disk)
 *
 * Lock file format:
 * {
 *   agentId: string,
 *   pid: number,
 *   createdAt: ISO string,
 *   staleAfter: ISO string,
 *   sessionInfo?: object   // optional metadata from caller
 * }
 */
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Default lock directory */
const DEFAULT_LOCK_DIR = 'data/.locks';

/** Default max lock age in ms (2 hours — generous for long-running CLI sessions) */
const DEFAULT_MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Check whether a process with the given PID is currently running.
 *
 * Uses `process.kill(pid, 0)` which sends signal 0 (no actual signal)
 * to test for process existence without affecting it.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process, EPERM = process exists but we lack permission (still alive)
    if (err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Get the lock file path for an agent.
 *
 * @param {string} agentId
 * @param {string} [lockDir]
 * @returns {string}
 */
export function lockPathFor(agentId, lockDir = DEFAULT_LOCK_DIR) {
  if (!agentId) throw new Error('agentId is required');
  return join(lockDir, `${agentId}.lock`);
}

/**
 * Read and parse a lock file, or return null if it doesn't exist.
 *
 * @param {string} lockPath
 * @returns {Promise<object|null>}
 */
export async function readLockFile(lockPath) {
  try {
    const raw = await readFile(lockPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // Corrupt lock file — treat as absent
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Check if a lock is stale based on its createdAt timestamp.
 *
 * A lock is stale if:
 * - lockData is null/missing createdAt
 * - Age exceeds maxAgeMs
 *
 * @param {object} lockData - Parsed lock file contents
 * @param {number} maxAgeMs - Maximum allowed age in ms
 * @returns {boolean}
 */
export function isLockStale(lockData, maxAgeMs) {
  if (!lockData || !lockData.createdAt) return true;
  const age = Date.now() - new Date(lockData.createdAt).getTime();
  return age > maxAgeMs;
}

/**
 * Check if a lock is orphaned — the owning process is no longer running.
 *
 * @param {object} lockData - Parsed lock file contents
 * @returns {boolean}
 */
export function isLockOrphaned(lockData) {
  if (!lockData || typeof lockData.pid !== 'number') return true;
  return !isPidAlive(lockData.pid);
}

/**
 * Determine the effective status of a lock.
 *
 * Returns one of:
 * - 'active'   — Lock exists, PID is alive, not stale
 * - 'stale'    — Lock exists but exceeded max age
 * - 'orphaned' — Lock exists but owning PID is dead
 * - 'absent'   — No lock file
 *
 * @param {object|null} lockData
 * @param {number} maxAgeMs
 * @returns {'active'|'stale'|'orphaned'|'absent'}
 */
export function lockStatus(lockData, maxAgeMs) {
  if (!lockData) return 'absent';
  if (isLockStale(lockData, maxAgeMs)) return 'stale';
  if (isLockOrphaned(lockData)) return 'orphaned';
  return 'active';
}

/**
 * Attempt to acquire a lock for an agent session.
 *
 * Idempotent: stale and orphaned locks are automatically replaced.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @param {number} [opts.maxLockAgeMs]
 * @param {object} [opts.sessionInfo] - Optional metadata to store in lock
 * @returns {Promise<{acquired: boolean, lockData?: object, reason?: string, existingLock?: object, replacedStatus?: string}>}
 */
export async function acquireLock(agentId, opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  if (!agentId) throw new Error('agentId is required');

  await mkdir(lockDir, { recursive: true });
  const lockPath = lockPathFor(agentId, lockDir);

  // Check for existing lock
  const existing = await readLockFile(lockPath);
  const status = lockStatus(existing, maxLockAgeMs);

  if (status === 'active') {
    return {
      acquired: false,
      reason: 'already_locked',
      existingLock: existing,
    };
  }

  // Create new lock (absent, stale, or orphaned — safe to acquire)
  const lockData = {
    agentId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    staleAfter: new Date(Date.now() + maxLockAgeMs).toISOString(),
  };

  if (opts.sessionInfo) {
    lockData.sessionInfo = opts.sessionInfo;
  }

  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + '\n', 'utf-8');

  const result = { acquired: true, lockData };
  if (existing && status !== 'absent') {
    result.replacedStatus = status;
  }
  return result;
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
    if (err.code === 'ENOENT') return { released: true };
    throw err;
  }
}

/**
 * Query the lock state for an agent.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @param {number} [opts.maxLockAgeMs]
 * @returns {Promise<{locked: boolean, status: 'active'|'stale'|'orphaned'|'absent', lockData?: object}>}
 */
export async function queryLock(agentId, opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  if (!agentId) throw new Error('agentId is required');

  const lockPath = lockPathFor(agentId, lockDir);
  const lockData = await readLockFile(lockPath);
  const status = lockStatus(lockData, maxLockAgeMs);

  return {
    locked: status === 'active',
    status,
    ...(lockData ? { lockData } : {}),
  };
}

/**
 * Force-break a lock regardless of status.
 * Useful for manual intervention / admin cleanup.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @returns {Promise<{broken: boolean, previousLock?: object}>}
 */
export async function breakLock(agentId, opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  if (!agentId) throw new Error('agentId is required');

  const lockPath = lockPathFor(agentId, lockDir);
  const previousLock = await readLockFile(lockPath);

  await rm(lockPath, { force: true });

  return {
    broken: true,
    ...(previousLock ? { previousLock } : {}),
  };
}

/**
 * Create a LockManager instance bound to a specific configuration.
 *
 * @param {object} [opts]
 * @param {string} [opts.lockDir='data/.locks']
 * @param {number} [opts.maxLockAgeMs=7200000]
 * @returns {object} LockManager API
 */
export function createLockManager(opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  return {
    lockDir,
    maxLockAgeMs,
    lockPathFor: (agentId) => lockPathFor(agentId, lockDir),
    acquire: (agentId, extra = {}) =>
      acquireLock(agentId, { lockDir, maxLockAgeMs, ...extra }),
    release: (agentId) => releaseLock(agentId, { lockDir }),
    query: (agentId) => queryLock(agentId, { lockDir, maxLockAgeMs }),
    break: (agentId) => breakLock(agentId, { lockDir }),
  };
}
