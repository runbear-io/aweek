/**
 * JSON Schema definitions for agent goals with time horizons.
 * Goals are classified by horizon: 1mo (short-term), 3mo (medium-term), 1yr (long-term).
 * Plan traceability: monthly objectives trace back to goals via goalId.
 */

/** Valid time horizons for goals */
export const GOAL_HORIZONS = ['1mo', '3mo', '1yr'];

/**
 * Schema for a single goal with time horizon.
 * Each goal has a horizon that indicates its planning timeframe.
 */
export const goalSchema = {
  $id: 'aweek://schemas/goal',
  type: 'object',
  required: ['id', 'description', 'horizon', 'status'],
  properties: {
    id: {
      type: 'string',
      pattern: '^goal-[a-z0-9-]+$',
      description: 'Unique goal identifier',
    },
    description: {
      type: 'string',
      minLength: 1,
      description: 'What this goal aims to achieve',
    },
    horizon: {
      type: 'string',
      enum: ['1mo', '3mo', '1yr'],
      description: 'Time horizon: 1mo (short-term), 3mo (medium-term), 1yr (long-term)',
    },
    status: {
      type: 'string',
      enum: ['active', 'completed', 'paused', 'dropped'],
    },
    targetDate: {
      type: 'string',
      format: 'date',
      description: 'Target completion date (YYYY-MM-DD)',
    },
    createdAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};

/**
 * Schema for the goals array within an agent config.
 * Enforces that at least one goal exists when goals are provided.
 */
export const goalsArraySchema = {
  $id: 'aweek://schemas/goals-array',
  type: 'array',
  items: { $ref: 'aweek://schemas/goal' },
  description: 'Array of agent goals across different time horizons',
};
