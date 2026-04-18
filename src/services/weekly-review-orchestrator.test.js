import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  nextISOWeek,
  isoWeeksInYear,
  mondayFromISOWeek,
  buildReviewHeader,
  assembleReviewDocument,
  buildReviewMetadata,
  reviewsDir,
  reviewPaths,
  persistReview,
  loadReview,
  listReviews,
  generateWeeklyReview,
} from './weekly-review-orchestrator.js';

import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { InboxStore } from '../storage/inbox-store.js';
import { AgentStore } from '../storage/agent-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ID = 'agent-orchtest1234';
const WEEK = '2026-W16';
const WEEK_MONDAY = '2026-04-13';
const GENERATED_AT = '2026-04-19T18:00:00.000Z';

function makePlan(tasks = [], overrides = {}) {
  return {
    week: WEEK,
    month: '2026-04',
    tasks,
    approved: true,
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(id, status = 'completed', overrides = {}) {
  return {
    id,
    description: `Task ${id}`,
    objectiveId: 'obj-abc12345',
    status,
    priority: 'medium',
    ...overrides,
  };
}

function makeLogEntry(id, status = 'completed', overrides = {}) {
  return {
    id,
    timestamp: '2026-04-14T10:00:00.000Z',
    agentId: AGENT_ID,
    status,
    description: `Log entry ${id}`,
    ...overrides,
  };
}

function makeAgentConfig(overrides = {}) {
  return {
    id: AGENT_ID,
    subagentRef: AGENT_ID,
    goals: [],
    budget: {
      weeklyTokenLimit: 500000,
      currentUsage: 0,
      periodStart: '2026-04-13T00:00:00.000Z',
    },
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// nextISOWeek
// ---------------------------------------------------------------------------

describe('nextISOWeek', () => {
  it('increments a normal week', () => {
    assert.equal(nextISOWeek('2026-W16'), '2026-W17');
  });

  it('increments single-digit weeks with zero-padding', () => {
    assert.equal(nextISOWeek('2026-W01'), '2026-W02');
    assert.equal(nextISOWeek('2026-W09'), '2026-W10');
  });

  it('rolls over to next year at week 52 (52-week year)', () => {
    // 2026 has 53 weeks, so W52 → W53
    assert.equal(nextISOWeek('2026-W52'), '2026-W53');
    // 2025 has 52 weeks, so W52 → 2026-W01
    assert.equal(nextISOWeek('2025-W52'), '2026-W01');
  });

  it('rolls over from W53 to next year W01', () => {
    assert.equal(nextISOWeek('2026-W53'), '2027-W01');
  });

  it('throws on invalid format', () => {
    assert.throws(() => nextISOWeek('2026-16'), /Invalid ISO week/);
    assert.throws(() => nextISOWeek('not-a-week'), /Invalid ISO week/);
  });
});

// ---------------------------------------------------------------------------
// isoWeeksInYear
// ---------------------------------------------------------------------------

describe('isoWeeksInYear', () => {
  it('returns 52 for a typical year', () => {
    assert.equal(isoWeeksInYear(2025), 52);
  });

  it('returns 53 for a long year (2026 has 53 weeks)', () => {
    assert.equal(isoWeeksInYear(2026), 53);
  });
});

// ---------------------------------------------------------------------------
// mondayFromISOWeek
// ---------------------------------------------------------------------------

describe('mondayFromISOWeek', () => {
  it('returns correct Monday for 2026-W16', () => {
    assert.equal(mondayFromISOWeek('2026-W16'), '2026-04-13');
  });

  it('returns correct Monday for first week of year', () => {
    assert.equal(mondayFromISOWeek('2026-W01'), '2025-12-29');
  });

  it('throws on invalid format', () => {
    assert.throws(() => mondayFromISOWeek('invalid'), /Invalid ISO week/);
  });
});

// ---------------------------------------------------------------------------
// buildReviewHeader
// ---------------------------------------------------------------------------

describe('buildReviewHeader', () => {
  it('builds markdown header with agent info and date range', () => {
    const header = buildReviewHeader({
      agentId: AGENT_ID,
      agentName: 'Test Agent',
      week: WEEK,
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
    });

    assert.ok(header.includes('# Weekly Review: Test Agent'));
    assert.ok(header.includes(`**Week:** ${WEEK}`));
    assert.ok(header.includes(WEEK_MONDAY));
    assert.ok(header.includes('2026-04-19')); // Sunday
    assert.ok(header.includes(`**Agent:** ${AGENT_ID}`));
    assert.ok(header.includes(`**Generated:** ${GENERATED_AT}`));
  });

  it('falls back to agentId when agentName is falsy', () => {
    const header = buildReviewHeader({
      agentId: AGENT_ID,
      agentName: null,
      week: WEEK,
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
    });

    assert.ok(header.includes(`# Weekly Review: ${AGENT_ID}`));
  });
});

// ---------------------------------------------------------------------------
// assembleReviewDocument
// ---------------------------------------------------------------------------

describe('assembleReviewDocument', () => {
  const sections = {
    header: '# Weekly Review: Test\n\n---\n\n',
    completedTasks: '## Completed Tasks\n\n_No tasks._\n',
    metrics: '## Metrics\n\n| Metric | Value |\n',
    blockers: '## Blockers\n\n_No blockers._ \n',
    completionRates: '## Completion Rates\n\nAll good.\n',
    calendar: 'Mon 2026-04-13\nTue 2026-04-14\n',
    nextWeek: '## Next Week\n\n_No tasks planned._\n',
  };

  it('includes all sections in order', () => {
    const doc = assembleReviewDocument(sections);

    // Header comes first
    assert.ok(doc.startsWith('# Weekly Review: Test'));

    // Table of Contents
    assert.ok(doc.includes('## Table of Contents'));
    assert.ok(doc.includes('[Completed Tasks]'));
    assert.ok(doc.includes('[Metrics]'));
    assert.ok(doc.includes('[Blockers]'));
    assert.ok(doc.includes('[Completion Rates]'));
    assert.ok(doc.includes('[Weekly Calendar]'));
    assert.ok(doc.includes('[Next Week]'));

    // All sections present
    assert.ok(doc.includes('## Completed Tasks'));
    assert.ok(doc.includes('## Metrics'));
    assert.ok(doc.includes('## Blockers'));
    assert.ok(doc.includes('## Completion Rates'));
    assert.ok(doc.includes('## Weekly Calendar'));
    assert.ok(doc.includes('## Next Week'));

    // Calendar wrapped in code block
    assert.ok(doc.includes('```\nMon 2026-04-13'));
  });

  it('includes footer', () => {
    const doc = assembleReviewDocument(sections);
    assert.ok(doc.includes('auto-generated by aweek'));
  });

  it('sections appear in correct order', () => {
    const doc = assembleReviewDocument(sections);
    const completedIdx = doc.indexOf('## Completed Tasks');
    const metricsIdx = doc.indexOf('## Metrics');
    const blockersIdx = doc.indexOf('## Blockers');
    const completionIdx = doc.indexOf('## Completion Rates');
    const calendarIdx = doc.indexOf('## Weekly Calendar');
    const nextWeekIdx = doc.indexOf('## Next Week');

    assert.ok(completedIdx < metricsIdx, 'Completed before Metrics');
    assert.ok(metricsIdx < blockersIdx, 'Metrics before Blockers');
    assert.ok(blockersIdx < completionIdx, 'Blockers before Completion');
    assert.ok(completionIdx < calendarIdx, 'Completion before Calendar');
    assert.ok(calendarIdx < nextWeekIdx, 'Calendar before Next Week');
  });
});

// ---------------------------------------------------------------------------
// buildReviewMetadata
// ---------------------------------------------------------------------------

describe('buildReviewMetadata', () => {
  it('builds metadata with summary from section data', () => {
    const meta = buildReviewMetadata({
      agentId: AGENT_ID,
      week: WEEK,
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      completedTasksData: { completedTasks: [{ id: 1 }, { id: 2 }] },
      metricsData: {
        metrics: { tokens: { totalTokens: 10000, costUsd: 0.05 } },
      },
      blockersData: { blockers: [{ id: 1 }] },
      completionData: { weekly: { completionRate: 75, effectiveRate: 80 } },
      nextWeekData: {
        items: [{ id: 1 }, { id: 2 }, { id: 3 }],
        counts: { planned: 2, carryOver: 1, inbox: 0 },
      },
    });

    assert.equal(meta.agentId, AGENT_ID);
    assert.equal(meta.week, WEEK);
    assert.equal(meta.summary.completedTaskCount, 2);
    assert.equal(meta.summary.blockerCount, 1);
    assert.equal(meta.summary.completionRate, 75);
    assert.equal(meta.summary.effectiveRate, 80);
    assert.equal(meta.summary.totalTokens, 10000);
    assert.equal(meta.summary.costUsd, 0.05);
    assert.equal(meta.summary.nextWeekItemCount, 3);
  });

  it('handles null/missing data gracefully', () => {
    const meta = buildReviewMetadata({
      agentId: AGENT_ID,
      week: WEEK,
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      completedTasksData: null,
      metricsData: null,
      blockersData: null,
      completionData: null,
      nextWeekData: null,
    });

    assert.equal(meta.summary.completedTaskCount, 0);
    assert.equal(meta.summary.blockerCount, 0);
    assert.equal(meta.summary.completionRate, null);
    assert.equal(meta.summary.totalTokens, 0);
    assert.equal(meta.summary.nextWeekItemCount, 0);
  });
});

// ---------------------------------------------------------------------------
// reviewsDir / reviewPaths
// ---------------------------------------------------------------------------

describe('reviewsDir', () => {
  it('returns correct directory path', () => {
    const dir = reviewsDir('/data/agents', AGENT_ID);
    assert.equal(dir, `/data/agents/${AGENT_ID}/reviews`);
  });
});

describe('reviewPaths', () => {
  it('returns markdown and metadata paths', () => {
    const paths = reviewPaths('/data/agents', AGENT_ID, WEEK);
    assert.ok(paths.markdownPath.endsWith(`${WEEK}.md`));
    assert.ok(paths.metadataPath.endsWith(`${WEEK}.json`));
  });
});

// ---------------------------------------------------------------------------
// persistReview / loadReview / listReviews
// ---------------------------------------------------------------------------

describe('persistReview', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-orch-persist-'));
  });

  it('persists markdown and metadata files', async () => {
    const content = '# Review\n\nSome content.\n';
    const meta = { agentId: AGENT_ID, week: WEEK };

    const paths = await persistReview(tmpDir, AGENT_ID, WEEK, content, meta);

    const savedMd = await readFile(paths.markdownPath, 'utf-8');
    assert.equal(savedMd, content);

    const savedMeta = JSON.parse(await readFile(paths.metadataPath, 'utf-8'));
    assert.equal(savedMeta.agentId, AGENT_ID);
    assert.equal(savedMeta.week, WEEK);
  });

  it('creates directories as needed', async () => {
    const paths = await persistReview(tmpDir, 'agent-new12345678', WEEK, 'test', {});
    const savedMd = await readFile(paths.markdownPath, 'utf-8');
    assert.equal(savedMd, 'test');
  });

  it('overwrites existing review (idempotent)', async () => {
    await persistReview(tmpDir, AGENT_ID, WEEK, 'first', { v: 1 });
    await persistReview(tmpDir, AGENT_ID, WEEK, 'second', { v: 2 });

    const paths = reviewPaths(tmpDir, AGENT_ID, WEEK);
    const savedMd = await readFile(paths.markdownPath, 'utf-8');
    assert.equal(savedMd, 'second');
  });
});

describe('loadReview', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-orch-load-'));
  });

  it('loads persisted review', async () => {
    await persistReview(tmpDir, AGENT_ID, WEEK, '# Doc', { week: WEEK });

    const result = await loadReview(tmpDir, AGENT_ID, WEEK);
    assert.equal(result.markdown, '# Doc');
    assert.equal(result.metadata.week, WEEK);
  });

  it('returns null for non-existent review', async () => {
    const result = await loadReview(tmpDir, AGENT_ID, '2026-W99');
    assert.equal(result, null);
  });
});

describe('listReviews', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-orch-list-'));
  });

  it('returns empty array when no reviews exist', async () => {
    const weeks = await listReviews(tmpDir, AGENT_ID);
    assert.deepStrictEqual(weeks, []);
  });

  it('lists persisted review weeks in order', async () => {
    await persistReview(tmpDir, AGENT_ID, '2026-W18', 'r3', {});
    await persistReview(tmpDir, AGENT_ID, '2026-W16', 'r1', {});
    await persistReview(tmpDir, AGENT_ID, '2026-W17', 'r2', {});

    const weeks = await listReviews(tmpDir, AGENT_ID);
    assert.deepStrictEqual(weeks, ['2026-W16', '2026-W17', '2026-W18']);
  });

  it('ignores non-week files', async () => {
    await persistReview(tmpDir, AGENT_ID, '2026-W16', 'r1', {});
    // The metadata .json file is also in the directory — should be ignored
    const weeks = await listReviews(tmpDir, AGENT_ID);
    assert.deepStrictEqual(weeks, ['2026-W16']);
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyReview (full integration)
// ---------------------------------------------------------------------------

describe('generateWeeklyReview', () => {
  let tmpDir;
  let agentStore;
  let weeklyPlanStore;
  let activityLogStore;
  let usageStore;
  let inboxStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-orch-full-'));
    agentStore = new AgentStore(tmpDir);
    weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    activityLogStore = new ActivityLogStore(tmpDir);
    usageStore = new UsageStore(tmpDir);
    inboxStore = new InboxStore(tmpDir);

    // Save a minimal agent config
    await agentStore.init();
    await agentStore.save(makeAgentConfig());
  });

  function deps() {
    return { agentStore, weeklyPlanStore, activityLogStore, usageStore, inboxStore };
  }

  it('generates a complete review with all sections', async () => {
    const plan = makePlan([
      makeTask('task-aaa11111', 'completed', { completedAt: '2026-04-14T10:00:00.000Z' }),
      makeTask('task-bbb22222', 'pending'),
      makeTask('task-ccc33333', 'failed'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    // Verify markdown structure
    assert.ok(result.markdown.includes('# Weekly Review:'));
    assert.ok(result.markdown.includes('## Table of Contents'));
    assert.ok(result.markdown.includes('## Completed Tasks'));
    assert.ok(result.markdown.includes('## Metrics'));
    assert.ok(result.markdown.includes('## Blockers'));
    assert.ok(result.markdown.includes('## Completion Rates'));
    assert.ok(result.markdown.includes('## Weekly Calendar'));
    assert.ok(result.markdown.includes('## Next Week'));
    assert.ok(result.markdown.includes('auto-generated by aweek'));
  });

  it('returns structured metadata', async () => {
    const plan = makePlan([
      makeTask('task-aaa11111', 'completed', { completedAt: '2026-04-14T10:00:00.000Z' }),
      makeTask('task-bbb22222', 'failed'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    assert.equal(result.metadata.agentId, AGENT_ID);
    assert.equal(result.metadata.week, WEEK);
    assert.equal(result.metadata.weekMonday, WEEK_MONDAY);
    assert.equal(result.metadata.summary.completedTaskCount, 1);
    assert.equal(result.metadata.summary.blockerCount, 1);
    assert.equal(typeof result.metadata.summary.completionRate, 'number');
  });

  it('persists review to disk by default', async () => {
    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    assert.ok(result.paths);
    assert.ok(result.paths.markdownPath.endsWith('.md'));
    assert.ok(result.paths.metadataPath.endsWith('.json'));

    // Verify files exist and are readable
    const savedMd = await readFile(result.paths.markdownPath, 'utf-8');
    assert.ok(savedMd.includes('# Weekly Review:'));

    const savedMeta = JSON.parse(await readFile(result.paths.metadataPath, 'utf-8'));
    assert.equal(savedMeta.agentId, AGENT_ID);
  });

  it('skips persistence when persist=false', async () => {
    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.equal(result.paths, null);
    assert.ok(result.markdown.length > 0);
    assert.ok(result.metadata.agentId === AGENT_ID);
  });

  it('works with empty data (no plan, no logs)', async () => {
    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    assert.ok(result.markdown.includes('No tasks were completed'));
    assert.ok(result.markdown.includes('No blockers'));
    assert.equal(result.metadata.summary.completedTaskCount, 0);
    assert.equal(result.metadata.summary.blockerCount, 0);
  });

  it('works without agent config (graceful fallback)', async () => {
    const result = await generateWeeklyReview(deps(), 'agent-nonexist123', WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    // Should still generate a review, using agentId as name
    assert.ok(result.markdown.includes('# Weekly Review: agent-nonexist123'));
  });

  it('is idempotent — regenerating overwrites without duplication', async () => {
    const plan = makePlan([
      makeTask('task-aaa11111', 'completed', { completedAt: '2026-04-14T10:00:00.000Z' }),
    ]);
    await weeklyPlanStore.save(AGENT_ID, plan);

    // Generate twice
    await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });
    const result2 = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: '2026-04-19T19:00:00.000Z', // different timestamp
      baseDir: tmpDir,
    });

    // Only one review for this week should exist
    const weeks = await listReviews(tmpDir, AGENT_ID);
    assert.deepStrictEqual(weeks, [WEEK]);

    // Should have the newer timestamp
    const loaded = await loadReview(tmpDir, AGENT_ID, WEEK);
    assert.ok(loaded.markdown.includes('2026-04-19T19:00:00.000Z'));
  });

  it('enriches with activity log data', async () => {
    const entry = makeLogEntry('log-aaa11111', 'completed', {
      agentId: AGENT_ID,
      description: 'Ad-hoc completed work',
      duration: 120000,
    });
    await activityLogStore.append(AGENT_ID, entry);

    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    assert.ok(result.markdown.includes('Ad-hoc completed work'));
    assert.equal(result.metadata.summary.completedTaskCount, 1);
  });

  it('includes next-week carry-over tasks', async () => {
    const plan = makePlan([
      makeTask('task-aaa11111', 'completed', { completedAt: '2026-04-14T10:00:00.000Z' }),
      makeTask('task-bbb22222', 'pending', { description: 'Unfinished work' }),
    ]);
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    assert.ok(result.markdown.includes('## Next Week'));
    assert.ok(result.markdown.includes('Unfinished work'));
  });

  it('uses agent id as fallback name in header', async () => {
    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      weekMonday: WEEK_MONDAY,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    assert.ok(result.markdown.includes(`# Weekly Review: ${AGENT_ID}`));
  });

  it('auto-derives weekMonday from week when not provided', async () => {
    const result = await generateWeeklyReview(deps(), AGENT_ID, WEEK, {
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.equal(result.metadata.weekMonday, WEEK_MONDAY);
  });
});
