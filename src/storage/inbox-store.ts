/**
 * Storage layer for agent inbox queues.
 * Persists inbox messages as structured JSON under .aweek/agents/<agentId>/inbox.json.
 * Each agent has a single inbox file containing an ordered array of messages.
 * Files are the source of truth — human-readable and skill-readable.
 *
 * Message lifecycle: pending → accepted → completed | rejected
 * Idempotent: enqueuing a message with the same ID is a no-op.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValid } from '../schemas/validator.js';

const MESSAGE_SCHEMA_ID = 'aweek://schemas/inbox-message';
const QUEUE_SCHEMA_ID = 'aweek://schemas/inbox-queue';

/** Lifecycle status of an inbox message. */
export type InboxMessageStatus = 'pending' | 'accepted' | 'completed' | 'rejected';

/** Priority levels for an inbox message — aligned with weekly-task priorities. */
export type InboxMessagePriority = 'critical' | 'high' | 'medium' | 'low';

/** Discriminator for the kind of inbox message. */
export type InboxMessageType = 'task-delegation' | 'status-update' | 'info';

/**
 * Canonical shape of a single inbox message — mirrors `inboxMessageSchema`
 * in `src/schemas/inbox.schema.js`. The schema literal is still authored
 * as a plain JS object, so the TypeScript shape is hand-mirrored here.
 * Required vs. optional matches the schema's `required` array exactly.
 */
export interface InboxMessage {
  /** Unique message identifier (`msg-<lowercase-alphanum-and-hyphens>`). */
  id: string;
  /** Sender agent ID (subagent slug). */
  from: string;
  /** Recipient agent ID (subagent slug). */
  to: string;
  /** Message kind. */
  type: InboxMessageType;
  /** Description of the delegated task or message content. */
  taskDescription: string;
  /** Additional context, background, or instructions for the task. */
  context?: string;
  /** Message priority — aligns with weekly-task priority scale. */
  priority: InboxMessagePriority;
  /** ID of the weekly task that triggered this delegation (traceability). */
  sourceTaskId?: string;
  /** When the message was created/sent. */
  createdAt: string;
  /** Current message status in the processing lifecycle. */
  status: InboxMessageStatus;
  /** When the message was accepted/rejected. */
  processedAt?: string;
  /** When the delegated task was completed. */
  completedAt?: string;
  /** Outcome or result summary after completion. */
  result?: string;
  /** Reason for rejection (when status is rejected). */
  rejectionReason?: string;
}

/** Updater function signature accepted by `InboxStore.update()`. */
export type InboxMessageUpdater = (current: InboxMessage) => InboxMessage;

/** Optional filters for `InboxStore.query()`. */
export interface InboxQueryFilters {
  status?: InboxMessageStatus;
  type?: InboxMessageType;
  /** Sender agent ID. */
  from?: string;
  priority?: InboxMessagePriority;
}

/** Aggregated counts returned by `InboxStore.summary()`. */
export interface InboxSummary {
  total: number;
  byStatus: Partial<Record<InboxMessageStatus, number>>;
  byType: Partial<Record<InboxMessageType, number>>;
}

export class InboxStore {
  /** Root data directory (e.g., ./.aweek/agents) */
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Directory for an agent's data. */
  _agentDir(agentId: string): string {
    return join(this.baseDir, agentId);
  }

  /** Path to an agent's inbox file. */
  _filePath(agentId: string): string {
    return join(this._agentDir(agentId), 'inbox.json');
  }

  /** Ensure the agent directory exists. */
  async init(agentId: string): Promise<void> {
    await mkdir(this._agentDir(agentId), { recursive: true });
  }

  /**
   * Load the full inbox queue for an agent.
   * Returns empty array if no inbox file exists yet.
   * Validates against the inbox queue schema on load.
   */
  async load(agentId: string): Promise<InboxMessage[]> {
    const filePath = this._filePath(agentId);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const messages = JSON.parse(raw) as InboxMessage[];
      assertValid(QUEUE_SCHEMA_ID, messages);
      return messages;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Save the full inbox queue for an agent.
   * Validates the entire queue before writing.
   */
  async _save(agentId: string, messages: InboxMessage[]): Promise<void> {
    assertValid(QUEUE_SCHEMA_ID, messages);
    await this.init(agentId);
    const filePath = this._filePath(agentId);
    await writeFile(filePath, JSON.stringify(messages, null, 2) + '\n', 'utf-8');
  }

  /**
   * Enqueue a message into an agent's inbox.
   * Validates the message before writing.
   * Idempotent: if a message with the same ID already exists, it is not duplicated.
   */
  async enqueue(agentId: string, message: InboxMessage): Promise<InboxMessage> {
    assertValid(MESSAGE_SCHEMA_ID, message);
    const messages = await this.load(agentId);

    // Idempotent: skip if message ID already present
    if (messages.some((m) => m.id === message.id)) {
      return message;
    }

    messages.push(message);
    await this._save(agentId, messages);
    return message;
  }

  /** Get a single message by ID from an agent's inbox. */
  async get(agentId: string, messageId: string): Promise<InboxMessage | null> {
    const messages = await this.load(agentId);
    return messages.find((m) => m.id === messageId) || null;
  }

  /**
   * Update a message in an agent's inbox.
   * The updater receives the current message and returns the updated one.
   * Validates the updated message before saving.
   * @throws If message not found
   */
  async update(
    agentId: string,
    messageId: string,
    updater: InboxMessageUpdater,
  ): Promise<InboxMessage> {
    const messages = await this.load(agentId);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      throw new Error(`Message not found: ${messageId} in inbox of ${agentId}`);
    }

    const current = messages[idx] as InboxMessage;
    const updated = updater(structuredClone(current));
    assertValid(MESSAGE_SCHEMA_ID, updated);
    messages[idx] = updated;
    await this._save(agentId, messages);
    return updated;
  }

  /**
   * Transition a message to 'accepted' status.
   * Idempotent: if already accepted, returns current message.
   */
  async accept(agentId: string, messageId: string): Promise<InboxMessage> {
    return this.update(agentId, messageId, (msg) => {
      if (msg.status === 'accepted') return msg;
      msg.status = 'accepted';
      msg.processedAt = new Date().toISOString();
      return msg;
    });
  }

  /**
   * Transition a message to 'completed' status with an optional result.
   * Idempotent: if already completed, returns current message.
   */
  async complete(
    agentId: string,
    messageId: string,
    result?: string,
  ): Promise<InboxMessage> {
    return this.update(agentId, messageId, (msg) => {
      if (msg.status === 'completed') return msg;
      msg.status = 'completed';
      msg.completedAt = new Date().toISOString();
      if (!msg.processedAt) msg.processedAt = msg.completedAt;
      if (result) msg.result = result;
      return msg;
    });
  }

  /**
   * Transition a message to 'rejected' status with a reason.
   * Idempotent: if already rejected, returns current message.
   */
  async reject(
    agentId: string,
    messageId: string,
    reason?: string,
  ): Promise<InboxMessage> {
    return this.update(agentId, messageId, (msg) => {
      if (msg.status === 'rejected') return msg;
      msg.status = 'rejected';
      msg.processedAt = new Date().toISOString();
      if (reason) msg.rejectionReason = reason;
      return msg;
    });
  }

  /**
   * Remove a message from an agent's inbox by ID.
   * Idempotent: removing a nonexistent message is a no-op.
   * @returns True if removed, false if not found
   */
  async remove(agentId: string, messageId: string): Promise<boolean> {
    const messages = await this.load(agentId);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    messages.splice(idx, 1);
    await this._save(agentId, messages);
    return true;
  }

  /**
   * Get all pending messages for an agent (messages awaiting processing).
   * Returns messages sorted by priority (critical > high > medium > low).
   */
  async pending(agentId: string): Promise<InboxMessage[]> {
    const messages = await this.load(agentId);
    return sortByPriority(messages.filter((m) => m.status === 'pending'));
  }

  /** Query inbox messages with optional filters. */
  async query(
    agentId: string,
    filters: InboxQueryFilters = {},
  ): Promise<InboxMessage[]> {
    const messages = await this.load(agentId);
    return messages.filter((m) => {
      if (filters.status && m.status !== filters.status) return false;
      if (filters.type && m.type !== filters.type) return false;
      if (filters.from && m.from !== filters.from) return false;
      if (filters.priority && m.priority !== filters.priority) return false;
      return true;
    });
  }

  /** Count messages in an agent's inbox, optionally filtered by status. */
  async count(agentId: string, status?: InboxMessageStatus): Promise<number> {
    const messages = await this.load(agentId);
    if (!status) return messages.length;
    return messages.filter((m) => m.status === status).length;
  }

  /** Get a summary of an agent's inbox. */
  async summary(agentId: string): Promise<InboxSummary> {
    const messages = await this.load(agentId);
    const byStatus: Partial<Record<InboxMessageStatus, number>> = {};
    const byType: Partial<Record<InboxMessageType, number>> = {};

    for (const msg of messages) {
      byStatus[msg.status] = (byStatus[msg.status] || 0) + 1;
      byType[msg.type] = (byType[msg.type] || 0) + 1;
    }

    return {
      total: messages.length,
      byStatus,
      byType,
    };
  }

  /**
   * Clear all processed messages (completed + rejected) from an agent's inbox.
   * Keeps only pending and accepted messages. Useful for inbox cleanup.
   * @returns Number of messages removed
   */
  async clearProcessed(agentId: string): Promise<number> {
    const messages = await this.load(agentId);
    const kept = messages.filter(
      (m) => m.status === 'pending' || m.status === 'accepted',
    );
    const removed = messages.length - kept.length;
    if (removed > 0) {
      await this._save(agentId, kept);
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Priority weight mapping for sorting (higher = more urgent) */
const PRIORITY_WEIGHTS: Record<InboxMessagePriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Sort messages by priority (critical first, low last).
 * Stable sort: messages with equal priority keep their original order.
 */
function sortByPriority(messages: InboxMessage[]): InboxMessage[] {
  return [...messages].sort(
    (a, b) =>
      (PRIORITY_WEIGHTS[b.priority] || 0) - (PRIORITY_WEIGHTS[a.priority] || 0),
  );
}

/** Narrow `unknown` to a Node `ErrnoException` so we can read the `code` field. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
