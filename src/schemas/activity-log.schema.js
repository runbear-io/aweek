/**
 * JSON Schema for activity log entries.
 * Each entry records a discrete agent action with structured metadata.
 *
 * Fields:
 *   - id:          Unique log entry identifier
 *   - timestamp:   ISO-8601 datetime when the activity occurred
 *   - agentId:     The agent that performed the activity
 *   - taskId:      The weekly-plan task ID (if applicable)
 *   - status:      Outcome of the activity
 *   - title:       Short single-line label sourced from the task's title —
 *                  the log is a user-facing surface, so it tracks the
 *                  calendar label rather than the full prompt.
 *   - duration:    Wall-clock milliseconds the activity took
 *   - metadata:    Optional extra key-value data (tokens used, error info, etc.)
 */

/** Valid activity statuses */
export const ACTIVITY_STATUSES = ['started', 'completed', 'failed', 'skipped', 'delegated'];

export const activityLogEntrySchema = {
  $id: 'aweek://schemas/activity-log-entry',
  type: 'object',
  required: ['id', 'timestamp', 'agentId', 'status', 'title'],
  properties: {
    id: {
      type: 'string',
      pattern: '^log-[a-f0-9]+$',
      description: 'Unique log entry identifier',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: 'ISO-8601 datetime when the activity occurred',
    },
    agentId: {
      type: 'string',
      description: 'The agent that performed the activity',
    },
    taskId: {
      type: 'string',
      description: 'The weekly-plan task ID (if applicable)',
    },
    status: {
      type: 'string',
      enum: ACTIVITY_STATUSES,
      description: 'Outcome of the activity',
    },
    title: {
      type: 'string',
      minLength: 1,
      description:
        'Short single-line label sourced from the task title when the log ' +
        'entry traces back to a weekly task.',
    },
    duration: {
      type: 'integer',
      minimum: 0,
      description: 'Wall-clock milliseconds the activity took',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Optional extra key-value data (tokens used, error info, etc.)',
    },
  },
  additionalProperties: false,
};

export const activityLogSchema = {
  $id: 'aweek://schemas/activity-log',
  type: 'array',
  items: { $ref: 'aweek://schemas/activity-log-entry' },
  description: 'Array of activity log entries for an agent',
};
