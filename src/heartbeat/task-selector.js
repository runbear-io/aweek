/**
 * Task selector — reads an agent's weekly plan and selects tasks to run
 * on the current heartbeat tick.
 *
 * Track-based selection:
 *   - Each task optionally carries a `track` string (e.g. "x-com",
 *     "reddit"). When `track` is absent, `objectiveId` is used as the
 *     default track key so tasks under the same objective pace together.
 *   - At each tick the selector picks ONE top-priority pending task per
 *     distinct track key. Tracks are parallel lanes — the heartbeat
 *     runner drains them serially within a single tick.
 *
 * Ordering:
 *   - Within a track, pick top-priority pending task; ties broken by
 *     original array order (stable).
 *   - Across tracks, the returned array is sorted by the same rule so
 *     the first element is always the overall top-priority task.
 *
 * Idempotent: pure functions with no side effects; calling
 * selectTasksForTick twice on the same plan returns the same picks.
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
 * Resolve the track key for a task: explicit `track` wins, else
 * `objectiveId` is used so tasks under the same objective share a lane.
 *
 * @param {object} task
 * @returns {string}
 */
export function trackKeyOf(task) {
  return task?.track ?? task?.objectiveId ?? '__no_track__';
}

/**
 * Check whether a task's `runAt` slot has arrived.
 *
 * Missing / malformed `runAt` is treated as always-eligible — we'd
 * rather run a task with a bogus timestamp than block the agent forever
 * on a validator miss. Schema validation already rejects malformed
 * values at write time.
 *
 * @param {object} task
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isRunAtReady(task, nowMs) {
  if (!task || task.runAt == null) return true;
  const scheduledMs = Date.parse(task.runAt);
  if (Number.isNaN(scheduledMs)) return true;
  return scheduledMs <= nowMs;
}

/**
 * Filter tasks that are both pending AND time-eligible (no runAt OR
 * runAt <= now).
 *
 * @param {object[]} tasks
 * @param {object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {object[]}
 */
export function filterEligibleTasks(tasks, { nowMs = Date.now() } = {}) {
  return filterPendingTasks(tasks).filter((t) => isRunAtReady(t, nowMs));
}

/**
 * Select one pending task per distinct track from a weekly plan.
 * Returns an array of `{ task, index, trackKey }` sorted by priority
 * (highest first) so callers that only need the top task can take [0].
 *
 * Tasks whose `runAt` is still in the future are excluded; tracks
 * whose only pending tasks are future-scheduled contribute no pick
 * this tick.
 *
 * Returns `[]` if the plan is not approved or has no eligible tasks.
 *
 * @param {object} plan - A weekly plan object (from WeeklyPlanStore)
 * @param {object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {Array<{ task: object, index: number, trackKey: string }>}
 */
export function selectTasksForTickFromPlan(plan, { nowMs = Date.now() } = {}) {
  if (!plan) return [];
  if (!plan.approved) return [];
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return [];

  const eligible = filterEligibleTasks(plan.tasks, { nowMs });
  if (eligible.length === 0) return [];

  // Group eligible tasks by track key (explicit `track` or objectiveId).
  const groups = new Map();
  for (const task of eligible) {
    const key = trackKeyOf(task);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  // Pick top-priority task per track (stable within priority).
  const picks = [];
  for (const [trackKey, tasks] of groups) {
    const sorted = sortByPriority(tasks);
    const selected = sorted[0];
    const index = plan.tasks.findIndex((t) => t.id === selected.id);
    picks.push({ task: selected, index, trackKey });
  }

  // Order the per-track picks by priority so the first element is the
  // overall top-priority task — preserves backward compatibility for
  // selectNextTaskFromPlan, which just returns picks[0].
  picks.sort((a, b) => {
    const diff = priorityWeight(a.task.priority) - priorityWeight(b.task.priority);
    return diff !== 0 ? diff : a.index - b.index;
  });

  return picks;
}

/**
 * Select the top-priority pending task from a weekly plan.
 * Returns null if the plan is not approved or has no pending tasks.
 *
 * Equivalent to `selectTasksForTickFromPlan(plan)[0]`. Retained for
 * callers that only need a single selection; the heartbeat tick runner
 * uses the multi-pick variant directly.
 *
 * @param {object} plan - A weekly plan object (from WeeklyPlanStore)
 * @returns {{ task: object, index: number } | null}
 */
export function selectNextTaskFromPlan(plan, opts) {
  const picks = selectTasksForTickFromPlan(plan, opts);
  if (picks.length === 0) return null;
  const [{ task, index }] = picks;
  return { task, index };
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
 * Load the latest approved plan and select one task per track.
 *
 * Heartbeat's multi-track entry point — the tick runner drains every
 * returned pick serially within a single tick.
 *
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} store
 * @param {string} agentId
 * @returns {Promise<{
 *   picks: Array<{ task: object, index: number, trackKey: string }>,
 *   week: string | null,
 *   plan: object | null,
 * }>}
 */
export async function selectTasksForTick(store, agentId) {
  if (!store) throw new Error('store is required');
  if (!agentId) throw new Error('agentId is required');

  const plan = await store.loadLatestApproved(agentId);
  if (!plan) return { picks: [], week: null, plan: null };

  const picks = selectTasksForTickFromPlan(plan);
  return { picks, week: plan.week, plan };
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
