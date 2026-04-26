/**
 * Inbox Processor — picks up delegated tasks from an agent's inbox during heartbeat.
 *
 * When a heartbeat fires for an agent, this module:
 *   1. Loads all pending inbox messages (delegated tasks from other agents)
 *   2. Sorts them by priority (critical > high > medium > low)
 *   3. Accepts each message (marks status → 'accepted')
 *   4. Converts each message into an executable task descriptor
 *   5. After execution, marks messages as 'completed' or 'failed'
 *
 * Design:
 * - Idempotent: only 'pending' messages are picked up; re-running is safe
 * - Priority-ordered: critical inbox tasks are processed before low ones
 * - Graceful: errors processing one message don't block others
 * - File source of truth: all state transitions go through InboxStore
 * - Inter-agent reliability: delegated tasks reliably appear and get picked up
 */

/** Priority weight mapping — higher = more urgent (matches InboxStore sorting) */
const PRIORITY_WEIGHTS = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Sort inbox messages by priority (critical first), then by createdAt (oldest first / FIFO).
 * Returns a new array — does not mutate the input.
 *
 * @param {object[]} messages
 * @returns {object[]} Sorted copy
 */
export function sortInboxByPriority(messages) {
  return [...messages].sort((a, b) => {
    const pDiff = (PRIORITY_WEIGHTS[b.priority] || 0) - (PRIORITY_WEIGHTS[a.priority] || 0);
    if (pDiff !== 0) return pDiff;
    // FIFO within same priority
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

/**
 * Convert an inbox message into a task descriptor suitable for CLI session execution.
 *
 * The returned object matches the shape expected by session-executor / heartbeat-task-runner:
 *   { taskId, type, priority, payload, source }
 *
 * @param {object} message - Inbox message from InboxStore
 * @returns {object} Task descriptor for execution
 */
export function inboxMessageToTask(message) {
  if (!message || !message.id) {
    throw new Error('Invalid inbox message: missing id');
  }

  return {
    taskId: `inbox-${message.id}`,
    type: 'delegated',
    priority: priorityToNumeric(message.priority),
    payload: {
      description: message.taskDescription,
      context: message.context || undefined,
      sourceTaskId: message.sourceTaskId || undefined,
      delegatedFrom: message.from,
      delegatedTo: message.to,
      inboxMessageId: message.id,
    },
    source: `agent:${message.from}`,
  };
}

/**
 * Convert string priority to numeric (1-5) for task queue compatibility.
 * @param {string} priority
 * @returns {number}
 */
function priorityToNumeric(priority) {
  const map = { critical: 5, high: 4, medium: 3, low: 2 };
  return map[priority] || 3;
}

/**
 * @typedef {object} InboxPickupResult
 * @property {string} agentId
 * @property {number} pendingCount - Number of pending messages found
 * @property {number} acceptedCount - Number of messages successfully accepted
 * @property {object[]} tasks - Task descriptors ready for execution
 * @property {object[]} errors - Any errors during acceptance
 * @property {string} processedAt - ISO timestamp
 */

/**
 * Pick up all pending inbox messages for an agent: load, sort, accept, convert to tasks.
 *
 * This is the main entry point called during heartbeat.
 * Only messages with status 'pending' are picked up — already accepted/completed/rejected
 * messages are ignored (idempotent).
 *
 * @param {string} agentId - Recipient agent ID
 * @param {import('../storage/inbox-store.js').InboxStore} inboxStore
 * @returns {Promise<InboxPickupResult>}
 */
export async function pickupInboxTasks(agentId, inboxStore) {
  if (!agentId) throw new Error('agentId is required');
  if (!inboxStore) throw new Error('inboxStore is required');

  const processedAt = new Date().toISOString();
  const tasks = [];
  const errors = [];

  // Step 1: Load pending messages (already filtered + priority-sorted by InboxStore)
  const pendingMessages = await inboxStore.pending(agentId);
  const sorted = sortInboxByPriority(pendingMessages);

  // Step 2: Accept each message and convert to task
  for (const msg of sorted) {
    try {
      // Mark as accepted (idempotent — already-accepted is a no-op inside InboxStore)
      await inboxStore.accept(agentId, msg.id);

      // Convert to task descriptor
      const task = inboxMessageToTask(msg);
      tasks.push(task);
    } catch (err) {
      errors.push({
        messageId: msg.id,
        error: err.message,
      });
    }
  }

  return {
    agentId,
    pendingCount: sorted.length,
    acceptedCount: tasks.length,
    tasks,
    errors,
    processedAt,
  };
}

/**
 * Mark an inbox message as completed after successful execution.
 *
 * @param {string} agentId
 * @param {string} messageId - Original inbox message ID (without 'inbox-' prefix)
 * @param {import('../storage/inbox-store.js').InboxStore} inboxStore
 * @param {string} [result] - Optional result summary
 * @returns {Promise<object>} Updated message
 */
export async function completeInboxTask(agentId, messageId, inboxStore, result) {
  if (!agentId) throw new Error('agentId is required');
  if (!messageId) throw new Error('messageId is required');
  if (!inboxStore) throw new Error('inboxStore is required');

  return inboxStore.complete(agentId, messageId, result);
}

/**
 * Mark an inbox message as failed after execution error.
 *
 * We use reject with a reason, keeping the message in the inbox for visibility.
 *
 * @param {string} agentId
 * @param {string} messageId - Original inbox message ID
 * @param {import('../storage/inbox-store.js').InboxStore} inboxStore
 * @param {string} reason - Error description
 * @returns {Promise<object>} Updated message
 */
export async function failInboxTask(agentId, messageId, inboxStore, reason) {
  if (!agentId) throw new Error('agentId is required');
  if (!messageId) throw new Error('messageId is required');
  if (!inboxStore) throw new Error('inboxStore is required');

  return inboxStore.reject(agentId, messageId, reason || 'Execution failed');
}

/**
 * Extract the original inbox message ID from a task descriptor's taskId.
 * Task IDs from inbox are prefixed with 'inbox-'.
 *
 * @param {string} taskId - e.g., 'inbox-msg-abc123'
 * @returns {string|null} Original message ID, or null if not an inbox task
 */
export function extractInboxMessageId(taskId) {
  if (!taskId || !taskId.startsWith('inbox-')) return null;
  return taskId.slice('inbox-'.length);
}

/**
 * Check if a task descriptor originated from the inbox (delegated task).
 *
 * @param {object} taskInfo - Task descriptor
 * @returns {boolean}
 */
export function isInboxTask(taskInfo) {
  if (!taskInfo) return false;
  return taskInfo.type === 'delegated' || (taskInfo.taskId && taskInfo.taskId.startsWith('inbox-'));
}

/**
 * @typedef {object} InboxHeartbeatResult
 * @property {string} agentId
 * @property {InboxPickupResult} pickup - Results from picking up inbox tasks
 * @property {Array<{taskId: string, messageId: string, status: 'completed'|'failed', result?: *, error?: string}>} executionResults
 * @property {string} startedAt
 * @property {string} completedAt
 */

/**
 * Full heartbeat inbox processing: pickup → execute → mark complete/failed.
 *
 * This combines pickup, execution, and status updates into a single flow.
 * Designed to be called alongside the weekly plan task runner during heartbeat.
 *
 * @param {string} agentId
 * @param {import('../storage/inbox-store.js').InboxStore} inboxStore
 * @param {function(string, object): Promise<*>} [executeFn] - Optional execution function
 *   If provided, each inbox task is executed via executeFn(agentId, taskDescriptor).
 *   If omitted, tasks are only picked up and accepted (execution deferred to caller).
 * @returns {Promise<InboxHeartbeatResult>}
 */
export async function processInboxOnHeartbeat(agentId, inboxStore, executeFn) {
  if (!agentId) throw new Error('agentId is required');
  if (!inboxStore) throw new Error('inboxStore is required');

  const startedAt = new Date().toISOString();
  const executionResults = [];

  // Step 1: Pick up pending inbox tasks
  const pickup = await pickupInboxTasks(agentId, inboxStore);

  // Step 2: If no executeFn, return pickup results only (caller handles execution)
  if (!executeFn || pickup.tasks.length === 0) {
    return {
      agentId,
      pickup,
      executionResults,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // Step 3: Execute each inbox task and mark completion/failure
  for (const task of pickup.tasks) {
    const messageId = extractInboxMessageId(task.taskId);

    try {
      const result = await executeFn(agentId, task);

      // Mark the inbox message as completed
      if (messageId) {
        await completeInboxTask(agentId, messageId, inboxStore,
          typeof result === 'string' ? result : 'Task executed successfully');
      }

      executionResults.push({
        taskId: task.taskId,
        messageId,
        status: 'completed',
        result,
      });
    } catch (err) {
      // Mark the inbox message as failed
      if (messageId) {
        try {
          await failInboxTask(agentId, messageId, inboxStore, err.message);
        } catch {
          // Swallow — best-effort status update
        }
      }

      executionResults.push({
        taskId: task.taskId,
        messageId,
        status: 'failed',
        error: err.message,
      });
    }
  }

  return {
    agentId,
    pickup,
    executionResults,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
