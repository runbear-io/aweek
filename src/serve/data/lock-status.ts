/**
 * Per-agent lock status data source for the SPA dashboard.
 *
 * Read-only JSON gatherer for the chat panel's heartbeat-activity
 * banner (AC 11): "informational banner appears when heartbeat is
 * actively executing that agent's scheduled task — banner is purely
 * informational, does not block input or queue messages".
 *
 * Per the chat-panel contract, chat NEVER acquires the per-agent lock
 * itself — both heartbeat and chat run concurrently. The presence of
 * an *active* lock therefore directly indicates that the heartbeat
 * (or some other locked-session path) is running for this agent. The
 * chat panel reads this status purely to render an informational
 * banner; it does not block input or queue messages on the lock state.
 *
 * Data sources (read-only):
 *   - `queryLock` → `src/lock/lock-manager.js`
 *
 * The lock manager already canonicalises lock state across the
 * (`active`, `stale`, `orphaned`, `absent`) tuple — we simply re-shape
 * the answer for the SPA. Since orphaned and stale locks should NOT
 * trigger the banner (the heartbeat is not actually running), the
 * gatherer surfaces the canonical `LockStatus` and a derived `locked`
 * flag matching `queryLock`'s active/inactive contract.
 *
 * @module serve/data/lock-status
 */

import { join } from 'node:path';

import { queryLock, type LockStatus } from '../../lock/lock-manager.js';

/** Default lock directory under a project's `.aweek/` data dir. */
const LOCK_SUBDIR = '.locks';

/** Optional session metadata persisted alongside the lock file. */
export interface AgentLockSessionInfo {
  /** Originating task id when known (heartbeat / inbox / queued). */
  taskId?: string;
  /** Origin tag — `'heartbeat'` for scheduled ticks, `'inbox'` for
   *  delegated tasks, `'queued'` for previously-queued runs, etc. The
   *  banner does NOT discriminate by type — any active session counts
   *  as "heartbeat is busy" from the chat user's perspective — but the
   *  field is preserved here so future UI affordances (e.g. "running
   *  task XYZ") can surface it without a follow-up endpoint. */
  type?: string;
}

/**
 * Lock-status payload returned to the SPA. Mirrors the shape produced
 * by `queryLock` but with the chat-banner-relevant subset projected
 * out — we deliberately omit the raw PID + `staleAfter` fields because
 * the SPA has no use for them and exposing them would tempt callers
 * into client-side stale-detection logic that belongs in the lock
 * manager.
 */
export interface AgentLockStatusPayload {
  /** Slug of the agent this lock belongs to. */
  slug: string;
  /** `true` when an active heartbeat session holds the lock. */
  locked: boolean;
  /** Canonical `queryLock` status — `'active' | 'stale' | 'orphaned' | 'absent'`. */
  status: LockStatus;
  /** ISO timestamp the lock was acquired. `null` when absent. */
  since: string | null;
  /** Session metadata recorded by the heartbeat at lock-acquire time. */
  sessionInfo: AgentLockSessionInfo | null;
}

/** Options accepted by {@link gatherAgentLockStatus}. */
export interface GatherAgentLockStatusOptions {
  projectDir?: string;
  slug?: string;
  /**
   * Test seam — overrides the default `.aweek/.locks` lock directory.
   * Production callers omit this and the gatherer derives the path
   * from `projectDir`.
   */
  lockDir?: string;
}

/**
 * Resolve the project's lock directory. Mirrors the path the heartbeat
 * uses when running for a given project (`<projectDir>/.aweek/.locks`).
 */
function resolveLockDir(projectDir: string, override?: string): string {
  if (override) return override;
  return join(projectDir, '.aweek', LOCK_SUBDIR);
}

/**
 * Gather the heartbeat-lock status for a single agent.
 *
 * Returns the canonical `queryLock` status projected into the SPA's
 * banner-friendly shape. When the lock file is missing we still return
 * a successful payload with `locked: false` and `status: 'absent'` so
 * the SPA can render "no heartbeat activity" without 404 handling.
 *
 * **Caller contract (slug existence)**: this gatherer does NOT verify
 * that the agent slug is known on disk. The chat banner only renders
 * when the user has selected an agent via the picker, which already
 * sources slugs from `gatherAgentsList`; an unknown slug here would
 * simply return `{ locked: false, status: 'absent' }` — harmless but
 * uninformative. If a future caller needs slug validation, layer it
 * over this gatherer rather than coupling lock-status to the agent
 * registry.
 */
export async function gatherAgentLockStatus(
  { projectDir, slug, lockDir }: GatherAgentLockStatusOptions = {},
): Promise<AgentLockStatusPayload> {
  if (!projectDir) {
    throw new Error('gatherAgentLockStatus: projectDir is required');
  }
  if (!slug) {
    throw new Error('gatherAgentLockStatus: slug is required');
  }

  const resolvedLockDir = resolveLockDir(projectDir, lockDir);
  const result = await queryLock(slug, { lockDir: resolvedLockDir });

  const sessionInfo: AgentLockSessionInfo | null =
    result.lockData?.sessionInfo &&
    typeof result.lockData.sessionInfo === 'object'
      ? extractSessionInfo(result.lockData.sessionInfo)
      : null;

  return {
    slug,
    locked: result.locked,
    status: result.status,
    since: result.lockData?.createdAt ?? null,
    sessionInfo,
  };
}

/**
 * Project the persisted `sessionInfo` blob to the narrow surface the
 * SPA cares about. The lock manager stores arbitrary `Record<string, unknown>`
 * keyed metadata; we extract only `taskId` + `type` here so the wire
 * shape stays predictable for the SPA and unknown future fields don't
 * leak into the banner UI.
 */
function extractSessionInfo(
  raw: Record<string, unknown>,
): AgentLockSessionInfo {
  const out: AgentLockSessionInfo = {};
  if (typeof raw.taskId === 'string' && raw.taskId.length > 0) {
    out.taskId = raw.taskId;
  }
  if (typeof raw.type === 'string' && raw.type.length > 0) {
    out.type = raw.type;
  }
  return out;
}
