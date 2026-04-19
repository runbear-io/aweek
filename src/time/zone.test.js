/**
 * Tests for the time-zone utility. Covers:
 *   - isValidTimeZone
 *   - localParts basic projection
 *   - currentWeekKey across TZ boundaries (same instant, different week)
 *   - mondayOfWeek against known ISO weeks + TZ
 *   - localWallClockToUtc in DST seam weeks (spring forward / fall back)
 *   - localDayOffset handles DST-day lengths correctly
 *   - localHour agrees with localParts
 *   - parseLocalWallClock parses the permissive formats we accept
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TZ,
  currentWeekKey,
  detectSystemTimeZone,
  isValidTimeZone,
  localDayOffset,
  localHour,
  localParts,
  localWallClockToUtc,
  mondayOfWeek,
  parseLocalWallClock,
} from './zone.js';

// -----------------------------------------------------------------------------
// isValidTimeZone
// -----------------------------------------------------------------------------

describe('isValidTimeZone', () => {
  it('accepts canonical IANA names', () => {
    assert.equal(isValidTimeZone('America/Los_Angeles'), true);
    assert.equal(isValidTimeZone('Europe/Berlin'), true);
    assert.equal(isValidTimeZone('Asia/Seoul'), true);
    assert.equal(isValidTimeZone('UTC'), true);
  });

  it('rejects garbage', () => {
    assert.equal(isValidTimeZone('Not/A_Zone'), false);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone(null), false);
    assert.equal(isValidTimeZone(undefined), false);
    assert.equal(isValidTimeZone(42), false);
  });
});

// -----------------------------------------------------------------------------
// detectSystemTimeZone / DEFAULT_TZ
// -----------------------------------------------------------------------------

describe('detectSystemTimeZone', () => {
  it('returns a valid IANA zone', () => {
    const tz = detectSystemTimeZone();
    assert.equal(typeof tz, 'string');
    assert.ok(isValidTimeZone(tz), `${tz} should be a valid zone`);
  });

  it('exports DEFAULT_TZ', () => {
    assert.ok(isValidTimeZone(DEFAULT_TZ));
  });
});

// -----------------------------------------------------------------------------
// localParts
// -----------------------------------------------------------------------------

describe('localParts', () => {
  it('projects 18:00 UTC as 11:00 LA during PDT (UTC-7)', () => {
    // 2026-04-20 is after DST starts in LA (March 8 spring-forward).
    const parts = localParts('2026-04-20T18:00:00Z', 'America/Los_Angeles');
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 4);
    assert.equal(parts.day, 20);
    assert.equal(parts.hour, 11);
    assert.equal(parts.minute, 0);
    assert.equal(parts.weekday, 1); // Monday
  });

  it('projects 03:00 UTC on Monday as Sunday 20:00 LA (DST offset rolls the date back)', () => {
    const parts = localParts('2026-04-20T03:00:00Z', 'America/Los_Angeles');
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 4);
    assert.equal(parts.day, 19); // Sunday
    assert.equal(parts.hour, 20);
    assert.equal(parts.weekday, 7); // Sunday in ISO
  });

  it('projects into Seoul (+09:00, no DST)', () => {
    const parts = localParts('2026-04-20T00:00:00Z', 'Asia/Seoul');
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 4);
    assert.equal(parts.day, 20);
    assert.equal(parts.hour, 9);
  });

  it('throws on an invalid zone', () => {
    assert.throws(() => localParts('2026-04-20T00:00:00Z', 'Not/Real'), /Invalid time zone/);
  });
});

// -----------------------------------------------------------------------------
// currentWeekKey
// -----------------------------------------------------------------------------

describe('currentWeekKey', () => {
  it('returns the same week for a Tuesday noon instant across US zones', () => {
    // Tue 2026-04-21 17:00 UTC = 10:00 PDT = 13:00 EDT (still Tuesday).
    const iso = '2026-04-21T17:00:00Z';
    assert.equal(currentWeekKey('America/Los_Angeles', iso), '2026-W17');
    assert.equal(currentWeekKey('America/New_York', iso), '2026-W17');
  });

  it('straddles midnight: Monday 06:00 UTC is still Sunday (W16) in LA', () => {
    const iso = '2026-04-20T06:00:00Z';
    // In LA that's Sun 2026-04-19 23:00 — week 16.
    assert.equal(currentWeekKey('America/Los_Angeles', iso), '2026-W16');
    // In UTC it's already Monday W17.
    assert.equal(currentWeekKey('UTC', iso), '2026-W17');
  });

  it('handles ISO-year rollover (Jan 1 still in previous ISO year)', () => {
    // Jan 1, 2024 (Mon) — that IS in ISO week 2024-W01. Check a known edge
    // point instead: Jan 1 2023 (Sun) belongs to 2022-W52.
    assert.equal(currentWeekKey('UTC', '2023-01-01T12:00:00Z'), '2022-W52');
  });
});

// -----------------------------------------------------------------------------
// mondayOfWeek
// -----------------------------------------------------------------------------

describe('mondayOfWeek', () => {
  it('2026-W17 Monday 00:00 LA is 07:00 UTC (PDT, UTC-7)', () => {
    const utc = mondayOfWeek('2026-W17', 'America/Los_Angeles');
    assert.equal(utc.toISOString(), '2026-04-20T07:00:00.000Z');
  });

  it('2026-W17 Monday 00:00 UTC is exactly 2026-04-20T00:00Z', () => {
    const utc = mondayOfWeek('2026-W17', 'UTC');
    assert.equal(utc.toISOString(), '2026-04-20T00:00:00.000Z');
  });

  it('2026-W17 Monday 00:00 Seoul is 15:00 UTC the Sunday before', () => {
    const utc = mondayOfWeek('2026-W17', 'Asia/Seoul');
    // Seoul is UTC+09:00 year-round. Mon 00:00 KST = Sun 15:00 UTC.
    assert.equal(utc.toISOString(), '2026-04-19T15:00:00.000Z');
  });

  it('throws on a bad week key', () => {
    assert.throws(() => mondayOfWeek('nope', 'UTC'), /Invalid ISO week key/);
  });
});

// -----------------------------------------------------------------------------
// localWallClockToUtc
// -----------------------------------------------------------------------------

describe('localWallClockToUtc', () => {
  it('maps a normal wall clock through LA in PDT', () => {
    const utc = localWallClockToUtc(
      { year: 2026, month: 4, day: 20, hour: 9, minute: 0 },
      'America/Los_Angeles',
    );
    assert.equal(utc.toISOString(), '2026-04-20T16:00:00.000Z');
  });

  it('maps midnight local → previous-day UTC in Asia/Seoul', () => {
    const utc = localWallClockToUtc(
      { year: 2026, month: 4, day: 20, hour: 0 },
      'Asia/Seoul',
    );
    assert.equal(utc.toISOString(), '2026-04-19T15:00:00.000Z');
  });

  it('spring-forward gap: 2:30 local on jump day → first valid instant after gap', () => {
    // LA spring forward 2026: 02:00 → 03:00 on Sunday 2026-03-08.
    // 02:30 LA doesn't exist — we expect the result to land on 03:00 or later
    // local time, i.e. 10:00 UTC or later.
    const utc = localWallClockToUtc(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      'America/Los_Angeles',
    );
    // After the jump, local 03:00 is 10:00Z. Our policy: return the first
    // valid moment at or after the requested wall clock. 02:30 maps to the
    // equivalent of "30 min into the skipped hour", which becomes 10:30Z.
    // Accept anything in the [10:00Z, 11:00Z) band that a sane projection
    // could produce.
    const ms = utc.getTime();
    assert.ok(
      ms >= Date.UTC(2026, 2, 8, 10, 0) && ms < Date.UTC(2026, 2, 8, 11, 0),
      `unexpected utc=${utc.toISOString()}`,
    );
  });

  it('fall-back ambiguity: 01:30 local → first (earlier) UTC occurrence', () => {
    // LA fall back 2026: 02:00 → 01:00 on Sunday 2026-11-01.
    // 01:30 LA happens twice: 08:30Z (PDT, before fall-back) and 09:30Z (PST,
    // after). We document "first occurrence".
    const utc = localWallClockToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      'America/Los_Angeles',
    );
    assert.equal(utc.toISOString(), '2026-11-01T08:30:00.000Z');
  });
});

// -----------------------------------------------------------------------------
// localDayOffset
// -----------------------------------------------------------------------------

describe('localDayOffset', () => {
  it('returns 0 for Monday local same day', () => {
    const mon = mondayOfWeek('2026-W17', 'America/Los_Angeles');
    const iso = '2026-04-20T18:00:00Z'; // 11:00 LA Monday
    assert.equal(localDayOffset(iso, mon, 'America/Los_Angeles'), 0);
  });

  it('returns 2 for Wednesday local', () => {
    const mon = mondayOfWeek('2026-W17', 'America/Los_Angeles');
    const iso = '2026-04-22T18:00:00Z'; // 11:00 LA Wednesday
    assert.equal(localDayOffset(iso, mon, 'America/Los_Angeles'), 2);
  });

  it('still returns the right day across the DST-shortened week', () => {
    // Sun 2026-03-08 is the spring-forward day in LA and belongs to
    // 2026-W10 (Mon 2026-03-02 .. Sun 2026-03-08). Expect offset 6.
    const mon = mondayOfWeek('2026-W10', 'America/Los_Angeles');
    const iso = '2026-03-08T23:00:00Z'; // 16:00 LA Sunday (after jump)
    assert.equal(localDayOffset(iso, mon, 'America/Los_Angeles'), 6);
  });
});

// -----------------------------------------------------------------------------
// localHour + parseLocalWallClock
// -----------------------------------------------------------------------------

describe('localHour', () => {
  it('matches localParts.hour', () => {
    const iso = '2026-04-20T18:30:00Z';
    assert.equal(localHour(iso, 'America/Los_Angeles'), localParts(iso, 'America/Los_Angeles').hour);
  });
});

describe('parseLocalWallClock', () => {
  it('accepts ISO form with T', () => {
    const utc = parseLocalWallClock('2026-04-20T09:00', 'America/Los_Angeles');
    assert.equal(utc.toISOString(), '2026-04-20T16:00:00.000Z');
  });

  it('accepts space-separated form', () => {
    const utc = parseLocalWallClock('2026-04-20 09:00', 'America/Los_Angeles');
    assert.equal(utc.toISOString(), '2026-04-20T16:00:00.000Z');
  });

  it('accepts seconds', () => {
    const utc = parseLocalWallClock('2026-04-20 09:15:30', 'America/Los_Angeles');
    assert.equal(utc.toISOString(), '2026-04-20T16:15:30.000Z');
  });

  it('throws on malformed input', () => {
    assert.throws(() => parseLocalWallClock('next tuesday', 'UTC'), /Unrecognized/);
  });
});
