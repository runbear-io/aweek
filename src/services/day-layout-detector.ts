/**
 * Day-layout detection for agent plan.md content.
 *
 * Reads an agent's plan.md markdown body and classifies the planning style
 * into one of three layout modes:
 *
 *   'theme-days'        — plan organises work by named weekday themes
 *                         (e.g. "### Monday — Research", "Tuesdays: deep work")
 *   'priority-waterfall'— plan organises work by explicit priority rank
 *                         (e.g. "Priority 1:", "#1 goal", "must-have / nice-to-have")
 *   'mixed'             — plan contains signals from both categories, or
 *                         has no clear structural signals at all (default)
 *
 * The detector is intentionally heuristic — it looks for recurring textual
 * patterns rather than enforcing a schema. This means it can work against
 * any free-form plan.md without requiring the user to annotate their style.
 *
 * Scoring rules
 * -------------
 * Each category has a set of named signal patterns. Every distinct pattern
 * that matches the input contributes +1 to that category's score. The final
 * mode is selected by:
 *
 *   themeScore > 0 && priorityScore === 0  → 'theme-days'
 *   priorityScore > 0 && themeScore === 0  → 'priority-waterfall'
 *   otherwise (both, neither)              → 'mixed'
 *
 * This keeps the function deterministic for the same input, and "mixed" is
 * the safe default when the plan structure is ambiguous.
 */

// ---------------------------------------------------------------------------
// Day-name constants
// ---------------------------------------------------------------------------

/**
 * Canonical English weekday names (lowercase). Only Mon–Fri are used as
 * theme-day signals; Sat/Sun are uncommon in work schedules and would add
 * noise to the score if treated as strong signals.
 */
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

/**
 * Regex that matches any workday name (case-insensitive, word boundary).
 * Pre-compiled for re-use across multiple scoring helpers.
 */
const ANY_WEEKDAY_RE = /\b(monday|tuesday|wednesday|thursday|friday)\b/gi;

// ---------------------------------------------------------------------------
// Theme-day signal patterns
// ---------------------------------------------------------------------------

interface LayoutSignal {
  name: string;
  pattern: RegExp;
}

/**
 * Each entry is `{ name, pattern }`.  A pattern counts once regardless of
 * how many times it matches in the document (we're measuring *presence* of
 * a signal, not frequency).
 *
 * @type {Array<{ name: string, pattern: RegExp }>}
 */
const THEME_DAY_SIGNALS: LayoutSignal[] = [
  {
    // Day name used directly as a Markdown heading: "## Monday", "### Friday:"
    name: 'day-as-heading',
    pattern: /^#{1,4}\s+(monday|tuesday|wednesday|thursday|friday)\b/im,
  },
  {
    // "Monday:" / "Monday -" / "Monday —" at line start (theme label)
    name: 'day-label-at-line-start',
    pattern: /^(monday|tuesday|wednesday|thursday|friday)\s*[:\-—]/im,
  },
  {
    // Plural day names — "Mondays:", "Tuesdays are for…" (recurring schedule)
    name: 'plural-day-recurring',
    pattern: /\b(mondays|tuesdays|wednesdays|thursdays|fridays)\s*[:\-—]|\b(mondays|tuesdays|wednesdays|thursdays|fridays)\s+are\b/i,
  },
  {
    // "Monday = deep work" / "Tuesday: research" (assignment syntax)
    name: 'day-assignment',
    pattern: /\b(monday|tuesday|wednesday|thursday|friday)\s*[=:]\s*\S/i,
  },
  {
    // "every Monday" / "on Tuesdays" (scheduling cadence language)
    name: 'day-cadence',
    pattern: /\b(every|on)\s+(monday|tuesday|wednesday|thursday|friday)s?\b/i,
  },
  {
    // Named theme-day phrases regardless of specific day: "deep work day",
    // "admin day", "focus day", "review day" — common in day-theming guides
    name: 'theme-day-phrase',
    pattern: /\b(deep[- ]work|admin|focus|research|build|planning|review|creative)\s+day\b/i,
  },
  {
    // "Day 1 / Day 2 / Day 3" — ordinal day sequencing (temporal, not priority)
    name: 'ordinal-day-sequence',
    pattern: /\bday\s+[1-7]\b.*\bday\s+[2-7]\b/is,
  },
];

/**
 * Minimum number of distinct weekday names that must appear in the text
 * before the "many weekdays" bonus signal fires. This guards against plans
 * that happen to mention a single day in passing.
 */
const MIN_WEEKDAY_COUNT_FOR_BONUS = 3;

// ---------------------------------------------------------------------------
// Priority-waterfall signal patterns
// ---------------------------------------------------------------------------

/**
 * @type {Array<{ name: string, pattern: RegExp }>}
 */
const PRIORITY_WATERFALL_SIGNALS: LayoutSignal[] = [
  {
    // "Priority 1:" / "Priority #2:" / "P1:" / "P2:" — numbered priority labels
    name: 'numbered-priority-label',
    pattern: /\b(priority\s*#?\d+|p[1-9])\s*[:\-—]/i,
  },
  {
    // "## Priorities" / "### Priority 1" / "## Top Priorities" — section headings
    name: 'priorities-heading',
    pattern: /^#{1,4}\s+(top\s+|key\s+)?priorities?\b/im,
  },
  {
    // "first priority" / "top priority" / "primary priority" (superlative language)
    name: 'superlative-priority',
    pattern: /\b(first|second|third|top|main|primary|highest)\s+priority\b/i,
  },
  {
    // MoSCoW method: "must-have", "should-have", "could-have", "nice-to-have"
    name: 'moscow',
    pattern: /\b(must[\s-]have|should[\s-]have|could[\s-]have|nice[\s-]to[\s-]have|won[''']t[\s-]have)\b/i,
  },
  {
    // Explicit priority brackets/inline tags: [critical], [high], [P1], (priority: high)
    name: 'inline-priority-tag',
    pattern: /\[(critical|high|medium|low|p[1-4]|priority[:\s]+\w+)\]/i,
  },
  {
    // "priority: high" / "priority: critical" as a field in a list or table
    name: 'priority-field',
    pattern: /\bpriority[:\s]+(critical|high|medium|low)\b/i,
  },
  {
    // "#1 goal" / "#1 objective" / "#1 task" — hash-numbered ranking
    // Note: `\b` cannot precede `#` (non-word char) so we use a negative
    // lookbehind to ensure the `#` is not part of a larger identifier.
    name: 'hash-ranked-goal',
    pattern: /(?<![a-zA-Z0-9_])#[1-9]\s+(goal|objective|task|item|priority)\b/i,
  },
  {
    // Waterfall/tier framing: "Tier 1 / Tier 2", "Level 1 objective"
    name: 'tier-or-level',
    pattern: /\b(tier|level)\s+[1-9]\b/i,
  },
  {
    // "critical path" — project-management priority language
    name: 'critical-path',
    pattern: /\bcritical[- ]path\b/i,
  },
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Count how many distinct theme-day signals fire for `text`.
 * An additional bonus signal fires when 3+ unique weekday names appear
 * (indicating day-by-day planning rather than a passing reference).
 *
 * @param {string} text - Plan markdown body
 * @returns {number} Signal count (0 = no theme-day signals found)
 */
export function scoreThemeDays(text: string): number {
  let score = 0;

  for (const signal of THEME_DAY_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += 1;
    }
  }

  // Bonus: multiple weekday names scattered throughout (day-by-day planning)
  const matchedDays = new Set(
    (text.match(ANY_WEEKDAY_RE) || []).map((d) => d.toLowerCase()),
  );
  if (matchedDays.size >= MIN_WEEKDAY_COUNT_FOR_BONUS) {
    score += 1;
  }

  return score;
}

/**
 * Count how many distinct priority-waterfall signals fire for `text`.
 *
 * @param {string} text - Plan markdown body
 * @returns {number} Signal count (0 = no priority signals found)
 */
export function scorePriorityWaterfall(text: string): number {
  let score = 0;

  for (const signal of PRIORITY_WATERFALL_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += 1;
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the day-layout mode from an agent's plan.md content.
 *
 * @param {string} planMarkdown - Raw plan.md content (may be null/empty)
 * @returns {'theme-days' | 'priority-waterfall' | 'mixed'}
 */
export type LayoutMode = 'theme-days' | 'priority-waterfall' | 'mixed';

export function detectDayLayout(planMarkdown: unknown): LayoutMode {
  if (typeof planMarkdown !== 'string' || planMarkdown.trim().length === 0) {
    return 'mixed';
  }

  const themeScore = scoreThemeDays(planMarkdown);
  const priorityScore = scorePriorityWaterfall(planMarkdown);

  if (themeScore > 0 && priorityScore === 0) return 'theme-days';
  if (priorityScore > 0 && themeScore === 0) return 'priority-waterfall';

  // Both signals present, or neither — treat as mixed
  return 'mixed';
}

/**
 * Detect the day-layout mode with confidence metadata.
 *
 * Returns the same `mode` as {@link detectDayLayout} plus a `confident`
 * flag and an `ambiguityReason` that clarifies *why* the result is 'mixed'
 * when it is:
 *
 *   - `'conflicting-signals'` — both theme-day and priority-waterfall
 *     signals are present, creating an ambiguous structural mix. The plan
 *     uses day-theme language (e.g. "Monday: deep work") alongside priority
 *     language (e.g. "Priority 1: …"), so neither pattern dominates.
 *   - `'absent-signals'`      — neither category has any signals; the plan
 *     contains no structural layout hints whatsoever (pure prose, empty, or
 *     null). The detector cannot infer a preference from the content alone.
 *   - `null`                  — result is confident. Only one signal category
 *     fired, so the mode is unambiguously 'theme-days' or 'priority-waterfall'.
 *
 * This extended form is used by the `/aweek:plan` skill to decide whether to
 * ask the user for an explicit layout preference (via `AskUserQuestion`) before
 * generating or distributing a weekly plan. The basic {@link detectDayLayout}
 * return value is preserved unchanged for callers that only need the mode.
 *
 * @param {string} planMarkdown - Raw plan.md content (may be null/empty)
 * @returns {{
 *   mode: 'theme-days' | 'priority-waterfall' | 'mixed',
 *   confident: boolean,
 *   ambiguityReason: 'conflicting-signals' | 'absent-signals' | null,
 *   themeScore: number,
 *   priorityScore: number,
 * }}
 */
export interface LayoutConfidence {
  mode: LayoutMode;
  confident: boolean;
  ambiguityReason: 'conflicting-signals' | 'absent-signals' | null;
  themeScore: number;
  priorityScore: number;
}

export function detectDayLayoutWithConfidence(planMarkdown: unknown): LayoutConfidence {
  if (typeof planMarkdown !== 'string' || planMarkdown.trim().length === 0) {
    return {
      mode: 'mixed',
      confident: false,
      ambiguityReason: 'absent-signals',
      themeScore: 0,
      priorityScore: 0,
    };
  }

  const themeScore = scoreThemeDays(planMarkdown);
  const priorityScore = scorePriorityWaterfall(planMarkdown);

  if (themeScore > 0 && priorityScore === 0) {
    return {
      mode: 'theme-days',
      confident: true,
      ambiguityReason: null,
      themeScore,
      priorityScore,
    };
  }

  if (priorityScore > 0 && themeScore === 0) {
    return {
      mode: 'priority-waterfall',
      confident: true,
      ambiguityReason: null,
      themeScore,
      priorityScore,
    };
  }

  // Both scores > 0 → conflicting signals; both === 0 → absent signals.
  const ambiguityReason =
    themeScore > 0 && priorityScore > 0 ? 'conflicting-signals' : 'absent-signals';

  return {
    mode: 'mixed',
    confident: false,
    ambiguityReason,
    themeScore,
    priorityScore,
  };
}

/**
 * Convenience function that returns a human-readable label for each mode.
 * Useful for displaying the detected layout in plan summaries.
 *
 * @param {'theme-days' | 'priority-waterfall' | 'mixed'} mode
 * @returns {string}
 */
export function layoutModeLabel(mode: string): string {
  const labels: Record<string, string> = {
    'theme-days': 'Theme Days',
    'priority-waterfall': 'Priority Waterfall',
    mixed: 'Mixed / Flexible',
  };
  return labels[mode] ?? 'Unknown';
}

/**
 * Named set of all valid layout modes. Useful for validation in callers.
 * @type {Set<string>}
 */
export const LAYOUT_MODES: Set<string> = new Set(['theme-days', 'priority-waterfall', 'mixed']);
