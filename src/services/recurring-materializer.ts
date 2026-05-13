/**
 * Recurring-task materializer — eagerly projects RecurringTask records into
 * the existing WeeklyPlanStore at heartbeat tick time.
 *
 * Pipeline (per agent × ISO week):
 *
 *   recurring-tasks.json  +  weekKey  +  tz
 *           │
 *           ▼
 *   expandForWindow(rule, mondayOfWeek, tz, ruleId)  // pure
 *           │
 *           ▼   apply exceptions (skip / override)
 *           ▼
 *   materializedTasks: WeeklyTask[]                  // pending, runAt set
 *           │
 *           ▼   merge into existing WeeklyPlan (or create fresh one)
 *           ▼
 *   WeeklyPlanStore.save(agentId, plan)              // only when content changed
 *
 * Why "lazily on the SPA, eagerly here": the SPA can re-derive occurrences
 * cheaply on render, but the heartbeat needs concrete WeeklyTask rows so the
 * existing task-selector / queue / locking layer can fire them through the
 * normal execution loop unchanged (the seed's "no parallel storage tree"
 * constraint).
 *
 * Design rules:
 *
 *  1. **Idempotence (AC5).** Running the materializer twice on the same
 *     (agentId, weekKey, recurring-tasks set, tz) must leave the
 *     weekly-plan file byte-identical on disk. The contract is enforced by:
 *
 *       - The expander is pure and deterministic (AC2).
 *       - The merge step adds NEW occurrence ids to the plan; it never
 *         touches an existing task with the same id (so the heartbeat may
 *         have already flipped `status` to `completed` / `failed` between
 *         runs and the next materializer pass leaves that state intact).
 *       - When the merge would not add any new tasks AND no existing plan
 *         needs to be created, the materializer skips the
 *         `WeeklyPlanStore.save()` call entirely — no `updatedAt` drift,
 *         no metadata churn, no fs write.
 *
 *     The colocated test suite asserts both halves: it compares the file
 *     bytes after two consecutive runs AND it asserts the file's `mtime`
 *     is unchanged (no silent re-write).
 *
 *  2. **Existing-task preservation.** Any task already present in the
 *     weekly plan — recurring or otherwise — passes through untouched.
 *     This is what protects the heartbeat's per-task state (status,
 *     completedAt, consecutiveFailures, …) across re-materialization.
 *
 *  3. **Exception application.**
 *       - `skip`     → drop the occurrence entirely.
 *       - `override` → merge `exception.override` over the template; if
 *                      `override.runAt` is present, use it as the task's
 *                      runAt (Google Calendar "move this occurrence" UX).
 *                      The occurrence id stays anchored to the ORIGINAL
 *                      runAt (so the exception keying matches across runs
 *                      even when the user moves the occurrence by minutes).
 *
 *  4. **No DST code.** The expander already routes wall-clock projection
 *     through `localWallClockToUtc`; this module never re-derives DST.
 *
 *  5. **No new persistence.** Only `WeeklyPlanStore` writes happen. The
 *     RecurringTaskStore is read-only here. Strictly additive to the
 *     existing storage tree (seed: "no parallel storage tree").
 *
 *  6. **Auto-approval of recurring-only plans (AC15).** A weekly plan that
 *     contains ONLY recurring-derived tasks (every task id starts with
 *     `task-rec-`, matching the AC6 occurrence-id contract) is approved
 *     automatically by this module. The intent is that an unattended week
 *     — no human in the loop, only the heartbeat's recurring-task
 *     materialization — still executes through the existing approval gate.
 *
 *     Trigger rules:
 *       - Creating a fresh plan whose materialized tasks are all
 *         recurring → set `approved: true` + `approvedAt: now`.
 *       - Merging into an existing UN-approved plan whose post-merge task
 *         list is all recurring → flip `approved: false` → `approved: true`
 *         + stamp `approvedAt: now`.
 *       - Existing plan already `approved: true` → leave the historical
 *         `approvedAt` intact (no re-stamp).
 *       - Mixed plan (≥1 hand-crafted task, id NOT starting with
 *         `task-rec-`) → leave `approved` exactly as it was.
 *
 *     The flip itself is a "write" (counts as a material change), so the
 *     idempotence fast-paths still need a way to recognise that no
 *     auto-approval transition is pending; otherwise a recurring-only,
 *     already-approved, no-new-occurrences run would tripwire a needless
 *     re-write. The implementation gates the flip on
 *     `!existing.approved && allRecurringDerived(merged)` so a second run
 *     finds nothing to flip and falls through to the existing
 *     `unchanged: true` early-return.
 */

import { mondayOfWeek, localParts } from '../time/zone.js';
import { expandForWindow } from './recurrence-expander.js';
import type { Occurrence } from './recurrence-expander.js';
import type {
  WeeklyPlan,
  WeeklyPlanStore,
  WeeklyTask,
} from '../storage/weekly-plan-store.js';
import type {
  RecurrenceException,
  RecurringTask,
  RecurringTaskStore,
  RecurringTaskTemplate,
} from '../storage/recurring-task-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Inputs accepted by {@link materializeRecurringForWeek}. */
export interface MaterializeOptions {
  /** Store responsible for reading and writing weekly plan JSON files. */
  weeklyPlanStore: WeeklyPlanStore;
  /** Store responsible for reading per-agent recurring-tasks.json. */
  recurringTaskStore: RecurringTaskStore;
  /** Agent slug — used to namespace both stores. */
  agentId: string;
  /** ISO week key (`YYYY-Www`). */
  weekKey: string;
  /** IANA zone for the expansion + month-key derivation. */
  tz: string;
  /**
   * Timestamp used as `createdAt` when the materializer has to author a
   * brand-new weekly-plan file (no existing one on disk). Defaults to
   * `new Date()`. Tests inject a fixed instant so the first-run write is
   * deterministic — important because AC5 compares the file bytes across
   * two runs, and an existing-plan path that re-uses the on-disk
   * `createdAt` would otherwise mask a regression.
   */
  now?: Date;
}

/** Outcome reported by {@link materializeRecurringForWeek}. */
export interface MaterializeResult {
  /** Echo of the week key, for log lines / multi-week loops. */
  weekKey: string;
  /**
   * `true` when the materializer made NO disk writes — i.e. every
   * materialized occurrence was already present in the plan (or there
   * was nothing to materialize and no plan to create). This is the AC5
   * signal: a `true` here on the second run guarantees byte-identity.
   */
  unchanged: boolean;
  /** Occurrence ids appended to the plan on this run. */
  addedTaskIds: string[];
  /**
   * `true` when this run flipped the plan's `approved` flag from `false`
   * (or absent) to `true` because every task in the merged plan was
   * recurring-derived (AC15). Useful for telemetry / log lines so a
   * caller can see "the heartbeat auto-approved 2026-W19 because it
   * contained only recurring tasks". Always `false` when `unchanged` is
   * `true`.
   */
  autoApproved: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an ISO date-time string so two strings representing the same
 * instant compare equal. `Date.parse` round-trip gives us a canonical form
 * (`.toISOString()` always emits `YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
function normalizeIso(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString();
}

/**
 * Build a WeeklyTask from a single Occurrence, applying the optional
 * override exception. Only fields with a defined value are set on the
 * output — leaving `undefined` keys off the object keeps the JSON-stringify
 * shape deterministic (AJV `additionalProperties: false` would otherwise
 * still pass, but absent vs explicit-undefined would differ on the wire).
 */
function buildWeeklyTask(
  occ: Occurrence,
  template: RecurringTaskTemplate,
  override: RecurrenceException['override'] | undefined,
): WeeklyTask {
  // Effective template = template fields with override fields shallow-merged on top.
  const effective: RecurringTaskTemplate = {
    title: override?.title ?? template.title,
    prompt: override?.prompt ?? template.prompt,
  };
  const objectiveId = override?.objectiveId ?? template.objectiveId;
  const priority = override?.priority ?? template.priority;
  const estimatedMinutes = override?.estimatedMinutes ?? template.estimatedMinutes;
  const track = override?.track ?? template.track;
  if (objectiveId !== undefined) effective.objectiveId = objectiveId;
  if (priority !== undefined) effective.priority = priority;
  if (estimatedMinutes !== undefined) effective.estimatedMinutes = estimatedMinutes;
  if (track !== undefined) effective.track = track;

  // override.runAt moves the occurrence to a new instant; absent → keep
  // the expander's runAt. The occurrence id stays anchored to the
  // original instant either way (deterministic dedupe across runs).
  const runAt = override?.runAt ?? occ.runAt;

  const task: WeeklyTask = {
    id: occ.id,
    title: effective.title,
    prompt: effective.prompt,
    status: 'pending',
    runAt,
  };
  if (effective.objectiveId !== undefined) task.objectiveId = effective.objectiveId;
  if (effective.priority !== undefined) task.priority = effective.priority;
  if (effective.estimatedMinutes !== undefined) {
    task.estimatedMinutes = effective.estimatedMinutes;
  }
  if (effective.track !== undefined) task.track = effective.track;
  return task;
}

/**
 * Expand a single RecurringTask record into the WeeklyTask[] it would
 * contribute to the given week. Skips occurrences marked `skip` and
 * applies override fields shallow-style. Pure — no I/O.
 */
function materializeRecord(
  record: RecurringTask,
  weekMondayUtc: Date,
  tz: string,
): WeeklyTask[] {
  const occurrences = expandForWindow(record.rule, weekMondayUtc, tz, record.id);
  if (occurrences.length === 0) return [];

  // Index exceptions by their normalized originalRunAt so we can join in O(1).
  const exceptionsByOriginal = new Map<string, RecurrenceException>();
  for (const exc of record.exceptions ?? []) {
    exceptionsByOriginal.set(normalizeIso(exc.originalRunAt), exc);
  }

  const out: WeeklyTask[] = [];
  for (const occ of occurrences) {
    const exc = exceptionsByOriginal.get(normalizeIso(occ.runAt));
    if (exc?.kind === 'skip') continue;
    const override = exc?.kind === 'override' ? exc.override : undefined;
    out.push(buildWeeklyTask(occ, record.template, override));
  }
  return out;
}

/**
 * Derive a `YYYY-MM` month key from the UTC instant of the local Monday
 * 00:00. Matches the convention used elsewhere in the codebase — the
 * weekly plan's `month` field tracks the month that owns the Monday of
 * the ISO week (not the calendar-month majority of the seven days).
 */
function monthFromMondayUtc(weekMondayUtc: Date, tz: string): string {
  const p = localParts(weekMondayUtc, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/**
 * AC15 predicate: does this task carry a recurring-derived id?
 *
 * The expander stamps every occurrence with an id of the form
 * `task-rec-<ruleId>-<yyyymmddThhmm>` (AC6). Hand-authored tasks use
 * `task-<something>` without the `rec-` segment, so a simple prefix check
 * distinguishes the two populations cheaply and without a parallel field
 * on the task schema.
 *
 * The check is intentionally permissive about the suffix shape — we
 * trust the expander/materializer to mint correct ids; the predicate
 * only protects against a hand-authored task accidentally being treated
 * as recurring (which would mis-fire the auto-approval gate).
 */
function isRecurringDerivedTask(task: { id: string }): boolean {
  return typeof task.id === 'string' && task.id.startsWith('task-rec-');
}

/**
 * AC15 predicate: every task in the array is recurring-derived (and the
 * array is non-empty — an empty plan should NOT auto-approve, since
 * there's nothing for the heartbeat to execute and approving a zero-task
 * plan only adds noise to the dashboard's "approved this week" feed).
 */
function isPlanAllRecurringDerived(tasks: readonly WeeklyTask[]): boolean {
  return tasks.length > 0 && tasks.every(isRecurringDerivedTask);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Materialize every recurring task for an agent into the given ISO week's
 * WeeklyPlan, idempotently.
 *
 * Effects on disk:
 *   - No existing plan + no materialized tasks → no write.
 *   - No existing plan + materialized tasks    → writes a fresh plan
 *                                                with `approved: false`
 *                                                and `createdAt: now`.
 *   - Existing plan + every materialized id    → no write (byte-identical
 *     already in the plan                        guarantee for AC5).
 *   - Existing plan + ≥1 new materialized id   → writes the merged plan,
 *                                                appending the new tasks
 *                                                after existing ones. The
 *                                                store does NOT bump
 *                                                `updatedAt` on this path
 *                                                (we call `save()` directly
 *                                                rather than `update()`).
 *
 * @returns A {@link MaterializeResult} describing what happened. The
 *          `unchanged` flag is the signal AC5 leans on.
 */
export async function materializeRecurringForWeek(
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const {
    weeklyPlanStore,
    recurringTaskStore,
    agentId,
    weekKey,
    tz,
    now = new Date(),
  } = opts;

  const records = await recurringTaskStore.loadAll(agentId);
  const weekMondayUtc = mondayOfWeek(weekKey, tz);

  // Expand every record into its contribution to this week, then sort
  // deterministically so the new-tasks tail appended to the plan is
  // stable across runs.
  const materialized: WeeklyTask[] = [];
  for (const record of records) {
    materialized.push(...materializeRecord(record, weekMondayUtc, tz));
  }
  materialized.sort((a, b) => {
    const aRun = a.runAt ?? '';
    const bRun = b.runAt ?? '';
    if (aRun !== bRun) return aRun < bRun ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  // Load existing plan if any. We do NOT round-trip through
  // `WeeklyPlanStore.load()` because that throws on missing files; the
  // store's `exists` + manual readFile pattern is cleaner.
  const planExists = await weeklyPlanStore.exists(agentId, weekKey);
  const existing: WeeklyPlan | null = planExists
    ? await weeklyPlanStore.load(agentId, weekKey)
    : null;

  const existingIds = new Set((existing?.tasks ?? []).map((t) => t.id));
  const newTasks = materialized.filter((t) => !existingIds.has(t.id));

  // Idempotence fast-paths:
  //   (a) no existing plan AND no occurrences → nothing to do.
  //   (b) existing plan AND no new ids        → nothing to add. Skip the
  //                                              write so the file's
  //                                              bytes (and mtime) stay
  //                                              identical to the prior
  //                                              run.
  if (!existing && materialized.length === 0) {
    return { weekKey, unchanged: true, addedTaskIds: [], autoApproved: false };
  }
  if (existing && newTasks.length === 0) {
    return { weekKey, unchanged: true, addedTaskIds: [], autoApproved: false };
  }

  // Build the merged plan. Existing tasks pass through verbatim so the
  // heartbeat's state (status / completedAt / failure tracker) survives.
  const mergedTasks: WeeklyTask[] = existing
    ? [...existing.tasks, ...newTasks]
    : [...newTasks];

  // AC15 — auto-approve plans containing only recurring-derived tasks so
  // unattended weeks execute through the existing approval gate. The
  // flip fires when:
  //   - we're creating a fresh plan whose tasks are all recurring, OR
  //   - we're merging into an existing UN-approved plan whose post-merge
  //     task list is all recurring.
  // A plan that is already approved keeps its historical `approvedAt`
  // intact; a mixed (manual + recurring) plan never auto-approves.
  const wasApproved = existing?.approved === true;
  const autoApproveNow =
    !wasApproved && isPlanAllRecurringDerived(mergedTasks);

  const merged: WeeklyPlan = existing
    ? autoApproveNow
      ? {
          ...existing,
          tasks: mergedTasks,
          approved: true,
          approvedAt: now.toISOString(),
        }
      : { ...existing, tasks: mergedTasks }
    : {
        week: weekKey,
        month: monthFromMondayUtc(weekMondayUtc, tz),
        tasks: mergedTasks,
        approved: autoApproveNow,
        ...(autoApproveNow ? { approvedAt: now.toISOString() } : {}),
        createdAt: now.toISOString(),
      };

  await weeklyPlanStore.save(agentId, merged);

  return {
    weekKey,
    unchanged: false,
    addedTaskIds: newTasks.map((t) => t.id),
    autoApproved: autoApproveNow,
  };
}
