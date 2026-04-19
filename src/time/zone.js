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

/**
 * Detect the system IANA time zone. Used as the implicit default when the
 * user hasn't written one into `.aweek/config.json` yet.
 * @returns {string}
 */
export function detectSystemTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === 'string') return tz;
  } catch {}
  return 'UTC';
}

export const DEFAULT_TZ = detectSystemTimeZone();

/**
 * Return true if the given string is a recognizable IANA time-zone name.
 * @param {unknown} tz
 * @returns {boolean}
 */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Coerce the input to an instant in ms since epoch.
 * Accepts: Date, ISO string, number (ms).
 * @param {Date|string|number} input
 * @returns {number}
 */
function toMs(input) {
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

/**
 * Project a UTC instant into the given IANA time zone and return the
 * individual date/time fields as integers. `weekday` is 1..7 with Monday=1
 * (ISO 8601 convention).
 *
 * @param {Date|string|number} input - Any UTC instant
 * @param {string} tz - IANA zone name
 * @returns {{year:number, month:number, day:number, weekday:number, hour:number, minute:number, second:number}}
 */
export function localParts(input, tz) {
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
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );

  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

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
 * @param {{year:number, month:number, day:number, weekday:number}} parts - output of localParts
 * @returns {{isoYear:number, isoWeek:number}}
 */
function isoWeekFromLocalParts({ year, month, day, weekday }) {
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
 * @param {string} tz
 * @param {Date|string|number} [now] - defaults to the current wall clock
 * @returns {string}
 */
export function currentWeekKey(tz, now = Date.now()) {
  const parts = localParts(now, tz);
  const { isoYear, isoWeek } = isoWeekFromLocalParts(parts);
  return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
}

/**
 * Return a UTC `Date` representing the moment that is Monday 00:00 local
 * time of `weekKey` in `tz`. The result is suitable for subtracting
 * millisecond offsets against other UTC instants.
 *
 * @param {string} weekKey - e.g. "2026-W17"
 * @param {string} tz
 * @returns {Date}
 */
export function mondayOfWeek(weekKey, tz) {
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
 * @param {Date|string|number} iso
 * @param {string} tz
 * @returns {number}
 */
export function localHour(iso, tz) {
  return localParts(iso, tz).hour;
}

/**
 * Return the day offset (0..6, Monday-origin) between a UTC instant and
 * the local-zone `weekMondayUtc` anchor. Returns a negative number or
 * ≥7 when the instant falls outside the anchor's week.
 *
 * @param {Date|string|number} iso
 * @param {Date|number} weekMondayUtc - output of `mondayOfWeek`
 * @param {string} tz
 * @returns {number}
 */
export function localDayOffset(iso, weekMondayUtc, tz) {
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
 *
 * @param {{year:number, month:number, day:number, hour?:number, minute?:number, second?:number}} wc
 * @param {string} tz
 * @returns {Date}
 */
export function localWallClockToUtc(wc, tz) {
  if (!isValidTimeZone(tz)) {
    throw new TypeError(`Invalid time zone: ${JSON.stringify(tz)}`);
  }
  const { year, month, day, hour = 0, minute = 0, second = 0 } = wc;

  const wantMs = Date.UTC(year, month - 1, day, hour, minute, second);

  // offsetAt(ms): zone offset in ms (local - utc) at `ms`.
  const offsetAt = (ms) => {
    const p = localParts(ms, tz);
    const localMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return localMs - ms;
  };

  const projectionMatches = (ms) => {
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
 *
 * @param {string} input
 * @param {string} tz
 * @returns {Date}
 */
export function parseLocalWallClock(input, tz) {
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
