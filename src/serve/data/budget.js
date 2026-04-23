/**
 * Budget data source for the SPA dashboard.
 *
 * Read-only JSON gatherer for the "Budget & usage" view. Surfaces, per
 * agent, the weekly token limit compared against the current week's
 * usage total. Exclusively sources from existing `src/storage/*`
 * stores — no new persistence, no writes.
 *
 * Data sources (all read-only):
 *   - `listAllAgents` → `src/storage/agent-helpers.js`
 *   - `UsageStore.weeklyTotal` / `UsageStore.listWeeks` → `src/storage/usage-store.js`
 *   - `loadConfig` → `src/storage/config-store.js`
 *   - `readSubagentIdentity` → `src/subagents/subagent-file.js`
 */

import { join } from 'node:path';
import { listAllAgents } from '../../storage/agent-helpers.js';
import { UsageStore, getMondayDate } from '../../storage/usage-store.js';
import { loadConfig } from '../../storage/config-store.js';
import { readSubagentIdentity } from '../../subagents/subagent-file.js';

/**
 * Derive budget totals for a single agent given its config and the
 * current week's usage totals.
 *
 * @param {{ weeklyTokenBudget?: number,
 *           budget?: { weeklyTokenLimit?: number } }} config
 * @param {{ totalTokens?: number }} usage
 * @returns {{
 *   tokenLimit: number,
 *   tokensUsed: number,
 *   remaining: number,
 *   overBudget: boolean,
 *   utilizationPct: number | null,
 * }}
 */
export function deriveBudget(config, usage) {
  const tokenLimit =
    config?.weeklyTokenBudget || config?.budget?.weeklyTokenLimit || 0;
  const tokensUsed = usage?.totalTokens || 0;
  const overBudget = tokenLimit > 0 && tokensUsed >= tokenLimit;
  const remaining = tokenLimit > 0 ? Math.max(0, tokenLimit - tokensUsed) : 0;
  const utilizationPct =
    tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : null;
  return { tokenLimit, tokensUsed, remaining, overBudget, utilizationPct };
}

/**
 * Gather budget rows for every agent. Over-budget rows float to the
 * top; ties are broken by utilization desc, then slug asc.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @returns {Promise<Array<{
 *   slug: string,
 *   name: string,
 *   missing: boolean,
 *   tokenLimit: number,
 *   tokensUsed: number,
 *   remaining: number,
 *   overBudget: boolean,
 *   utilizationPct: number | null,
 *   weekMonday: string,
 * }>>}
 */
export async function gatherBudgetList({ projectDir } = {}) {
  if (!projectDir) throw new Error('gatherBudgetList: projectDir is required');
  const dataDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir });
  if (configs.length === 0) return [];

  let timeZone;
  try {
    ({ timeZone } = await loadConfig(dataDir));
  } catch {
    timeZone = undefined;
  }
  const weekMondayDate = getMondayDate(new Date(), timeZone);
  const usageStore = new UsageStore(dataDir);

  const rows = await Promise.all(
    configs.map(async (config) => {
      const [identity, usage] = await Promise.all([
        readSubagentIdentity(config.id, projectDir).catch(() => ({
          missing: true,
          name: '',
        })),
        usageStore.weeklyTotal(config.id, weekMondayDate).catch(() => ({
          totalTokens: 0,
        })),
      ]);

      return {
        slug: config.id,
        name: identity.missing ? config.id : identity.name || config.id,
        missing: !!identity.missing,
        ...deriveBudget(config, usage),
        weekMonday: weekMondayDate,
      };
    }),
  );

  return rows.sort((a, b) => {
    if (a.overBudget && !b.overBudget) return -1;
    if (!a.overBudget && b.overBudget) return 1;
    const pctA = a.utilizationPct ?? -1;
    const pctB = b.utilizationPct ?? -1;
    if (pctA !== pctB) return pctB - pctA;
    return a.slug.localeCompare(b.slug);
  });
}

/**
 * Gather a single agent's budget + usage payload for the SPA Usage tab.
 *
 * Returns the current week's budget / usage aggregates plus a per-week
 * historical roll-up so the UI can render trend charts without a second
 * round-trip. Every field is derived from an existing `src/storage/*`
 * store — no new persistence.
 *
 * Returns `null` when the slug is not present on disk so the HTTP layer
 * can map it to 404. Per-week aggregation errors are absorbed so a
 * single malformed week file cannot knock the whole endpoint offline;
 * the caller sees the remaining well-formed weeks.
 *
 * Response shape:
 *   {
 *     slug, name, missing,
 *     paused, pausedReason,
 *     weekMonday,                       // current-week Monday (timezone-aware)
 *     tokenLimit, tokensUsed,
 *     inputTokens, outputTokens, costUsd, recordCount,
 *     remaining, overBudget, utilizationPct,
 *     weeks: [                           // sorted ascending by weekMonday
 *       { weekMonday, recordCount,
 *         inputTokens, outputTokens, totalTokens, costUsd }
 *     ]
 *   }
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} opts.slug
 * @returns {Promise<{
 *   slug: string,
 *   name: string,
 *   missing: boolean,
 *   paused: boolean,
 *   pausedReason: string | null,
 *   weekMonday: string,
 *   tokenLimit: number,
 *   tokensUsed: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   costUsd: number,
 *   recordCount: number,
 *   remaining: number,
 *   overBudget: boolean,
 *   utilizationPct: number | null,
 *   weeks: Array<{
 *     weekMonday: string,
 *     recordCount: number,
 *     inputTokens: number,
 *     outputTokens: number,
 *     totalTokens: number,
 *     costUsd: number,
 *   }>,
 * } | null>}
 */
export async function gatherAgentUsage({ projectDir, slug } = {}) {
  if (!projectDir) throw new Error('gatherAgentUsage: projectDir is required');
  if (!slug) throw new Error('gatherAgentUsage: slug is required');
  const dataDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir });
  const config = configs.find((c) => c.id === slug);
  if (!config) return null;

  // Timezone-aware Monday anchor — matches the heartbeat + `/aweek:summary`
  // derivation. Fall back to UTC on config-load errors so a malformed
  // `.aweek/config.json` never knocks the dashboard offline.
  let timeZone;
  try {
    ({ timeZone } = await loadConfig(dataDir));
  } catch {
    timeZone = undefined;
  }
  const weekMondayDate = getMondayDate(new Date(), timeZone);
  const usageStore = new UsageStore(dataDir);

  const [identity, currentUsage, weekKeys] = await Promise.all([
    readSubagentIdentity(slug, projectDir).catch(() => ({
      missing: true,
      name: '',
    })),
    usageStore.weeklyTotal(slug, weekMondayDate).catch(() => ({
      weekMonday: weekMondayDate,
      recordCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    })),
    // `listWeeks` touches the usage dir; missing dir → empty list.
    usageStore.listWeeks(slug).catch(() => []),
  ]);

  // Build historical per-week roll-up. The store throws when a week
  // file is malformed; we catch individually so one bad week does not
  // zero out the whole history.
  const weeks = await Promise.all(
    weekKeys.map((weekMonday) =>
      usageStore.weeklyTotal(slug, weekMonday).catch(() => ({
        weekMonday,
        recordCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      })),
    ),
  );
  // listWeeks already returns ascending, but re-sort defensively in
  // case the underlying filesystem returns a different order.
  weeks.sort((a, b) => a.weekMonday.localeCompare(b.weekMonday));

  const derived = deriveBudget(config, currentUsage);

  return {
    slug,
    name: identity.missing ? slug : identity.name || slug,
    missing: !!identity.missing,
    paused: !!config.budget?.paused,
    pausedReason: config.budget?.pausedReason || null,
    weekMonday: weekMondayDate,
    tokenLimit: derived.tokenLimit,
    tokensUsed: derived.tokensUsed,
    inputTokens: currentUsage.inputTokens || 0,
    outputTokens: currentUsage.outputTokens || 0,
    costUsd: currentUsage.costUsd || 0,
    recordCount: currentUsage.recordCount || 0,
    remaining: derived.remaining,
    overBudget: derived.overBudget,
    utilizationPct: derived.utilizationPct,
    weeks,
  };
}
