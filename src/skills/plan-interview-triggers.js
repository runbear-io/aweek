/**
 * Interview-trigger detection for /aweek:plan.
 *
 * When /aweek:plan builds a new weekly plan it runs these four checks in
 * parallel before deciding whether to proceed autonomously or to route into
 * a Socratic interview. Any trigger that fires returns a **reason object**;
 * a non-empty array of reasons causes the plan skill to interview the user
 * instead of generating autonomously.
 *
 * Trigger IDs (kebab-case):
 *   'first-ever-plan'            — no weekly plans have ever been generated
 *   'conflicting-or-vague-goals' — plan.md goals are empty, placeholder-only, or contradictory
 *   'prior-week-problems'        — prior week had a notable number of failed activities
 *   'deadline-approaching'       — a monthly end-date or explicit date is within the lookahead window
 *
 * Reason object shape (every trigger returns this shape or null):
 *   {
 *     trigger:  string,  // one of the four IDs above
 *     reason:   string,  // one-sentence human-readable explanation
 *     details:  object,  // trigger-specific context consumed by the interview prompt
 *   }
 *
 * Design principles:
 *   - No schema changes. Uses existing WeeklyPlanStore, ActivityLogStore,
 *     and plan-markdown-store surfaces only.
 *   - Store instances are created internally; callers just pass dataDir.
 *   - Never throw for expected missing-data conditions — return null instead
 *     so a missing plan.md or missing activity log is handled gracefully.
 *   - Pure helper functions (previousWeekKey, extractSubstantiveLines, …)
 *     are exported for testability.
 *   - All four triggers are run concurrently via checkInterviewTriggers.
 */

import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { readPlan, parsePlanMarkdownSections } from '../storage/plan-markdown-store.js';
import { currentWeekKey } from '../time/zone.js';

// ---------------------------------------------------------------------------
// Exported constants (consumed by callers for documentation / tests)
// ---------------------------------------------------------------------------

/** Absolute failure count that always fires trigger 3, regardless of rate. */
export const PRIOR_WEEK_ABSOLUTE_FAILURE_THRESHOLD = 3;

/**
 * Failure-rate threshold (0–1) that fires trigger 3 when the sample size
 * is large enough (≥ MIN_ACTIVITIES_FOR_RATE_TRIGGER activities).
 */
export const PRIOR_WEEK_FAILURE_RATE_THRESHOLD = 0.25;

/**
 * Minimum number of activity log + weekly-plan entries required before
 * the rate threshold fires. Below this sample size only the absolute
 * threshold applies, to avoid noise from very short weeks.
 */
export const PRIOR_WEEK_MIN_ACTIVITIES = 4;

/** Default lookahead window in calendar days for trigger 4. */
export const DEFAULT_DEADLINE_LOOKAHEAD_DAYS = 14;

// ---------------------------------------------------------------------------
// Week-key arithmetic helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Return the number of ISO weeks in `year` (52 or 53).
 *
 * A year has 53 ISO weeks if its last Thursday falls in week 53 — which
 * happens when Dec 31 is a Thursday, or when the year is a leap year and
 * Dec 31 is a Wednesday. The equivalent algebraic test used here is the
 * Doomsday-style formula: p(y) ≡ (y + ⌊y/4⌋ − ⌊y/100⌋ + ⌊y/400⌋) mod 7.
 * A year has 53 weeks iff p(y) === 4 (Dec 31 is Thursday) OR p(y−1) === 3
 * (Dec 31 of the preceding year was Wednesday, making Jan 1 Thursday).
 *
 * @param {number} year - Four-digit Gregorian year
 * @returns {52 | 53}
 */
export function isoWeeksInYear(year) {
  const p = (y) =>
    (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)) % 7;
  return p(year) === 4 || p(year - 1) === 3 ? 53 : 52;
}

/**
 * Return the ISO-week key for the week immediately before `weekKey`.
 * Handles year-boundary roll-over by computing the ISO week count of the
 * prior year via {@link isoWeeksInYear}.
 *
 * @param {string} weekKey - "YYYY-Www" (e.g. "2026-W01")
 * @returns {string} - e.g. "2025-W52"
 * @throws {TypeError} On malformed input
 */
export function previousWeekKey(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) throw new TypeError(`Invalid ISO week key: ${JSON.stringify(weekKey)}`);
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);

  if (week > 1) {
    return `${year}-W${String(week - 1).padStart(2, '0')}`;
  }

  // Week 1 → last week (52 or 53) of the previous year.
  const lastWeek = isoWeeksInYear(year - 1);
  return `${year - 1}-W${String(lastWeek).padStart(2, '0')}`;
}

/**
 * Compute the Monday "YYYY-MM-DD" string for the given ISO week key.
 *
 * Algorithm: Jan 4 is always in ISO week 1. Locate that week's Monday,
 * then advance (week − 1) × 7 days to reach the target Monday. All
 * arithmetic stays in UTC so the result is timezone-agnostic.
 *
 * @param {string} weekKey - "YYYY-Www"
 * @returns {string} - "YYYY-MM-DD" in UTC
 * @throws {TypeError} On malformed input
 */
export function mondayStringForWeek(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) throw new TypeError(`Invalid ISO week key: ${JSON.stringify(weekKey)}`);
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // 1=Mon … 7=Sun (ISO convention)
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));

  const targetMonday = new Date(week1Monday);
  targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

  return targetMonday.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Plan-markdown analysis helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Extract substantive lines from a section body returned by
 * {@link parsePlanMarkdownSections}.
 *
 * "Substantive" means not blank, not an HTML comment placeholder
 * (`<!-- … -->`), and not a bare sub-heading (`### …`). List markers
 * (`-`, `*`, `N.`) are stripped so callers receive the goal text only.
 *
 * @param {string} body - Raw section body from parsePlanMarkdownSections
 * @returns {string[]} Cleaned, non-empty lines
 */
export function extractSubstantiveLines(body) {
  if (typeof body !== 'string') return [];
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (/^<!--/.test(line)) return false; // HTML placeholder comment
      if (/^#{1,6}\s/.test(line)) return false; // sub-heading line
      return true;
    })
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter((line) => line.length > 0);
}

// Action-verb sets for lightweight conflict detection.
// A pair of goals is "potentially conflicting" when one line contains a
// GROWTH_VERB and the other contains a SHRINK_VERB AND they share at least
// one significant noun (≥ 4 chars, not a stopword).
const GROWTH_VERBS = new Set([
  'increase', 'grow', 'expand', 'scale', 'build', 'add', 'more', 'raise',
  'boost', 'accelerate', 'double', 'maximize',
]);
const SHRINK_VERBS = new Set([
  'decrease', 'reduce', 'cut', 'shrink', 'remove', 'drop', 'lower', 'stop',
  'less', 'minimize', 'eliminate', 'halve',
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'be', 'this', 'that',
  'it', 'its', 'my', 'our', 'we', 'you', 'he', 'she', 'they',
  'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
  'not', 'do', 'so', 'if', 'as', 'up', 'all', 'each', 'get', 'make',
]);

/**
 * Extract significant tokens (non-stopword words ≥ 4 chars) from a line.
 * Used for noun-overlap detection in the conflict heuristic.
 *
 * @param {string} line
 * @returns {Set<string>}
 */
function significantTokens(line) {
  const words = line
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Return true when `lineA` and `lineB` appear to contradict each other:
 * one line contains a growth verb, the other a shrink verb, and they
 * share at least one significant noun (same topic, opposite direction).
 *
 * This is a lightweight syntactic heuristic, not semantic analysis. False
 * positives on very different topics are guarded by the noun-overlap check.
 *
 * @param {string} lineA
 * @param {string} lineB
 * @returns {boolean}
 */
export function goalLinesAppearConflicting(lineA, lineB) {
  const wordsA = new Set(lineA.toLowerCase().split(/\s+/));
  const wordsB = new Set(lineB.toLowerCase().split(/\s+/));

  const aGrowth = [...wordsA].some((w) => GROWTH_VERBS.has(w));
  const aShrink = [...wordsA].some((w) => SHRINK_VERBS.has(w));
  const bGrowth = [...wordsB].some((w) => GROWTH_VERBS.has(w));
  const bShrink = [...wordsB].some((w) => SHRINK_VERBS.has(w));

  // One line purely growth, the other purely shrink.
  const opposingDirections =
    (aGrowth && !aShrink && bShrink && !bGrowth) ||
    (aShrink && !aGrowth && bGrowth && !bShrink);

  if (!opposingDirections) return false;

  // Require at least one shared significant token to confirm same topic.
  const tA = significantTokens(lineA);
  const tB = significantTokens(lineB);
  return [...tA].some((t) => tB.has(t));
}

/**
 * Parse explicit date mentions from free-form text.
 * Recognizes patterns:
 *   - "by YYYY-MM-DD"
 *   - "due YYYY-MM-DD"
 *   - "deadline: YYYY-MM-DD"
 *   - Bare ISO dates ("YYYY-MM-DD") preceded by a word boundary
 *
 * @param {string} text
 * @returns {Array<{date: Date, label: string, snippet: string}>}
 */
export function parseDateMentions(text) {
  if (typeof text !== 'string') return [];

  const results = [];
  // Capture either an explicit keyword ("by", "due", "deadline :") or a
  // bare ISO date standing alone at a word boundary.
  const re =
    /(?:(?:by|due|deadline\s*:?\s+)\s*)(\d{4}-\d{2}-\d{2})|\b(\d{4}-\d{2}-\d{2})\b/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const dateStr = match[1] ?? match[2];
    const d = new Date(`${dateStr}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      results.push({
        date: d,
        label: dateStr,
        snippet: match[0].trim(),
      });
    }
  }
  return results;
}

/**
 * Return the last calendar day (UTC midnight) of a "YYYY-MM" string.
 *
 * @param {string} month - e.g. "2026-04"
 * @returns {Date | null} null on malformed input
 */
export function lastDayOfMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10); // 1-indexed
  // Date.UTC(year, mo, 0) === day 0 of month `mo+1` === last day of month `mo`.
  return new Date(Date.UTC(year, mo, 0));
}

// ---------------------------------------------------------------------------
// Trigger 1: first-ever plan
// ---------------------------------------------------------------------------

/**
 * Check whether this agent has never had a weekly plan generated.
 *
 * This is the lowest-cost trigger. It fires on the very first call to
 * /aweek:plan for a brand-new agent and signals the interview gate to
 * establish basic planning context before any tasks are created.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.dataDir - `.aweek/agents` root
 * @returns {Promise<{trigger: string, reason: string, details: object} | null>}
 */
export async function isFirstEverPlan({ agentId, dataDir }) {
  if (!agentId) throw new TypeError('agentId is required');
  if (!dataDir) throw new TypeError('dataDir is required');

  const store = new WeeklyPlanStore(dataDir);
  let weeks;
  try {
    weeks = await store.list(agentId);
  } catch {
    // Plans directory not yet created — definitely the first plan.
    weeks = [];
  }

  if (weeks.length === 0) {
    return {
      trigger: 'first-ever-plan',
      reason:
        'This agent has never had a weekly plan generated. An interview ensures the first plan maps to real priorities rather than relying on placeholder goals.',
      details: { agentId, priorWeekCount: 0 },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Trigger 2: conflicting or vague goals
// ---------------------------------------------------------------------------

/** Minimum character length for a goal line to be considered substantive. */
const MIN_GOAL_LINE_CHARS = 10;

/**
 * Scan an agent's plan.md for vague or conflicting goals.
 *
 * **Vague** is flagged when:
 *   - plan.md does not exist.
 *   - The `Long-term goals` section is absent, empty, or contains only
 *     HTML placeholder comments with no substantive text.
 *   - The `Monthly plans` section has no `### YYYY-MM` subsection headings
 *     (no concrete monthly objectives to derive weekly tasks from).
 *
 * **Conflicting** is flagged when two or more goal lines contain opposing
 * direction verbs (e.g. "increase revenue" vs "reduce revenue") AND share
 * at least one significant noun token — indicating the same topic is being
 * pushed in contradictory directions.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.agentsDir - `.aweek/agents` root (same as dataDir)
 * @returns {Promise<{trigger: string, reason: string, details: object} | null>}
 */
export async function detectVagueOrConflictingGoals({ agentId, agentsDir }) {
  if (!agentId) throw new TypeError('agentId is required');
  if (!agentsDir) throw new TypeError('agentsDir is required');

  // --- Load plan.md ---
  let body;
  try {
    body = await readPlan(agentsDir, agentId);
  } catch {
    body = null;
  }

  if (!body) {
    return {
      trigger: 'conflicting-or-vague-goals',
      reason:
        'The agent has no plan.md yet. An interview is needed to establish long-term goals and monthly plans before a meaningful weekly schedule can be generated.',
      details: {
        agentId,
        vague: true,
        vagueReason: 'plan.md is absent',
      },
    };
  }

  const parsed = parsePlanMarkdownSections(body);

  // --- Check Long-term goals section ---
  const goalsBody = parsed.byTitle['Long-term goals'] ?? '';
  const goalLines = extractSubstantiveLines(goalsBody);
  const substantiveGoalLines = goalLines.filter((l) => l.length >= MIN_GOAL_LINE_CHARS);

  if (substantiveGoalLines.length === 0) {
    return {
      trigger: 'conflicting-or-vague-goals',
      reason:
        'The Long-term goals section in plan.md appears empty or contains only placeholder text. Clarifying concrete goals will make the generated weekly plan meaningfully goal-aligned.',
      details: {
        agentId,
        vague: true,
        vagueReason: 'Long-term goals section is empty or placeholder-only',
        goalLineCount: goalLines.length,
        substantiveGoalLineCount: 0,
      },
    };
  }

  // --- Check Monthly plans section (required for weekly task generation) ---
  const monthlyBody = parsed.byTitle['Monthly plans'] ?? '';
  const hasMonthlyPlanSections = /^###\s+\d{4}-\d{2}\b/m.test(monthlyBody);

  if (!hasMonthlyPlanSections) {
    return {
      trigger: 'conflicting-or-vague-goals',
      reason:
        'The Monthly plans section in plan.md has no `### YYYY-MM` subsections. Without monthly objectives the weekly plan generator cannot produce meaningful task breakdowns.',
      details: {
        agentId,
        vague: true,
        vagueReason: 'Monthly plans section has no YYYY-MM subsections',
        substantiveGoalLineCount: substantiveGoalLines.length,
      },
    };
  }

  // --- Check for conflicting goals ---
  const conflictingPairs = [];
  for (let i = 0; i < substantiveGoalLines.length; i++) {
    for (let j = i + 1; j < substantiveGoalLines.length; j++) {
      if (goalLinesAppearConflicting(substantiveGoalLines[i], substantiveGoalLines[j])) {
        conflictingPairs.push([substantiveGoalLines[i], substantiveGoalLines[j]]);
      }
    }
  }

  if (conflictingPairs.length > 0) {
    const count = conflictingPairs.length;
    return {
      trigger: 'conflicting-or-vague-goals',
      reason:
        `${count} potentially conflicting goal pair${count > 1 ? 's' : ''} detected in plan.md ` +
        '(opposing direction verbs on the same topic). An interview can clarify priorities and resolve the contradiction before weekly tasks are generated.',
      details: {
        agentId,
        conflicting: true,
        conflictingPairs,
        substantiveGoalLineCount: substantiveGoalLines.length,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Trigger 3: prior-week flagged problems
// ---------------------------------------------------------------------------

/**
 * Inspect the prior week's activity log and weekly plan for failed tasks.
 *
 * The trigger fires when failures meet either threshold:
 *   - Absolute: {@link PRIOR_WEEK_ABSOLUTE_FAILURE_THRESHOLD} or more failures (regardless of total).
 *   - Rate: at least {@link PRIOR_WEEK_MIN_ACTIVITIES} activities total AND
 *     {@link PRIOR_WEEK_FAILURE_RATE_THRESHOLD} or more are failures.
 *
 * Failure signals are sourced from:
 *   - Activity log entries with `status === 'failed'`
 *   - Weekly plan tasks with `status === 'failed'` (avoiding double-count
 *     against log entries that already reference the same task via taskId)
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.dataDir - `.aweek/agents` root
 * @param {string} [params.tz] - IANA timezone for week-boundary computation (defaults to UTC)
 * @param {Date|number} [params.now] - Override wall-clock "now" for testing
 * @returns {Promise<{trigger: string, reason: string, details: object} | null>}
 */
export async function detectPriorWeekProblems({
  agentId,
  dataDir,
  tz,
  now = new Date(),
}) {
  if (!agentId) throw new TypeError('agentId is required');
  if (!dataDir) throw new TypeError('dataDir is required');

  const resolvedTz = typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
  const currentKey = currentWeekKey(resolvedTz, now);
  const priorKey = previousWeekKey(currentKey);
  const priorMonday = mondayStringForWeek(priorKey);

  const activityStore = new ActivityLogStore(dataDir);
  const weeklyPlanStore = new WeeklyPlanStore(dataDir);

  // Load both sources concurrently; treat missing data as empty.
  const [logEntries, priorPlan] = await Promise.all([
    activityStore.load(agentId, priorMonday).catch(() => []),
    weeklyPlanStore.load(agentId, priorKey).catch(() => null),
  ]);

  const priorPlanTasks = Array.isArray(priorPlan?.tasks) ? priorPlan.tasks : [];

  // Failed activity log entries.
  const failedLogEntries = logEntries.filter((e) => e.status === 'failed');

  // Failed weekly plan tasks not already covered by a matching log entry.
  const logTaskIds = new Set(failedLogEntries.map((e) => e.taskId).filter(Boolean));
  const failedPlanTasks = priorPlanTasks.filter(
    (t) => t.status === 'failed' && !logTaskIds.has(t.id),
  );

  const totalFailed = failedLogEntries.length + failedPlanTasks.length;
  const totalActivities = logEntries.length + priorPlanTasks.length;
  const failureRate = totalActivities > 0 ? totalFailed / totalActivities : 0;

  const triggeredByAbsolute = totalFailed >= PRIOR_WEEK_ABSOLUTE_FAILURE_THRESHOLD;
  const triggeredByRate =
    totalActivities >= PRIOR_WEEK_MIN_ACTIVITIES &&
    totalFailed >= 1 &&
    failureRate >= PRIOR_WEEK_FAILURE_RATE_THRESHOLD;

  if (!triggeredByAbsolute && !triggeredByRate) return null;

  const failedDescriptions = [
    ...failedLogEntries.map((e) => e.title),
    ...failedPlanTasks.map((t) => t.title),
  ];

  return {
    trigger: 'prior-week-problems',
    reason:
      `${totalFailed} failed task${totalFailed !== 1 ? 's' : ''} detected in week ${priorKey} ` +
      `(${Math.round(failureRate * 100)}% of ${totalActivities} recorded activities). ` +
      'An interview can surface blockers and adjust priorities before the next week is planned.',
    details: {
      agentId,
      priorWeekKey: priorKey,
      priorWeekMonday: priorMonday,
      totalFailed,
      totalActivities,
      failureRate: Math.round(failureRate * 100) / 100,
      triggeredBy: triggeredByAbsolute ? 'absolute-threshold' : 'rate-threshold',
      failedDescriptions,
    },
  };
}

// ---------------------------------------------------------------------------
// Trigger 4: deadline approaching
// ---------------------------------------------------------------------------

/**
 * Scan plan.md for deadlines that fall within the lookahead window.
 *
 * Two deadline sources are searched:
 *   1. `## Monthly plans` section: each `### YYYY-MM` subsection heading
 *      is treated as a monthly objective whose deadline is the last calendar
 *      day of that month.
 *   2. Explicit date mentions anywhere in plan.md (patterns recognized by
 *      {@link parseDateMentions}: "by YYYY-MM-DD", "due YYYY-MM-DD",
 *      "deadline: YYYY-MM-DD", or bare ISO dates).
 *
 * A deadline is "approaching" when it falls between (now − 1 day) and
 * (now + lookaheadDays). The 1-day grace handles end-of-day timing so a
 * deadline that passed at midnight tonight still fires.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.agentsDir - `.aweek/agents` root
 * @param {number} [params.lookaheadDays] - Window in calendar days (default 14)
 * @param {Date|number} [params.now] - Override wall-clock "now" for testing
 * @returns {Promise<{trigger: string, reason: string, details: object} | null>}
 */
export async function detectDeadlineApproaching({
  agentId,
  agentsDir,
  lookaheadDays = DEFAULT_DEADLINE_LOOKAHEAD_DAYS,
  now = new Date(),
}) {
  if (!agentId) throw new TypeError('agentId is required');
  if (!agentsDir) throw new TypeError('agentsDir is required');

  let body;
  try {
    body = await readPlan(agentsDir, agentId);
  } catch {
    body = null;
  }

  if (!body) return null;

  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const windowStartMs = nowMs - 24 * 60 * 60 * 1000; // 1-day grace
  const windowEndMs = nowMs + lookaheadDays * 24 * 60 * 60 * 1000;

  const approachingDeadlines = [];

  // --- Source 1: Monthly plan end-dates (### YYYY-MM headings) ---
  const parsed = parsePlanMarkdownSections(body);
  const monthlyBody = parsed.byTitle['Monthly plans'] ?? '';
  const monthHeadingRe = /^###\s+(\d{4}-\d{2})\b/gm;
  let monthMatch;
  while ((monthMatch = monthHeadingRe.exec(monthlyBody)) !== null) {
    const monthStr = monthMatch[1];
    const deadline = lastDayOfMonth(monthStr);
    if (!deadline) continue;
    const deadlineMs = deadline.getTime();
    if (deadlineMs >= windowStartMs && deadlineMs <= windowEndMs) {
      const daysRemaining = Math.ceil((deadlineMs - nowMs) / (24 * 60 * 60 * 1000));
      approachingDeadlines.push({
        type: 'monthly-plan',
        label: monthStr,
        deadline: deadline.toISOString().slice(0, 10),
        daysRemaining,
      });
    }
  }

  // --- Source 2: Explicit date mentions in plan.md ---
  const mentionedDates = parseDateMentions(body);
  // Deduplicate against monthly-plan deadlines already collected.
  const collectedLabels = new Set(approachingDeadlines.map((d) => d.label));
  for (const { date, label, snippet } of mentionedDates) {
    if (collectedLabels.has(label)) continue; // already captured above
    const deadlineMs = date.getTime();
    if (deadlineMs >= windowStartMs && deadlineMs <= windowEndMs) {
      const daysRemaining = Math.ceil((deadlineMs - nowMs) / (24 * 60 * 60 * 1000));
      approachingDeadlines.push({
        type: 'explicit-date',
        label,
        deadline: date.toISOString().slice(0, 10),
        daysRemaining,
        snippet,
      });
      collectedLabels.add(label);
    }
  }

  if (approachingDeadlines.length === 0) return null;

  // Sort by soonest deadline first so the most urgent appears in the reason string.
  approachingDeadlines.sort((a, b) => a.daysRemaining - b.daysRemaining);

  const nearest = approachingDeadlines[0];
  const daysDesc =
    nearest.daysRemaining <= 0
      ? 'already passed'
      : `in ${nearest.daysRemaining} day${nearest.daysRemaining !== 1 ? 's' : ''}`;
  const count = approachingDeadlines.length;

  return {
    trigger: 'deadline-approaching',
    reason:
      `${count} deadline${count !== 1 ? 's are' : ' is'} approaching within ${lookaheadDays} days ` +
      `(nearest: ${nearest.label} — ${daysDesc}). An interview ensures the weekly plan prioritises deadline-critical work.`,
    details: {
      agentId,
      lookaheadDays,
      approachingDeadlines,
      nearestDeadline: nearest,
    },
  };
}

// ---------------------------------------------------------------------------
// Composite: run all four triggers in parallel
// ---------------------------------------------------------------------------

/**
 * Run all four interview triggers concurrently and return the array of
 * fired reasons. An empty array means no interview is needed and the
 * planner can proceed autonomously.
 *
 * Individual trigger failures are silently swallowed (the trigger is
 * treated as non-firing) so a broken activity log or missing plan.md
 * never blocks the weekly planning flow.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.dataDir - `.aweek/agents` root directory
 * @param {string} [params.tz] - IANA timezone (passed to trigger 3)
 * @param {Date|number} [params.now] - Override wall-clock "now" for testing
 * @param {number} [params.deadlineLookaheadDays] - Lookahead window for trigger 4 (default 14)
 * @returns {Promise<Array<{trigger: string, reason: string, details: object}>>}
 */
export async function checkInterviewTriggers({
  agentId,
  dataDir,
  tz,
  now = new Date(),
  deadlineLookaheadDays = DEFAULT_DEADLINE_LOOKAHEAD_DAYS,
}) {
  const results = await Promise.allSettled([
    isFirstEverPlan({ agentId, dataDir }),
    detectVagueOrConflictingGoals({ agentId, agentsDir: dataDir }),
    detectPriorWeekProblems({ agentId, dataDir, tz, now }),
    detectDeadlineApproaching({
      agentId,
      agentsDir: dataDir,
      lookaheadDays: deadlineLookaheadDays,
      now,
    }),
  ]);

  return results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value);
}

// ---------------------------------------------------------------------------
// Skip-questions escape hatch
//
// When the user selects "skip questions" at the B2a interview gate, the skill
// calls generateSkipAssumptions(triggers) to produce a best-guess assumption
// for every fired trigger and then displays the formatted block via
// formatAssumptionsBlock(assumptions). The user reviews the block and either
// approves it (proceeding directly to B2b) or declines (falling back to the
// normal inline interview). No further AskUserQuestion interview steps are
// run while skip mode is active.
// ---------------------------------------------------------------------------

/**
 * Human-readable label for a trigger ID.
 *
 * @param {string} trigger
 * @returns {string}
 */
function triggerLabel(trigger) {
  switch (trigger) {
    case 'first-ever-plan':
      return 'First-Ever Plan';
    case 'conflicting-or-vague-goals':
      return 'Conflicting or Vague Goals';
    case 'prior-week-problems':
      return 'Prior-Week Problems';
    case 'deadline-approaching':
      return 'Deadline Approaching';
    default:
      return trigger;
  }
}

/**
 * Generate a best-guess assumption string for a single fired trigger.
 *
 * Each trigger type produces a concise, actionable assumption that a
 * planner would make when proceeding without further user input. The
 * assumptions are intentionally conservative — they prefer reducing scope
 * and deferring risky choices rather than committing to a direction that
 * might be wrong.
 *
 * @param {object} triggerResult - One element from the checkInterviewTriggers array
 * @param {string} triggerResult.trigger - Trigger ID
 * @param {object} triggerResult.details - Trigger-specific context
 * @returns {string} Best-guess assumption text (one or two sentences)
 */
export function generateAssumptionForTrigger({ trigger, details = {} }) {
  switch (trigger) {
    case 'first-ever-plan':
      return (
        `Proceeding with a calibration starter week: 2–3 broad tasks derived from the agent's ` +
        `description, spread evenly across Mon–Fri. Treat this first week as a signal ` +
        `for scope and pacing — results will inform next week's refinement.`
      );

    case 'conflicting-or-vague-goals': {
      if (details.conflicting && Array.isArray(details.conflictingPairs) && details.conflictingPairs.length > 0) {
        const [lineA] = details.conflictingPairs[0];
        return (
          `Conflicting goal direction detected. Assuming the first stated direction takes ` +
          `precedence this week: "${lineA}". Tasks that pull in the opposing direction ` +
          `will be omitted or de-prioritised. Update plan.md to resolve the conflict ` +
          `permanently.`
        );
      }
      // Vague / absent goals
      const vagueReason = details.vagueReason ?? 'goals are absent or placeholder-only';
      return (
        `Goals are unclear (${vagueReason}). Defaulting to a general-productivity focus: ` +
        `consolidating existing work, fixing outstanding issues, and preparing for the next ` +
        `planned milestone. Add specific goals to plan.md for more targeted weekly plans.`
      );
    }

    case 'prior-week-problems': {
      const totalFailed = details.totalFailed ?? 0;
      const failurePct = Math.round((details.failureRate ?? 0) * 100);
      return (
        `Prior week (${details.priorWeekKey ?? 'last week'}) had ${totalFailed} failed ` +
        `task${totalFailed !== 1 ? 's' : ''} (${failurePct}% failure rate). Assuming tasks ` +
        `were over-scoped. This week's plan will reduce breadth by ~30%, focusing on fewer ` +
        `and more atomic tasks to rebuild momentum. Adjust scope up next week if this week ` +
        `goes smoothly.`
      );
    }

    case 'deadline-approaching': {
      const count = details.approachingDeadlines?.length ?? 1;
      const nearest = details.nearestDeadline;
      const nearestDesc = nearest
        ? `nearest: ${nearest.label} — ${
            nearest.daysRemaining <= 0 ? 'already passed' : `in ${nearest.daysRemaining} day${nearest.daysRemaining !== 1 ? 's' : ''}`
          }`
        : `within ${details.lookaheadDays ?? DEFAULT_DEADLINE_LOOKAHEAD_DAYS} days`;
      return (
        `${count} deadline${count !== 1 ? 's are' : ' is'} approaching (${nearestDesc}). ` +
        `Assuming deadline-critical work takes top priority this week. Non-critical tasks ` +
        `will be deferred until after the deadline passes.`
      );
    }

    default:
      return (
        `Proceeding with best-guess defaults for trigger "${trigger}". ` +
        `No specific assumption is available — review the generated plan carefully.`
      );
  }
}

/**
 * Generate a best-guess assumption for every fired trigger.
 *
 * This is the primary entry point for the skip-questions escape hatch.
 * The returned array has one entry per trigger (same order as the input)
 * and is meant to be passed directly to {@link formatAssumptionsBlock}.
 *
 * @param {Array<{trigger: string, reason: string, details: object}>} triggers
 *   Fired triggers from {@link checkInterviewTriggers}
 * @returns {Array<{trigger: string, label: string, assumption: string}>}
 */
export function generateSkipAssumptions(triggers) {
  if (!Array.isArray(triggers)) return [];
  return triggers.map((t) => ({
    trigger: t.trigger,
    label: triggerLabel(t.trigger),
    assumption: generateAssumptionForTrigger(t),
  }));
}

/**
 * Format a list of skip-mode assumptions as a clearly-labelled markdown
 * block suitable for direct display in the skill output.
 *
 * The block is framed with horizontal rules so it stands visually apart
 * from the surrounding plan text. Each assumption is introduced with its
 * trigger label as an H3 heading and quoted in a blockquote so the user
 * can distinguish the machine-generated guess from their own plan content.
 *
 * An empty assumptions array returns an empty string so callers can skip
 * the display step cleanly.
 *
 * @param {Array<{trigger: string, label: string, assumption: string}>} assumptions
 *   Output of {@link generateSkipAssumptions}
 * @returns {string} Formatted markdown block (empty string if no assumptions)
 */
export function formatAssumptionsBlock(assumptions) {
  if (!Array.isArray(assumptions) || assumptions.length === 0) return '';

  const lines = [
    '---',
    '',
    '## ⚠ Skipped Questions — Assumptions Applied',
    '',
    'The following best-guess assumptions replace the interview questions that would',
    'normally run for this plan. Review each assumption carefully.',
    'If any assumption looks wrong, **decline approval** and run the full interview instead.',
    '',
  ];

  for (const { label, assumption } of assumptions) {
    lines.push(`### ${label}`);
    lines.push('');
    lines.push(`> ${assumption}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    '_To proceed: approve the assumptions above. To run the interview instead: decline._',
  );

  return lines.join('\n');
}
