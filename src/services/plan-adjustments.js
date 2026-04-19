/**
 * Plan-adjustment service — shared goal/monthly/weekly adjustment logic.
 *
 * This module is the single source of truth for:
 *   - Validating an adjustment operation against an agent config.
 *   - Applying an adjustment operation (mutating the config in place).
 *   - Running a full batch of adjustments end-to-end (`adjustGoals`), including
 *     persistence via `AgentStore` and schema re-validation.
 *   - Formatting a post-adjustment summary for user-facing output.
 *
 * It is consumed by:
 *   - The consolidated `/aweek:plan` skill (handles goal/monthly/weekly
 *     adjustments alongside plan approval).
 *   - `src/skills/adjust-goal.js` — the legacy skill module kept as a thin
 *     re-export shim during the transition to the new skill surface.
 *
 * The three adjustment scopes are:
 *   - goals:   long-term goals (horizons: 1mo, 3mo, 1yr). Actions: add / update / remove.
 *   - monthly: monthly plan objectives. Actions: add / update.
 *   - weekly:  weekly plan tasks. Actions: add / update.
 *
 * Design notes:
 *   - Validators are pure functions — no I/O, no mutation. They return
 *     `{ valid, errors }` so callers can collect every problem before acting.
 *   - Apply functions mutate the passed-in config and return
 *     `{ applied, result, error? }`. They assume validation has already passed
 *     (they still perform the lookup so failures are explicit).
 *   - `adjustGoals` is the single entry point used by skills: it loads the
 *     agent, validates every operation up front, applies them all only if
 *     every validation succeeded, runs a final JSON-schema check on the
 *     resulting config, then persists. This "validate all then apply all"
 *     contract makes batch adjustments atomic.
 */
import {
  createGoal,
  createObjective,
  createTask,
  createMonthlyPlan,
  createWeeklyPlan,
  addGoal,
  updateGoalStatus,
  removeGoal,
  addMonthlyPlan,
  addObjectiveToMonthlyPlan,
  updateObjectiveStatus,
  getMonthlyPlan,
} from '../models/agent.js';
import { validateAgentConfig } from '../schemas/validator.js';
import { GOAL_HORIZONS } from '../schemas/goals.schema.js';
import {
  MONTHLY_PLAN_STATUSES,
  OBJECTIVE_STATUSES,
} from '../schemas/monthly-plan.schema.js';
import { TASK_PRIORITIES } from '../schemas/weekly-plan.schema.js';
import { createAgentStore } from '../storage/agent-helpers.js';

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Check whether `value` is a valid track identifier: a non-empty string
 * up to 64 chars. Matches the JSON schema's `track` constraints so we
 * surface a friendly error before the final schema check fires.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidTrack(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

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
  const validActions = ['create', 'add', 'update'];

  if (!op || typeof op !== 'object') {
    return { valid: false, errors: ['Monthly adjustment must be an object'] };
  }

  if (!validActions.includes(op.action)) {
    errors.push(`action must be one of: ${validActions.join(', ')}`);
    return { valid: false, errors };
  }

  if (!op.month || typeof op.month !== 'string' || !/^\d{4}-\d{2}$/.test(op.month)) {
    errors.push('month is required in YYYY-MM format');
    return { valid: false, errors };
  }

  // `create` is the bootstrap path: the monthly plan must NOT already exist,
  // and the caller must seed at least one objective (the schema enforces
  // `objectives.minItems: 1`, so an empty seed would just fail later in the
  // final schema check — surface it up front for a cleaner error).
  if (op.action === 'create') {
    if (getMonthlyPlan(agentConfig, op.month)) {
      errors.push(`Monthly plan already exists for ${op.month} — use action: "add" to append objectives`);
    }
    if (!Array.isArray(op.objectives) || op.objectives.length === 0) {
      errors.push('objectives is required for create (array with at least one { description, goalId } entry)');
    } else {
      for (const [i, seed] of op.objectives.entries()) {
        if (!seed || typeof seed !== 'object') {
          errors.push(`objectives[${i}] must be an object`);
          continue;
        }
        if (!seed.description || typeof seed.description !== 'string' || seed.description.trim().length === 0) {
          errors.push(`objectives[${i}].description must be a non-empty string`);
        }
        if (!seed.goalId || typeof seed.goalId !== 'string') {
          errors.push(`objectives[${i}].goalId is required`);
        } else if (!agentConfig.goals?.find((g) => g.id === seed.goalId)) {
          errors.push(`objectives[${i}]: goal not found: ${seed.goalId}`);
        }
      }
    }
    if (op.status !== undefined && !MONTHLY_PLAN_STATUSES.includes(op.status)) {
      errors.push(`status must be one of: ${MONTHLY_PLAN_STATUSES.join(', ')}`);
    }
    if (op.summary !== undefined && (typeof op.summary !== 'string' || op.summary.length === 0)) {
      errors.push('summary must be a non-empty string when provided');
    }
    return { valid: errors.length === 0, errors };
  }

  // `add` and `update` both require an existing monthly plan to mutate.
  const plan = getMonthlyPlan(agentConfig, op.month);
  if (!plan) {
    errors.push(`No monthly plan found for ${op.month} — use action: "create" to bootstrap one`);
    return { valid: false, errors };
  }

  {
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
  const validActions = ['create', 'add', 'update'];

  if (!op || typeof op !== 'object') {
    return { valid: false, errors: ['Weekly adjustment must be an object'] };
  }

  if (!validActions.includes(op.action)) {
    errors.push(`action must be one of: ${validActions.join(', ')}`);
    return { valid: false, errors };
  }

  if (!op.week || typeof op.week !== 'string' || !/^\d{4}-W\d{2}$/.test(op.week)) {
    errors.push('week is required in YYYY-Www format');
    return { valid: false, errors };
  }

  // `create` is the bootstrap path: the weekly plan must NOT already exist,
  // its parent month must already have a monthly plan on this agent (so the
  // week threads back to a real plan), and any seed tasks must reference an
  // objective from some monthly plan on this agent.
  if (op.action === 'create') {
    if (agentConfig.weeklyPlans?.find((p) => p.week === op.week)) {
      errors.push(`Weekly plan already exists for ${op.week} — use action: "add" to append tasks`);
    }
    if (!op.month || typeof op.month !== 'string' || !/^\d{4}-\d{2}$/.test(op.month)) {
      errors.push('month is required for create in YYYY-MM format (parent month of the weekly plan)');
    } else if (!getMonthlyPlan(agentConfig, op.month)) {
      errors.push(`No monthly plan found for ${op.month} — create the monthly plan first via monthlyAdjustments action: "create"`);
    }
    if (op.tasks !== undefined) {
      if (!Array.isArray(op.tasks)) {
        errors.push('tasks must be an array when provided');
      } else {
        for (const [i, seed] of op.tasks.entries()) {
          if (!seed || typeof seed !== 'object') {
            errors.push(`tasks[${i}] must be an object`);
            continue;
          }
          if (!seed.description || typeof seed.description !== 'string' || seed.description.trim().length === 0) {
            errors.push(`tasks[${i}].description must be a non-empty string`);
          }
          if (!seed.objectiveId || typeof seed.objectiveId !== 'string') {
            errors.push(`tasks[${i}].objectiveId is required`);
          } else {
            let found = false;
            for (const mp of agentConfig.monthlyPlans || []) {
              if (mp.objectives.find((o) => o.id === seed.objectiveId)) {
                found = true;
                break;
              }
            }
            if (!found) errors.push(`tasks[${i}]: objective not found: ${seed.objectiveId}`);
          }
          if (seed.priority !== undefined && !TASK_PRIORITIES.includes(seed.priority)) {
            errors.push(`tasks[${i}].priority must be one of: ${TASK_PRIORITIES.join(', ')}`);
          }
          if (seed.estimatedMinutes !== undefined) {
            if (!Number.isInteger(seed.estimatedMinutes) || seed.estimatedMinutes < 1 || seed.estimatedMinutes > 480) {
              errors.push(`tasks[${i}].estimatedMinutes must be an integer between 1 and 480`);
            }
          }
          if (seed.track !== undefined && !isValidTrack(seed.track)) {
            errors.push(
              `tasks[${i}].track must be a non-empty string (max 64 chars)`,
            );
          }
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  // `add` and `update` both require an existing weekly plan to mutate.
  const plan = agentConfig.weeklyPlans?.find((p) => p.week === op.week);
  if (!plan) {
    errors.push(`No weekly plan found for ${op.week} — use action: "create" to bootstrap one`);
    return { valid: false, errors };
  }

  {
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
      if (op.track !== undefined && op.track !== null && !isValidTrack(op.track)) {
        errors.push(
          'track must be a non-empty string (max 64 chars), or null to clear',
        );
      }
      if (
        !op.status &&
        op.description === undefined &&
        op.track === undefined
      ) {
        errors.push(
          'At least one field to update is required (status, description, or track)',
        );
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
      if (op.track !== undefined && !isValidTrack(op.track)) {
        errors.push('track must be a non-empty string (max 64 chars)');
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
  if (op.action === 'create') {
    if (getMonthlyPlan(config, op.month)) {
      return { applied: false, result: null, error: `Monthly plan already exists for ${op.month}` };
    }
    const objectives = op.objectives.map((seed) =>
      createObjective(seed.description, seed.goalId)
    );
    const newPlan = createMonthlyPlan(op.month, objectives, {
      ...(op.status !== undefined ? { status: op.status } : {}),
      ...(op.summary !== undefined ? { summary: op.summary } : {}),
    });
    addMonthlyPlan(config, newPlan);
    return { applied: true, result: newPlan };
  }

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
  if (op.action === 'create') {
    if (config.weeklyPlans?.find((p) => p.week === op.week)) {
      return { applied: false, result: null, error: `Weekly plan already exists for ${op.week}` };
    }
    const tasks = Array.isArray(op.tasks)
      ? op.tasks.map((seed) =>
          createTask(seed.description, seed.objectiveId, {
            ...(seed.priority !== undefined ? { priority: seed.priority } : {}),
            ...(seed.estimatedMinutes !== undefined
              ? { estimatedMinutes: seed.estimatedMinutes }
              : {}),
            ...(seed.track !== undefined ? { track: seed.track } : {}),
          })
        )
      : [];
    const newPlan = createWeeklyPlan(op.week, op.month, tasks);
    if (!Array.isArray(config.weeklyPlans)) config.weeklyPlans = [];
    config.weeklyPlans.push(newPlan);
    config.updatedAt = new Date().toISOString();
    return { applied: true, result: newPlan };
  }

  const plan = config.weeklyPlans?.find((p) => p.week === op.week);
  if (!plan) return { applied: false, result: null, error: `No weekly plan for ${op.week}` };

  if (op.action === 'add') {
    const task = createTask(op.description, op.objectiveId, {
      ...(op.track !== undefined ? { track: op.track } : {}),
    });
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
    if (op.track !== undefined) {
      if (op.track === null) delete task.track;
      else task.track = op.track;
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
 * Validates every operation first; if any validation fails, nothing is
 * applied and nothing is persisted. This makes batch adjustments atomic.
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
  const store = createAgentStore(dataDir);
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
      if (!r.result) continue;
      // `create` returns the freshly-built monthly plan (no `id` — keyed on
      // `month` — and a populated `objectives` array). Distinguish it from the
      // `add`/`update` shape (which returns the objective object with its
      // own `id`/`description`).
      if (r.result.month && Array.isArray(r.result.objectives)) {
        lines.push(`    - Created monthly plan ${r.result.month} (${r.result.objectives.length} objective(s))`);
      } else {
        lines.push(`    - ${r.result.id}: ${r.result.description || '(updated)'}`);
      }
    }
  }

  if (results.weekly.length > 0) {
    lines.push(`  Weekly tasks: ${results.weekly.length} change(s)`);
    for (const r of results.weekly) {
      if (!r.result) continue;
      // `create` returns the freshly-built weekly plan (keyed on `week`,
      // populated `tasks` array). `add`/`update` return the task object.
      if (r.result.week && Array.isArray(r.result.tasks)) {
        lines.push(`    - Created weekly plan ${r.result.week} (${r.result.tasks.length} task(s)) — pending approval`);
      } else {
        lines.push(`    - ${r.result.id}: ${r.result.description || '(updated)'}`);
      }
    }
  }

  return lines.join('\n');
}
