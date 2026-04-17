/**
 * Heartbeat–Task-Selector integration.
 *
 * Wires the heartbeat scheduler (lock-based execution isolation) with the
 * task selector (priority-based pending-task selection) so that each
 * heartbeat tick:
 *
 *   1. Acquires the agent lock (via scheduler)
 *   2. Selects the next pending task from the latest approved weekly plan
 *   3. Marks the task as "in-progress" in the plan file
 *   4. Returns a TaskTickResult describing what was selected (or why nothing was)
 *   5. Releases the lock (always, even on error)
 *
 * Idempotent: repeated heartbeats with no state changes produce the same
 * result. A task already in-progress won't be re-selected (only 'pending'
 * tasks are eligible).
 *
 * File source of truth: all reads and writes go through the stores.
 */

import { selectNextTask, getTaskStatusSummary, isAllTasksFinished } from './task-selector.js';
import {
  computeTimeWindow,
  generateIdempotencyKey,
  createExecutionRecord,
} from '../storage/execution-store.js';

/**
 * @typedef {object} TaskTickResult
 * @property {'task_selected'|'no_pending_tasks'|'all_tasks_finished'|'no_approved_plan'|'skipped'|'error'} outcome
 * @property {string} agentId
 * @property {object} [task]         - The selected task (when outcome === 'task_selected')
 * @property {number} [taskIndex]    - Original index in plan.tasks
 * @property {string} [week]         - The plan week (YYYY-Www)
 * @property {object} [summary]      - Task status summary at tick time
 * @property {string} [reason]       - Human-readable reason (for non-task outcomes)
 * @property {Error}  [error]        - Error object (when outcome === 'error')
 * @property {string} tickedAt       - ISO timestamp of the tick
 */

/**
 * Create a heartbeat callback that selects the next pending task for an agent.
 *
 * This is the glue between `scheduler.runHeartbeat(agentId, callback)` and
 * the task-selector module. The returned callback:
 *   - reads the latest approved weekly plan via `selectNextTask`
 *   - marks the selected task as 'in-progress' in the store
 *   - returns a structured TaskTickResult
 *
 * Usage with scheduler:
 * ```js
 * const scheduler = createScheduler({ lockDir });
 * const callback = createTaskTickCallback({ weeklyPlanStore });
 * const result = await scheduler.runHeartbeat(agentId, callback);
 * // result.result is a TaskTickResult
 * ```
 *
 * @param {object} opts
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} opts.weeklyPlanStore
 * @param {import('../storage/execution-store.js').ExecutionStore} [opts.executionStore] - Optional execution store for deduplication
 * @param {import('../storage/agent-store.js').AgentStore} [opts.agentStore] - Optional agent store for pause-check
 * @param {number} [opts.windowMs=3600000] - Time window for idempotency (default 1 hour)
 * @returns {function(string): Promise<TaskTickResult>}
 */
export function createTaskTickCallback(opts = {}) {
  const { weeklyPlanStore, executionStore, agentStore, windowMs } = opts;
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore is required');

  return async function taskTickCallback(agentId) {
    return tickAgent(agentId, { weeklyPlanStore, executionStore, agentStore, windowMs });
  };
}

/**
 * Execute a single heartbeat tick for an agent: select next task and mark in-progress.
 *
 * Pure integration function — can be used standalone or via createTaskTickCallback.
 *
 * @param {string} agentId
 * @param {object} opts
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} opts.weeklyPlanStore
 * @param {import('../storage/execution-store.js').ExecutionStore} [opts.executionStore] - Optional execution store for deduplication
 * @param {import('../storage/agent-store.js').AgentStore} [opts.agentStore] - Optional agent store for pause-check
 * @param {number} [opts.windowMs=3600000] - Time window for idempotency (default 1 hour)
 * @returns {Promise<TaskTickResult>}
 */
export async function tickAgent(agentId, opts = {}) {
  const { weeklyPlanStore, executionStore, agentStore, windowMs } = opts;
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore is required');
  if (!agentId) throw new Error('agentId is required');

  const now = new Date();
  const tickedAt = now.toISOString();

  try {
    // Step 0a: Resume guard — skip paused agents immediately
    if (agentStore) {
      const paused = await _isAgentPausedSafe(agentStore, agentId);
      if (paused) {
        await _recordExecution(executionStore, agentId, now, windowMs, 'skipped');
        return {
          outcome: 'skipped',
          agentId,
          reason: `Agent "${agentId}" is paused (budget exhausted). Resume the agent before executing tasks.`,
          pausedReason: 'budget_exhausted',
          tickedAt,
        };
      }
    }

    // Step 0b: Deduplication check — skip if this agent+window was already executed
    if (executionStore) {
      const { windowStart } = computeTimeWindow(now, windowMs);
      const idempotencyKey = generateIdempotencyKey(agentId, windowStart);
      const alreadyExecuted = await executionStore.exists(agentId, idempotencyKey);

      if (alreadyExecuted) {
        return {
          outcome: 'skipped',
          agentId,
          reason: `Duplicate heartbeat in time window (key: ${idempotencyKey})`,
          idempotencyKey,
          tickedAt,
        };
      }
    }

    // Step 1: Select next pending task from latest approved plan
    const selection = await selectNextTask(weeklyPlanStore, agentId);

    // No approved plan at all
    if (selection === null) {
      // Distinguish: no approved plan vs all tasks finished
      // selectNextTask returns null for both cases, so we probe further
      const plan = await _loadLatestApprovedSafe(weeklyPlanStore, agentId);

      if (!plan) {
        // Record even no-plan executions to prevent repeated checks in same window
        await _recordExecution(executionStore, agentId, now, windowMs, 'skipped');
        return {
          outcome: 'no_approved_plan',
          agentId,
          reason: 'No approved weekly plan found for agent',
          tickedAt,
        };
      }

      // Plan exists but no pending tasks
      const summary = getTaskStatusSummary(plan);
      const allFinished = isAllTasksFinished(plan);

      await _recordExecution(executionStore, agentId, now, windowMs, 'skipped');
      return {
        outcome: allFinished ? 'all_tasks_finished' : 'no_pending_tasks',
        agentId,
        week: plan.week,
        summary,
        reason: allFinished
          ? 'All tasks in the weekly plan are finished'
          : 'No pending tasks available (some may be in-progress)',
        tickedAt,
      };
    }

    // Step 2: Mark the selected task as 'in-progress'
    await weeklyPlanStore.updateTaskStatus(
      agentId,
      selection.week,
      selection.task.id,
      'in-progress'
    );

    // Step 3: Build summary after marking
    // Re-load to get the updated state
    const updatedPlan = await weeklyPlanStore.load(agentId, selection.week);
    const summary = getTaskStatusSummary(updatedPlan);

    // Step 4: Record successful execution for deduplication
    await _recordExecution(executionStore, agentId, now, windowMs, 'started', selection.task.id);

    return {
      outcome: 'task_selected',
      agentId,
      task: selection.task,
      taskIndex: selection.index,
      week: selection.week,
      summary,
      tickedAt,
    };
  } catch (error) {
    // Record failed execution so we don't retry in the same window
    await _recordExecution(executionStore, agentId, now, windowMs, 'failed');
    return {
      outcome: 'error',
      agentId,
      error,
      reason: `Heartbeat tick error: ${error.message}`,
      tickedAt,
    };
  }
}

/**
 * Record an execution in the execution store (if provided).
 * Gracefully degrades: if the store is not provided or recording fails,
 * execution proceeds unaffected.
 *
 * @param {import('../storage/execution-store.js').ExecutionStore|undefined} executionStore
 * @param {string} agentId
 * @param {Date} date
 * @param {number} [windowMs]
 * @param {string} status
 * @param {string} [taskId]
 * @returns {Promise<void>}
 */
async function _recordExecution(executionStore, agentId, date, windowMs, status, taskId) {
  if (!executionStore) return;
  try {
    const record = createExecutionRecord({ agentId, date, windowMs, status, taskId });
    await executionStore.record(agentId, record);
  } catch {
    // Graceful degradation: execution tracking failure must not break the heartbeat
  }
}

/**
 * Run a full heartbeat tick for an agent using the scheduler (with lock isolation).
 *
 * This is the main entry point for heartbeat-triggered task selection.
 * Combines lock acquisition, task selection, and status update in one call.
 *
 * @param {string} agentId
 * @param {object} opts
 * @param {import('./scheduler.js').Scheduler} opts.scheduler - Scheduler instance from createScheduler()
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} opts.weeklyPlanStore
 * @param {import('../storage/execution-store.js').ExecutionStore} [opts.executionStore] - Optional execution store for deduplication
 * @param {import('../storage/agent-store.js').AgentStore} [opts.agentStore] - Optional agent store for pause-check
 * @param {number} [opts.windowMs] - Time window for idempotency
 * @returns {Promise<{status: string, agentId: string, result?: TaskTickResult, reason?: string, error?: Error}>}
 */
export async function runHeartbeatTick(agentId, opts = {}) {
  const { scheduler, weeklyPlanStore, executionStore, agentStore, windowMs } = opts;
  if (!scheduler) throw new Error('scheduler is required');
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore is required');
  if (!agentId) throw new Error('agentId is required');

  const callback = createTaskTickCallback({ weeklyPlanStore, executionStore, agentStore, windowMs });
  return scheduler.runHeartbeat(agentId, callback);
}

/**
 * Run heartbeat ticks for all agents in parallel.
 * Each agent is independently locked and task-selected.
 *
 * @param {string[]} agentIds
 * @param {object} opts
 * @param {import('./scheduler.js').Scheduler} opts.scheduler
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} opts.weeklyPlanStore
 * @param {import('../storage/execution-store.js').ExecutionStore} [opts.executionStore] - Optional execution store for deduplication
 * @param {import('../storage/agent-store.js').AgentStore} [opts.agentStore] - Optional agent store for pause-check
 * @param {number} [opts.windowMs] - Time window for idempotency
 * @returns {Promise<Array<{status: string, agentId: string, result?: TaskTickResult}>>}
 */
export async function runHeartbeatTickAll(agentIds, opts = {}) {
  const { scheduler, weeklyPlanStore, executionStore, agentStore, windowMs } = opts;
  if (!scheduler) throw new Error('scheduler is required');
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore is required');
  if (!Array.isArray(agentIds)) throw new Error('agentIds must be an array');

  return Promise.all(
    agentIds.map((id) => runHeartbeatTick(id, { scheduler, weeklyPlanStore, executionStore, agentStore, windowMs }))
  );
}

/**
 * Safely load the latest approved plan (returns null on any error).
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} store
 * @param {string} agentId
 * @returns {Promise<object|null>}
 */
async function _loadLatestApprovedSafe(store, agentId) {
  try {
    return await store.loadLatestApproved(agentId);
  } catch {
    return null;
  }
}

/**
 * Safely check if an agent is paused (returns false on any error).
 * Graceful degradation: if the store is unavailable or the agent doesn't exist,
 * we assume the agent is NOT paused (allow execution to proceed).
 *
 * @param {import('../storage/agent-store.js').AgentStore} agentStore
 * @param {string} agentId
 * @returns {Promise<boolean>}
 */
async function _isAgentPausedSafe(agentStore, agentId) {
  try {
    const config = await agentStore.load(agentId);
    return config.budget?.paused === true;
  } catch {
    return false;
  }
}
