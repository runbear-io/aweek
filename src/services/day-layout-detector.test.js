/**
 * Tests for day-layout-detector.js
 *
 * Covers:
 *  - detectDayLayout: empty / null / non-string inputs
 *  - detectDayLayout: theme-days signals (individual and combined)
 *  - detectDayLayout: priority-waterfall signals (individual and combined)
 *  - detectDayLayout: mixed (both present)
 *  - detectDayLayout: mixed (neither present)
 *  - scoreThemeDays: individual signal counts
 *  - scorePriorityWaterfall: individual signal counts
 *  - layoutModeLabel: label lookup
 *  - LAYOUT_MODES: membership
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDayLayout,
  detectDayLayoutWithConfidence,
  scoreThemeDays,
  scorePriorityWaterfall,
  layoutModeLabel,
  LAYOUT_MODES,
} from './day-layout-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal plan.md with no structural signals — used as a neutral baseline. */
const BLANK_PLAN = `
# My Agent

## Long-term goals

Build something useful.

## Strategies

Work hard.
`;

// ---------------------------------------------------------------------------
// detectDayLayout — edge cases
// ---------------------------------------------------------------------------

describe('detectDayLayout — edge cases', () => {
  it('returns mixed for null input', () => {
    assert.equal(detectDayLayout(null), 'mixed');
  });

  it('returns mixed for undefined input', () => {
    assert.equal(detectDayLayout(undefined), 'mixed');
  });

  it('returns mixed for empty string', () => {
    assert.equal(detectDayLayout(''), 'mixed');
  });

  it('returns mixed for whitespace-only string', () => {
    assert.equal(detectDayLayout('   \n\t  '), 'mixed');
  });

  it('returns mixed for non-string input (number)', () => {
    assert.equal(detectDayLayout(42), 'mixed');
  });

  it('returns mixed for plan with no layout signals', () => {
    assert.equal(detectDayLayout(BLANK_PLAN), 'mixed');
  });
});

// ---------------------------------------------------------------------------
// detectDayLayout — theme-days
// ---------------------------------------------------------------------------

describe('detectDayLayout — theme-days', () => {
  it('detects day-name heading (## Monday)', () => {
    const md = `
# Agent Plan

## Long-term goals

Ship features.

## Monday

Research and reading.

## Tuesday

Coding sessions.
`;
    assert.equal(detectDayLayout(md), 'theme-days');
  });

  it('detects day-label at line start (Monday:)', () => {
    const md = `
# Weekly Schedule

Monday: Deep work on the API
Tuesday: Code review and PR merges
Wednesday: Planning and retrospective
`;
    assert.equal(detectDayLayout(md), 'theme-days');
  });

  it('detects plural recurring day names (Mondays:)', () => {
    const md = `
# Strategies

Mondays: kickoff and planning
Tuesdays: deep work
Fridays: review and wrap-up
`;
    assert.equal(detectDayLayout(md), 'theme-days');
  });

  it('detects day assignment syntax (Monday = deep work)', () => {
    const md = `
# Weekly themes

Monday = deep work
Tuesday = research
Friday = admin
`;
    assert.equal(detectDayLayout(md), 'theme-days');
  });

  it('detects scheduling cadence language (every Monday)', () => {
    const md = `
# Strategies

Every Monday we run a planning session.
On Fridays the team does a retrospective.
`;
    assert.equal(detectDayLayout(md), 'theme-days');
  });

  it('detects named theme-day phrases (deep work day)', () => {
    const md = `
# Strategies

Tuesday is my deep work day. Thursday is admin day.
`;
    assert.equal(detectDayLayout(md), 'theme-days');
  });

  it('detects three or more weekday names scattered in the plan', () => {
    const md = `
# Notes

I work best on Monday mornings. Tuesday afternoons are for review.
Wednesday is usually the heaviest meeting day. Thursday I try to keep clear for coding.
`;
    assert.equal(detectDayLayout(md), 'theme-days');
  });

  it('detects Day 1 / Day 2 ordinal sequencing', () => {
    const md = `
# Onboarding Plan

Day 1: environment setup and tool installation.
Day 2: read codebase and run existing tests.
Day 3: first PR.
`;
    assert.equal(detectDayLayout(md), 'theme-days');
  });
});

// ---------------------------------------------------------------------------
// detectDayLayout — priority-waterfall
// ---------------------------------------------------------------------------

describe('detectDayLayout — priority-waterfall', () => {
  it('detects numbered priority label (Priority 1:)', () => {
    const md = `
# Goals

Priority 1: Launch the MVP
Priority 2: Write documentation
Priority 3: Add analytics
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects short priority label (P1:)', () => {
    const md = `
# Objectives

P1: Complete the auth module
P2: Set up CI pipeline
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects "## Priorities" section heading', () => {
    const md = `
# Agent Plan

## Priorities

- Ship the core feature
- Fix critical bugs
- Improve test coverage
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects "## Top Priorities" heading variant', () => {
    const md = `
# Agent Plan

## Top Priorities

- Deliver the API
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects superlative priority language (top priority)', () => {
    const md = `
# Long-term goals

The top priority this quarter is to ship the redesign.
The second priority is improving documentation.
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects MoSCoW must-have / nice-to-have', () => {
    const md = `
# Monthly plans

Must-have: database migration complete
Should-have: new onboarding flow
Nice-to-have: dark mode
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects inline priority tag [critical]', () => {
    const md = `
# Objectives

- Fix auth bug [critical]
- Update readme [low]
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects "priority: high" field syntax', () => {
    const md = `
# Goals

- Ship new feature (priority: high)
- Update tests (priority: medium)
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects hash-ranked goal (#1 goal)', () => {
    const md = `
# Long-term goals

The #1 goal is to reach 1000 active users.
The #2 goal is to reduce churn.
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects tier-or-level framing (Tier 1)', () => {
    const md = `
# Strategies

Tier 1 objectives must be completed before Tier 2 work begins.
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });

  it('detects critical-path language', () => {
    const md = `
# Notes

The critical-path items for this month are: database migration and auth refactor.
`;
    assert.equal(detectDayLayout(md), 'priority-waterfall');
  });
});

// ---------------------------------------------------------------------------
// detectDayLayout — mixed (both signals)
// ---------------------------------------------------------------------------

describe('detectDayLayout — mixed (both signals present)', () => {
  it('returns mixed when both theme-days and priority signals are present', () => {
    const md = `
# Agent Plan

## Monday

Deep work session.

Priority 1: Ship auth module.
Priority 2: Write tests.
`;
    assert.equal(detectDayLayout(md), 'mixed');
  });

  it('returns mixed when must-have language appears alongside day headings', () => {
    const md = `
# Plan

## Tuesday

Must-have: finish the feature branch.
`;
    assert.equal(detectDayLayout(md), 'mixed');
  });

  it('returns mixed when day cadence is mixed with priority tiers', () => {
    const md = `
# Strategies

Every Monday focus on Tier 1 objectives.
Tuesday and Thursday are for Tier 2 work.
`;
    assert.equal(detectDayLayout(md), 'mixed');
  });
});

// ---------------------------------------------------------------------------
// detectDayLayout — mixed (no signals)
// ---------------------------------------------------------------------------

describe('detectDayLayout — mixed (no signals)', () => {
  it('returns mixed for a plan with pure prose and no structure signals', () => {
    const md = `
# Research Agent

## Long-term goals

Become a domain expert in distributed systems.

## Monthly plans

### 2026-04

Work through foundational papers and implement prototypes.

## Notes

Keep notes in Markdown.
`;
    assert.equal(detectDayLayout(md), 'mixed');
  });

  it('returns mixed for an empty plan skeleton', () => {
    assert.equal(detectDayLayout(BLANK_PLAN), 'mixed');
  });
});

// ---------------------------------------------------------------------------
// scoreThemeDays — individual signals
// ---------------------------------------------------------------------------

describe('scoreThemeDays', () => {
  it('returns 0 for blank content', () => {
    assert.equal(scoreThemeDays(''), 0);
  });

  it('returns 0 for plan with no day signals', () => {
    assert.equal(scoreThemeDays(BLANK_PLAN), 0);
  });

  it('increments for day-as-heading signal', () => {
    const before = scoreThemeDays(BLANK_PLAN);
    const after = scoreThemeDays(BLANK_PLAN + '\n## Monday\nDeep work.\n');
    assert.ok(after > before, 'score should increase when day heading is present');
  });

  it('increments for plural-day-recurring signal', () => {
    const score = scoreThemeDays('Mondays: planning and kickoff');
    assert.ok(score > 0);
  });

  it('increments for day-cadence signal', () => {
    const score = scoreThemeDays('Every Tuesday we do code review.');
    assert.ok(score > 0);
  });

  it('counts multiple distinct signals independently', () => {
    const single = scoreThemeDays('## Monday\nDeep work.');
    const multi = scoreThemeDays('## Monday\nDeep work.\n\nEvery Friday: admin day.\n\nTuesday = research.');
    assert.ok(multi > single, 'multiple signals should score higher than one');
  });

  it('does not double-count the same signal pattern', () => {
    // Repeat the same day heading — score stays the same as a single occurrence
    const once = scoreThemeDays('## Monday\nWork.');
    const twice = scoreThemeDays('## Monday\nWork.\n## Monday\nMore work.');
    assert.equal(once, twice);
  });
});

// ---------------------------------------------------------------------------
// scorePriorityWaterfall — individual signals
// ---------------------------------------------------------------------------

describe('scorePriorityWaterfall', () => {
  it('returns 0 for blank content', () => {
    assert.equal(scorePriorityWaterfall(''), 0);
  });

  it('returns 0 for plan with no priority signals', () => {
    assert.equal(scorePriorityWaterfall(BLANK_PLAN), 0);
  });

  it('increments for numbered-priority-label signal', () => {
    const score = scorePriorityWaterfall('Priority 1: launch the feature');
    assert.ok(score > 0);
  });

  it('increments for priorities-heading signal', () => {
    const score = scorePriorityWaterfall('## Priorities\n\n- Ship\n- Test\n');
    assert.ok(score > 0);
  });

  it('increments for moscow signal', () => {
    const score = scorePriorityWaterfall('Must-have: complete migration');
    assert.ok(score > 0);
  });

  it('increments for inline-priority-tag signal', () => {
    const score = scorePriorityWaterfall('Fix login bug [critical]');
    assert.ok(score > 0);
  });

  it('counts multiple distinct signals independently', () => {
    const single = scorePriorityWaterfall('Priority 1: ship feature');
    const multi = scorePriorityWaterfall(
      'Priority 1: ship feature\nMust-have: tests pass\n[critical] auth bug'
    );
    assert.ok(multi > single, 'multiple signals should score higher than one');
  });

  it('does not double-count the same signal pattern', () => {
    const once = scorePriorityWaterfall('Priority 1: A');
    const twice = scorePriorityWaterfall('Priority 1: A\nPriority 1: B');
    assert.equal(once, twice);
  });
});

// ---------------------------------------------------------------------------
// layoutModeLabel
// ---------------------------------------------------------------------------

describe('layoutModeLabel', () => {
  it('returns "Theme Days" for theme-days', () => {
    assert.equal(layoutModeLabel('theme-days'), 'Theme Days');
  });

  it('returns "Priority Waterfall" for priority-waterfall', () => {
    assert.equal(layoutModeLabel('priority-waterfall'), 'Priority Waterfall');
  });

  it('returns "Mixed / Flexible" for mixed', () => {
    assert.equal(layoutModeLabel('mixed'), 'Mixed / Flexible');
  });

  it('returns "Unknown" for unrecognised mode', () => {
    assert.equal(layoutModeLabel('unknown-mode'), 'Unknown');
  });
});

// ---------------------------------------------------------------------------
// LAYOUT_MODES
// ---------------------------------------------------------------------------

describe('LAYOUT_MODES', () => {
  it('contains all three valid modes', () => {
    assert.ok(LAYOUT_MODES.has('theme-days'));
    assert.ok(LAYOUT_MODES.has('priority-waterfall'));
    assert.ok(LAYOUT_MODES.has('mixed'));
  });

  it('has exactly 3 members', () => {
    assert.equal(LAYOUT_MODES.size, 3);
  });

  it('detectDayLayout always returns a value in LAYOUT_MODES', () => {
    const plans = [
      null,
      '',
      BLANK_PLAN,
      '## Monday\nDeep work.',
      'Priority 1: ship it',
      '## Monday\nPriority 1: ship it',
    ];
    for (const p of plans) {
      assert.ok(LAYOUT_MODES.has(detectDayLayout(p)), `unexpected result for: ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------
// detectDayLayoutWithConfidence
// ---------------------------------------------------------------------------

describe('detectDayLayoutWithConfidence — null / empty / non-string inputs', () => {
  it('returns mode=mixed, confident=false, ambiguityReason=absent-signals for null', () => {
    const r = detectDayLayoutWithConfidence(null);
    assert.equal(r.mode, 'mixed');
    assert.equal(r.confident, false);
    assert.equal(r.ambiguityReason, 'absent-signals');
    assert.equal(r.themeScore, 0);
    assert.equal(r.priorityScore, 0);
  });

  it('returns absent-signals for undefined', () => {
    const r = detectDayLayoutWithConfidence(undefined);
    assert.equal(r.confident, false);
    assert.equal(r.ambiguityReason, 'absent-signals');
  });

  it('returns absent-signals for empty string', () => {
    const r = detectDayLayoutWithConfidence('');
    assert.equal(r.confident, false);
    assert.equal(r.ambiguityReason, 'absent-signals');
  });

  it('returns absent-signals for whitespace-only string', () => {
    const r = detectDayLayoutWithConfidence('   \n\t  ');
    assert.equal(r.confident, false);
    assert.equal(r.ambiguityReason, 'absent-signals');
  });

  it('returns absent-signals for plan with no layout signals', () => {
    const r = detectDayLayoutWithConfidence(BLANK_PLAN);
    assert.equal(r.mode, 'mixed');
    assert.equal(r.confident, false);
    assert.equal(r.ambiguityReason, 'absent-signals');
    assert.equal(r.themeScore, 0);
    assert.equal(r.priorityScore, 0);
  });
});

describe('detectDayLayoutWithConfidence — confident theme-days', () => {
  it('returns confident=true, mode=theme-days when only theme signals present', () => {
    const md = `
# Plan
## Monday
Deep work session.
## Tuesday
Code review.
## Wednesday
Planning.
`;
    const r = detectDayLayoutWithConfidence(md);
    assert.equal(r.mode, 'theme-days');
    assert.equal(r.confident, true);
    assert.equal(r.ambiguityReason, null);
    assert.ok(r.themeScore > 0);
    assert.equal(r.priorityScore, 0);
  });

  it('includes non-zero themeScore in the result', () => {
    const md = 'Monday: deep work\nTuesday: review\nFriday: admin';
    const r = detectDayLayoutWithConfidence(md);
    assert.ok(r.themeScore > 0, 'themeScore should be > 0');
    assert.equal(r.priorityScore, 0);
    assert.equal(r.confident, true);
  });
});

describe('detectDayLayoutWithConfidence — confident priority-waterfall', () => {
  it('returns confident=true, mode=priority-waterfall when only priority signals present', () => {
    const md = `
# Goals
Priority 1: Launch MVP
Priority 2: Write docs
Priority 3: Add analytics
`;
    const r = detectDayLayoutWithConfidence(md);
    assert.equal(r.mode, 'priority-waterfall');
    assert.equal(r.confident, true);
    assert.equal(r.ambiguityReason, null);
    assert.equal(r.themeScore, 0);
    assert.ok(r.priorityScore > 0);
  });

  it('includes non-zero priorityScore in the result', () => {
    const md = 'Must-have: feature complete\nShould-have: tests passing';
    const r = detectDayLayoutWithConfidence(md);
    assert.ok(r.priorityScore > 0, 'priorityScore should be > 0');
    assert.equal(r.themeScore, 0);
    assert.equal(r.confident, true);
  });
});

describe('detectDayLayoutWithConfidence — conflicting-signals (both present)', () => {
  it('returns confident=false, ambiguityReason=conflicting-signals when both signal types present', () => {
    const md = `
# Plan
## Monday
Priority 1: ship auth module.
Priority 2: write tests.
`;
    const r = detectDayLayoutWithConfidence(md);
    assert.equal(r.mode, 'mixed');
    assert.equal(r.confident, false);
    assert.equal(r.ambiguityReason, 'conflicting-signals');
    assert.ok(r.themeScore > 0, 'themeScore should be > 0');
    assert.ok(r.priorityScore > 0, 'priorityScore should be > 0');
  });

  it('conflicting: must-have language alongside day headings', () => {
    const md = `
## Tuesday
Must-have: finish the feature branch.
`;
    const r = detectDayLayoutWithConfidence(md);
    assert.equal(r.ambiguityReason, 'conflicting-signals');
    assert.equal(r.confident, false);
  });

  it('conflicting: day-cadence mixed with priority tiers', () => {
    const md = `
Every Monday focus on Tier 1 objectives.
Tuesday and Thursday are for Tier 2 work.
`;
    const r = detectDayLayoutWithConfidence(md);
    assert.equal(r.ambiguityReason, 'conflicting-signals');
    assert.equal(r.confident, false);
  });
});

describe('detectDayLayoutWithConfidence — mode field matches detectDayLayout', () => {
  const plans = [
    null,
    '',
    BLANK_PLAN,
    '## Monday\nDeep work.',
    'Priority 1: ship it',
    '## Monday\nPriority 1: ship it',
    'Mondays: planning\nTuesdays: coding\nFridays: review',
    'Must-have: auth\nShould-have: tests',
  ];
  for (const p of plans) {
    it(`mode matches detectDayLayout for: ${JSON.stringify((p ?? '').slice(0, 40))}`, () => {
      assert.equal(
        detectDayLayoutWithConfidence(p).mode,
        detectDayLayout(p),
        'detectDayLayoutWithConfidence.mode must match detectDayLayout output',
      );
    });
  }
});

describe('detectDayLayoutWithConfidence — result shape', () => {
  it('always returns all five required fields', () => {
    const inputs = [null, '', BLANK_PLAN, '## Monday\nWork.', 'Priority 1: X'];
    for (const input of inputs) {
      const r = detectDayLayoutWithConfidence(input);
      assert.ok('mode' in r, 'missing mode');
      assert.ok('confident' in r, 'missing confident');
      assert.ok('ambiguityReason' in r, 'missing ambiguityReason');
      assert.ok('themeScore' in r, 'missing themeScore');
      assert.ok('priorityScore' in r, 'missing priorityScore');
    }
  });

  it('confident is always boolean', () => {
    const inputs = [null, '', '## Monday\nWork.', 'Priority 1: X', '## Monday\nP1: X'];
    for (const input of inputs) {
      assert.equal(typeof detectDayLayoutWithConfidence(input).confident, 'boolean');
    }
  });

  it('ambiguityReason is null when confident', () => {
    assert.equal(detectDayLayoutWithConfidence('## Monday\nDeep work.').ambiguityReason, null);
    assert.equal(detectDayLayoutWithConfidence('Priority 1: ship it').ambiguityReason, null);
  });

  it('ambiguityReason is non-null when not confident', () => {
    assert.notEqual(detectDayLayoutWithConfidence(null).ambiguityReason, null);
    assert.notEqual(detectDayLayoutWithConfidence('').ambiguityReason, null);
    assert.notEqual(detectDayLayoutWithConfidence(BLANK_PLAN).ambiguityReason, null);
    assert.notEqual(
      detectDayLayoutWithConfidence('## Monday\nPriority 1: X').ambiguityReason,
      null,
    );
  });
});
