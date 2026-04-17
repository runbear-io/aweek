/**
 * JSON Schema definitions for monthly plans.
 * Monthly plans contain objectives that trace back to agent goals via goalId.
 * Plan traceability: goal -> monthly objective -> weekly task.
 */

/** Valid statuses for monthly plan objectives */
export const OBJECTIVE_STATUSES = ['planned', 'in-progress', 'completed', 'dropped'];

/** Valid statuses for monthly plans */
export const MONTHLY_PLAN_STATUSES = ['draft', 'active', 'completed', 'archived'];

/** Schema for a monthly plan objective */
export const monthlyObjectiveSchema = {
  $id: 'aweek://schemas/monthly-objective',
  type: 'object',
  required: ['id', 'description', 'goalId', 'status'],
  properties: {
    id: {
      type: 'string',
      pattern: '^obj-[a-z0-9-]+$',
      description: 'Unique objective identifier',
    },
    description: {
      type: 'string',
      minLength: 1,
      description: 'What this objective aims to accomplish',
    },
    goalId: {
      type: 'string',
      pattern: '^goal-[a-z0-9-]+$',
      description: 'Parent goal this objective traces back to',
    },
    status: {
      type: 'string',
      enum: ['planned', 'in-progress', 'completed', 'dropped'],
    },
    completedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};

/** Schema for a monthly plan */
export const monthlyPlanSchema = {
  $id: 'aweek://schemas/monthly-plan',
  type: 'object',
  required: ['month', 'objectives', 'status'],
  properties: {
    month: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}$',
      description: 'Plan month in YYYY-MM format',
    },
    objectives: {
      type: 'array',
      items: { $ref: 'aweek://schemas/monthly-objective' },
      minItems: 1,
      description: 'Monthly objectives that trace back to goals',
    },
    status: {
      type: 'string',
      enum: ['draft', 'active', 'completed', 'archived'],
      description: 'Current status of the monthly plan',
    },
    summary: {
      type: 'string',
      description: 'Optional high-level summary of this month\'s focus',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};
