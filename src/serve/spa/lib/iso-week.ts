/**
 * Browser-side ISO 8601 week-key helpers for the calendar tab.
 *
 * The backend issues canonical week keys via `currentWeekKey` /
 * `mondayOfWeek` in `src/time/zone.ts`, which are timezone-aware. The
 * SPA only needs *relative* navigation — "the week before this one",
 * "the week after this one" — so it computes those from the active
 * week key client-side without round-tripping the server.
 *
 * For the "current" affordance the SPA never derives the current week
 * itself — it clears the `?week=` query param and lets the server pick
 * the agent's configured timezone's current week. That keeps the
 * client free of timezone math while still showing the right "today".
 */

/**
 * Convert a `"YYYY-Www"` ISO week key into a UTC `Date` representing
 * that week's Monday at 00:00:00Z. Throws on malformed input so callers
 * surface invariant violations during development rather than silently
 * navigating to a phantom week.
 */
export function isoWeekToMonday(week: string): Date {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) throw new Error(`Invalid ISO week key: ${week}`);
  const year = Number(match[1]);
  const weekNum = Number(match[2]);
  // ISO 8601: Jan 4 is always in week 1. Find that Monday and offset.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const result = new Date(week1Monday);
  result.setUTCDate(week1Monday.getUTCDate() + 7 * (weekNum - 1));
  return result;
}

/**
 * Convert any UTC `Date` into its ISO 8601 week key (`"YYYY-Www"`).
 * Uses the standard Thursday-pivot trick so dates that fall in a
 * different ISO year than their calendar year (early-Jan / late-Dec)
 * still map to the right week.
 */
export function mondayToIsoWeek(d: Date): string {
  const target = new Date(d);
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Offset an ISO week key by `delta` weeks. `addIsoWeeks("2026-W17", -1)`
 * → `"2026-W16"`; `addIsoWeeks("2026-W52", 1)` → `"2027-W01"` (or
 * `"2027-W53"` in 53-week years — the math is unconditional).
 */
export function addIsoWeeks(week: string, delta: number): string {
  const monday = isoWeekToMonday(week);
  monday.setUTCDate(monday.getUTCDate() + 7 * delta);
  return mondayToIsoWeek(monday);
}
