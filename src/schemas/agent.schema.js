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

/**
 * Subagent slug pattern — lowercase alphanumeric with hyphens, no leading/trailing
 * hyphen, no consecutive hyphens. Matches the set of safe filesystem basenames
 * for `.claude/agents/SLUG.md`.
 */
export const SUBAGENT_SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';

// Identity is no longer part of the aweek JSON. The subagent .md file at
// .claude/agents/SLUG.md is the single source of truth for name, role,
// system prompt, model, tools, skills, and MCP servers.
//
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
      description: 'Whether agent is paused (budget exhausted, missing subagent file, or manually stopped)',
    },
    pausedReason: {
      type: ['string', 'null'],
      enum: ['budget_exhausted', 'subagent_missing', 'manual', null],
      description:
        'Why the agent was paused. Set alongside paused=true so resume flows can distinguish recoverable causes (budget top-up) from identity-loss causes (subagent_missing → restore .claude/agents/<slug>.md). Explicitly `null` on freshly hired shells where paused=false — fresh JSON wrappers (e.g. produced by hire-all) carry the field with a null value so downstream readers can distinguish "never paused" from "field missing because the schema predates the column".',
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
  required: ['id', 'subagentRef', 'goals', 'budget', 'createdAt'],
  properties: {
    id: {
      type: 'string',
      pattern: SUBAGENT_SLUG_PATTERN,
      description:
        'Unique agent identifier. Equals the Claude Code subagent slug (filesystem basename of .claude/agents/SLUG.md).',
    },
    subagentRef: {
      type: 'string',
      pattern: SUBAGENT_SLUG_PATTERN,
      description:
        'Slug of the Claude Code subagent at .claude/agents/SLUG.md — the single source of truth for identity, system prompt, model, tools, skills, and MCP servers. Must equal `id`.',
    },
    goals: { $ref: 'aweek://schemas/goals-array' },
    monthlyPlans: {
      type: 'array',
      items: { $ref: 'aweek://schemas/monthly-plan' },
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
