import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mondayFromISOWeek,
  dayOfWeek,
  weekDates,
  bucketLogEntriesByDay,
  bucketTasksByDay,
  countByStatus,
  countLogByStatus,
  buildDayComparison,
  aggregateWeeklyData,
} from './weekly-data-aggregator.js';

interface TaskOverrides {
  id?: string;
  title?: string;
  prompt?: string;
  objectiveId?: string;
  status?: string;
  completedAt?: string;
  delegatedTo?: string;
  [key: string]: unknown;
}

interface LogEntryOverrides {
  id?: string;
  timestamp?: string;
  agentId?: string;
  status?: string;
  title?: string;
  taskId?: string;
  duration?: number;
  [key: string]: unknown;
}

interface MockTask {
  id: string;
  title: string;
  prompt: string;
  objectiveId: string;
  status: string;
  [key: string]: unknown;
}

interface MockLogEntry {
  id: string;
  timestamp: string;
  agentId: string;
  status: string;
  title: string;
  [key: string]: unknown;
}

// ─── Helper factories ────────────────────────────────────────────

function makeTask(overrides: TaskOverrides = {}): MockTask {
  return {
    id: 'task-test-001',
    title: 'Test task', prompt: 'Test task',
    objectiveId: 'obj-test-001',
    status: 'pending',
    ...overrides,
  };
}

function makeLogEntry(overrides: LogEntryOverrides = {}): MockLogEntry {
  return {
    id: 'log-aabb0011',
    timestamp: '2026-04-13T10:00:00.000Z',
    agentId: 'agent-test',
    status: 'completed',
    title: 'Did something',
    ...overrides,
  };
}

// ─── mondayFromISOWeek ───────────────────────────────────────────

describe('mondayFromISOWeek', () => {
  it('returns correct Monday for 2026-W16', () => {
    assert.equal(mondayFromISOWeek('2026-W16'), '2026-04-13');
  });

  it('returns correct Monday for 2026-W01', () => {
    // 2026-W01: Jan 4 is Sunday => Week 1 Monday is Dec 29, 2025
    assert.equal(mondayFromISOWeek('2026-W01'), '2025-12-29');
  });

  it('returns correct Monday for 2025-W01', () => {
    // 2025-W01 Monday is Dec 30, 2024
    assert.equal(mondayFromISOWeek('2025-W01'), '2024-12-30');
  });

  it('returns correct Monday for a mid-year week', () => {
    assert.equal(mondayFromISOWeek('2026-W26'), '2026-06-22');
  });

  it('throws on invalid format', () => {
    assert.throws(() => mondayFromISOWeek('2026-16'), /Invalid ISO week format/);
    assert.throws(() => mondayFromISOWeek('bad'), /Invalid ISO week format/);
  });
});

// ─── dayOfWeek ───────────────────────────────────────────────────

describe('dayOfWeek', () => {
  it('returns mon for a Monday date', () => {
    assert.equal(dayOfWeek('2026-04-13'), 'mon');
  });

  it('returns sun for a Sunday date', () => {
    assert.equal(dayOfWeek('2026-04-19'), 'sun');
  });

  it('returns wed for a Wednesday datetime', () => {
    assert.equal(dayOfWeek('2026-04-15T14:30:00.000Z'), 'wed');
  });
});

// ─── weekDates ───────────────────────────────────────────────────

describe('weekDates', () => {
  it('returns 7 dates starting from Monday', () => {
    const dates = weekDates('2026-04-13');
    assert.equal(dates.length, 7);
    assert.deepEqual(dates[0], { date: '2026-04-13', day: 'mon' });
    assert.deepEqual(dates[6], { date: '2026-04-19', day: 'sun' });
  });

  it('days are in order mon through sun', () => {
    const dates = weekDates('2026-04-13');
    const dayNames = dates.map((d) => d.day);
    assert.deepEqual(dayNames, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });

  it('dates are consecutive', () => {
    const dates = weekDates('2026-04-13');
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1].date);
      const curr = new Date(dates[i].date);
      assert.equal(curr.getTime() - prev.getTime(), 86400000, `Gap between ${dates[i - 1].date} and ${dates[i].date}`);
    }
  });
});

// ─── bucketLogEntriesByDay ───────────────────────────────────────

describe('bucketLogEntriesByDay', () => {
  it('buckets entries into correct days', () => {
    const entries = [
      makeLogEntry({ id: 'log-aa000001', timestamp: '2026-04-13T08:00:00.000Z' }), // Mon
      makeLogEntry({ id: 'log-aa000002', timestamp: '2026-04-15T10:00:00.000Z' }), // Wed
      makeLogEntry({ id: 'log-aa000003', timestamp: '2026-04-15T14:00:00.000Z' }), // Wed
    ];
    const buckets = bucketLogEntriesByDay(entries, '2026-04-13');
    assert.equal(buckets.get('mon')!.length, 1);
    assert.equal(buckets.get('wed')!.length, 2);
    assert.equal(buckets.get('tue')!.length, 0);
  });

  it('ignores entries outside the week range', () => {
    const entries = [
      makeLogEntry({ id: 'log-aa000004', timestamp: '2026-04-20T08:00:00.000Z' }), // Next week
    ];
    const buckets = bucketLogEntriesByDay(entries, '2026-04-13');
    for (const [, arr] of buckets) {
      assert.equal(arr.length, 0);
    }
  });

  it('returns empty buckets when no entries', () => {
    const buckets = bucketLogEntriesByDay([], '2026-04-13');
    assert.equal(buckets.size, 7);
    for (const [, arr] of buckets) {
      assert.equal(arr.length, 0);
    }
  });
});

// ─── bucketTasksByDay ────────────────────────────────────────────

describe('bucketTasksByDay', () => {
  it('places completed tasks in their completedAt day', () => {
    const tasks = [
      makeTask({ id: 'task-a', status: 'completed', completedAt: '2026-04-14T12:00:00.000Z' }),
    ];
    const { byDay, unscheduled } = bucketTasksByDay(tasks, '2026-04-13');
    assert.equal(byDay.get('tue')!.length, 1);
    assert.equal(unscheduled.length, 0);
  });

  it('places pending tasks in unscheduled', () => {
    const tasks = [
      makeTask({ id: 'task-b', status: 'pending' }),
    ];
    const { byDay, unscheduled } = bucketTasksByDay(tasks, '2026-04-13');
    assert.equal(unscheduled.length, 1);
    for (const [, arr] of byDay) {
      assert.equal(arr.length, 0);
    }
  });

  it('places tasks with out-of-range completedAt in unscheduled', () => {
    const tasks = [
      makeTask({ id: 'task-c', status: 'completed', completedAt: '2026-04-20T12:00:00.000Z' }),
    ];
    const { unscheduled } = bucketTasksByDay(tasks, '2026-04-13');
    assert.equal(unscheduled.length, 1);
  });
});

// ─── countByStatus ───────────────────────────────────────────────

describe('countByStatus', () => {
  it('counts tasks by status', () => {
    const tasks = [
      makeTask({ status: 'completed' }),
      makeTask({ status: 'completed' }),
      makeTask({ status: 'pending' }),
      makeTask({ status: 'failed' }),
    ];
    const counts = countByStatus(tasks);
    assert.equal(counts.completed, 2);
    assert.equal(counts.pending, 1);
    assert.equal(counts.failed, 1);
  });

  it('returns empty object for empty array', () => {
    assert.deepEqual(countByStatus([]), {});
  });
});

// ─── countLogByStatus ────────────────────────────────────────────

describe('countLogByStatus', () => {
  it('counts log entries by status', () => {
    const entries = [
      makeLogEntry({ status: 'completed' }),
      makeLogEntry({ status: 'started' }),
      makeLogEntry({ status: 'completed' }),
    ];
    const counts = countLogByStatus(entries);
    assert.equal(counts.completed, 2);
    assert.equal(counts.started, 1);
  });
});

// ─── buildDayComparison ──────────────────────────────────────────

describe('buildDayComparison', () => {
  it('builds structured comparison for a day', () => {
    const tasks = [
      makeTask({ status: 'completed', completedAt: '2026-04-14T12:00:00.000Z' }),
    ];
    const entries = [
      makeLogEntry({ status: 'completed', duration: 5000 }),
      makeLogEntry({ id: 'log-bb000001', status: 'failed', duration: 2000 }),
    ];
    const result = buildDayComparison('2026-04-14', 'tue', tasks, entries);

    assert.equal(result.date, '2026-04-14');
    assert.equal(result.day, 'tue');
    assert.equal(result.planned.count, 1);
    assert.equal(result.planned.statusCounts.completed, 1);
    assert.equal(result.actual.count, 2);
    assert.equal(result.actual.completedCount, 1);
    assert.equal(result.actual.failedCount, 1);
    assert.equal(result.actual.totalDurationMs, 7000);
  });

  it('handles empty day', () => {
    const result = buildDayComparison('2026-04-13', 'mon', [], []);
    assert.equal(result.planned.count, 0);
    assert.equal(result.actual.count, 0);
    assert.equal(result.actual.totalDurationMs, 0);
  });
});

// ─── aggregateWeeklyData ─────────────────────────────────────────

interface MockWeeklyPlanStore {
  load: (agentId: string, week: string) => Promise<{
    week: string;
    month: string;
    approved: boolean;
    tasks: MockTask[];
  }>;
}

interface MockActivityLogStore {
  load: (agentId: string, weekMonday: string) => Promise<MockLogEntry[]>;
}

describe('aggregateWeeklyData', () => {
  let mockWeeklyPlanStore: MockWeeklyPlanStore;
  let mockActivityLogStore: MockActivityLogStore;

  beforeEach(() => {
    mockWeeklyPlanStore = {
      load: async () => ({
        week: '2026-W16',
        month: '2026-04',
        approved: true,
        tasks: [
          makeTask({ id: 'task-001', status: 'completed', completedAt: '2026-04-13T10:00:00.000Z' }),
          makeTask({ id: 'task-002', status: 'completed', completedAt: '2026-04-14T14:00:00.000Z' }),
          makeTask({ id: 'task-003', status: 'pending' }),
          makeTask({ id: 'task-004', status: 'failed' }),
          makeTask({ id: 'task-005', status: 'in-progress' }),
        ],
      }),
    };

    mockActivityLogStore = {
      load: async () => [
        makeLogEntry({ id: 'log-11000001', timestamp: '2026-04-13T10:30:00.000Z', taskId: 'task-001', status: 'completed', duration: 60000 }),
        makeLogEntry({ id: 'log-11000002', timestamp: '2026-04-14T14:30:00.000Z', taskId: 'task-002', status: 'completed', duration: 45000 }),
        makeLogEntry({ id: 'log-11000003', timestamp: '2026-04-14T16:00:00.000Z', taskId: 'task-004', status: 'failed', duration: 30000 }),
        makeLogEntry({ id: 'log-11000004', timestamp: '2026-04-15T09:00:00.000Z', taskId: 'task-005', status: 'started', duration: 0 }),
      ],
    };
  });

  it('returns structured weekly aggregation', async () => {
    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    assert.equal(result.agentId, 'agent-test');
    assert.equal(result.week, '2026-W16');
    assert.equal(result.weekMonday, '2026-04-13');
    assert.equal(result.planExists, true);
    assert.equal(result.planApproved, true);
    assert.equal(result.days.length, 7);
  });

  it('computes correct summary totals', async () => {
    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    assert.equal(result.summary.planned.total, 5);
    assert.equal(result.summary.planned.completed, 2);
    assert.equal(result.summary.planned.failed, 1);
    assert.equal(result.summary.planned.pending, 1);
    assert.equal(result.summary.planned.inProgress, 1);
    assert.equal(result.summary.planned.completionRate, 40); // 2/5 = 40%
  });

  it('computes correct actual summary', async () => {
    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    assert.equal(result.summary.actual.totalEntries, 4);
    assert.equal(result.summary.actual.completed, 2);
    assert.equal(result.summary.actual.failed, 1);
    assert.equal(result.summary.actual.totalDurationMs, 135000);
  });

  it('distributes activity log entries across correct days', async () => {
    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    const mon = result.days.find((d) => d.day === 'mon')!;
    const tue = result.days.find((d) => d.day === 'tue')!;
    const wed = result.days.find((d) => d.day === 'wed')!;

    assert.equal(mon.actual.count, 1); // 1 log entry on Monday
    assert.equal(tue.actual.count, 2); // 2 log entries on Tuesday
    assert.equal(wed.actual.count, 1); // 1 log entry on Wednesday
  });

  it('places completed tasks in their completedAt day', async () => {
    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    const mon = result.days.find((d) => d.day === 'mon')!;
    const tue = result.days.find((d) => d.day === 'tue')!;

    assert.equal(mon.planned.count, 1); // task-001 completed Monday
    assert.equal(tue.planned.count, 1); // task-002 completed Tuesday
  });

  it('collects unscheduled tasks (pending, in-progress, failed without completedAt)', async () => {
    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    // task-003 (pending), task-004 (failed, no completedAt), task-005 (in-progress)
    assert.equal(result.unscheduledTasks.length, 3);
  });

  it('handles missing weekly plan gracefully', async () => {
    const noplanStore = {
      load: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    };

    const result = await aggregateWeeklyData(
      { weeklyPlanStore: noplanStore as unknown as MockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    assert.equal(result.planExists, false);
    assert.equal(result.planApproved, false);
    assert.equal(result.summary.planned.total, 0);
    assert.equal(result.summary.planned.completionRate, 0);
    assert.equal(result.summary.actual.totalEntries, 4); // log entries still present
  });

  it('handles empty activity log gracefully', async () => {
    const emptyLogStore: MockActivityLogStore = { load: async () => [] };

    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: emptyLogStore },
      'agent-test',
      '2026-W16',
    );

    assert.equal(result.summary.actual.totalEntries, 0);
    assert.equal(result.summary.planned.total, 5);
    // All days should have 0 actual entries
    for (const day of result.days) {
      assert.equal(day.actual.count, 0);
    }
  });

  it('handles both stores empty', async () => {
    const noplanStore = {
      load: async () => { throw new Error('nope'); },
    };
    const emptyLogStore: MockActivityLogStore = { load: async () => [] };

    const result = await aggregateWeeklyData(
      { weeklyPlanStore: noplanStore as unknown as MockWeeklyPlanStore, activityLogStore: emptyLogStore },
      'agent-test',
      '2026-W16',
    );

    assert.equal(result.planExists, false);
    assert.equal(result.summary.planned.total, 0);
    assert.equal(result.summary.actual.totalEntries, 0);
    assert.equal(result.days.length, 7);
  });

  it('respects weekMonday override', async () => {
    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
      { weekMonday: '2026-04-13' },
    );

    assert.equal(result.weekMonday, '2026-04-13');
  });

  it('computes completionRate correctly for all-completed plans', async () => {
    mockWeeklyPlanStore.load = async () => ({
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        makeTask({ id: 'task-a', status: 'completed', completedAt: '2026-04-13T10:00:00.000Z' }),
        makeTask({ id: 'task-b', status: 'completed', completedAt: '2026-04-14T10:00:00.000Z' }),
      ],
    });

    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    assert.equal(result.summary.planned.completionRate, 100);
  });

  it('includes skipped and delegated in summary', async () => {
    mockWeeklyPlanStore.load = async () => ({
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        makeTask({ id: 'task-s', status: 'skipped' }),
        makeTask({ id: 'task-d', status: 'delegated', delegatedTo: 'agent-other' }),
        makeTask({ id: 'task-c', status: 'completed', completedAt: '2026-04-13T10:00:00.000Z' }),
      ],
    });

    const result = await aggregateWeeklyData(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-test',
      '2026-W16',
    );

    assert.equal(result.summary.planned.skipped, 1);
    assert.equal(result.summary.planned.delegated, 1);
    assert.equal(result.summary.planned.total, 3);
  });
});
