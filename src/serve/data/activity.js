/**
 * Activity log data source for the SPA dashboard.
 *
 * Read-only JSON gatherer for the per-agent activity feed. Exclusively
 * sources from `src/storage/activity-log-store.js` — no writes, no new
 * persistence.
 *
 * Returned shape:
 *   {
 *     slug, dateRange,
 *     entries: [
 *       { id, timestamp, status, title, agentId, duration?,
 *         metadata?: { resources, tokenUsage, execution, error, ... } }
 *     ]
 *   }
 */

import { join } from 'node:path';
import { listAllAgents } from '../../storage/agent-helpers.js';
import { ActivityLogStore } from '../../storage/activity-log-store.js';

/** Valid date-range preset keys. */
export const DATE_RANGE_PRESETS = ['all', 'this-week', 'last-7-days'];
/** Default preset when none supplied / unknown. */
export const DEFAULT_DATE_RANGE = 'all';

/**
 * Coerce an arbitrary string into a valid preset key.
 * @param {string | undefined} raw
 * @returns {'all' | 'this-week' | 'last-7-days'}
 */
export function resolveDateRange(raw) {
  if (typeof raw === 'string' && DATE_RANGE_PRESETS.includes(raw)) {
    return /** @type {any} */ (raw);
  }
  return DEFAULT_DATE_RANGE;
}

/**
 * Compute the earliest timestamp (ms) that entries must have to be
 * included in the given preset. Returns `{ cutoff: null }` for 'all'.
 *
 * @param {'all' | 'this-week' | 'last-7-days'} preset
 * @param {Date} [now]
 * @returns {{ cutoff: number | null }}
 */
export function computeDateRangeBounds(preset, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (preset === 'this-week') {
    const d = new Date(nowMs);
    const utcDay = d.getUTCDay();
    const diffToMonday = utcDay === 0 ? -6 : 1 - utcDay;
    const monday = new Date(nowMs);
    monday.setUTCDate(d.getUTCDate() + diffToMonday);
    monday.setUTCHours(0, 0, 0, 0);
    return { cutoff: monday.getTime() };
  }
  if (preset === 'last-7-days') {
    return { cutoff: nowMs - 7 * 24 * 60 * 60 * 1000 };
  }
  return { cutoff: null };
}

/** Keep the activity feed responsive for agents with years of history. */
const MAX_ENTRIES = 100;

/**
 * Gather the activity feed for a single agent.
 *
 * Returns `null` when the slug is unknown on disk so the HTTP layer
 * can map it to 404.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} opts.slug
 * @param {string} [opts.dateRange] - 'all' | 'this-week' | 'last-7-days'.
 * @param {number} [opts.limit] - Override the default MAX_ENTRIES cap.
 * @param {Date}   [opts.now]
 * @returns {Promise<{
 *   slug: string,
 *   dateRange: string,
 *   entries: Array<object>,
 * } | null>}
 */
export async function gatherAgentActivity({
  projectDir,
  slug,
  dateRange,
  limit = MAX_ENTRIES,
  now,
} = {}) {
  if (!projectDir) throw new Error('gatherAgentActivity: projectDir is required');
  if (!slug) throw new Error('gatherAgentActivity: slug is required');
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir: agentsDir });
  const exists = configs.some((c) => c.id === slug);
  if (!exists) return null;

  const resolved = resolveDateRange(dateRange);
  const store = new ActivityLogStore(agentsDir);

  let entries = [];
  try {
    const weeks = await store.listWeeks(slug);
    const perWeek = await Promise.all(
      weeks.map((week) => store.load(slug, week).catch(() => [])),
    );
    entries = perWeek.flat();
  } catch {
    entries = [];
  }

  entries.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta;
  });

  const { cutoff } = computeDateRangeBounds(resolved, now);
  if (cutoff !== null) {
    entries = entries.filter((e) => {
      const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
      return ts >= cutoff;
    });
  }

  if (entries.length > limit) {
    entries = entries.slice(0, limit);
  }

  return { slug, dateRange: resolved, entries };
}
