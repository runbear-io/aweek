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
import { createTickExecutionRecord } from '../storage/execution-store.js';
import { resolveSubagentFile } from '../subagents/subagent-file.js';

/**
 * @typedef {object} TaskTickResult
 * @property {'task_selected'|'no_pending_tasks'|'all_tasks_finished'|'no_approved_plan'|'no_weekly_plans'|'skipped'|'error'} outcome
 * @property {string} agentId
 * @property {object} [task]         - The selected task (when outcome === 'task_selected')
 * @property {number} [taskIndex]    - Original index in plan.tasks
 * @property {string} [week]         - The plan week (YYYY-Www)
 * @property {object} [summary]      - Task status summary at tick time
 * @property {string} [reason]       - Human-readable reason (for non-task outcomes)
 * @property {Error}  [error]        - Error object (when outcome === 'error')
 * @property {string} tickedAt       - ISO timestamp of the tick
 *
 * outcome === 'no_weekly_plans' identifies "shell" agents — typically freshly
 * hired via `hireAllSubagents` — that have a valid subagent `.md` + aweek JSON
 * wrapper but no weekly plan files on disk yet. These are distinct from
 * `no_approved_plan` agents (which DO have plans, just none approved); the
 * resume path is to author + approve a plan via `/aweek:plan`, not to approve
 * an existing draft.
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
  const { weeklyPlanStore, executionStore, agentStore, windowMs, projectDir, home } = opts;
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore is required');

  return async function taskTickCallback(agentId) {
    return tickAgent(agentId, {
      weeklyPlanStore,
      executionStore,
      agentStore,
      windowMs,
      projectDir,
      home,
    });
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
 * @param {string} [opts.projectDir] - Project root for subagent-file resolution
 *   (defaults to `process.cwd()` inside `resolveSubagentFile`). Exposed so
 *   tests can verify the subagent-missing auto-pause without touching cwd.
 * @param {string} [opts.home] - User home override for subagent-file resolution
 *   (tests only; defaults to `os.homedir()`).
 * @returns {Promise<TaskTickResult>}
 */
export async function tickAgent(agentId, opts = {}) {
  const { weeklyPlanStore, executionStore, agentStore, windowMs, projectDir, home } = opts;
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore is required');
  if (!agentId) throw new Error('agentId is required');

  const now = new Date();
  const tickedAt = now.toISOString();

  try {
    // Step 0a: Resume guard — skip paused agents immediately.
    //
    // We read the persisted pausedReason (if any) so the skipped outcome
    // can surface WHY the agent is paused — a subagent_missing pause, for
    // example, must not be confused with a budget_exhausted pause because
    // the resume path is different (restore the .md file, not top up the
    // token budget).
    if (agentStore) {
      const pausedInfo = await _readAgentPauseStateSafe(agentStore, agentId);
      if (pausedInfo.paused) {
        await _recordExecution(executionStore, agentId, now, 'skipped');
        const reason =
          pausedInfo.pausedReason === 'subagent_missing'
            ? `Agent "${agentId}" is paused (subagent file missing). Restore .claude/agents/${agentId}.md before executing tasks.`
            : `Agent "${agentId}" is paused (budget exhausted). Resume the agent before executing tasks.`;
        return {
          outcome: 'skipped',
          agentId,
          reason,
          pausedReason: pausedInfo.pausedReason || 'budget_exhausted',
          tickedAt,
        };
      }
    }

    // Step 0a': Subagent-file guard — auto-pause when the backing .md is gone.
    //
    // The subagent file at `.claude/agents/<slug>.md` (or the user-level
    // `~/.claude/agents/<slug>.md`) is the single source of truth for
    // identity: without it, Claude Code's `--agent <slug>` lookup fails and
    // any spawn would crash-loop. We therefore:
    //
    //   1. Resolve the subagentRef (falling back to the agentId when the
    //      slug-equals-id invariant holds, which it does post-refactor).
    //   2. Check EITHER location (`resolveSubagentFile` probes project then
    //      user level).
    //   3. If missing, persist `budget.paused = true` + `pausedReason =
    //      'subagent_missing'` and return `skipped` WITHOUT throwing.
    //
    // All error paths degrade gracefully: if the agent store itself is
    // broken we proceed as if the subagent exists rather than block the
    // tick. The next tick with a working store will redo the check.
    if (agentStore) {
      const missingResult = await _autoPauseIfSubagentMissing({
        agentStore,
        agentId,
        projectDir,
        home,
        now,
        executionStore,
        windowMs,
        tickedAt,
      });
      if (missingResult) return missingResult;
    }

    // Step 0c: Shell-agent guard — skip agents with no weekly plan entries.
    //
    // Agents created via `hireAllSubagents` (or the `select-some` variant of
    // the `/aweek:init` post-setup menu) land on disk as "shells": a valid
    // aweek JSON wrapper + a `.claude/agents/<slug>.md` subagent file, but
    // NO weekly plan files under `.aweek/agents/<slug>/weekly-plans/`. Ticking
    // such an agent through `selectNextTask` would work (it returns null, and
    // we'd fall through to the `no_approved_plan` branch), but conflating
    // "shell" with "has plans, none approved" hides an actionable distinction:
    //
    //   - Shell  → resume path: author + approve a plan (`/aweek:plan`).
    //   - Has unapproved plan → resume path: `/aweek:approve-plan`.
    //
    // Detect it explicitly here so the outcome string and reason can name the
    // shell case, surface `hasWeeklyPlans: false`, and still record a skipped
    // execution for dedup parity with the other skipped branches.
    const weeklyPlanListing = await _listWeeklyPlanWeeksSafe(weeklyPlanStore, agentId);
    if (weeklyPlanListing.ok && weeklyPlanListing.weeks.length === 0) {
      await _recordExecution(executionStore, agentId, now, 'skipped');
      return {
        outcome: 'no_weekly_plans',
        agentId,
        reason:
          `Agent "${agentId}" has no weekly plan entries — it appears to be a freshly hired shell. ` +
          `Author and approve a weekly plan before the heartbeat can select tasks.`,
        hasWeeklyPlans: false,
        tickedAt,
      };
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
        await _recordExecution(executionStore, agentId, now, 'skipped');
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

      await _recordExecution(executionStore, agentId, now, 'skipped');
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
    await _recordExecution(executionStore, agentId, now, 'started', selection.task.id);

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
    await _recordExecution(executionStore, agentId, now, 'failed');
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
 *
 * Each call produces a unique `idempotencyKey` so the store's internal
 * dedup never collapses two ticks into one row — the audit trail needs
 * one row per tick regardless of cadence. True duplicate-run prevention
 * is handled upstream by the per-agent file lock + the atomic
 * `pending → in-progress` task transition.
 *
 * Gracefully degrades: if the store is not provided or recording fails,
 * execution proceeds unaffected.
 *
 * @param {import('../storage/execution-store.js').ExecutionStore|undefined} executionStore
 * @param {string} agentId
 * @param {Date} date
 * @param {string} status
 * @param {string} [taskId]
 * @returns {Promise<void>}
 */
async function _recordExecution(executionStore, agentId, date, status, taskId) {
  if (!executionStore) return;
  try {
    const record = createTickExecutionRecord({ agentId, date, status, taskId });
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
  const { scheduler, weeklyPlanStore, executionStore, agentStore, windowMs, projectDir, home } = opts;
  if (!scheduler) throw new Error('scheduler is required');
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore is required');
  if (!agentId) throw new Error('agentId is required');

  const callback = createTaskTickCallback({
    weeklyPlanStore,
    executionStore,
    agentStore,
    windowMs,
    projectDir,
    home,
  });
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
  const { scheduler, weeklyPlanStore, executionStore, agentStore, windowMs, projectDir, home } = opts;
  if (!scheduler) throw new Error('scheduler is required');
  if (!weeklyPlanStore) throw new Error('weeklyPlanStore is required');
  if (!Array.isArray(agentIds)) throw new Error('agentIds must be an array');

  return Promise.all(
    agentIds.map((id) =>
      runHeartbeatTick(id, {
        scheduler,
        weeklyPlanStore,
        executionStore,
        agentStore,
        windowMs,
        projectDir,
        home,
      })
    )
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
 * Safely list the weekly plan weeks for an agent.
 *
 * Used by the shell-agent guard to distinguish "no weekly plan files at all"
 * (shell) from "has weekly plan files but none approved" (draft pending
 * approval). The `ok: false` branch lets callers skip the shell guard and
 * fall through to the downstream plan-approval branches when the store is
 * unavailable — graceful degradation per the `graceful_degradation`
 * principle: a missing `.list` method or a filesystem hiccup must not block
 * the tick.
 *
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} store
 * @param {string} agentId
 * @returns {Promise<{ ok: boolean, weeks: string[] }>}
 *   - `ok: true`  — listing succeeded; `weeks` is the array of YYYY-Www keys.
 *   - `ok: false` — listing unavailable (no `.list` method or threw); caller
 *     should skip the shell guard and continue the tick.
 */
async function _listWeeklyPlanWeeksSafe(store, agentId) {
  if (!store || typeof store.list !== 'function') {
    return { ok: false, weeks: [] };
  }
  try {
    const weeks = await store.list(agentId);
    return { ok: true, weeks: Array.isArray(weeks) ? weeks : [] };
  } catch {
    return { ok: false, weeks: [] };
  }
}

/**
 * Safely read an agent's pause state (returns `{ paused: false }` on any error).
 * Graceful degradation: if the store is unavailable or the agent doesn't exist,
 * we assume the agent is NOT paused (allow execution to proceed).
 *
 * Surfaces `pausedReason` alongside `paused` so the heartbeat can report the
 * correct cause in its skipped outcome without re-reading the config.
 *
 * @param {import('../storage/agent-store.js').AgentStore} agentStore
 * @param {string} agentId
 * @returns {Promise<{ paused: boolean, pausedReason: string|undefined }>}
 */
async function _readAgentPauseStateSafe(agentStore, agentId) {
  try {
    const config = await agentStore.load(agentId);
    return {
      paused: config.budget?.paused === true,
      pausedReason: config.budget?.pausedReason,
    };
  } catch {
    return { paused: false, pausedReason: undefined };
  }
}

/**
 * If the agent's backing subagent .md file is missing at BOTH project and
 * user level, persist `budget.paused = true` + `budget.pausedReason =
 * 'subagent_missing'` and return a skipped TaskTickResult. Otherwise return
 * `null` so the tick proceeds.
 *
 * Never throws: every failure mode (agent load error, file-system error,
 * persist error) is caught and the caller is told to proceed. The
 * next heartbeat will re-check with fresh state.
 *
 * @param {object} params
 * @param {import('../storage/agent-store.js').AgentStore} params.agentStore
 * @param {string} params.agentId
 * @param {string} [params.projectDir]
 * @param {string} [params.home]
 * @param {Date}   params.now
 * @param {import('../storage/execution-store.js').ExecutionStore} [params.executionStore]
 * @param {number} [params.windowMs]
 * @param {string} params.tickedAt
 * @returns {Promise<TaskTickResult|null>}
 */
async function _autoPauseIfSubagentMissing(params) {
  const {
    agentStore,
    agentId,
    projectDir,
    home,
    now,
    executionStore,
    windowMs,
    tickedAt,
  } = params;

  let config;
  try {
    config = await agentStore.load(agentId);
  } catch {
    // Store unavailable or agent missing → proceed; the existing flow will
    // emit its own error/skipped outcome.
    return null;
  }

  const subagentRef = (typeof config.subagentRef === 'string' && config.subagentRef)
    ? config.subagentRef
    : agentId;

  let resolution;
  try {
    resolution = await resolveSubagentFile(subagentRef, { projectDir, home });
  } catch {
    // File-system probe failed — proceed rather than block. A subsequent
    // tick will try again.
    return null;
  }

  if (resolution.exists) return null;

  // Persist the auto-pause. Never throw: if the write fails we still return
  // a skipped outcome (the caller has already verified the file is missing,
  // so proceeding to spawn would crash-loop anyway).
  try {
    await agentStore.update(agentId, (cfg) => {
      if (!cfg.budget) cfg.budget = {};
      cfg.budget.paused = true;
      cfg.budget.pausedReason = 'subagent_missing';
      return cfg;
    });
  } catch {
    // Persist failed; still degrade gracefully by returning the skipped
    // outcome. The next tick will retry the persist.
  }

  await _recordExecution(executionStore, agentId, now, 'skipped');

  return {
    outcome: 'skipped',
    agentId,
    reason:
      `Agent "${agentId}" is paused: subagent file not found at ${resolution.projectPath} or ${resolution.userPath}. ` +
      `Restore the .md file and resume the agent.`,
    pausedReason: 'subagent_missing',
    subagentRef,
    checkedPaths: {
      project: resolution.projectPath,
      user: resolution.userPath,
    },
    tickedAt,
  };
}
