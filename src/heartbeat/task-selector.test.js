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
  filterEligibleTasks,
  isRunAtReady,
  findStaleTasks,
  STALE_TASK_WINDOW_MS,
  sortByPriority,
  selectNextTaskFromPlan,
  selectTasksForTickFromPlan,
  trackKeyOf,
  getTaskStatusSummary,
  isAllTasksFinished,
  selectNextTask,
  selectNextTaskForWeek,
  isDailyReviewTask,
} from './task-selector.js';

import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';

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

describe('task-selector — runAt filtering', () => {
  const fixed = Date.parse('2026-04-20T10:00:00Z');

  it('isRunAtReady treats missing runAt as always ready', () => {
    assert.equal(isRunAtReady({}, fixed), true);
    assert.equal(isRunAtReady({ runAt: null }, fixed), true);
  });

  it('isRunAtReady returns false when runAt > now', () => {
    assert.equal(isRunAtReady({ runAt: '2026-04-20T11:00:00Z' }, fixed), false);
    assert.equal(isRunAtReady({ runAt: '2026-04-20T10:00:00Z' }, fixed), true);
  });

  it('isRunAtReady fails open on malformed runAt', () => {
    assert.equal(isRunAtReady({ runAt: 'not-a-date' }, fixed), true);
  });

  it('isRunAtReady returns false for runAt older than the stale window', () => {
    // fixed = 10:00. Default stale window = 60 min. 08:00 is 2h ago → stale.
    assert.equal(isRunAtReady({ runAt: '2026-04-20T08:00:00Z' }, fixed), false);
    // 09:00 is exactly 1h ago — at the boundary, still ready (inclusive).
    assert.equal(isRunAtReady({ runAt: '2026-04-20T09:00:00Z' }, fixed), true);
    // 08:59 is > 60 min ago → stale.
    assert.equal(isRunAtReady({ runAt: '2026-04-20T08:59:00Z' }, fixed), false);
  });

  it('isRunAtReady honours a custom maxAgeMs override', () => {
    const oldRunAt = '2026-04-20T08:00:00Z'; // 2h old, normally stale.
    assert.equal(isRunAtReady({ runAt: oldRunAt }, fixed), false);
    // Widen the window to 4h — task becomes ready again.
    assert.equal(
      isRunAtReady({ runAt: oldRunAt }, fixed, { maxAgeMs: 4 * 60 * 60 * 1000 }),
      true,
    );
    // Infinity disables the sweep entirely.
    assert.equal(
      isRunAtReady({ runAt: oldRunAt }, fixed, { maxAgeMs: Infinity }),
      true,
    );
  });

  it('STALE_TASK_WINDOW_MS is 60 minutes', () => {
    assert.equal(STALE_TASK_WINDOW_MS, 60 * 60 * 1000);
  });

  it('filterEligibleTasks excludes future-scheduled pending tasks', () => {
    const tasks = [
      { id: 'task-a', status: 'pending', runAt: '2026-04-20T09:00:00Z' },
      { id: 'task-b', status: 'pending', runAt: '2026-04-20T11:00:00Z' },
      { id: 'task-c', status: 'pending' },
    ];
    const eligible = filterEligibleTasks(tasks, { nowMs: fixed });
    assert.deepEqual(eligible.map((t) => t.id).sort(), ['task-a', 'task-c']);
  });

  it('selectTasksForTickFromPlan skips tracks whose only pending task is in the future', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-x-future', track: 'x-com', runAt: '2026-04-20T15:00:00Z' }),
        makeTask({ id: 'task-r-now', track: 'reddit', runAt: '2026-04-20T09:00:00Z' }),
      ],
    });
    const picks = selectTasksForTickFromPlan(plan, { nowMs: fixed });
    assert.equal(picks.length, 1);
    assert.equal(picks[0].task.id, 'task-r-now');
  });

  it('returns empty when every task is future-scheduled', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-a', runAt: '2026-04-20T12:00:00Z' }),
        makeTask({ id: 'task-b', runAt: '2026-04-20T15:00:00Z' }),
      ],
    });
    assert.deepEqual(selectTasksForTickFromPlan(plan, { nowMs: fixed }), []);
  });

  it('future task becomes eligible once its slot arrives', () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: 'task-a', runAt: '2026-04-20T12:00:00Z' }),
      ],
    });
    assert.deepEqual(
      selectTasksForTickFromPlan(plan, { nowMs: Date.parse('2026-04-20T11:59:00Z') }),
      [],
    );
    const at = selectTasksForTickFromPlan(plan, { nowMs: Date.parse('2026-04-20T12:01:00Z') });
    assert.equal(at.length, 1);
    assert.equal(at[0].task.id, 'task-a');
  });
});

// ---------------------------------------------------------------------------
// task-selector — daily-review selection (advisor-mode)
// ---------------------------------------------------------------------------

/**
 * Build a daily-review task stub matching the shape produced by buildReviewTasks.
 * All daily-review tasks share objectiveId and track = DAILY_REVIEW_OBJECTIVE_ID.
 */
function makeDailyReviewTask(runAtIso, overrides = {}) {
  return {
    id: `task-dr-${uid()}`,
    description: 'Daily review',
    objectiveId: DAILY_REVIEW_OBJECTIVE_ID,
    track: DAILY_REVIEW_OBJECTIVE_ID,
    priority: 'medium',
    status: 'pending',
    runAt: runAtIso,
    ...overrides,
  };
}

/**
 * Build a weekly-review task stub.
 */
function makeWeeklyReviewTask(runAtIso, overrides = {}) {
  return {
    id: `task-wr-${uid()}`,
    description: 'Weekly review',
    objectiveId: WEEKLY_REVIEW_OBJECTIVE_ID,
    track: WEEKLY_REVIEW_OBJECTIVE_ID,
    priority: 'high',
    status: 'pending',
    runAt: runAtIso,
    ...overrides,
  };
}

describe('isDailyReviewTask', () => {
  it('returns true for a task with DAILY_REVIEW_OBJECTIVE_ID', () => {
    assert.equal(isDailyReviewTask({ objectiveId: DAILY_REVIEW_OBJECTIVE_ID }), true);
  });

  it('returns false for a regular work task', () => {
    assert.equal(isDailyReviewTask({ objectiveId: 'obj-work' }), false);
  });

  it('returns false for a weekly-review task', () => {
    assert.equal(isDailyReviewTask({ objectiveId: WEEKLY_REVIEW_OBJECTIVE_ID }), false);
  });

  it('returns false for null', () => {
    assert.equal(isDailyReviewTask(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isDailyReviewTask(undefined), false);
  });

  it('returns false for a task with no objectiveId', () => {
    assert.equal(isDailyReviewTask({ id: 'task-x', status: 'pending' }), false);
  });
});

describe('task-selector — findStaleTasks', () => {
  const nowMs = Date.parse('2026-04-21T10:00:00Z');

  it('returns [] for null / empty plans', () => {
    assert.deepEqual(findStaleTasks(null, { nowMs }), []);
    assert.deepEqual(findStaleTasks({}, { nowMs }), []);
    assert.deepEqual(findStaleTasks({ tasks: [] }, { nowMs }), []);
  });

  it('returns pending tasks whose runAt is older than 60 min (default)', () => {
    const plan = {
      tasks: [
        { id: 'task-stale-1', status: 'pending', runAt: '2026-04-21T08:00:00Z' }, // 2h old
        { id: 'task-stale-2', status: 'pending', runAt: '2026-04-20T12:00:00Z' }, // 22h old
        { id: 'task-fresh', status: 'pending', runAt: '2026-04-21T09:30:00Z' }, // 30m old
        { id: 'task-future', status: 'pending', runAt: '2026-04-21T11:00:00Z' }, // future
      ],
    };
    const stale = findStaleTasks(plan, { nowMs });
    assert.deepEqual(stale.map((t) => t.taskId).sort(), ['task-stale-1', 'task-stale-2']);
    assert.ok(stale.every((t) => t.ageMs > 0));
  });

  it('ignores non-pending tasks regardless of runAt', () => {
    const plan = {
      tasks: [
        { id: 'task-done', status: 'completed', runAt: '2026-04-20T12:00:00Z' },
        { id: 'task-failed', status: 'failed', runAt: '2026-04-20T12:00:00Z' },
        { id: 'task-already-skipped', status: 'skipped', runAt: '2026-04-20T12:00:00Z' },
        { id: 'task-in-progress', status: 'in-progress', runAt: '2026-04-20T12:00:00Z' },
      ],
    };
    assert.deepEqual(findStaleTasks(plan, { nowMs }), []);
  });

  it('ignores tasks without runAt', () => {
    const plan = { tasks: [{ id: 'no-runat', status: 'pending' }] };
    assert.deepEqual(findStaleTasks(plan, { nowMs }), []);
  });

  it('ignores malformed runAt values', () => {
    const plan = { tasks: [{ id: 'bad', status: 'pending', runAt: 'not-a-date' }] };
    assert.deepEqual(findStaleTasks(plan, { nowMs }), []);
  });

  it('honours a custom maxAgeMs', () => {
    const plan = {
      tasks: [
        { id: 'task-a', status: 'pending', runAt: '2026-04-21T09:30:00Z' }, // 30m old
      ],
    };
    // Tighten the window to 10 min → the 30-min-old task becomes stale.
    const stale = findStaleTasks(plan, { nowMs, maxAgeMs: 10 * 60 * 1000 });
    assert.deepEqual(stale.map((t) => t.taskId), ['task-a']);
  });

  it('boundary: a task at exactly now - 60min is NOT stale (>= boundary)', () => {
    const plan = {
      tasks: [
        { id: 'edge', status: 'pending', runAt: '2026-04-21T09:00:00Z' }, // exactly 60m ago
      ],
    };
    assert.deepEqual(findStaleTasks(plan, { nowMs }), []);
  });
});

describe('task-selector — daily-review once-per-day rule (filterEligibleTasks)', () => {
  // Use a fixed "now" at Wednesday 18:00 UTC so Mon/Tue/Wed reviews
  // (all at 17:00 UTC) are past-eligible and Thu/Fri are still future.
  const WED_17 = '2026-04-22T17:00:00Z'; // Wednesday 17:00 UTC
  const nowMs  = Date.parse('2026-04-22T18:00:00Z'); // Wednesday 18:00 UTC

  const MON_17 = '2026-04-20T17:00:00Z';
  const TUE_17 = '2026-04-21T17:00:00Z';
  const THU_17 = '2026-04-23T17:00:00Z';

  it('single eligible daily-review passes through unchanged', () => {
    const dr = makeDailyReviewTask(WED_17);
    const eligible = filterEligibleTasks([dr], { nowMs });
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, dr.id);
  });

  it('when multiple daily-reviews are eligible, only the most recent is kept', () => {
    const drMon = makeDailyReviewTask(MON_17);
    const drTue = makeDailyReviewTask(TUE_17);
    const drWed = makeDailyReviewTask(WED_17);
    // All three runAt values are <= nowMs (Wed 18:00).
    const eligible = filterEligibleTasks([drMon, drTue, drWed], { nowMs });
    assert.equal(eligible.length, 1, 'only the most recent daily-review should remain');
    assert.equal(eligible[0].id, drWed.id, 'Wednesday review wins (largest runAt)');
  });

  it('future daily-reviews are excluded by runAt regardless', () => {
    const drWed = makeDailyReviewTask(WED_17);
    const drThu = makeDailyReviewTask(THU_17); // still in the future at Wed 18:00
    const eligible = filterEligibleTasks([drWed, drThu], { nowMs });
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, drWed.id, 'only Wednesday (past) is eligible');
  });

  it('non-daily-review tasks are unaffected by the rule', () => {
    const work = makeTask({ id: 'task-work', objectiveId: 'obj-1', runAt: MON_17 });
    const drMon = makeDailyReviewTask(MON_17);
    const drWed = makeDailyReviewTask(WED_17);
    // The once-per-day rule is independent from the 60-min staleness window.
    // Disable staleness here so the fixture's multi-day runAt values stay
    // eligible and we actually exercise the daily-review collapse rule.
    const eligible = filterEligibleTasks([work, drMon, drWed], { nowMs, maxAgeMs: Infinity });
    // work task + one winning daily-review
    assert.equal(eligible.length, 2);
    const ids = eligible.map((t) => t.id).sort();
    assert.ok(ids.includes(work.id), 'regular work task is preserved');
    assert.ok(ids.includes(drWed.id), 'Wednesday daily-review wins');
    assert.ok(!ids.includes(drMon.id), 'Monday daily-review is excluded');
  });

  it('weekly-review task is not affected by the daily-review rule', () => {
    const drMon = makeDailyReviewTask(MON_17);
    const drWed = makeDailyReviewTask(WED_17);
    const wr    = makeWeeklyReviewTask(WED_17);
    const eligible = filterEligibleTasks([drMon, drWed, wr], { nowMs });
    // One daily-review (Wed) + one weekly-review
    assert.equal(eligible.length, 2);
    const ids = eligible.map((t) => t.id).sort();
    assert.ok(ids.includes(drWed.id), 'Wednesday daily-review is present');
    assert.ok(ids.includes(wr.id), 'weekly-review is present');
    assert.ok(!ids.includes(drMon.id), 'Monday daily-review is excluded');
  });

  it('completed daily-review tasks are not eligible (status filter takes precedence)', () => {
    const drMonDone = makeDailyReviewTask(MON_17, { status: 'completed' });
    const drTue     = makeDailyReviewTask(TUE_17);
    const drWed     = makeDailyReviewTask(WED_17);
    const eligible  = filterEligibleTasks([drMonDone, drTue, drWed], { nowMs });
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, drWed.id, 'completed Monday is excluded; Wednesday wins');
  });

  it('daily-review with no runAt is treated as epoch 0 (lowest precedence)', () => {
    const drNoRunAt = makeDailyReviewTask(undefined, { runAt: undefined });
    const drWed     = makeDailyReviewTask(WED_17);
    // drNoRunAt has no runAt → isRunAtReady treats it as always-eligible
    // but applyDailyReviewOncePerDayRule gives it epoch 0, so drWed wins.
    const eligible  = filterEligibleTasks([drNoRunAt, drWed], { nowMs });
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, drWed.id, 'timestamped review wins over no-runAt review');
  });
});

describe('task-selector — daily-review interleaved with work tasks (selectTasksForTickFromPlan)', () => {
  const MON_17 = '2026-04-20T17:00:00Z';
  const TUE_17 = '2026-04-21T17:00:00Z';
  const WED_17 = '2026-04-22T17:00:00Z';
  const nowMs  = Date.parse('2026-04-22T18:00:00Z'); // Wednesday 18:00 UTC

  it('daily-review appears as its own track pick alongside regular task picks', () => {
    const work = makeTask({ id: 'task-work', objectiveId: 'obj-1', track: 'x-com' });
    const drWed = makeDailyReviewTask(WED_17);
    const plan = makePlan({ tasks: [work, drWed] });

    const picks = selectTasksForTickFromPlan(plan, { nowMs });
    assert.equal(picks.length, 2, 'one pick per distinct track (x-com + daily-review)');
    const trackKeys = picks.map((p) => p.trackKey).sort();
    assert.ok(trackKeys.includes('x-com'), 'x-com track is selected');
    assert.ok(trackKeys.includes(DAILY_REVIEW_OBJECTIVE_ID), 'daily-review track is selected');
  });

  it('when multiple stale daily-reviews exist, only the most recent is selected', () => {
    const drMon = makeDailyReviewTask(MON_17);
    const drTue = makeDailyReviewTask(TUE_17);
    const drWed = makeDailyReviewTask(WED_17);
    const plan  = makePlan({ tasks: [drMon, drTue, drWed] });

    const picks = selectTasksForTickFromPlan(plan, { nowMs });
    assert.equal(picks.length, 1, 'exactly one daily-review pick total');
    assert.equal(picks[0].task.id, drWed.id, 'Wednesday review (most recent) is selected');
  });

  it('selectNextTaskFromPlan returns the daily-review pick when it is top priority', () => {
    // daily-review is 'medium'; high-priority work task should win overall
    const highWork = makeTask({ id: 'task-high', objectiveId: 'obj-h', priority: 'high', track: 'work' });
    const drWed    = makeDailyReviewTask(WED_17);
    const plan     = makePlan({ tasks: [drWed, highWork] });

    const single = selectNextTaskFromPlan(plan, { nowMs });
    assert.ok(single, 'should return a pick');
    assert.equal(single.task.id, highWork.id, 'high-priority work task wins overall');
  });

  it('selectNextTaskFromPlan returns daily-review when it is the only eligible task', () => {
    const drWed = makeDailyReviewTask(WED_17);
    const plan  = makePlan({ tasks: [drWed] });

    const single = selectNextTaskFromPlan(plan, { nowMs });
    assert.ok(single, 'should return a pick');
    assert.equal(single.task.id, drWed.id);
  });

  it('future daily-review does not appear in picks', () => {
    const THU_17 = '2026-04-23T17:00:00Z'; // future relative to nowMs
    const drThu  = makeDailyReviewTask(THU_17);
    const plan   = makePlan({ tasks: [drThu] });

    const picks = selectTasksForTickFromPlan(plan, { nowMs });
    assert.equal(picks.length, 0, 'future daily-review is not eligible yet');
  });

  it('once the day-slot review completes, the next stale slot becomes the pick', () => {
    // Mon and Tue are both past-eligible. Wed has been marked completed.
    const drMon = makeDailyReviewTask(MON_17);
    const drTue = makeDailyReviewTask(TUE_17);
    const drWed = makeDailyReviewTask(WED_17, { status: 'completed' });
    const plan  = makePlan({ tasks: [drMon, drTue, drWed] });

    // With Wed completed, among pending eligible reviews Mon+Tue, Tue is the
    // most recent (larger runAt) and should be selected. The default 60-min
    // stale sweep would mark Mon/Tue as skipped in real ticks; this test
    // deliberately disables the stale window to isolate the once-per-day
    // collapse logic.
    const picks = selectTasksForTickFromPlan(plan, { nowMs, maxAgeMs: Infinity });
    assert.equal(picks.length, 1);
    assert.equal(picks[0].task.id, drTue.id, 'Tuesday (most recent pending) is selected after Wed completes');
  });
});
