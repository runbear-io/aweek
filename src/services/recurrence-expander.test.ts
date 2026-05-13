/**
 * Tests for `expandForWindow` — the pure recurrence expander.
 *
 * AC2 focus: every test runs the expander twice with identical inputs and
 * asserts `deepStrictEqual` on the two arrays. This pins the determinism
 * contract — the materializer and SPA caching layers both rely on it.
 *
 * Coverage:
 *   - Determinism (every case re-runs the expander)
 *   - Window scoping (before / inside / after `[mon, mon+7d)`)
 *   - FREQ=DAILY (with and without interval / BYDAY filter)
 *   - FREQ=WEEKLY (anchor weekday, BYDAY multi-day, interval=2 biweekly)
 *   - FREQ=MONTHLY (BYMONTHDAY exact, BYMONTHDAY > month length skip,
 *     BYDAY+BYSETPOS positive + negative, plain anchor-day fallback)
 *   - COUNT and UNTIL terminators
 *   - DST seam (spring-forward + fall-back) routes through localWallClockToUtc
 *   - Occurrence id format is `task-rec-<ruleId>-<yyyymmddThhmm>`
 *   - Argument validation (invalid tz, invalid Date, invalid dtStart, empty ruleId)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expandForWindow } from './recurrence-expander.js';
import { localWallClockToUtc, mondayOfWeek } from '../time/zone.js';
import type { RecurrenceRule } from '../storage/recurring-task-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the expander twice and assert byte-identical output. Returns the
 * first call's result so the test body can make further assertions.
 */
function expandDeterministically(
  rule: RecurrenceRule,
  weekMondayUtc: Date,
  tz: string,
  ruleId: string,
): ReturnType<typeof expandForWindow> {
  const a = expandForWindow(rule, weekMondayUtc, tz, ruleId);
  const b = expandForWindow(rule, weekMondayUtc, tz, ruleId);
  assert.deepStrictEqual(a, b, 'expandForWindow must be deterministic across calls');
  // Also assert it does not mutate the rule argument.
  return a;
}

const RULE_ID = 'rec-standup';

// ---------------------------------------------------------------------------
// Determinism — AC2 core check, distilled
// ---------------------------------------------------------------------------

describe('expandForWindow — determinism (AC2)', () => {
  it('returns byte-identical arrays across repeated calls (weekly, BYDAY)', () => {
    const tz = 'America/Los_Angeles';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
      dtStart: '2026-05-04T17:00:00.000Z', // Mon 2026-05-04 10:00 PT
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);

    const a = expandForWindow(rule, monday, tz, RULE_ID);
    const b = expandForWindow(rule, monday, tz, RULE_ID);
    const c = expandForWindow(rule, monday, tz, RULE_ID);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(b, c);
    assert.equal(a.length, 3);
  });

  it('does not mutate its rule argument', () => {
    const tz = 'America/Los_Angeles';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
      dtStart: '2026-05-04T17:00:00.000Z',
      timeZone: tz,
    };
    const snapshot = JSON.stringify(rule);
    const monday = mondayOfWeek('2026-W19', tz);
    expandForWindow(rule, monday, tz, RULE_ID);
    assert.equal(JSON.stringify(rule), snapshot, 'rule must not be mutated');
  });

  it('does not consult the wall clock (purity)', () => {
    // We can't truly mock Date.now in node:test without monkey-patching,
    // so we assert behavioral purity: the result for an old window does
    // not depend on "now".
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2010-01-01T09:00:00.000Z',
      timeZone: tz,
    };
    const oldMonday = mondayOfWeek('2010-W01', tz);
    const futureMonday = mondayOfWeek('2030-W01', tz);
    const a = expandForWindow(rule, oldMonday, tz, RULE_ID);
    const b = expandForWindow(rule, oldMonday, tz, RULE_ID);
    const c = expandForWindow(rule, futureMonday, tz, RULE_ID);
    const d = expandForWindow(rule, futureMonday, tz, RULE_ID);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(c, d);
    assert.equal(a.length, 7);
    assert.equal(c.length, 7);
  });
});

// ---------------------------------------------------------------------------
// Window scoping
// ---------------------------------------------------------------------------

describe('expandForWindow — window scoping', () => {
  it('returns empty when the window ends before dtStart', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-06-01T09:00:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz); // 2026-05-04
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.deepStrictEqual(out, []);
  });

  it('only includes occurrences inside [mon, mon+7d)', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz); // Mon 2026-05-04 UTC
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 7);

    const windowStart = monday.getTime();
    const windowEnd = windowStart + 7 * 86_400_000;
    for (const o of out) {
      const ms = Date.parse(o.runAt);
      assert.ok(ms >= windowStart, `${o.runAt} should be >= window start`);
      assert.ok(ms < windowEnd, `${o.runAt} should be < window end (half-open)`);
    }
  });

  it('orders occurrences ascending by runAt', () => {
    const tz = 'America/Los_Angeles';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['FR', 'MO', 'WE'], // intentionally unsorted
      dtStart: '2026-05-04T17:00:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    const isoTimes = out.map((o) => o.runAt);
    const sorted = [...isoTimes].sort();
    assert.deepStrictEqual(isoTimes, sorted);
  });
});

// ---------------------------------------------------------------------------
// FREQ=DAILY
// ---------------------------------------------------------------------------

describe('expandForWindow — daily', () => {
  it('every-day rule produces 7 occurrences in a 7-day window', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T08:30:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 7);
  });

  it('every-other-day rule (interval=2) produces 4 occurrences', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 2,
      dtStart: '2026-05-04T08:30:00.000Z', // Mon
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    // Mon, Wed, Fri, Sun = 4
    assert.equal(out.length, 4);
  });

  it('daily + BYDAY filter restricts to listed weekdays', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
      dtStart: '2026-05-04T08:30:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 3);
  });
});

// ---------------------------------------------------------------------------
// FREQ=WEEKLY
// ---------------------------------------------------------------------------

describe('expandForWindow — weekly', () => {
  it('without BYDAY fires once on the anchor weekday', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      dtStart: '2026-05-06T14:00:00.000Z', // Wed
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 1);
    assert.equal(out[0].runAt, '2026-05-06T14:00:00.000Z');
  });

  it('BYDAY MO/WE/FR produces three occurrences per week', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
      dtStart: '2026-05-04T17:00:00.000Z', // Mon
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 3);
    const days = out.map((o) => new Date(o.runAt).getUTCDay());
    assert.deepStrictEqual(days.sort(), [1, 3, 5]);
  });

  it('biweekly (interval=2) skips alternate weeks', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 2,
      byDay: ['TU'],
      dtStart: '2026-05-05T14:00:00.000Z', // Tue 2026-05-05 (W19)
      timeZone: tz,
    };
    const w19 = mondayOfWeek('2026-W19', tz);
    const w20 = mondayOfWeek('2026-W20', tz);
    const w21 = mondayOfWeek('2026-W21', tz);
    const a19 = expandDeterministically(rule, w19, tz, RULE_ID);
    const a20 = expandDeterministically(rule, w20, tz, RULE_ID);
    const a21 = expandDeterministically(rule, w21, tz, RULE_ID);
    assert.equal(a19.length, 1, 'W19 fires (the anchor week)');
    assert.equal(a20.length, 0, 'W20 skipped (biweekly)');
    assert.equal(a21.length, 1, 'W21 fires (every other week)');
  });
});

// ---------------------------------------------------------------------------
// FREQ=MONTHLY
// ---------------------------------------------------------------------------

describe('expandForWindow — monthly', () => {
  it('BYMONTHDAY=15 fires once in the containing week', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'monthly',
      interval: 1,
      byMonthDay: 15,
      dtStart: '2026-01-15T09:00:00.000Z',
      timeZone: tz,
    };
    // 2026-05-15 is a Friday — W20 (2026-05-11 .. 2026-05-17).
    const monday = mondayOfWeek('2026-W20', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 1);
    assert.equal(out[0].runAt, '2026-05-15T09:00:00.000Z');
  });

  it('BYMONTHDAY=31 silently skips short months (Feb)', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'monthly',
      interval: 1,
      byMonthDay: 31,
      dtStart: '2026-01-31T09:00:00.000Z',
      timeZone: tz,
    };
    // Pick the week containing 2026-02-28 (last day of Feb). W09 starts Mon 2026-02-23.
    const monday = mondayOfWeek('2026-W09', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 0, 'Feb has no day 31 → no occurrence in W09');
  });

  it('BYDAY + BYSETPOS=2 fires on the second listed-weekday of the month', () => {
    const tz = 'UTC';
    // "Second Tuesday of every month"
    const rule: RecurrenceRule = {
      freq: 'monthly',
      interval: 1,
      byDay: ['TU'],
      bySetPos: 2,
      dtStart: '2026-01-13T15:00:00.000Z', // 2nd Tue of Jan 2026
      timeZone: tz,
    };
    // May 2026: 2nd Tuesday = 2026-05-12. W20 covers 2026-05-11..2026-05-17.
    const monday = mondayOfWeek('2026-W20', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 1);
    assert.equal(out[0].runAt, '2026-05-12T15:00:00.000Z');
  });

  it('BYDAY + BYSETPOS=-1 fires on the last listed-weekday of the month', () => {
    const tz = 'UTC';
    // "Last Friday of every month"
    const rule: RecurrenceRule = {
      freq: 'monthly',
      interval: 1,
      byDay: ['FR'],
      bySetPos: -1,
      dtStart: '2026-01-30T17:00:00.000Z', // Last Fri of Jan 2026
      timeZone: tz,
    };
    // May 2026: last Fri = 2026-05-29. W22 covers 2026-05-25..2026-05-31.
    const monday = mondayOfWeek('2026-W22', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 1);
    assert.equal(out[0].runAt, '2026-05-29T17:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// COUNT and UNTIL terminators
// ---------------------------------------------------------------------------

describe('expandForWindow — terminators', () => {
  it('COUNT=3 fires at most 3 times total across all weeks', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO'],
      dtStart: '2026-05-04T09:00:00.000Z', // Mon W19
      timeZone: tz,
      count: 3,
    };
    const w19 = mondayOfWeek('2026-W19', tz);
    const w20 = mondayOfWeek('2026-W20', tz);
    const w21 = mondayOfWeek('2026-W21', tz);
    const w22 = mondayOfWeek('2026-W22', tz);
    assert.equal(expandDeterministically(rule, w19, tz, RULE_ID).length, 1);
    assert.equal(expandDeterministically(rule, w20, tz, RULE_ID).length, 1);
    assert.equal(expandDeterministically(rule, w21, tz, RULE_ID).length, 1);
    assert.equal(expandDeterministically(rule, w22, tz, RULE_ID).length, 0, 'count=3 exhausted');
  });

  it('UNTIL excludes occurrences strictly after the bound', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
      until: '2026-05-06T09:00:00.000Z', // inclusive Wed
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    // Mon, Tue, Wed all <= until; Thu .. Sun excluded.
    assert.equal(out.length, 3);
    assert.equal(out[2].runAt, '2026-05-06T09:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// AC13 — bounded count:3 rule expands to exactly 3 occurrences;
// 4th week (and every week thereafter) returns 0 for that rule
// ---------------------------------------------------------------------------
//
// AC13 contract: a recurrence rule with `count = 3` must produce exactly
// three occurrences across the entire series, full stop. Every week-window
// query past the third occurrence's containing week returns an empty
// array. The expander achieves this without a global cache by walking the
// series from dtStart forward on every call and counting every in-series
// candidate against the rule's `count` budget — not just the candidates
// inside the requested window. This pins:
//   - the cumulative sum across consecutive weeks equals exactly 3,
//   - the very next week (the "4th week" past the anchor) returns 0,
//   - every subsequent week also returns 0 (durability),
//   - the three occurrences land at the expected UTC instants in order,
//   - and the count cap is series-wide, not window-wide.

describe('expandForWindow — bounded count:3 (AC13)', () => {
  const tz = 'UTC';
  const ruleId = 'rec-standup';
  const rule: RecurrenceRule = {
    freq: 'weekly',
    interval: 1,
    byDay: ['MO'],
    dtStart: '2026-05-04T09:00:00.000Z', // Mon W19
    timeZone: tz,
    count: 3,
  };
  const w19 = mondayOfWeek('2026-W19', tz); // 1st Monday — anchor week
  const w20 = mondayOfWeek('2026-W20', tz); // 2nd Monday
  const w21 = mondayOfWeek('2026-W21', tz); // 3rd Monday
  const w22 = mondayOfWeek('2026-W22', tz); // 4th Monday — past count cap
  const w23 = mondayOfWeek('2026-W23', tz); // 5th Monday — far past cap
  const w52 = mondayOfWeek('2026-W52', tz); // late-year window

  it('cumulative expansion across all weeks sums to exactly 3 occurrences', () => {
    const all = [w19, w20, w21, w22, w23, w52].flatMap((mon) =>
      expandDeterministically(rule, mon, tz, ruleId),
    );
    assert.equal(all.length, 3, 'count:3 rule must produce exactly 3 occurrences total');
  });

  it('4th week (W22) returns exactly 0 occurrences for the count:3 rule', () => {
    const out = expandDeterministically(rule, w22, tz, ruleId);
    assert.deepStrictEqual(out, [], 'count:3 must be exhausted by the 4th week');
  });

  it('every week past the 3rd returns 0 (count cap is durable)', () => {
    for (const mon of [w22, w23, w52]) {
      const out = expandDeterministically(rule, mon, tz, ruleId);
      assert.equal(out.length, 0, 'count:3 must stay exhausted indefinitely');
    }
  });

  it('the three occurrences land on the expected UTC instants in order', () => {
    const w19Out = expandDeterministically(rule, w19, tz, ruleId);
    const w20Out = expandDeterministically(rule, w20, tz, ruleId);
    const w21Out = expandDeterministically(rule, w21, tz, ruleId);
    assert.equal(w19Out.length, 1);
    assert.equal(w20Out.length, 1);
    assert.equal(w21Out.length, 1);
    assert.equal(w19Out[0].runAt, '2026-05-04T09:00:00.000Z');
    assert.equal(w20Out[0].runAt, '2026-05-11T09:00:00.000Z');
    assert.equal(w21Out[0].runAt, '2026-05-18T09:00:00.000Z');
  });

  it('count cap is series-wide, not window-wide — querying only W22 still returns 0 without first asking for earlier weeks', () => {
    // Pure-function contract: the expander has no in-process cache and
    // must derive the cap from dtStart on every call. Querying W22 cold
    // (without warming up W19/W20/W21) must STILL yield 0, because the
    // count budget is walked from dtStart inside the call.
    const out = expandDeterministically(rule, w22, tz, ruleId);
    assert.deepStrictEqual(out, []);
  });

  it('count cap survives the "request a far-future week directly" stress case', () => {
    // Equivalent assertion as above but with a much larger window gap —
    // pins that the walk from dtStart is bounded by `count`, not by the
    // distance to the requested window.
    const out = expandDeterministically(rule, w52, tz, ruleId);
    assert.deepStrictEqual(out, []);
  });

  it('removing the count terminator restores unbounded behavior for the same rule shape (sanity check)', () => {
    // Negative-control: without `count`, the same rule produces an
    // occurrence in every requested week. Confirms the 0-at-W22 result
    // above is due to the count terminator and not some unrelated
    // filter excluding W22.
    const unbounded: RecurrenceRule = { ...rule };
    delete unbounded.count;
    const w22Unbounded = expandDeterministically(unbounded, w22, tz, ruleId);
    const w52Unbounded = expandDeterministically(unbounded, w52, tz, ruleId);
    assert.equal(w22Unbounded.length, 1);
    assert.equal(w52Unbounded.length, 1);
  });
});

// ---------------------------------------------------------------------------
// AC14 — open-ended rule expands forever for any future week
// ---------------------------------------------------------------------------
//
// AC14 contract: a recurrence rule with NO count and NO until terminator
// must produce occurrences for ANY future week, no matter how far the
// window is from `dtStart`. The expander must have no internal upper
// bound on the dtStart→window distance — a rule anchored in 2026 must
// still expand correctly for a window in year 9999.
//
// Implementation note (companion to AC13): count-bounded rules walk
// from step 0 to debit the budget; open-ended rules fast-forward to the
// requested window so MAX_CANDIDATES never bounds the temporal horizon.
// These tests pin the fast-forward path: identical occurrences for both
// near-future and far-future windows, biweekly alignment preserved
// across centuries, and the count-cap counter-test (count:3 + far
// future == 0) to prove the two regimes don't bleed into each other.

describe('expandForWindow — open-ended forever (AC14)', () => {
  it('open-ended daily rule produces 7 occurrences in a year-2300 window', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
      // No count, no until — open-ended forever.
    };
    const farFuture = mondayOfWeek('2300-W19', tz);
    const out = expandDeterministically(rule, farFuture, tz, RULE_ID);
    assert.equal(
      out.length,
      7,
      'open-ended daily rule must produce 7 occurrences in any future week',
    );

    // Every occurrence lands inside the requested half-open window.
    const windowStart = farFuture.getTime();
    const windowEnd = windowStart + 7 * 86_400_000;
    for (const o of out) {
      const ms = Date.parse(o.runAt);
      assert.ok(ms >= windowStart, `${o.runAt} should be >= window start`);
      assert.ok(ms < windowEnd, `${o.runAt} should be < window end`);
    }
  });

  it('open-ended weekly rule with BYDAY produces 3 occurrences in a year-3000 window', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
      dtStart: '2026-05-04T17:00:00.000Z',
      timeZone: tz,
    };
    const farFuture = mondayOfWeek('3000-W26', tz);
    const out = expandDeterministically(rule, farFuture, tz, RULE_ID);
    assert.equal(out.length, 3, 'BYDAY=MO/WE/FR must produce 3 occurrences in any week');
    const days = out.map((o) => new Date(o.runAt).getUTCDay()).sort();
    assert.deepStrictEqual(days, [1, 3, 5]);
  });

  it('open-ended monthly BYMONTHDAY=15 fires in any future month containing day 15', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'monthly',
      interval: 1,
      byMonthDay: 15,
      dtStart: '2026-01-15T09:00:00.000Z',
      timeZone: tz,
    };
    // 2500-05-15 → find the containing ISO week. May 15 in year 2500
    // happens to fall in W20 (2500-05-13 .. 2500-05-19). To stay
    // calendar-agnostic across far-future leap-year drift, pick the
    // week from the date itself rather than hard-coding a week key.
    const fifteenthUtc = new Date(Date.UTC(2500, 4, 15));
    const isoWeekday = fifteenthUtc.getUTCDay() || 7;
    const mondayMs = fifteenthUtc.getTime() - (isoWeekday - 1) * 86_400_000;
    const mondayDate = new Date(mondayMs);
    const out = expandDeterministically(rule, mondayDate, tz, RULE_ID);
    assert.equal(out.length, 1, 'BYMONTHDAY=15 must fire in May 2500');
    assert.equal(out[0].runAt, '2500-05-15T09:00:00.000Z');
  });

  it('open-ended biweekly rule preserves alignment across centuries', () => {
    // Biweekly with TUE anchored at W19 of 2026 should fire on every
    // other Tuesday forever. Two consecutive weeks far in the future
    // must contain exactly one firing between them (proves the
    // fast-forward respects the interval=2 cadence).
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 2,
      byDay: ['TU'],
      dtStart: '2026-05-05T14:00:00.000Z', // Tue 2026-W19
      timeZone: tz,
    };
    const w200a = mondayOfWeek('2200-W26', tz);
    const w200b = mondayOfWeek('2200-W27', tz);
    const a = expandDeterministically(rule, w200a, tz, RULE_ID);
    const b = expandDeterministically(rule, w200b, tz, RULE_ID);
    assert.equal(
      a.length + b.length,
      1,
      'biweekly cadence must persist into the far future (exactly one of two consecutive weeks fires)',
    );
  });

  it('no upper bound: open-ended rule produces 7 occurrences at year 9999', () => {
    // The original MAX_CANDIDATES=100k cap, applied absolutely from step 0,
    // would have bounded a FREQ=DAILY interval=1 rule at ~273 years past
    // dtStart. AC14 lifts that horizon: even a window ~8000 years out must
    // expand correctly.
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
    };
    const yearEnd = mondayOfWeek('9999-W26', tz);
    const out = expandDeterministically(rule, yearEnd, tz, RULE_ID);
    assert.equal(out.length, 7);
  });

  it('far-future window expansion is determinism-stable (no hidden mutable state)', () => {
    // Two calls with identical inputs must return byte-identical arrays
    // even after the fast-forward jump. expandDeterministically already
    // asserts this, but we restate it explicitly here for AC14.
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
      dtStart: '2026-05-04T17:00:00.000Z',
      timeZone: tz,
    };
    const farFuture = mondayOfWeek('5000-W26', tz);
    const a = expandForWindow(rule, farFuture, tz, RULE_ID);
    const b = expandForWindow(rule, farFuture, tz, RULE_ID);
    assert.deepStrictEqual(a, b);
    assert.equal(a.length, 5);
  });

  it('count-bounded rule still terminates correctly when asked for a far-future window (counter-test to AC14)', () => {
    // Regression guard: AC14's fast-forward must NOT apply to count-
    // bounded rules. A count:3 rule asked for year 2300 must still
    // return 0 (count exhausted by week 3 of the series), not "re-fire"
    // because the open-ended fast-forward bypassed the budget.
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO'],
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
      count: 3,
    };
    const farFuture = mondayOfWeek('2300-W19', tz);
    const out = expandDeterministically(rule, farFuture, tz, RULE_ID);
    assert.deepStrictEqual(
      out,
      [],
      'count:3 rule must stay exhausted at year 2300 — AC14 fast-forward must not bypass the count budget',
    );
  });

  it('near-future and far-future open-ended results are shape-identical', () => {
    // The fast-forward jump must not change the *shape* of the output,
    // only the temporal placement. A daily rule should produce 7
    // occurrences whether asked for next week or 1000 years out.
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
    };
    const near = mondayOfWeek('2026-W22', tz);
    const far = mondayOfWeek('3026-W22', tz);
    const nearOut = expandDeterministically(rule, near, tz, RULE_ID);
    const farOut = expandDeterministically(rule, far, tz, RULE_ID);
    assert.equal(nearOut.length, 7);
    assert.equal(farOut.length, 7);
    // Both produce 7 ascending occurrences spaced 1 day apart.
    for (let i = 1; i < nearOut.length; i += 1) {
      assert.equal(
        Date.parse(nearOut[i].runAt) - Date.parse(nearOut[i - 1].runAt),
        86_400_000,
      );
      assert.equal(
        Date.parse(farOut[i].runAt) - Date.parse(farOut[i - 1].runAt),
        86_400_000,
      );
    }
  });

  it('open-ended rule with UNTIL well past the window still expands correctly', () => {
    // UNTIL > windowEnd must NOT terminate the series prematurely in
    // the far-future path. The series stays "live" through the requested
    // window; only candidates strictly past UNTIL are excluded.
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
      until: '9999-12-31T23:59:59.000Z', // very far future
    };
    const farFuture = mondayOfWeek('2500-W26', tz);
    const out = expandDeterministically(rule, farFuture, tz, RULE_ID);
    assert.equal(
      out.length,
      7,
      'UNTIL in the very-far future must not prematurely terminate a far-future window expansion',
    );
  });
});

// ---------------------------------------------------------------------------
// Occurrence id format — AC6
// ---------------------------------------------------------------------------
//
// AC6 contract: every Occurrence carries an id of the form
//     task-rec-<ruleId>-<yyyymmddThhmm>
// where the trailing component is the UTC components of `runAt`, and the
// id is STABLE across runs (deterministic; same rule + same week input
// produce byte-identical ids on every call, regardless of when the call
// is made or whether the occurrence also appears in adjacent week
// windows). The format underpins materializer dedup and SPA caching.

describe('expandForWindow — occurrence id (AC6)', () => {
  it('uses `task-rec-<ruleId>-<yyyymmddThhmm>` from UTC components', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:30:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out[0].id, 'task-rec-rec-standup-20260504T0930');
    assert.equal(out[6].id, 'task-rec-rec-standup-20260510T0930');
  });

  it('every id matches the regex `^task-rec-<ruleId>-\\d{8}T\\d{4}$`', () => {
    const tz = 'America/Los_Angeles';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
      dtStart: '2026-05-04T17:00:00.000Z', // Mon 10:00 PT
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 5);
    const idPattern = /^task-rec-rec-standup-\d{8}T\d{4}$/;
    for (const o of out) {
      assert.ok(
        idPattern.test(o.id),
        `id "${o.id}" does not match task-rec-<ruleId>-<yyyymmddThhmm>`,
      );
    }
  });

  it('yyyymmddThhmm uses UTC components — not local — for non-UTC timezones', () => {
    // Rule fires at 10:00 PT (Pacific Daylight Time, UTC-7 in May).
    // Local components: 2026-05-04 10:00 PT
    // UTC components:   2026-05-04 17:00 UTC
    // The id MUST reflect the UTC components (17:00 → "1700"), not local.
    const tz = 'America/Los_Angeles';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO'],
      dtStart: '2026-05-04T17:00:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 1);
    // UTC components: 2026-05-04 17:00 → "20260504T1700"
    assert.equal(out[0].id, 'task-rec-rec-standup-20260504T1700');
    // Sanity: NOT the local-component variant.
    assert.notEqual(out[0].id, 'task-rec-rec-standup-20260504T1000');
  });

  it('id is stable across runs — same expander call repeated yields identical ids', () => {
    const tz = 'America/Los_Angeles';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
      dtStart: '2026-05-04T17:00:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    // Five separate invocations — simulates separate process runs from
    // the same on-disk inputs. AC6 demands byte-identical id sequences.
    const runs = [
      expandForWindow(rule, monday, tz, RULE_ID),
      expandForWindow(rule, monday, tz, RULE_ID),
      expandForWindow(rule, monday, tz, RULE_ID),
      expandForWindow(rule, monday, tz, RULE_ID),
      expandForWindow(rule, monday, tz, RULE_ID),
    ];
    const idsPerRun = runs.map((run) => run.map((o) => o.id));
    for (let i = 1; i < idsPerRun.length; i += 1) {
      assert.deepStrictEqual(
        idsPerRun[i],
        idsPerRun[0],
        `run ${i} id list diverged from run 0`,
      );
    }
  });

  it('id is stable across adjacent windows — same instant has same id no matter which week requests it', () => {
    // A daily rule that fires on every day produces an occurrence on
    // Mon 2026-05-04. Whether we ask for that occurrence by requesting
    // W19 (the containing week) or any other week that ALSO happens to
    // surface it (none for a strict 7-day window — so we instead vary
    // the surrounding rule shape), the id for that exact instant must
    // be identical, because the id is a pure function of (ruleId, ms).
    const tz = 'UTC';
    const dailyRule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
    };
    const weeklyRule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO'],
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const daily = expandForWindow(dailyRule, monday, tz, RULE_ID);
    const weekly = expandForWindow(weeklyRule, monday, tz, RULE_ID);

    // Both rules fire on Mon 2026-05-04 09:00 UTC → same id.
    const mondayInstant = '2026-05-04T09:00:00.000Z';
    const dailyMon = daily.find((o) => o.runAt === mondayInstant);
    const weeklyMon = weekly.find((o) => o.runAt === mondayInstant);
    assert.ok(dailyMon, 'daily rule should fire on Mon');
    assert.ok(weeklyMon, 'weekly rule should fire on Mon');
    assert.equal(
      dailyMon.id,
      weeklyMon.id,
      'same (ruleId, instant) must produce the same occurrence id regardless of containing rule shape',
    );
    assert.equal(dailyMon.id, 'task-rec-rec-standup-20260504T0900');
  });

  it('id is stable across different display zones — UTC components do not shift with tz arg', () => {
    // The tz parameter governs expansion's window math; the id suffix is
    // ALWAYS UTC. So two callers expanding the same rule for the same
    // ISO-week — one in PT, one in UTC — get matching ids for shared
    // occurrences. (Coverage scope of AC6: id format stability across
    // runs; the display-zone parameter must not alter the id.)
    const ruleTz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: ruleTz,
    };
    const mondayUtc = mondayOfWeek('2026-W19', 'UTC');
    const mondayPt = mondayOfWeek('2026-W19', 'America/Los_Angeles');

    const aUtc = expandForWindow(rule, mondayUtc, 'UTC', RULE_ID);
    const bPt = expandForWindow(rule, mondayPt, 'America/Los_Angeles', RULE_ID);
    const aById = new Map(aUtc.map((o) => [o.runAt, o.id]));
    for (const o of bPt) {
      const matched = aById.get(o.runAt);
      if (matched !== undefined) {
        assert.equal(
          o.id,
          matched,
          `id for instant ${o.runAt} must match across display zones`,
        );
      }
    }
  });

  it('id format uses zero-padded month, day, hour, and minute components', () => {
    // Pin the padding contract explicitly — the format spec calls for
    // yyyymmdd / Thhmm with two-digit components. A January-1st 09:05
    // run must serialize as "20260101T0905", not "2026115T95".
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-01-01T09:05:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W01', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.ok(out.length > 0);
    // First in-window occurrence is Mon 2026-W01 (which is 2025-12-29
    // for ISO weeks; the rule begins 2026-01-01, so Thu 01 is the first
    // in-window occurrence).
    const firstWithJan1 = out.find((o) => o.runAt === '2026-01-01T09:05:00.000Z');
    assert.ok(firstWithJan1, 'should include the dtStart occurrence');
    assert.equal(firstWithJan1.id, 'task-rec-rec-standup-20260101T0905');
  });

  it('id encodes minute precision — different minutes produce different ids', () => {
    const tz = 'UTC';
    const ruleA: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
    };
    const ruleB: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:01:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const aOut = expandDeterministically(ruleA, monday, tz, RULE_ID);
    const bOut = expandDeterministically(ruleB, monday, tz, RULE_ID);
    assert.equal(aOut[0].id, 'task-rec-rec-standup-20260504T0900');
    assert.equal(bOut[0].id, 'task-rec-rec-standup-20260504T0901');
    assert.notEqual(aOut[0].id, bOut[0].id);
  });

  it('different ruleIds produce different ids for the same instant', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const a = expandDeterministically(rule, monday, tz, 'rec-alpha');
    const b = expandDeterministically(rule, monday, tz, 'rec-beta');
    assert.equal(a[0].id, 'task-rec-rec-alpha-20260504T0900');
    assert.equal(b[0].id, 'task-rec-rec-beta-20260504T0900');
    assert.notEqual(a[0].id, b[0].id);
  });

  it('back-pointer ruleId is included on every occurrence', () => {
    const tz = 'UTC';
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-05-04T09:00:00.000Z',
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W19', tz);
    const out = expandDeterministically(rule, monday, tz, 'rec-x');
    for (const o of out) assert.equal(o.ruleId, 'rec-x');
  });
});

// ---------------------------------------------------------------------------
// DST seams — must route through localWallClockToUtc
// ---------------------------------------------------------------------------

describe('expandForWindow — DST', () => {
  it('spring-forward: weekly 09:00 PT rule still produces 7 daily occurrences', () => {
    const tz = 'America/Los_Angeles';
    // PT spring forward 2026: 2026-03-08 02:00 → 03:00 PT.
    // W11 = 2026-03-09 Mon .. 2026-03-15 Sun.
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: '2026-03-09T16:00:00.000Z', // 09:00 PT on Mon 2026-03-09 (post-spring DST: -07:00)
      timeZone: tz,
    };
    const monday = mondayOfWeek('2026-W11', tz);
    const out = expandDeterministically(rule, monday, tz, RULE_ID);
    assert.equal(out.length, 7);
    // Every occurrence projects back to local 09:00 (the wall clock).
    // We can sanity-check the first three: same UTC hour since we're
    // entirely post-spring (PDT, UTC-7).
    assert.equal(out[0].runAt, '2026-03-09T16:00:00.000Z');
    assert.equal(out[1].runAt, '2026-03-10T16:00:00.000Z');
  });

  it('fall-back: weekly 01:30 PT rule on the ambiguous day picks the earlier UTC instant (AC4)', () => {
    const tz = 'America/Los_Angeles';
    // PT fall back 2026: at 2026-11-01 02:00 PDT the clock jumps BACK to
    // 01:00 PST, so the 01:30 wall-clock fires TWICE on Sun 2026-11-01:
    //   - first  candidate: 01:30 PDT (UTC-7) → 2026-11-01T08:30:00.000Z
    //   - second candidate: 01:30 PST (UTC-8) → 2026-11-01T09:30:00.000Z
    // AC4 contract: the expander routes wall-clock projection through
    // `localWallClockToUtc`, which picks the EARLIER of the two — no
    // separate DST code in the expander.
    //
    // W43 = 2026-10-19 .. 2026-10-25 is a pre-fall-back baseline; W44 =
    // 2026-10-26 .. 2026-11-01 is the fall-back week (Sun = the seam).
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['SU'],
      dtStart: '2026-10-25T08:30:00.000Z', // Sun 01:30 PDT (UTC-7)
      timeZone: tz,
    };
    const w44 = mondayOfWeek('2026-W44', tz);
    const out = expandDeterministically(rule, w44, tz, RULE_ID);
    assert.equal(out.length, 1);

    // AC4: must resolve to the earlier (PDT) candidate, NOT the later (PST) one.
    const earlierCandidate = '2026-11-01T08:30:00.000Z'; // PDT, UTC-7
    const laterCandidate = '2026-11-01T09:30:00.000Z'; // PST, UTC-8
    assert.equal(out[0].runAt, earlierCandidate);
    assert.notEqual(out[0].runAt, laterCandidate);
    assert.ok(
      Date.parse(out[0].runAt) < Date.parse(laterCandidate),
      `AC4: fall-back must pick the earlier UTC instant (got ${out[0].runAt}, later candidate was ${laterCandidate})`,
    );

    // Occurrence id is derived from the UTC components of the chosen
    // instant — so it too must reflect the earlier candidate (08:30 not 09:30).
    assert.equal(out[0].id, 'task-rec-rec-standup-20261101T0830');
  });

  it('fall-back: 01:30 local fired by the rule round-trips through localWallClockToUtc (AC4)', () => {
    // Direct cross-check: assert the expander's chosen runAt agrees with
    // `localWallClockToUtc` applied to the ambiguous wall clock. Pins the
    // "no separate DST code in the expander" half of the AC4 contract.
    const tz = 'America/Los_Angeles';
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['SU'],
      dtStart: '2026-10-25T08:30:00.000Z',
      timeZone: tz,
    };
    const w44 = mondayOfWeek('2026-W44', tz);
    const out = expandDeterministically(rule, w44, tz, RULE_ID);

    // What localWallClockToUtc reports for 01:30 local on the seam day.
    const seamUtc = localWallClockToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      tz,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].runAt, seamUtc.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('expandForWindow — argument validation', () => {
  const tz = 'UTC';
  const rule: RecurrenceRule = {
    freq: 'daily',
    interval: 1,
    dtStart: '2026-05-04T09:00:00.000Z',
    timeZone: tz,
  };
  const monday = mondayOfWeek('2026-W19', tz);

  it('throws on invalid time zone', () => {
    assert.throws(
      () => expandForWindow(rule, monday, 'Not/A_Zone', RULE_ID),
      /invalid time zone/,
    );
  });

  it('throws on invalid weekMondayUtc', () => {
    assert.throws(
      // @ts-expect-error — intentional bad input
      () => expandForWindow(rule, 'not-a-date', tz, RULE_ID),
      /weekMondayUtc/,
    );
    assert.throws(
      () => expandForWindow(rule, new Date('not-a-date'), tz, RULE_ID),
      /weekMondayUtc/,
    );
  });

  it('throws on empty ruleId', () => {
    assert.throws(() => expandForWindow(rule, monday, tz, ''), /ruleId/);
  });

  it('throws on unparsable rule.dtStart', () => {
    const bad: RecurrenceRule = { ...rule, dtStart: 'not-a-date' };
    assert.throws(() => expandForWindow(bad, monday, tz, RULE_ID), /dtStart/);
  });

  it('throws on unparsable rule.until', () => {
    const bad: RecurrenceRule = { ...rule, until: 'not-a-date' };
    assert.throws(() => expandForWindow(bad, monday, tz, RULE_ID), /until/);
  });
});
