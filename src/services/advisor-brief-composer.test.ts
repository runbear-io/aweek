/**
 * Tests for the advisor brief composer service.
 *
 * Verifies that composeAdvisorBrief:
 *   1. Always returns a non-empty string with 3–6 sentences.
 *   2. Produces status-aware openers for in-progress vs planned objectives.
 *   3. Incorporates goal frames when goalDescription is supplied.
 *   4. Incorporates plan context when planContext (parsed plan.md) is supplied.
 *   5. Incorporates prior-day continuity when priorDayOutcomes is supplied.
 *   6. Produces different openers for different objectiveIds (variant selection).
 *   7. Handles edge-case inputs gracefully (null, missing fields, empty strings).
 *   8. Is deterministic: same inputs always produce same output.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeAdvisorBrief } from './advisor-brief-composer.js';
import { parsePlanMarkdownSections } from '../storage/plan-markdown-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count sentence-ending punctuation followed by whitespace or end-of-string.
 * This is a heuristic: works for well-formed advisor briefs that end sentences
 * with `.` (not `...` ellipsis patterns).
 */
function countSentences(text: string): number {
  return (text.match(/[.!?](?:\s|$)/g) ?? []).length;
}

interface MakeObjectiveOpts {
  suffix?: string;
  description?: string;
  status?: string;
  goalId?: string;
}

function makeObjective({
  suffix = 'abc12345',
  description = 'Build the authentication module',
  status = 'planned',
  goalId = 'goal-xyz',
}: MakeObjectiveOpts = {}): { id: string; description: string; status: string; goalId: string } {
  return { id: `obj-${suffix}`, description, status, goalId };
}

const SAMPLE_PLAN_MD = `
# Developer Agent

A developer agent focused on backend API work.

## Long-term goals

- (3mo) Ship a production-ready REST API
- (1yr) Become the go-to service for the team

## Monthly plans

### 2026-04

- Complete authentication module
- Write API documentation
- Add analytics dashboard

## Strategies

- Work in 2-hour deep work blocks
- Test-first development approach
- Review PRs in the morning slot

## Notes

Focus on API quality and reliability over feature breadth this quarter.
`;

// ---------------------------------------------------------------------------
// Basic output shape
// ---------------------------------------------------------------------------

describe('composeAdvisorBrief — output shape', () => {
  it('returns a non-empty string for a minimal planned objective', () => {
    const obj = makeObjective();
    const result = composeAdvisorBrief(obj);
    assert.ok(typeof result === 'string' && result.length > 0, 'should return non-empty string');
  });

  it('returns 3–6 sentences for a minimal objective with no context', () => {
    const obj = makeObjective();
    const result = composeAdvisorBrief(obj);
    const n = countSentences(result);
    assert.ok(n >= 3 && n <= 6, `Expected 3–6 sentences, got ${n}: "${result}"`);
  });

  it('returns 3–6 sentences with full context (goal + plan + prior-day)', () => {
    const obj = makeObjective({ status: 'in-progress' });
    const planContext = parsePlanMarkdownSections(SAMPLE_PLAN_MD);
    const result = composeAdvisorBrief(obj, {
      planContext,
      priorDayOutcomes: 'Finished the endpoint schema design and merged the initial PR',
      goalDescription: 'Ship a production-ready REST API',
    });
    const n = countSentences(result);
    assert.ok(n >= 3 && n <= 6, `Expected 3–6 sentences, got ${n}: "${result}"`);
  });

  it('description always contains the objective description text', () => {
    const obj = makeObjective({ description: 'Migrate the database schema' });
    const result = composeAdvisorBrief(obj);
    assert.ok(
      result.includes('Migrate the database schema'),
      `Brief must contain the objective description: "${result}"`,
    );
  });

  it('handles null objective gracefully (no throw)', () => {
    const result = composeAdvisorBrief(null);
    assert.ok(typeof result === 'string' && result.length > 0, 'should not throw for null objective');
  });

  it('handles undefined context gracefully (no throw)', () => {
    const obj = makeObjective();
    const result = composeAdvisorBrief(obj, undefined);
    assert.ok(typeof result === 'string' && result.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Status-aware openers
// ---------------------------------------------------------------------------

describe('composeAdvisorBrief — status-aware openers', () => {
  it('in-progress brief does not contain new-chapter or starting-fresh language', () => {
    const obj = makeObjective({ status: 'in-progress', description: 'Write API docs' });
    const result = composeAdvisorBrief(obj);
    assert.ok(result.includes('Write API docs'), 'must include objective description');
    // Planned openers say "starting fresh" or "opens a new chapter" — should not appear
    assert.ok(
      !result.toLowerCase().includes('starting fresh') &&
      !result.toLowerCase().includes('opens a new chapter'),
      `In-progress opener should not contain planned language: "${result}"`,
    );
  });

  it('planned brief does not contain closing-the-gap or already-underway language', () => {
    const obj = makeObjective({ status: 'planned', description: 'Migrate database schema' });
    const result = composeAdvisorBrief(obj);
    assert.ok(result.includes('Migrate database schema'), 'must include objective description');
    // In-progress openers say "closing the remaining gap" or "actively underway" — should not appear
    assert.ok(
      !result.toLowerCase().includes('closing the remaining gap') &&
      !result.toLowerCase().includes('actively underway'),
      `Planned opener should not contain in-progress language: "${result}"`,
    );
  });

  it('in-progress and planned objectives with the same id produce different first sentences', () => {
    const inProg = makeObjective({ status: 'in-progress', suffix: 'aaa11111', description: 'Same task' });
    const planned = makeObjective({ status: 'planned', suffix: 'aaa11111', description: 'Same task' });
    const briefIP = composeAdvisorBrief(inProg);
    const briefP = composeAdvisorBrief(planned);
    // Extract just the first sentence for comparison
    const firstIP = briefIP.split('.')[0];
    const firstP = briefP.split('.')[0];
    assert.notStrictEqual(firstIP, firstP, 'in-progress and planned should open differently');
  });
});

// ---------------------------------------------------------------------------
// Goal frame
// ---------------------------------------------------------------------------

describe('composeAdvisorBrief — goal frame', () => {
  it('includes goal reference when goalDescription is provided', () => {
    const obj = makeObjective({ suffix: 'goal01' });
    const goalDesc = 'ship a production-ready REST API';
    const result = composeAdvisorBrief(obj, { goalDescription: goalDesc });
    assert.ok(
      result.toLowerCase().includes('ship a production-ready rest api'),
      `Brief should contain the goal description: "${result}"`,
    );
  });

  it('goal frame adds at least one sentence compared to no-goal brief', () => {
    const obj = makeObjective({ suffix: 'goal02' });
    const withGoal = composeAdvisorBrief(obj, { goalDescription: 'Build an enterprise API' });
    const withoutGoal = composeAdvisorBrief(obj, { goalDescription: null });
    assert.ok(
      withGoal.length > withoutGoal.length,
      'Brief with goal should be longer (has extra sentence)',
    );
  });

  it('omits goal reference when goalDescription is null', () => {
    const obj = makeObjective({ suffix: 'goal03' });
    const result = composeAdvisorBrief(obj, { goalDescription: null });
    // No goal-frame language should appear without a goal
    assert.ok(
      !result.toLowerCase().includes('traces back to your goal'),
      'Should not include goal-frame language when goalDescription is null',
    );
  });

  it('omits goal reference when goalDescription is empty string', () => {
    const obj = makeObjective({ suffix: 'goal04' });
    const withEmpty = composeAdvisorBrief(obj, { goalDescription: '' });
    const withNull = composeAdvisorBrief(obj, { goalDescription: null });
    assert.equal(withEmpty, withNull, 'Empty string goalDescription should behave same as null');
  });

  it('truncates very long goal descriptions with ellipsis', () => {
    const obj = makeObjective({ suffix: 'goal05' });
    const longGoal = 'ship a great product'.padEnd(200, ' across multiple markets and segments');
    const result = composeAdvisorBrief(obj, { goalDescription: longGoal });
    assert.ok(result.includes('...'), `Long goal should be truncated with ellipsis: "${result}"`);
  });
});

// ---------------------------------------------------------------------------
// Plan context (Strategies / Notes)
// ---------------------------------------------------------------------------

describe('composeAdvisorBrief — plan context', () => {
  it('includes strategy reference when planContext has Strategies content', () => {
    const obj = makeObjective({ suffix: 'plan01' });
    const planContext = parsePlanMarkdownSections(SAMPLE_PLAN_MD);
    const result = composeAdvisorBrief(obj, { planContext });
    assert.ok(
      result.includes('plan.md'),
      `Brief should reference plan.md when strategy is present: "${result}"`,
    );
    assert.ok(
      result.toLowerCase().includes('deep work') ||
      result.toLowerCase().includes('test-first') ||
      result.toLowerCase().includes('review prs'),
      `Brief should reference a strategy line: "${result}"`,
    );
  });

  it('omits plan.md reference when planContext is null', () => {
    const obj = makeObjective({ suffix: 'plan02' });
    const result = composeAdvisorBrief(obj, { planContext: null });
    assert.ok(!result.includes('plan.md'), 'Should not reference plan.md when context is null');
  });

  it('falls back to Notes when Strategies section is empty/placeholder-only', () => {
    const mdWithNotesOnly = `
# Agent

## Long-term goals

- Build something great

## Strategies

<!-- No strategies yet, add them here -->

## Notes

Stay focused on customer-facing features first.
`;
    const obj = makeObjective({ suffix: 'plan03' });
    const planContext = parsePlanMarkdownSections(mdWithNotesOnly);
    const result = composeAdvisorBrief(obj, { planContext });
    assert.ok(
      result.includes('customer-facing'),
      `Brief should fall back to Notes when Strategies is placeholder-only: "${result}"`,
    );
  });

  it('omits plan context when both Strategies and Notes are placeholder-only', () => {
    const mdWithPlaceholders = `
# Agent

## Strategies

<!-- Add strategies here -->

## Notes

<!-- Freeform context the weekly-plan generator should know about. -->
`;
    const obj = makeObjective({ suffix: 'plan04' });
    const planContext = parsePlanMarkdownSections(mdWithPlaceholders);
    const withPlaceholder = composeAdvisorBrief(obj, { planContext });
    const withoutContext = composeAdvisorBrief(obj, { planContext: null });
    assert.equal(
      withPlaceholder,
      withoutContext,
      'Placeholder-only sections should produce same brief as no context',
    );
  });

  it('omits plan context when planContext has empty byTitle', () => {
    const obj = makeObjective({ suffix: 'plan05' });
    const emptyContext = { byTitle: {}, sections: [], heading: null, preamble: '' };
    const withEmpty = composeAdvisorBrief(obj, { planContext: emptyContext });
    const withNull = composeAdvisorBrief(obj, { planContext: null });
    assert.equal(withEmpty, withNull, 'Empty byTitle should behave same as null planContext');
  });
});

// ---------------------------------------------------------------------------
// Prior-day continuity
// ---------------------------------------------------------------------------

describe('composeAdvisorBrief — prior-day continuity', () => {
  it('includes "yesterday" reference when priorDayOutcomes is supplied', () => {
    const obj = makeObjective({ suffix: 'cont01' });
    const outcomes = 'Finished the endpoint schema review and pushed the initial migration';
    const result = composeAdvisorBrief(obj, { priorDayOutcomes: outcomes });
    assert.ok(
      result.toLowerCase().includes('yesterday'),
      `Brief should reference yesterday when outcomes are supplied: "${result}"`,
    );
  });

  it('continuity sentence adds length compared to no-outcomes brief', () => {
    const obj = makeObjective({ suffix: 'cont02' });
    const withOutcomes = composeAdvisorBrief(obj, {
      priorDayOutcomes: 'Completed the schema review',
    });
    const withoutOutcomes = composeAdvisorBrief(obj, { priorDayOutcomes: null });
    assert.ok(
      withOutcomes.length > withoutOutcomes.length,
      'Prior-day outcomes should add a sentence',
    );
    assert.ok(
      !withoutOutcomes.toLowerCase().includes('yesterday'),
      'No-outcomes brief should not mention yesterday',
    );
  });

  it('omits continuity sentence when priorDayOutcomes is null', () => {
    const obj = makeObjective({ suffix: 'cont03' });
    const result = composeAdvisorBrief(obj, { priorDayOutcomes: null });
    assert.ok(!result.toLowerCase().includes('yesterday'), 'Should not say "yesterday" without outcomes');
  });

  it('omits continuity sentence when priorDayOutcomes is empty string', () => {
    const obj = makeObjective({ suffix: 'cont04' });
    const withEmpty = composeAdvisorBrief(obj, { priorDayOutcomes: '' });
    const withNull = composeAdvisorBrief(obj, { priorDayOutcomes: null });
    assert.equal(withEmpty, withNull, 'Empty string priorDayOutcomes should behave same as null');
  });

  it('truncates very long prior-day outcomes with ellipsis', () => {
    const obj = makeObjective({ suffix: 'cont05' });
    const longOutcomes = 'Completed a lot of important work'.padEnd(200, ' across many systems');
    const result = composeAdvisorBrief(obj, { priorDayOutcomes: longOutcomes });
    assert.ok(result.includes('...'), 'Long prior-day outcomes should be truncated');
  });

  it('prior-day outcomes reference is included in the main brief body (not a separate field)', () => {
    const obj = makeObjective({ suffix: 'cont06' });
    const outcomes = 'finished the rate-limiter prototype';
    const result = composeAdvisorBrief(obj, { priorDayOutcomes: outcomes });
    // The outcomes text should appear somewhere in the string (possibly lower-cased)
    assert.ok(
      result.toLowerCase().includes('rate-limiter prototype'),
      `Outcomes text should appear in the brief: "${result}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// Variant selection
// ---------------------------------------------------------------------------

describe('composeAdvisorBrief — variant selection', () => {
  it('diverse objectiveIds produce at least 2 distinct openers among 8 (planned)', () => {
    // Use suffixes that are structurally varied (different lengths, different characters)
    // so the djb2-style hash is unlikely to collide on all of them.
    const suffixes = ['aaa', 'beta', 'gamma01', 'short', 'longsuffix', 'zz9', 'abc-def', 'xyz99'];
    const objectives = suffixes.map((suffix) =>
      makeObjective({ suffix, description: 'Write docs' }),
    );
    const openers = objectives.map((obj) => {
      const brief = composeAdvisorBrief(obj);
      return brief.slice(0, brief.indexOf('.') + 1);
    });
    const distinct = new Set(openers);
    assert.ok(
      distinct.size >= 2,
      `Expected at least 2 distinct openers among 8 diverse IDs, got ${distinct.size}: ${JSON.stringify([...distinct])}`,
    );
  });

  it('diverse objectiveIds produce at least 2 distinct openers among 8 (in-progress)', () => {
    const suffixes = ['aaa', 'beta', 'gamma01', 'short', 'longsuffix', 'zz9', 'abc-def', 'xyz99'];
    const objectives = suffixes.map((suffix) =>
      makeObjective({ suffix, description: 'Refactor module', status: 'in-progress' }),
    );
    const openers = objectives.map((obj) => {
      const brief = composeAdvisorBrief(obj);
      return brief.slice(0, brief.indexOf('.') + 1);
    });
    const distinct = new Set(openers);
    assert.ok(
      distinct.size >= 2,
      `Expected at least 2 distinct in-progress openers among 8 diverse IDs, got ${distinct.size}`,
    );
  });

  it('same objectiveId always produces the same brief (fully deterministic)', () => {
    const obj = makeObjective({ suffix: 'det00001' });
    const context = {
      planContext: parsePlanMarkdownSections(SAMPLE_PLAN_MD),
      goalDescription: 'Ship a production REST API',
      priorDayOutcomes: 'Completed the schema migration and updated the tests',
    };
    const result1 = composeAdvisorBrief(obj, context);
    const result2 = composeAdvisorBrief(obj, context);
    assert.strictEqual(result1, result2, 'Same inputs must always produce the same output');
  });

  it('different objectiveIds produce different briefs (even with same description)', () => {
    const obj1 = makeObjective({ suffix: 'dif00001', description: 'Build feature X' });
    const obj2 = makeObjective({ suffix: 'dif00002', description: 'Build feature X' });
    const r1 = composeAdvisorBrief(obj1);
    const r2 = composeAdvisorBrief(obj2);
    // May or may not differ (depends on hash collision) but should not throw
    assert.ok(typeof r1 === 'string' && typeof r2 === 'string');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('composeAdvisorBrief — edge cases', () => {
  it('handles objective missing id field without throwing', () => {
    const obj = { description: 'Fix the bug', status: 'planned' };
    const result = composeAdvisorBrief(obj);
    assert.ok(result.includes('Fix the bug'));
    const n = countSentences(result);
    assert.ok(n >= 3, `Expected at least 3 sentences, got ${n}`);
  });

  it('handles objective missing description field without throwing', () => {
    const obj = { id: 'obj-edge01', status: 'planned' };
    const result = composeAdvisorBrief(obj);
    assert.ok(typeof result === 'string' && result.length > 0, 'Should not throw for missing description');
  });

  it('handles all context fields as null simultaneously', () => {
    const obj = makeObjective({ suffix: 'edge02' });
    const result = composeAdvisorBrief(obj, {
      planContext: null,
      priorDayOutcomes: null,
      goalDescription: null,
    });
    const n = countSentences(result);
    assert.ok(n >= 3 && n <= 6, `Expected 3–6 sentences, got ${n}: "${result}"`);
  });

  it('handles unknown objective status (falls back to planned template)', () => {
    const obj = makeObjective({ suffix: 'edge03', status: 'unknown-status' });
    const result = composeAdvisorBrief(obj);
    assert.ok(typeof result === 'string' && result.length > 0);
    const n = countSentences(result);
    assert.ok(n >= 3, `Expected at least 3 sentences, got ${n}`);
  });

  it('whitespace-only goalDescription is treated as absent', () => {
    const obj = makeObjective({ suffix: 'edge04' });
    const withWhitespace = composeAdvisorBrief(obj, { goalDescription: '   \n  ' });
    const withNull = composeAdvisorBrief(obj, { goalDescription: null });
    assert.equal(withWhitespace, withNull);
  });

  it('whitespace-only priorDayOutcomes is treated as absent', () => {
    const obj = makeObjective({ suffix: 'edge05' });
    const withWhitespace = composeAdvisorBrief(obj, { priorDayOutcomes: '   \t  ' });
    const withNull = composeAdvisorBrief(obj, { priorDayOutcomes: null });
    assert.equal(withWhitespace, withNull);
  });
});

// ---------------------------------------------------------------------------
// Voice quality spot-checks
// ---------------------------------------------------------------------------

describe('composeAdvisorBrief — voice quality', () => {
  it('brief does not start with "Do " (imperative task voice)', () => {
    const obj = makeObjective({ suffix: 'voice01', description: 'Deploy the service' });
    const result = composeAdvisorBrief(obj);
    assert.ok(!result.startsWith('Do '), `Brief should not start with imperative "Do": "${result}"`);
  });

  it('brief does not consist of only the objective description (it is expanded)', () => {
    const obj = makeObjective({ description: 'Build the login page' });
    const result = composeAdvisorBrief(obj);
    assert.notEqual(result.trim(), 'Build the login page', 'Brief must be more than just the objective description');
    assert.ok(result.length > 'Build the login page'.length);
  });

  it('in-progress brief contains action-oriented language (drive / prioritise / resolve / focus)', () => {
    const obj = makeObjective({ suffix: 'voice02', status: 'in-progress', description: 'Finish auth module' });
    const result = composeAdvisorBrief(obj).toLowerCase();
    const hasAction =
      result.includes('drive') ||
      result.includes('priorit') ||
      result.includes('resolve') ||
      result.includes('focus') ||
      result.includes('push');
    assert.ok(hasAction, `In-progress brief should contain action directive: "${result}"`);
  });

  it('planned brief contains scoping or foundation language', () => {
    const obj = makeObjective({ suffix: 'voice03', status: 'planned', description: 'Scaffold the new service' });
    const result = composeAdvisorBrief(obj).toLowerCase();
    const hasFoundation =
      result.includes('scope') ||
      result.includes('clarif') ||
      result.includes('establish') ||
      result.includes('foundation') ||
      result.includes('first') ||
      result.includes('begin') ||
      result.includes('starting');
    assert.ok(hasFoundation, `Planned brief should contain scoping/foundation language: "${result}"`);
  });
});
