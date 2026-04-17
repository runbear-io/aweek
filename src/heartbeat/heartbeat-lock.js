/**
 * Heartbeat Lock — file-based locking for heartbeat invocations using
 * the lock-manager's PID-tracked lock infrastructure.
 *
 * Ensures that concurrent or repeated heartbeat invocations for the same
 * agent are serialized and duplicate runs are rejected. Uses PID tracking
 * and orphan detection from lock-manager.js for robust stale lock handling.
 *
 * Differences from scheduler.js's built-in lock:
 * - PID tracking: detects orphaned locks from crashed processes
 * - Orphan detection: auto-recovers from dead-process locks
 * - Invocation metadata: tracks heartbeatId and triggerTime
 * - Composable: works with any async callback, not tied to scheduler internals
 *
 * Usage:
 * ```js
 * const hbLock = createHeartbeatLock({ lockDir: '.aweek/.heartbeat-locks' });
 * const result = await hbLock.run('agent-writer', async (agentId) => {
 *   // ... do heartbeat work
 *   return { outcome: 'task_selected' };
 * });
 * // result.status is 'completed' | 'skipped' | 'error'
 * ```
 *
 * Idempotent: repeated heartbeat invocations while a lock is held return
 * `status: 'skipped'` without side effects.
 *
 * File source of truth: all lock state persisted as JSON files on disk.
 */

import { randomBytes } from 'node:crypto';
import {
  acquireLock,
  releaseLock,
  queryLock,
  breakLock,
  createLockManager,
} from '../lock/lock-manager.js';

/** Default lock directory for heartbeat locks (separate from session locks) */
const DEFAULT_HEARTBEAT_LOCK_DIR = '.aweek/.heartbeat-locks';

/** Default max heartbeat lock age: 90 minutes (heartbeat should complete well within) */
const DEFAULT_MAX_HEARTBEAT_LOCK_AGE_MS = 90 * 60 * 1000;

/**
 * @typedef {object} HeartbeatLockResult
 * @property {'completed'|'skipped'|'error'} status
 * @property {string} agentId
 * @property {string} heartbeatId - Unique ID for this heartbeat invocation
 * @property {*} [result]        - Callback return value (when status === 'completed')
 * @property {string} [reason]   - Why it was skipped or errored
 * @property {object} [existingLock] - Lock data of the blocker (when status === 'skipped')
 * @property {Error} [error]     - Error object (when status === 'error')
 * @property {string} [replacedStatus] - If a stale/orphaned lock was replaced
 * @property {string} startedAt  - ISO timestamp of invocation start
 * @property {string} [completedAt] - ISO timestamp of invocation end
 * @property {number} [durationMs]  - Duration in milliseconds
 */

/**
 * Generate a unique heartbeat invocation ID.
 * @returns {string}
 */
export function generateHeartbeatId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  return `hb-${ts}-${rand}`;
}

/**
 * Run a heartbeat callback for an agent with PID-tracked lock isolation.
 *
 * - Acquires a heartbeat lock (or returns 'skipped' if already locked)
 * - Stale/orphaned locks are automatically replaced (PID + age checks)
 * - Invokes the callback with agentId
 * - Releases the lock on completion (success or error)
 * - Returns structured result describing what happened
 *
 * @param {string} agentId
 * @param {function(string): Promise<*>} callback - Async function receiving agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir] - Lock directory
 * @param {number} [opts.maxLockAgeMs] - Max lock age in ms
 * @param {string} [opts.heartbeatId] - Override the auto-generated heartbeat ID
 * @returns {Promise<HeartbeatLockResult>}
 */
export async function runWithHeartbeatLock(agentId, callback, opts = {}) {
  if (!agentId) throw new Error('agentId is required');
  if (typeof callback !== 'function') throw new Error('callback must be a function');

  const lockDir = opts.lockDir || DEFAULT_HEARTBEAT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_HEARTBEAT_LOCK_AGE_MS;
  const heartbeatId = opts.heartbeatId || generateHeartbeatId();
  const startedAt = new Date().toISOString();

  // Step 1: Attempt to acquire the heartbeat lock (with PID tracking)
  const lockResult = await acquireLock(agentId, {
    lockDir,
    maxLockAgeMs,
    sessionInfo: {
      heartbeatId,
      triggerTime: startedAt,
      type: 'heartbeat',
    },
  });

  if (!lockResult.acquired) {
    return {
      status: 'skipped',
      agentId,
      heartbeatId,
      reason: `Heartbeat already in progress (${lockResult.reason})`,
      existingLock: lockResult.existingLock,
      startedAt,
    };
  }

  // Step 2: Lock acquired — execute the callback
  try {
    const result = await callback(agentId);
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    return {
      status: 'completed',
      agentId,
      heartbeatId,
      result,
      ...(lockResult.replacedStatus ? { replacedStatus: lockResult.replacedStatus } : {}),
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
      heartbeatId,
      error,
      reason: `Heartbeat execution error: ${error.message}`,
      startedAt,
      completedAt,
      durationMs,
    };
  } finally {
    // Step 3: Always release the lock
    await releaseLock(agentId, { lockDir });
  }
}

/**
 * Run heartbeats for multiple agents in parallel, each with independent lock isolation.
 *
 * @param {string[]} agentIds
 * @param {function(string): Promise<*>} callback
 * @param {object} [opts] - Same as runWithHeartbeatLock opts
 * @returns {Promise<Array<HeartbeatLockResult>>}
 */
export async function runAllWithHeartbeatLock(agentIds, callback, opts = {}) {
  if (!Array.isArray(agentIds)) throw new Error('agentIds must be an array');
  if (typeof callback !== 'function') throw new Error('callback must be a function');

  return Promise.all(
    agentIds.map((agentId) => runWithHeartbeatLock(agentId, callback, opts))
  );
}

/**
 * Query the heartbeat lock status for an agent.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @param {number} [opts.maxLockAgeMs]
 * @returns {Promise<{locked: boolean, status: string, lockData?: object}>}
 */
export async function queryHeartbeatLock(agentId, opts = {}) {
  if (!agentId) throw new Error('agentId is required');

  const lockDir = opts.lockDir || DEFAULT_HEARTBEAT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_HEARTBEAT_LOCK_AGE_MS;

  return queryLock(agentId, { lockDir, maxLockAgeMs });
}

/**
 * Force-break a heartbeat lock (for manual intervention / admin cleanup).
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @returns {Promise<{broken: boolean, previousLock?: object}>}
 */
export async function breakHeartbeatLock(agentId, opts = {}) {
  if (!agentId) throw new Error('agentId is required');

  const lockDir = opts.lockDir || DEFAULT_HEARTBEAT_LOCK_DIR;
  return breakLock(agentId, { lockDir });
}

/**
 * Create a HeartbeatLock instance bound to specific configuration.
 *
 * @param {object} [opts]
 * @param {string} [opts.lockDir='.aweek/.heartbeat-locks']
 * @param {number} [opts.maxLockAgeMs=5400000]
 * @returns {object} HeartbeatLock API
 */
export function createHeartbeatLock(opts = {}) {
  const lockDir = opts.lockDir || DEFAULT_HEARTBEAT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_HEARTBEAT_LOCK_AGE_MS;

  return {
    lockDir,
    maxLockAgeMs,

    /**
     * Run a heartbeat callback with lock isolation.
     */
    run: (agentId, callback, extra = {}) =>
      runWithHeartbeatLock(agentId, callback, { lockDir, maxLockAgeMs, ...extra }),

    /**
     * Run heartbeats for multiple agents in parallel.
     */
    runAll: (agentIds, callback, extra = {}) =>
      runAllWithHeartbeatLock(agentIds, callback, { lockDir, maxLockAgeMs, ...extra }),

    /**
     * Query lock status for an agent.
     */
    query: (agentId) =>
      queryHeartbeatLock(agentId, { lockDir, maxLockAgeMs }),

    /**
     * Force-break a lock.
     */
    break: (agentId) =>
      breakHeartbeatLock(agentId, { lockDir }),
  };
}
