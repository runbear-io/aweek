/**
 * Daily-review adjustment applier.
 *
 * After `generateDailyReview` writes the daily review file, this module:
 *   1. Converts the structured "Adjustments for Tomorrow" records from the
 *      daily review into `weeklyAdjustment` operations — the same format that
 *      `adjustGoals` accepts.
 *   2. Validates the entire batch up front; if any operation fails, none are
 *      applied (atomic: all-or-nothing).
 *   3. Applies the batch to the agent's weekly plan immediately via
 *      `adjustGoals`. New / rescheduled / retried tasks land as `pending` and
 *      become eligible for the heartbeat on the next tick — no Branch B
 *      approval step stands between the daily review and the plan.
 *
 * Adjustment type → weekly operation mapping
 * ------------------------------------------
 *   'carry-over' → update task runAt to tomorrow at 09:00 UTC
 *   'continue'   → no plan mutation (task is already in-progress); skipped
 *   'retry'      → update task status back to 'pending' AND runAt to tomorrow 09:00
 *   'reschedule' → update task runAt to tomorrow at 09:00 UTC
 *   'follow-up'  → add a new follow-up task (same objectiveId, same week)
 *
 * Why no 'continue' op?
 *   An in-progress task already has the heartbeat pointed at it; updating its
 *   runAt would reschedule it past its current "pick me up now" eligibility
 *   window and potentially cause it to be skipped. The advisor-voice text in
 *   the daily review document already captures the context for the agent — no
 *   plan mutation is needed or safe.
 */

import {
  isValidTimeZone,
  localParts,
  localWallClockToUtc,
} from '../time/zone.js';
import { adjustGoals } from './plan-adjustments.js';

export interface AdjustmentRecord {
  type: string;
  taskId: string;
  title: string;
  text: string;
}

export interface WeeklyTaskLite {
  id: string;
  objectiveId?: string | null;
  /**
   * Original `runAt` for the task. Used by the carry-over / retry / reschedule
   * paths so the new `runAt` lands at the same local time-of-day as the
   * original schedule, instead of bunching every adjusted task at a single
   * hardcoded UTC hour.
   */
  runAt?: string;
}

export interface WeeklyPlanLite {
  tasks?: WeeklyTaskLite[];
}

export interface WeeklyAdjustmentOp {
  action: 'update' | 'add';
  week: string;
  taskId?: string;
  status?: string;
  runAt?: string;
  title?: string;
  prompt?: string;
  objectiveId?: string;
}

export interface ApplyDailyReviewResult {
  applied: boolean;
  opsCount: number;
  skippedCount: number;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default wall-clock hour for follow-up tasks (no original `runAt` to
 * preserve). Interpreted in the agent's `tz` when one is supplied, or as
 * UTC otherwise. 09:00 is early enough to be picked up on the first
 * heartbeat of a typical working day.
 */
const DEFAULT_CARRY_OVER_HOUR = 9;

// ---------------------------------------------------------------------------
// Date arithmetic helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Return the ISO date string (YYYY-MM-DD) for the day after `dateStr`.
 * Arithmetic is done in UTC so the result is timezone-independent.
 */
export function tomorrowDateStr(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a `runAt` ISO 8601 datetime string for a given local date at a
 * specific local hour:minute, projected into UTC via `tz`. Falls back to
 * UTC when `tz` is missing / invalid, which keeps legacy callers (no `tz`
 * supplied) on their pre-tz hardcoded behaviour.
 */
export function runAtForDate(
  dateStr: string,
  hour: number = DEFAULT_CARRY_OVER_HOUR,
  minute: number = 0,
  tz?: string,
): string {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (tz && isValidTimeZone(tz)) {
    const inst = localWallClockToUtc(
      { year, month, day, hour, minute, second: 0 },
      tz,
    );
    return inst.toISOString();
  }
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

/**
 * Compute a new `runAt` for `tomorrow` that preserves the local time-of-day
 * of the task's existing `runAt`, in the agent's configured zone. When the
 * task has no original `runAt` (e.g. brand-new follow-ups) or the zone is
 * missing / invalid, falls back to {@link DEFAULT_CARRY_OVER_HOUR}:00 in
 * whatever zone is available.
 */
function preserveTimeOfDay(
  originalRunAt: string | undefined,
  tomorrowDate: string,
  tz?: string,
): string {
  if (!originalRunAt) {
    return runAtForDate(tomorrowDate, DEFAULT_CARRY_OVER_HOUR, 0, tz);
  }
  const ms = Date.parse(originalRunAt);
  if (Number.isNaN(ms)) {
    return runAtForDate(tomorrowDate, DEFAULT_CARRY_OVER_HOUR, 0, tz);
  }
  if (tz && isValidTimeZone(tz)) {
    const parts = localParts(ms, tz);
    return runAtForDate(tomorrowDate, parts.hour, parts.minute, tz);
  }
  // No tz: read time-of-day in UTC and project onto the target UTC date.
  const d = new Date(ms);
  return runAtForDate(
    tomorrowDate,
    d.getUTCHours(),
    d.getUTCMinutes(),
    undefined,
  );
}

// ---------------------------------------------------------------------------
// Core converter: adjustment records → weeklyAdjustment ops
// ---------------------------------------------------------------------------

/**
 * Convert daily-review adjustment records into `weeklyAdjustment` operations.
 *
 * Each record from `buildAdjustmentsForTomorrow` carries `{ type, taskId,
 * title, text }`. This function translates those into operations that
 * `adjustGoals` / `applyWeeklyAdjustment` can apply to the live weekly plan.
 *
 * Records whose `taskId` cannot be found in `weeklyPlan.tasks` are silently
 * skipped — the human-readable daily review already captures every suggestion,
 * so no information is lost.
 *
 * @param {Array<{ type: string, taskId: string, title: string, text: string }>} adjustmentRecords
 *   Adjustment records produced by `buildAdjustmentsForTomorrow`.
 * @param {object|null} weeklyPlan - The current approved weekly plan.
 * @param {string} date - The review date (YYYY-MM-DD).
 * @param {string} week - ISO week string for the plan to mutate (YYYY-Www).
 * @returns {Array<object>} `weeklyAdjustment` operations ready for `adjustGoals`.
 */
export function extractWeeklyAdjustmentOps(
  adjustmentRecords: AdjustmentRecord[] | null | undefined,
  weeklyPlan: WeeklyPlanLite | null | undefined,
  date: string,
  week: string,
  tz?: string,
): WeeklyAdjustmentOp[] {
  if (!Array.isArray(adjustmentRecords) || adjustmentRecords.length === 0) return [];
  if (!weeklyPlan || !Array.isArray(weeklyPlan.tasks)) return [];

  const tomorrow = tomorrowDateStr(date);
  const followUpRunAt = runAtForDate(tomorrow, DEFAULT_CARRY_OVER_HOUR, 0, tz);
  const ops: WeeklyAdjustmentOp[] = [];

  for (const record of adjustmentRecords) {
    const { type, taskId, title } = record;

    const task = weeklyPlan.tasks.find((t: WeeklyTaskLite) => t.id === taskId);
    if (!task) continue;

    switch (type) {
      case 'carry-over': {
        const newRunAt = preserveTimeOfDay(task.runAt, tomorrow, tz);
        ops.push({ action: 'update', week, taskId, runAt: newRunAt });
        break;
      }

      case 'continue':
        break;

      case 'retry': {
        const newRunAt = preserveTimeOfDay(task.runAt, tomorrow, tz);
        ops.push({ action: 'update', week, taskId, status: 'pending', runAt: newRunAt });
        break;
      }

      case 'reschedule': {
        const newRunAt = preserveTimeOfDay(task.runAt, tomorrow, tz);
        ops.push({ action: 'update', week, taskId, runAt: newRunAt });
        break;
      }

      case 'follow-up': {
        const objectiveId = task.objectiveId || null;
        if (objectiveId) {
          const baseTitle = `Follow up: ${title}`;
          const trimmedTitle =
            baseTitle.length > 80 ? `${baseTitle.slice(0, 77)}...` : baseTitle;
          ops.push({
            action: 'add',
            week,
            title: trimmedTitle,
            prompt: `Follow up on delegated task: ${title}`,
            objectiveId,
            runAt: followUpRunAt,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Apply daily-review adjustment proposals directly to the agent's weekly plan.
 *
 * Called by `generateDailyReview` after the review file has been persisted.
 * New tasks (follow-ups) land as `pending`; carry-over / reschedule ops shift
 * `runAt` to tomorrow 09:00 UTC; retry ops reset failed tasks back to
 * `pending`. All of this flows straight into the live plan — the heartbeat
 * picks up the resulting tasks on the next eligible tick.
 *
 * **Atomic guarantee** — `adjustGoals` validates every op up front; if any op
 * fails validation the whole batch is rejected and nothing is written.
 *
 * **Non-error no-ops** — returns `{ applied: false }` (not an error) when:
 *   - No adjustment records (all tasks completed — nothing to carry over).
 *   - No weekly plan provided (tasks cannot be looked up).
 *   - Every record produced no op (e.g. all were 'continue' type).
 * Callers should treat these as benign no-ops rather than failures.
 *
 * @param {object} opts
 * @param {string} opts.baseDir - Data directory (e.g. `.aweek/agents`) passed
 *   through to `adjustGoals` as its `dataDir` argument.
 * @param {string} opts.agentId
 * @param {string} opts.date - Review date (YYYY-MM-DD); kept for parity with
 *   the previous enqueue signature so `generateDailyReview` doesn't change.
 * @param {string} opts.week - ISO week string for the target plan (YYYY-Www)
 * @param {Array<{ type: string, taskId: string, title: string, text: string }>} opts.adjustmentRecords
 *   Adjustment records from `buildAdjustmentsForTomorrow`.
 * @param {object|null} opts.weeklyPlan - The weekly plan loaded by `generateDailyReview`.
 * @returns {Promise<{
 *   applied: boolean,
 *   opsCount: number,
 *   skippedCount: number,
 *   errors?: string[],
 * }>}
 */
export interface ApplyDailyReviewAdjustmentsOpts {
  baseDir: string;
  agentId: string;
  week: string;
  adjustmentRecords: AdjustmentRecord[] | null | undefined;
  weeklyPlan: WeeklyPlanLite | null | undefined;
  date: string;
  /**
   * Agent's IANA time zone. Used so carry-over / retry / reschedule tasks
   * preserve their original local time-of-day instead of bunching at a
   * hardcoded 09:00 UTC slot (which renders as 02:00 PT, dead-of-night).
   */
  tz?: string;
}

export async function applyDailyReviewAdjustments({
  baseDir,
  agentId,
  week,
  adjustmentRecords,
  weeklyPlan,
  date: _date,
  tz,
}: ApplyDailyReviewAdjustmentsOpts): Promise<ApplyDailyReviewResult> {
  if (!Array.isArray(adjustmentRecords) || adjustmentRecords.length === 0) {
    return { applied: false, opsCount: 0, skippedCount: 0 };
  }

  if (!weeklyPlan || !Array.isArray(weeklyPlan.tasks)) {
    return { applied: false, opsCount: 0, skippedCount: adjustmentRecords.length };
  }

  const ops = extractWeeklyAdjustmentOps(adjustmentRecords, weeklyPlan, _date, week, tz);

  if (ops.length === 0) {
    return { applied: false, opsCount: 0, skippedCount: adjustmentRecords.length };
  }

  const result = await adjustGoals({
    agentId,
    weeklyAdjustments: ops as unknown[],
    dataDir: baseDir,
  });

  if (!result.success) {
    return {
      applied: false,
      opsCount: 0,
      skippedCount: adjustmentRecords.length,
      errors: result.errors || ['adjustGoals rejected the batch'],
    };
  }

  return {
    applied: true,
    opsCount: ops.length,
    skippedCount: adjustmentRecords.length - ops.length,
  };
}
