/**
 * Agents data source for the SPA dashboard.
 *
 * Read-only JSON gatherer for the agents list view. Every field is
 * derived from an existing `src/storage/*` store — this module never
 * writes, never creates new persistence, and never caches.
 *
 * Data sources (all read-only):
 *   - `listAllAgents` → `src/storage/agent-helpers.js` (wraps AgentStore.loadAll)
 *   - `UsageStore.weeklyTotal` → `src/storage/usage-store.js`
 *   - `loadConfig` → `src/storage/config-store.js`
 *   - `readSubagentIdentity` → `src/subagents/subagent-file.js`
 *     (reads `.claude/agents/<slug>.md` — existing identity primitive)
 *
 * Shape returned by `gatherAgentsList`:
 *   [{ slug, name, description, missing, status,
 *      tokensUsed, tokenLimit, utilizationPct }]
 *
 * The `status` enum mirrors the SSR dashboard's derivation so the SPA
 * Overview tab matches the terminal `/aweek:summary` baseline:
 *   - `active`            — hired, not paused, under budget
 *   - `paused`            — `config.budget.paused === true`
 *   - `budget-exhausted`  — paused AND usage ≥ weekly limit
 */

import { join } from 'node:path';
import { listAllAgentsPartial } from '../../storage/agent-helpers.js';
import { UsageStore, getMondayDate } from '../../storage/usage-store.js';
import { WeeklyPlanStore } from '../../storage/weekly-plan-store.js';
import { loadConfig } from '../../storage/config-store.js';
import { readSubagentIdentity } from '../../subagents/subagent-file.js';
import { currentWeekKey } from '../../time/zone.js';

/** Tri-state agent status surfaced in the SPA agents list. */
export type AgentStatus = 'active' | 'paused' | 'budget-exhausted';

/** Loose config shape consumed by {@link deriveAgentStatus}. */
interface AgentStatusConfig {
  budget?: { paused?: boolean; weeklyTokenLimit?: number };
  weeklyTokenBudget?: number;
}

/** Loose usage shape consumed by {@link deriveAgentStatus}. */
interface AgentStatusUsage {
  totalTokens?: number;
}

/** Status sort order — active first, exhausted last. */
const STATUS_ORDER: Record<AgentStatus, number> = {
  active: 0,
  paused: 1,
  'budget-exhausted': 2,
};

/**
 * Derive a tri-state status for an agent from its config + current-week
 * usage total. Exported so callers (and tests) can reuse the derivation
 * without touching the filesystem.
 */
export function deriveAgentStatus(
  config: AgentStatusConfig | null | undefined,
  usage: AgentStatusUsage | null | undefined,
): AgentStatus {
  const paused = !!config?.budget?.paused;
  const limit = config?.weeklyTokenBudget || config?.budget?.weeklyTokenLimit || 0;
  const used = usage?.totalTokens || 0;
  const overBudget = limit > 0 && used >= limit;
  if (paused && overBudget) return 'budget-exhausted';
  if (paused) return 'paused';
  return 'active';
}

/** Options accepted by {@link gatherAgentsList}. */
export interface GatherAgentsListOptions {
  projectDir?: string;
}

/** A single row in the SPA agents-list payload. */
export interface AgentsListRow {
  slug: string;
  name: string;
  description: string;
  missing: boolean;
  status: AgentStatus;
  tokensUsed: number;
  tokenLimit: number;
  utilizationPct: number | null;
  week: string;
  tasksTotal: number;
  tasksCompleted: number;
}

/** Result shape returned by {@link gatherAgentsList}. */
export interface AgentsListResult {
  rows: AgentsListRow[];
  issues: Array<{ id: string; message: string }>;
}

/**
 * Gather every agent's row for the SPA agents list / overview table.
 *
 * Per-agent failures (missing .md, malformed usage) are absorbed so the
 * dashboard degrades to "partial list" rather than 500ing. The result
 * is sorted: active agents first, then by display name.
 */
export async function gatherAgentsList(
  { projectDir }: GatherAgentsListOptions = {},
): Promise<AgentsListResult> {
  if (!projectDir) throw new Error('gatherAgentsList: projectDir is required');
  const dataDir = join(projectDir, '.aweek', 'agents');

  // Partial load so a single invalid agent JSON doesn't wipe the
  // dashboard — the caller surfaces `issues` as an error banner.
  const { agents: configs, errors: issues } = await listAllAgentsPartial({
    dataDir,
  });
  if (configs.length === 0) return { rows: [], issues };

  // Monday anchor is timezone-aware; fall back to UTC on config-load errors
  // so a malformed .aweek/config.json can't knock the dashboard offline.
  let timeZone: string | undefined;
  try {
    ({ timeZone } = await loadConfig(dataDir));
  } catch {
    timeZone = undefined;
  }
  const weekMonday = getMondayDate(new Date(), timeZone);
  // Current ISO-week key used as both the weekly-plan lookup key and the
  // UI "week" column — matches the terminal `/aweek:summary` header.
  // `currentWeekKey` throws on an undefined tz, so fall back to UTC when
  // `.aweek/config.json` is missing or malformed.
  const week = currentWeekKey(timeZone || 'UTC');
  const usageStore = new UsageStore(dataDir);
  const weeklyPlanStore = new WeeklyPlanStore(dataDir);

  const rows = await Promise.all(
    configs.map(async (config): Promise<AgentsListRow> => {
      const [identity, usage, tasksCount] = await Promise.all([
        readSubagentIdentity(config.id, projectDir).catch(() => ({
          missing: true,
          name: '',
          description: '',
        })),
        usageStore.weeklyTotal(config.id, weekMonday).catch(() => ({
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          recordCount: 0,
        })),
        // Current-week plan lookup may miss (agent not approved yet, or
        // no plan generated for this week). Treat every failure as
        // "no tasks" so the dashboard degrades gracefully.
        weeklyPlanStore.load(config.id, week).then(
          (plan) => {
            const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
            const completed = tasks.filter((t) => t.status === 'completed').length;
            return { total: tasks.length, completed };
          },
          () => ({ total: 0, completed: 0 }),
        ),
      ]);

      const status = deriveAgentStatus(config, usage);
      const tokenLimit =
        config.weeklyTokenBudget || config.budget?.weeklyTokenLimit || 0;
      const tokensUsed = usage.totalTokens || 0;
      const utilizationPct =
        tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : null;

      return {
        slug: config.id,
        name: identity.missing ? config.id : identity.name || config.id,
        description: identity.missing ? '' : identity.description || '',
        missing: !!identity.missing,
        status,
        tokensUsed,
        tokenLimit,
        utilizationPct,
        week,
        tasksTotal: tasksCount.total,
        tasksCompleted: tasksCount.completed,
      };
    }),
  );

  const sorted = rows.sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 99;
    const ob = STATUS_ORDER[b.status] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
  return { rows: sorted, issues };
}

/** Options accepted by {@link gatherAgentProfile}. */
export interface GatherAgentProfileOptions {
  projectDir?: string;
  slug?: string;
}

/** Profile payload for a single agent. */
export interface AgentProfile {
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  missing: boolean;
  identityPath: string;
  createdAt: string | null;
  updatedAt: string | null;
  paused: boolean;
  pausedReason: string | null;
  periodStart: string | null;
  tokenLimit: number;
  tokensUsed: number;
  remaining: number;
  overBudget: boolean;
  utilizationPct: number | null;
  weekMonday: string;
}

/**
 * Gather a single agent's profile payload for the SPA Profile tab.
 *
 * Combines identity (from `.claude/agents/<slug>.md` via
 * `readSubagentIdentity`), scheduling metadata (from `AgentStore` via
 * `listAllAgents`), and weekly budget (from `UsageStore.weeklyTotal`).
 *
 * Returns `null` when the slug is not present on disk so the HTTP layer
 * can map it to 404.
 */
export async function gatherAgentProfile(
  { projectDir, slug }: GatherAgentProfileOptions = {},
): Promise<AgentProfile | null> {
  if (!projectDir) throw new Error('gatherAgentProfile: projectDir is required');
  if (!slug) throw new Error('gatherAgentProfile: slug is required');
  const dataDir = join(projectDir, '.aweek', 'agents');

  // Use the partial loader so a single drifted/invalid agent file (e.g.
  // a hand-edited `pausedReason` that violates the enum) doesn't take
  // down every per-agent endpoint. The list endpoint already does this
  // — without the same tolerance here, one bad file 404s every detail
  // route.
  const { agents: configs } = await listAllAgentsPartial({ dataDir });
  const config = configs.find((c) => c.id === slug);
  if (!config) return null;

  let timeZone: string | undefined;
  try {
    ({ timeZone } = await loadConfig(dataDir));
  } catch {
    timeZone = undefined;
  }
  const weekMonday = getMondayDate(new Date(), timeZone);
  const usageStore = new UsageStore(dataDir);

  const [identity, usage] = await Promise.all([
    readSubagentIdentity(slug, projectDir).catch(() => ({
      missing: true,
      name: '',
      description: '',
      body: '',
      path: '',
    })),
    usageStore.weeklyTotal(slug, weekMonday).catch(() => ({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      recordCount: 0,
    })),
  ]);

  const tokenLimit =
    config.weeklyTokenBudget || config.budget?.weeklyTokenLimit || 0;
  const tokensUsed = usage.totalTokens || 0;
  const overBudget = tokenLimit > 0 && tokensUsed >= tokenLimit;
  const remaining = tokenLimit > 0 ? Math.max(0, tokenLimit - tokensUsed) : 0;
  const utilizationPct =
    tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : null;

  return {
    slug,
    name: identity.missing ? slug : identity.name || slug,
    description: identity.missing ? '' : identity.description || '',
    systemPrompt: identity.missing ? '' : identity.body || '',
    missing: !!identity.missing,
    identityPath: identity.path || '',
    createdAt: config.createdAt || null,
    updatedAt: config.updatedAt || null,
    paused: !!config.budget?.paused,
    pausedReason: config.budget?.pausedReason || null,
    periodStart: config.budget?.periodStart || null,
    tokenLimit,
    tokensUsed,
    remaining,
    overBudget,
    utilizationPct,
    weekMonday,
  };
}
