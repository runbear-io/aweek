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
 *
 * The two schemas owned by this file (`budgetSchema`, `agentConfigSchema`)
 * are typed via AJV's `JSONSchemaType<T>` generic so the schema literal
 * is compile-time checked against the canonical `Budget` / `Agent`
 * interfaces from `./agent.ts`. Per AJV's strict-null typing, every
 * optional property in the interface (`foo?: T`) requires a matching
 * `nullable: true` flag on its inline schema; `nullable: true` lets the
 * runtime validator accept either the typed value or JSON `null` (and
 * stays compatible with the existing runtime that never serializes
 * `undefined` over the wire). Sub-schemas declared in sibling files
 * remain attached via `{ $ref: '...' }`, which `JSONSchemaType<T>`
 * permits inside `properties` without further annotation.
 */
import type { JSONSchemaType } from 'ajv';
import type { Agent, Budget } from './agent.js';

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

/**
 * Schema for budget tracking — typed against the `Budget` interface.
 *
 * `pausedReason` is modeled as `type: 'string'` plus `nullable: true`
 * (instead of the older JSON-Schema-draft-4 `type: ['string', 'null']`
 * form): AJV's `JSONSchemaType<T>` strictly types each property and
 * `nullable: true` is the canonical way to express a string-OR-null
 * field in AJV's typing while keeping runtime validation behaviour
 * identical (one of the enum strings, or JSON `null`).
 */
export const budgetSchema: JSONSchemaType<Budget> = {
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
      nullable: true,
      description: 'Whether agent is paused (budget exhausted, missing subagent file, or manually stopped)',
    },
    pausedReason: {
      type: 'string',
      // `null` is included in the enum alongside `nullable: true` because
      // AJV's enum check fires before `nullable` and a bare
      // `enum: ['budget_exhausted', ...]` rejects `null` outright. The
      // runtime model writes `pausedReason: null` literally on freshly
      // hired shells, so the schema must accept it.
      enum: ['budget_exhausted', 'subagent_missing', 'manual', null],
      nullable: true,
      description:
        'Why the agent was paused. Set alongside paused=true so resume flows can distinguish recoverable causes (budget top-up) from identity-loss causes (subagent_missing → restore .claude/agents/<slug>.md). Explicitly `null` on freshly hired shells where paused=false — fresh JSON wrappers (e.g. produced by hire-all) carry the field with a null value so downstream readers can distinguish "never paused" from "field missing because the schema predates the column".',
    },
    sessions: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        required: ['timestamp', 'tokensUsed'],
        properties: {
          timestamp: { type: 'string', format: 'date-time' },
          tokensUsed: { type: 'integer', minimum: 0 },
          taskId: { type: 'string', nullable: true },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

/**
 * Full agent config schema — the top-level document stored per agent.
 *
 * Typed against the `Agent` interface from `./agent.ts`. Sub-schemas
 * declared in other files (`goals-array`, `monthly-plan`, `budget`,
 * `inbox-queue`) are referenced via `{ $ref: '...' }`, which
 * `JSONSchemaType<T>` accepts inside `properties` without forcing the
 * schema literal to inline a duplicate sub-schema body. The single
 * non-`$ref` optional collection (`monthlyPlans`) carries
 * `nullable: true` to satisfy AJV's strict-null typing for optional
 * array fields; runtime behaviour is unchanged because callers never
 * serialize an `undefined` array key in the on-disk JSON.
 */
export const agentConfigSchema: JSONSchemaType<Agent> = {
  $id: 'aweek://schemas/agent-config',
  type: 'object',
  // `goals` / `monthlyPlans` are now optional — long-term goals and
  // monthly plans live in free-form `.aweek/agents/<slug>/plan.md`
  // (see src/storage/plan-markdown-store.js). Existing agents may still
  // carry them; new hires default to an empty array for compatibility.
  required: ['id', 'subagentRef', 'budget', 'createdAt'],
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
      nullable: true,
      // The `type: 'object'` on `items` is required to satisfy AJV's
      // strict `JSONSchemaType<MonthlyPlanPlaceholder>` array-items
      // typing; it sits alongside `$ref` and AJV ignores everything
      // except the `$ref` at validation time, so runtime behaviour is
      // unchanged.
      items: { type: 'object', $ref: 'aweek://schemas/monthly-plan' },
    },
    weeklyTokenBudget: {
      type: 'integer',
      minimum: 0,
      default: 500000,
      nullable: true,
      description: 'Per-agent weekly token budget limit. Synced to budget.weeklyTokenLimit on creation.',
    },
    budget: { $ref: 'aweek://schemas/budget' },
    inbox: { $ref: 'aweek://schemas/inbox-queue' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
  additionalProperties: false,
};
