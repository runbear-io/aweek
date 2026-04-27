/**
 * Plan data source for the SPA dashboard.
 *
 * Read-only JSON gatherer that returns the raw `plan.md` body for an
 * agent together with its structured weekly plan data. Rendering
 * (markdown → HTML) is the SPA's responsibility — this module ships the
 * canonical text so the client can render it however the Strategy tab
 * sees fit, and ships the weekly plans so the Plan tab can surface
 * approval state and per-week task lists without a second round-trip.
 *
 * Data sources (all read-only):
 *   - `listAllAgents`        → `src/storage/agent-helpers.js`
 *   - `readPlan`             → `src/storage/plan-markdown-store.js`
 *   - `WeeklyPlanStore`      → `src/storage/weekly-plan-store.js`
 *   - `readSubagentIdentity` → `src/subagents/subagent-file.js`
 */

import { join } from 'node:path';
import { listAllAgentsPartial } from '../../storage/agent-helpers.js';
import { readPlan } from '../../storage/plan-markdown-store.js';
import { WeeklyPlanStore } from '../../storage/weekly-plan-store.js';
import type { WeeklyPlan } from '../../storage/weekly-plan-store.js';
import { readSubagentIdentity } from '../../subagents/subagent-file.js';
import { readWatchlistAndStrategies } from '../../storage/review-file-reader.js';

/** Options accepted by {@link gatherAgentPlan}. */
export interface GatherAgentPlanOptions {
  projectDir?: string;
  slug?: string;
}

/** A single strategy document read from `.aweek/agents/<slug>/strategies/`. */
export interface AgentStrategyEntry {
  /** Basename without extension (e.g. `"2026-W17-strategy"`). */
  name: string;
  /** Raw markdown body. */
  markdown: string;
}

/** Plan payload returned to the SPA. */
export interface AgentPlanPayload {
  slug: string;
  name: string;
  hasPlan: boolean;
  markdown: string;
  weeklyPlans: WeeklyPlan[];
  latestApproved: WeeklyPlan | null;
  /** Watchlist surface. `hasWatchlist` is false when the file is missing or unreadable. */
  watchlist: { hasWatchlist: boolean; markdown: string };
  /** Per-strategy documents from `.aweek/agents/<slug>/strategies/*.md`. */
  strategies: AgentStrategyEntry[];
}

/**
 * Gather a single agent's plan.md body + weekly plan data.
 *
 * Returns `null` when the slug is not present on disk so the HTTP layer
 * can map it to 404. When the agent exists but has no plan.md yet,
 * `hasPlan === false` and `markdown === ''`. When the agent has no
 * weekly plans yet, `weeklyPlans === []` and `latestApproved === null`.
 *
 * Errors from the weekly plan store are absorbed (a malformed week file
 * never knocks the plan view offline) — the caller sees the remaining
 * well-formed weeks or an empty list.
 */
export async function gatherAgentPlan(
  { projectDir, slug }: GatherAgentPlanOptions = {},
): Promise<AgentPlanPayload | null> {
  if (!projectDir) throw new Error('gatherAgentPlan: projectDir is required');
  if (!slug) throw new Error('gatherAgentPlan: slug is required');
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const { agents: configs } = await listAllAgentsPartial({ dataDir: agentsDir });
  const config = configs.find((c) => c.id === slug);
  if (!config) return null;

  const identity = await readSubagentIdentity(slug, projectDir).catch(() => ({
    missing: true,
    name: '',
  }));
  const name = identity.missing ? slug : identity.name || slug;

  const markdown = await readPlan(agentsDir, slug).catch(() => null);
  const body = typeof markdown === 'string' ? markdown : '';

  // Load every weekly plan + latest approved. The store throws when a
  // single week file is malformed; we catch so a bad row doesn't null
  // out the whole response. `loadAll` already sorts by week key.
  const weeklyPlanStore = new WeeklyPlanStore(agentsDir);
  const [weeklyPlans, latestApproved, { watchlist, strategies }] =
    await Promise.all([
      weeklyPlanStore.loadAll(slug).catch(() => [] as WeeklyPlan[]),
      weeklyPlanStore.loadLatestApproved(slug).catch(() => null),
      readWatchlistAndStrategies(join(agentsDir, slug)),
    ]);

  return {
    slug,
    name,
    hasPlan: body.trim().length > 0,
    markdown: body,
    weeklyPlans,
    latestApproved,
    watchlist,
    strategies,
  };
}
