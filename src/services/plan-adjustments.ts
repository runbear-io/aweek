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
import { validateAgentConfig, validateWeeklyPlan } from '../schemas/validator.js';
import { GOAL_HORIZONS } from '../schemas/goals.schema.js';
import {
  MONTHLY_PLAN_STATUSES,
  OBJECTIVE_STATUSES,
} from '../schemas/monthly-plan.schema.js';
import { TASK_PRIORITIES } from '../schemas/weekly-plan.schema.js';
import { createAgentStore, resolveDataDir } from '../storage/agent-helpers.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';

interface AgentGoal {
  id: string;
  description: string;
  horizon: string;
  status?: string;
  completedAt?: string;
}

interface AgentObjective {
  id: string;
  description: string;
  goalId: string;
  status?: string;
}

interface AgentMonthlyPlan {
  month: string;
  objectives: AgentObjective[];
  status?: string;
  summary?: string;
  updatedAt?: string;
}

interface AgentTaskShape {
  id: string;
  title?: string;
  prompt?: string;
  objectiveId?: string | null;
  status?: string;
  completedAt?: string;
  track?: string | null;
  runAt?: string | null;
}

interface AgentWeeklyPlan {
  week: string;
  month?: string | null;
  tasks: AgentTaskShape[];
  approved?: boolean;
  approvedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentConfigShape {
  id: string;
  goals: AgentGoal[];
  monthlyPlans: AgentMonthlyPlan[];
  updatedAt?: string;
  [key: string]: unknown;
}

export interface GoalAdjustmentOp {
  action?: string;
  goalId?: string;
  description?: string;
  horizon?: '1mo' | '3mo' | '1yr';
  status?: 'active' | 'completed' | 'paused' | 'dropped';
}

export interface MonthlyAdjustmentOp {
  action?: string;
  month?: string;
  objectiveId?: string;
  description?: string;
  goalId?: string;
  status?: 'active' | 'completed' | 'draft' | 'archived';
  summary?: string;
  objectives?: { description?: string; goalId?: string }[];
}

export interface WeeklyTaskAdjustmentSeed {
  title?: string;
  prompt?: string;
  objectiveId?: string | null;
  track?: string;
  runAt?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  estimatedMinutes?: number;
}

export interface WeeklyAdjustmentOp {
  action?: string;
  week?: string;
  taskId?: string;
  title?: string;
  prompt?: string;
  objectiveId?: string | null;
  status?: string;
  track?: string;
  runAt?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  estimatedMinutes?: number;
  month?: string;
  tasks?: WeeklyTaskAdjustmentSeed[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AdjustmentApplyResult {
  applied: boolean;
  result: unknown;
  error?: string;
}

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
function isValidTrack(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

/**
 * Check whether `value` is an ISO 8601 date-time string with explicit
 * time + timezone (Z or ±hh:mm). Matches what the AJV `date-time` format
 * validator accepts so we surface a clean error up-front instead of at
 * the final schema check.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidIsoDateTime(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
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
export function validateGoalAdjustment(op: unknown, agentConfig: AgentConfigShape): ValidationResult {
  const errors: string[] = [];
  const validActions = ['add', 'update', 'remove'];

  if (!op || typeof op !== 'object') {
    return { valid: false, errors: ['Goal adjustment must be an object'] };
  }
  const o = op as GoalAdjustmentOp;

  if (!o.action || !validActions.includes(o.action)) {
    errors.push(`action must be one of: ${validActions.join(', ')}`);
    return { valid: false, errors };
  }

  if (o.action === 'add') {
    if (!o.description || typeof o.description !== 'string' || o.description.trim().length === 0) {
      errors.push('description is required for adding a goal');
    }
    if (!o.horizon || !GOAL_HORIZONS.includes(o.horizon)) {
      errors.push(`horizon must be one of: ${GOAL_HORIZONS.join(', ')}`);
    }
  }

  if (o.action === 'update') {
    if (!o.goalId || typeof o.goalId !== 'string') {
      errors.push('goalId is required for updating a goal');
    } else if (!agentConfig.goals.find((g) => g.id === o.goalId)) {
      errors.push(`Goal not found: ${o.goalId}`);
    }
    if (o.status && !['active', 'completed', 'paused', 'dropped'].includes(o.status)) {
      errors.push('status must be one of: active, completed, paused, dropped');
    }
    if (o.description !== undefined && (typeof o.description !== 'string' || o.description.trim().length === 0)) {
      errors.push('description must be a non-empty string');
    }
    // Must provide at least one field to update
    if (!o.status && o.description === undefined && !o.horizon) {
      errors.push('At least one field to update is required (status, description, or horizon)');
    }
    if (o.horizon && !GOAL_HORIZONS.includes(o.horizon)) {
      errors.push(`horizon must be one of: ${GOAL_HORIZONS.join(', ')}`);
    }
  }

  if (o.action === 'remove') {
    if (!o.goalId || typeof o.goalId !== 'string') {
      errors.push('goalId is required for removing a goal');
    } else if (!agentConfig.goals.find((g) => g.id === o.goalId)) {
      errors.push(`Goal not found: ${o.goalId}`);
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
export function validateMonthlyAdjustment(op: unknown, agentConfig: AgentConfigShape): ValidationResult {
  const errors: string[] = [];
  const validActions = ['create', 'add', 'update'];

  if (!op || typeof op !== 'object') {
    return { valid: false, errors: ['Monthly adjustment must be an object'] };
  }
  const o = op as MonthlyAdjustmentOp;

  if (!o.action || !validActions.includes(o.action)) {
    errors.push(`action must be one of: ${validActions.join(', ')}`);
    return { valid: false, errors };
  }

  if (!o.month || typeof o.month !== 'string' || !/^\d{4}-\d{2}$/.test(o.month)) {
    errors.push('month is required in YYYY-MM format');
    return { valid: false, errors };
  }

  // `create` is the bootstrap path: the monthly plan must NOT already exist,
  // and the caller must seed at least one objective (the schema enforces
  // `objectives.minItems: 1`, so an empty seed would just fail later in the
  // final schema check — surface it up front for a cleaner error).
  if (o.action === 'create') {
    if (getMonthlyPlan(agentConfig, o.month)) {
      errors.push(`Monthly plan already exists for ${o.month} — use action: "add" to append objectives`);
    }
    if (!Array.isArray(o.objectives) || o.objectives.length === 0) {
      errors.push('objectives is required for create (array with at least one { description, goalId } entry)');
    } else {
      for (const [i, seed] of o.objectives.entries()) {
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
    if (o.status !== undefined && !MONTHLY_PLAN_STATUSES.includes(o.status)) {
      errors.push(`status must be one of: ${MONTHLY_PLAN_STATUSES.join(', ')}`);
    }
    if (o.summary !== undefined && (typeof o.summary !== 'string' || o.summary.length === 0)) {
      errors.push('summary must be a non-empty string when provided');
    }
    return { valid: errors.length === 0, errors };
  }

  // `add` and `update` both require an existing monthly plan to mutate.
  const plan = getMonthlyPlan(agentConfig, o.month) as AgentMonthlyPlan | undefined;
  if (!plan) {
    errors.push(`No monthly plan found for ${o.month} — use action: "create" to bootstrap one`);
    return { valid: false, errors };
  }

  {
    if (o.action === 'update') {
      if (!o.objectiveId || typeof o.objectiveId !== 'string') {
        errors.push('objectiveId is required for updating an objective');
      } else {
        const obj = plan.objectives.find((x) => x.id === o.objectiveId);
        if (!obj) {
          errors.push(`Objective not found: ${o.objectiveId}`);
        }
      }
      if (o.status && !OBJECTIVE_STATUSES.includes(o.status)) {
        errors.push(`status must be one of: ${OBJECTIVE_STATUSES.join(', ')}`);
      }
      if (o.description !== undefined && (typeof o.description !== 'string' || o.description.trim().length === 0)) {
        errors.push('description must be a non-empty string');
      }
      if (!o.status && o.description === undefined) {
        errors.push('At least one field to update is required (status or description)');
      }
    }

    if (o.action === 'add') {
      if (!o.description || typeof o.description !== 'string' || o.description.trim().length === 0) {
        errors.push('description is required for adding an objective');
      }
      if (!o.goalId || typeof o.goalId !== 'string') {
        errors.push('goalId is required for adding an objective');
      } else if (!agentConfig.goals.find((g) => g.id === o.goalId)) {
        errors.push(`Goal not found: ${o.goalId}`);
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
 * @param {string} [op.title] - Required for add (calendar label, ≤ 80 chars)
 * @param {string} [op.prompt] - Required for add (instruction sent to Claude)
 * @param {string} [op.objectiveId] - Required for add
 * @param {string} [op.status] - For update
 * @param {object} agentConfig - Agent config (used for monthly-plan lookups)
 * @param {object[]} [weeklyPlans=[]] - Weekly plans array (loaded from
 *   WeeklyPlanStore by the orchestrator). Used for `create` existence checks
 *   and `add`/`update` task lookups. Defaults to `[]` when omitted so legacy
 *   tests that pass only the config still run the shape checks.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWeeklyAdjustment(
  op: unknown,
  agentConfig: AgentConfigShape,
  weeklyPlans: AgentWeeklyPlan[] = [],
): ValidationResult {
  const errors: string[] = [];
  const validActions = ['create', 'add', 'update'];

  if (!op || typeof op !== 'object') {
    return { valid: false, errors: ['Weekly adjustment must be an object'] };
  }
  const o = op as WeeklyAdjustmentOp;
  void agentConfig;

  if (!o.action || !validActions.includes(o.action)) {
    errors.push(`action must be one of: ${validActions.join(', ')}`);
    return { valid: false, errors };
  }

  if (!o.week || typeof o.week !== 'string' || !/^\d{4}-W\d{2}$/.test(o.week)) {
    errors.push('week is required in YYYY-Www format');
    return { valid: false, errors };
  }

  // `create` is the bootstrap path: the weekly plan must NOT already exist.
  // `month` (YYYY-MM) is now a free-form label (it typically matches a
  // `### YYYY-MM` subsection in plan.md) — we still enforce the shape when
  // present but no longer require the agent to carry a structured monthly
  // plan for it.
  if (o.action === 'create') {
    if (weeklyPlans.find((p) => p.week === o.week)) {
      errors.push(`Weekly plan already exists for ${o.week} — use action: "add" to append tasks`);
    }
    if (o.month !== undefined && o.month !== null) {
      if (typeof o.month !== 'string' || !/^\d{4}-\d{2}$/.test(o.month)) {
        errors.push('month must be a YYYY-MM string when provided');
      }
    }
    if (o.tasks !== undefined) {
      if (!Array.isArray(o.tasks)) {
        errors.push('tasks must be an array when provided');
      } else {
        for (const [i, seed] of o.tasks.entries()) {
          if (!seed || typeof seed !== 'object') {
            errors.push(`tasks[${i}] must be an object`);
            continue;
          }
          if (!seed.title || typeof seed.title !== 'string' || seed.title.trim().length === 0) {
            errors.push(`tasks[${i}].title must be a non-empty string`);
          } else if (seed.title.length > 80) {
            errors.push(`tasks[${i}].title must be at most 80 characters`);
          }
          if (!seed.prompt || typeof seed.prompt !== 'string' || seed.prompt.trim().length === 0) {
            errors.push(`tasks[${i}].prompt must be a non-empty string`);
          }
          if (seed.objectiveId !== undefined && seed.objectiveId !== null) {
            if (typeof seed.objectiveId !== 'string' || seed.objectiveId.length === 0) {
              errors.push(`tasks[${i}].objectiveId must be a non-empty string when provided`);
            }
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
          if (seed.runAt !== undefined && !isValidIsoDateTime(seed.runAt)) {
            errors.push(
              `tasks[${i}].runAt must be an ISO 8601 date-time (e.g. "2026-04-20T09:00:00Z")`,
            );
          }
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  // `add` and `update` both require an existing weekly plan to mutate.
  const plan = weeklyPlans.find((p) => p.week === o.week);
  if (!plan) {
    errors.push(`No weekly plan found for ${o.week} — use action: "create" to bootstrap one`);
    return { valid: false, errors };
  }

  {
    if (o.action === 'update') {
      if (!o.taskId || typeof o.taskId !== 'string') {
        errors.push('taskId is required for updating a task');
      } else {
        const task = plan.tasks.find((t) => t.id === o.taskId);
        if (!task) {
          errors.push(`Task not found: ${o.taskId}`);
        }
      }
      const validStatuses = ['pending', 'in-progress', 'completed', 'failed', 'delegated', 'skipped'];
      if (o.status && !validStatuses.includes(o.status)) {
        errors.push(`status must be one of: ${validStatuses.join(', ')}`);
      }
      if (o.title !== undefined) {
        if (typeof o.title !== 'string' || o.title.trim().length === 0) {
          errors.push('title must be a non-empty string');
        } else if (o.title.length > 80) {
          errors.push('title must be at most 80 characters');
        }
      }
      if (o.prompt !== undefined && (typeof o.prompt !== 'string' || o.prompt.trim().length === 0)) {
        errors.push('prompt must be a non-empty string');
      }
      if (o.track !== undefined && o.track !== null && !isValidTrack(o.track)) {
        errors.push(
          'track must be a non-empty string (max 64 chars), or null to clear',
        );
      }
      if (o.runAt !== undefined && o.runAt !== null && !isValidIsoDateTime(o.runAt)) {
        errors.push(
          'runAt must be an ISO 8601 date-time string, or null to clear',
        );
      }
      if (
        !o.status &&
        o.title === undefined &&
        o.prompt === undefined &&
        o.track === undefined &&
        o.runAt === undefined
      ) {
        errors.push(
          'At least one field to update is required (status, title, prompt, track, or runAt)',
        );
      }
    }

    if (o.action === 'add') {
      if (!o.title || typeof o.title !== 'string' || o.title.trim().length === 0) {
        errors.push('title is required for adding a task');
      } else if (o.title.length > 80) {
        errors.push('title must be at most 80 characters');
      }
      if (!o.prompt || typeof o.prompt !== 'string' || o.prompt.trim().length === 0) {
        errors.push('prompt is required for adding a task');
      }
      // `objectiveId` is now a free-form string that typically points at a
      // monthly section heading in plan.md — no longer required, no longer
      // validated against a structured monthlyPlans array.
      if (o.objectiveId !== undefined && o.objectiveId !== null) {
        if (typeof o.objectiveId !== 'string' || o.objectiveId.length === 0) {
          errors.push('objectiveId must be a non-empty string when provided');
        }
      }
      if (o.track !== undefined && !isValidTrack(o.track)) {
        errors.push('track must be a non-empty string (max 64 chars)');
      }
      if (o.runAt !== undefined && !isValidIsoDateTime(o.runAt)) {
        errors.push(
          'runAt must be an ISO 8601 date-time (e.g. "2026-04-20T09:00:00Z")',
        );
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
export function applyGoalAdjustment(
  config: AgentConfigShape,
  op: GoalAdjustmentOp,
): AdjustmentApplyResult {
  if (op.action === 'add') {
    const goal = createGoal(op.description!, op.horizon!);
    addGoal(config, goal);
    return { applied: true, result: goal };
  }

  if (op.action === 'update') {
    const goal = config.goals.find((g) => g.id === op.goalId);
    if (!goal) return { applied: false, result: null, error: `Goal not found: ${op.goalId}` };

    if (op.description) goal.description = op.description;
    if (op.horizon) goal.horizon = op.horizon;
    if (op.status) {
      updateGoalStatus(config, op.goalId!, op.status);
    } else {
      config.updatedAt = new Date().toISOString();
    }
    return { applied: true, result: goal };
  }

  if (op.action === 'remove') {
    const removed = removeGoal(config, op.goalId!);
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
export function applyMonthlyAdjustment(
  config: AgentConfigShape,
  op: MonthlyAdjustmentOp,
): AdjustmentApplyResult {
  if (op.action === 'create') {
    if (getMonthlyPlan(config, op.month!)) {
      return { applied: false, result: null, error: `Monthly plan already exists for ${op.month}` };
    }
    const objectives = (op.objectives || []).map((seed) =>
      createObjective(seed.description!, seed.goalId!)
    );
    const newPlan = createMonthlyPlan(op.month!, objectives, {
      ...(op.status !== undefined ? { status: op.status } : {}),
      ...(op.summary !== undefined ? { summary: op.summary } : {}),
    });
    addMonthlyPlan(config, newPlan);
    return { applied: true, result: newPlan };
  }

  const plan = getMonthlyPlan(config, op.month!) as AgentMonthlyPlan | undefined;
  if (!plan) return { applied: false, result: null, error: `No monthly plan for ${op.month}` };

  if (op.action === 'add') {
    const objective = createObjective(op.description!, op.goalId!);
    addObjectiveToMonthlyPlan(config, op.month!, objective);
    return { applied: true, result: objective };
  }

  if (op.action === 'update') {
    const obj = plan.objectives.find((x) => x.id === op.objectiveId);
    if (!obj) return { applied: false, result: null, error: `Objective not found: ${op.objectiveId}` };

    if (op.description) obj.description = op.description;
    if (op.status) {
      updateObjectiveStatus(
        config,
        op.objectiveId!,
        op.status as 'completed' | 'dropped' | 'planned' | 'in-progress',
      );
    } else {
      plan.updatedAt = new Date().toISOString();
      config.updatedAt = new Date().toISOString();
    }
    return { applied: true, result: obj };
  }

  return { applied: false, result: null, error: `Unknown action: ${op.action}` };
}

/**
 * Apply a weekly task adjustment (mutates `config` for `updatedAt` and
 * `weeklyPlans` for the plan contents).
 *
 * Weekly plans are no longer embedded in the agent config — they live in
 * `WeeklyPlanStore`. The orchestrator (`adjustGoals`) loads the array via
 * `weeklyPlanStore.loadAll`, passes it in here so this function can stay
 * pure-ish (no I/O), and persists each affected plan afterwards.
 *
 * @param {object} config - Agent config (only `updatedAt` is touched)
 * @param {object} op - Weekly adjustment operation
 * @param {object[]} weeklyPlans - Mutable array of weekly plans. For
 *   `create`, the new plan is pushed onto this array. For `add`/`update`,
 *   the matching plan in the array is mutated in place. The orchestrator
 *   persists the resulting plan(s) via `WeeklyPlanStore.save`.
 * @returns {{ applied: boolean, result: object | null, error?: string }}
 */
export function applyWeeklyAdjustment(
  config: AgentConfigShape,
  op: WeeklyAdjustmentOp,
  weeklyPlans: AgentWeeklyPlan[] = [],
): AdjustmentApplyResult {
  if (op.action === 'create') {
    if (weeklyPlans.find((p) => p.week === op.week)) {
      return { applied: false, result: null, error: `Weekly plan already exists for ${op.week}` };
    }
    const tasks = Array.isArray(op.tasks)
      ? op.tasks.map((seed) =>
          createTask({ title: seed.title!, prompt: seed.prompt! }, seed.objectiveId!, {
            ...(seed.priority !== undefined ? { priority: seed.priority } : {}),
            ...(seed.estimatedMinutes !== undefined
              ? { estimatedMinutes: seed.estimatedMinutes }
              : {}),
            ...(seed.track !== undefined ? { track: seed.track } : {}),
            ...(seed.runAt !== undefined ? { runAt: seed.runAt } : {}),
          })
        )
      : [];
    const newPlan = createWeeklyPlan(op.week!, op.month!, tasks) as AgentWeeklyPlan;
    weeklyPlans.push(newPlan);
    config.updatedAt = new Date().toISOString();
    return { applied: true, result: newPlan };
  }

  const plan = weeklyPlans.find((p) => p.week === op.week);
  if (!plan) return { applied: false, result: null, error: `No weekly plan for ${op.week}` };

  if (op.action === 'add') {
    const task = createTask({ title: op.title!, prompt: op.prompt! }, op.objectiveId!, {
      ...(op.priority !== undefined ? { priority: op.priority } : {}),
      ...(op.estimatedMinutes !== undefined ? { estimatedMinutes: op.estimatedMinutes } : {}),
      ...(op.track !== undefined ? { track: op.track } : {}),
      ...(op.runAt !== undefined ? { runAt: op.runAt } : {}),
    }) as AgentTaskShape;
    plan.tasks.push(task);
    plan.updatedAt = new Date().toISOString();
    config.updatedAt = new Date().toISOString();
    return { applied: true, result: task };
  }

  if (op.action === 'update') {
    const task = plan.tasks.find((t) => t.id === op.taskId);
    if (!task) return { applied: false, result: null, error: `Task not found: ${op.taskId}` };

    if (op.title) task.title = op.title;
    if (op.prompt) task.prompt = op.prompt;
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
    if (op.runAt !== undefined) {
      if (op.runAt === null) delete task.runAt;
      else task.runAt = op.runAt;
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
export interface AdjustGoalsParams {
  agentId: string;
  goalAdjustments?: unknown[];
  monthlyAdjustments?: unknown[];
  weeklyAdjustments?: unknown[];
  dataDir?: string;
}

export interface AdjustGoalsResult {
  success: boolean;
  results?: {
    goals: AdjustmentApplyResult[];
    monthly: AdjustmentApplyResult[];
    weekly: AdjustmentApplyResult[];
  };
  errors?: string[];
}

export async function adjustGoals({
  agentId,
  goalAdjustments = [],
  monthlyAdjustments = [],
  weeklyAdjustments = [],
  dataDir,
}: AdjustGoalsParams): Promise<AdjustGoalsResult> {
  const allErrors: string[] = [];

  // Must have at least one adjustment
  if (goalAdjustments.length === 0 && monthlyAdjustments.length === 0 && weeklyAdjustments.length === 0) {
    return { success: false, errors: ['At least one adjustment is required'] };
  }

  // Load agent
  const store = createAgentStore(dataDir);
  let config: AgentConfigShape;
  try {
    config = (await store.load(agentId)) as unknown as AgentConfigShape;
  } catch {
    return { success: false, errors: [`Agent not found: ${agentId}`] };
  }

  // Load weekly plans from the file store — they're no longer embedded
  // in the agent config. The array is mutated by `applyWeeklyAdjustment`
  // (push for create, in-place mutation for add/update); we persist the
  // affected plans after validation succeeds.
  const weeklyPlanStore = new WeeklyPlanStore(resolveDataDir(dataDir));
  let weeklyPlans: AgentWeeklyPlan[];
  try {
    weeklyPlans = (await weeklyPlanStore.loadAll(agentId)) as AgentWeeklyPlan[];
  } catch {
    weeklyPlans = [];
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
    const result = validateWeeklyAdjustment(op, config, weeklyPlans);
    if (!result.valid) {
      allErrors.push(...result.errors.map((e) => `weekly[${i}]: ${e}`));
    }
  }

  if (allErrors.length > 0) {
    return { success: false, errors: allErrors };
  }

  // Apply all adjustments. Track which weekly plans were touched so we
  // persist each of them individually afterwards.
  const results: {
    goals: AdjustmentApplyResult[];
    monthly: AdjustmentApplyResult[];
    weekly: AdjustmentApplyResult[];
  } = { goals: [], monthly: [], weekly: [] };
  const touchedWeeks = new Set<string>();

  for (const op of goalAdjustments) {
    const r = applyGoalAdjustment(config, op as GoalAdjustmentOp);
    results.goals.push(r);
  }

  for (const op of monthlyAdjustments) {
    const r = applyMonthlyAdjustment(config, op as MonthlyAdjustmentOp);
    results.monthly.push(r);
  }

  for (const op of weeklyAdjustments) {
    const wop = op as WeeklyAdjustmentOp;
    const r = applyWeeklyAdjustment(config, wop, weeklyPlans);
    results.weekly.push(r);
    if (r.applied && wop.week) touchedWeeks.add(wop.week);
  }

  // Final agent-schema validation before persisting
  const schemaResult = validateAgentConfig(config) as { valid: boolean; errors: { instancePath?: string; message?: string }[] };
  if (!schemaResult.valid) {
    const messages = schemaResult.errors.map(
      (e) => `${e.instancePath || '/'}: ${e.message}`
    );
    return { success: false, errors: messages };
  }

  // Validate every touched weekly plan against the per-item schema so
  // invalid plans never land in the file store.
  for (const week of touchedWeeks) {
    const plan = weeklyPlans.find((p) => p.week === week);
    if (!plan) continue;
    const planResult = validateWeeklyPlan(plan) as { valid: boolean; errors: { instancePath?: string; message?: string }[] };
    if (!planResult.valid) {
      const messages = planResult.errors.map(
        (e) => `weeklyPlans[${week}]${e.instancePath || ''}: ${e.message}`,
      );
      return { success: false, errors: messages };
    }
  }

  // Persist the agent config and every touched weekly plan atomically
  // from the caller's perspective (we fail fast on the first error).
  await store.save(config as unknown as Parameters<typeof store.save>[0]);
  for (const week of touchedWeeks) {
    const plan = weeklyPlans.find((p) => p.week === week);
    if (plan) await weeklyPlanStore.save(agentId, plan);
  }

  return { success: true, results };
}

/**
 * Format a summary of the adjustments made.
 * @param {object} results - The results object from adjustGoals
 * @returns {string}
 */
interface ResultsShape {
  goals: AdjustmentApplyResult[];
  monthly: AdjustmentApplyResult[];
  weekly: AdjustmentApplyResult[];
}

export function formatAdjustmentSummary(results: ResultsShape): string {
  const lines = ['Goal adjustments applied successfully!', ''];

  if (results.goals.length > 0) {
    lines.push(`  Goals: ${results.goals.length} change(s)`);
    for (const r of results.goals) {
      const result = r.result as { removed?: boolean; goalId?: string; id?: string; description?: string } | null | undefined;
      if (result?.removed) {
        lines.push(`    - Removed goal ${result.goalId}`);
      } else if (result) {
        lines.push(`    - ${result.id}: ${result.description || '(updated)'}`);
      }
    }
  }

  if (results.monthly.length > 0) {
    lines.push(`  Monthly objectives: ${results.monthly.length} change(s)`);
    for (const r of results.monthly) {
      const result = r.result as { month?: string; objectives?: unknown[]; id?: string; description?: string } | null | undefined;
      if (!result) continue;
      // `create` returns the freshly-built monthly plan (no `id` — keyed on
      // `month` — and a populated `objectives` array). Distinguish it from the
      // `add`/`update` shape (which returns the objective object with its
      // own `id`/`description`).
      if (result.month && Array.isArray(result.objectives)) {
        lines.push(`    - Created monthly plan ${result.month} (${result.objectives.length} objective(s))`);
      } else {
        lines.push(`    - ${result.id}: ${result.description || '(updated)'}`);
      }
    }
  }

  if (results.weekly.length > 0) {
    lines.push(`  Weekly tasks: ${results.weekly.length} change(s)`);
    for (const r of results.weekly) {
      const result = r.result as { week?: string; tasks?: unknown[]; id?: string; title?: string } | null | undefined;
      if (!result) continue;
      // `create` returns the freshly-built weekly plan (keyed on `week`,
      // populated `tasks` array). `add`/`update` return the task object.
      if (result.week && Array.isArray(result.tasks)) {
        lines.push(`    - Created weekly plan ${result.week} (${result.tasks.length} task(s)) — pending approval`);
      } else {
        lines.push(`    - ${result.id}: ${result.title || '(updated)'}`);
      }
    }
  }

  return lines.join('\n');
}
