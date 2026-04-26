/**
 * Logs data source for the SPA dashboard — `/api/agents/:slug/logs`.
 *
 * Read-only JSON gatherer that merges two complementary on-disk views of
 * an agent's run history:
 *
 *   1. Activity-log entries (`src/storage/activity-log-store.js`) — the
 *      user-facing per-task log: started / completed / failed / skipped /
 *      delegated rows with friendly titles, durations, and resource /
 *      token metadata. This is the same source the existing Activity
 *      tab consumed in the SSR build.
 *
 *   2. Execution records (`src/storage/execution-store.js`) — the
 *      heartbeat audit trail: one row per heartbeat tick with
 *      idempotency key, time window, status, and optional taskId. Useful
 *      for verifying the cron loop is actually firing and surfacing
 *      ticks that did not produce a user-facing activity entry (e.g.
 *      paused, skipped, no-op).
 *
 * The endpoint returns BOTH arrays so the SPA can render a unified
 * "execution logs" view without making two round-trips. Each array is
 * sorted newest-first and capped at MAX_ENTRIES so the response stays
 * cheap to serialize even for agents with years of history.
 *
 * Read-only contract (see `data/data.test.js` AC 9):
 *   - No writes (the underlying stores' read APIs are pure reads).
 *   - No new persistence — sources only from existing src/storage/* modules.
 */

import { join } from 'node:path';
import { listAllAgents } from '../../storage/agent-helpers.js';
import { ActivityLogStore } from '../../storage/activity-log-store.js';
import type { ActivityLogEntry } from '../../storage/activity-log-store.js';
import { ExecutionStore } from '../../storage/execution-store.js';
import type { ExecutionRecord } from '../../storage/execution-store.js';
import {
  computeDateRangeBounds,
  resolveDateRange,
} from './activity.js';
import type { DateRangePreset } from './activity.js';

/**
 * Maximum entries returned per source. Both lists are capped
 * independently so a noisy execution log can't push out the activity
 * entries (and vice-versa).
 */
const MAX_ENTRIES = 100;

/** Options accepted by {@link gatherAgentLogs}. */
export interface GatherAgentLogsOptions {
  projectDir?: string;
  slug?: string;
  /** 'all' | 'this-week' | 'last-7-days'. */
  dateRange?: string;
  /**
   * Override the default MAX_ENTRIES cap applied independently to each
   * list.
   */
  limit?: number;
  /** Test injection point for the date-range cutoff calculation. */
  now?: Date | number;
}

/** Logs payload returned to the SPA. */
export interface AgentLogsPayload {
  slug: string;
  dateRange: DateRangePreset;
  entries: ActivityLogEntry[];
  executions: ExecutionRecord[];
}

/**
 * Gather merged execution / activity logs for a single agent.
 *
 * Returns `null` when the slug is unknown on disk so the HTTP layer can
 * map it to 404. Per-week file errors are absorbed so a single corrupt
 * file does not blank out the rest of the log.
 */
export async function gatherAgentLogs({
  projectDir,
  slug,
  dateRange,
  limit = MAX_ENTRIES,
  now,
}: GatherAgentLogsOptions = {}): Promise<AgentLogsPayload | null> {
  if (!projectDir) throw new Error('gatherAgentLogs: projectDir is required');
  if (!slug) throw new Error('gatherAgentLogs: slug is required');
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir: agentsDir });
  const exists = configs.some((c) => c.id === slug);
  if (!exists) return null;

  const resolved = resolveDateRange(dateRange);
  const { cutoff } = computeDateRangeBounds(resolved, now);

  const [entries, executions] = await Promise.all([
    loadActivityEntries(agentsDir, slug),
    loadExecutionRecords(agentsDir, slug),
  ]);

  // Sort newest first — callers can paginate from the front, and the SPA
  // renders most-recent-first to match the SSR Activity tab's behaviour.
  const byTimestampDesc = (a: { timestamp?: string }, b: { timestamp?: string }) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta;
  };
  entries.sort(byTimestampDesc);
  executions.sort(byTimestampDesc);

  // Apply the date-range filter before the per-list cap so the cap is
  // measured against the already-windowed set, not the raw history.
  const inRange = (e: { timestamp?: string }): boolean => {
    if (cutoff === null) return true;
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
    return ts >= cutoff;
  };
  const filteredEntries = entries.filter(inRange);
  const filteredExecutions = executions.filter(inRange);

  const cap = <T>(list: T[]): T[] => (list.length > limit ? list.slice(0, limit) : list);

  return {
    slug,
    dateRange: resolved,
    entries: cap(filteredEntries),
    executions: cap(filteredExecutions),
  };
}

/**
 * Load every activity-log entry across every persisted week. Per-week
 * read failures are swallowed so one unreadable file does not blank the
 * whole feed — same forgiving policy `gatherAgentActivity` uses.
 */
async function loadActivityEntries(
  agentsDir: string,
  slug: string,
): Promise<ActivityLogEntry[]> {
  const store = new ActivityLogStore(agentsDir);
  try {
    const weeks = await store.listWeeks(slug);
    const perWeek = await Promise.all(
      weeks.map((week) => store.load(slug, week).catch(() => [] as ActivityLogEntry[])),
    );
    return perWeek.flat();
  } catch {
    return [];
  }
}

/**
 * Load every execution record (heartbeat audit row) across every
 * persisted week. Same per-week absorption as `loadActivityEntries`.
 */
async function loadExecutionRecords(
  agentsDir: string,
  slug: string,
): Promise<ExecutionRecord[]> {
  const store = new ExecutionStore(agentsDir);
  try {
    const weeks = await store.listWeeks(slug);
    const perWeek = await Promise.all(
      weeks.map((week) => store.load(slug, week).catch(() => [] as ExecutionRecord[])),
    );
    return perWeek.flat();
  } catch {
    return [];
  }
}
