/**
 * Recurrence expander — turns a `RecurrenceRule` + a week-Monday anchor into
 * the set of `Occurrence` records that fire inside that ISO week.
 *
 * This module is the canonical projection layer between a persisted
 * `RecurringTask` and either:
 *   - the SPA calendar (lazy expansion at render time), or
 *   - the heartbeat materializer (eager expansion at tick time into the
 *     existing WeeklyPlanStore).
 *
 * Design rules:
 *
 *  1. **Purity / determinism.** `expandForWindow(rule, weekMondayUtc, tz)`
 *     never reads the wall clock, never touches the filesystem, and never
 *     mutates its inputs. Identical arguments produce a byte-identical
 *     `Occurrence[]` on every call. This is load-bearing — the heartbeat
 *     materializer relies on idempotent merges, the SPA relies on stable
 *     occurrence ids across re-renders, and the test suite asserts the
 *     same expansion twice in a row.
 *
 *  2. **No DST code here.** Every wall-clock → UTC projection routes
 *     through `localWallClockToUtc`. Spring-forward gaps and fall-back
 *     ambiguities are handled exactly as that helper handles them
 *     elsewhere in the codebase.
 *
 *  3. **Window-scoped.** The expander only emits occurrences whose UTC
 *     instant falls inside `[weekMondayUtc, weekMondayUtc + 7 days)`. It
 *     does NOT enumerate the entire recurrence series — for an open-ended
 *     rule that would be unbounded. To enumerate enough candidates for
 *     `COUNT` / `BYSETPOS` we expand "from the start of the series up to
 *     the end of the window" internally, then trim.
 *
 *  4. **Exceptions are NOT applied here.** The expander returns the raw
 *     occurrences the rule would produce. Skip / override merging is the
 *     materializer's job (it has access to the full RecurringTask and
 *     handles override.runAt time-shifts before window filtering).
 *
 *  5. **Occurrence id format.** `task-rec-<ruleId>-<yyyymmddThhmm>` where
 *     the trailing component is the UTC components of the occurrence
 *     instant. Stable across runs because the inputs are stable.
 *
 *  6. **v1 scope ceiling.** FREQ=YEARLY, multiple RRULEs, RDATE/EXDATE,
 *     and iCalendar I/O are explicitly out of scope (see the seed's "v1
 *     out of scope" constraint).
 */

import {
  isValidTimeZone,
  localParts,
  localWallClockToUtc,
} from '../time/zone.js';
import type {
  RecurrenceByDay,
  RecurrenceRule,
} from '../storage/recurring-task-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/** Milliseconds in seven days (ISO-week window length). */
const WEEK_MS = 7 * MS_PER_DAY;

/**
 * Hard cap on the number of step iterations *after* the fast-forward
 * jump (`computeStartStep`). Prevents pathological rules (e.g. a
 * BYMONTHDAY=31 monthly rule asked for a Feb-only window — every step
 * generates an empty candidate set and the loop has no other way to
 * exit) from blocking the event loop. With the fast-forward this cap is
 * a safety net rather than a horizon limit: open-ended rules normally
 * exit within ~10 step iterations of the window via the `allPastWindow`
 * check, regardless of how far the window is from `dtStart`.
 *
 * AC14 contract: the expander has NO upper bound on the temporal
 * distance between `dtStart` and the requested window — open-ended
 * rules expand forever. The bound here is on per-call iterations
 * *relative to the window*, not absolute steps from `dtStart`.
 */
const MAX_CANDIDATES = 100_000;

/** Two-letter weekday codes in ISO order (Monday-first). */
const BYDAY_ORDER: readonly RecurrenceByDay[] = [
  'MO',
  'TU',
  'WE',
  'TH',
  'FR',
  'SA',
  'SU',
];

/** Map BYDAY code → ISO weekday number (1..7, Monday=1). */
const BYDAY_TO_ISO: Readonly<Record<RecurrenceByDay, number>> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single expanded occurrence — the rule fired at this instant. The
 * expander returns occurrences with `id`, `runAt`, and a back-pointer to
 * the rule. The materializer (downstream) merges this against the
 * template + exceptions to produce a fully-populated WeeklyTask.
 */
export interface Occurrence {
  /**
   * Stable occurrence id: `task-rec-<ruleId>-<yyyymmddThhmm>` using the
   * UTC components of `runAt`. Suitable as the `id` for a materialized
   * WeeklyTask — the materializer can dedupe on this directly.
   */
  id: string;
  /** UTC ISO instant the occurrence fires. */
  runAt: string;
  /** Back-pointer to the rule's owning RecurringTask id. */
  ruleId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a UTC instant into the `yyyymmddThhmm` suffix used inside the
 * occurrence id. Seconds are intentionally dropped — recurrence rules
 * never fire at sub-minute precision in v1.
 */
function formatOccurrenceSuffix(runAtMs: number): string {
  const d = new Date(runAtMs);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}` +
    `${pad2(d.getUTCMonth() + 1)}` +
    `${pad2(d.getUTCDate())}` +
    `T` +
    `${pad2(d.getUTCHours())}` +
    `${pad2(d.getUTCMinutes())}`
  );
}

/** Build a deterministic occurrence id. */
function buildOccurrenceId(ruleId: string, runAtMs: number): string {
  return `task-rec-${ruleId}-${formatOccurrenceSuffix(runAtMs)}`;
}

/**
 * Day-arithmetic on a local Y/M/D triple. Adding N days never crosses a
 * DST seam (we're staying in wall-clock terms) — the seam is only
 * relevant when we re-project to UTC via `localWallClockToUtc`.
 */
function addDaysLocal(year: number, month: number, day: number, days: number): {
  year: number;
  month: number;
  day: number;
} {
  // Use UTC arithmetic on the Y/M/D triple (the projection is already
  // baked in, so UTC is a safe scratch space).
  const ms = Date.UTC(year, month - 1, day) + days * MS_PER_DAY;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** Add N months to a local Y/M/D triple, clamping the day to the new month length. */
function addMonthsLocal(year: number, month: number, day: number, months: number): {
  year: number;
  month: number;
  day: number;
} {
  const totalMonths = (year * 12 + (month - 1)) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  // Last day of new month — JS trick: day 0 of next month.
  const lastDay = new Date(Date.UTC(newYear, newMonth, 0)).getUTCDate();
  return {
    year: newYear,
    month: newMonth,
    day: Math.min(day, lastDay),
  };
}

/** Last calendar day of a given local month. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Convert ISO weekday (1..7, Mon=1) to JS getUTCDay (0..6, Sun=0). */
function isoWeekdayOfDate(year: number, month: number, day: number): number {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Compute the local Y/M/D of `dtStart` projected into the rule's zone.
 * This is the anchor — every other candidate is derived from it via
 * frequency-specific stepping.
 */
function dtStartLocal(rule: RecurrenceRule): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const dtStartMs = Date.parse(rule.dtStart);
  if (Number.isNaN(dtStartMs)) {
    throw new TypeError(
      `recurrence-expander: rule.dtStart is not a valid ISO date-time: ${JSON.stringify(rule.dtStart)}`,
    );
  }
  const p = localParts(dtStartMs, rule.timeZone);
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
  };
}

/**
 * Project a local Y/M/D triple back to UTC at the rule's wall-clock
 * time-of-day. Centralises the DST handling: `localWallClockToUtc`
 * already returns the first valid moment past a spring-forward gap and
 * the earlier of two ambiguous candidates for fall-back.
 */
function projectToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  return localWallClockToUtc({ year, month, day, hour, minute, second }, tz);
}

/**
 * Generate candidate occurrence UTC instants for a single "interval step"
 * — i.e. one week (FREQ=WEEKLY), one day (FREQ=DAILY), or one month
 * (FREQ=MONTHLY). The step is the unit `interval` multiplies.
 *
 * Filters that depend on the step (BYDAY for WEEKLY, BYDAY+BYSETPOS or
 * BYMONTHDAY for MONTHLY) are applied here so the caller just sees a
 * flat stream of candidates in chronological order.
 */
function generateStepCandidates(
  rule: RecurrenceRule,
  stepIndex: number,
  anchor: ReturnType<typeof dtStartLocal>,
): Date[] {
  const { hour, minute, second } = anchor;
  const tz = rule.timeZone;
  const out: Date[] = [];

  switch (rule.freq) {
    case 'daily': {
      // FREQ=DAILY: one candidate per step, optionally filtered by BYDAY.
      const days = stepIndex * rule.interval;
      const { year, month, day } = addDaysLocal(
        anchor.year,
        anchor.month,
        anchor.day,
        days,
      );
      if (rule.byDay && rule.byDay.length > 0) {
        const iso = isoWeekdayOfDate(year, month, day);
        const allowed = rule.byDay.some((d) => BYDAY_TO_ISO[d] === iso);
        if (!allowed) return out;
      }
      out.push(projectToUtc(year, month, day, hour, minute, second, tz));
      return out;
    }

    case 'weekly': {
      // FREQ=WEEKLY: each step covers one whole week starting at the
      // local Monday of the anchor's containing ISO week.
      const anchorIso = isoWeekdayOfDate(anchor.year, anchor.month, anchor.day);
      const anchorWeekMonday = addDaysLocal(
        anchor.year,
        anchor.month,
        anchor.day,
        -(anchorIso - 1),
      );
      const stepMonday = addDaysLocal(
        anchorWeekMonday.year,
        anchorWeekMonday.month,
        anchorWeekMonday.day,
        stepIndex * rule.interval * 7,
      );

      // Without BYDAY a FREQ=WEEKLY rule fires on the anchor's weekday
      // exactly once per step. With BYDAY it fires on each listed weekday
      // within the step's week.
      const days: RecurrenceByDay[] =
        rule.byDay && rule.byDay.length > 0
          ? [...rule.byDay].sort(
              (a, b) => BYDAY_ORDER.indexOf(a) - BYDAY_ORDER.indexOf(b),
            )
          : [BYDAY_ORDER[anchorIso - 1]];

      for (const code of days) {
        const offset = BYDAY_TO_ISO[code] - 1;
        const { year, month, day } = addDaysLocal(
          stepMonday.year,
          stepMonday.month,
          stepMonday.day,
          offset,
        );
        out.push(projectToUtc(year, month, day, hour, minute, second, tz));
      }
      return out;
    }

    case 'monthly': {
      // FREQ=MONTHLY: each step is one calendar month from the anchor.
      const stepMonth = addMonthsLocal(
        anchor.year,
        anchor.month,
        1,
        stepIndex * rule.interval,
      );
      const monthYear = stepMonth.year;
      const monthMonth = stepMonth.month;
      const lastDay = lastDayOfMonth(monthYear, monthMonth);

      // Case A — BYMONTHDAY: single specific day of month (silently
      // skips if month is too short, per RFC 5545).
      if (rule.byMonthDay !== undefined) {
        if (rule.byMonthDay > lastDay) return out;
        out.push(
          projectToUtc(monthYear, monthMonth, rule.byMonthDay, hour, minute, second, tz),
        );
        return out;
      }

      // Case B — BYDAY + BYSETPOS: nth weekday of the month (e.g.
      // {byDay:["TU"], bySetPos:2} = second Tuesday).
      if (rule.byDay && rule.byDay.length > 0 && rule.bySetPos !== undefined) {
        const isoDays = new Set(rule.byDay.map((d) => BYDAY_TO_ISO[d]));
        const matches: Array<{ day: number }> = [];
        for (let day = 1; day <= lastDay; day += 1) {
          const iso = isoWeekdayOfDate(monthYear, monthMonth, day);
          if (isoDays.has(iso)) matches.push({ day });
        }
        if (matches.length === 0) return out;
        const idx =
          rule.bySetPos > 0 ? rule.bySetPos - 1 : matches.length + rule.bySetPos;
        if (idx < 0 || idx >= matches.length) return out;
        const pick = matches[idx];
        out.push(projectToUtc(monthYear, monthMonth, pick.day, hour, minute, second, tz));
        return out;
      }

      // Case C — BYDAY only (no BYSETPOS): every listed weekday in the
      // month. Useful for "every Mon/Wed/Fri this month" patterns.
      if (rule.byDay && rule.byDay.length > 0) {
        const isoDays = new Set(rule.byDay.map((d) => BYDAY_TO_ISO[d]));
        for (let day = 1; day <= lastDay; day += 1) {
          const iso = isoWeekdayOfDate(monthYear, monthMonth, day);
          if (isoDays.has(iso)) {
            out.push(projectToUtc(monthYear, monthMonth, day, hour, minute, second, tz));
          }
        }
        return out;
      }

      // Case D — no filters: fire on the anchor's day-of-month, clamped
      // to the new month's last day (matches addMonthsLocal's clamp).
      const clampedDay = Math.min(anchor.day, lastDay);
      out.push(projectToUtc(monthYear, monthMonth, clampedDay, hour, minute, second, tz));
      return out;
    }

    default: {
      // Exhaustive switch — TS narrows this to `never`.
      const _exhaustive: never = rule.freq;
      void _exhaustive;
      return out;
    }
  }
}

/**
 * Compute the step index at which to begin the main expansion loop for
 * the given window. The expander's "step 0" corresponds to the `dtStart`
 * anchor; higher steps move forward in time by `interval` units of
 * `rule.freq`.
 *
 * Two regimes:
 *
 *  - **count-bounded** (`rule.count` defined). Must start at step 0
 *    because the `count` budget has to be debited for every in-series
 *    candidate from `dtStart` forward — fast-forwarding past earlier
 *    occurrences would let an exhausted rule erroneously fire again in
 *    a far-future window. AC13 covers this regime.
 *
 *  - **open-ended** (`rule.count === undefined`). Fast-forward to a
 *    step at or just before the requested window. AC14 contract: the
 *    expander must produce occurrences for ANY future week, no matter
 *    how far ahead — without this jump, a daily rule with `dtStart` in
 *    2026 asking for a window in year 2300+ would exhaust
 *    `MAX_CANDIDATES` before reaching the window.
 *
 * The "step back 1" buffer absorbs slop: DST drift over decades can
 * shift the candidate by an hour, and a MONTHLY BYSETPOS=-1 rule lands
 * near month-end. A filtered or out-of-window candidate is cheap; a
 * missed in-window candidate is wrong.
 */
function computeStartStep(
  rule: RecurrenceRule,
  windowStartMs: number,
  anchor: ReturnType<typeof dtStartLocal>,
): number {
  if (rule.count !== undefined) return 0;

  const anchorUtcMs = projectToUtc(
    anchor.year,
    anchor.month,
    anchor.day,
    anchor.hour,
    anchor.minute,
    anchor.second,
    rule.timeZone,
  ).getTime();

  if (windowStartMs <= anchorUtcMs) return 0;

  const distanceMs = windowStartMs - anchorUtcMs;

  switch (rule.freq) {
    case 'daily': {
      const stepsMs = rule.interval * MS_PER_DAY;
      return Math.max(0, Math.floor(distanceMs / stepsMs) - 1);
    }
    case 'weekly': {
      const stepsMs = rule.interval * 7 * MS_PER_DAY;
      return Math.max(0, Math.floor(distanceMs / stepsMs) - 1);
    }
    case 'monthly': {
      // Calendar-month distance — months aren't uniform ms, so project
      // the window start into the rule's zone and count whole months.
      const wp = localParts(windowStartMs, rule.timeZone);
      const monthsDiff =
        (wp.year - anchor.year) * 12 + (wp.month - anchor.month);
      return Math.max(0, Math.floor(monthsDiff / rule.interval) - 1);
    }
    default: {
      const _exhaustive: never = rule.freq;
      void _exhaustive;
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure, deterministic expansion of a recurrence rule into the
 * `Occurrence[]` that fire inside the ISO-week starting at
 * `weekMondayUtc`. The window is `[weekMondayUtc, weekMondayUtc + 7 days)`
 * — half-open on the upper bound (Sunday 23:59 inclusive, the following
 * Monday 00:00 exclusive).
 *
 * Inputs:
 *   - `rule`           — a validated `RecurrenceRule` (post-AJV).
 *   - `weekMondayUtc`  — output of `mondayOfWeek(weekKey, tz)`. The UTC
 *                         instant of local-Monday 00:00 in `tz`.
 *   - `tz`             — IANA zone for the expansion (typically equal to
 *                         `rule.timeZone`, but kept as an explicit
 *                         argument so the caller can re-project a rule
 *                         under a different display zone if needed).
 *   - `ruleId`         — id of the owning RecurringTask. Used to build
 *                         deterministic occurrence ids.
 *
 * Output: occurrences sorted by `runAt` ascending. Empty array when the
 * rule produces nothing inside the window (window before `dtStart`,
 * past `count`/`until`, or filters exclude every weekday).
 *
 * **Purity contract.** This function MUST:
 *   - never read the wall clock,
 *   - never touch the filesystem,
 *   - never mutate its arguments,
 *   - return the same `Occurrence[]` (same length, same ids, same
 *     `runAt` strings, same order) on every call with identical inputs.
 *
 * The unit-test suite asserts the contract directly: every test case
 * runs the expander twice and `deepStrictEqual`s the two arrays.
 */
export function expandForWindow(
  rule: RecurrenceRule,
  weekMondayUtc: Date,
  tz: string,
  ruleId: string,
): Occurrence[] {
  if (!isValidTimeZone(tz)) {
    throw new TypeError(`recurrence-expander: invalid time zone ${JSON.stringify(tz)}`);
  }
  if (!(weekMondayUtc instanceof Date) || Number.isNaN(weekMondayUtc.getTime())) {
    throw new TypeError('recurrence-expander: weekMondayUtc must be a valid Date');
  }
  if (typeof ruleId !== 'string' || ruleId.length === 0) {
    throw new TypeError('recurrence-expander: ruleId must be a non-empty string');
  }

  const windowStartMs = weekMondayUtc.getTime();
  const windowEndMs = windowStartMs + WEEK_MS;

  const dtStartMs = Date.parse(rule.dtStart);
  if (Number.isNaN(dtStartMs)) {
    throw new TypeError(
      `recurrence-expander: rule.dtStart is not a valid ISO date-time: ${JSON.stringify(rule.dtStart)}`,
    );
  }

  // Early exit: window ends before the series even starts.
  if (windowEndMs <= dtStartMs) return [];

  const untilMs =
    rule.until !== undefined ? Date.parse(rule.until) : Number.POSITIVE_INFINITY;
  if (rule.until !== undefined && Number.isNaN(untilMs)) {
    throw new TypeError(
      `recurrence-expander: rule.until is not a valid ISO date-time: ${JSON.stringify(rule.until)}`,
    );
  }
  const countCap = rule.count !== undefined ? rule.count : Number.POSITIVE_INFINITY;

  const anchor = dtStartLocal(rule);
  const occurrences: Occurrence[] = [];
  let producedCount = 0;

  // AC14: fast-forward past the long walk from `dtStart` when the rule
  // is open-ended. count-bounded rules (AC13) still start at step 0 so
  // the count budget is debited from the series start.
  const startStep = computeStartStep(rule, windowStartMs, anchor);

  for (let i = 0; i < MAX_CANDIDATES; i += 1) {
    const step = startStep + i;
    const candidates = generateStepCandidates(rule, step, anchor);

    // Sort within the step so `out` is monotonically ascending across
    // steps (matters for FREQ=WEEKLY with BYDAY and FREQ=MONTHLY case-C).
    candidates.sort((a, b) => a.getTime() - b.getTime());

    let allPastWindow = candidates.length > 0;

    for (const cand of candidates) {
      const ms = cand.getTime();

      // Bound checks against dtStart and the rule terminators.
      if (ms < dtStartMs) continue;
      if (ms > untilMs) {
        // until terminates the series — no further candidates can be
        // inside-window AND inside the series.
        return occurrences;
      }
      if (producedCount >= countCap) {
        // count terminates the series.
        return occurrences;
      }
      producedCount += 1;

      if (ms < windowStartMs) {
        // Inside the series but before the window — keep walking.
        allPastWindow = false;
        continue;
      }
      if (ms >= windowEndMs) {
        // Past the window. Don't return yet — later candidates in this
        // step may have been ordered before earlier ones in a previous
        // step (shouldn't happen with our sort, but defensive). The
        // outer step loop's `allPastWindow` check terminates us.
        continue;
      }

      allPastWindow = false;
      occurrences.push({
        id: buildOccurrenceId(ruleId, ms),
        runAt: new Date(ms).toISOString(),
        ruleId,
      });
    }

    // If every candidate in this step landed past the window end AND
    // we've already entered the series (i.e. at least one prior step
    // produced something or this step's first candidate is past
    // windowEnd), we can stop — subsequent steps only move further
    // forward in time.
    if (allPastWindow && candidates.length > 0 && candidates[0].getTime() >= windowEndMs) {
      return occurrences;
    }
  }

  return occurrences;
}

/**
 * Count the number of occurrences in this rule's series that fire STRICTLY
 * before `beforeMs` (UTC ms). Walks candidates from `dtStart` forward so
 * `rule.count` is debited from the series start — matching how
 * {@link expandForWindow} debits the count budget.
 *
 * Used by `splitRuleAtOccurrence` (sub-AC 11.2.2) to compute the "consumed
 * count" when splitting a COUNT-bounded series at `occurrenceDate`. The
 * caller then assigns the consumed count to the original successor rule
 * and the remaining count to the successor — guaranteeing the seam date
 * never fires under both halves of the split.
 *
 * Semantics:
 *   - Returns 0 when `beforeMs <= dtStart` (no occurrence can precede dtStart).
 *   - Respects `rule.count` as an upper bound (returns at most `rule.count`).
 *   - Respects `rule.until` (stops counting past the UNTIL terminator).
 *   - "Strictly before" means `runAt < beforeMs` — an occurrence whose
 *     `runAt === beforeMs` is NOT counted (so the seam goes to the successor).
 *
 * Purity contract: same as {@link expandForWindow} — no wall clock, no
 * filesystem, no input mutation; same arguments → same return value.
 *
 * @throws TypeError when `rule.dtStart` / `rule.until` is not a valid ISO
 *                  date-time, or `rule.timeZone` is not a recognisable IANA
 *                  zone.
 */
export function countOccurrencesBefore(
  rule: RecurrenceRule,
  beforeMs: number,
): number {
  if (!isValidTimeZone(rule.timeZone)) {
    throw new TypeError(
      `recurrence-expander: invalid time zone ${JSON.stringify(rule.timeZone)}`,
    );
  }
  const dtStartMs = Date.parse(rule.dtStart);
  if (Number.isNaN(dtStartMs)) {
    throw new TypeError(
      `recurrence-expander: rule.dtStart is not a valid ISO date-time: ${JSON.stringify(rule.dtStart)}`,
    );
  }
  if (beforeMs <= dtStartMs) return 0;

  const untilMs =
    rule.until !== undefined ? Date.parse(rule.until) : Number.POSITIVE_INFINITY;
  if (rule.until !== undefined && Number.isNaN(untilMs)) {
    throw new TypeError(
      `recurrence-expander: rule.until is not a valid ISO date-time: ${JSON.stringify(rule.until)}`,
    );
  }
  const countCap = rule.count !== undefined ? rule.count : Number.POSITIVE_INFINITY;

  const anchor = dtStartLocal(rule);
  let consumed = 0;
  let seriesProduced = 0;

  // Walk steps from 0 — we MUST debit the count budget from the series
  // start, so no fast-forward here (mirrors the count-bounded regime of
  // expandForWindow's `computeStartStep`).
  for (let step = 0; step < MAX_CANDIDATES; step += 1) {
    const candidates = generateStepCandidates(rule, step, anchor);
    candidates.sort((a, b) => a.getTime() - b.getTime());

    if (candidates.length === 0) {
      // Empty step — keep walking. (Schema-impossible filter combos like
      // BYMONTHDAY=31 in February land here; the MAX_CANDIDATES guard is
      // the only thing that prevents an infinite loop.)
      continue;
    }

    for (const cand of candidates) {
      const ms = cand.getTime();
      if (ms < dtStartMs) continue;
      if (ms > untilMs) return consumed;
      if (seriesProduced >= countCap) return consumed;
      seriesProduced += 1;
      if (ms < beforeMs) {
        consumed += 1;
        continue;
      }
      // ms >= beforeMs → we've crossed the seam. consumed is final.
      return consumed;
    }
  }

  return consumed;
}
