/**
 * Task selector — reads an agent's weekly plan and selects the next pending task.
 *
 * Selection strategy:
 * 1. Only approved weekly plans are considered
 * 2. Only tasks with status 'pending' are eligible
 * 3. Tasks are sorted by priority: critical > high > medium > low
 * 4. Within the same priority, original array order is preserved (stable sort)
 * 5. The first eligible task is returned
 *
 * Idempotent: calling selectNextTask multiple times with the same plan state
 * always returns the same task — no side effects, no mutations.
 *
 * File source of truth: reads from WeeklyPlanStore, never caches.
 */

/** Priority weights — lower number = higher priority */
const PRIORITY_WEIGHT = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Default priority when task has none set */
const DEFAULT_PRIORITY = 'medium';

/**
 * Get the numeric weight for a priority level.
 * @param {string} [priority] - Priority string
 * @returns {number}
 */
export function priorityWeight(priority) {
  return PRIORITY_WEIGHT[priority ?? DEFAULT_PRIORITY] ?? PRIORITY_WEIGHT[DEFAULT_PRIORITY];
}

/**
 * Filter tasks to only those that are pending (eligible for execution).
 * @param {object[]} tasks - Array of task objects from a weekly plan
 * @returns {object[]} Pending tasks (new array, no mutation)
 */
export function filterPendingTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t) => t.status === 'pending');
}

/**
 * Sort tasks by priority (critical > high > medium > low).
 * Stable sort: tasks with the same priority retain their original order.
 * Returns a new array — does not mutate the input.
 *
 * @param {object[]} tasks - Array of task objects
 * @returns {object[]} Sorted copy
 */
export function sortByPriority(tasks) {
  // Use index to guarantee stability across engines
  const indexed = tasks.map((t, i) => ({ task: t, idx: i }));
  indexed.sort((a, b) => {
    const diff = priorityWeight(a.task.priority) - priorityWeight(b.task.priority);
    return diff !== 0 ? diff : a.idx - b.idx;
  });
  return indexed.map((entry) => entry.task);
}

/**
 * Select the next pending task from a weekly plan object.
 * Returns null if the plan is not approved or has no pending tasks.
 *
 * Pure function — no side effects, no mutations, idempotent.
 *
 * @param {object} plan - A weekly plan object (from WeeklyPlanStore)
 * @returns {{ task: object, index: number } | null} The selected task and its index in the original array, or null
 */
export function selectNextTaskFromPlan(plan) {
  if (!plan) return null;
  if (!plan.approved) return null;
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return null;

  const pending = filterPendingTasks(plan.tasks);
  if (pending.length === 0) return null;

  const sorted = sortByPriority(pending);
  const selected = sorted[0];

  // Find original index for traceability
  const index = plan.tasks.findIndex((t) => t.id === selected.id);

  return { task: selected, index };
}

/**
 * Get a summary of task statuses from a plan.
 * Useful for heartbeat logging and budget decisions.
 *
 * @param {object} plan - A weekly plan object
 * @returns {{ total: number, pending: number, completed: number, failed: number, inProgress: number, delegated: number, skipped: number }}
 */
export function getTaskStatusSummary(plan) {
  const summary = {
    total: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    inProgress: 0,
    delegated: 0,
    skipped: 0,
  };

  if (!plan || !Array.isArray(plan.tasks)) return summary;

  summary.total = plan.tasks.length;
  for (const task of plan.tasks) {
    switch (task.status) {
      case 'pending':
        summary.pending++;
        break;
      case 'completed':
        summary.completed++;
        break;
      case 'failed':
        summary.failed++;
        break;
      case 'in-progress':
        summary.inProgress++;
        break;
      case 'delegated':
        summary.delegated++;
        break;
      case 'skipped':
        summary.skipped++;
        break;
    }
  }
  return summary;
}

/**
 * Check if all tasks in a plan are finished (none pending or in-progress).
 * @param {object} plan - A weekly plan object
 * @returns {boolean}
 */
export function isAllTasksFinished(plan) {
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) return true;
  return plan.tasks.every(
    (t) => t.status !== 'pending' && t.status !== 'in-progress'
  );
}

/**
 * Select the next pending task for an agent from the store.
 * Loads the latest approved plan and selects the highest-priority pending task.
 *
 * This is the main entry point used by the heartbeat system.
 *
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} store - Weekly plan store
 * @param {string} agentId - The agent ID
 * @returns {Promise<{ task: object, index: number, week: string, plan: object } | null>}
 */
export async function selectNextTask(store, agentId) {
  if (!store) throw new Error('store is required');
  if (!agentId) throw new Error('agentId is required');

  const plan = await store.loadLatestApproved(agentId);
  if (!plan) return null;

  const result = selectNextTaskFromPlan(plan);
  if (!result) return null;

  return {
    task: result.task,
    index: result.index,
    week: plan.week,
    plan,
  };
}

/**
 * Select the next task, considering a specific week rather than latest approved.
 * Useful when the heartbeat knows which week to target.
 *
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} store
 * @param {string} agentId
 * @param {string} week - YYYY-Www
 * @returns {Promise<{ task: object, index: number, week: string, plan: object } | null>}
 */
export async function selectNextTaskForWeek(store, agentId, week) {
  if (!store) throw new Error('store is required');
  if (!agentId) throw new Error('agentId is required');
  if (!week) throw new Error('week is required');

  let plan;
  try {
    plan = await store.load(agentId, week);
  } catch {
    return null; // Plan doesn't exist
  }

  const result = selectNextTaskFromPlan(plan);
  if (!result) return null;

  return {
    task: result.task,
    index: result.index,
    week: plan.week,
    plan,
  };
}
