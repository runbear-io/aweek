/**
 * AC3 — Spring-forward DST week.
 *
 * Acceptance criterion under test:
 *
 *   "Spring-forward DST week: 09:00 local on transition day resolves via
 *    `localWallClockToUtc` to the first valid instant after the gap."
 *
 * The expander itself does NOT contain any DST code — it must route every
 * wall-clock → UTC projection through `localWallClockToUtc` from
 * `src/time/zone.ts`. The constraint section of the seed is explicit:
 *
 *   "DST seams handled via existing localWallClockToUtc — no new DST code."
 *
 * Why this test lives in its own file:
 *
 *   The general expander suite at `recurrence-expander.test.ts` already
 *   covers a generic spring-forward smoke test (W11 — the week AFTER the
 *   transition). AC3 wants the focused case in the transition WEEK itself
 *   (W10 — which contains spring-forward Sunday 2026-03-08). The sibling
 *   AC4 task is editing the same `recurrence-expander.test.ts` file for
 *   fall-back coverage, so we isolate AC3 here to avoid merge conflicts
 *   while the parallel run is in flight.
 *
 * What is asserted:
 *
 *   1. A 09:00-local daily rule in W10 2026 produces exactly 7 occurrences
 *      (one per day) — the spring-forward day does NOT drop an occurrence.
 *   2. The Mon–Sat occurrences project under PST (UTC-8) → 17:00 UTC.
 *   3. The Sunday (transition day, 2026-03-08) occurrence projects under
 *      PDT (UTC-7) → 16:00 UTC. This is the "post-gap" half of the seam:
 *      the 09:00 wall clock lives unambiguously past the 02:00→03:00 jump,
 *      and the offset must flip accordingly. If the expander were doing
 *      its own DST math (or skipping `localWallClockToUtc`), it would
 *      either drop the Sunday occurrence or place it at 17:00Z under the
 *      old PST offset.
 *   4. A wall clock INSIDE the gap (02:30 PT on the transition day) resolves
 *      through the expander to the SAME UTC instant `localWallClockToUtc`
 *      returns directly — i.e. the first valid moment past the gap, which
 *      lands at-or-after local 03:00 PDT (≥ 10:00 UTC on transition day).
 *      This pins the routing contract: the expander's projection helper
 *      MUST delegate to `localWallClockToUtc`, not re-implement the DST
 *      handling.
 *   5. Determinism — every assertion runs the expander twice and
 *      `deepStrictEqual`s the two arrays (matches the AC2 contract).
 *
 * Reference dates (Pacific Time, IANA "America/Los_Angeles"):
 *   - Spring forward 2026: 2026-03-08 (Sunday) — 02:00 PST → 03:00 PDT.
 *   - W10 2026 = Mon 2026-03-02 .. Sun 2026-03-08 (contains the transition).
 *   - W11 2026 = Mon 2026-03-09 .. Sun 2026-03-15 (fully post-transition).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expandForWindow } from './recurrence-expander.js';
import { localWallClockToUtc, mondayOfWeek } from '../time/zone.js';
import type { RecurrenceRule } from '../storage/recurring-task-store.js';

const TZ = 'America/Los_Angeles';
const RULE_ID = 'rec-springforward';

/**
 * Re-run the expander once and assert the two outputs are byte-identical.
 * Returns the first call's result for further assertions.
 */
function expandTwice(
  rule: RecurrenceRule,
  weekMondayUtc: Date,
  tz: string,
  ruleId: string,
): ReturnType<typeof expandForWindow> {
  const a = expandForWindow(rule, weekMondayUtc, tz, ruleId);
  const b = expandForWindow(rule, weekMondayUtc, tz, ruleId);
  assert.deepStrictEqual(a, b, 'expandForWindow must be deterministic across calls');
  return a;
}

describe('expandForWindow — spring-forward DST week (AC3)', () => {
  it('produces 7 occurrences in W10 2026 with the transition Sunday at PDT offset', () => {
    // 09:00 PT on Mon 2026-03-02. That Monday is still PST (UTC-8) since
    // spring-forward doesn't happen until Sunday 2026-03-08. So 09:00 PST
    // == 17:00 UTC.
    const dtStartMs = localWallClockToUtc(
      { year: 2026, month: 3, day: 2, hour: 9, minute: 0, second: 0 },
      TZ,
    ).getTime();
    assert.equal(
      new Date(dtStartMs).toISOString(),
      '2026-03-02T17:00:00.000Z',
      'sanity: 09:00 PST on Mon 2026-03-02 is 17:00 UTC',
    );

    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtStart: new Date(dtStartMs).toISOString(),
      timeZone: TZ,
    };
    const monday = mondayOfWeek('2026-W10', TZ);

    const out = expandTwice(rule, monday, TZ, RULE_ID);

    // Exactly 7 — the spring-forward day must NOT drop or duplicate an
    // occurrence.
    assert.equal(out.length, 7, 'spring-forward week must still expand to 7 daily occurrences');

    // Mon–Sat: PST (UTC-8), so 09:00 local = 17:00 UTC.
    assert.equal(out[0].runAt, '2026-03-02T17:00:00.000Z', 'Mon 09:00 PST → 17:00Z');
    assert.equal(out[1].runAt, '2026-03-03T17:00:00.000Z', 'Tue 09:00 PST → 17:00Z');
    assert.equal(out[2].runAt, '2026-03-04T17:00:00.000Z', 'Wed 09:00 PST → 17:00Z');
    assert.equal(out[3].runAt, '2026-03-05T17:00:00.000Z', 'Thu 09:00 PST → 17:00Z');
    assert.equal(out[4].runAt, '2026-03-06T17:00:00.000Z', 'Fri 09:00 PST → 17:00Z');
    assert.equal(out[5].runAt, '2026-03-07T17:00:00.000Z', 'Sat 09:00 PST → 17:00Z');

    // Sun 2026-03-08 is the spring-forward day. 09:00 PDT (post-jump,
    // UTC-7) → 16:00 UTC, NOT 17:00 UTC. This is the AC3 core assertion:
    // the wall-clock 09:00 on the transition day routes through
    // `localWallClockToUtc`, which produces the correct post-gap UTC
    // instant.
    assert.equal(
      out[6].runAt,
      '2026-03-08T16:00:00.000Z',
      'Sun 09:00 PDT → 16:00Z (post-gap, AC3 core)',
    );
  });

  it('matches localWallClockToUtc directly for 09:00 PT on the transition day', () => {
    // The expander's per-occurrence projection MUST match what
    // `localWallClockToUtc` returns for the same wall clock. This pins
    // the "no new DST code" constraint: any time the expander projects a
    // wall clock to UTC it does so via `localWallClockToUtc`, so a side-
    // by-side equality is the routing receipt.
    const sunday0900PtUtc = localWallClockToUtc(
      { year: 2026, month: 3, day: 8, hour: 9, minute: 0, second: 0 },
      TZ,
    );

    // Drive the expander toward the same wall clock via a weekly rule
    // anchored on Sunday at 09:00 PT.
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['SU'],
      dtStart: sunday0900PtUtc.toISOString(),
      timeZone: TZ,
    };
    const monday = mondayOfWeek('2026-W10', TZ);

    const out = expandTwice(rule, monday, TZ, RULE_ID);
    assert.equal(out.length, 1);
    assert.equal(
      out[0].runAt,
      sunday0900PtUtc.toISOString(),
      'expander projection of Sun 09:00 PT MUST equal localWallClockToUtc',
    );
    assert.equal(
      out[0].runAt,
      '2026-03-08T16:00:00.000Z',
      'and that UTC instant is 16:00Z (PDT, post-gap)',
    );
  });

  it('routes an in-gap wall clock (02:30 PT) through localWallClockToUtc — first valid instant after the gap', () => {
    // 02:30 PT on the spring-forward Sunday doesn't exist locally — it's
    // inside the 02:00 → 03:00 jump. `localWallClockToUtc` resolves this
    // to the FIRST valid instant after the gap (the contract documented
    // in `src/time/zone.ts`). The expander has no business doing its own
    // DST math; it must delegate. We assert two things:
    //
    //   1. The expander emits an occurrence (i.e. doesn't silently drop
    //      a wall clock that resolves out-of-window-day).
    //   2. The UTC instant matches `localWallClockToUtc` directly AND
    //      sits at-or-after local 03:00 PDT (≥ 10:00Z on 2026-03-08).
    //
    // This is the strict "first valid instant after the gap" check the
    // AC3 wording calls out.
    const inGapUtc = localWallClockToUtc(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      TZ,
    );
    // Routing receipt: the helper picks a UTC instant that, projected
    // back, lands at or after the post-gap moment (local 03:00 PDT =
    // 10:00 UTC on 2026-03-08).
    const postGapFloorMs = Date.UTC(2026, 2, 8, 10, 0, 0); // 10:00Z
    assert.ok(
      inGapUtc.getTime() >= postGapFloorMs,
      `localWallClockToUtc(02:30 PT) must land at-or-after 10:00Z; got ${inGapUtc.toISOString()}`,
    );

    // Build a weekly Sunday rule anchored at the in-gap wall clock so we
    // exercise the expander's projectToUtc helper on the gap input.
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['SU'],
      dtStart: inGapUtc.toISOString(),
      timeZone: TZ,
    };
    const monday = mondayOfWeek('2026-W10', TZ);
    const out = expandTwice(rule, monday, TZ, RULE_ID);

    assert.equal(out.length, 1, 'expander must emit one Sunday occurrence');
    assert.equal(
      out[0].runAt,
      inGapUtc.toISOString(),
      'expander projection of 02:30-PT-in-gap MUST equal localWallClockToUtc (routing receipt)',
    );
    assert.ok(
      Date.parse(out[0].runAt) >= postGapFloorMs,
      'first valid instant after the gap: occurrence must be ≥ 10:00Z on 2026-03-08',
    );
  });

  it('a weekly rule firing on W10 + W11 sees the offset flip cleanly across the seam', () => {
    // Anchor on Tue 2026-03-03 at 09:00 PT (PST, UTC-8) → 17:00 UTC.
    // The rule fires every Tuesday at 09:00 local. Tue 2026-03-03 is
    // pre-jump (PST → 17:00Z). Tue 2026-03-10 is post-jump (PDT → 16:00Z).
    // Both weeks must produce exactly one occurrence each, and the UTC
    // instants must differ by 7d − 1h (the "DST-shortened week").
    const dtStart = localWallClockToUtc(
      { year: 2026, month: 3, day: 3, hour: 9, minute: 0, second: 0 },
      TZ,
    ).toISOString();
    assert.equal(dtStart, '2026-03-03T17:00:00.000Z');

    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['TU'],
      dtStart,
      timeZone: TZ,
    };

    const w10 = expandTwice(rule, mondayOfWeek('2026-W10', TZ), TZ, RULE_ID);
    const w11 = expandTwice(rule, mondayOfWeek('2026-W11', TZ), TZ, RULE_ID);

    assert.equal(w10.length, 1);
    assert.equal(w10[0].runAt, '2026-03-03T17:00:00.000Z', 'Tue pre-jump: 09:00 PST = 17:00Z');

    assert.equal(w11.length, 1);
    assert.equal(w11[0].runAt, '2026-03-10T16:00:00.000Z', 'Tue post-jump: 09:00 PDT = 16:00Z');

    // The post-jump Tuesday is exactly (7d − 1h) after the pre-jump one
    // because that week lost an hour to spring forward.
    const sevenDaysMinusOneHourMs = 7 * 86_400_000 - 3_600_000;
    assert.equal(
      Date.parse(w11[0].runAt) - Date.parse(w10[0].runAt),
      sevenDaysMinusOneHourMs,
      'spring-forward week is 1h shorter in UTC: w11 − w10 == 7d − 1h',
    );
  });
});
