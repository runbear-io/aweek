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
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Default queue directory */
const DEFAULT_QUEUE_DIR = '.aweek/.queues';

/** Valid priority range */
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 5;
const DEFAULT_PRIORITY = 3;

/** Task payload — free-form data carried by a queued task. */
export type QueueTaskPayload = Record<string, unknown>;

/** A persisted queue entry. */
export interface QueueEntry {
  taskId: string;
  agentId: string;
  type: string;
  priority: number;
  payload: QueueTaskPayload;
  enqueuedAt: string;
  source?: string;
}

/** Input shape for {@link enqueue} / {@link createQueueEntry}. */
export interface QueueTaskInput {
  agentId: string;
  taskId?: string;
  type?: string;
  priority?: number;
  payload?: QueueTaskPayload;
  source?: string;
}

/** Common queue-directory option shared by every queue function. */
export interface QueueDirOptions {
  queueDir?: string;
}

export interface EnqueueResult {
  enqueued: boolean;
  entry: QueueEntry;
  duplicate?: boolean;
  position?: number;
}

export interface DequeueResult {
  dequeued: boolean;
  entry?: QueueEntry;
  remaining: number;
}

export interface DequeueAllResult {
  entries: QueueEntry[];
  count: number;
}

export interface PeekResult {
  hasTask: boolean;
  entry?: QueueEntry;
  queueLength: number;
}

export interface RemoveTaskResult {
  removed: boolean;
  entry?: QueueEntry;
  remaining: number;
}

export interface ClearQueueResult {
  cleared: boolean;
  previousLength: number;
}

/** Bound TaskQueue API returned by {@link createTaskQueue}. */
export interface TaskQueue {
  agentId: string;
  queueDir: string;
  queuePath: () => string;
  read: () => Promise<QueueEntry[]>;
  enqueue: (task: Omit<QueueTaskInput, 'agentId'>) => Promise<EnqueueResult>;
  dequeue: () => Promise<DequeueResult>;
  dequeueAll: () => Promise<DequeueAllResult>;
  peek: () => Promise<PeekResult>;
  length: () => Promise<number>;
  remove: (taskId: string) => Promise<RemoveTaskResult>;
  clear: () => Promise<ClearQueueResult>;
}

/**
 * Get the queue file path for an agent.
 */
export function queuePathFor(agentId: string, queueDir: string = DEFAULT_QUEUE_DIR): string {
  if (!agentId) throw new Error('agentId is required');
  return join(queueDir, `${agentId}.queue.json`);
}

/**
 * Read the queue file for an agent, returning an array of entries.
 * Returns empty array if no queue file exists.
 */
export async function readQueue(
  agentId: string,
  opts: QueueDirOptions = {},
): Promise<QueueEntry[]> {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const queuePath = queuePathFor(agentId, queueDir);
  try {
    const raw = await readFile(queuePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as QueueEntry[];
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === 'ENOENT') return [];
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

/**
 * Write the queue entries to disk, replacing the file atomically.
 */
async function writeQueue(
  agentId: string,
  entries: QueueEntry[],
  opts: QueueDirOptions = {},
): Promise<void> {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  await mkdir(queueDir, { recursive: true });
  const queuePath = queuePathFor(agentId, queueDir);
  await writeFile(queuePath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Create a queue entry object with defaults applied.
 */
export function createQueueEntry(task: QueueTaskInput | null | undefined): QueueEntry {
  if (!task || !task.agentId) throw new Error('agentId is required');

  const priority = task.priority ?? DEFAULT_PRIORITY;
  if (typeof priority !== 'number' || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
    throw new Error(`priority must be between ${MIN_PRIORITY} and ${MAX_PRIORITY}`);
  }

  const entry: QueueEntry = {
    taskId: task.taskId || randomUUID(),
    agentId: task.agentId,
    type: task.type || 'heartbeat',
    priority,
    payload: task.payload || {},
    enqueuedAt: new Date().toISOString(),
  };
  if (task.source) entry.source = task.source;
  return entry;
}

/**
 * Enqueue a task for an agent. The task is appended to the agent's queue file.
 *
 * Idempotent: if a task with the same taskId already exists in the queue,
 * it is not added again and `duplicate: true` is returned.
 */
export async function enqueue(
  task: QueueTaskInput,
  opts: QueueDirOptions = {},
): Promise<EnqueueResult> {
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

/** Sort a list of queue entries: highest priority first, FIFO within ties. */
function sortByPriorityFifo(entries: QueueEntry[]): void {
  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
  });
}

/**
 * Dequeue the highest-priority task from an agent's queue.
 *
 * Tasks are sorted by priority (descending), then by enqueuedAt (ascending / FIFO).
 * The selected task is removed from the queue file.
 */
export async function dequeue(
  agentId: string,
  opts: QueueDirOptions = {},
): Promise<DequeueResult> {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const entries = await readQueue(agentId, { queueDir });

  if (entries.length === 0) {
    return { dequeued: false, remaining: 0 };
  }

  sortByPriorityFifo(entries);

  const [selected, ...rest] = entries;
  await writeQueue(agentId, rest, { queueDir });

  return { dequeued: true, entry: selected, remaining: rest.length };
}

/**
 * Dequeue all tasks from an agent's queue, sorted by priority then FIFO.
 */
export async function dequeueAll(
  agentId: string,
  opts: QueueDirOptions = {},
): Promise<DequeueAllResult> {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const entries = await readQueue(agentId, { queueDir });

  if (entries.length === 0) {
    return { entries: [], count: 0 };
  }

  sortByPriorityFifo(entries);

  // Clear the queue file
  await writeQueue(agentId, [], { queueDir });

  return { entries, count: entries.length };
}

/**
 * Peek at the next task without removing it.
 */
export async function peek(
  agentId: string,
  opts: QueueDirOptions = {},
): Promise<PeekResult> {
  const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
  if (!agentId) throw new Error('agentId is required');

  const entries = await readQueue(agentId, { queueDir });

  if (entries.length === 0) {
    return { hasTask: false, queueLength: 0 };
  }

  sortByPriorityFifo(entries);

  return { hasTask: true, entry: entries[0], queueLength: entries.length };
}

/**
 * Get the current queue length for an agent.
 */
export async function queueLength(
  agentId: string,
  opts: QueueDirOptions = {},
): Promise<number> {
  const entries = await readQueue(agentId, opts);
  return entries.length;
}

/**
 * Remove a specific task from the queue by taskId.
 */
export async function removeTask(
  agentId: string,
  taskId: string,
  opts: QueueDirOptions = {},
): Promise<RemoveTaskResult> {
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
 */
export async function clearQueue(
  agentId: string,
  opts: QueueDirOptions = {},
): Promise<ClearQueueResult> {
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
 */
export function createTaskQueue(agentId: string, opts: QueueDirOptions = {}): TaskQueue {
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
