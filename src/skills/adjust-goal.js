/**
 * Adjust-goal skill logic.
 * Loads an agent, accepts goal/plan modifications, validates against schemas,
 * and persists updates via agent-store.
 *
 * Supports three adjustment types:
 *   - goals: Add, update, or remove long-term goals (1mo/3mo/1yr)
 *   - monthly: Add or update monthly objectives
 *   - weekly: Add or update weekly tasks
 *
 * Used by the /aweek:adjust-goal Claude Code skill.
 */
import { join } from 'node:path';
import { AgentStore } from '../storage/agent-store.js';
import {
  createGoal,
  createObjective,
  createTask,
  addGoal,
  updateGoalStatus,
  removeGoal,
  addObjectiveToMonthlyPlan,
  updateObjectiveStatus,
  getMonthlyPlan,
} from '../models/agent.js';
import {
  validateAgentConfig,
  validateGoal,
  validateMonthlyObjective,
} from '../schemas/validator.js';
import { GOAL_HORIZONS } from '../schemas/goals.schema.js';
import { OBJECTIVE_STATUSES } from '../schemas/monthly-plan.schema.js';

/** Default data directory (relative to project root) */
const DEFAULT_DATA_DIR = join(process.cwd(), '.aweek', 'agents');

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a goal adjustment operation.
 * @param {object} op
 * @param {'add' | 'update' | 'remove'} op.action
 * @param {string} [op.goalId] - Required for update/remove
 * @param {string} [op.description] - Required for add
 * @param {string} [op.horizon] - Required for add
 * @param {string} [op.status] - For update
 * @param {object} agentConfig - Current agent config (for reference checks)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateGoalAdjustment(op, agentConfig) {
  const errors = [];
  const validActions = ['add', 'update', 'remove'];

  if (!op || typeof op !== 'object') {
    return { valid: false, errors: ['Goal adjustment must be an object'] };
  }

  if (!validActions.includes(op.action)) {
    errors.push(`action must be one of: ${validActions.join(', ')}`);
    return { valid: false, errors };
  }

  if (op.action === 'add') {
    if (!op.description || typeof op.description !== 'string' || op.description.trim().length === 0) {
      errors.push('description is required for adding a goal');
    }
    if (!op.horizon || !GOAL_HORIZONS.includes(op.horizon)) {
      errors.push(`horizon must be one of: ${GOAL_HORIZONS.join(', ')}`);
    }
  }

  if (op.action === 'update') {
    if (!op.goalId || typeof op.goalId !== 'string') {
      errors.push('goalId is required for updating a goal');
    } else if (!agentConfig.goals.find((g) => g.id === op.goalId)) {
      errors.push(`Goal not found: ${op.goalId}`);
    }
    if (op.status && !['active', 'completed', 'paused', 'dropped'].includes(op.status)) {
      errors.push('status must be one of: active, completed, paused, dropped');
    }
    if (op.description !== undefined && (typeof op.description !== 'string' || op.description.trim().length === 0)) {
      errors.push('description must be a non-empty string');
    }
    // Must provide at least one field to update
    if (!op.status && op.description === undefined && !op.horizon) {
      errors.push('At least one field to update is required (status, description, or horizon)');
    }
    if (op.horizon && !GOAL_HORIZONS.includes(op.horizon)) {
      errors.push(`horizon must be one of: ${GOAL_HORIZONS.join(', ')}`);
    }
  }

  if (op.action === 'remove') {
    if (!op.goalId || typeof op.goalId !== 'string') {
      errors.push('goalId is required for removing a goal');
    } else if (!agentConfig.goals.find((g) => g.id === op.goalId)) {
      errors.push(`Goal not found: ${op.goalId}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a monthly objective adjustment.
 * @param {object} op
 * @param {'add' | 'update'} op.action
 * @param {string} op.month - YYYY-MM
 * @param {string} [op.objectiveId] - Required for update
 * @param {string} [op.description] - Required for add
 * @param {string} [op.goalId] - Required for add
 * @param {string} [op.status] - For update
 * @param {object} agentConfig
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMonthlyAdjustment(op, agentConfig) {
  const errors = [];
  const validActions = ['add', 'update'];

  if (!op || typeof op !== 'object') {
    return { valid: false, errors: ['Monthly adjustment must be an object'] };
  }

  if (!validActions.includes(op.action)) {
    errors.push(`action must be one of: ${validActions.join(', ')}`);
    return { valid: false, errors };
  }

  if (!op.month || typeof op.month !== 'string' || !/^\d{4}-\d{2}$/.test(op.month)) {
    errors.push('month is required in YYYY-MM format');
  } else {
    const plan = getMonthlyPlan(agentConfig, op.month);
    if (!plan) {
      errors.push(`No monthly plan found for ${op.month}`);
      return { valid: false, errors };
    }

    if (op.action === 'update') {
      if (!op.objectiveId || typeof op.objectiveId !== 'string') {
        errors.push('objectiveId is required for updating an objective');
      } else {
        const obj = plan.objectives.find((o) => o.id === op.objectiveId);
        if (!obj) {
          errors.push(`Objective not found: ${op.objectiveId}`);
        }
      }
      if (op.status && !OBJECTIVE_STATUSES.includes(op.status)) {
        errors.push(`status must be one of: ${OBJECTIVE_STATUSES.join(', ')}`);
      }
      if (op.description !== undefined && (typeof op.description !== 'string' || op.description.trim().length === 0)) {
        errors.push('description must be a non-empty string');
      }
      if (!op.status && op.description === undefined) {
        errors.push('At least one field to update is required (status or description)');
      }
    }

    if (op.action === 'add') {
      if (!op.description || typeof op.description !== 'string' || op.description.trim().length === 0) {
        errors.push('description is required for adding an objective');
      }
      if (!op.goalId || typeof op.goalId !== 'string') {
        errors.push('goalId is required for adding an objective');
      } else if (!agentConfig.goals.find((g) => g.id === op.goalId)) {
        errors.push(`Goal not found: ${op.goalId}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a weekly task adjustment.
 * @param {object} op
 * @param {'add' | 'update'} op.action
 * @param {string} op.week - YYYY-Www
 * @param {string} [op.taskId] - Required for update
 * @param {string} [op.description] - Required for add
 * @param {string} [op.objectiveId] - Required for add
 * @param {string} [op.status] - For update
 * @param {object} agentConfig
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWeeklyAdjustment(op, agentConfig) {
  const errors = [];
  const validActions = ['add', 'update'];

  if (!op || typeof op !== 'object') {
    return { valid: false, errors: ['Weekly adjustment must be an object'] };
  }

  if (!validActions.includes(op.action)) {
    errors.push(`action must be one of: ${validActions.join(', ')}`);
    return { valid: false, errors };
  }

  if (!op.week || typeof op.week !== 'string' || !/^\d{4}-W\d{2}$/.test(op.week)) {
    errors.push('week is required in YYYY-Www format');
  } else {
    const plan = agentConfig.weeklyPlans?.find((p) => p.week === op.week);
    if (!plan) {
      errors.push(`No weekly plan found for ${op.week}`);
      return { valid: false, errors };
    }

    if (op.action === 'update') {
      if (!op.taskId || typeof op.taskId !== 'string') {
        errors.push('taskId is required for updating a task');
      } else {
        const task = plan.tasks.find((t) => t.id === op.taskId);
        if (!task) {
          errors.push(`Task not found: ${op.taskId}`);
        }
      }
      const validStatuses = ['pending', 'in-progress', 'completed', 'failed', 'delegated', 'skipped'];
      if (op.status && !validStatuses.includes(op.status)) {
        errors.push(`status must be one of: ${validStatuses.join(', ')}`);
      }
      if (op.description !== undefined && (typeof op.description !== 'string' || op.description.trim().length === 0)) {
        errors.push('description must be a non-empty string');
      }
      if (!op.status && op.description === undefined) {
        errors.push('At least one field to update is required (status or description)');
      }
    }

    if (op.action === 'add') {
      if (!op.description || typeof op.description !== 'string' || op.description.trim().length === 0) {
        errors.push('description is required for adding a task');
      }
      if (!op.objectiveId || typeof op.objectiveId !== 'string') {
        errors.push('objectiveId is required for adding a task');
      } else {
        // Verify the objective exists in some monthly plan
        let found = false;
        for (const mp of agentConfig.monthlyPlans || []) {
          if (mp.objectives.find((o) => o.id === op.objectiveId)) {
            found = true;
            break;
          }
        }
        if (!found) {
          errors.push(`Objective not found: ${op.objectiveId}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Core adjustment functions
// ---------------------------------------------------------------------------

/**
 * Apply a goal adjustment to an agent config (mutates config).
 * @param {object} config - Agent config
 * @param {object} op - Goal adjustment operation
 * @returns {{ applied: boolean, result: object | null, error?: string }}
 */
export function applyGoalAdjustment(config, op) {
  if (op.action === 'add') {
    const goal = createGoal(op.description, op.horizon);
    addGoal(config, goal);
    return { applied: true, result: goal };
  }

  if (op.action === 'update') {
    const goal = config.goals.find((g) => g.id === op.goalId);
    if (!goal) return { applied: false, result: null, error: `Goal not found: ${op.goalId}` };

    if (op.description) goal.description = op.description;
    if (op.horizon) goal.horizon = op.horizon;
    if (op.status) {
      updateGoalStatus(config, op.goalId, op.status);
    } else {
      config.updatedAt = new Date().toISOString();
    }
    return { applied: true, result: goal };
  }

  if (op.action === 'remove') {
    const removed = removeGoal(config, op.goalId);
    if (!removed) return { applied: false, result: null, error: `Goal not found: ${op.goalId}` };
    return { applied: true, result: { goalId: op.goalId, removed: true } };
  }

  return { applied: false, result: null, error: `Unknown action: ${op.action}` };
}

/**
 * Apply a monthly objective adjustment to an agent config (mutates config).
 * @param {object} config - Agent config
 * @param {object} op - Monthly adjustment operation
 * @returns {{ applied: boolean, result: object | null, error?: string }}
 */
export function applyMonthlyAdjustment(config, op) {
  const plan = getMonthlyPlan(config, op.month);
  if (!plan) return { applied: false, result: null, error: `No monthly plan for ${op.month}` };

  if (op.action === 'add') {
    const objective = createObjective(op.description, op.goalId);
    addObjectiveToMonthlyPlan(config, op.month, objective);
    return { applied: true, result: objective };
  }

  if (op.action === 'update') {
    const obj = plan.objectives.find((o) => o.id === op.objectiveId);
    if (!obj) return { applied: false, result: null, error: `Objective not found: ${op.objectiveId}` };

    if (op.description) obj.description = op.description;
    if (op.status) {
      updateObjectiveStatus(config, op.objectiveId, op.status);
    } else {
      plan.updatedAt = new Date().toISOString();
      config.updatedAt = new Date().toISOString();
    }
    return { applied: true, result: obj };
  }

  return { applied: false, result: null, error: `Unknown action: ${op.action}` };
}

/**
 * Apply a weekly task adjustment to an agent config (mutates config).
 * @param {object} config - Agent config
 * @param {object} op - Weekly adjustment operation
 * @returns {{ applied: boolean, result: object | null, error?: string }}
 */
export function applyWeeklyAdjustment(config, op) {
  const plan = config.weeklyPlans?.find((p) => p.week === op.week);
  if (!plan) return { applied: false, result: null, error: `No weekly plan for ${op.week}` };

  if (op.action === 'add') {
    const task = createTask(op.description, op.objectiveId);
    plan.tasks.push(task);
    plan.updatedAt = new Date().toISOString();
    config.updatedAt = new Date().toISOString();
    return { applied: true, result: task };
  }

  if (op.action === 'update') {
    const task = plan.tasks.find((t) => t.id === op.taskId);
    if (!task) return { applied: false, result: null, error: `Task not found: ${op.taskId}` };

    if (op.description) task.description = op.description;
    if (op.status) {
      task.status = op.status;
      if (op.status === 'completed') {
        task.completedAt = new Date().toISOString();
      }
    }
    plan.updatedAt = new Date().toISOString();
    config.updatedAt = new Date().toISOString();
    return { applied: true, result: task };
  }

  return { applied: false, result: null, error: `Unknown action: ${op.action}` };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Adjust an agent's goals, monthly objectives, or weekly tasks.
 *
 * @param {object} params
 * @param {string} params.agentId - The agent to modify
 * @param {object[]} [params.goalAdjustments] - Goal operations (add/update/remove)
 * @param {object[]} [params.monthlyAdjustments] - Monthly objective operations (add/update)
 * @param {object[]} [params.weeklyAdjustments] - Weekly task operations (add/update)
 * @param {string} [params.dataDir] - Override data directory path
 * @returns {Promise<{ success: boolean, results?: object, errors?: string[] }>}
 */
export async function adjustGoals({
  agentId,
  goalAdjustments = [],
  monthlyAdjustments = [],
  weeklyAdjustments = [],
  dataDir,
}) {
  const allErrors = [];

  // Must have at least one adjustment
  if (goalAdjustments.length === 0 && monthlyAdjustments.length === 0 && weeklyAdjustments.length === 0) {
    return { success: false, errors: ['At least one adjustment is required'] };
  }

  // Load agent
  const store = new AgentStore(dataDir || DEFAULT_DATA_DIR);
  let config;
  try {
    config = await store.load(agentId);
  } catch (err) {
    return { success: false, errors: [`Agent not found: ${agentId}`] };
  }

  // Validate all adjustments before applying any
  for (const [i, op] of goalAdjustments.entries()) {
    const result = validateGoalAdjustment(op, config);
    if (!result.valid) {
      allErrors.push(...result.errors.map((e) => `goals[${i}]: ${e}`));
    }
  }

  for (const [i, op] of monthlyAdjustments.entries()) {
    const result = validateMonthlyAdjustment(op, config);
    if (!result.valid) {
      allErrors.push(...result.errors.map((e) => `monthly[${i}]: ${e}`));
    }
  }

  for (const [i, op] of weeklyAdjustments.entries()) {
    const result = validateWeeklyAdjustment(op, config);
    if (!result.valid) {
      allErrors.push(...result.errors.map((e) => `weekly[${i}]: ${e}`));
    }
  }

  if (allErrors.length > 0) {
    return { success: false, errors: allErrors };
  }

  // Apply all adjustments
  const results = { goals: [], monthly: [], weekly: [] };

  for (const op of goalAdjustments) {
    const r = applyGoalAdjustment(config, op);
    results.goals.push(r);
  }

  for (const op of monthlyAdjustments) {
    const r = applyMonthlyAdjustment(config, op);
    results.monthly.push(r);
  }

  for (const op of weeklyAdjustments) {
    const r = applyWeeklyAdjustment(config, op);
    results.weekly.push(r);
  }

  // Final schema validation before persisting
  const schemaResult = validateAgentConfig(config);
  if (!schemaResult.valid) {
    const messages = schemaResult.errors.map(
      (e) => `${e.instancePath || '/'}: ${e.message}`
    );
    return { success: false, errors: messages };
  }

  // Persist
  await store.save(config);

  return { success: true, results };
}

/**
 * Format a summary of the adjustments made.
 * @param {object} results - The results object from adjustGoals
 * @returns {string}
 */
export function formatAdjustmentSummary(results) {
  const lines = ['Goal adjustments applied successfully!', ''];

  if (results.goals.length > 0) {
    lines.push(`  Goals: ${results.goals.length} change(s)`);
    for (const r of results.goals) {
      if (r.result?.removed) {
        lines.push(`    - Removed goal ${r.result.goalId}`);
      } else if (r.result) {
        lines.push(`    - ${r.result.id}: ${r.result.description || '(updated)'}`);
      }
    }
  }

  if (results.monthly.length > 0) {
    lines.push(`  Monthly objectives: ${results.monthly.length} change(s)`);
    for (const r of results.monthly) {
      if (r.result) {
        lines.push(`    - ${r.result.id}: ${r.result.description || '(updated)'}`);
      }
    }
  }

  if (results.weekly.length > 0) {
    lines.push(`  Weekly tasks: ${results.weekly.length} change(s)`);
    for (const r of results.weekly) {
      if (r.result) {
        lines.push(`    - ${r.result.id}: ${r.result.description || '(updated)'}`);
      }
    }
  }

  return lines.join('\n');
}
