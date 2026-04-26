/**
 * Token Tracking Recorder — accepts agent ID and token counts,
 * resolves the current week key, and calls the usage store to accumulate usage.
 *
 * This is a higher-level convenience layer over UsageStore + createUsageRecord.
 * It simplifies the common pattern of "record some token usage for an agent"
 * without needing to manually construct records or resolve week keys.
 *
 * Design:
 * - Resolves week key automatically via getMondayDate() (budget period = Monday–Sunday)
 * - Creates a valid usage record and appends it to the store
 * - Returns both the record and current weekly totals for budget checking
 * - Idempotent: UsageStore deduplicates by record ID
 * - Graceful: returns error info instead of throwing on store failures
 */

import { UsageStore, createUsageRecord, getMondayDate } from '../storage/usage-store.js';

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface RecordingContext {
  taskId?: string;
  sessionId?: string;
  durationMs?: number;
  model?: string;
  week?: string;
  timestamp?: string;
}

export interface WeeklyTotals {
  weekMonday: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordCount: number;
}

export interface UsageRecordShape {
  agentId: string;
  taskId: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs?: number;
  model?: string;
  week: string;
  timestamp: string;
}

export interface RecordingResult {
  success: boolean;
  record: UsageRecordShape | null;
  weeklyTotals: WeeklyTotals | null;
  error: string | null;
}

interface TokenTrackerDeps {
  usageStore?: UsageStore;
}

/**
 * @typedef {object} TokenCounts
 * @property {number} inputTokens - Input tokens consumed
 * @property {number} outputTokens - Output tokens consumed
 * @property {number} [costUsd=0] - Estimated cost in USD
 */

/**
 * @typedef {object} RecordingContext
 * @property {string} [taskId='unknown'] - Task identifier
 * @property {string} [sessionId] - Session identifier
 * @property {number} [durationMs] - Session duration in ms
 * @property {string} [model] - Model used
 * @property {string} [week] - Explicit week key (Monday date); defaults to current week
 * @property {string} [timestamp] - Explicit timestamp; defaults to now
 */

/**
 * @typedef {object} RecordingResult
 * @property {boolean} success - Whether recording succeeded
 * @property {object|null} record - The created usage record (null on failure)
 * @property {{ weekMonday: string, totalTokens: number, inputTokens: number, outputTokens: number, costUsd: number, recordCount: number }|null} weeklyTotals - Current week totals after recording (null on failure)
 * @property {string|null} error - Error message if recording failed
 */

/**
 * Record token usage for an agent.
 *
 * Resolves the current week key, creates a usage record, persists it,
 * and returns the updated weekly totals for budget enforcement.
 *
 * @param {string} agentId - Agent identifier
 * @param {TokenCounts} tokens - Token counts to record
 * @param {RecordingContext} [context={}] - Additional recording context
 * @param {object} [deps] - Injectable dependencies
 * @param {UsageStore} [deps.usageStore] - UsageStore instance
 * @returns {Promise<RecordingResult>}
 */
export async function recordTokenUsage(
  agentId: unknown,
  tokens: unknown,
  context: RecordingContext = {},
  deps: TokenTrackerDeps = {},
): Promise<RecordingResult> {
  if (!agentId || typeof agentId !== 'string') {
    return { success: false, record: null, weeklyTotals: null, error: 'agentId is required and must be a string' };
  }
  const t = tokens as TokenCounts | null | undefined;
  if (!t || typeof t.inputTokens !== 'number' || typeof t.outputTokens !== 'number') {
    return { success: false, record: null, weeklyTotals: null, error: 'tokens must include numeric inputTokens and outputTokens' };
  }

  const { usageStore } = deps;
  if (!usageStore) {
    return { success: false, record: null, weeklyTotals: null, error: 'usageStore dependency is required' };
  }

  const weekKey = context.week || getMondayDate();

  try {
    const record = createUsageRecord({
      agentId,
      taskId: context.taskId || 'unknown',
      sessionId: context.sessionId,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      costUsd: t.costUsd || 0,
      durationMs: context.durationMs,
      model: context.model,
      week: weekKey,
      timestamp: context.timestamp,
    }) as UsageRecordShape;

    await usageStore.append(agentId, record);

    const weeklyTotals = (await usageStore.weeklyTotal(agentId, weekKey)) as WeeklyTotals;

    return {
      success: true,
      record,
      weeklyTotals,
      error: null,
    };
  } catch (err) {
    return {
      success: false,
      record: null,
      weeklyTotals: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Get current week's token usage totals for an agent.
 *
 * Convenience wrapper for checking budget status without recording new usage.
 *
 * @param {string} agentId - Agent identifier
 * @param {object} [deps] - Injectable dependencies
 * @param {UsageStore} [deps.usageStore] - UsageStore instance
 * @param {string} [weekMonday] - Explicit week key; defaults to current week
 * @returns {Promise<{ weekMonday: string, totalTokens: number, inputTokens: number, outputTokens: number, costUsd: number, recordCount: number }>}
 */
export async function getWeeklyUsage(
  agentId: unknown,
  deps: TokenTrackerDeps = {},
  weekMonday?: string,
): Promise<WeeklyTotals> {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agentId is required and must be a string');
  }
  const { usageStore } = deps;
  if (!usageStore) {
    throw new Error('usageStore dependency is required');
  }
  const monday = weekMonday || getMondayDate();
  return (await usageStore.weeklyTotal(agentId, monday)) as WeeklyTotals;
}

export interface BudgetStatus {
  exceeded: boolean;
  used: number;
  budget: number;
  remaining: number;
  weekMonday: string;
}

/**
 * Check whether an agent has exceeded its token budget for the current week.
 *
 * @param {string} agentId - Agent identifier
 * @param {number} budgetTokens - Maximum allowed tokens for the week
 * @param {object} [deps] - Injectable dependencies
 * @param {UsageStore} [deps.usageStore] - UsageStore instance
 * @param {string} [weekMonday] - Explicit week key; defaults to current week
 * @returns {Promise<{ exceeded: boolean, used: number, budget: number, remaining: number, weekMonday: string }>}
 */
export async function checkBudget(
  agentId: unknown,
  budgetTokens: unknown,
  deps: TokenTrackerDeps = {},
  weekMonday?: string,
): Promise<BudgetStatus> {
  if (typeof budgetTokens !== 'number' || budgetTokens <= 0) {
    throw new Error('budgetTokens must be a positive number');
  }
  const totals = await getWeeklyUsage(agentId, deps, weekMonday);
  const used = totals.totalTokens;
  const remaining = Math.max(0, budgetTokens - used);
  return {
    exceeded: used >= budgetTokens,
    used,
    budget: budgetTokens,
    remaining,
    weekMonday: totals.weekMonday,
  };
}

export interface TokenTracker {
  record: (agentId: string, tokens: TokenCounts, context?: RecordingContext) => Promise<RecordingResult>;
  getUsage: (agentId: string, weekMonday?: string) => Promise<WeeklyTotals>;
  checkBudget: (agentId: string, budgetTokens: number, weekMonday?: string) => Promise<BudgetStatus>;
}

/**
 * Create a bound token tracker instance for a specific configuration.
 *
 * Factory that pre-binds the UsageStore so callers only need to pass
 * agentId and token counts.
 *
 * @param {object} config
 * @param {UsageStore} config.usageStore - UsageStore instance
 * @returns {{ record: function, getUsage: function, checkBudget: function }}
 */
export function createTokenTracker(config: TokenTrackerDeps = {}): TokenTracker {
  const { usageStore } = config;
  if (!usageStore) {
    throw new Error('usageStore is required to create a token tracker');
  }

  const deps = { usageStore };

  return {
    /**
     * Record token usage for an agent.
     * @param {string} agentId
     * @param {TokenCounts} tokens
     * @param {RecordingContext} [context]
     * @returns {Promise<RecordingResult>}
     */
    record: (agentId, tokens, context) => recordTokenUsage(agentId, tokens, context, deps),

    /**
     * Get weekly usage totals for an agent.
     * @param {string} agentId
     * @param {string} [weekMonday]
     * @returns {Promise<object>}
     */
    getUsage: (agentId, weekMonday) => getWeeklyUsage(agentId, deps, weekMonday),

    /**
     * Check budget status for an agent.
     * @param {string} agentId
     * @param {number} budgetTokens
     * @param {string} [weekMonday]
     * @returns {Promise<object>}
     */
    checkBudget: (agentId, budgetTokens, weekMonday) => checkBudget(agentId, budgetTokens, deps, weekMonday),
  };
}
