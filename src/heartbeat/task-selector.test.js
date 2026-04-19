/**
 * Tests for task-selector — selects next pending task from weekly plans.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  priorityWeight,
  filterPendingTasks,
  sortByPriority,
  selectNextTaskFromPlan,
  selectTasksForTickFromPlan,
  trackKeyOf,
  getTaskStatusSummary,
  isAllTasksFinished,
  selectNextTask,
  selectNextTaskForWeek,
} from './task-selector.js';

import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { assertValid } from '../schemas/validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => randomBytes(4).toString('hex');

function makeTask(overrides = {}) {
  return {
    id: `task-${uid()}`,
    description: overrides.description || 'Do something',
    objectiveId: overrides.objectiveId || `obj-${uid()}`,
    priority: overrides.priority || 'medium',
    status: overrides.status || 'pending',
    ...overrides,
  };
}

function makePlan(overrides = {}) {
  return {
    week: overrides.week || '2026-W16',
    month: overrides.month || '2026-04',
    tasks: overrides.tasks || [],
    approved: overrides.approved !== undefined ? overrides.approved : true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(overrides.approvedAt ? { approvedAt: overrides.approvedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// priorityWeight
// ---------------------------------------------------------------------------

describe('priorityWeight', () => {
  it('returns 0 for critical', () => {
    assert.equal(priorityWeight('critical'), 0);
  });

  it('returns 1 for high', () => {
    assert.equal(priorityWeight('high'), 1);
  });

  it('returns 2 for medium', () => {
    assert.equal(priorityWeight('medium'), 2);
  });

  it('returns 3 for low', () => {
    assert.equal(priorityWeight('low'), 3);
  });

  it('defaults to medium (2) for undefined', () => {
    assert.equal(priorityWeight(undefined), 2);
  });

  it('defaults to medium (2) for null', () => {
    assert.equal(priorityWeight(null), 2);
  });

  it('defaults to medium (2) for unknown string', () => {
    assert.equal(priorityWeight('urgent'), 2);
  });
});

// ---------------------------------------------------------------------------
// filterPendingTasks
// ---------------------------------------------------------------------------

describe('filterPendingTasks', () => {
  it('returns only pending tasks', () => {
    const tasks = [
      makeTask({ status: 'pending' }),
      makeTask({ status: 'completed' }),
      makeTask({ status: 'pending' }),
      makeTask({ status: 'failed' }),
      makeTask({ status: 'in-progress' }),
      makeTask({ status: 'delegated' }),
      makeTask({ status: 'skipped' }),
    ];
    const result = filterPendingTasks(tasks);
    assert.equal(result.length, 2);
    assert.ok(result.every((t) => t.status === 'pending'));
  });

  it('returns empty array when no pending tasks', () => {
    const tasks = [
      makeTask({ status: 'completed' }),
      makeTask({ status: 'failed' }),
    ];
    assert.deepEqual(filterPendingTasks(tasks), []);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(filterPendingTasks([]), []);
  });

  it('returns empty array for null/undefined input', () => {
    assert.deepEqual(filterPendingTasks(null), []);
    assert.deepEqual(filterPendingTasks(undefined), []);
  });

  it('does not mutate the original array', () => {
    const tasks = [makeTask({ status: 'pending' }), makeTask({ status: 'completed' })];
    const original = [...tasks];
    filterPendingTasks(tasks);
    assert.deepEqual(tasks, original);
  });
});

// ---------------------------------------------------------------------------
// sortByPriority
// ---------------------------------------------------------------------------

describe('sortByPriority', () => {
  it('sorts critical before high before medium before low', () => {
    const tasks = [
      makeTask({ priority: 'low', description: 'low' }),
      makeTask({ priority: 'critical', description: 'critical' }),
      makeTask({ priority: 'medium', description: 'medium' }),
      makeTask({ priority: 'high', description: 'high' }),
    ];
    const sorted = sortByPriority(tasks);
    assert.equal(sorted[0].description, 'critical');
    assert.equal(sorted[1].description, 'high');
    assert.equal(sorted[2].description, 'medium');
    assert.equal(sorted[3].description, 'low');
  });

  it('preserves original order for same priority (stable sort)', () => {
    const tasks = [
      makeTask({ priority: 'high', description: 'first-high' }),
      makeTask({ priority: 'high', description: 'second-high' }),
      makeTask({ priority: 'high', description: 'third-high' }),
    ];
    const sorted = sortByPriority(tasks);
    assert.equal(sorted[0].description, 'first-high');
    assert.equal(sorted[1].description, 'second-high');
    assert.equal(sorted[2].description, 'third-high');
  });

  it('does not mutate the original array', () => {
    const tasks = [
      makeTask({ priority: 'low' }),
      makeTask({ priority: 'critical' }),
    ];
    const originalIds = tasks.map((t) => t.id);
    sortByPriority(tasks);
    assert.deepEqual(tasks.map((t) => t.id), originalIds);
  });

  it('handles tasks without priority (defaults to medium)', () => {
    const taskNoPriority = { id: 'task-nopri', description: 'x', objectiveId: 'obj-abc', status: 'pending' };
    const tasks = [
      taskNoPriority,
      makeTask({ priority: 'high', description: 'high' }),
      makeTask({ priority: 'low', description: 'low' }),
    ];
    const sorted = sortByPriority(tasks);
    assert.equal(sorted[0].description, 'high');
    assert.equal(sorted[1].description, 'x'); // no priority → medium
    assert.equal(sorted[2].description, 'low');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(sortByPriority([]), []);
  });
});

// ---------------------------------------------------------------------------
// selectNextTaskFromPlan
// ---------------------------------------------------------------------------

describe('selectNextTaskFromPlan', () => {
  it('returns the highest priority pending task', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ priority: 'low', description: 'low-task' }),
        makeTask({ priority: 'critical', description: 'critical-task' }),
        makeTask({ priority: 'medium', description: 'medium-task' }),
      ],
    });
    const result = selectNextTaskFromPlan(plan);
    assert.ok(result);
    assert.equal(result.task.description, 'critical-task');
    assert.equal(result.index, 1); // original index in tasks array
  });

  it('returns null for unapproved plan', () => {
    const plan = makePlan({
      approved: false,
      tasks: [makeTask()],
    });
    assert.equal(selectNextTaskFromPlan(plan), null);
  });

  it('returns null for null plan', () => {
    assert.equal(selectNextTaskFromPlan(null), null);
  });

  it('returns null for undefined plan', () => {
    assert.equal(selectNextTaskFromPlan(undefined), null);
  });

  it('returns null when all tasks are completed', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'completed' }),
      ],
    });
    assert.equal(selectNextTaskFromPlan(plan), null);
  });

  it('returns null for empty tasks array', () => {
    const plan = makePlan({ tasks: [] });
    assert.equal(selectNextTaskFromPlan(plan), null);
  });

  it('skips in-progress, completed, failed, delegated, and skipped tasks', () => {
    const pendingTask = makeTask({ priority: 'low', description: 'the-pending-one' });
    const plan = makePlan({
      tasks: [
        makeTask({ status: 'in-progress', priority: 'critical' }),
        makeTask({ status: 'completed', priority: 'critical' }),
        makeTask({ status: 'failed', priority: 'critical' }),
        makeTask({ status: 'delegated', priority: 'critical' }),
        makeTask({ status: 'skipped', priority: 'critical' }),
        pendingTask,
      ],
    });
    const result = selectNextTaskFromPlan(plan);
    assert.ok(result);
    assert.equal(result.task.id, pendingTask.id);
  });

  it('is idempotent — same plan always produces same result', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ priority: 'high', description: 'task-a' }),
        makeTask({ priority: 'critical', description: 'task-b' }),
        makeTask({ priority: 'medium', description: 'task-c' }),
      ],
    });
    const r1 = selectNextTaskFromPlan(plan);
    const r2 = selectNextTaskFromPlan(plan);
    assert.equal(r1.task.id, r2.task.id);
    assert.equal(r1.index, r2.index);
  });

  it('does not mutate the plan', () => {
    const tasks = [
      makeTask({ priority: 'high' }),
      makeTask({ priority: 'low' }),
    ];
    const plan = makePlan({ tasks });
    const originalJSON = JSON.stringify(plan);
    selectNextTaskFromPlan(plan);
    assert.equal(JSON.stringify(plan), originalJSON);
  });

  it('returns correct original index', () => {
    const target = makeTask({ priority: 'critical', description: 'target' });
    const plan = makePlan({
      tasks: [
        makeTask({ priority: 'low', status: 'completed' }),
        makeTask({ priority: 'medium' }),
        target,
        makeTask({ priority: 'low' }),
      ],
    });
    const result = selectNextTaskFromPlan(plan);
    assert.equal(result.task.id, target.id);
    assert.equal(result.index, 2);
  });

  it('picks first same-priority task by array order', () => {
    const first = makeTask({ priority: 'high', description: 'first' });
    const second = makeTask({ priority: 'high', description: 'second' });
    const plan = makePlan({ tasks: [first, second] });
    const result = selectNextTaskFromPlan(plan);
    assert.equal(result.task.id, first.id);
  });
});

// ---------------------------------------------------------------------------
// getTaskStatusSummary
// ---------------------------------------------------------------------------

describe('getTaskStatusSummary', () => {
  it('counts all statuses correctly', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ status: 'pending' }),
        makeTask({ status: 'pending' }),
        makeTask({ status: 'completed' }),
        makeTask({ status: 'failed' }),
        makeTask({ status: 'in-progress' }),
        makeTask({ status: 'delegated' }),
        makeTask({ status: 'skipped' }),
      ],
    });
    const summary = getTaskStatusSummary(plan);
    assert.equal(summary.total, 7);
    assert.equal(summary.pending, 2);
    assert.equal(summary.completed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.inProgress, 1);
    assert.equal(summary.delegated, 1);
    assert.equal(summary.skipped, 1);
  });

  it('returns zeroes for null plan', () => {
    const summary = getTaskStatusSummary(null);
    assert.equal(summary.total, 0);
    assert.equal(summary.pending, 0);
  });

  it('returns zeroes for plan with no tasks', () => {
    const summary = getTaskStatusSummary(makePlan({ tasks: [] }));
    assert.equal(summary.total, 0);
  });
});

// ---------------------------------------------------------------------------
// isAllTasksFinished
// ---------------------------------------------------------------------------

describe('isAllTasksFinished', () => {
  it('returns true when all tasks completed/failed/delegated/skipped', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'failed' }),
        makeTask({ status: 'delegated' }),
        makeTask({ status: 'skipped' }),
      ],
    });
    assert.equal(isAllTasksFinished(plan), true);
  });

  it('returns false when pending tasks remain', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'pending' }),
      ],
    });
    assert.equal(isAllTasksFinished(plan), false);
  });

  it('returns false when in-progress tasks remain', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'in-progress' }),
      ],
    });
    assert.equal(isAllTasksFinished(plan), false);
  });

  it('returns true for empty tasks', () => {
    assert.equal(isAllTasksFinished(makePlan({ tasks: [] })), true);
  });

  it('returns true for null plan', () => {
    assert.equal(isAllTasksFinished(null), true);
  });
});

// ---------------------------------------------------------------------------
// selectNextTask (integration with WeeklyPlanStore)
// ---------------------------------------------------------------------------

describe('selectNextTask (store integration)', () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `aweek-task-selector-${uid()}`);
    await mkdir(tmpDir, { recursive: true });
    store = new WeeklyPlanStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('selects highest priority pending task from latest approved plan', async () => {
    const agentId = `agent-test-${uid()}`;
    const plan = makePlan({
      week: '2026-W16',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [
        makeTask({ priority: 'low', description: 'low-task' }),
        makeTask({ priority: 'critical', description: 'critical-task' }),
        makeTask({ priority: 'medium', description: 'medium-task' }),
      ],
    });
    await store.save(agentId, plan);

    const result = await selectNextTask(store, agentId);
    assert.ok(result);
    assert.equal(result.task.description, 'critical-task');
    assert.equal(result.week, '2026-W16');
    assert.ok(result.plan);
  });

  it('returns null when no approved plans exist', async () => {
    const agentId = `agent-test-${uid()}`;
    await store.init(agentId);
    const result = await selectNextTask(store, agentId);
    assert.equal(result, null);
  });

  it('returns null when all tasks in latest approved plan are done', async () => {
    const agentId = `agent-test-${uid()}`;
    const plan = makePlan({
      week: '2026-W16',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'failed' }),
      ],
    });
    await store.save(agentId, plan);

    const result = await selectNextTask(store, agentId);
    assert.equal(result, null);
  });

  it('picks from latest approved plan, not earlier ones', async () => {
    const agentId = `agent-test-${uid()}`;
    const oldPlan = makePlan({
      week: '2026-W15',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ priority: 'critical', description: 'old-critical' })],
    });
    const newPlan = makePlan({
      week: '2026-W16',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ priority: 'low', description: 'new-low' })],
    });
    await store.save(agentId, oldPlan);
    await store.save(agentId, newPlan);

    const result = await selectNextTask(store, agentId);
    assert.ok(result);
    assert.equal(result.task.description, 'new-low');
    assert.equal(result.week, '2026-W16');
  });

  it('skips unapproved plans', async () => {
    const agentId = `agent-test-${uid()}`;
    const approvedPlan = makePlan({
      week: '2026-W15',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'approved-task' })],
    });
    const unapprovedPlan = makePlan({
      week: '2026-W16',
      approved: false,
      tasks: [makeTask({ description: 'unapproved-task' })],
    });
    await store.save(agentId, approvedPlan);
    await store.save(agentId, unapprovedPlan);

    const result = await selectNextTask(store, agentId);
    assert.ok(result);
    assert.equal(result.task.description, 'approved-task');
    assert.equal(result.week, '2026-W15');
  });

  it('throws on missing store', async () => {
    await assert.rejects(() => selectNextTask(null, 'agent-x'), /store is required/);
  });

  it('throws on missing agentId', async () => {
    await assert.rejects(() => selectNextTask(store, ''), /agentId is required/);
  });
});

// ---------------------------------------------------------------------------
// selectNextTaskForWeek
// ---------------------------------------------------------------------------

describe('selectNextTaskForWeek', () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `aweek-task-week-${uid()}`);
    await mkdir(tmpDir, { recursive: true });
    store = new WeeklyPlanStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('selects from a specific week', async () => {
    const agentId = `agent-test-${uid()}`;
    const plan = makePlan({
      week: '2026-W16',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [
        makeTask({ priority: 'high', description: 'week16-task' }),
      ],
    });
    await store.save(agentId, plan);

    const result = await selectNextTaskForWeek(store, agentId, '2026-W16');
    assert.ok(result);
    assert.equal(result.task.description, 'week16-task');
    assert.equal(result.week, '2026-W16');
  });

  it('returns null for non-existent week', async () => {
    const agentId = `agent-test-${uid()}`;
    await store.init(agentId);
    const result = await selectNextTaskForWeek(store, agentId, '2099-W01');
    assert.equal(result, null);
  });

  it('returns null for unapproved plan at that week', async () => {
    const agentId = `agent-test-${uid()}`;
    const plan = makePlan({
      week: '2026-W16',
      approved: false,
      tasks: [makeTask()],
    });
    await store.save(agentId, plan);

    const result = await selectNextTaskForWeek(store, agentId, '2026-W16');
    assert.equal(result, null);
  });

  it('throws on missing arguments', async () => {
    await assert.rejects(() => selectNextTaskForWeek(null, 'a', 'w'), /store is required/);
    await assert.rejects(() => selectNextTaskForWeek(store, '', 'w'), /agentId is required/);
    await assert.rejects(() => selectNextTaskForWeek(store, 'a', ''), /week is required/);
  });
});

describe('task-selector — track-based selection', () => {
  it('trackKeyOf prefers explicit track', () => {
    assert.equal(trackKeyOf({ track: 'x-com', objectiveId: 'obj-1' }), 'x-com');
  });

  it('trackKeyOf falls back to objectiveId', () => {
    assert.equal(trackKeyOf({ objectiveId: 'obj-1' }), 'obj-1');
  });

  it('trackKeyOf returns a sentinel for tasks without either field', () => {
    assert.equal(trackKeyOf({}), '__no_track__');
  });

  it('selectTasksForTickFromPlan returns one pick per distinct track', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-x1', track: 'x-com',  priority: 'medium' }),
        makeTask({ id: 'task-x2', track: 'x-com',  priority: 'medium' }),
        makeTask({ id: 'task-x3', track: 'x-com',  priority: 'medium' }),
        makeTask({ id: 'task-r1', track: 'reddit', priority: 'medium' }),
        makeTask({ id: 'task-r2', track: 'reddit', priority: 'medium' }),
      ],
    });

    const picks = selectTasksForTickFromPlan(plan);
    const keys = picks.map((p) => p.trackKey).sort();
    assert.deepEqual(keys, ['reddit', 'x-com']);
    // Each pick is the FIRST pending task in its track (stable FIFO within priority).
    const pickIds = picks.map((p) => p.task.id).sort();
    assert.deepEqual(pickIds, ['task-r1', 'task-x1']);
  });

  it('defaults to objectiveId when track is absent', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-a', objectiveId: 'obj-1' }),
        makeTask({ id: 'task-b', objectiveId: 'obj-1' }),
        makeTask({ id: 'task-c', objectiveId: 'obj-2' }),
      ],
    });

    const picks = selectTasksForTickFromPlan(plan);
    assert.equal(picks.length, 2, 'one pick per distinct objectiveId');
    const pickIds = picks.map((p) => p.task.id).sort();
    assert.deepEqual(pickIds, ['task-a', 'task-c']);
  });

  it('explicit track overrides objectiveId grouping', () => {
    // Two tasks under the same objective but different explicit tracks
    // should produce TWO picks, not one.
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-a', objectiveId: 'obj-1', track: 'x-com' }),
        makeTask({ id: 'task-b', objectiveId: 'obj-1', track: 'reddit' }),
      ],
    });
    const picks = selectTasksForTickFromPlan(plan);
    assert.equal(picks.length, 2);
  });

  it('within a track, priority still wins', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-a', track: 'x-com', priority: 'low' }),
        makeTask({ id: 'task-b', track: 'x-com', priority: 'critical' }),
        makeTask({ id: 'task-c', track: 'x-com', priority: 'medium' }),
      ],
    });
    const picks = selectTasksForTickFromPlan(plan);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].task.id, 'task-b'); // critical wins
  });

  it('across tracks, the returned array is sorted by priority', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-low',  track: 'x-com',  priority: 'low' }),
        makeTask({ id: 'task-crit', track: 'reddit', priority: 'critical' }),
      ],
    });
    const picks = selectTasksForTickFromPlan(plan);
    assert.equal(picks[0].task.id, 'task-crit', 'highest priority first');
    assert.equal(picks[1].task.id, 'task-low');
  });

  it('returns empty array for unapproved plan', () => {
    const plan = makePlan({
      approved: false,
      tasks: [makeTask({ track: 'x-com' })],
    });
    assert.deepEqual(selectTasksForTickFromPlan(plan), []);
  });

  it('ignores non-pending tasks', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-a', track: 'x-com', status: 'completed' }),
        makeTask({ id: 'task-b', track: 'x-com', status: 'pending' }),
        makeTask({ id: 'task-c', track: 'reddit', status: 'failed' }),
      ],
    });
    const picks = selectTasksForTickFromPlan(plan);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].task.id, 'task-b');
  });

  it('selectNextTaskFromPlan still returns the overall top-priority pick', () => {
    // Backward-compat smoke test: the single-pick API should return the
    // first element of the track-aware pick array (highest priority).
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-a', track: 'x-com',  priority: 'medium' }),
        makeTask({ id: 'task-b', track: 'reddit', priority: 'critical' }),
      ],
    });
    const single = selectNextTaskFromPlan(plan);
    assert.ok(single);
    assert.equal(single.task.id, 'task-b');
  });
});
