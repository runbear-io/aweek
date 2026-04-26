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

import type {
  InboxMessage,
  InboxMessagePriority,
  InboxStore,
} from '../storage/inbox-store.js';

/** Priority weight mapping — higher = more urgent (matches InboxStore sorting) */
const PRIORITY_WEIGHTS: Record<InboxMessagePriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Task descriptor produced by `inboxMessageToTask` (consumed by session-executor). */
export interface InboxTaskDescriptor {
  taskId: string;
  type: 'delegated';
  priority: number;
  payload: {
    description: string;
    context?: string;
    sourceTaskId?: string;
    delegatedFrom: string;
    delegatedTo: string;
    inboxMessageId: string;
  };
  source: string;
}

export interface InboxAcceptError {
  messageId: string;
  error: string;
}

export interface InboxPickupResult {
  agentId: string;
  pendingCount: number;
  acceptedCount: number;
  tasks: InboxTaskDescriptor[];
  errors: InboxAcceptError[];
  processedAt: string;
}

export interface InboxExecutionResult {
  taskId: string;
  messageId: string | null;
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

export interface InboxHeartbeatResult {
  agentId: string;
  pickup: InboxPickupResult;
  executionResults: InboxExecutionResult[];
  startedAt: string;
  completedAt: string;
}

export type InboxExecuteFn = (
  agentId: string,
  task: InboxTaskDescriptor,
) => Promise<unknown>;

/**
 * Sort inbox messages by priority (critical first), then by createdAt (oldest first / FIFO).
 * Returns a new array — does not mutate the input.
 *
 * @param {object[]} messages
 * @returns {object[]} Sorted copy
 */
export function sortInboxByPriority(messages: InboxMessage[]): InboxMessage[] {
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
export function inboxMessageToTask(message: InboxMessage): InboxTaskDescriptor {
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
function priorityToNumeric(priority: InboxMessagePriority | string): number {
  const map: Record<InboxMessagePriority, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
  };
  return map[priority as InboxMessagePriority] || 3;
}

/**
 * Pick up all pending inbox messages for an agent: load, sort, accept, convert to tasks.
 *
 * This is the main entry point called during heartbeat.
 * Only messages with status 'pending' are picked up — already accepted/completed/rejected
 * messages are ignored (idempotent).
 */
export async function pickupInboxTasks(
  agentId: string,
  inboxStore: InboxStore,
): Promise<InboxPickupResult> {
  if (!agentId) throw new Error('agentId is required');
  if (!inboxStore) throw new Error('inboxStore is required');

  const processedAt = new Date().toISOString();
  const tasks: InboxTaskDescriptor[] = [];
  const errors: InboxAcceptError[] = [];

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
        error: err instanceof Error ? err.message : String(err),
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
 */
export async function completeInboxTask(
  agentId: string,
  messageId: string,
  inboxStore: InboxStore,
  result?: string,
): Promise<InboxMessage> {
  if (!agentId) throw new Error('agentId is required');
  if (!messageId) throw new Error('messageId is required');
  if (!inboxStore) throw new Error('inboxStore is required');

  return inboxStore.complete(agentId, messageId, result);
}

/**
 * Mark an inbox message as failed after execution error.
 *
 * We use reject with a reason, keeping the message in the inbox for visibility.
 */
export async function failInboxTask(
  agentId: string,
  messageId: string,
  inboxStore: InboxStore,
  reason: string,
): Promise<InboxMessage> {
  if (!agentId) throw new Error('agentId is required');
  if (!messageId) throw new Error('messageId is required');
  if (!inboxStore) throw new Error('inboxStore is required');

  return inboxStore.reject(agentId, messageId, reason || 'Execution failed');
}

/**
 * Extract the original inbox message ID from a task descriptor's taskId.
 * Task IDs from inbox are prefixed with 'inbox-'.
 */
export function extractInboxMessageId(taskId: string | null | undefined): string | null {
  if (!taskId || !taskId.startsWith('inbox-')) return null;
  return taskId.slice('inbox-'.length);
}

/**
 * Check if a task descriptor originated from the inbox (delegated task).
 */
export function isInboxTask(taskInfo: { type?: string; taskId?: string } | null | undefined): boolean {
  if (!taskInfo) return false;
  return taskInfo.type === 'delegated' || (!!taskInfo.taskId && taskInfo.taskId.startsWith('inbox-'));
}

/**
 * Full heartbeat inbox processing: pickup → execute → mark complete/failed.
 *
 * This combines pickup, execution, and status updates into a single flow.
 * Designed to be called alongside the weekly plan task runner during heartbeat.
 */
export async function processInboxOnHeartbeat(
  agentId: string,
  inboxStore: InboxStore,
  executeFn?: InboxExecuteFn,
): Promise<InboxHeartbeatResult> {
  if (!agentId) throw new Error('agentId is required');
  if (!inboxStore) throw new Error('inboxStore is required');

  const startedAt = new Date().toISOString();
  const executionResults: InboxExecutionResult[] = [];

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
      const errMessage = err instanceof Error ? err.message : String(err);
      // Mark the inbox message as failed
      if (messageId) {
        try {
          await failInboxTask(agentId, messageId, inboxStore, errMessage);
        } catch {
          // Swallow — best-effort status update
        }
      }

      executionResults.push({
        taskId: task.taskId,
        messageId,
        status: 'failed',
        error: errMessage,
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
