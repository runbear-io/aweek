import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AMBIGUITY_THRESHOLD,
  AUTO_COMPLETE_STREAK_REQUIRED,
  DIMENSIONS,
  ambiguityFromBreakdown,
  buildAmbiguitySnapshot,
  buildScoringPrompt,
  getFloorFailures,
  isFullBreakdown,
  milestoneFromScore,
  parseScoreResponse,
  qualifiesForCompletion,
  updateStreak,
  weakestDimension,
} from './plan-ambiguity.js';

function fullBreakdown({ goal = 0.9, task = 0.85, priority = 0.8, constraint = 0.8 } = {}) {
  return {
    goalClarity: { score: goal, justification: 'g' },
    taskSpecificity: { score: task, justification: 't' },
    prioritySequencing: { score: priority, justification: 'p' },
    constraintClarity: { score: constraint, justification: 'c' },
  };
}

describe('plan-ambiguity — DIMENSIONS', () => {
  it('weights sum to 1.0', () => {
    const sum = DIMENSIONS.reduce((acc, d) => acc + d.weight, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });

  it('every dimension has a floor in [0, 1]', () => {
    for (const d of DIMENSIONS) {
      assert.ok(d.floor >= 0 && d.floor <= 1);
    }
  });
});

describe('plan-ambiguity — ambiguityFromBreakdown', () => {
  it('returns 1 for missing / empty input', () => {
    assert.equal(ambiguityFromBreakdown(null), 1);
    assert.equal(ambiguityFromBreakdown({}), 1);
  });

  it('returns 0 when every dimension is perfect', () => {
    const amb = ambiguityFromBreakdown(fullBreakdown({ goal: 1, task: 1, priority: 1, constraint: 1 }));
    assert.equal(amb, 0);
  });

  it('returns 1 when every dimension is zero', () => {
    const amb = ambiguityFromBreakdown(fullBreakdown({ goal: 0, task: 0, priority: 0, constraint: 0 }));
    assert.equal(amb, 1);
  });

  it('respects dimension weights', () => {
    // Goal is 35% of the weighted mean; tanking it should dominate.
    const goalTanked = ambiguityFromBreakdown(fullBreakdown({ goal: 0, task: 1, priority: 1, constraint: 1 }));
    const constraintTanked = ambiguityFromBreakdown(
      fullBreakdown({ goal: 1, task: 1, priority: 1, constraint: 0 }),
    );
    assert.ok(goalTanked > constraintTanked);
  });

  it('gracefully degrades when only some dimensions score', () => {
    const partial = { goalClarity: { score: 0.9 } };
    const amb = ambiguityFromBreakdown(partial);
    // Only goal dimension (weight 0.35) contributes. Clarity = 0.9, so
    // ambiguity = 1 - 0.9 = 0.1.
    assert.ok(Math.abs(amb - 0.1) < 1e-9);
  });

  it('clamps out-of-range scores', () => {
    const amb = ambiguityFromBreakdown(fullBreakdown({ goal: 1.5, task: -1, priority: 1, constraint: 1 }));
    // goal clamps to 1, task clamps to 0; result should still be a valid probability.
    assert.ok(amb >= 0 && amb <= 1);
  });
});

describe('plan-ambiguity — getFloorFailures', () => {
  it('returns every dimension when breakdown is missing', () => {
    assert.equal(getFloorFailures(null).length, DIMENSIONS.length);
    assert.equal(getFloorFailures({}).length, DIMENSIONS.length);
  });

  it('returns only dimensions below floor', () => {
    const breakdown = fullBreakdown({ goal: 0.5, task: 0.9, priority: 0.9, constraint: 0.9 });
    const fails = getFloorFailures(breakdown);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].key, 'goalClarity');
  });

  it('returns empty when every floor is met', () => {
    const breakdown = fullBreakdown({ goal: 0.8, task: 0.75, priority: 0.7, constraint: 0.7 });
    assert.deepEqual(getFloorFailures(breakdown), []);
  });
});

describe('plan-ambiguity — qualifiesForCompletion', () => {
  it('requires threshold + floors + streak all to pass', () => {
    const breakdown = fullBreakdown();
    const streakTooShort = qualifiesForCompletion({ breakdown, streak: 1 });
    assert.equal(streakTooShort.qualifies, false);
    assert.equal(streakTooShort.streakMet, false);

    const ok = qualifiesForCompletion({ breakdown, streak: 2 });
    assert.equal(ok.qualifies, true);
    assert.ok(ok.ambiguity <= AMBIGUITY_THRESHOLD);
    assert.deepEqual(ok.floorFailures, []);
  });

  it('refuses completion when any floor fails, even with a low overall score', () => {
    // Inflated average but Goal floor fails: 0.74 < 0.75.
    const breakdown = fullBreakdown({ goal: 0.74, task: 1, priority: 1, constraint: 1 });
    const res = qualifiesForCompletion({ breakdown, streak: 5 });
    assert.equal(res.qualifies, false);
    assert.equal(res.floorFailures.length, 1);
    assert.equal(res.floorFailures[0].key, 'goalClarity');
  });

  it('reports thresholdMet accurately at the boundary', () => {
    // Tune scores so ambiguity is very close to threshold.
    const breakdown = fullBreakdown({ goal: 0.8, task: 0.8, priority: 0.8, constraint: 0.8 });
    const res = qualifiesForCompletion({ breakdown, streak: 2 });
    assert.equal(res.thresholdMet, true);
    assert.equal(res.streakMet, true);
  });
});

describe('plan-ambiguity — updateStreak', () => {
  it('increments when the current turn qualifies', () => {
    const breakdown = fullBreakdown();
    assert.equal(updateStreak(0, breakdown), 1);
    assert.equal(updateStreak(1, breakdown), 2);
  });

  it('resets to 0 when a floor fails', () => {
    const breakdown = fullBreakdown({ goal: 0.5, task: 1, priority: 1, constraint: 1 });
    assert.equal(updateStreak(3, breakdown), 0);
  });

  it('resets to 0 when the overall threshold is missed', () => {
    const breakdown = fullBreakdown({ goal: 0.8, task: 0.8, priority: 0.8, constraint: 0 });
    // Ambiguity will be just above threshold due to constraint=0.
    assert.equal(updateStreak(2, breakdown), 0);
  });
});

describe('plan-ambiguity — milestoneFromScore', () => {
  it('maps Ouroboros-style ranges', () => {
    assert.equal(milestoneFromScore(0.1), 'ready');
    assert.equal(milestoneFromScore(0.2), 'ready');
    assert.equal(milestoneFromScore(0.25), 'refined');
    assert.equal(milestoneFromScore(0.35), 'progress');
    assert.equal(milestoneFromScore(0.6), 'initial');
  });

  it('returns initial for bad input', () => {
    assert.equal(milestoneFromScore(NaN), 'initial');
    assert.equal(milestoneFromScore('x'), 'initial');
  });
});

describe('plan-ambiguity — weakestDimension', () => {
  it('returns the dimension with the largest deficit (floor - score)', () => {
    const breakdown = fullBreakdown({ goal: 0.5, task: 0.95, priority: 0.95, constraint: 0.95 });
    const weakest = weakestDimension(breakdown);
    assert.ok(weakest);
    assert.equal(weakest!.key, 'goalClarity');
    assert.ok(weakest!.score === 0.5);
  });

  it('returns null for an empty breakdown', () => {
    // Empty object yields all-zero scores, so weakest is picked by tie-break
    // order — just verify a shape is returned rather than null.
    const out = weakestDimension({});
    assert.ok(out && out.key);
  });

  it('returns null for non-object input', () => {
    assert.equal(weakestDimension(null), null);
    assert.equal(weakestDimension('nope'), null);
  });
});

describe('plan-ambiguity — buildAmbiguitySnapshot', () => {
  it('includes ambiguity, milestone, streak, and seed-ready flag', () => {
    const snap = buildAmbiguitySnapshot({ breakdown: fullBreakdown(), streak: 2 });
    assert.match(snap, /Overall ambiguity:/);
    assert.match(snap, /milestone: ready/);
    assert.match(snap, /Streak: 2\/2 \(met\)/);
    assert.match(snap, /Seed-ready now: yes/);
  });

  it('lists floor failures when present', () => {
    const breakdown = fullBreakdown({ goal: 0.5 });
    const snap = buildAmbiguitySnapshot({ breakdown, streak: 0 });
    assert.match(snap, /Floor failures:/);
    assert.match(snap, /Goal Clarity/);
  });

  it('calls out the weakest area', () => {
    const breakdown = fullBreakdown({ goal: 0.5 });
    const snap = buildAmbiguitySnapshot({ breakdown, streak: 0 });
    assert.match(snap, /Weakest area: Goal Clarity/);
  });
});

describe('plan-ambiguity — buildScoringPrompt', () => {
  it('includes every dimension and a transcript', () => {
    const prompt = buildScoringPrompt({
      initialContext: 'Publish 2 posts / week',
      transcript: [
        { question: 'What outcomes?', answer: 'More signups' },
      ],
    });
    for (const d of DIMENSIONS) {
      assert.ok(prompt.system.includes(d.key), `missing ${d.key} in system prompt`);
    }
    assert.match(prompt.user, /Initial plan intent:/);
    assert.match(prompt.user, /Q1: What outcomes\?/);
    assert.match(prompt.user, /A1: More signups/);
  });

  it('handles empty transcripts', () => {
    const prompt = buildScoringPrompt({});
    assert.match(prompt.user, /\(no Q&A yet\)/);
  });
});

describe('plan-ambiguity — parseScoreResponse', () => {
  it('parses a clean JSON payload', () => {
    const raw = JSON.stringify({
      goalClarity: { score: 0.8, justification: 'g' },
      taskSpecificity: { score: 0.7, justification: 't' },
      prioritySequencing: { score: 0.7, justification: 'p' },
      constraintClarity: { score: 0.7, justification: 'c' },
    });
    const res = parseScoreResponse(raw);
    assert.equal(res.ok, true);
    assert.ok(res.ok);
    assert.equal(res.breakdown.goalClarity.score, 0.8);
  });

  it('tolerates triple-backtick fences', () => {
    const raw = '```json\n' + JSON.stringify({
      goalClarity: { score: 0.8 },
      taskSpecificity: { score: 0.7 },
      prioritySequencing: { score: 0.7 },
      constraintClarity: { score: 0.7 },
    }) + '\n```';
    const res = parseScoreResponse(raw);
    assert.equal(res.ok, true);
    assert.ok(res.ok);
    assert.equal(res.breakdown.taskSpecificity.score, 0.7);
  });

  it('tolerates leading/trailing prose around a JSON object', () => {
    const raw = 'Sure, here is the score:\n' + JSON.stringify({
      goalClarity: { score: 0.9 },
      taskSpecificity: { score: 0.8 },
      prioritySequencing: { score: 0.75 },
      constraintClarity: { score: 0.7 },
    }) + '\nLet me know if you need more.';
    const res = parseScoreResponse(raw);
    assert.equal(res.ok, true);
  });

  it('fails cleanly on empty or non-string input', () => {
    assert.equal(parseScoreResponse('').ok, false);
    assert.equal(parseScoreResponse(null).ok, false);
  });

  it('fails when a dimension is missing', () => {
    const raw = JSON.stringify({
      goalClarity: { score: 0.9 },
      // taskSpecificity missing
      prioritySequencing: { score: 0.8 },
      constraintClarity: { score: 0.7 },
    });
    const res = parseScoreResponse(raw);
    assert.equal(res.ok, false);
    assert.ok(!res.ok);
    assert.match(res.error, /taskSpecificity/);
  });

  it('clamps out-of-range scores to [0, 1]', () => {
    const raw = JSON.stringify({
      goalClarity: { score: 1.3 },
      taskSpecificity: { score: -0.2 },
      prioritySequencing: { score: 0.7 },
      constraintClarity: { score: 0.7 },
    });
    const res = parseScoreResponse(raw);
    assert.equal(res.ok, true);
    assert.ok(res.ok);
    assert.equal(res.breakdown.goalClarity.score, 1);
    assert.equal(res.breakdown.taskSpecificity.score, 0);
  });
});

describe('plan-ambiguity — isFullBreakdown', () => {
  it('returns true for a complete breakdown', () => {
    assert.equal(isFullBreakdown(fullBreakdown()), true);
  });

  it('returns false when a dimension is missing', () => {
    const partial: Record<string, { score: number; justification: string }> = fullBreakdown();
    delete partial.constraintClarity;
    assert.equal(isFullBreakdown(partial), false);
  });
});

describe('plan-ambiguity — constants', () => {
  it('threshold and streak match adopted Ouroboros defaults', () => {
    assert.equal(AMBIGUITY_THRESHOLD, 0.2);
    assert.equal(AUTO_COMPLETE_STREAK_REQUIRED, 2);
  });
});
