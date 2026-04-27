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
import { listAllAgentsPartial } from '../../storage/agent-helpers.js';
import { ActivityLogStore } from '../../storage/activity-log-store.js';
import type { ActivityLogEntry } from '../../storage/activity-log-store.js';

/** Valid date-range preset keys. */
export const DATE_RANGE_PRESETS = ['all', 'this-week', 'last-7-days'] as const;
/** Default preset when none supplied / unknown. */
export const DEFAULT_DATE_RANGE = 'all';

/** Date-range preset literal. */
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

/**
 * Coerce an arbitrary string into a valid preset key.
 */
export function resolveDateRange(raw: string | undefined): DateRangePreset {
  if (typeof raw === 'string' && (DATE_RANGE_PRESETS as readonly string[]).includes(raw)) {
    return raw as DateRangePreset;
  }
  return DEFAULT_DATE_RANGE;
}

/**
 * Compute the earliest timestamp (ms) that entries must have to be
 * included in the given preset. Returns `{ cutoff: null }` for 'all'.
 */
export function computeDateRangeBounds(
  preset: DateRangePreset,
  now: Date | number = new Date(),
): { cutoff: number | null } {
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

/** Options accepted by {@link gatherAgentActivity}. */
export interface GatherAgentActivityOptions {
  projectDir?: string;
  slug?: string;
  /** 'all' | 'this-week' | 'last-7-days'. */
  dateRange?: string;
  /** Override the default MAX_ENTRIES cap. */
  limit?: number;
  now?: Date | number;
}

/** Activity feed payload returned to the SPA. */
export interface AgentActivityPayload {
  slug: string;
  dateRange: DateRangePreset;
  entries: ActivityLogEntry[];
}

/**
 * Gather the activity feed for a single agent.
 *
 * Returns `null` when the slug is unknown on disk so the HTTP layer
 * can map it to 404.
 */
export async function gatherAgentActivity({
  projectDir,
  slug,
  dateRange,
  limit = MAX_ENTRIES,
  now,
}: GatherAgentActivityOptions = {}): Promise<AgentActivityPayload | null> {
  if (!projectDir) throw new Error('gatherAgentActivity: projectDir is required');
  if (!slug) throw new Error('gatherAgentActivity: slug is required');
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const { agents: configs } = await listAllAgentsPartial({ dataDir: agentsDir });
  const exists = configs.some((c) => c.id === slug);
  if (!exists) return null;

  const resolved = resolveDateRange(dateRange);
  const store = new ActivityLogStore(agentsDir);

  let entries: ActivityLogEntry[] = [];
  try {
    const weeks = await store.listWeeks(slug);
    const perWeek = await Promise.all(
      weeks.map((week) => store.load(slug, week).catch(() => [] as ActivityLogEntry[])),
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
