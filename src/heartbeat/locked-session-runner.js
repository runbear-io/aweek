/**
 * Locked Session Runner — integrates lock acquisition and task queuing into
 * the heartbeat/session execution flow.
 *
 * When a heartbeat fires for an agent:
 *   1. Try to acquire the agent lock (via LockManager)
 *   2. If lock acquired → execute the task, then drain any queued tasks
 *   3. If lock is held → enqueue the task for later execution
 *   4. Lock is always released when the executing session finishes
 *
 * Design principles:
 * - Concurrent session attempts for the same agent are blocked
 * - Blocked tasks are enqueued (not dropped) for sequential processing
 * - After completing a task, the runner drains the queue before releasing the lock
 * - Each agent runs independently — no cross-agent lock contention
 * - Idempotent: repeated heartbeats with the same task ID are deduplicated by the queue
 * - File source of truth: locks and queues are persisted to disk
 */

import { acquireLock, releaseLock, queryLock, createLockManager } from '../lock/lock-manager.js';
import { enqueue, dequeue, peek, queueLength, createTaskQueue } from '../queue/task-queue.js';
import { DAILY_REVIEW_OBJECTIVE_ID } from '../schemas/weekly-plan.schema.js';

/**
 * @typedef {object} LockedSessionResult
 * @property {'executed'|'queued'|'error'} status
 * @property {string} agentId
 * @property {string} [taskId]
 * @property {object} [sessionResult]     - Result from the execution callback (when status === 'executed')
 * @property {object} [queueEntry]        - Queue entry (when status === 'queued')
 * @property {number} [queuePosition]     - Position in queue (when status === 'queued')
 * @property {Array<object>} [drainResults] - Results from draining queued tasks after primary execution
 * @property {string} [reason]
 * @property {Error}  [error]
 * @property {string} startedAt
 */

/**
 * @typedef {object} DrainResult
 * @property {string} taskId
 * @property {'executed'|'error'} status
 * @property {object} [sessionResult]
 * @property {Error}  [error]
 */

/**
 * Attempt to run a task for an agent with lock-based isolation and queue fallback.
 *
 * This is the primary entry point for heartbeat-triggered execution with
 * lock + queue integration.
 *
 * @param {string} agentId - Target agent
 * @param {object} taskInfo - Task metadata for queue entry
 * @param {string} taskInfo.taskId - Unique task identifier
 * @param {string} [taskInfo.type='heartbeat'] - Task type
 * @param {number} [taskInfo.priority=3] - Priority 1-5
 * @param {object} [taskInfo.payload={}] - Task-specific data
 * @param {string} [taskInfo.source] - Origin identifier
 * @param {function(string, object): Promise<*>} executeFn - Async function(agentId, taskInfo) that runs the actual session
 * @param {object} [opts]
 * @param {string} [opts.lockDir] - Lock directory
 * @param {number} [opts.maxLockAgeMs] - Max lock age
 * @param {string} [opts.queueDir] - Queue directory
 * @param {boolean} [opts.drainQueue=true] - Whether to drain queued tasks after primary execution
 * @param {import('../storage/agent-store.js').AgentStore} [opts.agentStore] - Optional agent store for pause-check
 * @returns {Promise<LockedSessionResult>}
 */
export async function runWithLockAndQueue(agentId, taskInfo, executeFn, opts = {}) {
  if (!agentId) throw new Error('agentId is required');
  if (!taskInfo) throw new Error('taskInfo is required');
  if (!taskInfo.taskId) throw new Error('taskInfo.taskId is required');
  if (typeof executeFn !== 'function') throw new Error('executeFn must be a function');

  const lockOpts = {};
  if (opts.lockDir) lockOpts.lockDir = opts.lockDir;
  if (opts.maxLockAgeMs !== undefined) lockOpts.maxLockAgeMs = opts.maxLockAgeMs;

  const queueOpts = {};
  if (opts.queueDir) queueOpts.queueDir = opts.queueDir;

  const drainQueue = opts.drainQueue !== false;
  const startedAt = new Date().toISOString();

  // Step 0: Resume guard — skip paused agents before acquiring any lock
  if (opts.agentStore) {
    try {
      const config = await opts.agentStore.load(agentId);
      if (config.budget?.paused === true) {
        return {
          status: 'skipped',
          agentId,
          taskId: taskInfo.taskId,
          reason: `Agent "${agentId}" is paused (budget exhausted). Resume the agent before executing tasks.`,
          pausedReason: 'budget_exhausted',
          startedAt,
        };
      }
    } catch {
      // Graceful degradation: if agent store is unavailable, proceed with execution
    }
  }

  // Step 1: Try to acquire the lock
  const lockResult = await acquireLock(agentId, {
    ...lockOpts,
    sessionInfo: { taskId: taskInfo.taskId, type: taskInfo.type || 'heartbeat' },
  });

  // Step 2: If lock not acquired → enqueue the task
  if (!lockResult.acquired) {
    const enqueueResult = await enqueue(
      {
        agentId,
        taskId: taskInfo.taskId,
        type: taskInfo.type || 'heartbeat',
        priority: taskInfo.priority,
        payload: taskInfo.payload || {},
        source: taskInfo.source,
      },
      queueOpts
    );

    return {
      status: 'queued',
      agentId,
      taskId: taskInfo.taskId,
      queueEntry: enqueueResult.entry,
      queuePosition: enqueueResult.position,
      duplicate: enqueueResult.duplicate || false,
      reason: enqueueResult.duplicate
        ? 'Task already queued (duplicate taskId)'
        : 'Agent is locked — task enqueued for later execution',
      startedAt,
    };
  }

  // Step 3: Lock acquired → execute the task
  try {
    const sessionResult = await executeFn(agentId, taskInfo);

    const result = {
      status: 'executed',
      agentId,
      taskId: taskInfo.taskId,
      sessionResult,
      startedAt,
    };

    // Step 4: Drain any queued tasks before releasing the lock
    if (drainQueue) {
      const drainResults = await drainQueuedTasks(agentId, executeFn, queueOpts);
      if (drainResults.length > 0) {
        result.drainResults = drainResults;
      }
    }

    return result;
  } catch (error) {
    return {
      status: 'error',
      agentId,
      taskId: taskInfo.taskId,
      error,
      reason: `Execution error: ${error.message}`,
      startedAt,
    };
  } finally {
    // Always release the lock
    await releaseLock(agentId, lockOpts);
  }
}

/**
 * Drain all queued tasks for an agent, executing them sequentially.
 *
 * Called after the primary task completes (while still holding the lock).
 * Each queued task is dequeued and executed in priority-then-FIFO order.
 * Errors in one queued task don't stop processing of subsequent tasks.
 *
 * @param {string} agentId
 * @param {function(string, object): Promise<*>} executeFn
 * @param {object} [queueOpts]
 * @param {string} [queueOpts.queueDir]
 * @returns {Promise<Array<DrainResult>>}
 */
export async function drainQueuedTasks(agentId, executeFn, queueOpts = {}) {
  if (!agentId) throw new Error('agentId is required');
  if (typeof executeFn !== 'function') throw new Error('executeFn must be a function');

  const results = [];

  // Drain loop: dequeue one at a time, execute, repeat
  while (true) {
    const dequeueResult = await dequeue(agentId, queueOpts);
    if (!dequeueResult.dequeued) break;

    const entry = dequeueResult.entry;

    try {
      const sessionResult = await executeFn(agentId, {
        taskId: entry.taskId,
        type: entry.type,
        priority: entry.priority,
        payload: entry.payload,
        source: entry.source,
      });

      results.push({
        taskId: entry.taskId,
        status: 'executed',
        sessionResult,
      });
    } catch (error) {
      results.push({
        taskId: entry.taskId,
        status: 'error',
        error,
      });
      // Continue draining — don't stop on error
    }
  }

  return results;
}

/**
 * Run tasks for multiple agents in parallel, each with lock + queue isolation.
 *
 * Agents run concurrently but each agent's tasks are sequential.
 *
 * @param {Array<{agentId: string, taskInfo: object}>} agentTasks
 * @param {function(string, object): Promise<*>} executeFn
 * @param {object} [opts] - Same as runWithLockAndQueue opts
 * @returns {Promise<Array<LockedSessionResult>>}
 */
export async function runAllWithLockAndQueue(agentTasks, executeFn, opts = {}) {
  if (!Array.isArray(agentTasks)) throw new Error('agentTasks must be an array');
  if (typeof executeFn !== 'function') throw new Error('executeFn must be a function');

  return Promise.all(
    agentTasks.map(({ agentId, taskInfo }) =>
      runWithLockAndQueue(agentId, taskInfo, executeFn, opts)
    )
  );
}

/**
 * Create a LockedSessionRunner instance bound to specific lock/queue configuration.
 *
 * @param {object} [opts]
 * @param {string} [opts.lockDir]
 * @param {number} [opts.maxLockAgeMs]
 * @param {string} [opts.queueDir]
 * @param {boolean} [opts.drainQueue=true]
 * @returns {object} LockedSessionRunner API
 */
export function createLockedSessionRunner(opts = {}) {
  return {
    lockDir: opts.lockDir,
    queueDir: opts.queueDir,

    /**
     * Run a task with lock + queue isolation.
     */
    run: (agentId, taskInfo, executeFn) =>
      runWithLockAndQueue(agentId, taskInfo, executeFn, opts),

    /**
     * Run tasks for multiple agents in parallel.
     */
    runAll: (agentTasks, executeFn) =>
      runAllWithLockAndQueue(agentTasks, executeFn, opts),

    /**
     * Drain queued tasks for an agent.
     */
    drain: (agentId, executeFn) =>
      drainQueuedTasks(agentId, executeFn, { queueDir: opts.queueDir }),

    /**
     * Query the lock status for an agent.
     */
    queryLock: (agentId) =>
      queryLock(agentId, { lockDir: opts.lockDir }),

    /**
     * Get queue length for an agent.
     */
    queueLength: (agentId) =>
      queueLength(agentId, { queueDir: opts.queueDir }),

    /**
     * Peek at next queued task.
     */
    peek: (agentId) =>
      peek(agentId, { queueDir: opts.queueDir }),
  };
}

/**
 * Create an executor function that routes daily-review tasks to a dedicated
 * handler instead of the normal session execution path.
 *
 * This is the dispatch layer for the advisor-mode heartbeat pipeline. When
 * a daily-review task (objectiveId === DAILY_REVIEW_OBJECTIVE_ID) is selected
 * for execution — either as the primary tick task or pulled from the drain
 * queue — it must call the review pipeline rather than spawning a CLI session.
 *
 * The returned executor is a drop-in replacement for any `executeFn` passed to
 * `runWithLockAndQueue` or `drainQueuedTasks`. All non-review tasks fall
 * through to `normalExecuteFn` unchanged.
 *
 * The objectiveId is read from `taskInfo.objectiveId` (top-level, the
 * canonical location when enqueueing advisor-mode tasks). Falls back to
 * `taskInfo.payload.objectiveId` for callers that nest the field inside the
 * payload envelope.
 *
 * @param {function(string, object): Promise<*>} normalExecuteFn - Executor for all non-review tasks
 * @param {object} [opts]
 * @param {function(string, object): Promise<*>} [opts.dailyReviewExecuteFn] - Handler for daily-review tasks;
 *   when omitted, daily-review tasks fall through to normalExecuteFn
 * @returns {function(string, object): Promise<*>} Dispatch-aware executor
 */
export function createDispatchingExecutor(normalExecuteFn, opts = {}) {
  if (typeof normalExecuteFn !== 'function') {
    throw new Error('normalExecuteFn must be a function');
  }
  const { dailyReviewExecuteFn } = opts;

  return async function dispatchingExecute(agentId, taskInfo) {
    // Resolve objectiveId from either the top-level field (canonical) or the
    // payload envelope (legacy / alternate callers).
    const objectiveId = taskInfo?.objectiveId ?? taskInfo?.payload?.objectiveId;

    if (objectiveId === DAILY_REVIEW_OBJECTIVE_ID && typeof dailyReviewExecuteFn === 'function') {
      return dailyReviewExecuteFn(agentId, taskInfo);
    }

    return normalExecuteFn(agentId, taskInfo);
  };
}
