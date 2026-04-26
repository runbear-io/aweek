/**
 * Canonical TypeScript types for the agent data model.
 *
 * `Agent` mirrors the runtime shape produced by `createAgentConfig`
 * (src/models/agent.js) and validated at runtime by `agentConfigSchema`
 * (src/schemas/agent.schema.ts). It is the single source of truth for
 * the on-disk JSON document stored at `.aweek/agents/<slug>.json`.
 *
 * Identity fields (name, role, system prompt, model, tools, skills, MCP
 * servers) intentionally do NOT appear here — the Claude Code subagent
 * file at `.claude/agents/<slug>.md` is the only source of truth for
 * identity. This split (identity in `.md`, scheduling state in `.json`)
 * is the 1-to-1 wrapper contract documented in CLAUDE.md.
 *
 * The `Budget` and `Agent` interfaces are wired to `budgetSchema` and
 * `agentConfigSchema` (in `./agent.schema.ts`) via AJV's
 * `JSONSchemaType<T>` generic, so the schema literal is compile-time
 * checked against this interface.
 *
 * Per the seed's tsconfig profile, `exactOptionalPropertyTypes` is OFF
 * — so an optional property `foo?: T` accepts both an explicit
 * `undefined` and a fully omitted key, matching the runtime behavior of
 * the existing factories that conditionally assign optional fields.
 */

// ---------------------------------------------------------------------------
// Goal / monthly-plan / inbox placeholder types.
//
// Sub-AC 1 of AC 5 owns only `agent.schema.ts`. The nested array types
// (`goals`, `monthlyPlans`, `inbox`) on `Agent` are referenced from the
// schema via AJV `$ref` directives, so the TypeScript shape only has to
// be permissive enough for the surrounding `Agent` interface to compile.
// The canonical interfaces for these entities will be wired in by later
// sub-ACs (5.2 / 5.3 / 5.4) that own the dedicated `goal.ts`,
// `monthly-plan.ts`, and `inbox.ts` modules.
//
// The placeholders are deliberately `Record<string, unknown>` (not `any`)
// so consumers must narrow before reading nested fields — and the
// `Record` shape lets the array-items `JSONSchemaType<...>` validator
// accept the existing `{$ref: '...'}` schema fragment without forcing
// the schema literal to inline a duplicate sub-schema body.
// ---------------------------------------------------------------------------

/** Placeholder shape for a single agent goal — refined in `goal.ts` later. */
export type GoalPlaceholder = Record<string, unknown>;

/** Placeholder shape for a single monthly plan — refined in `monthly-plan.ts` later. */
export type MonthlyPlanPlaceholder = Record<string, unknown>;

/** Placeholder shape for a single inbox message — refined in `inbox.ts` later. */
export type InboxMessagePlaceholder = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Budget — per-agent weekly token budget tracking.
// Mirrors `budgetSchema` in src/schemas/agent.schema.ts.
// ---------------------------------------------------------------------------

/** A single billable session within the budget's session log. */
export interface BudgetSession {
  /** ISO-8601 date-time when the session ran. */
  timestamp: string;
  tokensUsed: number;
  /** Optional originating task ID (e.g. `task-abc12345`). */
  taskId?: string;
}

/**
 * Why an agent was paused.
 *
 * Explicitly nullable: a freshly hired (never-paused) agent JSON carries
 * `pausedReason: null` so downstream readers can distinguish "never
 * paused" from "field missing because the schema predates the column".
 */
export type BudgetPauseReason =
  | 'budget_exhausted'
  | 'subagent_missing'
  | 'manual'
  | null;

/** Per-agent weekly budget tracking. */
export interface Budget {
  weeklyTokenLimit: number;
  currentUsage: number;
  /** ISO-8601 date-time for the Monday 00:00 of the current budget week. */
  periodStart: string;
  paused?: boolean;
  pausedReason?: BudgetPauseReason;
  sessions?: BudgetSession[];
}

// ---------------------------------------------------------------------------
// Agent — the canonical top-level document stored per agent.
// Mirrors `agentConfigSchema` in src/schemas/agent.schema.ts.
// ---------------------------------------------------------------------------

/**
 * Canonical agent configuration document.
 *
 * Stored on disk at `.aweek/agents/<slug>.json`. The aweek `id` always
 * equals the Claude Code subagent slug (`subagentRef`); the two fields
 * are intentionally redundant for backward compatibility with code that
 * predates the 1-to-1 subagent wrapper contract.
 *
 * `goals` and `monthlyPlans` are optional because the canonical store
 * for long-term goals and monthly plans has migrated to the per-agent
 * free-form markdown at `.aweek/agents/<slug>/plan.md` (see
 * `src/storage/plan-markdown-store.js`). The fields remain on the
 * shape so legacy agents still validate; new hires default to empty
 * arrays via `createAgentConfig`.
 */
export interface Agent {
  /** Subagent slug; equals `subagentRef`. */
  id: string;
  /** Subagent slug — single source of truth for identity at `.claude/agents/<slug>.md`. */
  subagentRef: string;
  goals?: GoalPlaceholder[];
  monthlyPlans?: MonthlyPlanPlaceholder[];
  /** Per-agent weekly token budget; synced to `budget.weeklyTokenLimit` on creation. */
  weeklyTokenBudget?: number;
  budget: Budget;
  inbox?: InboxMessagePlaceholder[];
  /** ISO-8601 date-time. */
  createdAt: string;
  /** ISO-8601 date-time. */
  updatedAt?: string;
}
