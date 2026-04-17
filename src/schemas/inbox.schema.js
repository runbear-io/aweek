/**
 * JSON Schema definitions for the inbox queue data model.
 * Inter-agent task delegation uses asynchronous inbox messages.
 * Each agent has an inbox queue; messages are enqueued by senders
 * and dequeued/processed on the recipient's next heartbeat tick.
 *
 * Message lifecycle: pending → accepted → completed | rejected
 * Priority follows the same scale as weekly tasks for consistency.
 */

/** Valid statuses for inbox messages */
export const MESSAGE_STATUSES = ['pending', 'accepted', 'completed', 'rejected'];

/** Valid priority levels for inbox messages */
export const MESSAGE_PRIORITIES = ['critical', 'high', 'medium', 'low'];

/** Valid message types for inbox messages */
export const MESSAGE_TYPES = ['task-delegation', 'status-update', 'info'];

/**
 * Schema for an individual inbox message (inter-agent delegation).
 * Each message represents a task delegated from one agent to another.
 */
export const inboxMessageSchema = {
  $id: 'aweek://schemas/inbox-message',
  type: 'object',
  required: ['id', 'from', 'to', 'type', 'taskDescription', 'priority', 'createdAt', 'status'],
  properties: {
    id: {
      type: 'string',
      pattern: '^msg-[a-z0-9-]+$',
      description: 'Unique message identifier',
    },
    from: {
      type: 'string',
      pattern: '^agent-[a-z0-9-]+$',
      description: 'Sender agent ID',
    },
    to: {
      type: 'string',
      pattern: '^agent-[a-z0-9-]+$',
      description: 'Recipient agent ID',
    },
    type: {
      type: 'string',
      enum: ['task-delegation', 'status-update', 'info'],
      description: 'Message type — task-delegation for delegated work, status-update for progress, info for notifications',
    },
    taskDescription: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'Description of the delegated task or message content',
    },
    context: {
      type: 'string',
      maxLength: 5000,
      description: 'Additional context, background, or instructions for the task',
    },
    priority: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low'],
      description: 'Message priority — aligns with weekly task priority scale',
    },
    sourceTaskId: {
      type: 'string',
      pattern: '^task-[a-z0-9-]+$',
      description: 'ID of the weekly task that triggered this delegation (traceability)',
    },
    createdAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the message was created/sent',
    },
    status: {
      type: 'string',
      enum: ['pending', 'accepted', 'completed', 'rejected'],
      description: 'Current message status in the processing lifecycle',
    },
    processedAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the message was accepted/rejected',
    },
    completedAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the delegated task was completed',
    },
    result: {
      type: 'string',
      maxLength: 5000,
      description: 'Outcome or result summary after completion',
    },
    rejectionReason: {
      type: 'string',
      maxLength: 1000,
      description: 'Reason for rejection (when status is rejected)',
    },
  },
  additionalProperties: false,
};

/**
 * Schema for an agent's full inbox queue.
 * The inbox is an ordered array of messages, newest last.
 */
export const inboxQueueSchema = {
  $id: 'aweek://schemas/inbox-queue',
  type: 'array',
  items: { $ref: 'aweek://schemas/inbox-message' },
  description: 'Ordered queue of inbox messages for an agent',
};
