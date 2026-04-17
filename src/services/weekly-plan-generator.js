/**
 * Weekly plan generation service.
 * Takes an agent's goals and monthly plan as input and produces a structured
 * weekly plan with tasks that trace back to monthly objectives.
 *
 * Plan traceability chain: goal -> monthly objective -> weekly task.
 *
 * Generation rules:
 *  - Only "planned" or "in-progress" objectives produce tasks.
 *  - Each eligible objective gets at least one task.
 *  - Task priority inherits from objective status: in-progress -> high, planned -> medium.
 *  - Idempotent: calling with the same inputs and week produces the same structure
 *    (new IDs each call, but deterministic task count & mapping).
 *  - Validates output against the weekly-plan schema before returning.
 */
import {
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import { assertValid } from '../schemas/validator.js';

const WEEKLY_PLAN_SCHEMA_ID = 'aweek://schemas/weekly-plan';

/**
 * Statuses that are eligible for weekly task generation.
 * Completed/dropped objectives are skipped.
 */
const ELIGIBLE_OBJECTIVE_STATUSES = new Set(['planned', 'in-progress']);

/**
 * Map objective status to default task priority.
 * In-progress objectives get higher priority since they're already started.
 */
const STATUS_TO_PRIORITY = {
  'in-progress': 'high',
  planned: 'medium',
};

/**
 * Filter objectives to only those eligible for task generation.
 * Eligible = status is "planned" or "in-progress".
 *
 * @param {object[]} objectives - Monthly plan objectives
 * @returns {object[]} Filtered objectives
 */
export function filterEligibleObjectives(objectives) {
  return objectives.filter((o) => ELIGIBLE_OBJECTIVE_STATUSES.has(o.status));
}

/**
 * Filter goals to only active ones.
 * @param {object[]} goals - Agent goals
 * @returns {object[]} Active goals
 */
export function filterActiveGoals(goals) {
  return goals.filter((g) => g.status === 'active');
}

/**
 * Build a lookup set of active goal IDs for fast membership check.
 * @param {object[]} goals - Agent goals
 * @returns {Set<string>} Set of active goal IDs
 */
function buildActiveGoalIdSet(goals) {
  return new Set(filterActiveGoals(goals).map((g) => g.id));
}

/**
 * Determine the default priority for a task based on its parent objective.
 * @param {object} objective - Monthly objective
 * @returns {'critical' | 'high' | 'medium' | 'low'}
 */
export function defaultPriorityForObjective(objective) {
  return STATUS_TO_PRIORITY[objective.status] || 'medium';
}

/**
 * Generate tasks for a single objective.
 * By default, produces one task per objective. Callers can supply
 * custom task descriptors to override.
 *
 * @param {object} objective - Monthly objective
 * @param {object} [opts]
 * @param {Array<{ description: string, priority?: string, estimatedMinutes?: number }>} [opts.taskDescriptors]
 *   Custom task descriptors. If omitted, one task is generated from the objective description.
 * @returns {object[]} Array of task objects conforming to weekly-task schema
 */
export function generateTasksForObjective(objective, { taskDescriptors } = {}) {
  if (taskDescriptors && taskDescriptors.length > 0) {
    return taskDescriptors.map((desc) =>
      createTask(desc.description, objective.id, {
        priority: desc.priority || defaultPriorityForObjective(objective),
        estimatedMinutes: desc.estimatedMinutes,
      }),
    );
  }

  // Default: one task derived from the objective description
  return [
    createTask(
      objective.description,
      objective.id,
      { priority: defaultPriorityForObjective(objective) },
    ),
  ];
}

/**
 * Generate a weekly plan from an agent's goals and monthly plan.
 *
 * This is the core generation function. It:
 *  1. Filters objectives to eligible ones (planned/in-progress)
 *  2. Optionally filters to objectives whose parent goal is active
 *  3. Generates tasks traced back to each objective
 *  4. Assembles a valid weekly plan
 *  5. Validates the output against the schema
 *
 * @param {object} params
 * @param {string} params.week - ISO week string (YYYY-Www)
 * @param {string} params.month - Month string (YYYY-MM)
 * @param {object[]} params.goals - Agent's goals array
 * @param {object} params.monthlyPlan - Monthly plan with objectives
 * @param {object} [params.options]
 * @param {boolean} [params.options.requireActiveGoal=true] - Only include objectives whose parent goal is active
 * @param {Object<string, Array<{ description: string, priority?: string, estimatedMinutes?: number }>>} [params.options.taskOverrides]
 *   Map of objectiveId -> custom task descriptors. Overrides default task generation for specific objectives.
 * @returns {{ plan: object, meta: { totalTasks: number, objectivesIncluded: number, objectivesSkipped: number, skippedReasons: object[] } }}
 * @throws {Error} If week or month format is invalid, or if output fails schema validation
 */
export function generateWeeklyPlan({
  week,
  month,
  goals,
  monthlyPlan,
  options = {},
}) {
  // --- Input validation ---
  if (!week || !/^\d{4}-W\d{2}$/.test(week)) {
    throw new Error(`Invalid week format: "${week}". Expected YYYY-Www (e.g., 2026-W16).`);
  }
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Invalid month format: "${month}". Expected YYYY-MM (e.g., 2026-04).`);
  }
  if (!monthlyPlan || !Array.isArray(monthlyPlan.objectives)) {
    throw new Error('monthlyPlan must have an objectives array.');
  }
  if (!Array.isArray(goals)) {
    throw new Error('goals must be an array.');
  }

  const { requireActiveGoal = true, taskOverrides = {} } = options;

  // --- Filter objectives ---
  const activeGoalIds = buildActiveGoalIdSet(goals);
  const skippedReasons = [];
  const eligibleObjectives = [];

  for (const obj of monthlyPlan.objectives) {
    // Check objective status
    if (!ELIGIBLE_OBJECTIVE_STATUSES.has(obj.status)) {
      skippedReasons.push({
        objectiveId: obj.id,
        reason: `status "${obj.status}" is not eligible (must be planned or in-progress)`,
      });
      continue;
    }

    // Check parent goal is active (if required)
    if (requireActiveGoal && !activeGoalIds.has(obj.goalId)) {
      skippedReasons.push({
        objectiveId: obj.id,
        reason: `parent goal "${obj.goalId}" is not active`,
      });
      continue;
    }

    eligibleObjectives.push(obj);
  }

  // --- Generate tasks ---
  const allTasks = [];
  for (const obj of eligibleObjectives) {
    const overrides = taskOverrides[obj.id];
    const tasks = generateTasksForObjective(obj, {
      taskDescriptors: overrides,
    });
    allTasks.push(...tasks);
  }

  // --- Build weekly plan ---
  const plan = createWeeklyPlan(week, month, allTasks);

  // --- Validate output ---
  assertValid(WEEKLY_PLAN_SCHEMA_ID, plan);

  return {
    plan,
    meta: {
      totalTasks: allTasks.length,
      objectivesIncluded: eligibleObjectives.length,
      objectivesSkipped: skippedReasons.length,
      skippedReasons,
    },
  };
}

/**
 * Generate a weekly plan and save it via a WeeklyPlanStore.
 * Convenience wrapper that generates + persists in one call.
 *
 * @param {object} params - Same as generateWeeklyPlan params
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} store
 * @param {string} agentId
 * @returns {Promise<{ plan: object, meta: object }>}
 */
export async function generateAndSaveWeeklyPlan(params, store, agentId) {
  const result = generateWeeklyPlan(params);
  await store.save(agentId, result.plan);
  return result;
}
