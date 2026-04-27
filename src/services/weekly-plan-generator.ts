/**
 * Weekly plan generation service.
 * Takes an agent's goals and monthly plan as input and produces a structured
 * weekly plan with tasks that trace back to monthly objectives.
 *
 * Plan traceability chain: goal -> monthly objective -> weekly task.
 *
 * Generation rules:
 *  - Only "planned" or "in-progress" objectives produce tasks.
 *  - Each eligible objective gets at least one task.
 *  - Task priority inherits from objective status: in-progress -> high, planned -> medium.
 *  - Idempotent: calling with the same inputs and week produces the same structure
 *    (new IDs each call, but deterministic task count & mapping).
 *  - Validates output against the weekly-plan schema before returning.
 *
 * Day-layout detection:
 *  - When `options.planMarkdown` is supplied, `detectDayLayout` reads the
 *    agent's plan.md body and classifies the planning style into one of three
 *    modes: 'theme-days', 'priority-waterfall', or 'mixed'.
 *  - The detected mode is returned as `meta.layoutMode` and determines the
 *    `meta.spreadStrategy` hint passed to `distributeTasks` callers:
 *      theme-days        → 'spread'  (round-robin across weekdays)
 *      priority-waterfall → 'pack'   (fill days sequentially, high → low)
 *      mixed             → 'pack'   (default)
 *  - For 'priority-waterfall', tasks are also pre-sorted by priority
 *    (critical → high → medium → low) before the plan is assembled so that
 *    `distributeTasks` places the most important work earliest in the week.
 */
import {
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import { assertValid } from '../schemas/validator.js';
import { detectDayLayout } from './day-layout-detector.js';
import { composeAdvisorBrief } from './advisor-brief-composer.js';
import { parsePlanMarkdownSections } from '../storage/plan-markdown-store.js';
import { emitPlanReadyNotification } from './plan-ready-notifier.js';
import type { NotificationStore } from '../storage/notification-store.js';
import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';
import {
  mondayOfWeek,
  localParts,
  localWallClockToUtc,
  isValidTimeZone,
} from '../time/zone.js';

interface Goal {
  id: string;
  description?: string;
  status?: string;
  [key: string]: unknown;
}

interface Objective {
  id: string;
  description?: string;
  goalId?: string;
  status?: string;
  [key: string]: unknown;
}

interface MonthlyPlan {
  month?: string;
  objectives: Objective[];
  status?: string;
  [key: string]: unknown;
}

interface TaskDescriptor {
  title: string;
  prompt: string;
  priority?: string;
  estimatedMinutes?: number;
}

interface Task {
  id: string;
  title: string;
  prompt: string;
  objectiveId: string;
  status: string;
  priority: string;
  estimatedMinutes?: number;
  runAt?: string;
  track?: string;
  [key: string]: unknown;
}

interface WeeklyPlan {
  week: string;
  month: string;
  tasks: Task[];
  approved: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface SkippedReason {
  objectiveId: string;
  reason: string;
}

interface GenerateMeta {
  totalTasks: number;
  objectivesIncluded: number;
  objectivesSkipped: number;
  skippedReasons: SkippedReason[];
  reviewTasksAdded: number;
  layoutMode: 'theme-days' | 'priority-waterfall' | 'mixed';
  spreadStrategy: 'spread' | 'pack';
}

interface GenerateOptions {
  requireActiveGoal?: boolean;
  taskOverrides?: Record<string, TaskDescriptor[] | undefined>;
  planMarkdown?: string | null;
  tz?: string;
  priorDayOutcomes?: string | null;
  retrospectiveContext?: string | null;
}

interface GenerateParams {
  week: string;
  month: string;
  goals: Goal[];
  monthlyPlan: MonthlyPlan;
  options?: GenerateOptions;
}

interface WeeklyPlanStoreLike {
  save(agentId: string, plan: WeeklyPlan): Promise<unknown>;
}

interface CreateTaskOpts {
  priority?: string;
  estimatedMinutes?: number;
  track?: string;
  runAt?: string;
}

/**
 * Wrapper around createTask whose JSDoc-only types in agent.ts under-declare
 * the optional opts shape. Centralises the cast so call sites stay tidy.
 */
function callCreateTask(
  base: { title: string; prompt: string },
  objectiveId: string,
  opts: CreateTaskOpts,
): Task {
  return (createTask as unknown as (
    base: { title: string; prompt: string },
    objectiveId: string,
    opts: CreateTaskOpts,
  ) => Task)(base, objectiveId, opts);
}

const WEEKLY_PLAN_SCHEMA_ID = 'aweek://schemas/weekly-plan';

/**
 * Statuses that are eligible for weekly task generation.
 * Completed/dropped objectives are skipped.
 */
const ELIGIBLE_OBJECTIVE_STATUSES = new Set(['planned', 'in-progress']);

/**
 * Map objective status to default task priority.
 * In-progress objectives get higher priority since they're already started.
 */
const STATUS_TO_PRIORITY: Record<string, string> = {
  'in-progress': 'high',
  planned: 'medium',
};

/**
 * Numeric sort key per priority level. Lower = more urgent.
 * Used to pre-sort tasks when the detected layout is 'priority-waterfall'
 * so that `distributeTasks` places critical work earliest in the week.
 */
const PRIORITY_SORT_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Map from layout mode (returned by `detectDayLayout`) to the `spread`
 * hint understood by `distributeTasks` in weekly-calendar-grid.js.
 *
 *   'theme-days'        → 'spread'  one task per day, round-robin
 *   'priority-waterfall'→ 'pack'   fill each day before advancing
 *   'mixed'             → 'pack'   same as pack (safe default)
 */
const LAYOUT_TO_SPREAD: Record<string, 'spread' | 'pack'> = {
  'theme-days': 'spread',
  'priority-waterfall': 'pack',
  mixed: 'pack',
};

// ---------------------------------------------------------------------------
// Advisor-mode review task injection
// ---------------------------------------------------------------------------

/**
 * Local-wall-clock hour at which daily review tasks fire (Mon–Fri).
 * Agents see these as end-of-day reflection slots in their calendar.
 */
const DAILY_REVIEW_HOUR = 17;

/**
 * Local-wall-clock hour at which the weekly review fires on Friday.
 * Placed one hour after the daily review so the day-close slot completes
 * before the week-close slot kicks off the next-week planner.
 */
const WEEKLY_REVIEW_HOUR = 18;

/**
 * Day-specific descriptions for daily review tasks (index 0 = Monday … 4 = Friday).
 * Written in an advisor / new-hire brief voice: contextual, paced, not flat imperatives.
 */
const DAILY_REVIEW_PROMPTS = [
  // Monday
  "Week orientation: open your weekly plan, confirm today's top two priorities, and flag any dependencies you need to unblock before the week gains momentum.",
  // Tuesday
  "Day-two check-in: note what moved forward yesterday, update task statuses, and surface anything that is drifting off-plan before it becomes a blocker.",
  // Wednesday
  "Mid-week pulse: you are halfway through — assess overall pacing, re-sequence tasks if needed, and lock in a clear plan for the remaining two days.",
  // Thursday
  "Pre-close prep: drive open items toward done, escalate any unresolved blockers, and identify what must be finished before Friday's end-of-week review.",
  // Friday
  "End-of-day Friday: record today's outcomes, note what carries forward into next week, and update plan.md so the weekly review has accurate data to work from.",
];

/**
 * Short calendar labels for each weekday's daily-review slot — mirrors
 * DAILY_REVIEW_PROMPTS index-for-index. The grid and activity log show
 * these; the full `prompt` text above is what gets fed to Claude.
 */
const DAILY_REVIEW_TITLES = [
  'Mon review: week orientation',
  'Tue review: day-two check-in',
  'Wed review: mid-week pulse',
  'Thu review: pre-close prep',
  'Fri review: end-of-day wrap-up',
];

/**
 * Prompt text for the single weekly review task placed on Friday afternoon.
 * The weekly review chains automatically into the next-week planner when the
 * agent runs autonomously.
 */
const WEEKLY_REVIEW_PROMPT =
  'Weekly review: assess outcomes against this week\'s plan, capture wins / misses / learnings, ' +
  'and hand off to the next-week planner which will auto-draft next week\'s schedule for approval.';

/** Short calendar label for the weekly review slot. */
const WEEKLY_REVIEW_TITLE = 'Weekly review';

/**
 * Build the six advisor-mode review tasks for a given ISO week.
 *
 * Produces five daily-review tasks (Mon–Fri at DAILY_REVIEW_HOUR local time)
 * and one weekly-review task (Friday at WEEKLY_REVIEW_HOUR local time).
 * Each task carries an explicit `track` matching its objectiveId so the
 * task-selector treats them as independent pacing lanes alongside work tasks.
 *
 * DST handling is delegated to `localWallClockToUtc`: spring-forward gaps
 * resolve to the first valid instant after the gap; fall-back ambiguity
 * resolves to the first (earlier) occurrence.
 *
 * @param {string} week - ISO week string (YYYY-Www)
 * @param {string} [tz='UTC'] - IANA time zone name (e.g. 'America/Los_Angeles').
 *   Falls back to 'UTC' when the value is absent or not a valid IANA name.
 * @returns {object[]} Array of 6 task objects (5 daily-review + 1 weekly-review)
 */
export function buildReviewTasks(week: string, tz: string = 'UTC'): Task[] {
  const resolvedTz = (typeof tz === 'string' && isValidTimeZone(tz)) ? tz : 'UTC';

  // Monday 00:00 local time expressed as a UTC Date.
  const mondayUtc = mondayOfWeek(week, resolvedTz);
  // Local Y/M/D components for Monday (used to build each day's wall clock).
  const { year, month, day: mondayDay } = localParts(mondayUtc, resolvedTz);

  const tasks: Task[] = [];

  // Five daily review tasks: Monday (offset 0) through Friday (offset 4).
  // localWallClockToUtc handles month/year roll-over when mondayDay + i
  // overflows the current month because Date.UTC normalises the components.
  for (let i = 0; i < 5; i++) {
    const runAt = localWallClockToUtc(
      { year, month, day: mondayDay + i, hour: DAILY_REVIEW_HOUR, minute: 0, second: 0 },
      resolvedTz,
    ).toISOString();

    tasks.push(
      callCreateTask(
        { title: DAILY_REVIEW_TITLES[i], prompt: DAILY_REVIEW_PROMPTS[i] },
        DAILY_REVIEW_OBJECTIVE_ID,
        {
          priority: 'medium',
          estimatedMinutes: 30,
          runAt,
          track: DAILY_REVIEW_OBJECTIVE_ID,
        },
      ),
    );
  }

  // One weekly review task on Friday (offset 4), one hour after the daily review.
  const weeklyRunAt = localWallClockToUtc(
    { year, month, day: mondayDay + 4, hour: WEEKLY_REVIEW_HOUR, minute: 0, second: 0 },
    resolvedTz,
  ).toISOString();

  tasks.push(
    callCreateTask(
      { title: WEEKLY_REVIEW_TITLE, prompt: WEEKLY_REVIEW_PROMPT },
      WEEKLY_REVIEW_OBJECTIVE_ID,
      {
        priority: 'high',
        estimatedMinutes: 60,
        runAt: weeklyRunAt,
        track: WEEKLY_REVIEW_OBJECTIVE_ID,
      },
    ),
  );

  return tasks;
}

/**
 * Filter objectives to only those eligible for task generation.
 * Eligible = status is "planned" or "in-progress".
 *
 * @param {object[]} objectives - Monthly plan objectives
 * @returns {object[]} Filtered objectives
 */
export function filterEligibleObjectives(objectives: Objective[]): Objective[] {
  return objectives.filter((o) => ELIGIBLE_OBJECTIVE_STATUSES.has(o.status ?? ''));
}

/**
 * Filter goals to only active ones.
 * @param {object[]} goals - Agent goals
 * @returns {object[]} Active goals
 */
export function filterActiveGoals(goals: Goal[]): Goal[] {
  return goals.filter((g) => g.status === 'active');
}

/**
 * Build a lookup set of active goal IDs for fast membership check.
 * @param {object[]} goals - Agent goals
 * @returns {Set<string>} Set of active goal IDs
 */
function buildActiveGoalIdSet(goals: Goal[]): Set<string> {
  return new Set(filterActiveGoals(goals).map((g) => g.id));
}

/**
 * Determine the default priority for a task based on its parent objective.
 * @param {object} objective - Monthly objective
 * @returns {'critical' | 'high' | 'medium' | 'low'}
 */
export function defaultPriorityForObjective(objective: Objective): string {
  return STATUS_TO_PRIORITY[objective.status ?? ''] || 'medium';
}

interface GenerateTasksOpts {
  taskDescriptors?: TaskDescriptor[];
}

/**
 * Generate tasks for a single objective.
 * By default, produces one task per objective. Callers can supply
 * custom task descriptors to override.
 *
 * @param {object} objective - Monthly objective
 * @param {object} [opts]
 * @param {Array<{ title: string, prompt: string, priority?: string, estimatedMinutes?: number }>} [opts.taskDescriptors]
 *   Custom task descriptors. When omitted, one task is generated from the
 *   objective description (used both as `title` — truncated to 80 chars —
 *   and as `prompt`).
 * @returns {object[]} Array of task objects conforming to weekly-task schema
 */
export function generateTasksForObjective(
  objective: Objective,
  { taskDescriptors }: GenerateTasksOpts = {},
): Task[] {
  if (taskDescriptors && taskDescriptors.length > 0) {
    return taskDescriptors.map((desc) =>
      callCreateTask(
        { title: desc.title, prompt: desc.prompt },
        objective.id,
        {
          priority: desc.priority || defaultPriorityForObjective(objective),
          estimatedMinutes: desc.estimatedMinutes,
        },
      ),
    );
  }

  // Default: one task using the objective description as both the short
  // calendar label (truncated to fit the 80-char schema cap) and the
  // prompt fed to Claude.
  const base = objective.description ?? '';
  const title = base.length > 80 ? `${base.slice(0, 77)}...` : base;
  return [
    callCreateTask(
      { title, prompt: base },
      objective.id,
      { priority: defaultPriorityForObjective(objective) },
    ),
  ];
}

/**
 * Generate a weekly plan from an agent's goals and monthly plan.
 *
 * This is the core generation function. It:
 *  1. Filters objectives to eligible ones (planned/in-progress)
 *  2. Optionally filters to objectives whose parent goal is active
 *  3. Generates tasks traced back to each objective
 *  4. Assembles a valid weekly plan
 *  5. Validates the output against the schema
 *
 * @param {object} params
 * @param {string} params.week - ISO week string (YYYY-Www)
 * @param {string} params.month - Month string (YYYY-MM)
 * @param {object[]} params.goals - Agent's goals array
 * @param {object} params.monthlyPlan - Monthly plan with objectives
 * @param {object} [params.options]
 * @param {boolean} [params.options.requireActiveGoal=true] - Only include objectives whose parent goal is active
 * @param {Object<string, Array<{ description: string, priority?: string, estimatedMinutes?: number }>>} [params.options.taskOverrides]
 *   Map of objectiveId -> custom task descriptors. Overrides default task generation for specific objectives.
 * @param {string|null} [params.options.planMarkdown=null]
 *   Raw content of the agent's plan.md file. When supplied, two things happen:
 *   1. `detectDayLayout` classifies the planning style (surfaced in `meta.layoutMode`
 *      and `meta.spreadStrategy` for callers that subsequently call `distributeTasks`).
 *   2. Each non-review work task without a user override gets an advisor-voiced
 *      3–6 sentence brief (via `composeAdvisorBrief`) instead of the flat
 *      objective description. The brief references the plan.md strategy/notes
 *      and optionally the prior-day outcomes.
 * @param {string|null} [params.options.priorDayOutcomes=null]
 *   One-sentence summary of what the agent accomplished in the prior working
 *   session (e.g. from the previous daily-review file). When supplied alongside
 *   `planMarkdown`, each advisor brief appends a continuity sentence that
 *   bridges from yesterday's work into today's task.
 * @param {string|null} [params.options.retrospectiveContext=null]
 *   Compact summary extracted from last week's retrospective file (produced by
 *   `extractRetrospectiveSummary` in `next-week-context-assembler.js`). When
 *   supplied alongside `planMarkdown`, each advisor brief appends a weekly
 *   retrospective bridge sentence using week-scoped language ("last week's
 *   review noted…"). Only set this on the autonomous next-week planner path via
 *   `assembleNextWeekPlannerContext`; leave null for standard user-invoked or
 *   daily plan generation so briefs stay focused on the current session.
 * @param {string} [params.options.tz='UTC']
 *   IANA time zone name used to compute `runAt` for injected review tasks.
 *   Falls back to 'UTC' when absent or not a valid IANA name.
 * @returns {{
 *   plan: object,
 *   meta: {
 *     totalTasks: number,
 *     objectivesIncluded: number,
 *     objectivesSkipped: number,
 *     skippedReasons: object[],
 *     reviewTasksAdded: number,
 *     layoutMode: 'theme-days' | 'priority-waterfall' | 'mixed',
 *     spreadStrategy: 'spread' | 'pack',
 *   }
 * }}
 * @throws {Error} If week or month format is invalid, or if output fails schema validation
 */
export function generateWeeklyPlan({
  week,
  month,
  goals,
  monthlyPlan,
  options = {},
}: GenerateParams): { plan: WeeklyPlan; meta: GenerateMeta } {
  // --- Input validation ---
  if (!week || !/^\d{4}-W\d{2}$/.test(week)) {
    throw new Error(`Invalid week format: "${week}". Expected YYYY-Www (e.g., 2026-W16).`);
  }
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Invalid month format: "${month}". Expected YYYY-MM (e.g., 2026-04).`);
  }
  if (!monthlyPlan || !Array.isArray(monthlyPlan.objectives)) {
    throw new Error('monthlyPlan must have an objectives array.');
  }
  if (!Array.isArray(goals)) {
    throw new Error('goals must be an array.');
  }

  const {
    requireActiveGoal = true,
    taskOverrides = {},
    planMarkdown = null,
    tz = 'UTC',
    priorDayOutcomes = null,
    retrospectiveContext = null,
  } = options;

  // --- Filter objectives ---
  const activeGoalIds = buildActiveGoalIdSet(goals);
  const skippedReasons: SkippedReason[] = [];
  const eligibleObjectives: Objective[] = [];

  for (const obj of monthlyPlan.objectives) {
    // Check objective status
    if (!ELIGIBLE_OBJECTIVE_STATUSES.has(obj.status ?? '')) {
      skippedReasons.push({
        objectiveId: obj.id,
        reason: `status "${obj.status}" is not eligible (must be planned or in-progress)`,
      });
      continue;
    }

    // Check parent goal is active (if required)
    if (requireActiveGoal && !activeGoalIds.has(obj.goalId ?? '')) {
      skippedReasons.push({
        objectiveId: obj.id,
        reason: `parent goal "${obj.goalId}" is not active`,
      });
      continue;
    }

    eligibleObjectives.push(obj);
  }

  // --- Advisor brief context (populated only when planMarkdown is supplied) ---
  // Build a goals lookup map so composeAdvisorBrief can reference the parent
  // goal description for each objective without iterating the goals array on
  // every iteration.
  const goalsById = new Map(goals.map((g) => [g.id, g]));

  // Parse plan.md into sections for brief composition context.
  // When planMarkdown is absent this stays null and advisor brief composition
  // is skipped — objectives fall back to their raw description (existing behaviour).
  const parsedPlanSections = planMarkdown ? parsePlanMarkdownSections(planMarkdown) : null;

  // --- Generate tasks ---
  const allTasks: Task[] = [];
  for (const obj of eligibleObjectives) {
    const overrides = taskOverrides[obj.id];
    const hasUserOverrides = Array.isArray(overrides) && overrides.length > 0;

    // When planMarkdown is available and the user has not supplied custom task
    // descriptors for this objective, compose an advisor-voiced 3–6 sentence
    // brief that references the plan.md context and (when supplied) prior-day
    // outcomes. This replaces the flat objective.description that would
    // otherwise become the task prompt string.
    //
    // The short objective description is reused as the `title` so the
    // calendar grid stays scannable while the brief (which is too long for
    // a cell label) populates the `prompt` sent to Claude.
    //
    // taskOverrides take precedence: they represent explicit user intent and
    // must never be silently replaced by the generated brief.
    let effectiveDescriptors: TaskDescriptor[] | undefined;
    if (!hasUserOverrides && parsedPlanSections) {
      const goalDescription = goalsById.get(obj.goalId ?? '')?.description ?? null;
      const brief = composeAdvisorBrief(obj, {
        planContext: parsedPlanSections,
        priorDayOutcomes,
        goalDescription,
        retrospectiveContext,
      });
      const baseTitle = obj.description ?? '';
      const title =
        baseTitle.length > 80 ? `${baseTitle.slice(0, 77)}...` : baseTitle;
      effectiveDescriptors = [{
        title,
        prompt: brief,
        priority: defaultPriorityForObjective(obj),
      }];
    } else {
      // No plan.md context, or user supplied explicit overrides — use them as-is.
      // When overrides is undefined, generateTasksForObjective falls back to the
      // objective description (one task per objective, existing behaviour).
      effectiveDescriptors = overrides;
    }

    const tasks = generateTasksForObjective(obj, {
      taskDescriptors: effectiveDescriptors,
    });
    allTasks.push(...tasks);
  }

  // --- Detect day-layout mode from plan.md content ---
  // detectDayLayout gracefully handles null / undefined / non-string inputs
  // by returning 'mixed', so passing planMarkdown directly is safe.
  const layoutMode = detectDayLayout(planMarkdown) as 'theme-days' | 'priority-waterfall' | 'mixed';
  const spreadStrategy = LAYOUT_TO_SPREAD[layoutMode] ?? 'pack';

  // For priority-waterfall mode, pre-sort tasks by priority so that
  // distributeTasks (called later by calendar/plan callers) places the most
  // critical work earliest in the week when using 'pack' distribution.
  if (layoutMode === 'priority-waterfall') {
    allTasks.sort(
      (a, b) =>
        (PRIORITY_SORT_ORDER[a.priority] ?? 99) -
        (PRIORITY_SORT_ORDER[b.priority] ?? 99),
    );
  }

  // --- Inject advisor-mode review tasks ---
  // Review tasks are always appended after work tasks so the sorted work
  // order above is preserved and the calendar renderer can distinguish them
  // via isReviewObjectiveId().
  const reviewTasks = buildReviewTasks(week, tz);
  allTasks.push(...reviewTasks);

  // --- Build weekly plan ---
  const plan = createWeeklyPlan(week, month, allTasks) as WeeklyPlan;

  // --- Validate output ---
  assertValid(WEEKLY_PLAN_SCHEMA_ID, plan);

  return {
    plan,
    meta: {
      totalTasks: allTasks.length,
      objectivesIncluded: eligibleObjectives.length,
      objectivesSkipped: skippedReasons.length,
      skippedReasons,
      reviewTasksAdded: reviewTasks.length,
      layoutMode,
      spreadStrategy,
    },
  };
}

/**
 * Generate a weekly plan and save it via a WeeklyPlanStore.
 * Convenience wrapper that generates + persists in one call.
 *
 * When a `notificationStore` is supplied AND the saved plan is in the
 * pending-approval state (`approved: false`, the default for freshly
 * generated plans), this also auto-emits a `plan-ready` system notification
 * so the user sees the new plan in the dashboard inbox without having to
 * poll. The sender slug is the agent whose plan needs approval — see
 * {@link emitPlanReadyNotification} for the dedup contract. Emission is
 * best-effort and never fails plan persistence.
 *
 * The `notificationStore` parameter is optional so existing callers (and
 * unit tests that don't care about notifications) keep working unchanged.
 *
 * @param {object} params - Same as generateWeeklyPlan params
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} store
 * @param {string} agentId
 * @param {object} [opts]
 * @param {import('../storage/notification-store.js').NotificationStore} [opts.notificationStore]
 *   Optional notification store. When supplied, a `plan-ready` system
 *   notification is auto-emitted for pending plans.
 * @returns {Promise<{ plan: object, meta: object }>}
 */
export interface GenerateAndSaveOptions {
  notificationStore?: NotificationStore;
}

export async function generateAndSaveWeeklyPlan(
  params: GenerateParams,
  store: WeeklyPlanStoreLike,
  agentId: string,
  opts: GenerateAndSaveOptions = {},
): Promise<{ plan: WeeklyPlan; meta: GenerateMeta }> {
  const result = generateWeeklyPlan(params);
  await store.save(agentId, result.plan);

  // Auto-emit the plan-ready system notification when:
  //   - a notification store was provided (no-op for legacy callers); and
  //   - the plan is in the pending-approval state (auto-approved chains
  //     handle their own no-op via `plan.approved === true` inside the
  //     emitter).
  // Emission is best-effort and the emitter swallows its own failures, so
  // we don't need a try/catch here — but we also intentionally don't await
  // anything that could throw at the boundary of plan persistence.
  if (opts.notificationStore) {
    await emitPlanReadyNotification(opts.notificationStore, agentId, result.plan);
  }

  return result;
}
