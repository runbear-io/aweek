/**
 * Tests for src/services/daily-review-adjustments.js
 *
 * Covers:
 *   - Date helpers (tomorrowDateStr, runAtForDate)
 *   - extractWeeklyAdjustmentOps — adjustment record → weeklyAdjustment op conversion
 *   - applyDailyReviewAdjustments — main entry point (integration with adjustGoals)
 *
 * Also exercises the `generateDailyReview` integration: after a review is
 * persisted to disk the function should return `appliedAdjustments` with
 * the applied ops and mutate the live weekly plan so the new tasks are
 * immediately pending.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

import {
  tomorrowDateStr,
  runAtForDate,
  extractWeeklyAdjustmentOps,
  applyDailyReviewAdjustments,
} from './daily-review-adjustments.js';

import { generateDailyReview } from './daily-review-writer.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { AgentStore } from '../storage/agent-store.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = 'agent-drwadj1234';
const DATE = '2026-04-14'; // Tuesday in 2026-W16
const TOMORROW = '2026-04-15'; // Wednesday
const WEEK = '2026-W16';

interface TaskOverrides {
  description?: string;
  title?: string;
  prompt?: string;
  objectiveId?: string | null | undefined;
  priority?: string;
  runAt?: string;
  status?: string;
  completedAt?: string;
  [key: string]: unknown;
}

interface TestTask {
  id: string;
  title: string;
  prompt: string;
  objectiveId?: string | null;
  status: string;
  priority: string;
  runAt?: string;
  completedAt?: string;
  [key: string]: unknown;
}

function makeTask(id: string, status: string = 'pending', overrides: TaskOverrides = {}): TestTask {
  const { description, title, prompt, ...rest } = overrides;
  const label = title || prompt || description || `Task ${id}`;
  return {
    id,
    title: title || label,
    prompt: prompt || label,
    objectiveId: 'obj-work01',
    status,
    priority: 'medium',
    runAt: `${DATE}T09:00:00.000Z`,
    ...rest,
  };
}

interface TestWeeklyPlan {
  week: string;
  month: string;
  tasks: TestTask[];
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

function makeWeeklyPlan(tasks: TestTask[] = []): TestWeeklyPlan {
  return {
    week: WEEK,
    month: '2026-04',
    tasks,
    approved: true,
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
  };
}

function makeAdjRecord(type: string, taskId: string, title: string = `Task ${taskId}`) {
  return { type, taskId, title, text: `Advisory text for ${taskId}.` };
}

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
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
// tomorrowDateStr
// ---------------------------------------------------------------------------

describe('tomorrowDateStr', () => {
  it('returns the next calendar day', () => {
    assert.equal(tomorrowDateStr('2026-04-14'), '2026-04-15');
  });

  it('handles month rollover', () => {
    assert.equal(tomorrowDateStr('2026-04-30'), '2026-05-01');
  });

  it('handles year rollover', () => {
    assert.equal(tomorrowDateStr('2026-12-31'), '2027-01-01');
  });

  it('handles leap year Feb 28→29', () => {
    assert.equal(tomorrowDateStr('2024-02-28'), '2024-02-29');
  });
});

// ---------------------------------------------------------------------------
// runAtForDate
// ---------------------------------------------------------------------------

describe('runAtForDate', () => {
  it('defaults to 09:00 UTC', () => {
    assert.equal(runAtForDate('2026-04-15'), '2026-04-15T09:00:00.000Z');
  });

  it('respects explicit hour', () => {
    assert.equal(runAtForDate('2026-04-15', 14), '2026-04-15T14:00:00.000Z');
  });

  it('returns a valid ISO 8601 datetime', () => {
    const result = runAtForDate('2026-04-15');
    assert.ok(!isNaN(Date.parse(result)), 'Result should parse as a valid date');
  });
});

// ---------------------------------------------------------------------------
// extractWeeklyAdjustmentOps
// ---------------------------------------------------------------------------

describe('extractWeeklyAdjustmentOps', () => {
  it('returns empty array when no adjustment records', () => {
    const plan = makeWeeklyPlan([makeTask('task-aaa11111')]);
    assert.deepStrictEqual(extractWeeklyAdjustmentOps([], plan, DATE, WEEK), []);
  });

  it('returns empty array when no weekly plan', () => {
    const records = [makeAdjRecord('carry-over', 'task-aaa11111')];
    assert.deepStrictEqual(extractWeeklyAdjustmentOps(records, null, DATE, WEEK), []);
  });

  it('returns empty array when plan has no tasks', () => {
    const plan = makeWeeklyPlan([]);
    const records = [makeAdjRecord('carry-over', 'task-aaa11111')];
    assert.deepStrictEqual(extractWeeklyAdjustmentOps(records, plan, DATE, WEEK), []);
  });

  it('skips records whose taskId is not in the plan', () => {
    const plan = makeWeeklyPlan([makeTask('task-aaa11111')]);
    const records = [makeAdjRecord('carry-over', 'task-nothere1')];
    assert.deepStrictEqual(extractWeeklyAdjustmentOps(records, plan, DATE, WEEK), []);
  });

  it('generates update+runAt op for carry-over', () => {
    const task = makeTask('task-bbb22222', 'pending');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('carry-over', 'task-bbb22222')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].action, 'update');
    assert.equal(ops[0].taskId, 'task-bbb22222');
    assert.equal(ops[0].week, WEEK);
    assert.equal(ops[0].runAt, `${TOMORROW}T09:00:00.000Z`);
    assert.equal(ops[0].status, undefined);
  });

  it('generates NO op for continue (in-progress task)', () => {
    const task = makeTask('task-ccc33333', 'in-progress');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('continue', 'task-ccc33333')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 0, 'continue type should produce no weekly op');
  });

  it('generates update with status:pending + runAt for retry', () => {
    const task = makeTask('task-ddd44444', 'failed');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('retry', 'task-ddd44444')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].action, 'update');
    assert.equal(ops[0].taskId, 'task-ddd44444');
    assert.equal(ops[0].status, 'pending');
    assert.equal(ops[0].runAt, `${TOMORROW}T09:00:00.000Z`);
  });

  it('generates update+runAt op for reschedule', () => {
    const task = makeTask('task-eee55555', 'skipped');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('reschedule', 'task-eee55555')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].action, 'update');
    assert.equal(ops[0].taskId, 'task-eee55555');
    assert.equal(ops[0].runAt, `${TOMORROW}T09:00:00.000Z`);
    assert.equal(ops[0].status, undefined);
  });

  it('generates add op for follow-up when task has objectiveId', () => {
    const task = makeTask('task-fff66666', 'delegated', { objectiveId: 'obj-lead01' });
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('follow-up', 'task-fff66666', 'Write the report')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.action, 'add');
    assert.equal(ops[0]!.week, WEEK);
    assert.equal(ops[0]!.objectiveId, 'obj-lead01');
    assert.ok(ops[0]!.prompt!.includes('Write the report'));
    assert.equal(ops[0]!.runAt, `${TOMORROW}T09:00:00.000Z`);
  });

  it('skips follow-up op when delegated task has no objectiveId', () => {
    const task = makeTask('task-ggg77777', 'delegated', { objectiveId: undefined });
    delete (task as { objectiveId?: string | null }).objectiveId;
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('follow-up', 'task-ggg77777')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 0);
  });

  it('handles mixed adjustment types correctly', () => {
    const tasks = [
      makeTask('task-aaa11111', 'pending'),
      makeTask('task-bbb22222', 'in-progress'),
      makeTask('task-ccc33333', 'failed'),
      makeTask('task-ddd44444', 'skipped'),
      makeTask('task-eee55555', 'delegated'),
    ];
    const plan = makeWeeklyPlan(tasks);
    const records = [
      makeAdjRecord('carry-over', 'task-aaa11111'),
      makeAdjRecord('continue', 'task-bbb22222'),
      makeAdjRecord('retry', 'task-ccc33333'),
      makeAdjRecord('reschedule', 'task-ddd44444'),
      makeAdjRecord('follow-up', 'task-eee55555'),
    ];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 4);
    assert.equal(ops.filter((o) => o.action === 'update').length, 3);
    assert.equal(ops.filter((o) => o.action === 'add').length, 1);
  });

  it('ignores unknown adjustment types', () => {
    const task = makeTask('task-zzz99999', 'pending');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('some-future-type', 'task-zzz99999')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 0);
  });
});

// ---------------------------------------------------------------------------
// applyDailyReviewAdjustments — main entry point
// ---------------------------------------------------------------------------

describe('applyDailyReviewAdjustments', () => {
  let tmpDir: string;
  let agentStore: AgentStore;
  let weeklyPlanStore: WeeklyPlanStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drwadj-apply-'));
    agentStore = new AgentStore(tmpDir);
    weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    await agentStore.init();
    await agentStore.save(makeAgentConfig());
  });

  it('returns applied:false when no adjustment records', async () => {
    const plan = makeWeeklyPlan([makeTask('task-aaa11111')]);
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await applyDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: [],
      weeklyPlan: plan,
    });

    assert.equal(result.applied, false);
    assert.equal(result.opsCount, 0);
    assert.equal(result.skippedCount, 0);
  });

  it('returns applied:false when no weekly plan', async () => {
    const records = [makeAdjRecord('carry-over', 'task-aaa11111')];
    const result = await applyDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: null,
    });

    assert.equal(result.applied, false);
    assert.equal(result.skippedCount, 1);
  });

  it('returns applied:false when all records produce no ops (e.g. all continue)', async () => {
    const task = makeTask('task-bbb22222', 'in-progress');
    const plan = makeWeeklyPlan([task]);
    await weeklyPlanStore.save(AGENT_ID, plan);
    const records = [makeAdjRecord('continue', 'task-bbb22222')];

    const result = await applyDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
    });

    assert.equal(result.applied, false);
    assert.equal(result.skippedCount, 1);
  });

  it('applies a carry-over op directly to the weekly plan', async () => {
    const task = makeTask('task-ccc33333', 'pending');
    const plan = makeWeeklyPlan([task]);
    await weeklyPlanStore.save(AGENT_ID, plan);
    const records = [makeAdjRecord('carry-over', 'task-ccc33333')];

    const result = await applyDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
    });

    assert.equal(result.applied, true);
    assert.equal(result.opsCount, 1);

    // Task runAt should now point at tomorrow 09:00 UTC in the stored plan.
    const persisted = await weeklyPlanStore.load(AGENT_ID, WEEK) as TestWeeklyPlan;
    const updated = persisted.tasks.find((t: TestTask) => t.id === 'task-ccc33333')!;
    assert.equal(updated.runAt, `${TOMORROW}T09:00:00.000Z`);
    assert.equal(updated.status, 'pending');
  });

  it('applies a retry op: failed task reset to pending with tomorrow runAt', async () => {
    const task = makeTask('task-ddd44444', 'failed');
    const plan = makeWeeklyPlan([task]);
    await weeklyPlanStore.save(AGENT_ID, plan);
    const records = [makeAdjRecord('retry', 'task-ddd44444')];

    await applyDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
    });

    const persisted = await weeklyPlanStore.load(AGENT_ID, WEEK) as TestWeeklyPlan;
    const updated = persisted.tasks.find((t: TestTask) => t.id === 'task-ddd44444')!;
    assert.equal(updated.status, 'pending');
    assert.equal(updated.runAt, `${TOMORROW}T09:00:00.000Z`);
  });

  it('applies a follow-up op: new pending task appears in the plan', async () => {
    const task = makeTask('task-eee55555', 'delegated', { objectiveId: 'obj-lead01' });
    const plan = makeWeeklyPlan([task]);
    await weeklyPlanStore.save(AGENT_ID, plan);
    const records = [makeAdjRecord('follow-up', 'task-eee55555', 'Write docs')];

    const result = await applyDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
    });

    assert.equal(result.applied, true);

    const persisted = await weeklyPlanStore.load(AGENT_ID, WEEK) as TestWeeklyPlan;
    assert.equal(persisted.tasks.length, 2);
    const followUp = persisted.tasks.find((t: TestTask) => t.id !== 'task-eee55555')!;
    assert.equal(followUp.status, 'pending');
    assert.equal(followUp.objectiveId, 'obj-lead01');
    assert.ok(followUp.prompt.includes('Write docs'));
  });

  it('returns errors and mutates nothing when ops fail validation', async () => {
    // Plan saved under WEEK, but we ask to apply ops against a mismatched
    // week — adjustGoals will reject because no plan exists for 2026-W99.
    const task = makeTask('task-fff66666', 'pending');
    const plan = makeWeeklyPlan([task]);
    await weeklyPlanStore.save(AGENT_ID, plan);
    const records = [makeAdjRecord('carry-over', 'task-fff66666')];

    const mismatchedPlan = { ...plan, week: '2026-W99' };

    const result = await applyDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: '2026-W99',
      adjustmentRecords: records,
      weeklyPlan: mismatchedPlan,
    });

    assert.equal(result.applied, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.length > 0);

    // Original plan untouched
    const persisted = await weeklyPlanStore.load(AGENT_ID, WEEK) as TestWeeklyPlan;
    assert.equal(persisted.tasks[0]!.runAt, `${DATE}T09:00:00.000Z`);
  });
});

// ---------------------------------------------------------------------------
// generateDailyReview integration: appliedAdjustments in the return value
// ---------------------------------------------------------------------------

describe('generateDailyReview — appliedAdjustments integration', () => {
  let tmpDir: string;
  let agentStore: AgentStore;
  let weeklyPlanStore: WeeklyPlanStore;
  let activityLogStore: ActivityLogStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drwadj-int-'));
    agentStore = new AgentStore(tmpDir);
    weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    activityLogStore = new ActivityLogStore(tmpDir);
    await agentStore.init();
    await agentStore.save(makeAgentConfig());
  });

  function deps() {
    return { agentStore, weeklyPlanStore, activityLogStore };
  }

  it('returns appliedAdjustments:null when persist=false', async () => {
    const plan = {
      week: WEEK, month: '2026-04', tasks: [makeTask('task-aaa11111', 'pending')],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      baseDir: tmpDir,
      persist: false,
    });

    assert.equal(result.appliedAdjustments, null);
  });

  it('returns appliedAdjustments:null when no adjustments (all tasks completed)', async () => {
    const plan = {
      week: WEEK, month: '2026-04',
      tasks: [makeTask('task-bbb22222', 'completed', { completedAt: `${DATE}T12:00:00.000Z` })],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK, baseDir: tmpDir,
    });

    assert.equal(result.appliedAdjustments, null);
  });

  it('mutates the stored plan when pending tasks are rescheduled', async () => {
    const plan = {
      week: WEEK, month: '2026-04',
      tasks: [makeTask('task-ccc33333', 'pending')],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK, baseDir: tmpDir,
    });

    assert.ok(result.appliedAdjustments !== null);
    assert.equal(result.appliedAdjustments.applied, true);
    assert.equal(result.appliedAdjustments.opsCount, 1);

    const persisted = await weeklyPlanStore.load(AGENT_ID, WEEK) as TestWeeklyPlan;
    const updated = persisted.tasks.find((t: TestTask) => t.id === 'task-ccc33333')!;
    assert.equal(updated.runAt, `${TOMORROW}T09:00:00.000Z`);
    assert.equal(updated.status, 'pending');
  });

  it('leaves the daily review markdown intact even if apply cannot find a plan', async () => {
    // Save a plan under a different week so weeklyPlanStore.load(WEEK) returns null.
    // No adjustments can be applied → appliedAdjustments stays null, but the
    // review markdown is still written.
    const mismatchedPlan = {
      week: '2026-W99', month: '2026-04',
      tasks: [makeTask('task-fff66666', 'pending')],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, mismatchedPlan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK, baseDir: tmpDir,
    });

    assert.ok(result.markdown.length > 0);
    assert.ok(result.paths !== null);
    assert.ok(result.paths.markdownPath.endsWith(`daily-${DATE}.md`));
  });
});

// ----------------------------------------------------------------------------
// Time-zone-aware carry-over (preserves the original local time-of-day)
//
// Regression coverage for the bug where every carry-over / retry / reschedule
// op stamped the same `09:00 UTC` runAt onto each adjusted task, bunching
// dozens of tasks at one calendar cell. The fix preserves the original
// task's local time-of-day in the agent's configured zone, falling back to
// `09:00 local` for follow-ups (which have no original runAt) and to UTC
// when the zone is missing or invalid.
// ----------------------------------------------------------------------------

describe('runAtForDate (tz-aware)', () => {
  it('produces a UTC instant matching the requested local hour:minute in tz', () => {
    // 2026-04-29 in America/Los_Angeles is on PDT (UTC-7), so 09:00 local
    // = 16:00 UTC.
    assert.equal(
      runAtForDate('2026-04-29', 9, 0, 'America/Los_Angeles'),
      '2026-04-29T16:00:00.000Z',
    );
  });

  it('respects minute granularity', () => {
    assert.equal(
      runAtForDate('2026-04-29', 11, 30, 'America/Los_Angeles'),
      '2026-04-29T18:30:00.000Z',
    );
  });

  it('falls back to UTC interpretation when tz is invalid', () => {
    assert.equal(
      runAtForDate('2026-04-29', 9, 0, 'Not/A/Zone'),
      '2026-04-29T09:00:00.000Z',
    );
  });

  it('falls back to UTC when tz is omitted', () => {
    assert.equal(runAtForDate('2026-04-29', 9, 0), '2026-04-29T09:00:00.000Z');
  });
});

describe('extractWeeklyAdjustmentOps — time-of-day preservation', () => {
  const TZ_DATE = '2026-04-28'; // a Tuesday
  const TOMORROW_PT_NOON_UTC = '2026-04-29T19:00:00.000Z'; // 12:00 PT, PDT
  const TOMORROW_PT_3PM_UTC = '2026-04-29T22:00:00.000Z'; // 15:00 PT, PDT
  const TOMORROW_PT_9AM_UTC = '2026-04-29T16:00:00.000Z'; // 09:00 PT, PDT
  const TZ = 'America/Los_Angeles';

  it('carry-over: rewrites runAt to tomorrow at the original local time-of-day', () => {
    const plan = {
      tasks: [
        { id: 't1', objectiveId: 'o1', runAt: '2026-04-28T19:00:00.000Z' }, // 12:00 PT
        { id: 't2', objectiveId: 'o1', runAt: '2026-04-28T22:00:00.000Z' }, // 15:00 PT
      ],
    };
    const records = [
      { type: 'carry-over', taskId: 't1', title: 'a', text: 't' },
      { type: 'carry-over', taskId: 't2', title: 'b', text: 't' },
    ];
    const ops = extractWeeklyAdjustmentOps(records, plan, TZ_DATE, '2026-W18', TZ);
    assert.equal(ops.length, 2);
    assert.equal(ops[0].runAt, TOMORROW_PT_NOON_UTC);
    assert.equal(ops[1].runAt, TOMORROW_PT_3PM_UTC);
    assert.notStrictEqual(ops[0].runAt, ops[1].runAt);
  });

  it('retry: preserves the original local time-of-day too', () => {
    const plan = {
      tasks: [
        { id: 't1', objectiveId: 'o1', runAt: '2026-04-28T22:00:00.000Z' }, // 15:00 PT
      ],
    };
    const records = [{ type: 'retry', taskId: 't1', title: 'a', text: 't' }];
    const ops = extractWeeklyAdjustmentOps(records, plan, TZ_DATE, '2026-W18', TZ);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].runAt, TOMORROW_PT_3PM_UTC);
    assert.equal(ops[0].status, 'pending');
  });

  it('reschedule: preserves the original local time-of-day too', () => {
    const plan = {
      tasks: [
        { id: 't1', objectiveId: 'o1', runAt: '2026-04-28T22:00:00.000Z' },
      ],
    };
    const records = [
      { type: 'reschedule', taskId: 't1', title: 'a', text: 't' },
    ];
    const ops = extractWeeklyAdjustmentOps(records, plan, TZ_DATE, '2026-W18', TZ);
    assert.equal(ops[0].runAt, TOMORROW_PT_3PM_UTC);
  });

  it('follow-up: uses 09:00 local (no original runAt)', () => {
    const plan = {
      tasks: [{ id: 't1', objectiveId: 'o1' }],
    };
    const records = [
      { type: 'follow-up', taskId: 't1', title: 'thing', text: 't' },
    ];
    const ops = extractWeeklyAdjustmentOps(records, plan, TZ_DATE, '2026-W18', TZ);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].action, 'add');
    assert.equal(ops[0].runAt, TOMORROW_PT_9AM_UTC);
  });

  it('falls back to 09:00 local when the task has no runAt', () => {
    const plan = {
      tasks: [{ id: 't1', objectiveId: 'o1' }],
    };
    const records = [
      { type: 'carry-over', taskId: 't1', title: 'a', text: 't' },
    ];
    const ops = extractWeeklyAdjustmentOps(records, plan, TZ_DATE, '2026-W18', TZ);
    assert.equal(ops[0].runAt, TOMORROW_PT_9AM_UTC);
  });

  it('legacy callers without tz keep the pre-fix UTC behavior for tasks lacking runAt', () => {
    const plan = {
      tasks: [{ id: 't1', objectiveId: 'o1' }],
    };
    const records = [
      { type: 'carry-over', taskId: 't1', title: 'a', text: 't' },
    ];
    const ops = extractWeeklyAdjustmentOps(records, plan, TZ_DATE, '2026-W18');
    assert.equal(ops[0].runAt, '2026-04-29T09:00:00.000Z');
  });
});
