/**
 * Advisor brief composer for weekly work tasks.
 *
 * Generates 3–6 sentence manager-style briefs for non-review tasks in a
 * weekly plan. Each brief contextualises the work inside the agent's plan.md,
 * names the parent goal when available, references the working strategy, and
 * picks up from prior-day outcomes when supplied.
 *
 * Design goals:
 *   - Advisor voice: reads like a manager briefing a new hire, not a flat task
 *     sentence. Contextual, paced, forward-looking.
 *   - Deterministic: same inputs → same output (no randomness).
 *   - Variety: a lightweight hash of objectiveId selects one of four phrase
 *     variants per sentence role so sibling objectives don't all start with
 *     identical wording.
 *   - Plan-grounded: when parsedPlanSections is supplied the brief references
 *     the agent's stated strategy or notes from plan.md rather than relying on
 *     generic filler.
 *   - Continuity-aware: when priorDayOutcomes is supplied the brief weaves in
 *     a "building on yesterday…" bridge sentence so daily momentum is preserved.
 *
 * Usage (inside weekly-plan-generator.js):
 * ```js
 * import { composeAdvisorBrief } from './advisor-brief-composer.js';
 * import { parsePlanMarkdownSections } from '../storage/plan-markdown-store.js';
 *
 * const parsedPlan = parsePlanMarkdownSections(planMarkdown);
 * const brief = composeAdvisorBrief(objective, {
 *   planContext: parsedPlan,
 *   priorDayOutcomes: 'Finished the endpoint schema review',
 *   goalDescription: parentGoal.description,
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return a deterministic variant index (0–3) based on objectiveId.
 * Provides four distinct phrasing templates per sentence role so adjacent
 * objectives in the same plan read differently without true randomness.
 *
 * @param {string} objectiveId
 * @returns {0 | 1 | 2 | 3}
 */
function variantIndex(objectiveId: string): number {
  let hash = 0;
  const str = typeof objectiveId === 'string' ? objectiveId : '';
  for (let i = 0; i < str.length; i++) {
    // djb2-style hash, unsigned 32-bit
    hash = ((hash * 31) + str.charCodeAt(i)) >>> 0;
  }
  return hash % 4;
}

/**
 * Extract the first meaningful line from a plan.md section body.
 *
 * "Meaningful" = non-blank, not an HTML comment (`<!-- … -->`), not a
 * heading line (`# …`). List markers and leading horizon tags like `(3mo) `
 * are stripped so the caller receives the goal or strategy text only.
 *
 * @param {string|undefined} body - Raw section body from parsePlanMarkdownSections
 * @param {number} [maxChars=130] - Truncation limit (adds `…` when exceeded)
 * @returns {string|null} First meaningful line, or null when none is found
 */
function firstMeaningfulLine(body: string | undefined | null, maxChars = 130): string | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^<!--/.test(line)) continue;      // HTML placeholder comment
    if (/^#{1,6}\s/.test(line)) continue;  // Markdown heading
    // Strip list markers then leading horizon tags like "(3mo) "
    const clean = line
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/^\([^)]+\)\s+/, '')
      .trim();
    if (clean.length < 8) continue;        // Too short to be useful
    return clean.length > maxChars ? `${clean.slice(0, maxChars - 3)}...` : clean;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sentence templates
// ---------------------------------------------------------------------------

type DescTemplate = (desc: string) => string;

/**
 * Opening sentences for in-progress objectives.
 * Index selected by variantIndex(objectiveId).
 *
 * @type {Array<(desc: string) => string>}
 */
const IN_PROGRESS_OPENERS: DescTemplate[] = [
  (desc: string) =>
    `You are continuing work on ${desc} this week — an in-progress objective that needs sustained focus to close the remaining gap.`,
  (desc: string) =>
    `${desc} is actively underway, and this week is about pushing it through to a reviewable, shareable outcome.`,
  (desc: string) =>
    `This week's priority is advancing ${desc}, which is already in motion and due for a decisive step forward.`,
  (desc: string) =>
    `Pick up where you left off on ${desc} — it is in progress and the plan calls for meaningful forward movement before Friday.`,
];

/**
 * Opening sentences for planned (not-yet-started) objectives.
 *
 * @type {Array<(desc: string) => string>}
 */
const PLANNED_OPENERS: DescTemplate[] = [
  (desc: string) =>
    `This week opens a new chapter: ${desc} transitions from planned to active and needs a confident first foothold.`,
  (desc: string) =>
    `${desc} is on the schedule to begin this week — move it from the backlog into active work with a clear first deliverable.`,
  (desc: string) =>
    `You are starting fresh on ${desc}, which means establishing scope, approach, and an early concrete output before Friday.`,
  (desc: string) =>
    `New objective in motion: ${desc} enters your weekly plan and needs its first week of real traction.`,
];

/**
 * Goal-frame sentences. Inserted after the opener when a parent goal
 * description is available to anchor the brief in the bigger picture.
 *
 * @type {Array<(goalDesc: string) => string>}
 */
const GOAL_FRAMES: DescTemplate[] = [
  (goal: string) =>
    `It traces back to your goal to ${goal}, keeping the bigger picture in view even as you work through the immediate details.`,
  (goal: string) =>
    `This work serves your stated goal to ${goal} — that context matters when scope decisions come up this week.`,
  (goal: string) =>
    `Your plan.md anchors this to the goal of ${goal}; let that thread guide trade-offs as you navigate the task-level decisions.`,
  (goal: string) =>
    `It is part of the push toward ${goal}, so keep that aim visible when deciding what to prioritise day to day.`,
];

/**
 * Weekly action directives for in-progress objectives.
 * Specific and paced: what to actually do this week, not just "work on it".
 *
 * @type {string[]}
 */
const IN_PROGRESS_DIRECTIVES: string[] = [
  'Drive open items toward a reviewable state and surface any blockers in your daily review slot before they compound into the next day.',
  'Prioritise depth over breadth this week: close outstanding work threads before opening new ones.',
  'Resolve the remaining open questions and get a concrete output into reviewable shape — aim for the Thursday checkpoint.',
  'Focus on producing a shareable, tangible result by mid-week — something concrete the Friday review can assess.',
];

/**
 * Weekly action directives for planned (new) objectives.
 *
 * @type {string[]}
 */
const PLANNED_DIRECTIVES: string[] = [
  'Clarify the scope and success criteria first, then produce an initial output before the week closes.',
  'Establish the foundation early: define what "done" looks like, map the key dependencies, and hit your first milestone by Wednesday.',
  'Give it a strong opening: review the relevant context, sketch the approach, and have a first draft output ready by Thursday.',
  "Scope it tightly for this first week, identify the single most important milestone, and meet it before Friday's review.",
];

/**
 * Prior-day continuity sentences. Appended when priorDayOutcomes is supplied,
 * bridging yesterday's session into today's work.
 *
 * @type {Array<(outcomes: string) => string>}
 */
const CONTINUITY_SENTENCES: DescTemplate[] = [
  (outcomes: string) =>
    `Building on yesterday — ${outcomes} — pick up from that point and push the work further today.`,
  (outcomes: string) =>
    `Yesterday's session covered ${outcomes}; use that as your starting point and keep the momentum going into today.`,
  (outcomes: string) =>
    `Coming off yesterday where ${outcomes}, continue from there and aim for the next concrete step before the daily review.`,
  (outcomes: string) =>
    `Yesterday you made progress with ${outcomes} — carry that forward and target the next milestone in today's session.`,
];

/**
 * Weekly retrospective bridge sentences. Appended when `retrospectiveContext`
 * is supplied (autonomous next-week planner path). Frames last week's outcomes
 * as the weekly entry point rather than a daily one — uses "last week" language
 * rather than "yesterday" so the tense is correct for planning context.
 *
 * @type {Array<(ctx: string) => string>}
 */
const RETROSPECTIVE_BRIDGES: DescTemplate[] = [
  (ctx: string) =>
    `Last week's review noted: ${ctx} — carry those outcomes forward and let them sharpen priorities as you enter the new week.`,
  (ctx: string) =>
    `Building on last week where ${ctx}, use those findings to focus effort and avoid repeating what did not land.`,
  (ctx: string) =>
    `Last week's retrospective captured: ${ctx} — factor those lessons into how you scope and sequence this week's work.`,
  (ctx: string) =>
    `Last week's review showed: ${ctx} — keep that context in view when deciding what to push hardest on this week.`,
];

/**
 * Fallback pacing sentence added when the brief would otherwise fall below
 * the 3-sentence minimum (e.g. no goal, no plan context, no prior-day data).
 */
const PACING_FALLBACK =
  'Use the daily review slot each afternoon to record progress and surface any blockers before they carry into the next day.';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loose shape for plan.md sections (output of parsePlanMarkdownSections).
 */
export interface PlanContext {
  byTitle?: Record<string, string>;
  sections?: Array<{ title: string; body: string }>;
  heading?: string | null;
  preamble?: string;
}

/**
 * Objective shape consumed by composeAdvisorBrief.
 */
export interface BriefObjective {
  id?: string;
  description?: string;
  status?: string;
  goalId?: string;
}

/**
 * Optional context for composing an advisor brief.
 */
export interface ComposeAdvisorBriefOptions {
  planContext?: PlanContext | null;
  priorDayOutcomes?: string | null;
  goalDescription?: string | null;
  retrospectiveContext?: string | null;
}

/**
 * Compose an advisor-voiced brief for a weekly work task.
 *
 * Produces a 3–6 sentence brief that reads like a manager speaking to a new
 * hire: contextual (grounded in plan.md and the parent goal), paced (clear
 * weekly directive), and continuity-aware (bridges from prior-day outcomes
 * when available). The brief replaces the flat objective.description that
 * would otherwise become the task prompt string.
 *
 * Sentence structure (each conditional sentence is included only when the
 * relevant context is present):
 *
 *   1. Opener (status-aware, **always**)
 *   2. Goal frame (when goalDescription is non-empty)
 *   3. Plan context (first substantive strategy or notes line from plan.md)
 *   4. Weekly action directive (status-aware, **always**)
 *   5. Prior-day continuity (when priorDayOutcomes is non-empty)
 *   6. Weekly retrospective bridge (when retrospectiveContext is non-empty)
 *   [+] Fallback pacing line when total < 3 sentences
 *
 * @param {object} objective - Monthly objective this task traces to.
 *   Expected fields: `id` (string), `description` (string), `status` (string).
 * @param {object} [context]
 * @param {object|null} [context.planContext]
 *   Parsed plan.md — output of `parsePlanMarkdownSections` from
 *   `src/storage/plan-markdown-store.js`. When supplied the brief extracts
 *   the first substantive strategy or notes line from the parsed sections.
 * @param {string|null} [context.priorDayOutcomes]
 *   One-sentence (or short paragraph) summary of what the agent completed
 *   or surfaced in the prior working session. When supplied a
 *   "building on yesterday…" bridge sentence is appended.
 * @param {string|null} [context.goalDescription]
 *   Description of the parent goal (from the agent's goals array). When
 *   supplied a goal-framing sentence is inserted after the opener.
 * @param {string|null} [context.retrospectiveContext]
 *   Compact summary extracted from last week's retrospective file (produced by
 *   `extractRetrospectiveSummary` in `next-week-context-assembler.js`). When
 *   supplied a "last week's review noted…" bridge sentence is appended after
 *   the prior-day continuity slot. Uses week-scoped language ("last week")
 *   rather than day-scoped ("yesterday") so it reads correctly during next-week
 *   plan generation. Only set on the autonomous next-week planner path; leave
 *   null (default) for standard daily / user-invoked plan generation.
 * @returns {string} A 3–7 sentence advisor brief suitable for the task `description` field.
 */
export function composeAdvisorBrief(
  objective: BriefObjective | null | undefined,
  {
    planContext = null,
    priorDayOutcomes = null,
    goalDescription = null,
    retrospectiveContext = null,
  }: ComposeAdvisorBriefOptions = {},
): string {
  const safeObj: BriefObjective =
    objective != null && typeof objective === 'object' ? objective : {};
  const {
    id: objectiveId = '',
    description = '',
    status = 'planned',
  } = safeObj;

  const vi = variantIndex(objectiveId);
  const isInProgress = status === 'in-progress';

  const sentences = [];

  // --- 1. Opener (always present) ---
  const openers = isInProgress ? IN_PROGRESS_OPENERS : PLANNED_OPENERS;
  sentences.push(openers[vi](description));

  // --- 2. Goal frame (when goalDescription is supplied and non-empty) ---
  if (typeof goalDescription === 'string' && goalDescription.trim().length > 0) {
    const rawGoal = goalDescription.trim();
    const goalText = rawGoal.length > 130 ? `${rawGoal.slice(0, 127)}...` : rawGoal;
    // Lowercase first letter so the sentence reads naturally after the connecting word
    const goalLc = goalText.length > 0
      ? `${goalText.charAt(0).toLowerCase()}${goalText.slice(1)}`
      : goalText;
    sentences.push(GOAL_FRAMES[vi](goalLc));
  }

  // --- 3. Plan context (first substantive strategy or notes line) ---
  if (planContext != null && typeof planContext === 'object') {
    const stratLine = firstMeaningfulLine(planContext.byTitle?.['Strategies']);
    const notesLine = firstMeaningfulLine(planContext.byTitle?.['Notes']);
    const contextLine = stratLine ?? notesLine;
    if (contextLine) {
      const lc = contextLine.length > 0
        ? `${contextLine.charAt(0).toLowerCase()}${contextLine.slice(1)}`
        : contextLine;
      if (stratLine) {
        sentences.push(
          `Your plan.md notes the following preferred approach: ${lc} — apply that lens to this work.`,
        );
      } else {
        sentences.push(`For additional context, your plan.md notes: ${lc}.`);
      }
    }
  }

  // --- 4. Weekly action directive (always present) ---
  const directives = isInProgress ? IN_PROGRESS_DIRECTIVES : PLANNED_DIRECTIVES;
  sentences.push(directives[vi]);

  // --- 5. Prior-day continuity (when priorDayOutcomes is supplied and non-empty) ---
  if (typeof priorDayOutcomes === 'string' && priorDayOutcomes.trim().length > 0) {
    const rawOutcomes = priorDayOutcomes.trim();
    const shortened = rawOutcomes.length > 150
      ? `${rawOutcomes.slice(0, 147)}...`
      : rawOutcomes;
    const lc = shortened.length > 0
      ? `${shortened.charAt(0).toLowerCase()}${shortened.slice(1)}`
      : shortened;
    sentences.push(CONTINUITY_SENTENCES[vi](lc));
  }

  // --- 6. Weekly retrospective bridge (autonomous next-week planner path only) ---
  // Only fires when retrospectiveContext is supplied — this happens when the
  // next-week planner is invoked from the weekly-review chain and
  // assembleNextWeekPlannerContext has already read last week's review file.
  // Uses week-scoped language ("last week") rather than "yesterday" so the
  // tense is correct in a weekly planning context vs. a daily planning context.
  if (typeof retrospectiveContext === 'string' && retrospectiveContext.trim().length > 0) {
    const rawCtx = retrospectiveContext.trim();
    const shortened = rawCtx.length > 150 ? `${rawCtx.slice(0, 147)}...` : rawCtx;
    const lc = shortened.length > 0
      ? `${shortened.charAt(0).toLowerCase()}${shortened.slice(1)}`
      : shortened;
    sentences.push(RETROSPECTIVE_BRIDGES[vi](lc));
  }

  // --- Ensure minimum 3 sentences ---
  if (sentences.length < 3) {
    sentences.push(PACING_FALLBACK);
  }

  return sentences.join(' ');
}
