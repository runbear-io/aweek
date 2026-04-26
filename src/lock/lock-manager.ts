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
const DEFAULT_LOCK_DIR = '.aweek/.locks';

/** Default max lock age in ms (2 hours — generous for long-running CLI sessions) */
const DEFAULT_MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000;

/** Free-form session metadata persisted alongside the lock. */
export type LockSessionInfo = Record<string, unknown>;

/** Parsed contents of a lock file on disk. */
export interface LockData {
  agentId: string;
  pid: number;
  createdAt: string;
  staleAfter: string;
  sessionInfo?: LockSessionInfo;
}

/** Effective state of a lock file (or its absence). */
export type LockStatus = 'active' | 'stale' | 'orphaned' | 'absent';

/** Common lock-directory + age options shared by every lock function. */
export interface LockDirOptions {
  lockDir?: string;
  maxLockAgeMs?: number;
}

/** Acquire-time options layer in optional `sessionInfo`. */
export interface AcquireLockOptions extends LockDirOptions {
  sessionInfo?: LockSessionInfo;
}

/** Result of an `acquireLock` call. */
export interface AcquireLockResult {
  acquired: boolean;
  lockData?: LockData;
  reason?: string;
  existingLock?: LockData;
  replacedStatus?: Exclude<LockStatus, 'active' | 'absent'>;
}

/** Result of a `releaseLock` call. */
export interface ReleaseLockResult {
  released: boolean;
}

/** Result of a `queryLock` call. */
export interface QueryLockResult {
  locked: boolean;
  status: LockStatus;
  lockData?: LockData;
}

/** Result of a `breakLock` call. */
export interface BreakLockResult {
  broken: boolean;
  previousLock?: LockData;
}

/** Bound LockManager API returned by {@link createLockManager}. */
export interface LockManager {
  lockDir: string;
  maxLockAgeMs: number;
  lockPathFor: (agentId: string) => string;
  acquire: (
    agentId: string,
    extra?: { sessionInfo?: LockSessionInfo },
  ) => Promise<AcquireLockResult>;
  release: (agentId: string) => Promise<ReleaseLockResult>;
  query: (agentId: string) => Promise<QueryLockResult>;
  break: (agentId: string) => Promise<BreakLockResult>;
}

/**
 * Check whether a process with the given PID is currently running.
 *
 * Uses `process.kill(pid, 0)` which sends signal 0 (no actual signal)
 * to test for process existence without affecting it.
 */
export function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process, EPERM = process exists but we lack permission (still alive)
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

/**
 * Get the lock file path for an agent.
 */
export function lockPathFor(agentId: string, lockDir: string = DEFAULT_LOCK_DIR): string {
  if (!agentId) throw new Error('agentId is required');
  return join(lockDir, `${agentId}.lock`);
}

/**
 * Read and parse a lock file, or return null if it doesn't exist.
 */
export async function readLockFile(lockPath: string): Promise<LockData | null> {
  try {
    const raw = await readFile(lockPath, 'utf-8');
    return JSON.parse(raw) as LockData;
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === 'ENOENT') return null;
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
 */
export function isLockStale(lockData: LockData | null | undefined, maxAgeMs: number): boolean {
  if (!lockData || !lockData.createdAt) return true;
  const age = Date.now() - new Date(lockData.createdAt).getTime();
  return age > maxAgeMs;
}

/**
 * Check if a lock is orphaned — the owning process is no longer running.
 */
export function isLockOrphaned(lockData: LockData | null | undefined): boolean {
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
 */
export function lockStatus(lockData: LockData | null | undefined, maxAgeMs: number): LockStatus {
  if (!lockData) return 'absent';
  if (isLockStale(lockData, maxAgeMs)) return 'stale';
  if (isLockOrphaned(lockData)) return 'orphaned';
  return 'active';
}

/**
 * Attempt to acquire a lock for an agent session.
 *
 * Idempotent: stale and orphaned locks are automatically replaced.
 */
export async function acquireLock(
  agentId: string,
  opts: AcquireLockOptions = {},
): Promise<AcquireLockResult> {
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
      existingLock: existing!,
    };
  }

  // Create new lock (absent, stale, or orphaned — safe to acquire)
  const lockData: LockData = {
    agentId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    staleAfter: new Date(Date.now() + maxLockAgeMs).toISOString(),
  };

  if (opts.sessionInfo) {
    lockData.sessionInfo = opts.sessionInfo;
  }

  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + '\n', 'utf-8');

  const result: AcquireLockResult = { acquired: true, lockData };
  if (existing && status !== 'absent') {
    result.replacedStatus = status as Exclude<LockStatus, 'active' | 'absent'>;
  }
  return result;
}

/**
 * Release the lock for an agent.
 * Idempotent: no error if lock doesn't exist.
 */
export async function releaseLock(
  agentId: string,
  opts: LockDirOptions = {},
): Promise<ReleaseLockResult> {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  if (!agentId) throw new Error('agentId is required');

  const lockPath = lockPathFor(agentId, lockDir);
  try {
    await rm(lockPath, { force: true });
    return { released: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { released: true };
    throw err;
  }
}

/**
 * Query the lock state for an agent.
 */
export async function queryLock(
  agentId: string,
  opts: LockDirOptions = {},
): Promise<QueryLockResult> {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  if (!agentId) throw new Error('agentId is required');

  const lockPath = lockPathFor(agentId, lockDir);
  const lockData = await readLockFile(lockPath);
  const status = lockStatus(lockData, maxLockAgeMs);

  const result: QueryLockResult = {
    locked: status === 'active',
    status,
  };
  if (lockData) result.lockData = lockData;
  return result;
}

/**
 * Force-break a lock regardless of status.
 * Useful for manual intervention / admin cleanup.
 */
export async function breakLock(
  agentId: string,
  opts: LockDirOptions = {},
): Promise<BreakLockResult> {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  if (!agentId) throw new Error('agentId is required');

  const lockPath = lockPathFor(agentId, lockDir);
  const previousLock = await readLockFile(lockPath);

  await rm(lockPath, { force: true });

  const result: BreakLockResult = { broken: true };
  if (previousLock) result.previousLock = previousLock;
  return result;
}

/**
 * Create a LockManager instance bound to a specific configuration.
 */
export function createLockManager(opts: LockDirOptions = {}): LockManager {
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
