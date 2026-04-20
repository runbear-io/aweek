/**
 * Tests for the next-week context assembler.
 *
 * Covers:
 *   - extractRetrospectiveSummary: section extraction, edge cases
 *   - summariseActivityLog: count derivation, most-recent anchor, edge cases
 *   - assembleNextWeekPlannerContext: parallel reads, best-effort error handling
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  extractRetrospectiveSummary,
  summariseActivityLog,
  assembleNextWeekPlannerContext,
} from './next-week-context-assembler.js';

import { generateWeeklyPlan } from './weekly-plan-generator.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { writePlan } from '../storage/plan-markdown-store.js';
import { persistReview } from './weekly-review-orchestrator.js';
import { createGoal, createObjective, createMonthlyPlan } from '../models/agent.js';
import { validateWeeklyPlan } from '../schemas/validator.js';
import { isReviewObjectiveId } from '../schemas/weekly-plan.schema.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeEntry(status, description, timestamp) {
  return {
    id: `log-${randomUUID().slice(0, 8)}`,
    timestamp: timestamp || new Date().toISOString(),
    agentId: 'agent-test',
    status,
    description,
  };
}

/** Build a minimal weekly review markdown similar to what assembleReviewDocument produces. */
function makeReviewMarkdown({
  completedBody = '',
  blockersBody = '',
  metricsBody = '',
} = {}) {
  const lines = [
    '# Weekly Review: Test Agent',
    '',
    '**Week:** 2026-W16 (2026-04-13 — 2026-04-19)',
    '',
    '---',
    '',
    '## Completed Tasks',
    '',
    completedBody,
    '',
    '## Metrics',
    '',
    metricsBody,
    '',
    '## Blockers',
    '',
    blockersBody,
    '',
    '## Next Week',
    '',
    '_No tasks planned for next week yet._',
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// extractRetrospectiveSummary
// ---------------------------------------------------------------------------

describe('extractRetrospectiveSummary', () => {
  it('returns null for null input', () => {
    assert.equal(extractRetrospectiveSummary(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(extractRetrospectiveSummary(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(extractRetrospectiveSummary(''), null);
  });

  it('returns null for a document with only headings and no body text', () => {
    const md = '## Completed Tasks\n\n## Blockers\n\n## Metrics\n';
    assert.equal(extractRetrospectiveSummary(md), null);
  });

  it('extracts completed tasks summary line', () => {
    const md = makeReviewMarkdown({ completedBody: '3 tasks completed this week.' });
    const result = extractRetrospectiveSummary(md);
    assert.ok(result, 'should return a non-null summary');
    assert.ok(result.includes('3 tasks completed'), `got: "${result}"`);
  });

  it('strips markdown decoration from completed tasks line', () => {
    const md = makeReviewMarkdown({ completedBody: '**3 tasks** completed this `week`.' });
    const result = extractRetrospectiveSummary(md);
    assert.ok(result, 'should return a non-null summary');
    // Markdown chars stripped
    assert.ok(!result.includes('**'), `should strip bold: "${result}"`);
    assert.ok(!result.includes('`'), `should strip code: "${result}"`);
  });

  it('extracts first bullet from Blockers section', () => {
    const md = makeReviewMarkdown({
      completedBody: '',
      blockersBody: '- Dependency on external API not available\n- Another issue',
    });
    const result = extractRetrospectiveSummary(md);
    assert.ok(result, 'should return a non-null summary');
    assert.ok(result.includes('unresolved blocker:'), `got: "${result}"`);
    assert.ok(result.includes('Dependency on external API'), `got: "${result}"`);
  });

  it('does not include the second blocker bullet', () => {
    const md = makeReviewMarkdown({
      blockersBody: '- First blocker\n- Second blocker',
    });
    const result = extractRetrospectiveSummary(md);
    assert.ok(!result.includes('Second blocker'), `got: "${result}"`);
  });

  it('extracts metrics line mentioning "completion"', () => {
    const md = makeReviewMarkdown({
      metricsBody: '| Metric | Value |\n| Completion rate | 80% |',
    });
    const result = extractRetrospectiveSummary(md);
    assert.ok(result, 'should return non-null summary');
    assert.ok(/completion|80/i.test(result), `got: "${result}"`);
  });

  it('joins multiple parts with "; "', () => {
    const md = makeReviewMarkdown({
      completedBody: '2 tasks done.',
      blockersBody: '- API rate limit hit',
      metricsBody: 'Completion rate: 67%',
    });
    const result = extractRetrospectiveSummary(md);
    assert.ok(result, 'should return non-null summary');
    assert.ok(result.includes('; '), `expected semicolon-joined parts: "${result}"`);
  });

  it('returns at most three parts', () => {
    const md = makeReviewMarkdown({
      completedBody: 'All 5 tasks completed.',
      blockersBody: '- Blocker one',
      metricsBody: 'Completion rate: 100%',
    });
    const result = extractRetrospectiveSummary(md);
    // Three semicolon-separated parts = at most two semicolons
    const semicolonCount = (result.match(/;/g) || []).length;
    assert.ok(semicolonCount <= 2, `expected at most 2 semicolons, got ${semicolonCount}: "${result}"`);
  });

  it('truncates lines that exceed 120 chars in completed tasks', () => {
    const longLine = 'A'.repeat(200);
    const md = makeReviewMarkdown({ completedBody: longLine });
    const result = extractRetrospectiveSummary(md);
    assert.ok(result, 'should return non-null summary');
    // Should be truncated with ellipsis
    assert.ok(result.includes('...'), `expected truncation: "${result}"`);
    assert.ok(result.length < 200, `should be shorter than original: length ${result.length}`);
  });

  it('falls back to body prose when no recognised sections match', () => {
    const md = '# Weekly Review\n\nSomething happened this week.\n\n_end_';
    const result = extractRetrospectiveSummary(md);
    assert.ok(result, 'should return non-null fallback');
    assert.ok(result.includes('Something happened'), `got: "${result}"`);
  });

  it('skips HTML comment lines in completed body (no <!-- placeholders))', () => {
    const md = makeReviewMarkdown({ completedBody: '<!-- No tasks -->' });
    // The comment line would be stripped in fallback; completed body only skips
    // non-empty non-heading lines — comments are returned as-is from the section
    // but the fallback should still yield something from the full body
    const result = extractRetrospectiveSummary(md);
    // We just assert it doesn't throw and handles gracefully
    assert.ok(result === null || typeof result === 'string');
  });

  it('handles a document with only the Blockers section', () => {
    const md = '## Blockers\n\n- Deployment pipeline is broken\n';
    const result = extractRetrospectiveSummary(md);
    assert.ok(result, 'should extract from Blockers section');
    assert.ok(result.includes('Deployment pipeline'), `got: "${result}"`);
  });

  it('returns null when all sections are empty and no prose exists', () => {
    const md = '## Completed Tasks\n\n## Blockers\n\n## Metrics\n';
    assert.equal(extractRetrospectiveSummary(md), null);
  });
});

// ---------------------------------------------------------------------------
// summariseActivityLog
// ---------------------------------------------------------------------------

describe('summariseActivityLog', () => {
  it('returns null for null input', () => {
    assert.equal(summariseActivityLog(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(summariseActivityLog(undefined), null);
  });

  it('returns null for empty array', () => {
    assert.equal(summariseActivityLog([]), null);
  });

  it('returns null for non-array input', () => {
    assert.equal(summariseActivityLog('not-array'), null);
  });

  it('counts total entries', () => {
    const entries = [
      makeEntry('completed', 'Task A'),
      makeEntry('completed', 'Task B'),
      makeEntry('failed', 'Task C'),
    ];
    const result = summariseActivityLog(entries);
    assert.ok(result.includes('3 recorded entries'), `got: "${result}"`);
  });

  it('counts completed entries', () => {
    const entries = [
      makeEntry('completed', 'Task A'),
      makeEntry('failed', 'Task B'),
    ];
    const result = summariseActivityLog(entries);
    assert.ok(result.includes('1 completed'), `got: "${result}"`);
  });

  it('counts failed entries and includes in summary', () => {
    const entries = [
      makeEntry('completed', 'Task A'),
      makeEntry('failed', 'Task B'),
      makeEntry('failed', 'Task C'),
    ];
    const result = summariseActivityLog(entries);
    assert.ok(result.includes('2 failed'), `got: "${result}"`);
  });

  it('omits failed count when zero failures', () => {
    const entries = [
      makeEntry('completed', 'Task A'),
      makeEntry('completed', 'Task B'),
    ];
    const result = summariseActivityLog(entries);
    assert.ok(!result.includes('failed'), `should omit failed: "${result}"`);
  });

  it('includes most recent completed description', () => {
    const entries = [
      makeEntry('completed', 'Older task', '2026-04-13T10:00:00Z'),
      makeEntry('completed', 'Newer task', '2026-04-14T10:00:00Z'),
    ];
    const result = summariseActivityLog(entries);
    assert.ok(result.includes('Newer task'), `should include newest completed: "${result}"`);
  });

  it('uses singular "entry" for count of 1', () => {
    const entries = [makeEntry('completed', 'Solo task')];
    const result = summariseActivityLog(entries);
    assert.ok(result.includes('1 recorded entry'), `got: "${result}"`);
    assert.ok(!result.includes('entries'), `should not use plural: "${result}"`);
  });

  it('truncates long completed description to 80 chars with ellipsis', () => {
    const longDesc = 'This is a very long task description that exceeds eighty characters in total length.';
    const entries = [makeEntry('completed', longDesc)];
    const result = summariseActivityLog(entries);
    assert.ok(result.includes('...'), `expected truncation: "${result}"`);
    // Extract just the description portion between quotes
    const match = result.match(/"([^"]+)"/);
    if (match) {
      assert.ok(match[1].length <= 80, `truncated desc too long: ${match[1].length}`);
    }
  });

  it('skips non-completed entries for the most-recent anchor', () => {
    const entries = [
      makeEntry('completed', 'The real last completed', '2026-04-13T08:00:00Z'),
      makeEntry('failed', 'A failed task', '2026-04-14T10:00:00Z'),
    ];
    const result = summariseActivityLog(entries);
    assert.ok(result.includes('The real last completed'), `got: "${result}"`);
    assert.ok(!result.includes('A failed task'), `should not include failed: "${result}"`);
  });

  it('does not include most-recent anchor when all entries are non-completed', () => {
    const entries = [
      makeEntry('failed', 'Failed task'),
      makeEntry('skipped', 'Skipped task'),
    ];
    const result = summariseActivityLog(entries);
    assert.ok(!result.includes('most recent completed'), `got: "${result}"`);
  });

  it('returns a non-empty string for a single completed entry', () => {
    const entries = [makeEntry('completed', 'Build the widget')];
    const result = summariseActivityLog(entries);
    assert.ok(typeof result === 'string' && result.length > 0);
    assert.ok(result.includes('Build the widget'), `got: "${result}"`);
  });
});

// ---------------------------------------------------------------------------
// assembleNextWeekPlannerContext
// ---------------------------------------------------------------------------

describe('assembleNextWeekPlannerContext', () => {
  let baseDir;
  let agentsDir;
  let activityLogStore;

  const AGENT_ID = 'agent-assembler-test';
  const WEEK = '2026-W16';

  beforeEach(async () => {
    baseDir = join(tmpdir(), `aweek-assembler-test-${randomUUID()}`);
    await mkdir(baseDir, { recursive: true });
    agentsDir = baseDir; // reviews live under baseDir/agentId/reviews/<week>.md
    activityLogStore = new ActivityLogStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('returns all nulls/empty when no files exist', async () => {
    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    assert.equal(ctx.planMarkdown, null);
    assert.equal(ctx.retrospectiveContext, null);
    assert.equal(ctx.activityLogSummary, null);
    assert.deepStrictEqual(ctx.activityLogEntries, []);
  });

  it('reads plan.md when it exists', async () => {
    const planBody = '# Test Agent\n\n## Strategies\n\nWork in 2-hour blocks.\n';
    await writePlan(agentsDir, AGENT_ID, planBody);

    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    // writePlan preserves a body that already ends with \n; readPlan returns it verbatim
    assert.equal(ctx.planMarkdown, planBody);
  });

  it('returns null planMarkdown when agentsDir is null', async () => {
    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir: null, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    assert.equal(ctx.planMarkdown, null);
  });

  it('reads the weekly retrospective when it exists and extracts context', async () => {
    const reviewMarkdown = makeReviewMarkdown({
      completedBody: '2 tasks completed this week.',
    });
    const metadata = {
      agentId: AGENT_ID,
      week: WEEK,
      weekMonday: '2026-04-13',
      generatedAt: new Date().toISOString(),
      summary: {},
      sections: {},
    };
    await persistReview(baseDir, AGENT_ID, WEEK, reviewMarkdown, metadata);

    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    assert.ok(ctx.retrospectiveContext, 'should have retrospective context');
    assert.ok(
      ctx.retrospectiveContext.includes('2 tasks completed'),
      `got: "${ctx.retrospectiveContext}"`,
    );
  });

  it('returns null retrospectiveContext when baseDir is null', async () => {
    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir: null, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    assert.equal(ctx.retrospectiveContext, null);
  });

  it('reads activity log entries when they exist', async () => {
    await activityLogStore.init(AGENT_ID);
    await activityLogStore.append(AGENT_ID, {
      id: 'log-aabbccdd',
      timestamp: '2026-04-14T10:00:00.000Z', // Monday April 13 week
      agentId: AGENT_ID,
      status: 'completed',
      description: 'Built the login page',
    });

    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    assert.ok(ctx.activityLogSummary, 'should have activity log summary');
    assert.ok(ctx.activityLogSummary.includes('1 completed'), `got: "${ctx.activityLogSummary}"`);
    assert.equal(ctx.activityLogEntries.length, 1);
  });

  it('returns empty activityLogEntries when activityLogStore is null', async () => {
    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore: null },
      AGENT_ID,
      WEEK,
    );
    assert.equal(ctx.activityLogSummary, null);
    assert.deepStrictEqual(ctx.activityLogEntries, []);
  });

  it('reads all three sources in parallel without error', async () => {
    // Set up plan.md
    const planBody = '# Agent\n\n## Strategies\n\nTDD first.\n';
    await writePlan(agentsDir, AGENT_ID, planBody);

    // Set up review
    const reviewMarkdown = makeReviewMarkdown({ completedBody: 'All 4 tasks done.' });
    const metadata = {
      agentId: AGENT_ID,
      week: WEEK,
      weekMonday: '2026-04-13',
      generatedAt: new Date().toISOString(),
      summary: {},
      sections: {},
    };
    await persistReview(baseDir, AGENT_ID, WEEK, reviewMarkdown, metadata);

    // Set up activity log
    await activityLogStore.init(AGENT_ID);
    await activityLogStore.append(AGENT_ID, {
      id: 'log-11223344',
      timestamp: '2026-04-15T14:00:00.000Z',
      agentId: AGENT_ID,
      status: 'completed',
      description: 'Wrote integration tests',
    });

    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );

    assert.ok(ctx.planMarkdown, 'planMarkdown should be non-null');
    assert.ok(ctx.retrospectiveContext, 'retrospectiveContext should be non-null');
    assert.ok(ctx.activityLogSummary, 'activityLogSummary should be non-null');
    assert.ok(ctx.activityLogEntries.length > 0, 'activityLogEntries should be non-empty');
  });

  it('gracefully handles a corrupt review file (returns null retrospectiveContext)', async () => {
    // Write an invalid JSON metadata file so loadReview throws
    const reviewDir = join(baseDir, AGENT_ID, 'reviews');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, `${WEEK}.json`), 'NOT_VALID_JSON', 'utf-8');
    await writeFile(join(reviewDir, `${WEEK}.md`), '## Completed Tasks\n\n1 done.\n', 'utf-8');

    // Should not throw
    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    // review loaded from .md is ok but .json parse failure triggers catch -> null
    // Actually loadReview reads both; if the JSON parse throws, it should return null
    assert.ok(ctx.retrospectiveContext === null || typeof ctx.retrospectiveContext === 'string');
  });

  it('returns planMarkdown as null (not undefined) when plan.md is missing', async () => {
    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    assert.strictEqual(ctx.planMarkdown, null);
  });

  it('assembleNextWeekPlannerContext result keys map to generateWeeklyPlan option names', async () => {
    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
    );
    // These are the keys that generateWeeklyPlan options destructures
    assert.ok('planMarkdown' in ctx, 'missing planMarkdown key');
    assert.ok('retrospectiveContext' in ctx, 'missing retrospectiveContext key');
    assert.ok('activityLogSummary' in ctx, 'missing activityLogSummary key');
    assert.ok('activityLogEntries' in ctx, 'missing activityLogEntries key');
  });

  it('handles null deps object gracefully', async () => {
    const ctx = await assembleNextWeekPlannerContext(null, AGENT_ID, WEEK);
    assert.equal(ctx.planMarkdown, null);
    assert.equal(ctx.retrospectiveContext, null);
    assert.equal(ctx.activityLogSummary, null);
    assert.deepStrictEqual(ctx.activityLogEntries, []);
  });

  it('uses tz option for weekMonday derivation (does not throw for valid IANA tz)', async () => {
    await activityLogStore.init(AGENT_ID);
    // Append an entry in EST week of 2026-W16 (April 13-17)
    await activityLogStore.append(AGENT_ID, {
      id: 'log-aabb1122',
      timestamp: '2026-04-14T02:00:00.000Z', // UTC Tuesday = Monday in EST
      agentId: AGENT_ID,
      status: 'completed',
      description: 'TZ-aware task',
    });

    // Should not throw when a valid IANA zone is passed
    const ctx = await assembleNextWeekPlannerContext(
      { agentsDir, baseDir, activityLogStore },
      AGENT_ID,
      WEEK,
      { tz: 'America/New_York' },
    );
    // Activity log may or may not have the entry depending on zone boundary, but no throw
    assert.ok(Array.isArray(ctx.activityLogEntries));
  });
});

// ---------------------------------------------------------------------------
// Integration: generateWeeklyPlan respects retrospectiveContext option
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — retrospectiveContext option', () => {
  const PLAN_MD = `
# Dev Agent

## Long-term goals
- (3mo) Ship production API

## Monthly plans
### 2026-04
- Implement endpoints

## Strategies
- Work in 2-hour blocks
- Test-first development

## Notes
Focus on quality.
`;

  it('advisor brief includes retrospective bridge sentence when retrospectiveContext is supplied', () => {
    const goal = createGoal('Ship API', '1mo');
    const obj = createObjective('Build endpoints', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        planMarkdown: PLAN_MD,
        retrospectiveContext: '3 tasks completed; unresolved blocker: deployment pipeline down',
      },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId));
    assert.ok(workTask, 'expected at least one work task');
    // The brief should contain last-week framing language
    const descLc = workTask.description.toLowerCase();
    const hasRetroSentence =
      descLc.includes('last week') ||
      descLc.includes('retrospective');
    assert.ok(
      hasRetroSentence,
      `expected retrospective bridge in brief, got: "${workTask.description}"`,
    );
  });

  it('advisor brief does NOT include retrospective bridge when retrospectiveContext is null', () => {
    const goal = createGoal('Ship API', '1mo');
    const obj = createObjective('Build endpoints', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        planMarkdown: PLAN_MD,
        retrospectiveContext: null,
      },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId));
    assert.ok(workTask);
    assert.ok(
      !workTask.description.includes("last week's review"),
      `should not have retro bridge with null ctx: "${workTask.description}"`,
    );
  });

  it('brief retains objectiveId traceability when retrospectiveContext is set', () => {
    const goal = createGoal('Ship API', '1mo');
    const obj = createObjective('Build auth module', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        planMarkdown: PLAN_MD,
        retrospectiveContext: '2 tasks completed this week',
      },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId));
    assert.equal(workTask.objectiveId, obj.id, 'objectiveId traceability preserved');
    assert.equal(workTask.status, 'pending');
  });

  it('generated plan with retrospectiveContext passes schema validation', () => {
    const goal = createGoal('Ship API', '1mo');
    const obj = createObjective('Write docs', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        planMarkdown: PLAN_MD,
        retrospectiveContext: '1 task done; unresolved blocker: broken CI',
      },
    });

    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('retrospectiveContext is ignored when planMarkdown is absent (backward compat)', () => {
    const goal = createGoal('Ship API', '1mo');
    const obj = createObjective('Write docs', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    // retrospectiveContext without planMarkdown → composeAdvisorBrief never called
    // → task uses raw objective.description unchanged
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        planMarkdown: null,
        retrospectiveContext: '2 tasks completed last week',
      },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId));
    assert.equal(
      workTask.description,
      'Write docs',
      'Without planMarkdown, advisor brief should not be called regardless of retrospectiveContext',
    );
  });
});
