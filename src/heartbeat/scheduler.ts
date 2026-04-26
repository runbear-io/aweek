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
 * The project-level heartbeat installer in `src/skills/init.ts` handles
 * *scheduling* (installing/removing the single project cron entry). This
 * module handles *execution* (what happens when a heartbeat fires).
 */
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Default lock directory */
const DEFAULT_LOCK_DIR = '.aweek/.locks';

/** Default max lock age in ms (2 hours — generous for long-running sessions) */
const DEFAULT_MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000;

/** Lock file payload as written by this scheduler. */
export interface SchedulerLockData {
  agentId: string;
  pid: number;
  createdAt: string;
  staleAfter: string;
}

/** Common lock-directory + age options shared across helpers. */
export interface SchedulerLockOptions {
  lockDir?: string;
  maxLockAgeMs?: number;
}

export interface AcquireLockResult {
  acquired: boolean;
  lockData?: SchedulerLockData;
  reason?: string;
  existingLock?: SchedulerLockData;
}

export interface ReleaseLockResult {
  released: boolean;
}

export interface IsLockedResult {
  locked: boolean;
  lockData?: SchedulerLockData;
  stale?: boolean;
}

/** Status of a single heartbeat invocation. */
export type HeartbeatRunStatus = 'completed' | 'skipped' | 'error';

export interface HeartbeatRunResult<T = unknown> {
  status: HeartbeatRunStatus;
  agentId: string;
  result?: T;
  reason?: string;
  existingLock?: SchedulerLockData;
  error?: Error;
  lockData?: SchedulerLockData;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export type HeartbeatCallback<T = unknown> = (agentId: string) => Promise<T>;

/** Bound Scheduler API returned by {@link createScheduler}. */
export interface Scheduler {
  lockDir: string;
  maxLockAgeMs: number;
  lockPathFor: (agentId: string) => string;
  acquireLock: (agentId: string) => Promise<AcquireLockResult>;
  releaseLock: (agentId: string) => Promise<ReleaseLockResult>;
  isLocked: (agentId: string) => Promise<IsLockedResult>;
  runHeartbeat: <T>(
    agentId: string,
    callback: HeartbeatCallback<T>,
  ) => Promise<HeartbeatRunResult<T>>;
}

/**
 * Create a heartbeat scheduler instance.
 */
export function createScheduler(opts: SchedulerLockOptions = {}): Scheduler {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  return {
    lockDir,
    maxLockAgeMs,
    lockPathFor: (agentId) => lockPathFor(agentId, lockDir),
    acquireLock: (agentId) => acquireLock(agentId, { lockDir, maxLockAgeMs }),
    releaseLock: (agentId) => releaseLock(agentId, { lockDir }),
    isLocked: (agentId) => isLocked(agentId, { lockDir, maxLockAgeMs }),
    runHeartbeat: <T>(agentId: string, callback: HeartbeatCallback<T>) =>
      runHeartbeat<T>(agentId, callback, { lockDir, maxLockAgeMs }),
  };
}

/**
 * Get the lock file path for an agent.
 */
export function lockPathFor(agentId: string, lockDir: string = DEFAULT_LOCK_DIR): string {
  if (!agentId) throw new Error('agentId is required');
  return join(lockDir, `${agentId}.lock`);
}

/**
 * Read lock file contents, or null if it doesn't exist.
 */
async function readLockFile(lockPath: string): Promise<SchedulerLockData | null> {
  try {
    const raw = await readFile(lockPath, 'utf-8');
    return JSON.parse(raw) as SchedulerLockData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Check if a lock is stale based on its createdAt timestamp.
 */
export function isLockStale(
  lockData: SchedulerLockData | null | undefined,
  maxAgeMs: number,
): boolean {
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
 */
export async function acquireLock(
  agentId: string,
  opts: SchedulerLockOptions = {},
): Promise<AcquireLockResult> {
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
  const lockData: SchedulerLockData = {
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
 */
export async function releaseLock(
  agentId: string,
  opts: SchedulerLockOptions = {},
): Promise<ReleaseLockResult> {
  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  if (!agentId) throw new Error('agentId is required');

  const lockPath = lockPathFor(agentId, lockDir);
  try {
    await rm(lockPath, { force: true });
    return { released: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { released: false };
    throw err;
  }
}

/**
 * Check if an agent is currently locked (active heartbeat in progress).
 */
export async function isLocked(
  agentId: string,
  opts: SchedulerLockOptions = {},
): Promise<IsLockedResult> {
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
 */
export async function runHeartbeat<T = unknown>(
  agentId: string,
  callback: HeartbeatCallback<T>,
  opts: SchedulerLockOptions = {},
): Promise<HeartbeatRunResult<T>> {
  if (!agentId) throw new Error('agentId is required');
  if (typeof callback !== 'function') throw new Error('callback must be a function');

  const lockDir = opts.lockDir || DEFAULT_LOCK_DIR;
  const maxLockAgeMs = opts.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;

  // Attempt to acquire lock
  const lockResult = await acquireLock(agentId, { lockDir, maxLockAgeMs });

  if (!lockResult.acquired) {
    const skipped: HeartbeatRunResult<T> = {
      status: 'skipped',
      agentId,
      reason: lockResult.reason,
    };
    if (lockResult.existingLock) skipped.existingLock = lockResult.existingLock;
    return skipped;
  }

  const startedAt = new Date().toISOString();

  try {
    const result = await callback(agentId);
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    const ok: HeartbeatRunResult<T> = {
      status: 'completed',
      agentId,
      result,
      startedAt,
      completedAt,
      durationMs,
    };
    if (lockResult.lockData) ok.lockData = lockResult.lockData;
    return ok;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    const failed: HeartbeatRunResult<T> = {
      status: 'error',
      agentId,
      error,
      startedAt,
      completedAt,
      durationMs,
    };
    if (lockResult.lockData) failed.lockData = lockResult.lockData;
    return failed;
  } finally {
    // Always release the lock
    await releaseLock(agentId, { lockDir });
  }
}

/**
 * Run heartbeats for multiple agents in parallel.
 * Each agent runs independently with its own lock.
 */
export async function runHeartbeatAll<T = unknown>(
  agentIds: string[],
  callback: HeartbeatCallback<T>,
  opts: SchedulerLockOptions = {},
): Promise<HeartbeatRunResult<T>[]> {
  if (!Array.isArray(agentIds)) throw new Error('agentIds must be an array');
  if (typeof callback !== 'function') throw new Error('callback must be a function');

  return Promise.all(
    agentIds.map((agentId) => runHeartbeat<T>(agentId, callback, opts)),
  );
}
