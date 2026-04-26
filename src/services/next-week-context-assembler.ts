/**
 * Context assembler for the autonomous next-week planner.
 *
 * When the weekly-review chain fires the next-week planner autonomously,
 * this module reads the three context sources that give the plan generator
 * situational awareness about the just-completed week:
 *
 *   1. plan.md — agent's goals, strategies, and notes (the canonical context
 *      already consumed by generateWeeklyPlan via options.planMarkdown).
 *
 *   2. Weekly retrospective file — the review document just written by the
 *      weekly-review orchestrator (.aweek/agents/<slug>/reviews/<week>.md).
 *      A compact summary is extracted from the Completed Tasks, Blockers, and
 *      Metrics H2 sections and surfaced as `retrospectiveContext` for the
 *      advisor brief composer.
 *
 *   3. Activity log — structured JSON entries for the completed week
 *      (.aweek/agents/<slug>/logs/<monday>.json). A brief count-based summary
 *      is derived as `activityLogSummary`.
 *
 * The returned context object maps directly onto generateWeeklyPlan option keys
 * so the caller can spread the result in without further transformation:
 *
 * ```js
 * const ctx = await assembleNextWeekPlannerContext(deps, agentId, week, { tz });
 * const { plan } = generateWeeklyPlan({
 *   week: nextWeek, month, goals, monthlyPlan,
 *   options: {
 *     planMarkdown:         ctx.planMarkdown,
 *     retrospectiveContext: ctx.retrospectiveContext,
 *     tz,
 *   },
 * });
 * ```
 *
 * All reads are best-effort: a missing plan.md, absent review file, or empty
 * activity log returns null / [] without throwing — the plan generator handles
 * nulls via its existing graceful fallbacks (absent planMarkdown falls back to
 * the flat objective description; absent retrospectiveContext skips the weekly
 * retrospective sentence in the advisor brief).
 */
import { readPlan } from '../storage/plan-markdown-store.js';
import { loadReview, mondayFromISOWeek } from './weekly-review-orchestrator.js';

interface ActivityLogEntry {
  status?: string;
  title?: string;
  [key: string]: unknown;
}

interface AssembleNextWeekDeps {
  agentsDir?: string | null;
  baseDir?: string | null;
  activityLogStore?: { load: (agentId: string, weekMonday: string) => Promise<unknown> } | null;
}

export interface AssembleNextWeekContextResult {
  planMarkdown: string | null;
  retrospectiveContext: string | null;
  activityLogSummary: string | null;
  activityLogEntries: ActivityLogEntry[];
}

// ---------------------------------------------------------------------------
// Retrospective summary extraction
// ---------------------------------------------------------------------------

/**
 * Extract a compact retrospective summary from a weekly review markdown document.
 *
 * Searches H2 sections for signal-rich content in priority order:
 *
 *   1. `Completed Tasks` — first non-heading, non-empty line after markdown
 *      decoration is stripped. Typically a bold count or summary sentence such
 *      as "3 tasks completed" or "No tasks completed this week."
 *
 *   2. `Blockers` — first bullet item in the section. Prefixed with
 *      "unresolved blocker: " so downstream brief composition knows the tone.
 *
 *   3. `Metrics` — first line that mentions "completion", "rate", or "task"
 *      (case-insensitive). Provides a quantitative anchor for the brief.
 *
 * Returns a single compact string joining at most three phrases with "; ",
 * or `null` when the review markdown is absent or yields no extractable signal.
 *
 * @param {string|null|undefined} reviewMarkdown - Full weekly review markdown
 * @returns {string|null} Compact summary string, or null when none extractable
 */
export function extractRetrospectiveSummary(reviewMarkdown: unknown): string | null {
  if (typeof reviewMarkdown !== 'string' || reviewMarkdown.length === 0) return null;

  // Parse H2 sections into a title → body map.  Uses the same loose parser as
  // parsePlanMarkdownSections but without the cross-module dependency: any line
  // starting with `## ` opens a new section; content up to the next H2 belongs
  // to the current section.
  const byTitle: Record<string, string> = {};
  let currentTitle: string | null = null;
  const currentLines: string[] = [];

  const flush = () => {
    if (currentTitle != null) {
      byTitle[currentTitle] = currentLines.join('\n').trim();
    }
  };

  for (const raw of reviewMarkdown.split(/\r?\n/)) {
    const h2 = /^##\s+(.+)$/.exec(raw);
    if (h2) {
      flush();
      currentTitle = h2[1]!.trim();
      currentLines.length = 0;
    } else if (currentTitle != null) {
      currentLines.push(raw);
    }
  }
  flush();

  const parts: string[] = [];

  // 1. Completed Tasks — first non-empty, non-heading line (markdown stripped).
  const completedBody = byTitle['Completed Tasks'] ?? '';
  if (completedBody.length > 0) {
    const summaryLine = completedBody
      .split('\n')
      .map((l) => l.replace(/[*_`]/g, '').trim())
      .find((l) => l.length > 0 && !/^#/.test(l));
    if (summaryLine) {
      parts.push(
        summaryLine.length > 120 ? `${summaryLine.slice(0, 117)}...` : summaryLine,
      );
    }
  }

  // 2. Blockers — first bullet item, cleaned up and prefixed.
  const blockersBody = byTitle['Blockers'] ?? '';
  if (blockersBody.length > 0) {
    const firstBullet = blockersBody
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('-') || l.startsWith('*'));
    if (firstBullet) {
      const cleaned = firstBullet.replace(/^[-*]\s*/, '').trim();
      if (cleaned.length > 0) {
        const truncated = cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned;
        parts.push(`unresolved blocker: ${truncated}`);
      }
    }
  }

  // 3. Metrics — first line mentioning "completion", "rate", or "task" (quantitative anchor).
  if (parts.length < 3) {
    const metricsBody = byTitle['Metrics'] ?? '';
    if (metricsBody.length > 0) {
      const rateLine = metricsBody
        .split('\n')
        .map((l) => l.replace(/[*_`|]/g, '').trim())
        .find((l) => l.length > 0 && /completion|rate|task/i.test(l));
      if (rateLine) {
        parts.push(rateLine.length > 100 ? `${rateLine.slice(0, 97)}...` : rateLine);
      }
    }
  }

  if (parts.length === 0) {
    // Fallback: strip headings, join prose, and take first 280 chars.
    const bodyText = reviewMarkdown
      .split('\n')
      .filter((l) => !/^#/.test(l.trim()) && l.trim().length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return bodyText.length > 0
      ? bodyText.length > 280
        ? `${bodyText.slice(0, 277)}...`
        : bodyText
      : null;
  }

  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Activity log summary
// ---------------------------------------------------------------------------

/**
 * Derive a compact summary string from an array of activity log entries.
 *
 * Counts entries by status (completed / failed / total) and appends the
 * description of the most recently completed entry so the plan generator has
 * a concrete "last thing accomplished" anchor for advisor brief composition.
 *
 * @param {object[]} entries - Activity log entries for the completed week
 * @returns {string|null} Compact summary, or null when the entries array is empty
 */
export function summariseActivityLog(entries: unknown): string | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const list = entries as ActivityLogEntry[];

  const completed = list.filter((e) => e.status === 'completed').length;
  const failed = list.filter((e) => e.status === 'failed').length;
  const total = list.length;

  const parts: string[] = [
    `${total} recorded ${total === 1 ? 'entry' : 'entries'}`,
    `${completed} completed`,
  ];
  if (failed > 0) parts.push(`${failed} failed`);

  // Most recent completed entry title — strongest continuity anchor.
  // Activity-log entries store `title` (sourced from task.title), so this
  // keeps the continuity hint focused on the user-facing label.
  const lastCompleted = [...list]
    .reverse()
    .find(
      (e) =>
        e.status === 'completed' &&
        typeof e.title === 'string' &&
        e.title.trim().length > 0,
    );
  if (lastCompleted) {
    const desc = lastCompleted.title!.trim();
    const truncated = desc.length > 80 ? `${desc.slice(0, 77)}...` : desc;
    parts.push(`most recent completed: "${truncated}"`);
  }

  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Main assembler
// ---------------------------------------------------------------------------

/**
 * Assemble context for the autonomous next-week planner from three sources.
 *
 * Reads plan.md, the just-written weekly retrospective, and the activity log
 * for the completed week. The returned object maps directly onto
 * `generateWeeklyPlan` option keys:
 *
 * ```js
 * const ctx = await assembleNextWeekPlannerContext(deps, agentId, week, { tz });
 * generateWeeklyPlan({
 *   week: nextWeek, month, goals, monthlyPlan,
 *   options: {
 *     planMarkdown:         ctx.planMarkdown,
 *     retrospectiveContext: ctx.retrospectiveContext,
 *     tz,
 *   },
 * });
 * ```
 *
 * All reads are best-effort: a missing plan.md, absent review file, or empty
 * activity log yields null / [] for that field without throwing.
 *
 * @param {object} deps - Injected dependencies
 * @param {string|null} deps.agentsDir - `.aweek/agents` root for plan.md reads.
 *   When null, plan.md reading is skipped (planMarkdown returns null).
 * @param {string|null} deps.baseDir - `.aweek/agents` root for review reads.
 *   May be the same path as agentsDir. When null, review reading is skipped.
 * @param {object|null} [deps.activityLogStore] - ActivityLogStore instance.
 *   When null or absent, the activity log context is skipped (returns []).
 * @param {string} agentId - Agent slug / identifier
 * @param {string} week - ISO week string for the *completed* week (YYYY-Www)
 * @param {object} [opts]
 * @param {string} [opts.tz='UTC'] - IANA time zone used for Monday derivation
 * @returns {Promise<{
 *   planMarkdown: string|null,
 *   retrospectiveContext: string|null,
 *   activityLogSummary: string|null,
 *   activityLogEntries: object[],
 * }>}
 */
export async function assembleNextWeekPlannerContext(
  deps: AssembleNextWeekDeps | null | undefined,
  agentId: string,
  week: string,
  opts: { tz?: string } = {},
): Promise<AssembleNextWeekContextResult> {
  const {
    agentsDir = null,
    baseDir = null,
    activityLogStore = null,
  } = deps ?? {};

  const tz =
    typeof opts?.tz === 'string' && opts.tz.length > 0 ? opts.tz : 'UTC';

  // Derive the Monday date string for the activity log lookup.
  const weekMonday = mondayFromISOWeek(week, tz);

  // Read all three sources concurrently; each is wrapped in a best-effort catch
  // so a missing file or unreadable store never aborts the whole assembly.
  const [planMarkdown, reviewResult, activityLogEntries] = await Promise.all([
    typeof agentsDir === 'string' && agentId
      ? readPlan(agentsDir, agentId).catch(() => null)
      : Promise.resolve(null),
    typeof baseDir === 'string' && agentId
      ? loadReview(baseDir, agentId, week).catch(() => null)
      : Promise.resolve(null),
    activityLogStore && agentId
      ? activityLogStore.load(agentId, weekMonday).catch(() => [])
      : Promise.resolve([]),
  ]);

  const retrospectiveMarkdown = (reviewResult as { markdown?: string } | null)?.markdown ?? null;
  const retrospectiveContext = extractRetrospectiveSummary(retrospectiveMarkdown);
  const logsArr = (Array.isArray(activityLogEntries) ? activityLogEntries : []) as ActivityLogEntry[];
  const activityLogSummary = summariseActivityLog(logsArr);

  return {
    planMarkdown: planMarkdown ?? null,
    retrospectiveContext,
    activityLogSummary,
    activityLogEntries: logsArr,
  };
}
