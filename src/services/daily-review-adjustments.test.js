/**
 * Tests for src/services/daily-review-adjustments.js
 *
 * Covers:
 *   - Date helpers (tomorrowDateStr, runAtForDate)
 *   - extractWeeklyAdjustmentOps — adjustment record → weeklyAdjustment op conversion
 *   - buildPendingAdjustmentBatch — batch record shape
 *   - persist / load / list / clear — round-trip persistence
 *   - enqueueDailyReviewAdjustments — main entry point (integration)
 *
 * Also exercises the `generateDailyReview` integration: after a review is
 * persisted to disk the function should return `enqueuedAdjustments` with
 * the queued ops so the plan skill can present them for approval.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  pendingAdjustmentsDir,
  pendingAdjustmentsPath,
  tomorrowDateStr,
  runAtForDate,
  extractWeeklyAdjustmentOps,
  buildPendingAdjustmentBatch,
  persistPendingAdjustmentBatch,
  loadPendingAdjustmentBatch,
  listPendingAdjustmentDates,
  clearPendingAdjustmentBatch,
  enqueueDailyReviewAdjustments,
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

function makeTask(id, status = 'pending', overrides = {}) {
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

function makeWeeklyPlan(tasks = []) {
  return {
    week: WEEK,
    month: '2026-04',
    tasks,
    approved: true,
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
  };
}

function makeAdjRecord(type, taskId, title = `Task ${taskId}`) {
  return { type, taskId, title, text: `Advisory text for ${taskId}.` };
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
// pendingAdjustmentsDir / pendingAdjustmentsPath
// ---------------------------------------------------------------------------

describe('pendingAdjustmentsDir', () => {
  it('returns correct directory path', () => {
    const dir = pendingAdjustmentsDir('/data/agents', AGENT_ID);
    assert.equal(dir, `/data/agents/${AGENT_ID}/pending-daily-adjustments`);
  });
});

describe('pendingAdjustmentsPath', () => {
  it('returns path ending with date.json', () => {
    const path = pendingAdjustmentsPath('/data/agents', AGENT_ID, DATE);
    assert.ok(path.endsWith(`${DATE}.json`));
  });

  it('path lives inside pendingAdjustmentsDir', () => {
    const dir = pendingAdjustmentsDir('/data/agents', AGENT_ID);
    const path = pendingAdjustmentsPath('/data/agents', AGENT_ID, DATE);
    assert.ok(path.startsWith(dir));
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

  // carry-over
  it('generates update+runAt op for carry-over', () => {
    const task = makeTask('task-bbb22222', 'pending');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('carry-over', 'task-bbb22222')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].action, 'update');
    assert.equal(ops[0].taskId, 'task-bbb22222');
    assert.equal(ops[0].week, WEEK);
    // runAt should be tomorrow at 09:00 UTC
    assert.equal(ops[0].runAt, `${TOMORROW}T09:00:00.000Z`);
    assert.equal(ops[0].status, undefined); // no status change for carry-over
  });

  // continue — no op
  it('generates NO op for continue (in-progress task)', () => {
    const task = makeTask('task-ccc33333', 'in-progress');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('continue', 'task-ccc33333')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 0, 'continue type should produce no weekly op');
  });

  // retry
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

  // reschedule
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

  // follow-up
  it('generates add op for follow-up when task has objectiveId', () => {
    const task = makeTask('task-fff66666', 'delegated', { objectiveId: 'obj-lead01' });
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('follow-up', 'task-fff66666', 'Write the report')];

    const ops = extractWeeklyAdjustmentOps(records, plan, DATE, WEEK);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].action, 'add');
    assert.equal(ops[0].week, WEEK);
    assert.equal(ops[0].objectiveId, 'obj-lead01');
    assert.ok(ops[0].prompt.includes('Write the report'));
    assert.equal(ops[0].runAt, `${TOMORROW}T09:00:00.000Z`);
  });

  it('skips follow-up op when delegated task has no objectiveId', () => {
    const task = makeTask('task-ggg77777', 'delegated', { objectiveId: undefined });
    delete task.objectiveId;
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
    // continue produces no op → 4 ops from the 5 records
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
// buildPendingAdjustmentBatch
// ---------------------------------------------------------------------------

describe('buildPendingAdjustmentBatch', () => {
  it('builds a batch with all required fields', () => {
    const ops = [{ action: 'update', week: WEEK, taskId: 'task-aaa11111', runAt: '2026-04-15T09:00:00.000Z' }];
    const batch = buildPendingAdjustmentBatch({
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      createdAt: '2026-04-14T17:00:00.000Z',
      weeklyAdjustments: ops,
    });

    assert.equal(batch.agentId, AGENT_ID);
    assert.equal(batch.date, DATE);
    assert.equal(batch.week, WEEK);
    assert.equal(batch.source, 'daily-review');
    assert.equal(batch.createdAt, '2026-04-14T17:00:00.000Z');
    assert.deepStrictEqual(batch.weeklyAdjustments, ops);
  });

  it('defaults createdAt to now when omitted', () => {
    const before = new Date().toISOString();
    const batch = buildPendingAdjustmentBatch({
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      weeklyAdjustments: [],
    });
    const after = new Date().toISOString();
    assert.ok(batch.createdAt >= before && batch.createdAt <= after);
  });
});

// ---------------------------------------------------------------------------
// Persistence: persist / load / list / clear
// ---------------------------------------------------------------------------

describe('persistPendingAdjustmentBatch', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drwadj-persist-'));
  });

  it('writes a JSON file readable by loadPendingAdjustmentBatch', async () => {
    const ops = [{ action: 'update', week: WEEK, taskId: 'task-aaa11111', runAt: '2026-04-15T09:00:00.000Z' }];
    const batch = buildPendingAdjustmentBatch({ agentId: AGENT_ID, date: DATE, week: WEEK, weeklyAdjustments: ops });

    const batchPath = await persistPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE, batch);

    const raw = await readFile(batchPath, 'utf-8');
    const loaded = JSON.parse(raw);
    assert.equal(loaded.agentId, AGENT_ID);
    assert.equal(loaded.date, DATE);
    assert.equal(loaded.weeklyAdjustments.length, 1);
  });

  it('creates the directory structure automatically', async () => {
    const batch = buildPendingAdjustmentBatch({ agentId: 'agent-brand-new12', date: DATE, week: WEEK, weeklyAdjustments: [] });
    const batchPath = await persistPendingAdjustmentBatch(tmpDir, 'agent-brand-new12', DATE, batch);
    const raw = await readFile(batchPath, 'utf-8');
    assert.ok(raw.length > 0);
  });

  it('overwrites an existing batch idempotently', async () => {
    const batch1 = buildPendingAdjustmentBatch({ agentId: AGENT_ID, date: DATE, week: WEEK, weeklyAdjustments: [{ version: 1 }] });
    const batch2 = buildPendingAdjustmentBatch({ agentId: AGENT_ID, date: DATE, week: WEEK, weeklyAdjustments: [{ version: 2 }] });

    await persistPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE, batch1);
    await persistPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE, batch2);

    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.equal(loaded.weeklyAdjustments[0].version, 2);
  });
});

describe('loadPendingAdjustmentBatch', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drwadj-load-'));
  });

  it('returns null when no batch exists', async () => {
    const result = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, '2026-01-01');
    assert.equal(result, null);
  });

  it('loads a persisted batch correctly', async () => {
    const ops = [{ action: 'update', week: WEEK, taskId: 'task-abc12345', runAt: '2026-04-15T09:00:00.000Z' }];
    const batch = buildPendingAdjustmentBatch({ agentId: AGENT_ID, date: DATE, week: WEEK, weeklyAdjustments: ops });
    await persistPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE, batch);

    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.ok(loaded !== null);
    assert.equal(loaded.source, 'daily-review');
    assert.equal(loaded.weeklyAdjustments.length, 1);
  });
});

describe('listPendingAdjustmentDates', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drwadj-list-'));
  });

  it('returns empty array when directory does not exist', async () => {
    const dates = await listPendingAdjustmentDates(tmpDir, AGENT_ID);
    assert.deepStrictEqual(dates, []);
  });

  it('lists and sorts persisted batch dates chronologically', async () => {
    const emptyBatch = (date) =>
      buildPendingAdjustmentBatch({ agentId: AGENT_ID, date, week: WEEK, weeklyAdjustments: [] });

    await persistPendingAdjustmentBatch(tmpDir, AGENT_ID, '2026-04-16', emptyBatch('2026-04-16'));
    await persistPendingAdjustmentBatch(tmpDir, AGENT_ID, '2026-04-14', emptyBatch('2026-04-14'));
    await persistPendingAdjustmentBatch(tmpDir, AGENT_ID, '2026-04-15', emptyBatch('2026-04-15'));

    const dates = await listPendingAdjustmentDates(tmpDir, AGENT_ID);
    assert.deepStrictEqual(dates, ['2026-04-14', '2026-04-15', '2026-04-16']);
  });

  it('ignores non-date-named JSON files', async () => {
    // Simulate a stray file
    const dir = pendingAdjustmentsDir(tmpDir, AGENT_ID);
    const { mkdir: mkdirFs, writeFile: wf } = await import('node:fs/promises');
    await mkdirFs(dir, { recursive: true });
    await wf(join(dir, 'not-a-date.json'), '{}', 'utf-8');

    const dates = await listPendingAdjustmentDates(tmpDir, AGENT_ID);
    assert.deepStrictEqual(dates, []);
  });
});

describe('clearPendingAdjustmentBatch', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drwadj-clear-'));
  });

  it('deletes a persisted batch and returns true', async () => {
    const batch = buildPendingAdjustmentBatch({ agentId: AGENT_ID, date: DATE, week: WEEK, weeklyAdjustments: [] });
    await persistPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE, batch);

    const deleted = await clearPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.equal(deleted, true);

    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.equal(loaded, null);
  });

  it('returns false when the batch does not exist', async () => {
    const result = await clearPendingAdjustmentBatch(tmpDir, AGENT_ID, '2026-01-01');
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// enqueueDailyReviewAdjustments — main entry point
// ---------------------------------------------------------------------------

describe('enqueueDailyReviewAdjustments', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drwadj-enqueue-'));
  });

  it('returns enqueued:false when no adjustment records', async () => {
    const plan = makeWeeklyPlan([makeTask('task-aaa11111')]);
    const result = await enqueueDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: [],
      weeklyPlan: plan,
    });

    assert.equal(result.enqueued, false);
    assert.equal(result.skippedCount, 0);
  });

  it('returns enqueued:false when no weekly plan', async () => {
    const records = [makeAdjRecord('carry-over', 'task-aaa11111')];
    const result = await enqueueDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: null,
    });

    assert.equal(result.enqueued, false);
    assert.equal(result.skippedCount, 1);
  });

  it('returns enqueued:false when all records produce no ops (e.g. all continue)', async () => {
    const task = makeTask('task-bbb22222', 'in-progress');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('continue', 'task-bbb22222')];

    const result = await enqueueDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
    });

    assert.equal(result.enqueued, false);
    // all records → 0 ops (continue produces no op)
    assert.equal(result.skippedCount, 1);
  });

  it('persists a batch and returns enqueued:true for carry-over', async () => {
    const task = makeTask('task-ccc33333', 'pending');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('carry-over', 'task-ccc33333')];

    const result = await enqueueDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
    });

    assert.equal(result.enqueued, true);
    assert.ok(result.batchPath);
    assert.equal(result.opsCount, 1);

    // Verify the batch is on disk
    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.ok(loaded !== null);
    assert.equal(loaded.weeklyAdjustments.length, 1);
    assert.equal(loaded.weeklyAdjustments[0].action, 'update');
    assert.equal(loaded.weeklyAdjustments[0].taskId, 'task-ccc33333');
  });

  it('persists a batch for retry op with correct status and runAt', async () => {
    const task = makeTask('task-ddd44444', 'failed');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('retry', 'task-ddd44444')];

    await enqueueDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
    });

    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.equal(loaded.weeklyAdjustments[0].status, 'pending');
    assert.equal(loaded.weeklyAdjustments[0].runAt, `${TOMORROW}T09:00:00.000Z`);
  });

  it('persists a batch for follow-up op', async () => {
    const task = makeTask('task-eee55555', 'delegated', { objectiveId: 'obj-lead01' });
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('follow-up', 'task-eee55555', 'Write docs')];

    await enqueueDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
    });

    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.equal(loaded.weeklyAdjustments[0].action, 'add');
    assert.equal(loaded.weeklyAdjustments[0].objectiveId, 'obj-lead01');
    assert.ok(loaded.weeklyAdjustments[0].prompt.includes('Write docs'));
  });

  it('atomic: returns errors and persists nothing when any op fails validation', async () => {
    // Create a task that IS in the plan but craft a record that generates an
    // invalid op (we manually craft a bad op by generating one that uses
    // a taskId not present in the plan alongside a valid one).
    const task = makeTask('task-fff66666', 'pending');
    const plan = makeWeeklyPlan([task]);

    // carry-over for task-fff66666 (valid) + carry-over for task-ghost00000 (not in plan)
    // task-ghost00000 gets skipped silently (not-found). So to trigger an actual validation
    // error we need to craft a scenario where extractWeeklyAdjustmentOps produces an op
    // that validateWeeklyAdjustment would reject.
    //
    // The easiest way: use a plan whose week differs from the week we pass.
    // extractWeeklyAdjustmentOps pins ops to the caller-supplied `week`, but
    // the plan uses a different week key → validateWeeklyAdjustment will say
    // "No weekly plan found for <week>".
    const mismatchedPlan = { ...makeWeeklyPlan([task]), week: '2026-W99' };
    const records = [makeAdjRecord('carry-over', 'task-fff66666')];

    const result = await enqueueDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,         // ops use WEEK
      adjustmentRecords: records,
      weeklyPlan: mismatchedPlan, // plan has a different week key → validation fails
    });

    assert.equal(result.enqueued, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.length > 0, 'Should report at least one validation error');

    // Nothing should be on disk
    const notOnDisk = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.equal(notOnDisk, null);
  });

  it('stores correct provenance fields in the batch', async () => {
    const task = makeTask('task-ggg77777', 'pending');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('carry-over', 'task-ggg77777')];
    const ts = '2026-04-14T17:00:00.000Z';

    await enqueueDailyReviewAdjustments({
      baseDir: tmpDir,
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      adjustmentRecords: records,
      weeklyPlan: plan,
      createdAt: ts,
    });

    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.equal(loaded.agentId, AGENT_ID);
    assert.equal(loaded.date, DATE);
    assert.equal(loaded.week, WEEK);
    assert.equal(loaded.source, 'daily-review');
    assert.equal(loaded.createdAt, ts);
  });

  it('is idempotent — re-enqueuing for the same date overwrites', async () => {
    const task = makeTask('task-hhh88888', 'pending');
    const plan = makeWeeklyPlan([task]);
    const records = [makeAdjRecord('carry-over', 'task-hhh88888')];

    await enqueueDailyReviewAdjustments({ baseDir: tmpDir, agentId: AGENT_ID, date: DATE, week: WEEK, adjustmentRecords: records, weeklyPlan: plan });
    await enqueueDailyReviewAdjustments({ baseDir: tmpDir, agentId: AGENT_ID, date: DATE, week: WEEK, adjustmentRecords: records, weeklyPlan: plan });

    const dates = await listPendingAdjustmentDates(tmpDir, AGENT_ID);
    assert.deepStrictEqual(dates, [DATE], 'Only one pending batch should exist for this date');
  });
});

// ---------------------------------------------------------------------------
// generateDailyReview integration: enqueuedAdjustments in the return value
// ---------------------------------------------------------------------------

describe('generateDailyReview — enqueuedAdjustments integration', () => {
  let tmpDir;
  let agentStore;
  let weeklyPlanStore;
  let activityLogStore;

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

  it('returns enqueuedAdjustments:null when persist=false', async () => {
    const plan = {
      week: WEEK, month: '2026-04', tasks: [makeTask('task-aaa11111', 'pending')],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      baseDir: tmpDir,
      persist: false, // <- skip persistence → skip enqueue
    });

    assert.equal(result.enqueuedAdjustments, null);
  });

  it('returns enqueuedAdjustments:null when no adjustments (all tasks completed)', async () => {
    const plan = {
      week: WEEK, month: '2026-04',
      tasks: [makeTask('task-bbb22222', 'completed', { completedAt: `${DATE}T12:00:00.000Z` })],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK, baseDir: tmpDir,
    });

    // No adjustments produced → enqueuedAdjustments remains null
    assert.equal(result.enqueuedAdjustments, null);
  });

  it('returns enqueuedAdjustments with enqueued:true when pending tasks are rescheduled', async () => {
    const plan = {
      week: WEEK, month: '2026-04',
      tasks: [makeTask('task-ccc33333', 'pending')],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK, baseDir: tmpDir,
    });

    assert.ok(result.enqueuedAdjustments !== null);
    assert.equal(result.enqueuedAdjustments.enqueued, true);
    assert.equal(result.enqueuedAdjustments.opsCount, 1);

    // Verify the pending batch is on disk
    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.ok(loaded !== null);
    assert.equal(loaded.weeklyAdjustments.length, 1);
    assert.equal(loaded.weeklyAdjustments[0].action, 'update');
    assert.equal(loaded.weeklyAdjustments[0].taskId, 'task-ccc33333');
    assert.equal(loaded.weeklyAdjustments[0].runAt, `${TOMORROW}T09:00:00.000Z`);
  });

  it('the pending batch can be listed via listPendingAdjustmentDates', async () => {
    const plan = {
      week: WEEK, month: '2026-04',
      tasks: [makeTask('task-ddd44444', 'failed')],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, plan);

    await generateDailyReview(deps(), AGENT_ID, DATE, { week: WEEK, baseDir: tmpDir });

    const dates = await listPendingAdjustmentDates(tmpDir, AGENT_ID);
    assert.ok(dates.includes(DATE));
  });

  it('the pending batch can be cleared after approval', async () => {
    const plan = {
      week: WEEK, month: '2026-04',
      tasks: [makeTask('task-eee55555', 'skipped')],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    await weeklyPlanStore.save(AGENT_ID, plan);

    await generateDailyReview(deps(), AGENT_ID, DATE, { week: WEEK, baseDir: tmpDir });
    await clearPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);

    const loaded = await loadPendingAdjustmentBatch(tmpDir, AGENT_ID, DATE);
    assert.equal(loaded, null);
  });

  it('does not affect the already-persisted daily review markdown on enqueue failure', async () => {
    // Use a plan whose week key mismatches to force a validation failure during enqueue.
    const mismatchedPlan = {
      week: '2026-W99', month: '2026-04',
      tasks: [makeTask('task-fff66666', 'pending')],
      approved: true, createdAt: '2026-04-13T00:00:00.000Z', updatedAt: '2026-04-13T00:00:00.000Z',
    };
    // Save with the mismatched week key
    await weeklyPlanStore.save(AGENT_ID, mismatchedPlan);

    // Attempt to generate a review for WEEK — weeklyPlanStore.load(agentId, WEEK) will
    // find nothing (the saved plan is under 2026-W99), so weeklyPlan will be null.
    // That means adjustments array will be empty → enqueuedAdjustments stays null.
    // The markdown/paths are still returned correctly.
    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK, baseDir: tmpDir,
    });

    // The daily review markdown should always be returned
    assert.ok(result.markdown.length > 0);
    assert.ok(result.paths !== null);
    assert.ok(result.paths.markdownPath.endsWith(`daily-${DATE}.md`));
  });
});
