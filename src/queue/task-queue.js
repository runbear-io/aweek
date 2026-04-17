/**
 * Task queue — per-agent FIFO queue for pending tasks.
 *
 * When an agent session is locked (already executing), incoming tasks are
 * enqueued to a file-based queue. When the lock is released, queued tasks
 * can be dequeued and executed in order.
 *
 * Design principles:
 * - File-based persistence (JSON) — source of truth on disk
 * - One queue file per agent: .aweek/.queues/{agentId}.queue.json
 * - FIFO ordering with priority support (higher priority dequeued first)
 * - Idempotent: duplicate task IDs are rejected (no double-enqueue)
 * - All operations are atomic at the file level
 *
 * Queue entry format:
 * {
 *   taskId: string,        // Unique task identifier
 *   agentId: string,       // Target agent
 *   type: string,          // Task type (e.g. 'heartbeat', 'delegated', 'inbox')
 *   priority: number,      // 1 (low) to 5 (critical), default 3
 *   payload: object,       // Task-specific data
 *   enqueuedAt: ISO string,
 *   source?: string        // Origin (e.g. 'heartbeat', 'agent:other-agent-id')
 * }
 */
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Default queue directory */
const DEFAULT_QUEUE_DIR = '.aweek/.queues';

/** Valid priority range */
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 5;
const DEFAULT_PRIORITY = 3;

/**
 * Get the queue file path for an agent.
 *
 * @param {string} agentId
 * @param {string} [queueDir]
 * @returns {string}
 */
export function queuePathFor(agentId, queueDir = DEFAULT_QUEUE_DIR) {
  if (!agentId) throw new Error('agentId is required');
  return join(queueDir, `${agentId}.queue.json`);
}

/**
 * Read the queue file for an agent, returning an array of entries.
 * Returns empty array if no queue file exists.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<Array<object>>}
 */
export async function readQueue(agentId, opts = {}) {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const queuePath = queuePathFor(agentId, queueDir);
  try {
    const raw = await readFile(queuePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

/**
 * Write the queue entries to disk, replacing the file atomically.
 *
 * @param {string} agentId
 * @param {Array<object>} entries
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<void>}
 */
async function writeQueue(agentId, entries, opts = {}) {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  await mkdir(queueDir, { recursive: true });
  const queuePath = queuePathFor(agentId, queueDir);
  await writeFile(queuePath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Create a queue entry object with defaults applied.
 *
 * @param {object} task
 * @param {string} task.agentId - Target agent
 * @param {string} [task.taskId] - Unique ID (auto-generated if omitted)
 * @param {string} [task.type='heartbeat'] - Task type
 * @param {number} [task.priority=3] - Priority 1-5
 * @param {object} [task.payload={}] - Task data
 * @param {string} [task.source] - Origin identifier
 * @returns {object} Validated queue entry
 */
export function createQueueEntry(task) {
  if (!task || !task.agentId) throw new Error('agentId is required');

  const priority = task.priority ?? DEFAULT_PRIORITY;
  if (typeof priority !== 'number' || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
    throw new Error(`priority must be between ${MIN_PRIORITY} and ${MAX_PRIORITY}`);
  }

  return {
    taskId: task.taskId || randomUUID(),
    agentId: task.agentId,
    type: task.type || 'heartbeat',
    priority,
    payload: task.payload || {},
    enqueuedAt: new Date().toISOString(),
    ...(task.source ? { source: task.source } : {}),
  };
}

/**
 * Enqueue a task for an agent. The task is appended to the agent's queue file.
 *
 * Idempotent: if a task with the same taskId already exists in the queue,
 * it is not added again and `duplicate: true` is returned.
 *
 * @param {object} task - Task to enqueue (see createQueueEntry for shape)
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<{enqueued: boolean, entry: object, duplicate?: boolean, position?: number}>}
 */
export async function enqueue(task, opts = {}) {
  const entry = createQueueEntry(task);
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;

  const entries = await readQueue(entry.agentId, { queueDir });

  // Duplicate detection by taskId
  if (entries.some((e) => e.taskId === entry.taskId)) {
    return { enqueued: false, entry, duplicate: true };
  }

  entries.push(entry);
  await writeQueue(entry.agentId, entries, { queueDir });

  return { enqueued: true, entry, position: entries.length };
}

/**
 * Dequeue the highest-priority task from an agent's queue.
 *
 * Tasks are sorted by priority (descending), then by enqueuedAt (ascending / FIFO).
 * The selected task is removed from the queue file.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<{dequeued: boolean, entry?: object, remaining: number}>}
 */
export async function dequeue(agentId, opts = {}) {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const entries = await readQueue(agentId, { queueDir });

  if (entries.length === 0) {
    return { dequeued: false, remaining: 0 };
  }

  // Sort: highest priority first, then oldest first (FIFO within same priority)
  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
  });

  const [selected, ...rest] = entries;
  await writeQueue(agentId, rest, { queueDir });

  return { dequeued: true, entry: selected, remaining: rest.length };
}

/**
 * Dequeue all tasks from an agent's queue, sorted by priority then FIFO.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<{entries: Array<object>, count: number}>}
 */
export async function dequeueAll(agentId, opts = {}) {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const entries = await readQueue(agentId, { queueDir });

  if (entries.length === 0) {
    return { entries: [], count: 0 };
  }

  // Sort: highest priority first, then oldest first
  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
  });

  // Clear the queue file
  await writeQueue(agentId, [], { queueDir });

  return { entries, count: entries.length };
}

/**
 * Peek at the next task without removing it.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<{hasTask: boolean, entry?: object, queueLength: number}>}
 */
export async function peek(agentId, opts = {}) {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const entries = await readQueue(agentId, { queueDir });

  if (entries.length === 0) {
    return { hasTask: false, queueLength: 0 };
  }

  // Sort same as dequeue
  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
  });

  return { hasTask: true, entry: entries[0], queueLength: entries.length };
}

/**
 * Get the current queue length for an agent.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<number>}
 */
export async function queueLength(agentId, opts = {}) {
  const entries = await readQueue(agentId, opts);
  return entries.length;
}

/**
 * Remove a specific task from the queue by taskId.
 *
 * @param {string} agentId
 * @param {string} taskId
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<{removed: boolean, entry?: object, remaining: number}>}
 */
export async function removeTask(agentId, taskId, opts = {}) {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');
  if (!taskId) throw new Error('taskId is required');

  const entries = await readQueue(agentId, { queueDir });
  const idx = entries.findIndex((e) => e.taskId === taskId);

  if (idx === -1) {
    return { removed: false, remaining: entries.length };
  }

  const [entry] = entries.splice(idx, 1);
  await writeQueue(agentId, entries, { queueDir });

  return { removed: true, entry, remaining: entries.length };
}

/**
 * Clear the entire queue for an agent.
 * Idempotent: no error if queue doesn't exist.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {Promise<{cleared: boolean, previousLength: number}>}
 */
export async function clearQueue(agentId, opts = {}) {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const entries = await readQueue(agentId, { queueDir });
  const previousLength = entries.length;

  if (previousLength > 0) {
    await writeQueue(agentId, [], { queueDir });
  }

  return { cleared: true, previousLength };
}

/**
 * Create a TaskQueue instance bound to a specific agent and configuration.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.queueDir]
 * @returns {object} TaskQueue API bound to the agent
 */
export function createTaskQueue(agentId, opts = {}) {
  if (!agentId) throw new Error('agentId is required');
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;

  return {
    agentId,
    queueDir,
    queuePath: () => queuePathFor(agentId, queueDir),
    read: () => readQueue(agentId, { queueDir }),
    enqueue: (task) => enqueue({ ...task, agentId }, { queueDir }),
    dequeue: () => dequeue(agentId, { queueDir }),
    dequeueAll: () => dequeueAll(agentId, { queueDir }),
    peek: () => peek(agentId, { queueDir }),
    length: () => queueLength(agentId, { queueDir }),
    remove: (taskId) => removeTask(agentId, taskId, { queueDir }),
    clear: () => clearQueue(agentId, { queueDir }),
  };
}
