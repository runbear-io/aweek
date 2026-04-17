/**
 * JSON Schema for execution records.
 * Each record tracks a single heartbeat execution for idempotency enforcement.
 *
 * Fields:
 *   - id:             Unique execution identifier
 *   - idempotencyKey: Hash of agent+timestamp-window to prevent duplicate runs
 *   - agentId:        The agent that was executed
 *   - timestamp:      ISO-8601 datetime when execution started
 *   - windowStart:    ISO-8601 datetime of the time-window start
 *   - windowEnd:      ISO-8601 datetime of the time-window end
 *   - status:         Outcome of the execution
 *   - taskId:         The weekly-plan task ID (if applicable)
 *   - duration:       Wall-clock milliseconds the execution took
 *   - metadata:       Optional extra key-value data (tokens used, error info, etc.)
 */

/** Valid execution statuses */
export const EXECUTION_STATUSES = ['started', 'completed', 'failed', 'skipped'];

export const executionRecordSchema = {
  $id: 'aweek://schemas/execution-record',
  type: 'object',
  required: ['id', 'idempotencyKey', 'agentId', 'timestamp', 'windowStart', 'windowEnd', 'status'],
  properties: {
    id: {
      type: 'string',
      pattern: '^exec-[a-f0-9]+$',
      description: 'Unique execution record identifier',
    },
    idempotencyKey: {
      type: 'string',
      pattern: '^idem-[a-f0-9]+$',
      description: 'Hash key for idempotency (agent + time window)',
    },
    agentId: {
      type: 'string',
      minLength: 1,
      description: 'The agent that was executed',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: 'ISO-8601 datetime when execution started',
    },
    windowStart: {
      type: 'string',
      format: 'date-time',
      description: 'ISO-8601 datetime of the time-window start',
    },
    windowEnd: {
      type: 'string',
      format: 'date-time',
      description: 'ISO-8601 datetime of the time-window end',
    },
    status: {
      type: 'string',
      enum: EXECUTION_STATUSES,
      description: 'Outcome of the execution',
    },
    taskId: {
      type: 'string',
      description: 'The weekly-plan task ID (if applicable)',
    },
    duration: {
      type: 'integer',
      minimum: 0,
      description: 'Wall-clock milliseconds the execution took',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Optional extra key-value data (tokens used, error info, etc.)',
    },
  },
  additionalProperties: false,
};

export const executionLogSchema = {
  $id: 'aweek://schemas/execution-log',
  type: 'array',
  items: { $ref: 'aweek://schemas/execution-record' },
  description: 'Array of execution records for an agent',
};
