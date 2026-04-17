/**
 * Resume-agent skill logic.
 * Provides interactive override/resume capability to unpause budget-paused agents.
 *
 * Flow:
 *  1. List all agents, identify paused ones
 *  2. User selects which agent to resume
 *  3. Show current budget status and alert details
 *  4. User chooses: simple resume, top-up (reset usage + optional new limit), or cancel
 *  5. Execute the chosen action and confirm result
 *
 * Used by the /aweek:resume-agent Claude Code skill.
 */
import { AgentStore } from '../storage/agent-store.js';
import { UsageStore } from '../storage/usage-store.js';
import {
  isAgentPaused,
  resumeAgent,
  topUpResume,
  loadAlert,
  createBudgetEnforcer,
} from '../services/budget-enforcer.js';

/** Valid resume actions */
export const RESUME_ACTIONS = ['resume', 'top-up', 'cancel'];

/**
 * List all paused agents with their budget details.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - Base data directory (e.g., ./.aweek/agents)
 * @returns {Promise<{ paused: object[], active: string[], total: number }>}
 */
export async function listPausedAgents({ dataDir }) {
  if (!dataDir) throw new Error('dataDir is required');

  const agentStore = new AgentStore(dataDir);
  let allConfigs;
  try {
    allConfigs = await agentStore.loadAll();
  } catch {
    allConfigs = [];
  }

  const paused = [];
  const active = [];

  for (const config of allConfigs) {
    if (config.budget?.paused === true) {
      paused.push({
        id: config.id,
        name: config.identity.name,
        role: config.identity.role,
        budget: {
          weeklyTokenLimit: config.budget.weeklyTokenLimit || config.weeklyTokenBudget || 0,
          currentUsage: config.budget.currentUsage || 0,
          paused: true,
        },
      });
    } else {
      active.push(config.id);
    }
  }

  return { paused, active, total: allConfigs.length };
}

/**
 * Get detailed budget status for a specific paused agent.
 *
 * @param {string} agentId
 * @param {object} opts
 * @param {string} opts.dataDir - Base data directory
 * @param {string} [opts.weekMonday] - Week key (defaults to current)
 * @returns {Promise<object>} Detailed budget/alert info
 */
export async function getPausedAgentDetails(agentId, { dataDir, weekMonday }) {
  if (!agentId) throw new Error('agentId is required');
  if (!dataDir) throw new Error('dataDir is required');

  const agentStore = new AgentStore(dataDir);
  const usageStore = new UsageStore(dataDir);

  const config = await agentStore.load(agentId);
  const paused = config.budget?.paused === true;

  if (!paused) {
    return {
      agentId,
      paused: false,
      message: `Agent "${agentId}" is not paused — no action needed.`,
    };
  }

  const budgetLimit = config.weeklyTokenBudget || config.budget?.weeklyTokenLimit || 0;
  const currentUsage = config.budget?.currentUsage || 0;

  // Try loading the alert for context
  const alert = await loadAlert(dataDir, agentId, weekMonday);

  // Try getting actual usage from store
  let usageTotals = null;
  try {
    usageTotals = await usageStore.weeklyTotal(agentId, weekMonday);
  } catch {
    // Usage store may not exist yet
  }

  return {
    agentId,
    name: config.identity.name,
    role: config.identity.role,
    paused: true,
    budget: {
      weeklyTokenLimit: budgetLimit,
      currentUsage,
      storeUsage: usageTotals?.totalTokens || currentUsage,
      exceededBy: Math.max(0, currentUsage - budgetLimit),
    },
    alert: alert ? {
      timestamp: alert.timestamp,
      message: alert.message,
      exceededBy: alert.exceededBy,
    } : null,
  };
}

/**
 * Validate the user's chosen resume action.
 *
 * @param {string} action - One of RESUME_ACTIONS
 * @param {object} [options] - Additional options for top-up
 * @param {number} [options.newLimit] - New budget limit (for top-up)
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateResumeAction(action, options = {}) {
  if (!action || !RESUME_ACTIONS.includes(action)) {
    return { valid: false, error: `Invalid action "${action}". Must be one of: ${RESUME_ACTIONS.join(', ')}` };
  }
  if (action === 'top-up' && options.newLimit !== undefined) {
    if (typeof options.newLimit !== 'number' || options.newLimit <= 0) {
      return { valid: false, error: 'newLimit must be a positive number' };
    }
  }
  return { valid: true };
}

/**
 * Execute the resume/top-up action on a paused agent.
 *
 * @param {string} agentId - Agent to resume
 * @param {string} action - 'resume' or 'top-up'
 * @param {object} opts
 * @param {string} opts.dataDir - Base data directory
 * @param {number} [opts.newLimit] - New weekly token limit (top-up only)
 * @param {string} [opts.timestamp] - Explicit timestamp
 * @returns {Promise<object>} Result of the action
 */
export async function executeResume(agentId, action, { dataDir, newLimit, timestamp }) {
  if (!agentId) throw new Error('agentId is required');
  if (!dataDir) throw new Error('dataDir is required');
  if (!action || !['resume', 'top-up'].includes(action)) {
    throw new Error(`Invalid action "${action}". Must be "resume" or "top-up".`);
  }

  const agentStore = new AgentStore(dataDir);
  const usageStore = new UsageStore(dataDir);
  const deps = { agentStore };

  if (action === 'resume') {
    // Simple resume — just clear the paused flag
    const config = await agentStore.load(agentId);
    const wasPaused = config.budget?.paused === true;

    await resumeAgent(agentId, deps);

    return {
      agentId,
      action: 'resume',
      success: true,
      wasPaused,
      message: wasPaused
        ? `Agent "${agentId}" has been resumed. Budget limit unchanged — agent will pause again if usage still exceeds the limit on next enforcement check.`
        : `Agent "${agentId}" was not paused — no action taken.`,
    };
  }

  // top-up — reset usage and optionally set new limit
  const result = await topUpResume(agentId, { agentStore, usageStore }, {
    newLimit,
    timestamp,
  });

  const limitChanged = newLimit !== undefined;

  return {
    agentId,
    action: 'top-up',
    success: true,
    wasPaused: result.wasPaused,
    resumed: result.resumed,
    previousUsage: result.previousUsage,
    previousLimit: result.previousLimit,
    newLimit: result.newLimit,
    limitChanged,
    message: buildTopUpMessage(agentId, result, limitChanged),
  };
}

/**
 * Build a human-readable message for a top-up result.
 * @param {string} agentId
 * @param {object} result - TopUpResult
 * @param {boolean} limitChanged
 * @returns {string}
 */
function buildTopUpMessage(agentId, result, limitChanged) {
  const parts = [`Agent "${agentId}" has been topped up and resumed.`];
  parts.push(`Previous usage: ${result.previousUsage.toLocaleString('en-US')} tokens (reset to 0).`);
  if (limitChanged) {
    parts.push(`Budget limit changed: ${result.previousLimit.toLocaleString('en-US')} → ${result.newLimit.toLocaleString('en-US')} tokens/week.`);
  } else {
    parts.push(`Budget limit unchanged: ${result.newLimit.toLocaleString('en-US')} tokens/week.`);
  }
  return parts.join(' ');
}

/**
 * Format the paused agents list for display.
 *
 * @param {{ paused: object[], active: string[], total: number }} listResult
 * @returns {string}
 */
export function formatPausedAgentsList(listResult) {
  const lines = [];

  lines.push('=== Paused Agents ===');
  lines.push(`Total agents: ${listResult.total} (${listResult.paused.length} paused, ${listResult.active.length} active)`);
  lines.push('');

  if (listResult.paused.length === 0) {
    lines.push('No paused agents found. All agents are currently active.');
    return lines.join('\n');
  }

  for (let i = 0; i < listResult.paused.length; i++) {
    const a = listResult.paused[i];
    const usage = a.budget.currentUsage.toLocaleString('en-US');
    const limit = a.budget.weeklyTokenLimit.toLocaleString('en-US');
    lines.push(`${i + 1}. [PAUSED] ${a.name} (${a.role})`);
    lines.push(`   ID: ${a.id}`);
    lines.push(`   Budget: ${usage} / ${limit} tokens`);
    if (i < listResult.paused.length - 1) lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format detailed agent budget info for the confirmation step.
 *
 * @param {object} details - From getPausedAgentDetails
 * @returns {string}
 */
export function formatPausedAgentDetails(details) {
  if (!details.paused) {
    return details.message;
  }

  const lines = [];
  lines.push(`=== Budget Details: ${details.name} (${details.role}) ===`);
  lines.push(`Agent ID: ${details.agentId}`);
  lines.push(`Status: PAUSED`);
  lines.push('');
  lines.push(`Weekly token limit: ${details.budget.weeklyTokenLimit.toLocaleString('en-US')}`);
  lines.push(`Current usage: ${details.budget.storeUsage.toLocaleString('en-US')} tokens`);
  if (details.budget.exceededBy > 0) {
    lines.push(`Exceeded by: ${details.budget.exceededBy.toLocaleString('en-US')} tokens`);
  }

  if (details.alert) {
    lines.push('');
    lines.push(`Alert: ${details.alert.message}`);
    lines.push(`Alert time: ${details.alert.timestamp}`);
  }

  lines.push('');
  lines.push('Available actions:');
  lines.push('  1. resume   — Clear pause flag (agent may re-pause on next budget check if still over limit)');
  lines.push('  2. top-up   — Reset usage to 0 and optionally set a new budget limit');
  lines.push('  3. cancel   — Do nothing');

  return lines.join('\n');
}

/**
 * Format the result of a resume/top-up action.
 *
 * @param {object} result - From executeResume
 * @returns {string}
 */
export function formatResumeResult(result) {
  if (!result.success) {
    return `Failed to ${result.action} agent "${result.agentId}": ${result.error || 'unknown error'}`;
  }

  const lines = [];
  lines.push(`=== Resume Result ===`);
  lines.push(result.message);
  lines.push('');
  lines.push(`The agent will execute tasks on its next heartbeat tick.`);

  return lines.join('\n');
}
