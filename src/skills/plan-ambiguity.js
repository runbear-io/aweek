/**
 * Ambiguity scoring primitives for the `/aweek:plan` interview.
 *
 * Inspired by Ouroboros's interview gate (see
 * https://github.com/Q00/ouroboros — `src/ouroboros/bigbang/ambiguity.py`),
 * adapted to the planning domain. Instead of Ouroboros's dimensions
 * (Goal / Constraint / Success Criteria / Brownfield Context), aweek
 * scores the things that make a weekly plan actionable for a scheduled
 * agent:
 *
 *   - goalClarity         — the user knows what weekly outcomes they want.
 *   - taskSpecificity     — proposed tasks are concrete enough for the
 *                           heartbeat to dispatch without further ambiguity.
 *   - prioritySequencing  — what to do first vs. last is clear.
 *   - constraintClarity   — deadlines, dependencies, and the agent's
 *                           budget/availability are surfaced.
 *
 * Everything in this module is pure — no LLM calls, no file I/O.
 *
 *   - {@link buildScoringPrompt} returns the text to feed to the model.
 *   - {@link parseScoreResponse} validates the model's JSON output.
 *   - {@link qualifiesForCompletion} enforces the three-gate stop rule
 *     (threshold + per-dimension floors + N-turn streak).
 *   - {@link buildAmbiguitySnapshot} renders a snapshot the next-question
 *     prompt can splice in so the LLM drills into the weakest area.
 *
 * The `/aweek:plan` skill markdown orchestrates the LLM calls; this
 * module only defines the rules.
 */

/** Ordered list of plan-interview clarity dimensions. */
export const DIMENSIONS = Object.freeze([
  Object.freeze({
    key: 'goalClarity',
    label: 'Goal Clarity',
    weight: 0.35,
    floor: 0.75,
    hint: 'Does the user know what weekly outcomes they want? Specific, not aspirational.',
  }),
  Object.freeze({
    key: 'taskSpecificity',
    label: 'Task Specificity',
    weight: 0.30,
    floor: 0.70,
    hint: 'Are the proposed tasks concrete enough for a scheduled agent to act on without asking back?',
  }),
  Object.freeze({
    key: 'prioritySequencing',
    label: 'Priority & Sequencing',
    weight: 0.20,
    floor: 0.65,
    hint: 'Is the order / priority of tasks clear? What do we do first if the week is compressed?',
  }),
  Object.freeze({
    key: 'constraintClarity',
    label: 'Constraint Clarity',
    weight: 0.15,
    floor: 0.65,
    hint: 'Are deadlines, dependencies, and the agent\'s budget/availability surfaced?',
  }),
]);

/** Overall ambiguity cutoff for seed-readiness. */
export const AMBIGUITY_THRESHOLD = 0.20;

/** Consecutive qualifying turns required before completion is offered. */
export const AUTO_COMPLETE_STREAK_REQUIRED = 2;

/** Milestone labels shown to the user and baked into the snapshot prompt. */
export const MILESTONES = Object.freeze(['initial', 'progress', 'refined', 'ready']);

/**
 * Return true when each dimension in the breakdown carries a numeric score.
 *
 * @param {Record<string, { score?: number }>} breakdown
 * @returns {boolean}
 */
export function isFullBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return false;
  for (const dim of DIMENSIONS) {
    const entry = breakdown[dim.key];
    if (!entry || typeof entry.score !== 'number') return false;
    if (entry.score < 0 || entry.score > 1) return false;
  }
  return true;
}

/**
 * Compute the weighted ambiguity score from a clarity breakdown.
 * `ambiguity = 1 - weighted_clarity_mean` — same shape Ouroboros uses.
 * Dimensions absent from the input don't contribute to the mean (the
 * weight is removed from the denominator), so partial scores degrade
 * gracefully instead of snapping to 1.0.
 *
 * @param {Record<string, { score: number }>} breakdown
 * @returns {number} A value in [0, 1].
 */
export function ambiguityFromBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return 1;

  let weightedClarity = 0;
  let totalWeight = 0;
  for (const dim of DIMENSIONS) {
    const entry = breakdown[dim.key];
    if (!entry || typeof entry.score !== 'number') continue;
    const clamped = Math.max(0, Math.min(1, entry.score));
    weightedClarity += clamped * dim.weight;
    totalWeight += dim.weight;
  }
  if (totalWeight === 0) return 1;
  return Math.max(0, Math.min(1, 1 - weightedClarity / totalWeight));
}

/**
 * Return the dimensions whose clarity score sits below their floor.
 *
 * @param {Record<string, { score: number }>} breakdown
 * @returns {Array<{ key: string, label: string, score: number, floor: number }>}
 */
export function getFloorFailures(breakdown) {
  const out = [];
  if (!breakdown || typeof breakdown !== 'object') {
    return DIMENSIONS.map((dim) => ({
      key: dim.key,
      label: dim.label,
      score: 0,
      floor: dim.floor,
    }));
  }
  for (const dim of DIMENSIONS) {
    const entry = breakdown[dim.key];
    const score = entry && typeof entry.score === 'number' ? entry.score : 0;
    if (score < dim.floor) {
      out.push({ key: dim.key, label: dim.label, score, floor: dim.floor });
    }
  }
  return out;
}

/**
 * The three-gate completion check. All must pass for the interview to
 * offer closure: overall threshold, per-dimension floors, and N-turn
 * sustained-clarity streak.
 *
 * @param {object} args
 * @param {Record<string, { score: number }>} args.breakdown
 * @param {number} args.streak - Count of consecutive qualifying turns so far.
 * @returns {{
 *   qualifies: boolean,
 *   ambiguity: number,
 *   thresholdMet: boolean,
 *   floorFailures: ReturnType<typeof getFloorFailures>,
 *   streak: number,
 *   streakMet: boolean,
 * }}
 */
export function qualifiesForCompletion({ breakdown, streak = 0 } = {}) {
  const ambiguity = ambiguityFromBreakdown(breakdown);
  const thresholdMet = ambiguity <= AMBIGUITY_THRESHOLD;
  const floorFailures = getFloorFailures(breakdown);
  const streakMet = streak >= AUTO_COMPLETE_STREAK_REQUIRED;
  const qualifies = thresholdMet && floorFailures.length === 0 && streakMet;
  return {
    qualifies,
    ambiguity,
    thresholdMet,
    floorFailures,
    streak,
    streakMet,
  };
}

/**
 * Update the sustained-clarity streak: +1 if *this* turn's breakdown
 * passes both the overall threshold AND every floor; reset to 0
 * otherwise. Matches Ouroboros's `_update_completion_candidate_streak`.
 *
 * @param {number} prevStreak
 * @param {Record<string, { score: number }>} breakdown
 * @returns {number}
 */
export function updateStreak(prevStreak, breakdown) {
  const ambiguity = ambiguityFromBreakdown(breakdown);
  const floorFails = getFloorFailures(breakdown);
  const qualifyingNow = ambiguity <= AMBIGUITY_THRESHOLD && floorFails.length === 0;
  return qualifyingNow ? Math.max(0, prevStreak) + 1 : 0;
}

/**
 * Milestone label for a given score — used by the UI and snapshot
 * prompt so the model knows how far along the interview is.
 *
 * @param {number} score - Ambiguity in [0, 1].
 * @returns {'initial' | 'progress' | 'refined' | 'ready'}
 */
export function milestoneFromScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'initial';
  if (score <= 0.2) return 'ready';
  if (score <= 0.3) return 'refined';
  if (score <= 0.4) return 'progress';
  return 'initial';
}

/**
 * Return the weakest dimension (highest (floor - score) deficit, or
 * lowest score if none are below floor). Ties break by `DIMENSIONS`
 * order. Returns `null` for an empty breakdown.
 *
 * @param {Record<string, { score: number, justification?: string }>} breakdown
 * @returns {{ key: string, label: string, score: number, floor: number, justification: string } | null}
 */
export function weakestDimension(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return null;
  let worst = null;
  for (const dim of DIMENSIONS) {
    const entry = breakdown[dim.key];
    const score = entry && typeof entry.score === 'number' ? entry.score : 0;
    const deficit = dim.floor - score;
    const candidate = {
      key: dim.key,
      label: dim.label,
      score,
      floor: dim.floor,
      deficit,
      justification: (entry && typeof entry.justification === 'string') ? entry.justification : '',
    };
    if (!worst || candidate.deficit > worst.deficit) worst = candidate;
  }
  if (!worst) return null;
  // Strip the internal `deficit` field from the public shape.
  const { deficit: _, ...rest } = worst;
  void _;
  return rest;
}

/**
 * Render a compact human-readable ambiguity snapshot that the skill
 * markdown can splice into the next-question prompt. The goal is to let
 * the question-generating model *read numbers* — the biggest trick in
 * Ouroboros's flow.
 *
 * @param {object} args
 * @param {Record<string, { score: number, justification?: string }>} args.breakdown
 * @param {number} args.streak
 * @returns {string}
 */
export function buildAmbiguitySnapshot({ breakdown, streak = 0 } = {}) {
  const ambiguity = ambiguityFromBreakdown(breakdown);
  const milestone = milestoneFromScore(ambiguity);
  const { qualifies, thresholdMet, floorFailures, streakMet } = qualifiesForCompletion({
    breakdown,
    streak,
  });
  const weakest = weakestDimension(breakdown);

  const lines = [
    '## Ambiguity snapshot',
    '',
    `- Overall ambiguity: ${ambiguity.toFixed(2)} (milestone: ${milestone})`,
    `- Overall threshold met (≤ ${AMBIGUITY_THRESHOLD}): ${thresholdMet ? 'yes' : 'no'}`,
    `- Streak: ${streak}/${AUTO_COMPLETE_STREAK_REQUIRED}${streakMet ? ' (met)' : ''}`,
    `- Seed-ready now: ${qualifies ? 'yes' : 'no'}`,
  ];

  if (floorFailures.length > 0) {
    lines.push('- Floor failures:');
    for (const f of floorFailures) {
      lines.push(`  - ${f.label}: ${f.score.toFixed(2)} < ${f.floor.toFixed(2)}`);
    }
  }

  if (weakest) {
    lines.push(
      `- Weakest area: ${weakest.label} (${weakest.score.toFixed(2)} clarity, floor ${weakest.floor.toFixed(2)})`,
    );
    if (weakest.justification) {
      lines.push(`  Reason: ${weakest.justification}`);
    }
  }

  lines.push(
    '- Drill into the weakest area until its floor is met.',
    '- A single qualifying score is not enough — require a sustained streak before closure.',
  );

  return lines.join('\n');
}

/**
 * Build the scoring-prompt payload the planner skill feeds to an LLM
 * between question rounds. Returns the text to send; the caller decides
 * how to invoke the model (Claude Code subagent, Task tool, direct
 * completion, etc.) and parses the JSON response via
 * {@link parseScoreResponse}.
 *
 * @param {object} args
 * @param {string} args.initialContext - The user's top-level plan intent.
 * @param {Array<{ question: string, answer: string }>} args.transcript - Prior Q&A.
 * @returns {{ system: string, user: string }}
 */
export function buildScoringPrompt({ initialContext = '', transcript = [] } = {}) {
  const dimensionSpec = DIMENSIONS.map(
    (d) =>
      `  - ${d.key} (${Math.round(d.weight * 100)}%, floor ${d.floor}): ${d.hint}`,
  ).join('\n');

  const system = [
    'You are an expert planning analyst. Evaluate how clearly a user has',
    'specified a weekly plan for a scheduled AI agent. Return ONLY valid',
    'JSON — no prose, no code fences.',
    '',
    'Score each dimension from 0.0 (completely unclear) to 1.0 (precisely',
    'specified). Scores ≥ 0.80 require specific, concrete commitments, not',
    'aspirational statements. Intentional "decide later" deferrals are NOT',
    'penalised — treat them as deliberate, not ambiguous.',
    '',
    'Dimensions:',
    dimensionSpec,
    '',
    'Output shape:',
    '{',
    '  "goalClarity":         { "score": 0.00, "justification": "..." },',
    '  "taskSpecificity":     { "score": 0.00, "justification": "..." },',
    '  "prioritySequencing":  { "score": 0.00, "justification": "..." },',
    '  "constraintClarity":   { "score": 0.00, "justification": "..." }',
    '}',
  ].join('\n');

  const lines = [`Initial plan intent: ${initialContext || '(not provided)'}`, '', 'Interview transcript:'];
  if (transcript.length === 0) {
    lines.push('(no Q&A yet)');
  } else {
    for (const [i, turn] of transcript.entries()) {
      lines.push(`Q${i + 1}: ${turn.question || ''}`);
      lines.push(`A${i + 1}: ${turn.answer || ''}`);
    }
  }
  lines.push('', 'Return JSON only.');

  return { system, user: lines.join('\n') };
}

/**
 * Parse and validate the LLM's JSON score output. Tolerates code-fence
 * wrapping and leading/trailing prose so a slightly chatty model still
 * produces usable data — Ouroboros's scorer does similar cleanup.
 *
 * @param {string} raw
 * @returns {{
 *   ok: true,
 *   breakdown: Record<string, { score: number, justification: string }>,
 * } | { ok: false, error: string }}
 */
export function parseScoreResponse(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: 'Empty response' };
  }

  const cleaned = stripCodeFence(raw.trim());
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return { ok: false, error: 'No JSON object found' };
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err.message}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Response was not an object' };
  }

  const breakdown = {};
  for (const dim of DIMENSIONS) {
    const entry = parsed[dim.key];
    if (!entry || typeof entry.score !== 'number' || Number.isNaN(entry.score)) {
      return { ok: false, error: `Missing or invalid score for ${dim.key}` };
    }
    breakdown[dim.key] = {
      score: Math.max(0, Math.min(1, entry.score)),
      justification:
        typeof entry.justification === 'string' ? entry.justification : '',
    };
  }

  return { ok: true, breakdown };
}

function stripCodeFence(s) {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const m = s.match(fence);
  return m ? m[1] : s;
}
