/**
 * Tests for src/skills/plan-interview-triggers.js
 *
 * Each test section mirrors one exported symbol. We test:
 *   - Pure helper functions (no I/O) with direct inputs
 *   - Trigger functions via real on-disk fixtures in a temp directory
 *
 * Trigger tests are intentionally shallow — they verify the contract
 * (shape and trigger ID) rather than duplicating store-level coverage.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  // Utilities
  isoWeeksInYear,
  previousWeekKey,
  mondayStringForWeek,
  extractSubstantiveLines,
  goalLinesAppearConflicting,
  parseDateMentions,
  lastDayOfMonth,
  // Triggers
  isFirstEverPlan,
  detectVagueOrConflictingGoals,
  detectPriorWeekProblems,
  detectDeadlineApproaching,
  checkInterviewTriggers,
  // Skip-questions escape hatch
  generateAssumptionForTrigger,
  generateSkipAssumptions,
  formatAssumptionsBlock,
  // Exported constants
  PRIOR_WEEK_ABSOLUTE_FAILURE_THRESHOLD,
  PRIOR_WEEK_FAILURE_RATE_THRESHOLD,
  PRIOR_WEEK_MIN_ACTIVITIES,
  DEFAULT_DEADLINE_LOOKAHEAD_DAYS,
} from './plan-interview-triggers.js';

import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { writePlan } from '../storage/plan-markdown-store.js';
import { createWeeklyPlan, createTask, createGoal, createObjective } from '../models/agent.js';

const AGENT_ID = 'test-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid weekly plan for any week. */
function makeWeeklyPlan(week) {
  const task = createTask({ title: 'Test task', prompt: 'Test task' }, 'obj-test', { priority: 'medium' });
  return createWeeklyPlan(week, week.slice(0, 7).replace('-W', '-').replace(/W(\d+)$/, (_m, w) => {
    // Convert "2026-W16" -> "2026-04" approximately — we just need a valid YYYY-MM.
    return '04';
  }), [task]);
}

/** Simple plan.md body with real goals and a monthly section. */
const GOOD_PLAN_MD = `# Test Agent

A test agent.

## Long-term goals

- Grow the user base to 10 000 active users within 12 months
- Increase monthly revenue by 20% over the next quarter
- Build a reliable automated test suite covering all critical paths

## Monthly plans

### 2026-04

- Launch the beta feature
- Fix top-5 reported bugs

### 2026-05

- Onboard first 100 paying customers

## Strategies

Work iteratively, ship daily.

## Notes

N/A
`;

/** Plan.md with only placeholder content in goals. */
const EMPTY_GOALS_PLAN_MD = `# Test Agent

## Long-term goals

<!-- What should this agent achieve? -->

## Monthly plans

### 2026-04

- Some objective

## Strategies

## Notes
`;

/** Plan.md with goals but no YYYY-MM monthly sections. */
const NO_MONTHLY_SECTIONS_PLAN_MD = `# Test Agent

## Long-term goals

- Build a great product

## Monthly plans

<!-- Add monthly sections here -->

## Strategies

## Notes
`;

/** Plan.md with conflicting goals. */
const CONFLICTING_GOALS_PLAN_MD = `# Test Agent

## Long-term goals

- Increase revenue from content marketing to $50 000/month
- Reduce content marketing costs by 40% this quarter

## Monthly plans

### 2026-04

- Publish 10 articles

## Strategies

## Notes
`;

/** Plan.md with an approaching monthly deadline. */
function deadlinePlanMd(monthStr) {
  return `# Test Agent

## Long-term goals

- Ship a great product by end of month

## Monthly plans

### ${monthStr}

- Launch the MVP

## Strategies

## Notes
`;
}

/** Plan.md with an explicit "by YYYY-MM-DD" date mention. */
function explicitDeadlinePlanMd(dateStr) {
  return `# Test Agent

## Long-term goals

- Complete the project by ${dateStr}

## Monthly plans

### 2030-01

- Some far-future objective

## Strategies

## Notes
`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('isoWeeksInYear', () => {
  it('returns 52 for typical years', () => {
    // 2023: p(2023)=(2023+505-20+5)%7=2513%7=359*7=2513→0. p(2022)=(2022+505-20+5)%7=2512%7=6. Not 4 or 3 → 52
    assert.equal(isoWeeksInYear(2023), 52);
    assert.equal(isoWeeksInYear(2024), 52);
  });

  it('returns 53 for long years', () => {
    // 2015, 2020, 2026 are known 53-week years
    assert.equal(isoWeeksInYear(2015), 53);
    assert.equal(isoWeeksInYear(2020), 53);
  });

  it('returns a number (52 or 53) for a range of years', () => {
    for (let y = 2000; y <= 2030; y++) {
      const n = isoWeeksInYear(y);
      assert.ok(n === 52 || n === 53, `year ${y}: expected 52 or 53, got ${n}`);
    }
  });
});

describe('previousWeekKey', () => {
  it('decrements the week number within the same year', () => {
    assert.equal(previousWeekKey('2026-W17'), '2026-W16');
    assert.equal(previousWeekKey('2026-W02'), '2026-W01');
  });

  it('crosses the year boundary to the last week of the prior year', () => {
    // 2026-W01 → last week of 2025 (which has 52 weeks)
    const prev = previousWeekKey('2026-W01');
    assert.match(prev, /^2025-W\d{2}$/);
    const weekNum = parseInt(prev.slice(-2), 10);
    assert.equal(weekNum, isoWeeksInYear(2025));
  });

  it('throws on malformed input', () => {
    assert.throws(() => previousWeekKey('not-a-week'), TypeError);
    assert.throws(() => previousWeekKey(''), TypeError);
  });
});

describe('mondayStringForWeek', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = mondayStringForWeek('2026-W16');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('2026-W16 Monday is 2026-04-13', () => {
    // Verified independently: 2026-W16 starts on Monday April 13
    assert.equal(mondayStringForWeek('2026-W16'), '2026-04-13');
  });

  it('consecutive weeks differ by exactly 7 days', () => {
    const d1 = new Date(mondayStringForWeek('2026-W10') + 'T00:00:00Z');
    const d2 = new Date(mondayStringForWeek('2026-W11') + 'T00:00:00Z');
    const diffDays = (d2 - d1) / (24 * 60 * 60 * 1000);
    assert.equal(diffDays, 7);
  });

  it('throws on malformed input', () => {
    assert.throws(() => mondayStringForWeek('bad'), TypeError);
  });
});

describe('extractSubstantiveLines', () => {
  it('returns empty array for empty / non-string input', () => {
    assert.deepEqual(extractSubstantiveLines(''), []);
    assert.deepEqual(extractSubstantiveLines(null), []);
    assert.deepEqual(extractSubstantiveLines(undefined), []);
  });

  it('strips HTML comment lines', () => {
    const body = '<!-- placeholder -->\nReal goal here';
    const result = extractSubstantiveLines(body);
    assert.deepEqual(result, ['Real goal here']);
  });

  it('strips blank lines', () => {
    const body = '\nGoal one\n\nGoal two\n';
    const result = extractSubstantiveLines(body);
    assert.deepEqual(result, ['Goal one', 'Goal two']);
  });

  it('strips leading list markers', () => {
    const body = '- Bullet goal\n* Star goal\n1. Numbered goal';
    const result = extractSubstantiveLines(body);
    assert.deepEqual(result, ['Bullet goal', 'Star goal', 'Numbered goal']);
  });

  it('filters out sub-heading lines', () => {
    const body = '### 2026-04\n- Some objective\n#### Deep heading\nContent';
    const result = extractSubstantiveLines(body);
    assert.deepEqual(result, ['Some objective', 'Content']);
  });
});

describe('goalLinesAppearConflicting', () => {
  it('returns false when directions are the same', () => {
    assert.equal(
      goalLinesAppearConflicting('Increase user revenue', 'Grow user base'),
      false,
    );
  });

  it('returns false when directions oppose but no noun overlap', () => {
    assert.equal(
      goalLinesAppearConflicting('Increase revenue', 'Reduce headcount'),
      false,
    );
  });

  it('returns true when directions oppose AND nouns overlap', () => {
    assert.equal(
      goalLinesAppearConflicting(
        'Increase content marketing spend',
        'Reduce content marketing spend by 40%',
      ),
      true,
    );
  });

  it('handles mixed-direction lines without false positive', () => {
    // Line A has both growth and shrink verbs → not "purely growth"
    assert.equal(
      goalLinesAppearConflicting('Increase and reduce costs', 'Reduce overall costs'),
      false,
    );
  });
});

describe('parseDateMentions', () => {
  it('returns empty array for non-string / empty input', () => {
    assert.deepEqual(parseDateMentions(''), []);
    assert.deepEqual(parseDateMentions(null), []);
  });

  it('matches "by YYYY-MM-DD" pattern', () => {
    const results = parseDateMentions('Ship the MVP by 2026-06-30.');
    assert.equal(results.length, 1);
    assert.equal(results[0].label, '2026-06-30');
  });

  it('matches "due YYYY-MM-DD" pattern', () => {
    const results = parseDateMentions('Report due 2026-05-15');
    assert.equal(results.length, 1);
    assert.equal(results[0].label, '2026-05-15');
  });

  it('matches "deadline: YYYY-MM-DD" pattern', () => {
    const results = parseDateMentions('deadline: 2026-04-30');
    assert.equal(results.length, 1);
    assert.equal(results[0].label, '2026-04-30');
  });

  it('returns a valid Date object for each match', () => {
    const results = parseDateMentions('by 2026-07-04');
    assert.ok(results[0].date instanceof Date);
    assert.ok(!Number.isNaN(results[0].date.getTime()));
  });

  it('ignores invalid dates', () => {
    const results = parseDateMentions('by 2026-99-99');
    assert.equal(results.length, 0);
  });
});

describe('lastDayOfMonth', () => {
  it('returns the correct last day for standard months', () => {
    assert.equal(lastDayOfMonth('2026-04').toISOString().slice(0, 10), '2026-04-30');
    assert.equal(lastDayOfMonth('2026-12').toISOString().slice(0, 10), '2026-12-31');
    assert.equal(lastDayOfMonth('2026-02').toISOString().slice(0, 10), '2026-02-28');
  });

  it('handles leap February', () => {
    assert.equal(lastDayOfMonth('2024-02').toISOString().slice(0, 10), '2024-02-29');
  });

  it('returns null for malformed input', () => {
    assert.equal(lastDayOfMonth('not-a-month'), null);
    assert.equal(lastDayOfMonth(''), null);
  });
});

// ---------------------------------------------------------------------------
// Trigger 1: isFirstEverPlan
// ---------------------------------------------------------------------------

describe('isFirstEverPlan', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aweek-trigger1-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fires when no weekly plans exist', async () => {
    const result = await isFirstEverPlan({ agentId: AGENT_ID, dataDir: dir });
    assert.ok(result !== null, 'should fire');
    assert.equal(result.trigger, 'first-ever-plan');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.equal(result.details.agentId, AGENT_ID);
    assert.equal(result.details.priorWeekCount, 0);
  });

  it('returns null when at least one weekly plan exists', async () => {
    const store = new WeeklyPlanStore(dir);
    const task = createTask({ title: 'Existing task', prompt: 'Existing task' }, 'obj-1', { priority: 'medium' });
    const plan = createWeeklyPlan('2026-W10', '2026-03', [task]);
    await store.save(AGENT_ID, plan);

    const result = await isFirstEverPlan({ agentId: AGENT_ID, dataDir: dir });
    assert.equal(result, null);
  });

  it('throws on missing required params', async () => {
    await assert.rejects(() => isFirstEverPlan({ dataDir: dir }), TypeError);
    await assert.rejects(() => isFirstEverPlan({ agentId: AGENT_ID }), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Trigger 2: detectVagueOrConflictingGoals
// ---------------------------------------------------------------------------

describe('detectVagueOrConflictingGoals', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aweek-trigger2-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fires with vague reason when plan.md is absent', async () => {
    const result = await detectVagueOrConflictingGoals({
      agentId: AGENT_ID,
      agentsDir: dir,
    });
    assert.ok(result !== null);
    assert.equal(result.trigger, 'conflicting-or-vague-goals');
    assert.equal(result.details.vague, true);
    assert.match(result.details.vagueReason, /absent/i);
  });

  it('fires with vague reason when goals section is empty/placeholder', async () => {
    await writePlan(dir, AGENT_ID, EMPTY_GOALS_PLAN_MD);
    const result = await detectVagueOrConflictingGoals({
      agentId: AGENT_ID,
      agentsDir: dir,
    });
    assert.ok(result !== null);
    assert.equal(result.trigger, 'conflicting-or-vague-goals');
    assert.equal(result.details.vague, true);
    assert.equal(result.details.substantiveGoalLineCount, 0);
  });

  it('fires with vague reason when no YYYY-MM monthly sections exist', async () => {
    await writePlan(dir, AGENT_ID, NO_MONTHLY_SECTIONS_PLAN_MD);
    const result = await detectVagueOrConflictingGoals({
      agentId: AGENT_ID,
      agentsDir: dir,
    });
    assert.ok(result !== null);
    assert.equal(result.trigger, 'conflicting-or-vague-goals');
    assert.equal(result.details.vague, true);
    assert.match(result.details.vagueReason, /YYYY-MM/i);
  });

  it('fires with conflicting reason when goals oppose each other', async () => {
    await writePlan(dir, AGENT_ID, CONFLICTING_GOALS_PLAN_MD);
    const result = await detectVagueOrConflictingGoals({
      agentId: AGENT_ID,
      agentsDir: dir,
    });
    assert.ok(result !== null);
    assert.equal(result.trigger, 'conflicting-or-vague-goals');
    assert.equal(result.details.conflicting, true);
    assert.ok(Array.isArray(result.details.conflictingPairs));
    assert.ok(result.details.conflictingPairs.length > 0);
  });

  it('returns null for a well-formed plan.md', async () => {
    await writePlan(dir, AGENT_ID, GOOD_PLAN_MD);
    const result = await detectVagueOrConflictingGoals({
      agentId: AGENT_ID,
      agentsDir: dir,
    });
    assert.equal(result, null);
  });

  it('throws on missing required params', async () => {
    await assert.rejects(
      () => detectVagueOrConflictingGoals({ agentsDir: dir }),
      TypeError,
    );
    await assert.rejects(
      () => detectVagueOrConflictingGoals({ agentId: AGENT_ID }),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Trigger 3: detectPriorWeekProblems
// ---------------------------------------------------------------------------

describe('detectPriorWeekProblems', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aweek-trigger3-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when there are no prior activity logs', async () => {
    const result = await detectPriorWeekProblems({
      agentId: AGENT_ID,
      dataDir: dir,
      // Fix "now" to a known week so the test is deterministic.
      now: new Date('2026-04-20T12:00:00Z'),
    });
    assert.equal(result, null);
  });

  it('returns null when prior week had no failures', async () => {
    const store = new ActivityLogStore(dir);
    // 2026-W15 Monday = 2026-04-06; to test W16 prior, fix now to W17.
    const priorMonday = '2026-04-06'; // Monday of 2026-W15
    await store.init(AGENT_ID);
    // Write two completed entries.
    const entry1 = {
      id: 'log-aabb0001',
      timestamp: '2026-04-07T10:00:00Z',
      agentId: AGENT_ID,
      status: 'completed',
      title: 'Task one completed',
    };
    const entry2 = {
      id: 'log-aabb0002',
      timestamp: '2026-04-07T11:00:00Z',
      agentId: AGENT_ID,
      status: 'completed',
      title: 'Task two completed',
    };
    // Write directly to the log file for that week.
    await writeFile(
      join(dir, AGENT_ID, 'logs', `${priorMonday}.json`),
      JSON.stringify([entry1, entry2], null, 2),
    );

    // "now" is in 2026-W16 so previous week is 2026-W15
    const result = await detectPriorWeekProblems({
      agentId: AGENT_ID,
      dataDir: dir,
      now: new Date('2026-04-13T12:00:00Z'), // Monday of W16 → prior = W15
    });
    assert.equal(result, null);
  });

  it('fires when absolute failure threshold is met', async () => {
    const store = new ActivityLogStore(dir);
    const priorMonday = '2026-04-06'; // 2026-W15
    await store.init(AGENT_ID);

    // Write PRIOR_WEEK_ABSOLUTE_FAILURE_THRESHOLD failed entries.
    // IDs must satisfy the schema pattern ^log-[a-f0-9]+$ (hex chars only).
    const entries = [];
    for (let i = 0; i < PRIOR_WEEK_ABSOLUTE_FAILURE_THRESHOLD; i++) {
      entries.push({
        id: `log-dead${String(i).padStart(4, '0')}`,
        timestamp: '2026-04-07T10:00:00Z',
        agentId: AGENT_ID,
        status: 'failed',
        title: `Failed task ${i}`,
      });
    }
    await writeFile(
      join(dir, AGENT_ID, 'logs', `${priorMonday}.json`),
      JSON.stringify(entries, null, 2),
    );

    const result = await detectPriorWeekProblems({
      agentId: AGENT_ID,
      dataDir: dir,
      now: new Date('2026-04-13T12:00:00Z'), // W16 → prior W15
    });
    assert.ok(result !== null, 'should fire');
    assert.equal(result.trigger, 'prior-week-problems');
    assert.equal(result.details.totalFailed, PRIOR_WEEK_ABSOLUTE_FAILURE_THRESHOLD);
    assert.ok(Array.isArray(result.details.failedDescriptions));
    assert.equal(result.details.triggeredBy, 'absolute-threshold');
  });

  it('fires when rate threshold is met with sufficient sample size', async () => {
    const store = new ActivityLogStore(dir);
    const priorMonday = '2026-04-06'; // 2026-W15
    await store.init(AGENT_ID);

    // PRIOR_WEEK_MIN_ACTIVITIES entries with >= PRIOR_WEEK_FAILURE_RATE_THRESHOLD failures.
    const total = PRIOR_WEEK_MIN_ACTIVITIES;
    const failCount = Math.ceil(total * PRIOR_WEEK_FAILURE_RATE_THRESHOLD);
    const entries = [];
    // IDs must satisfy the schema pattern ^log-[a-f0-9]+$ (hex chars only).
    for (let i = 0; i < total; i++) {
      entries.push({
        id: `log-cafe${String(i).padStart(4, '0')}`,
        timestamp: '2026-04-07T10:00:00Z',
        agentId: AGENT_ID,
        status: i < failCount ? 'failed' : 'completed',
        title: `Task ${i}`,
      });
    }
    await writeFile(
      join(dir, AGENT_ID, 'logs', `${priorMonday}.json`),
      JSON.stringify(entries, null, 2),
    );

    const result = await detectPriorWeekProblems({
      agentId: AGENT_ID,
      dataDir: dir,
      now: new Date('2026-04-13T12:00:00Z'),
    });
    assert.ok(result !== null, 'should fire on rate threshold');
    assert.equal(result.trigger, 'prior-week-problems');
    assert.ok(result.details.failureRate >= PRIOR_WEEK_FAILURE_RATE_THRESHOLD);
  });

  it('throws on missing required params', async () => {
    await assert.rejects(
      () => detectPriorWeekProblems({ dataDir: dir }),
      TypeError,
    );
    await assert.rejects(
      () => detectPriorWeekProblems({ agentId: AGENT_ID }),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Trigger 4: detectDeadlineApproaching
// ---------------------------------------------------------------------------

describe('detectDeadlineApproaching', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aweek-trigger4-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when plan.md is absent', async () => {
    const result = await detectDeadlineApproaching({
      agentId: AGENT_ID,
      agentsDir: dir,
      now: new Date('2026-04-19T00:00:00Z'),
    });
    assert.equal(result, null);
  });

  it('returns null when no deadlines are within the window', async () => {
    // Plan has "### 2030-06" — far in the future
    await writePlan(
      dir,
      AGENT_ID,
      deadlinePlanMd('2030-06'),
    );
    const result = await detectDeadlineApproaching({
      agentId: AGENT_ID,
      agentsDir: dir,
      now: new Date('2026-04-19T00:00:00Z'),
    });
    assert.equal(result, null);
  });

  it('fires when a monthly plan end-date is within the lookahead window', async () => {
    // "now" is Apr 19, 2026; April ends Apr 30 — 11 days away (< 14-day default)
    await writePlan(dir, AGENT_ID, deadlinePlanMd('2026-04'));
    const result = await detectDeadlineApproaching({
      agentId: AGENT_ID,
      agentsDir: dir,
      now: new Date('2026-04-19T00:00:00Z'),
    });
    assert.ok(result !== null, 'should fire');
    assert.equal(result.trigger, 'deadline-approaching');
    assert.equal(result.details.nearestDeadline.type, 'monthly-plan');
    assert.equal(result.details.nearestDeadline.label, '2026-04');
    assert.ok(result.details.nearestDeadline.daysRemaining >= 0);
  });

  it('fires when an explicit date mention is within the lookahead window', async () => {
    // "by 2026-04-25" is 6 days from Apr 19
    await writePlan(dir, AGENT_ID, explicitDeadlinePlanMd('2026-04-25'));
    const result = await detectDeadlineApproaching({
      agentId: AGENT_ID,
      agentsDir: dir,
      now: new Date('2026-04-19T00:00:00Z'),
    });
    assert.ok(result !== null, 'should fire');
    assert.equal(result.trigger, 'deadline-approaching');
    assert.equal(result.details.nearestDeadline.label, '2026-04-25');
    assert.ok(result.details.nearestDeadline.daysRemaining > 0);
    assert.ok(result.details.nearestDeadline.daysRemaining <= DEFAULT_DEADLINE_LOOKAHEAD_DAYS);
  });

  it('respects a custom lookaheadDays value', async () => {
    // April ends in 11 days from Apr 19. With lookahead=7, it should NOT fire.
    await writePlan(dir, AGENT_ID, deadlinePlanMd('2026-04'));
    const result = await detectDeadlineApproaching({
      agentId: AGENT_ID,
      agentsDir: dir,
      now: new Date('2026-04-19T00:00:00Z'),
      lookaheadDays: 7,
    });
    assert.equal(result, null, 'Apr 30 is 11 days out — outside a 7-day window');
  });

  it('sorts approachingDeadlines by soonest first', async () => {
    // Two deadlines: monthly end 2026-04 (Apr 30 = 11 days from Apr 19)
    // and an explicit "by 2026-04-22" (3 days). Nearest should be Apr 22.
    const body = `# Test Agent

## Long-term goals

- Ship a great product

## Monthly plans

### 2026-04

- Launch the MVP

## Strategies

Work iteratively.

## Notes

Ship the thing by 2026-04-22.
`;
    await writePlan(dir, AGENT_ID, body);
    const result = await detectDeadlineApproaching({
      agentId: AGENT_ID,
      agentsDir: dir,
      now: new Date('2026-04-19T00:00:00Z'),
    });
    assert.ok(result !== null);
    // Nearest should be 2026-04-22 (3 days) not 2026-04-30 (11 days)
    assert.equal(result.details.nearestDeadline.label, '2026-04-22');
    assert.ok(result.details.approachingDeadlines.length >= 2);
  });

  it('throws on missing required params', async () => {
    await assert.rejects(
      () => detectDeadlineApproaching({ agentsDir: dir }),
      TypeError,
    );
    await assert.rejects(
      () => detectDeadlineApproaching({ agentId: AGENT_ID }),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Composite: checkInterviewTriggers
// ---------------------------------------------------------------------------

describe('checkInterviewTriggers', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aweek-check-triggers-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty array when no triggers fire (good plan, prior week clean, no deadlines)', async () => {
    // Write a good plan.md
    await writePlan(dir, AGENT_ID, GOOD_PLAN_MD);
    // Seed at least one prior weekly plan so isFirstEverPlan stays silent
    const store = new WeeklyPlanStore(dir);
    const task = createTask({ title: 'Prior task', prompt: 'Prior task' }, 'obj-prior', { priority: 'medium' });
    const plan = createWeeklyPlan('2026-W15', '2026-04', [task]);
    await store.save(AGENT_ID, plan);

    // "now" is in 2026-W17, April ends far outside 14-day window from Apr 26
    const result = await checkInterviewTriggers({
      agentId: AGENT_ID,
      dataDir: dir,
      now: new Date('2026-04-26T12:00:00Z'), // Apr 30 is only 4 days away — tighten window
      deadlineLookaheadDays: 3, // window too small for Apr 30
    });
    assert.deepEqual(result, []);
  });

  it('fires first-ever-plan trigger when no plans exist', async () => {
    await writePlan(dir, AGENT_ID, GOOD_PLAN_MD);
    const result = await checkInterviewTriggers({
      agentId: AGENT_ID,
      dataDir: dir,
      now: new Date('2026-04-19T12:00:00Z'),
      deadlineLookaheadDays: 3, // keep Apr 30 quiet
    });
    const triggers = result.map((r) => r.trigger);
    assert.ok(triggers.includes('first-ever-plan'), `got: ${JSON.stringify(triggers)}`);
  });

  it('returns an array with the correct shape for each fired trigger', async () => {
    // No plan.md → vague trigger; no plans → first-ever trigger.
    const result = await checkInterviewTriggers({
      agentId: AGENT_ID,
      dataDir: dir,
      now: new Date('2026-04-19T12:00:00Z'),
    });
    for (const r of result) {
      assert.ok(typeof r.trigger === 'string' && r.trigger.length > 0, 'trigger must be a non-empty string');
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be a non-empty string');
      assert.ok(r.details !== null && typeof r.details === 'object', 'details must be an object');
    }
  });

  it('swallows individual trigger errors gracefully', async () => {
    // Pass a completely bogus dataDir — all store operations will fail.
    // The composite should still return an array (empty or partial), not throw.
    const result = await checkInterviewTriggers({
      agentId: AGENT_ID,
      dataDir: '/this/path/does/not/exist/at/all',
      now: new Date('2026-04-19T12:00:00Z'),
    });
    assert.ok(Array.isArray(result), 'must return an array even on store errors');
  });
});

// ---------------------------------------------------------------------------
// Skip-questions escape hatch: generateAssumptionForTrigger
// ---------------------------------------------------------------------------

describe('generateAssumptionForTrigger', () => {
  it('returns a non-empty string for the first-ever-plan trigger', () => {
    const result = generateAssumptionForTrigger({
      trigger: 'first-ever-plan',
      details: { agentId: AGENT_ID, priorWeekCount: 0 },
    });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
    // Should mention calibration / starter week
    assert.match(result, /calibration|starter|first/i);
  });

  it('returns a conflicting-direction assumption when details.conflicting is true', () => {
    const result = generateAssumptionForTrigger({
      trigger: 'conflicting-or-vague-goals',
      details: {
        conflicting: true,
        conflictingPairs: [
          ['Increase content marketing spend', 'Reduce content marketing spend by 40%'],
        ],
      },
    });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
    // Should mention the first line of the pair and "conflicting"
    assert.match(result, /Increase content marketing spend/i);
    assert.match(result, /conflict/i);
  });

  it('returns a vague-goals assumption when details.vague is true', () => {
    const result = generateAssumptionForTrigger({
      trigger: 'conflicting-or-vague-goals',
      details: {
        vague: true,
        vagueReason: 'plan.md is absent',
      },
    });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
    assert.match(result, /plan\.md is absent/i);
  });

  it('returns a vague-goals assumption when details has no conflicting flag', () => {
    // Neither vague nor conflicting explicitly set — fallback to vague path
    const result = generateAssumptionForTrigger({
      trigger: 'conflicting-or-vague-goals',
      details: {},
    });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('returns a prior-week assumption with failure stats', () => {
    const result = generateAssumptionForTrigger({
      trigger: 'prior-week-problems',
      details: {
        priorWeekKey: '2026-W15',
        totalFailed: 4,
        totalActivities: 10,
        failureRate: 0.4,
        triggeredBy: 'rate-threshold',
        failedDescriptions: ['Task A', 'Task B', 'Task C', 'Task D'],
      },
    });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
    assert.match(result, /2026-W15/);
    assert.match(result, /4 failed/i);
    assert.match(result, /40%/);
  });

  it('returns a deadline-approaching assumption with nearest deadline info', () => {
    const result = generateAssumptionForTrigger({
      trigger: 'deadline-approaching',
      details: {
        lookaheadDays: 14,
        approachingDeadlines: [{ label: '2026-04', daysRemaining: 11 }],
        nearestDeadline: { label: '2026-04', daysRemaining: 11 },
      },
    });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
    assert.match(result, /2026-04/);
    assert.match(result, /11 day/i);
    assert.match(result, /deadline/i);
  });

  it('returns a generic fallback for an unknown trigger', () => {
    const result = generateAssumptionForTrigger({ trigger: 'unknown-trigger', details: {} });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
    assert.match(result, /unknown-trigger/);
  });

  it('handles missing details gracefully (does not throw)', () => {
    assert.doesNotThrow(() => generateAssumptionForTrigger({ trigger: 'first-ever-plan' }));
    assert.doesNotThrow(() =>
      generateAssumptionForTrigger({ trigger: 'prior-week-problems', details: {} }),
    );
    assert.doesNotThrow(() =>
      generateAssumptionForTrigger({ trigger: 'deadline-approaching', details: {} }),
    );
  });

  it('includes "already passed" for a zero-days-remaining deadline', () => {
    const result = generateAssumptionForTrigger({
      trigger: 'deadline-approaching',
      details: {
        lookaheadDays: 14,
        approachingDeadlines: [{ label: '2026-04-18', daysRemaining: 0 }],
        nearestDeadline: { label: '2026-04-18', daysRemaining: 0 },
      },
    });
    assert.match(result, /already passed/i);
  });
});

// ---------------------------------------------------------------------------
// Skip-questions escape hatch: generateSkipAssumptions
// ---------------------------------------------------------------------------

describe('generateSkipAssumptions', () => {
  it('returns an empty array for an empty triggers array', () => {
    assert.deepEqual(generateSkipAssumptions([]), []);
  });

  it('returns an empty array for non-array input', () => {
    assert.deepEqual(generateSkipAssumptions(null), []);
    assert.deepEqual(generateSkipAssumptions(undefined), []);
  });

  it('returns one entry per trigger in the same order', () => {
    const triggers = [
      { trigger: 'first-ever-plan', reason: 'first plan', details: {} },
      {
        trigger: 'prior-week-problems',
        reason: 'failures',
        details: { priorWeekKey: '2026-W15', totalFailed: 3, failureRate: 0.3 },
      },
    ];
    const result = generateSkipAssumptions(triggers);
    assert.equal(result.length, 2);
    assert.equal(result[0].trigger, 'first-ever-plan');
    assert.equal(result[1].trigger, 'prior-week-problems');
  });

  it('each entry has the required shape: trigger, label, assumption', () => {
    const triggers = [
      { trigger: 'first-ever-plan', reason: 'r', details: {} },
    ];
    const result = generateSkipAssumptions(triggers);
    assert.equal(result.length, 1);
    const entry = result[0];
    assert.equal(typeof entry.trigger, 'string');
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.label.length > 0, 'label must be non-empty');
    assert.equal(typeof entry.assumption, 'string');
    assert.ok(entry.assumption.length > 0, 'assumption must be non-empty');
  });

  it('produces human-readable labels for all four known trigger IDs', () => {
    const allTriggers = [
      { trigger: 'first-ever-plan', details: {} },
      { trigger: 'conflicting-or-vague-goals', details: { vague: true, vagueReason: 'absent' } },
      { trigger: 'prior-week-problems', details: { priorWeekKey: '2026-W15', totalFailed: 1, failureRate: 0.25 } },
      { trigger: 'deadline-approaching', details: { approachingDeadlines: [{ label: '2026-04', daysRemaining: 5 }], nearestDeadline: { label: '2026-04', daysRemaining: 5 }, lookaheadDays: 14 } },
    ];
    const result = generateSkipAssumptions(allTriggers);
    assert.equal(result.length, 4);
    assert.equal(result[0].label, 'First-Ever Plan');
    assert.equal(result[1].label, 'Conflicting or Vague Goals');
    assert.equal(result[2].label, 'Prior-Week Problems');
    assert.equal(result[3].label, 'Deadline Approaching');
  });

  it('produces the same assumption text as generateAssumptionForTrigger for each entry', () => {
    const triggers = [
      { trigger: 'first-ever-plan', reason: 'first', details: { priorWeekCount: 0 } },
    ];
    const result = generateSkipAssumptions(triggers);
    const direct = generateAssumptionForTrigger(triggers[0]);
    assert.equal(result[0].assumption, direct);
  });
});

// ---------------------------------------------------------------------------
// Skip-questions escape hatch: formatAssumptionsBlock
// ---------------------------------------------------------------------------

describe('formatAssumptionsBlock', () => {
  it('returns an empty string for an empty array', () => {
    assert.equal(formatAssumptionsBlock([]), '');
  });

  it('returns an empty string for non-array input', () => {
    assert.equal(formatAssumptionsBlock(null), '');
    assert.equal(formatAssumptionsBlock(undefined), '');
  });

  it('returns a non-empty string for a single assumption', () => {
    const assumptions = [
      {
        trigger: 'first-ever-plan',
        label: 'First-Ever Plan',
        assumption: 'Proceeding with a calibration starter week.',
      },
    ];
    const result = formatAssumptionsBlock(assumptions);
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('contains the assumptions block header', () => {
    const assumptions = [
      { trigger: 'first-ever-plan', label: 'First-Ever Plan', assumption: 'Starter week.' },
    ];
    const result = formatAssumptionsBlock(assumptions);
    assert.match(result, /Skipped Questions/i);
    assert.match(result, /Assumptions Applied/i);
  });

  it('includes every label as a heading', () => {
    const assumptions = [
      { trigger: 'first-ever-plan', label: 'First-Ever Plan', assumption: 'Assumption A.' },
      { trigger: 'prior-week-problems', label: 'Prior-Week Problems', assumption: 'Assumption B.' },
    ];
    const result = formatAssumptionsBlock(assumptions);
    assert.match(result, /First-Ever Plan/);
    assert.match(result, /Prior-Week Problems/);
  });

  it('includes every assumption text', () => {
    const assumptions = [
      { trigger: 'first-ever-plan', label: 'First-Ever Plan', assumption: 'MyAssumptionTextHere.' },
    ];
    const result = formatAssumptionsBlock(assumptions);
    assert.match(result, /MyAssumptionTextHere/);
  });

  it('contains a visible separator (horizontal rule) for framing', () => {
    const assumptions = [
      { trigger: 'first-ever-plan', label: 'First-Ever Plan', assumption: 'Test assumption.' },
    ];
    const result = formatAssumptionsBlock(assumptions);
    // Should open and close with --- separators
    assert.match(result, /^---/m);
  });

  it('instructs the user to decline if assumptions look wrong', () => {
    const assumptions = [
      { trigger: 'first-ever-plan', label: 'First-Ever Plan', assumption: 'Test assumption.' },
    ];
    const result = formatAssumptionsBlock(assumptions);
    assert.match(result, /decline/i);
  });

  it('outputs all four assumptions cleanly for a full trigger set', () => {
    const allFour = [
      { trigger: 'first-ever-plan', label: 'First-Ever Plan', assumption: 'Assumption 1.' },
      { trigger: 'conflicting-or-vague-goals', label: 'Conflicting or Vague Goals', assumption: 'Assumption 2.' },
      { trigger: 'prior-week-problems', label: 'Prior-Week Problems', assumption: 'Assumption 3.' },
      { trigger: 'deadline-approaching', label: 'Deadline Approaching', assumption: 'Assumption 4.' },
    ];
    const result = formatAssumptionsBlock(allFour);
    for (const { label, assumption } of allFour) {
      assert.ok(result.includes(label), `block should include label "${label}"`);
      assert.ok(result.includes(assumption), `block should include assumption "${assumption}"`);
    }
  });
});
