/**
 * Budget Enforcer — compares token usage against per-agent weekly budget,
 * pauses agents when exhausted, and writes alert flag files for notification.
 *
 * Design:
 * - Reads agent config to get weeklyTokenBudget
 * - Queries UsageStore for current week's total tokens
 * - If usage >= budget: sets budget.paused = true in agent config, writes alert flag
 * - Alert flags are written to .aweek/agents/<agentId>/alerts/budget-exhausted-<week>.json
 * - Idempotent: re-checking an already-paused agent is a no-op (no duplicate alerts)
 * - Returns structured enforcement result for callers to act on
 *
 * Budget period resets each Monday (aligned with UsageStore week keys).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getMondayDate } from '../storage/usage-store.js';
import type { AgentStore } from '../storage/agent-store.js';
import type { UsageStore } from '../storage/usage-store.js';
import type { Agent } from '../schemas/agent.js';

/**
 * @typedef {object} EnforcementResult
 * @property {string} agentId - Agent that was checked
 * @property {string} weekMonday - Budget period (Monday date)
 * @property {number} used - Total tokens used this week
 * @property {number} budget - Weekly token budget limit
 * @property {number} remaining - Tokens remaining (0 if exhausted)
 * @property {boolean} exceeded - Whether usage >= budget
 * @property {boolean} paused - Whether the agent is now paused
 * @property {boolean} alertWritten - Whether a new alert flag was written (false if already existed)
 * @property {string|null} alertPath - Path to the alert file (null if not exceeded)
 */
export interface EnforcementResult {
  agentId: string;
  weekMonday: string;
  used: number;
  budget: number;
  remaining: number;
  exceeded: boolean;
  paused: boolean;
  alertWritten: boolean;
  alertPath: string | null;
}

/**
 * Loose shape of the agent config that the budget enforcer reads/writes.
 */
export interface BudgetAgentConfig {
  id?: string;
  weeklyTokenBudget?: number;
  budget: {
    weeklyTokenLimit?: number;
    paused?: boolean;
    currentUsage?: number;
    periodStart?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface BudgetEnforcerDeps {
  agentStore: AgentStore;
  usageStore: UsageStore;
  baseDir?: string;
}

interface AlertDetails {
  agentId: string;
  weekMonday: string;
  used: number;
  budget: number;
  timestamp?: string;
}

interface BudgetAlertFile {
  type: 'budget-exhausted';
  agentId: string;
  weekMonday: string;
  used: number;
  budget: number;
  exceededBy: number;
  timestamp: string;
  message: string;
}

/**
 * Path to the alerts directory for an agent.
 * @param {string} baseDir - Root agents directory
 * @param {string} agentId
 * @returns {string}
 */
export function alertsDir(baseDir: string, agentId: string): string {
  return join(baseDir, agentId, 'alerts');
}

/**
 * Path to a specific budget-exhausted alert file.
 * @param {string} baseDir - Root agents directory
 * @param {string} agentId
 * @param {string} weekMonday - Monday date string
 * @returns {string}
 */
export function alertFilePath(baseDir: string, agentId: string, weekMonday: string): string {
  return join(alertsDir(baseDir, agentId), `budget-exhausted-${weekMonday}.json`);
}

/**
 * Check if an alert file already exists.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function alertExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf-8');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Write a budget-exhausted alert flag file.
 * Contains structured JSON with enforcement details for downstream consumers.
 *
 * @param {string} filePath - Alert file path
 * @param {object} details - Alert details
 * @returns {Promise<void>}
 */
async function writeAlert(filePath: string, details: AlertDetails): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });

  const alert: BudgetAlertFile = {
    type: 'budget-exhausted',
    agentId: details.agentId,
    weekMonday: details.weekMonday,
    used: details.used,
    budget: details.budget,
    exceededBy: details.used - details.budget,
    timestamp: details.timestamp || new Date().toISOString(),
    message: `Agent "${details.agentId}" has exhausted its weekly token budget. Used ${details.used} of ${details.budget} tokens (week ${details.weekMonday}). Agent has been paused. Resume manually after reviewing usage.`,
  };

  await writeFile(filePath, JSON.stringify(alert, null, 2) + '\n', 'utf-8');
}

/**
 * Enforce the budget for a single agent.
 *
 * Compares the agent's current week token usage against their weeklyTokenBudget.
 * If exhausted: pauses the agent in the config and writes an alert flag file.
 * Idempotent: if already paused with an existing alert, no duplicate writes occur.
 *
 * @param {string} agentId - Agent to check
 * @param {object} deps - Required dependencies
 * @param {import('../storage/agent-store.js').AgentStore} deps.agentStore - Agent config store
 * @param {import('../storage/usage-store.js').UsageStore} deps.usageStore - Token usage store
 * @param {string} [deps.baseDir] - Base agents directory (for alert files). If not provided, derived from agentStore.baseDir.
 * @param {string} [weekMonday] - Explicit week key; defaults to current week
 * @param {string} [timestamp] - Explicit timestamp for alert; defaults to now
 * @returns {Promise<EnforcementResult>}
 */
export async function enforceBudget(
  agentId: string,
  deps: BudgetEnforcerDeps,
  weekMonday?: string,
  timestamp?: string,
): Promise<EnforcementResult> {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agentId is required and must be a string');
  }
  if (!deps?.agentStore) {
    throw new Error('agentStore dependency is required');
  }
  if (!deps?.usageStore) {
    throw new Error('usageStore dependency is required');
  }

  const { agentStore, usageStore } = deps;
  const baseDir = deps.baseDir || agentStore.baseDir;
  const monday = weekMonday || getMondayDate();

  // Load agent config to get budget limit
  // Cast through `unknown`: AgentStore.load returns the strict `Agent`
  // shape (post-storage-seed), and `BudgetAgentConfig` is a deliberately
  // loose local mirror with index signatures so this enforcer can read
  // legacy agents that still carry extra keys. The runtime invariants
  // (validated by the agent schema before save) make the structural
  // cast safe.
  const config = (await agentStore.load(agentId)) as unknown as BudgetAgentConfig;
  const budgetLimit = config.weeklyTokenBudget || config.budget?.weeklyTokenLimit || 0;

  if (budgetLimit <= 0) {
    // No budget set — cannot enforce
    return {
      agentId,
      weekMonday: monday,
      used: 0,
      budget: 0,
      remaining: 0,
      exceeded: false,
      paused: config.budget?.paused || false,
      alertWritten: false,
      alertPath: null,
    };
  }

  // Get current week's usage totals
  const totals = await usageStore.weeklyTotal(agentId, monday);
  const used = totals.totalTokens;
  const remaining = Math.max(0, budgetLimit - used);
  const exceeded = used >= budgetLimit;

  const result: EnforcementResult = {
    agentId,
    weekMonday: monday,
    used,
    budget: budgetLimit,
    remaining,
    exceeded,
    paused: config.budget?.paused || false,
    alertWritten: false,
    alertPath: null,
  };

  if (!exceeded) {
    return result;
  }

  // Budget exceeded — pause agent and write alert
  const aPath = alertFilePath(baseDir, agentId, monday);
  result.alertPath = aPath;

  // Check if already paused and alert already exists (idempotent)
  const alreadyAlerted = await alertExists(aPath);

  if (!config.budget.paused) {
    // Pause the agent
    await agentStore.update(agentId, ((cfg: BudgetAgentConfig) => {
      cfg.budget.paused = true;
      cfg.budget.currentUsage = used;
      return cfg;
    }) as unknown as (cfg: Agent) => Agent);
    result.paused = true;
  }

  if (!alreadyAlerted) {
    // Write the alert flag file
    await writeAlert(aPath, {
      agentId,
      weekMonday: monday,
      used,
      budget: budgetLimit,
      timestamp: timestamp || new Date().toISOString(),
    });
    result.alertWritten = true;
  }

  return result;
}

/**
 * Enforce budgets for all agents.
 *
 * @param {object} deps - Required dependencies
 * @param {import('../storage/agent-store.js').AgentStore} deps.agentStore
 * @param {import('../storage/usage-store.js').UsageStore} deps.usageStore
 * @param {string} [deps.baseDir]
 * @param {string} [weekMonday]
 * @returns {Promise<EnforcementResult[]>}
 */
export async function enforceAllBudgets(
  deps: BudgetEnforcerDeps,
  weekMonday?: string,
): Promise<EnforcementResult[]> {
  if (!deps?.agentStore) {
    throw new Error('agentStore dependency is required');
  }

  const agentIds = await deps.agentStore.list();
  const results: EnforcementResult[] = [];

  for (const agentId of agentIds) {
    const result = await enforceBudget(agentId, deps, weekMonday);
    results.push(result);
  }

  return results;
}

/**
 * Check if an agent is paused due to budget exhaustion.
 * Quick check without full enforcement — just reads agent config.
 *
 * @param {string} agentId
 * @param {object} deps
 * @param {import('../storage/agent-store.js').AgentStore} deps.agentStore
 * @returns {Promise<boolean>}
 */
export async function isAgentPaused(
  agentId: string,
  deps: { agentStore: AgentStore },
): Promise<boolean> {
  if (!deps?.agentStore) {
    throw new Error('agentStore dependency is required');
  }
  const config = (await deps.agentStore.load(agentId)) as unknown as BudgetAgentConfig;
  return config.budget?.paused === true;
}

/**
 * Resume an agent that was paused due to budget exhaustion.
 * Clears the paused flag in agent config.
 *
 * @param {string} agentId
 * @param {object} deps
 * @param {import('../storage/agent-store.js').AgentStore} deps.agentStore
 * @returns {Promise<object>} Updated agent config
 */
export async function resumeAgent(
  agentId: string,
  deps: { agentStore: AgentStore },
): Promise<BudgetAgentConfig> {
  if (!deps?.agentStore) {
    throw new Error('agentStore dependency is required');
  }
  return deps.agentStore.update(agentId, ((cfg: BudgetAgentConfig) => {
    cfg.budget.paused = false;
    return cfg;
  }) as unknown as (cfg: Agent) => Agent) as unknown as Promise<BudgetAgentConfig>;
}

/**
 * @typedef {object} TopUpResult
 * @property {string} agentId - Agent that was topped up
 * @property {boolean} wasPaused - Whether the agent was paused before top-up
 * @property {boolean} resumed - Whether the agent was resumed (true if was paused)
 * @property {number} previousUsage - Token usage before reset
 * @property {number} previousLimit - Budget limit before top-up
 * @property {number} newLimit - Budget limit after top-up
 * @property {string} periodStart - New budget period start date
 * @property {string} timestamp - When the top-up occurred
 */
export interface TopUpResult {
  agentId: string;
  wasPaused: boolean;
  resumed: boolean;
  previousUsage: number;
  previousLimit: number;
  newLimit: number;
  periodStart: string;
  timestamp: string;
}

export interface TopUpOptions {
  newLimit?: number;
  timestamp?: string;
}

/**
 * Top up an agent's token budget and resume from paused state.
 *
 * Resets the agent's current usage to zero, optionally sets a new weekly budget limit,
 * and changes the agent status from paused to active. This is the primary mechanism
 * for unblocking a budget-paused agent.
 *
 * Idempotent: calling on an already-active agent with no newLimit is a safe no-op
 * (usage still resets, status remains active).
 *
 * @param {string} agentId - Agent to top up
 * @param {object} deps - Required dependencies
 * @param {import('../storage/agent-store.js').AgentStore} deps.agentStore - Agent config store
 * @param {object} [options={}] - Top-up options
 * @param {number} [options.newLimit] - New weekly token budget limit (keeps current if omitted)
 * @param {string} [options.timestamp] - Explicit timestamp; defaults to now
 * @returns {Promise<TopUpResult>}
 */
export async function topUpResume(
  agentId: string,
  deps: { agentStore: AgentStore },
  options: TopUpOptions = {},
): Promise<TopUpResult> {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agentId is required and must be a string');
  }
  if (!deps?.agentStore) {
    throw new Error('agentStore dependency is required');
  }
  if (options.newLimit !== undefined) {
    if (typeof options.newLimit !== 'number' || options.newLimit <= 0) {
      throw new Error('newLimit must be a positive number');
    }
  }

  const config = (await deps.agentStore.load(agentId)) as unknown as BudgetAgentConfig;
  const wasPaused = config.budget?.paused === true;
  const previousUsage = config.budget?.currentUsage || 0;
  const previousLimit = config.weeklyTokenBudget || config.budget?.weeklyTokenLimit || 0;
  const newLimit = options.newLimit || previousLimit;
  const ts = options.timestamp || new Date().toISOString();
  const mondayDate = getMondayDate();
  const newPeriodStart = `${mondayDate}T00:00:00.000Z`;

  await deps.agentStore.update(agentId, ((cfg: BudgetAgentConfig) => {
    // Reset usage to zero
    cfg.budget.currentUsage = 0;
    cfg.budget.periodStart = newPeriodStart;
    // Resume from paused state
    cfg.budget.paused = false;
    // Update budget limit if a new one was provided
    if (options.newLimit !== undefined) {
      cfg.budget.weeklyTokenLimit = newLimit;
      cfg.weeklyTokenBudget = newLimit;
    }
    return cfg;
  }) as unknown as (cfg: Agent) => Agent);

  return {
    agentId,
    wasPaused,
    resumed: wasPaused,
    previousUsage,
    previousLimit,
    newLimit,
    periodStart: newPeriodStart,
    timestamp: ts,
  };
}

/**
 * Load an existing alert for an agent/week.
 *
 * @param {string} baseDir - Root agents directory
 * @param {string} agentId
 * @param {string} [weekMonday] - Defaults to current week
 * @returns {Promise<object|null>} Alert data or null if no alert
 */
export async function loadAlert(
  baseDir: string,
  agentId: string,
  weekMonday?: string,
): Promise<BudgetAlertFile | null> {
  const monday = weekMonday || getMondayDate();
  const filePath = alertFilePath(baseDir, agentId, monday);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as BudgetAlertFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface BudgetEnforcerInstance {
  enforce: (agentId: string, weekMonday?: string, timestamp?: string) => Promise<EnforcementResult>;
  enforceAll: (weekMonday?: string) => Promise<EnforcementResult[]>;
  isPaused: (agentId: string) => Promise<boolean>;
  resume: (agentId: string) => Promise<BudgetAgentConfig>;
  topUp: (agentId: string, options?: TopUpOptions) => Promise<TopUpResult>;
  loadAlert: (agentId: string, weekMonday?: string) => Promise<BudgetAlertFile | null>;
}

/**
 * Create a bound budget enforcer instance.
 *
 * @param {object} config
 * @param {import('../storage/agent-store.js').AgentStore} config.agentStore
 * @param {import('../storage/usage-store.js').UsageStore} config.usageStore
 * @param {string} [config.baseDir]
 * @returns {{ enforce: function, enforceAll: function, isPaused: function, resume: function, topUp: function, loadAlert: function }}
 */
export function createBudgetEnforcer(config: Partial<BudgetEnforcerDeps> = {}): BudgetEnforcerInstance {
  const { agentStore, usageStore } = config;
  if (!agentStore) throw new Error('agentStore is required');
  if (!usageStore) throw new Error('usageStore is required');

  const deps: BudgetEnforcerDeps = { agentStore, usageStore, baseDir: config.baseDir };

  return {
    enforce: (agentId: string, weekMonday?: string, timestamp?: string) =>
      enforceBudget(agentId, deps, weekMonday, timestamp),
    enforceAll: (weekMonday?: string) => enforceAllBudgets(deps, weekMonday),
    isPaused: (agentId: string) => isAgentPaused(agentId, deps),
    resume: (agentId: string) => resumeAgent(agentId, deps),
    topUp: (agentId: string, options?: TopUpOptions) => topUpResume(agentId, deps, options),
    loadAlert: (agentId: string, weekMonday?: string) =>
      loadAlert(deps.baseDir || agentStore.baseDir, agentId, weekMonday),
  };
}
