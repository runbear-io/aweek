/**
 * Agent model — factory functions for creating valid agent data structures.
 * These produce objects that conform to the JSON schemas.
 *
 * The factory output types (`Goal`, `Objective`, `MonthlyPlan`, `Task`,
 * `WeeklyPlan`, `InboxMessage`) are exported here so callers can rely on
 * concrete shapes when reading nested arrays off `Agent` (whose
 * `goals?` / `monthlyPlans?` / `inbox?` fields are typed against the
 * permissive `Record<string, unknown>` placeholders documented in
 * `src/schemas/agent.ts`). Each shape includes a string index signature
 * (`[key: string]: unknown`) so the rich interfaces remain structurally
 * assignable to those placeholders without `as` widenings — keeping the
 * model file free of any new type assertions on the happy path.
 *
 * The mutation helpers (`addGoal`, `updateGoalStatus`, `addMonthlyPlan`,
 * etc.) accept a deliberately permissive structural input shape
 * (`MutableAgentConfig`) so they can be invoked from collaborator
 * modules that maintain their own narrower per-file shapes for an agent
 * config (e.g. `AgentConfigShape` in `src/services/plan-adjustments.ts`
 * predates this seed and is incrementally being aligned with the
 * canonical `Agent` interface). The runtime contract is unchanged from
 * the original `agent.js`: every helper just mutates `config.goals`,
 * `config.monthlyPlans`, and/or `config.updatedAt`.
 */
import { randomBytes } from 'node:crypto';
import { SUBAGENT_SLUG_PATTERN } from '../schemas/agent.schema.js';
import type { Agent } from '../schemas/agent.js';
import { currentWeekKey, mondayOfWeek } from '../time/zone.js';

/** Generate a short random ID suffix (used by goals/objectives/tasks/messages — NOT agents). */
const shortId = (): string => randomBytes(4).toString('hex');

/** Compiled slug regex used at construction time to fail loudly on invalid input. */
const SLUG_REGEX = new RegExp(SUBAGENT_SLUG_PATTERN);

// ---------------------------------------------------------------------------
// Domain enums — single source of truth for status / horizon literals.
// ---------------------------------------------------------------------------

/** Time horizon classifications for a long-term goal. */
export type GoalHorizon = '1mo' | '3mo' | '1yr';

/** Lifecycle status of a long-term goal. */
export type GoalStatus = 'active' | 'completed' | 'paused' | 'dropped';

/** Lifecycle status of a monthly plan. */
export type MonthlyPlanStatus = 'draft' | 'active' | 'completed' | 'archived';

/** Lifecycle status of a single objective within a monthly plan. */
export type ObjectiveStatus = 'planned' | 'in-progress' | 'completed' | 'dropped';

/** Lifecycle status of a weekly task. */
export type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

/** Priority bucket for a weekly task. */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/** Lifecycle status of an inbox message. */
export type InboxMessageStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'completed'
  | 'in-progress';

/** Priority bucket for an inbox message. */
export type InboxMessagePriority = 'critical' | 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Domain shapes returned by the factories below.
//
// Every shape carries `[key: string]: unknown` so a concrete instance is
// structurally assignable to the `Record<string, unknown>` placeholders
// declared in `src/schemas/agent.ts` for nested arrays on `Agent`. This
// lets `addGoal(config, createGoal(...))` push directly into
// `config.goals` without `as` casts while still preserving the rich
// named-property typing for every read site.
// ---------------------------------------------------------------------------

/** Long-term goal entry. */
export interface Goal {
  id: string;
  description: string;
  horizon: GoalHorizon;
  status: GoalStatus;
  createdAt: string;
  completedAt?: string;
  targetDate?: string;
  [key: string]: unknown;
}

/** Monthly plan objective — traces back to a parent goal via `goalId`. */
export interface Objective {
  id: string;
  description: string;
  goalId: string;
  status: ObjectiveStatus;
  completedAt?: string;
  [key: string]: unknown;
}

/** Monthly plan covering a single calendar month (`YYYY-MM`). */
export interface MonthlyPlan {
  month: string;
  objectives: Objective[];
  status: MonthlyPlanStatus;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** Weekly task — the unit the heartbeat picks up and feeds to Claude Code. */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** Free-form tag linking the task back to a `plan.md` H3 heading or a reserved review value. */
  objectiveId?: string;
  estimatedMinutes?: number;
  track?: string;
  /** ISO 8601 — earliest time the task is eligible for execution. */
  runAt?: string;
  [key: string]: unknown;
}

/** Weekly plan keyed by ISO week (`YYYY-Www`). */
export interface WeeklyPlan {
  week: string;
  month: string;
  tasks: Task[];
  approved: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** Inbox message used for inter-agent task delegation. */
export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  taskDescription: string;
  priority: InboxMessagePriority | string;
  createdAt: string;
  status: InboxMessageStatus;
  context?: string;
  sourceTaskId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Permissive structural shape accepted by every mutation/read helper that
// touches `goals`, `monthlyPlans`, or `updatedAt`. Both the canonical
// `Agent` interface (whose `goals?` / `monthlyPlans?` array element types
// are `Record<string, unknown>`) and the loose per-file `AgentConfigShape`
// in `src/services/plan-adjustments.ts` (whose array element types are
// `AgentGoal` / `AgentMonthlyPlan` without an index signature) are
// assignable to this — every concrete array type is a subtype of
// `unknown[]`. Internally each helper narrows back to `Goal[]` or
// `MonthlyPlan[]` via single-step `as` casts (no new `as any`), which is
// safe because the runtime contract has always been "the array carries
// objects shaped like Goal / MonthlyPlan".
// ---------------------------------------------------------------------------

/** Minimal mutable shape every goal/monthly-plan helper needs. */
export interface MutableAgentConfig {
  goals?: unknown[];
  monthlyPlans?: unknown[];
  updatedAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Factory option shapes
// ---------------------------------------------------------------------------

/** Input shape for {@link createAgentConfig}. */
export interface CreateAgentConfigOptions {
  /** Subagent slug (e.g. "marketer"). Must match SUBAGENT_SLUG_PATTERN. */
  subagentRef: string;
  /** Per-agent weekly token budget. Defaults to 500_000. */
  weeklyTokenLimit?: number;
}

/** Required text fields for a weekly task. */
export interface CreateTaskFields {
  /** Short single-line calendar label (≤ 80 chars). */
  title: string;
  /** Full instruction text fed to Claude. */
  prompt: string;
}

/** Optional fields for {@link createTask}. */
export interface CreateTaskOptions {
  priority?: TaskPriority;
  estimatedMinutes?: number;
  track?: string;
  runAt?: string;
}

/** Optional fields for {@link createMonthlyPlan}. */
export interface CreateMonthlyPlanOptions {
  status?: MonthlyPlanStatus;
  summary?: string;
}

/** Optional fields for {@link createInboxMessage}. */
export interface CreateInboxMessageOptions {
  type?: string;
  priority?: InboxMessagePriority | string;
  context?: string;
  sourceTaskId?: string;
}

// ---------------------------------------------------------------------------
// Agent + sub-entity factories
// ---------------------------------------------------------------------------

/**
 * Create a new agent config with sensible defaults.
 *
 * The aweek agent id is the Claude Code subagent slug — i.e. the basename of
 * `.claude/agents/SLUG.md`. No UUID/random suffix is appended: aweek and the
 * subagent share a 1-to-1 filesystem mapping, so the slug is the id.
 */
export function createAgentConfig(
  opts: Partial<CreateAgentConfigOptions> = {},
): Agent {
  const { subagentRef, weeklyTokenLimit = 500_000 } = opts;
  if (typeof subagentRef !== 'string' || !SLUG_REGEX.test(subagentRef)) {
    throw new Error(
      `createAgentConfig: subagentRef must be a valid slug matching ${SUBAGENT_SLUG_PATTERN}, got: ${JSON.stringify(subagentRef)}`,
    );
  }
  const now = new Date().toISOString();

  return {
    id: subagentRef,
    subagentRef,
    goals: [],
    monthlyPlans: [],
    weeklyTokenBudget: weeklyTokenLimit,
    budget: {
      weeklyTokenLimit,
      currentUsage: 0,
      periodStart: getMondayISO(),
      paused: false,
      sessions: [],
    },
    inbox: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create a goal object with time horizon.
 */
export function createGoal(description: string, horizon: GoalHorizon = '3mo'): Goal {
  return {
    id: `goal-${shortId()}`,
    description,
    horizon,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a monthly plan objective.
 */
export function createObjective(description: string, goalId: string): Objective {
  return {
    id: `obj-${shortId()}`,
    description,
    goalId,
    status: 'planned',
  };
}

/**
 * Create a monthly plan.
 */
export function createMonthlyPlan(
  month: string,
  objectives: Objective[],
  { status = 'active', summary }: CreateMonthlyPlanOptions = {},
): MonthlyPlan {
  const now = new Date().toISOString();
  const plan: MonthlyPlan = {
    month,
    objectives,
    status,
    createdAt: now,
    updatedAt: now,
  };
  if (summary) plan.summary = summary;
  return plan;
}

/**
 * Create a weekly task.
 *
 * Weekly tasks carry TWO text fields: a short `title` shown in calendar
 * cells / activity rows / dashboards, and a long-form `prompt` that the
 * heartbeat passes to Claude Code as the per-task instruction. They are
 * intentionally decoupled so the UI surface stays compact while the model
 * gets all the context it needs.
 */
export function createTask(
  { title, prompt }: CreateTaskFields,
  objectiveId?: string,
  { priority = 'medium', estimatedMinutes, track, runAt }: CreateTaskOptions = {},
): Task {
  const task: Task = {
    id: `task-${shortId()}`,
    title,
    prompt,
    priority,
    status: 'pending',
  };
  // objectiveId is now optional: set it only when the caller actually
  // supplied a non-empty tag so the resulting JSON validates cleanly.
  if (typeof objectiveId === 'string' && objectiveId.length > 0) {
    task.objectiveId = objectiveId;
  }
  if (estimatedMinutes != null) task.estimatedMinutes = estimatedMinutes;
  if (track != null) task.track = track;
  if (runAt != null) task.runAt = runAt;
  return task;
}

/**
 * Create a weekly plan.
 *
 * Newly created plans land with `approved: true` so tasks are immediately
 * eligible for the heartbeat. The old behavior — start pending and require
 * `/aweek:plan` Branch C approval — was removed so tasks generated by the
 * weekly-plan generator, daily-review adjustments, and the autonomous
 * next-week planner all flow straight into execution.
 *
 * The `tasks` parameter is generic so collaborator modules that maintain
 * their own narrower task shape (e.g. `src/services/weekly-plan-generator.ts`
 * uses a local `Task` interface with `priority: string` rather than the
 * canonical `TaskPriority` enum) can pass their tasks through without
 * adapting at the call site. The runtime stores whatever array is
 * supplied — same as the original `agent.js`.
 */
export function createWeeklyPlan<T extends object = Task>(
  week: string,
  month: string,
  tasks: readonly T[],
): WeeklyPlan {
  const now = new Date().toISOString();
  return {
    week,
    month,
    // Single-step widening cast — the runtime always stored whatever the
    // caller passed, this just preserves that contract while letting
    // collaborator modules use their own narrower task shape.
    tasks: tasks as unknown as Task[],
    approved: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create an inbox message for inter-agent delegation.
 */
export function createInboxMessage(
  from: string,
  to: string,
  taskDescription: string,
  opts: CreateInboxMessageOptions = {},
): InboxMessage {
  const msg: InboxMessage = {
    id: `msg-${shortId()}`,
    from,
    to,
    type: opts.type || 'task-delegation',
    taskDescription,
    priority: opts.priority || 'medium',
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  if (opts.context) msg.context = opts.context;
  if (opts.sourceTaskId) msg.sourceTaskId = opts.sourceTaskId;
  return msg;
}

// ---------------------------------------------------------------------------
// Goal management helpers
// ---------------------------------------------------------------------------

/**
 * Add a goal to an agent config (mutates config).
 */
export function addGoal(config: MutableAgentConfig, goal: Goal): Goal {
  (config.goals ??= []).push(goal);
  config.updatedAt = new Date().toISOString();
  return goal;
}

/**
 * Update a goal's status within an agent config.
 * Returns the updated goal, or null if not found.
 */
export function updateGoalStatus(
  config: MutableAgentConfig,
  goalId: string,
  status: GoalStatus,
): Goal | null {
  const goals = (config.goals ?? []) as Goal[];
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return null;
  goal.status = status;
  if (status === 'completed') {
    goal.completedAt = new Date().toISOString();
  }
  config.updatedAt = new Date().toISOString();
  return goal;
}

/**
 * Remove a goal from an agent config by ID.
 * Returns true if removed, false if not found.
 */
export function removeGoal(config: MutableAgentConfig, goalId: string): boolean {
  const goals = (config.goals ?? []) as Goal[];
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx === -1) return false;
  goals.splice(idx, 1);
  config.updatedAt = new Date().toISOString();
  return true;
}

/**
 * Get goals filtered by time horizon.
 */
export function getGoalsByHorizon(config: MutableAgentConfig, horizon: GoalHorizon): Goal[] {
  const goals = (config.goals ?? []) as Goal[];
  return goals.filter((g) => g.horizon === horizon);
}

/**
 * Get all active goals from an agent config.
 */
export function getActiveGoals(config: MutableAgentConfig): Goal[] {
  const goals = (config.goals ?? []) as Goal[];
  return goals.filter((g) => g.status === 'active');
}

// ---------------------------------------------------------------------------
// Monthly plan management helpers
// ---------------------------------------------------------------------------

/**
 * Add a monthly plan to an agent config (mutates config).
 */
export function addMonthlyPlan(config: MutableAgentConfig, plan: MonthlyPlan): MonthlyPlan {
  (config.monthlyPlans ??= []).push(plan);
  config.updatedAt = new Date().toISOString();
  return plan;
}

/**
 * Get the monthly plan for a specific month.
 */
export function getMonthlyPlan(
  config: MutableAgentConfig,
  month: string,
): MonthlyPlan | undefined {
  const plans = (config.monthlyPlans ?? []) as MonthlyPlan[];
  return plans.find((p) => p.month === month);
}

/**
 * Get the currently active monthly plan (status === 'active').
 */
export function getActiveMonthlyPlan(config: MutableAgentConfig): MonthlyPlan | undefined {
  const plans = (config.monthlyPlans ?? []) as MonthlyPlan[];
  return plans.find((p) => p.status === 'active');
}

/**
 * Update a monthly plan's status.
 * Returns the updated plan, or null if not found.
 */
export function updateMonthlyPlanStatus(
  config: MutableAgentConfig,
  month: string,
  status: MonthlyPlanStatus,
): MonthlyPlan | null {
  const plans = (config.monthlyPlans ?? []) as MonthlyPlan[];
  const plan = plans.find((p) => p.month === month);
  if (!plan) return null;
  plan.status = status;
  plan.updatedAt = new Date().toISOString();
  config.updatedAt = new Date().toISOString();
  return plan;
}

/**
 * Update an objective's status within monthly plans.
 * Searches all monthly plans to find the objective by ID.
 * Returns the updated objective, or null if not found.
 */
export function updateObjectiveStatus(
  config: MutableAgentConfig,
  objectiveId: string,
  status: ObjectiveStatus,
): Objective | null {
  const plans = (config.monthlyPlans ?? []) as MonthlyPlan[];
  for (const plan of plans) {
    const obj = plan.objectives.find((o) => o.id === objectiveId);
    if (obj) {
      obj.status = status;
      if (status === 'completed') {
        obj.completedAt = new Date().toISOString();
      }
      plan.updatedAt = new Date().toISOString();
      config.updatedAt = new Date().toISOString();
      return obj;
    }
  }
  return null;
}

/**
 * Get all objectives that trace back to a specific goal.
 * Searches across all monthly plans for plan traceability.
 */
export function getObjectivesForGoal(
  config: MutableAgentConfig,
  goalId: string,
): Objective[] {
  const plans = (config.monthlyPlans ?? []) as MonthlyPlan[];
  const results: Objective[] = [];
  for (const plan of plans) {
    for (const obj of plan.objectives) {
      if (obj.goalId === goalId) {
        results.push(obj);
      }
    }
  }
  return results;
}

/**
 * Add an objective to an existing monthly plan (mutates plan).
 * Returns the added objective, or null if plan not found.
 */
export function addObjectiveToMonthlyPlan(
  config: MutableAgentConfig,
  month: string,
  objective: Objective,
): Objective | null {
  const plans = (config.monthlyPlans ?? []) as MonthlyPlan[];
  const plan = plans.find((p) => p.month === month);
  if (!plan) return null;
  plan.objectives.push(objective);
  plan.updatedAt = new Date().toISOString();
  config.updatedAt = new Date().toISOString();
  return objective;
}

/**
 * Get the ISO date-time string for Monday 00:00 of the current week.
 * When `tz` is omitted (or 'UTC') the Monday is computed in UTC —
 * existing behavior. When a valid IANA zone is supplied, the Monday is
 * computed in that zone (00:00 local) and returned as the equivalent
 * UTC ISO string.
 */
export function getMondayISO(tz?: string): string {
  if (typeof tz === 'string' && tz.length > 0 && tz !== 'UTC') {
    const weekKey = currentWeekKey(tz);
    return mondayOfWeek(weekKey, tz).toISOString();
  }
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}
