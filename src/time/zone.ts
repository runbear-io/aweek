/**
 * Time-zone utilities for aweek.
 *
 * Design rules:
 *   - Storage stays UTC. `runAt`, `createdAt`, `periodStart`, etc. are
 *     absolute UTC ISO strings. The functions in here read those and
 *     project them into a named IANA time zone (e.g. "America/Los_Angeles")
 *     for display and for keys (ISO week, Monday boundary).
 *   - IANA zone names go through `isValidTimeZone` before use so a typo
 *     surfaces immediately.
 *   - Local-wall-clock parsing handles DST seams explicitly:
 *       spring-forward: a wall-clock instant inside the skipped hour
 *                       resolves to the first valid local time after
 *                       the gap;
 *       fall-back:      an ambiguous wall-clock instant resolves to the
 *                       FIRST occurrence (earlier UTC).
 *
 * Callers should treat these functions as the single source of truth for
 * "what week/day/hour is this in the user's zone" — do NOT reach for
 * `getUTCHours` / `getUTCDay` outside this module.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Anything we accept as a UTC instant: a `Date`, an ISO string, or a number
 * of milliseconds since the epoch. The `toMs` coercion centralises this so
 * the rest of the module can speak in raw ms.
 */
export type TimestampInput = Date | string | number;

/**
 * The output of {@link localParts}: a UTC instant projected into a named
 * IANA zone, broken into integer date/time fields. `weekday` is 1..7 with
 * Monday=1 (ISO 8601), or 0 if the underlying `Intl` formatter returned an
 * unexpected weekday string.
 */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The minimum subset of {@link LocalParts} that uniquely identifies an
 * ISO week. Exists so {@link mondayOfWeek}'s internal helper can accept a
 * subset of the full `LocalParts` shape.
 */
export interface IsoWeekInput {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

/**
 * Output of the internal ISO-week computation: the ISO year that owns
 * the given local date plus the ISO week number (1..53).
 */
export interface IsoWeekResult {
  isoYear: number;
  isoWeek: number;
}

/**
 * Wall-clock input accepted by {@link localWallClockToUtc}. `hour`,
 * `minute`, and `second` default to 0 when omitted, matching the JS
 * implementation's `wc.hour ?? 0` semantics.
 */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

// ---------------------------------------------------------------------------
// Zone detection / validation
// ---------------------------------------------------------------------------

/**
 * Detect the system IANA time zone. Used as the implicit default when the
 * user hasn't written one into `.aweek/config.json` yet.
 */
export function detectSystemTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === 'string') return tz;
  } catch {
    // fall through to the safe default
  }
  return 'UTC';
}

export const DEFAULT_TZ: string = detectSystemTimeZone();

/**
 * Return true if the given string is a recognizable IANA time-zone name.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce the input to an instant in ms since epoch.
 * Accepts: Date, ISO string, number (ms).
 */
function toMs(input: TimestampInput): number {
  if (input instanceof Date) return input.getTime();
  if (typeof input === 'number') return input;
  if (typeof input === 'string') {
    const ms = Date.parse(input);
    if (Number.isNaN(ms)) {
      throw new TypeError(`Cannot parse timestamp: ${JSON.stringify(input)}`);
    }
    return ms;
  }
  throw new TypeError(`Unsupported timestamp input: ${typeof input}`);
}

// ---------------------------------------------------------------------------
// Local projection
// ---------------------------------------------------------------------------

/**
 * Project a UTC instant into the given IANA time zone and return the
 * individual date/time fields as integers. `weekday` is 1..7 with Monday=1
 * (ISO 8601 convention).
 *
 * @param input - Any UTC instant
 * @param tz - IANA zone name
 */
export function localParts(input: TimestampInput, tz: string): LocalParts {
  if (!isValidTimeZone(tz)) {
    throw new TypeError(`Invalid time zone: ${JSON.stringify(tz)}`);
  }
  const ms = toMs(input);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = Object.fromEntries(
    fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );

  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  let hour = parseInt(parts.hour, 10);
  // Intl returns 24 for midnight in some locales; normalize to 0.
  if (hour === 24) hour = 0;

  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    weekday: weekdayMap[parts.weekday] ?? 0,
    hour,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };
}

/**
 * Compute the ISO week number for a date projected into `tz`.
 *
 * @param parts - output of {@link localParts}
 */
function isoWeekFromLocalParts({ year, month, day, weekday }: IsoWeekInput): IsoWeekResult {
  // Use UTC arithmetic on the Y/M/D triple — the zone projection is
  // already baked into the triple, so we can safely stay in UTC here.
  const dateUtc = new Date(Date.UTC(year, month - 1, day));
  // Thursday of this local week determines the ISO year.
  const thursUtc = new Date(dateUtc);
  thursUtc.setUTCDate(dateUtc.getUTCDate() + (4 - weekday));
  const isoYear = thursUtc.getUTCFullYear();
  // Jan 4th is always in ISO week 1.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // 1..7, Mon=1
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const msPerDay = 86400000;
  const isoWeek =
    Math.floor((thursUtc.getTime() - week1Monday.getTime()) / msPerDay / 7) + 1;
  return { isoYear, isoWeek };
}

/**
 * Return the current ISO-week key ("YYYY-Www") for the given zone.
 *
 * @param tz - IANA zone name
 * @param now - defaults to the current wall clock
 */
export function currentWeekKey(tz: string, now: TimestampInput = Date.now()): string {
  const parts = localParts(now, tz);
  const { isoYear, isoWeek } = isoWeekFromLocalParts(parts);
  return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
}

/**
 * Return a UTC `Date` representing the moment that is Monday 00:00 local
 * time of `weekKey` in `tz`. The result is suitable for subtracting
 * millisecond offsets against other UTC instants.
 *
 * @param weekKey - e.g. "2026-W17"
 * @param tz - IANA zone name
 */
export function mondayOfWeek(weekKey: string, tz: string): Date {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) throw new TypeError(`Invalid ISO week key: ${JSON.stringify(weekKey)}`);
  const isoYear = parseInt(m[1], 10);
  const isoWeek = parseInt(m[2], 10);

  // Start from Jan 4 in the ISO year (always in week 1), then move back
  // to that week's Monday, then forward (week-1)*7 days. This Y/M/D
  // triple is a local-wall-clock date — pass through the TZ conversion
  // to get a UTC instant.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const targetLocalMs = week1Monday.getTime() + (isoWeek - 1) * 7 * 86400000;
  const local = new Date(targetLocalMs);

  return localWallClockToUtc(
    {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    tz,
  );
}

/**
 * Return the hour-of-day (0..23) for a UTC instant projected into `tz`.
 */
export function localHour(iso: TimestampInput, tz: string): number {
  return localParts(iso, tz).hour;
}

/**
 * Return the day offset (0..6, Monday-origin) between a UTC instant and
 * the local-zone `weekMondayUtc` anchor. Returns a negative number or
 * ≥7 when the instant falls outside the anchor's week.
 *
 * @param iso - any UTC instant
 * @param weekMondayUtc - output of {@link mondayOfWeek}
 * @param tz - IANA zone name
 */
export function localDayOffset(
  iso: TimestampInput,
  weekMondayUtc: Date | number,
  tz: string,
): number {
  if (!isValidTimeZone(tz)) {
    throw new TypeError(`Invalid time zone: ${JSON.stringify(tz)}`);
  }
  const instantMs = toMs(iso);
  const anchorMs = weekMondayUtc instanceof Date ? weekMondayUtc.getTime() : weekMondayUtc;

  // Compare local-wall-clock dates, not raw ms diff — DST days are not
  // always 24h long.
  const a = localParts(instantMs, tz);
  const b = localParts(anchorMs, tz);
  // Days since epoch at midnight local — compute via UTC-of-Y/M/D trick.
  const aDay = Math.floor(Date.UTC(a.year, a.month - 1, a.day) / 86400000);
  const bDay = Math.floor(Date.UTC(b.year, b.month - 1, b.day) / 86400000);
  return aDay - bDay;
}

/**
 * Convert a local-wall-clock date + time in `tz` into the equivalent UTC
 * `Date`. DST handling:
 *   - Spring forward (non-existent local time, e.g. 02:30 on the jump
 *     day): returns the first valid UTC instant at the post-jump offset.
 *   - Fall back (ambiguous local time, e.g. 01:30 occurring twice):
 *     returns the FIRST occurrence (the one before the offset change).
 *
 * Algorithm: sample the zone offset 25 hours before and after the
 * requested wall clock (outside any single seam) to get the "pre" and
 * "post" offsets. Convert the wall clock under each offset into two
 * candidate UTC instants, then check which candidate actually projects
 * back to the requested wall clock. Both candidates match outside DST
 * seams (return either); both match for ambiguous fall-back wall clocks
 * (return the earlier one); neither matches inside a spring-forward gap
 * (return the later one so we land at-or-after the gap).
 */
export function localWallClockToUtc(wc: WallClock, tz: string): Date {
  if (!isValidTimeZone(tz)) {
    throw new TypeError(`Invalid time zone: ${JSON.stringify(tz)}`);
  }
  const { year, month, day, hour = 0, minute = 0, second = 0 } = wc;

  const wantMs = Date.UTC(year, month - 1, day, hour, minute, second);

  // offsetAt(ms): zone offset in ms (local - utc) at `ms`.
  const offsetAt = (ms: number): number => {
    const p = localParts(ms, tz);
    const localMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return localMs - ms;
  };

  const projectionMatches = (ms: number): boolean => {
    const p = localParts(ms, tz);
    return (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute &&
      p.second === second
    );
  };

  const H25 = 25 * 3600 * 1000;
  const preOffset = offsetAt(wantMs - H25);
  const postOffset = offsetAt(wantMs + H25);

  const c1 = wantMs - preOffset;
  const c2 = wantMs - postOffset;

  const m1 = projectionMatches(c1);
  const m2 = projectionMatches(c2);

  if (m1 && m2) {
    // Unambiguous (no seam) OR fall-back (wall clock occurs twice).
    // Both candidates equal outside seams; pick the earlier of the two
    // for fall-back so we return "first occurrence".
    return new Date(Math.min(c1, c2));
  }
  if (m1) return new Date(c1);
  if (m2) return new Date(c2);
  // Spring-forward gap: wall clock never exists. Return the later
  // candidate (the one using the post-jump offset) so we land at the
  // earliest valid moment past the gap.
  return new Date(Math.max(c1, c2));
}

/**
 * Parse a permissive local-time string and convert to UTC.
 * Accepts:
 *   - Full ISO "YYYY-MM-DDTHH:MM[:SS]"
 *   - "YYYY-MM-DD HH:MM"
 *   - Splits on the first space or 'T'.
 */
export function parseLocalWallClock(input: string, tz: string): Date {
  if (typeof input !== 'string') {
    throw new TypeError(`parseLocalWallClock expects a string, got ${typeof input}`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    input.trim(),
  );
  if (!m) {
    throw new TypeError(`Unrecognized local wall-clock: ${JSON.stringify(input)}`);
  }
  const [, y, mo, d, h, mi, s] = m;
  return localWallClockToUtc(
    {
      year: parseInt(y, 10),
      month: parseInt(mo, 10),
      day: parseInt(d, 10),
      hour: parseInt(h, 10),
      minute: parseInt(mi, 10),
      second: s ? parseInt(s, 10) : 0,
    },
    tz,
  );
}
