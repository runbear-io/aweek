/**
 * JSON Schema definitions for agent data model.
 * All artifacts follow fixed templates/schemas for programmatic validation.
 *
 * Schema hierarchy (plan traceability):
 *   goals (1mo/3mo/1yr) -> monthly objectives -> weekly tasks
 *
 * Dedicated schemas are defined in:
 *   - goals.schema.js         — goal with time horizons
 *   - monthly-plan.schema.js  — monthly plans and objectives
 *   - weekly-plan.schema.js   — weekly plans and tasks
 */

// Re-export dedicated schemas
export { goalSchema, goalsArraySchema, GOAL_HORIZONS } from './goals.schema.js';
export { monthlyObjectiveSchema, monthlyPlanSchema, OBJECTIVE_STATUSES, MONTHLY_PLAN_STATUSES } from './monthly-plan.schema.js';
export { weeklyTaskSchema, weeklyPlanSchema, TASK_STATUSES, TASK_PRIORITIES } from './weekly-plan.schema.js';
export { inboxMessageSchema, inboxQueueSchema, MESSAGE_STATUSES, MESSAGE_PRIORITIES, MESSAGE_TYPES } from './inbox.schema.js';

/** Schema for agent identity */
export const identitySchema = {
  $id: 'aweek://schemas/identity',
  type: 'object',
  required: ['name', 'role', 'systemPrompt'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Human-readable agent name',
    },
    role: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Brief description of the agent role',
    },
    systemPrompt: {
      type: 'string',
      minLength: 1,
      description: 'System prompt / personality for Claude Code sessions',
    },
  },
  additionalProperties: false,
};

// weeklyTaskSchema and weeklyPlanSchema are now in weekly-plan.schema.js

/** Schema for budget tracking */
export const budgetSchema = {
  $id: 'aweek://schemas/budget',
  type: 'object',
  required: ['weeklyTokenLimit', 'currentUsage', 'periodStart'],
  properties: {
    weeklyTokenLimit: {
      type: 'integer',
      minimum: 0,
      description: 'Max tokens per week',
    },
    currentUsage: {
      type: 'integer',
      minimum: 0,
      description: 'Tokens consumed this period',
    },
    periodStart: {
      type: 'string',
      format: 'date-time',
      description: 'Monday of the current budget week',
    },
    paused: {
      type: 'boolean',
      default: false,
      description: 'Whether agent is paused due to budget exhaustion',
    },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['timestamp', 'tokensUsed'],
        properties: {
          timestamp: { type: 'string', format: 'date-time' },
          tokensUsed: { type: 'integer', minimum: 0 },
          taskId: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

/**
 * Full agent config schema — the top-level document stored per agent.
 */
export const agentConfigSchema = {
  $id: 'aweek://schemas/agent-config',
  type: 'object',
  required: ['id', 'identity', 'goals', 'budget', 'createdAt'],
  properties: {
    id: {
      type: 'string',
      pattern: '^agent-[a-z0-9-]+$',
      description: 'Unique agent identifier',
    },
    identity: { $ref: 'aweek://schemas/identity' },
    goals: { $ref: 'aweek://schemas/goals-array' },
    monthlyPlans: {
      type: 'array',
      items: { $ref: 'aweek://schemas/monthly-plan' },
    },
    weeklyPlans: {
      type: 'array',
      items: { $ref: 'aweek://schemas/weekly-plan' },
    },
    weeklyTokenBudget: {
      type: 'integer',
      minimum: 0,
      default: 500000,
      description: 'Per-agent weekly token budget limit. Synced to budget.weeklyTokenLimit on creation.',
    },
    budget: { $ref: 'aweek://schemas/budget' },
    inbox: { $ref: 'aweek://schemas/inbox-queue' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};
