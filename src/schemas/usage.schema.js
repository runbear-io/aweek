/**
 * JSON Schema for token usage tracking records.
 * Each record captures per-session token consumption for budget tracking.
 *
 * Fields:
 *   - id:           Unique usage record identifier
 *   - timestamp:    ISO-8601 datetime when the session completed
 *   - agentId:      The agent that consumed the tokens
 *   - taskId:       The weekly-plan task ID that was executed
 *   - sessionId:    Opaque session identifier for deduplication
 *   - inputTokens:  Number of input (prompt) tokens consumed
 *   - outputTokens: Number of output (completion) tokens consumed
 *   - totalTokens:  Sum of input + output tokens
 *   - costUsd:      Estimated cost in USD (from CLI output)
 *   - durationMs:   Wall-clock session duration in milliseconds
 *   - model:        Model used for the session (if known)
 *   - week:         Budget week key (ISO Monday date, e.g. "2026-04-13")
 */

/**
 * Single usage record schema.
 */
export const usageRecordSchema = {
  $id: 'aweek://schemas/usage-record',
  type: 'object',
  required: ['id', 'timestamp', 'agentId', 'taskId', 'inputTokens', 'outputTokens', 'totalTokens', 'week'],
  properties: {
    id: {
      type: 'string',
      pattern: '^usage-[a-f0-9]+$',
      description: 'Unique usage record identifier',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: 'ISO-8601 datetime when the session completed',
    },
    agentId: {
      type: 'string',
      minLength: 1,
      description: 'The agent that consumed the tokens',
    },
    taskId: {
      type: 'string',
      minLength: 1,
      description: 'The weekly-plan task ID that was executed',
    },
    sessionId: {
      type: 'string',
      description: 'Opaque session identifier for deduplication',
    },
    inputTokens: {
      type: 'integer',
      minimum: 0,
      description: 'Number of input (prompt) tokens consumed',
    },
    outputTokens: {
      type: 'integer',
      minimum: 0,
      description: 'Number of output (completion) tokens consumed',
    },
    totalTokens: {
      type: 'integer',
      minimum: 0,
      description: 'Sum of input + output tokens',
    },
    costUsd: {
      type: 'number',
      minimum: 0,
      description: 'Estimated cost in USD (from CLI output)',
    },
    durationMs: {
      type: 'integer',
      minimum: 0,
      description: 'Wall-clock session duration in milliseconds',
    },
    model: {
      type: 'string',
      description: 'Model used for the session (if known)',
    },
    week: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'Budget week key (ISO Monday date, e.g. "2026-04-13")',
    },
  },
  additionalProperties: false,
};

/**
 * Array of usage records (a week's usage log).
 */
export const usageLogSchema = {
  $id: 'aweek://schemas/usage-log',
  type: 'array',
  items: { $ref: 'aweek://schemas/usage-record' },
  description: 'Array of token usage records for an agent',
};
