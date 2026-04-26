/**
 * Weekly review data collector.
 *
 * Given an agent slug and ISO week key, reads the activity log, weekly plan
 * tasks, and budget/usage data for the completed week and returns a structured
 * snapshot object ready for downstream report generation.
 *
 * This module is the single I/O layer for the review pipeline — downstream
 * generators (weekly-review-orchestrator, daily-review-generator, etc.) receive
 * the pre-collected snapshot and never need to reach into stores directly.
 *
 * Design:
 *   - Dependency injection: stores are passed in, not imported globally.
 *   - Uses isReviewObjectiveId() to split tasks into work tasks vs. review slots.
 *     Never hardcodes the reserved objectiveId strings.
 *   - Read-only: no writes occur here.
 *   - Missing files/stores produce sensible empty defaults, never thrown errors
 *     (except for programmer errors like a missing agentId).
 *
 * Output shape (CollectedWeekData):
 *   {
 *     agentId,          // string — the agent slug
 *     week,             // ISO week string (YYYY-Www)
 *     weekMonday,       // Monday date (YYYY-MM-DD) for the week
 *     collectedAt,      // ISO datetime when the snapshot was taken
 *     plan: {
 *       exists,         // boolean — false when no plan file was found
 *       approved,       // boolean
 *       createdAt,      // ISO datetime or null
 *       allTasks,       // raw task array from the plan
 *       workTasks,      // non-review tasks (objectiveId not in reserved set)
 *       reviewTasks,    // review-slot tasks (objectiveId in reserved set)
 *     },
 *     activityLog: {
 *       entries,        // raw log entries for the week
 *       byStatus,       // { [status]: entry[] }
 *       totalDurationMs,// summed duration across all entries
 *     },
 *     budget: {
 *       weeklyTokenLimit,  // number — configured limit (0 = no limit configured)
 *       inputTokens,       // number
 *       outputTokens,      // number
 *       totalTokens,       // number
 *       costUsd,           // number
 *       sessionCount,      // number — usage records for the week
 *       remainingTokens,   // number | null — null when weeklyTokenLimit === 0
 *       utilizationPct,    // number | null — 0–100; null when weeklyTokenLimit === 0
 *       paused,            // boolean — whether agent is paused for budget exhaustion
 *     },
 *   }
 */

import { isReviewObjectiveId } from '../schemas/weekly-plan.schema.js';
import { mondayFromISOWeek } from './weekly-data-aggregator.js';

export interface CollectorTask {
  id?: string;
  title?: string;
  prompt?: string;
  objectiveId?: string;
  status?: string;
  priority?: string;
  completedAt?: string | null;
  estimatedMinutes?: number | null;
  [key: string]: unknown;
}

export interface CollectorLogEntry {
  id?: string;
  timestamp?: string;
  agentId?: string;
  status?: string;
  title?: string;
  duration?: number;
  taskId?: string | null;
  metadata?: unknown;
  [key: string]: unknown;
}

interface CollectorPlan {
  week?: string;
  month?: string;
  approved?: boolean;
  createdAt?: string;
  tasks?: CollectorTask[];
  [key: string]: unknown;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  recordCount: number;
}

interface AgentBudget {
  weeklyTokenBudget?: number;
  budget?: {
    weeklyTokenLimit?: number;
    paused?: boolean;
  };
  [key: string]: unknown;
}

interface WeeklyPlanStoreLike {
  load(agentId: string, week: string): Promise<CollectorPlan>;
}

interface ActivityLogStoreLike {
  load(agentId: string, weekMonday: string): Promise<CollectorLogEntry[]>;
}

interface UsageStoreLike {
  weeklyTotal(agentId: string, weekMonday: string): Promise<UsageTotals>;
}

interface AgentStoreLike {
  load(agentId: string): Promise<AgentBudget>;
}

interface CollectorDeps {
  weeklyPlanStore: WeeklyPlanStoreLike;
  activityLogStore: ActivityLogStoreLike;
  usageStore?: UsageStoreLike;
  agentStore?: AgentStoreLike;
}

interface CollectorOpts {
  weekMonday?: string;
  collectedAt?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely load the weekly plan for an agent/week.
 * Returns { plan: object, exists: boolean } without throwing on ENOENT.
 *
 * @param {object} weeklyPlanStore
 * @param {string} agentId
 * @param {string} week
 * @returns {Promise<{ plan: object|null, exists: boolean }>}
 */
async function safeLoadPlan(
  weeklyPlanStore: WeeklyPlanStoreLike,
  agentId: string,
  week: string,
): Promise<{ plan: CollectorPlan | null; exists: boolean }> {
  try {
    const plan = await weeklyPlanStore.load(agentId, week);
    return { plan, exists: true };
  } catch {
    return { plan: null, exists: false };
  }
}

/**
 * Safely load activity log entries for an agent/week Monday.
 * Returns an empty array on missing file.
 *
 * @param {object} activityLogStore
 * @param {string} agentId
 * @param {string} weekMonday - YYYY-MM-DD
 * @returns {Promise<object[]>}
 */
async function safeLoadLog(
  activityLogStore: ActivityLogStoreLike,
  agentId: string,
  weekMonday: string,
): Promise<CollectorLogEntry[]> {
  try {
    return await activityLogStore.load(agentId, weekMonday);
  } catch {
    return [];
  }
}

/**
 * Safely load token usage totals for an agent/week Monday.
 * Returns a zero-valued total on missing data.
 *
 * @param {object} usageStore
 * @param {string} agentId
 * @param {string} weekMonday - YYYY-MM-DD
 * @returns {Promise<{ inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number, recordCount: number }>}
 */
async function safeLoadUsageTotals(
  usageStore: UsageStoreLike | undefined,
  agentId: string,
  weekMonday: string,
): Promise<UsageTotals> {
  const zero: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    recordCount: 0,
  };
  if (!usageStore) return zero;
  try {
    return await usageStore.weeklyTotal(agentId, weekMonday);
  } catch {
    return zero;
  }
}

/**
 * Safely load the agent config to read the weekly token budget limit and
 * the current paused flag.
 *
 * @param {object|undefined} agentStore
 * @param {string} agentId
 * @returns {Promise<{ weeklyTokenLimit: number, paused: boolean }>}
 */
async function safeLoadAgentBudgetConfig(
  agentStore: AgentStoreLike | undefined,
  agentId: string,
): Promise<{ weeklyTokenLimit: number; paused: boolean }> {
  const defaults = { weeklyTokenLimit: 0, paused: false };
  if (!agentStore) return defaults;
  try {
    const config = await agentStore.load(agentId);
    const limit =
      config.weeklyTokenBudget ||
      config.budget?.weeklyTokenLimit ||
      0;
    const paused = config.budget?.paused === true;
    return { weeklyTokenLimit: limit, paused };
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Exported helpers (also useful for tests)
// ---------------------------------------------------------------------------

/**
 * Split a flat task array into work tasks and review tasks.
 * Uses isReviewObjectiveId() — never hardcodes the reserved strings.
 *
 * @param {object[]} tasks
 * @returns {{ workTasks: object[], reviewTasks: object[] }}
 */
export function splitTasksByType(
  tasks: CollectorTask[] | null | undefined,
): { workTasks: CollectorTask[]; reviewTasks: CollectorTask[] } {
  if (!Array.isArray(tasks)) return { workTasks: [], reviewTasks: [] };
  const workTasks: CollectorTask[] = [];
  const reviewTasks: CollectorTask[] = [];
  for (const task of tasks) {
    if (isReviewObjectiveId(task.objectiveId)) {
      reviewTasks.push(task);
    } else {
      workTasks.push(task);
    }
  }
  return { workTasks, reviewTasks };
}

/**
 * Group an array of activity log entries by status.
 *
 * @param {object[]} entries
 * @returns {{ [status: string]: object[] }}
 */
export function groupLogEntriesByStatus(
  entries: CollectorLogEntry[],
): Record<string, CollectorLogEntry[]> {
  const groups: Record<string, CollectorLogEntry[]> = {};
  for (const entry of entries) {
    const s = entry.status || 'unknown';
    if (!groups[s]) groups[s] = [];
    groups[s].push(entry);
  }
  return groups;
}

/**
 * Compute budget utilization fields from raw numbers.
 *
 * @param {number} totalTokens - Tokens consumed this week
 * @param {number} weeklyTokenLimit - Configured limit (0 = no limit)
 * @returns {{ remainingTokens: number|null, utilizationPct: number|null }}
 */
export function computeBudgetUtilization(
  totalTokens: number,
  weeklyTokenLimit: number,
): { remainingTokens: number | null; utilizationPct: number | null } {
  if (!weeklyTokenLimit) {
    return { remainingTokens: null, utilizationPct: null };
  }
  const remainingTokens = Math.max(0, weeklyTokenLimit - totalTokens);
  const utilizationPct = Math.min(
    100,
    Math.round((totalTokens / weeklyTokenLimit) * 100),
  );
  return { remainingTokens, utilizationPct };
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export interface CollectedWeekData {
  agentId: string;
  week: string;
  weekMonday: string;
  collectedAt: string;
  plan: {
    exists: boolean;
    approved: boolean;
    createdAt: string | null;
    allTasks: CollectorTask[];
    workTasks: CollectorTask[];
    reviewTasks: CollectorTask[];
  };
  activityLog: {
    entries: CollectorLogEntry[];
    byStatus: Record<string, CollectorLogEntry[]>;
    totalDurationMs: number;
  };
  budget: {
    weeklyTokenLimit: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    sessionCount: number;
    remainingTokens: number | null;
    utilizationPct: number | null;
    paused: boolean;
  };
}

/**
 * Collect all data needed to generate a weekly review for a given agent and week.
 *
 * @param {object} deps - Injected store dependencies
 * @param {object} deps.weeklyPlanStore - WeeklyPlanStore instance
 * @param {object} deps.activityLogStore - ActivityLogStore instance
 * @param {object} [deps.usageStore] - UsageStore instance (optional; budget fields default to zero)
 * @param {object} [deps.agentStore] - AgentStore instance (optional; budget config defaults to no-limit)
 * @param {string} agentId - Agent slug to collect data for
 * @param {string} week - ISO week string (YYYY-Www)
 * @param {object} [opts]
 * @param {string} [opts.weekMonday] - Override Monday date (YYYY-MM-DD); auto-derived from week if omitted
 * @param {string} [opts.collectedAt] - Override collection timestamp (ISO datetime)
 * @returns {Promise<CollectedWeekData>}
 */
export async function collectWeeklyReviewData(
  deps: CollectorDeps,
  agentId: string,
  week: string,
  opts: CollectorOpts = {},
): Promise<CollectedWeekData> {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agentId is required and must be a string');
  }
  if (!week || typeof week !== 'string') {
    throw new Error('week is required and must be a string (YYYY-Www)');
  }

  const { weeklyPlanStore, activityLogStore, usageStore, agentStore } = deps;
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore dependency is required');
  if (!activityLogStore) throw new Error('activityLogStore dependency is required');

  const weekMonday = opts.weekMonday || mondayFromISOWeek(week);
  const collectedAt = opts.collectedAt || new Date().toISOString();

  // Collect all three data sources in parallel.
  const [planResult, logEntries, usageTotals, budgetConfig] = await Promise.all([
    safeLoadPlan(weeklyPlanStore, agentId, week),
    safeLoadLog(activityLogStore, agentId, weekMonday),
    safeLoadUsageTotals(usageStore, agentId, weekMonday),
    safeLoadAgentBudgetConfig(agentStore, agentId),
  ]);

  // ── Plan ──────────────────────────────────────────────────────────────────
  const allTasks: CollectorTask[] = planResult.plan?.tasks || [];
  const { workTasks, reviewTasks } = splitTasksByType(allTasks);

  const plan = {
    exists: planResult.exists,
    approved: planResult.plan ? !!planResult.plan.approved : false,
    createdAt: planResult.plan?.createdAt || null,
    allTasks,
    workTasks,
    reviewTasks,
  };

  // ── Activity log ──────────────────────────────────────────────────────────
  const byStatus = groupLogEntriesByStatus(logEntries);
  const totalDurationMs = logEntries.reduce(
    (sum, e) => sum + (e.duration || 0),
    0,
  );

  const activityLog = {
    entries: logEntries,
    byStatus,
    totalDurationMs,
  };

  // ── Budget ────────────────────────────────────────────────────────────────
  const { weeklyTokenLimit, paused } = budgetConfig;
  const { remainingTokens, utilizationPct } = computeBudgetUtilization(
    usageTotals.totalTokens,
    weeklyTokenLimit,
  );

  const budget = {
    weeklyTokenLimit,
    inputTokens: usageTotals.inputTokens,
    outputTokens: usageTotals.outputTokens,
    totalTokens: usageTotals.totalTokens,
    costUsd: usageTotals.costUsd,
    sessionCount: usageTotals.recordCount,
    remainingTokens,
    utilizationPct,
    paused,
  };

  return {
    agentId,
    week,
    weekMonday,
    collectedAt,
    plan,
    activityLog,
    budget,
  };
}
