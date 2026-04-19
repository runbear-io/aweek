/**
 * JSON Schema definitions for weekly plans.
 * Weekly plans contain tasks that trace back to monthly objectives via objectiveId.
 * Plan traceability: goal -> monthly objective -> weekly task.
 */

/** Valid statuses for weekly tasks */
export const TASK_STATUSES = ['pending', 'in-progress', 'completed', 'failed', 'delegated', 'skipped'];

/** Valid priority levels for weekly tasks */
export const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'];

/** Schema for a weekly task */
export const weeklyTaskSchema = {
  $id: 'aweek://schemas/weekly-task',
  type: 'object',
  required: ['id', 'description', 'objectiveId', 'status'],
  properties: {
    id: {
      type: 'string',
      pattern: '^task-[a-z0-9-]+$',
      description: 'Unique task identifier',
    },
    description: {
      type: 'string',
      minLength: 1,
      description: 'What this task accomplishes',
    },
    objectiveId: {
      type: 'string',
      pattern: '^obj-[a-z0-9-]+$',
      description: 'Traces back to a monthly objective',
    },
    priority: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low'],
      description: 'Task priority level (defaults to medium)',
    },
    estimatedMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 480,
      description: 'Estimated time in minutes (1–480)',
    },
    status: {
      type: 'string',
      enum: ['pending', 'in-progress', 'completed', 'failed', 'delegated', 'skipped'],
    },
    delegatedTo: {
      type: 'string',
      description: 'Agent ID if task was delegated',
    },
    runAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Earliest time this task becomes eligible for heartbeat execution. Tasks with runAt > now are skipped until their slot arrives; tasks without runAt follow the usual FIFO/priority rules. Encourages many small, time-slotted tasks over one long task that would burn through everything in a single session.',
    },
    completedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};

/** Schema for a weekly plan */
export const weeklyPlanSchema = {
  $id: 'aweek://schemas/weekly-plan',
  type: 'object',
  required: ['week', 'month', 'tasks', 'approved'],
  properties: {
    week: {
      type: 'string',
      pattern: '^\\d{4}-W\\d{2}$',
      description: 'ISO week format YYYY-Www',
    },
    month: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}$',
      description: 'Parent month this plan belongs to',
    },
    tasks: {
      type: 'array',
      items: { $ref: 'aweek://schemas/weekly-task' },
    },
    approved: {
      type: 'boolean',
      description: 'Human-in-the-loop approval gate',
    },
    approvedAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};
