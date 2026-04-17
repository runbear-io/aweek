/**
 * Storage layer for agent inbox queues.
 * Persists inbox messages as structured JSON under data/agents/<agentId>/inbox.json.
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

export class InboxStore {
  /**
   * @param {string} baseDir - Root data directory (e.g., ./data/agents)
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  /**
   * Directory for an agent's data.
   * @param {string} agentId
   */
  _agentDir(agentId) {
    return join(this.baseDir, agentId);
  }

  /**
   * Path to an agent's inbox file.
   * @param {string} agentId
   */
  _filePath(agentId) {
    return join(this._agentDir(agentId), 'inbox.json');
  }

  /**
   * Ensure the agent directory exists.
   * @param {string} agentId
   */
  async init(agentId) {
    await mkdir(this._agentDir(agentId), { recursive: true });
  }

  /**
   * Load the full inbox queue for an agent.
   * Returns empty array if no inbox file exists yet.
   * Validates against the inbox queue schema on load.
   * @param {string} agentId
   * @returns {Promise<object[]>} Array of inbox messages
   */
  async load(agentId) {
    const filePath = this._filePath(agentId);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const messages = JSON.parse(raw);
      assertValid(QUEUE_SCHEMA_ID, messages);
      return messages;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Save the full inbox queue for an agent.
   * Validates the entire queue before writing.
   * @param {string} agentId
   * @param {object[]} messages - Full inbox queue array
   */
  async _save(agentId, messages) {
    assertValid(QUEUE_SCHEMA_ID, messages);
    await this.init(agentId);
    const filePath = this._filePath(agentId);
    await writeFile(filePath, JSON.stringify(messages, null, 2) + '\n', 'utf-8');
  }

  /**
   * Enqueue a message into an agent's inbox.
   * Validates the message before writing.
   * Idempotent: if a message with the same ID already exists, it is not duplicated.
   * @param {string} agentId - Recipient agent ID
   * @param {object} message - Inbox message (must match inbox-message schema)
   * @returns {Promise<object>} The enqueued message
   */
  async enqueue(agentId, message) {
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

  /**
   * Get a single message by ID from an agent's inbox.
   * @param {string} agentId
   * @param {string} messageId
   * @returns {Promise<object | null>} The message, or null if not found
   */
  async get(agentId, messageId) {
    const messages = await this.load(agentId);
    return messages.find((m) => m.id === messageId) || null;
  }

  /**
   * Update a message in an agent's inbox.
   * The updater receives the current message and returns the updated one.
   * Validates the updated message before saving.
   * @param {string} agentId
   * @param {string} messageId
   * @param {function(object): object} updater - Receives current message, returns updated message
   * @returns {Promise<object>} The updated message
   * @throws {Error} If message not found
   */
  async update(agentId, messageId, updater) {
    const messages = await this.load(agentId);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      throw new Error(`Message not found: ${messageId} in inbox of ${agentId}`);
    }

    const updated = updater(structuredClone(messages[idx]));
    assertValid(MESSAGE_SCHEMA_ID, updated);
    messages[idx] = updated;
    await this._save(agentId, messages);
    return updated;
  }

  /**
   * Transition a message to 'accepted' status.
   * Idempotent: if already accepted, returns current message.
   * @param {string} agentId
   * @param {string} messageId
   * @returns {Promise<object>} The updated message
   */
  async accept(agentId, messageId) {
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
   * @param {string} agentId
   * @param {string} messageId
   * @param {string} [result] - Outcome summary
   * @returns {Promise<object>} The updated message
   */
  async complete(agentId, messageId, result) {
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
   * @param {string} agentId
   * @param {string} messageId
   * @param {string} [reason] - Rejection reason
   * @returns {Promise<object>} The updated message
   */
  async reject(agentId, messageId, reason) {
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
   * @param {string} agentId
   * @param {string} messageId
   * @returns {Promise<boolean>} True if removed, false if not found
   */
  async remove(agentId, messageId) {
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
   * @param {string} agentId
   * @returns {Promise<object[]>} Pending messages, priority-sorted
   */
  async pending(agentId) {
    const messages = await this.load(agentId);
    return sortByPriority(messages.filter((m) => m.status === 'pending'));
  }

  /**
   * Query inbox messages with optional filters.
   * @param {string} agentId
   * @param {object} [filters]
   * @param {string} [filters.status] - Filter by status
   * @param {string} [filters.type] - Filter by message type
   * @param {string} [filters.from] - Filter by sender agent ID
   * @param {string} [filters.priority] - Filter by priority
   * @returns {Promise<object[]>} Matching messages
   */
  async query(agentId, filters = {}) {
    const messages = await this.load(agentId);
    return messages.filter((m) => {
      if (filters.status && m.status !== filters.status) return false;
      if (filters.type && m.type !== filters.type) return false;
      if (filters.from && m.from !== filters.from) return false;
      if (filters.priority && m.priority !== filters.priority) return false;
      return true;
    });
  }

  /**
   * Count messages in an agent's inbox, optionally filtered by status.
   * @param {string} agentId
   * @param {string} [status] - Optional status filter
   * @returns {Promise<number>}
   */
  async count(agentId, status) {
    const messages = await this.load(agentId);
    if (!status) return messages.length;
    return messages.filter((m) => m.status === status).length;
  }

  /**
   * Get a summary of an agent's inbox.
   * @param {string} agentId
   * @returns {Promise<object>} Summary with counts by status and type
   */
  async summary(agentId) {
    const messages = await this.load(agentId);
    const byStatus = {};
    const byType = {};

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
   * @param {string} agentId
   * @returns {Promise<number>} Number of messages removed
   */
  async clearProcessed(agentId) {
    const messages = await this.load(agentId);
    const kept = messages.filter((m) => m.status === 'pending' || m.status === 'accepted');
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
const PRIORITY_WEIGHTS = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Sort messages by priority (critical first, low last).
 * Stable sort: messages with equal priority keep their original order.
 * @param {object[]} messages
 * @returns {object[]} Sorted copy
 */
function sortByPriority(messages) {
  return [...messages].sort(
    (a, b) => (PRIORITY_WEIGHTS[b.priority] || 0) - (PRIORITY_WEIGHTS[a.priority] || 0)
  );
}
