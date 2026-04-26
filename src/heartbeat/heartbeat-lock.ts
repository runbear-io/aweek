/**
 * Heartbeat Lock — file-based locking for heartbeat invocations using
 * the lock-manager's PID-tracked lock infrastructure.
 *
 * Ensures that concurrent or repeated heartbeat invocations for the same
 * agent are serialized and duplicate runs are rejected. Uses PID tracking
 * and orphan detection from lock-manager.ts for robust stale lock handling.
 *
 * Differences from scheduler.ts's built-in lock:
 * - PID tracking: detects orphaned locks from crashed processes
 * - Orphan detection: auto-recovers from dead-process locks
 * - Invocation metadata: tracks heartbeatId and triggerTime
 * - Composable: works with any async callback, not tied to scheduler internals
 *
 * Usage:
 * ```ts
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
} from '../lock/lock-manager.js';
import type {
  BreakLockResult,
  LockData,
  QueryLockResult,
} from '../lock/lock-manager.js';

/** Default lock directory for heartbeat locks (separate from session locks) */
const DEFAULT_HEARTBEAT_LOCK_DIR = '.aweek/.heartbeat-locks';

/** Default max heartbeat lock age: 90 minutes (heartbeat should complete well within) */
const DEFAULT_MAX_HEARTBEAT_LOCK_AGE_MS = 90 * 60 * 1000;

/** Status of a heartbeat invocation. */
export type HeartbeatLockStatus = 'completed' | 'skipped' | 'error';

/** Common options shared across heartbeat-lock helpers. */
export interface HeartbeatLockOptions {
  lockDir?: string;
  maxLockAgeMs?: number;
  heartbeatId?: string;
}

/** Result returned by {@link runWithHeartbeatLock}. */
export interface HeartbeatLockResult<T = unknown> {
  status: HeartbeatLockStatus;
  agentId: string;
  /** Unique ID for this heartbeat invocation */
  heartbeatId: string;
  /** Callback return value (when status === 'completed') */
  result?: T;
  /** Why it was skipped or errored */
  reason?: string;
  /** Lock data of the blocker (when status === 'skipped') */
  existingLock?: LockData;
  /** Error object (when status === 'error') */
  error?: Error;
  /** If a stale/orphaned lock was replaced */
  replacedStatus?: string;
  /** ISO timestamp of invocation start */
  startedAt: string;
  /** ISO timestamp of invocation end */
  completedAt?: string;
  /** Duration in milliseconds */
  durationMs?: number;
}

/** Async callback that performs the heartbeat work for a given agent. */
export type HeartbeatCallback<T = unknown> = (agentId: string) => Promise<T>;

/** Bound HeartbeatLock API returned by {@link createHeartbeatLock}. */
export interface HeartbeatLock {
  lockDir: string;
  maxLockAgeMs: number;
  run: <T>(
    agentId: string,
    callback: HeartbeatCallback<T>,
    extra?: HeartbeatLockOptions,
  ) => Promise<HeartbeatLockResult<T>>;
  runAll: <T>(
    agentIds: string[],
    callback: HeartbeatCallback<T>,
    extra?: HeartbeatLockOptions,
  ) => Promise<HeartbeatLockResult<T>[]>;
  query: (agentId: string) => Promise<QueryLockResult>;
  break: (agentId: string) => Promise<BreakLockResult>;
}

/**
 * Generate a unique heartbeat invocation ID.
 */
export function generateHeartbeatId(): string {
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
 */
export async function runWithHeartbeatLock<T = unknown>(
  agentId: string,
  callback: HeartbeatCallback<T>,
  opts: HeartbeatLockOptions = {},
): Promise<HeartbeatLockResult<T>> {
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
    const skipped: HeartbeatLockResult<T> = {
      status: 'skipped',
      agentId,
      heartbeatId,
      reason: `Heartbeat already in progress (${lockResult.reason})`,
      startedAt,
    };
    if (lockResult.existingLock) skipped.existingLock = lockResult.existingLock;
    return skipped;
  }

  // Step 2: Lock acquired — execute the callback
  try {
    const result = await callback(agentId);
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    const ok: HeartbeatLockResult<T> = {
      status: 'completed',
      agentId,
      heartbeatId,
      result,
      startedAt,
      completedAt,
      durationMs,
    };
    if (lockResult.replacedStatus) ok.replacedStatus = lockResult.replacedStatus;
    return ok;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
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
 */
export async function runAllWithHeartbeatLock<T = unknown>(
  agentIds: string[],
  callback: HeartbeatCallback<T>,
  opts: HeartbeatLockOptions = {},
): Promise<HeartbeatLockResult<T>[]> {
  if (!Array.isArray(agentIds)) throw new Error('agentIds must be an array');
  if (typeof callback !== 'function') throw new Error('callback must be a function');

  return Promise.all(
    agentIds.map((agentId) => runWithHeartbeatLock(agentId, callback, opts)),
  );
}

/**
 * Query the heartbeat lock status for an agent.
 */
export async function queryHeartbeatLock(
  agentId: string,
  opts: HeartbeatLockOptions = {},
): Promise<QueryLockResult> {
  if (!agentId) throw new Error('agentId is required');

  const lockDir = opts.lockDir || DEFAULT_HEARTBEAT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_HEARTBEAT_LOCK_AGE_MS;

  return queryLock(agentId, { lockDir, maxLockAgeMs });
}

/**
 * Force-break a heartbeat lock (for manual intervention / admin cleanup).
 */
export async function breakHeartbeatLock(
  agentId: string,
  opts: HeartbeatLockOptions = {},
): Promise<BreakLockResult> {
  if (!agentId) throw new Error('agentId is required');

  const lockDir = opts.lockDir || DEFAULT_HEARTBEAT_LOCK_DIR;
  return breakLock(agentId, { lockDir });
}

/**
 * Create a HeartbeatLock instance bound to specific configuration.
 */
export function createHeartbeatLock(opts: HeartbeatLockOptions = {}): HeartbeatLock {
  const lockDir = opts.lockDir || DEFAULT_HEARTBEAT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_HEARTBEAT_LOCK_AGE_MS;

  return {
    lockDir,
    maxLockAgeMs,

    run: <T>(agentId: string, callback: HeartbeatCallback<T>, extra: HeartbeatLockOptions = {}) =>
      runWithHeartbeatLock<T>(agentId, callback, { lockDir, maxLockAgeMs, ...extra }),

    runAll: <T>(agentIds: string[], callback: HeartbeatCallback<T>, extra: HeartbeatLockOptions = {}) =>
      runAllWithHeartbeatLock<T>(agentIds, callback, { lockDir, maxLockAgeMs, ...extra }),

    query: (agentId: string) =>
      queryHeartbeatLock(agentId, { lockDir, maxLockAgeMs }),

    break: (agentId: string) =>
      breakHeartbeatLock(agentId, { lockDir }),
  };
}
