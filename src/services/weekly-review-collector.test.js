import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitTasksByType,
  groupLogEntriesByStatus,
  computeBudgetUtilization,
  collectWeeklyReviewData,
} from './weekly-review-collector.js';
import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides = {}) {
  return {
    id: 'task-001',
    description: 'Do some work',
    objectiveId: '2026-04',
    status: 'pending',
    ...overrides,
  };
}

function makeLogEntry(overrides = {}) {
  return {
    id: 'log-aabb0001',
    timestamp: '2026-04-14T10:00:00.000Z',
    agentId: 'agent-x',
    status: 'completed',
    description: 'Completed something',
    duration: 30000,
    ...overrides,
  };
}

// Minimal stub plan store
function makePlanStore(plan = null) {
  return {
    load: async (_agentId, _week) => {
      if (plan) return plan;
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  };
}

// Minimal stub activity log store
function makeLogStore(entries = []) {
  return {
    load: async () => entries,
  };
}

// Minimal stub usage store
function makeUsageStore(totals = null) {
  return {
    weeklyTotal: async () =>
      totals || {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        recordCount: 0,
      },
  };
}

// Minimal stub agent store
function makeAgentStore(config = {}) {
  return {
    load: async () => ({
      weeklyTokenBudget: 0,
      budget: { weeklyTokenLimit: 0, paused: false },
      ...config,
    }),
  };
}

// ─── splitTasksByType ─────────────────────────────────────────────────────────

describe('splitTasksByType', () => {
  it('separates daily-review tasks from work tasks', () => {
    const tasks = [
      makeTask({ objectiveId: '2026-04' }),
      makeTask({ id: 'task-002', objectiveId: DAILY_REVIEW_OBJECTIVE_ID }),
      makeTask({ id: 'task-003', objectiveId: WEEKLY_REVIEW_OBJECTIVE_ID }),
    ];
    const { workTasks, reviewTasks } = splitTasksByType(tasks);
    assert.equal(workTasks.length, 1);
    assert.equal(reviewTasks.length, 2);
    assert.equal(workTasks[0].objectiveId, '2026-04');
  });

  it('returns both empty arrays for an empty input', () => {
    const { workTasks, reviewTasks } = splitTasksByType([]);
    assert.deepEqual(workTasks, []);
    assert.deepEqual(reviewTasks, []);
  });

  it('handles null/undefined gracefully', () => {
    const { workTasks, reviewTasks } = splitTasksByType(null);
    assert.deepEqual(workTasks, []);
    assert.deepEqual(reviewTasks, []);
  });

  it('tasks with no objectiveId are treated as work tasks', () => {
    const tasks = [makeTask({ objectiveId: undefined })];
    const { workTasks, reviewTasks } = splitTasksByType(tasks);
    assert.equal(workTasks.length, 1);
    assert.equal(reviewTasks.length, 0);
  });
});

// ─── groupLogEntriesByStatus ──────────────────────────────────────────────────

describe('groupLogEntriesByStatus', () => {
  it('groups entries by their status field', () => {
    const entries = [
      makeLogEntry({ status: 'completed' }),
      makeLogEntry({ id: 'log-2', status: 'failed' }),
      makeLogEntry({ id: 'log-3', status: 'completed' }),
    ];
    const grouped = groupLogEntriesByStatus(entries);
    assert.equal(grouped.completed.length, 2);
    assert.equal(grouped.failed.length, 1);
  });

  it('uses "unknown" for entries without a status', () => {
    const entries = [{ id: 'log-x', description: 'mystery entry' }];
    const grouped = groupLogEntriesByStatus(entries);
    assert.equal(grouped.unknown.length, 1);
  });

  it('returns empty object for no entries', () => {
    assert.deepEqual(groupLogEntriesByStatus([]), {});
  });
});

// ─── computeBudgetUtilization ─────────────────────────────────────────────────

describe('computeBudgetUtilization', () => {
  it('returns null fields when no limit is configured', () => {
    const result = computeBudgetUtilization(50000, 0);
    assert.equal(result.remainingTokens, null);
    assert.equal(result.utilizationPct, null);
  });

  it('computes utilization correctly at 50%', () => {
    const result = computeBudgetUtilization(50000, 100000);
    assert.equal(result.remainingTokens, 50000);
    assert.equal(result.utilizationPct, 50);
  });

  it('caps utilization at 100% when over budget', () => {
    const result = computeBudgetUtilization(150000, 100000);
    assert.equal(result.utilizationPct, 100);
    assert.equal(result.remainingTokens, 0);
  });

  it('returns 0 utilization when nothing consumed', () => {
    const result = computeBudgetUtilization(0, 100000);
    assert.equal(result.remainingTokens, 100000);
    assert.equal(result.utilizationPct, 0);
  });
});

// ─── collectWeeklyReviewData ──────────────────────────────────────────────────

describe('collectWeeklyReviewData', () => {
  it('throws when agentId is missing', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(),
      activityLogStore: makeLogStore(),
    };
    await assert.rejects(
      () => collectWeeklyReviewData(deps, '', '2026-W16'),
      /agentId is required/
    );
  });

  it('throws when week is missing', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(),
      activityLogStore: makeLogStore(),
    };
    await assert.rejects(
      () => collectWeeklyReviewData(deps, 'agent-x', ''),
      /week is required/
    );
  });

  it('throws when weeklyPlanStore is not provided', async () => {
    await assert.rejects(
      () =>
        collectWeeklyReviewData(
          { activityLogStore: makeLogStore() },
          'agent-x',
          '2026-W16'
        ),
      /weeklyPlanStore dependency is required/
    );
  });

  it('throws when activityLogStore is not provided', async () => {
    await assert.rejects(
      () =>
        collectWeeklyReviewData(
          { weeklyPlanStore: makePlanStore() },
          'agent-x',
          '2026-W16'
        ),
      /activityLogStore dependency is required/
    );
  });

  it('returns plan.exists=false when no plan file exists', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(result.plan.exists, false);
    assert.equal(result.plan.approved, false);
    assert.deepEqual(result.plan.allTasks, []);
    assert.deepEqual(result.plan.workTasks, []);
    assert.deepEqual(result.plan.reviewTasks, []);
  });

  it('returns plan data when plan exists', async () => {
    const plan = {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      createdAt: '2026-04-13T00:00:00.000Z',
      tasks: [
        makeTask({ id: 'task-001', objectiveId: '2026-04' }),
        makeTask({ id: 'task-002', objectiveId: DAILY_REVIEW_OBJECTIVE_ID }),
        makeTask({ id: 'task-003', objectiveId: WEEKLY_REVIEW_OBJECTIVE_ID }),
      ],
    };
    const deps = {
      weeklyPlanStore: makePlanStore(plan),
      activityLogStore: makeLogStore(),
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(result.plan.exists, true);
    assert.equal(result.plan.approved, true);
    assert.equal(result.plan.createdAt, '2026-04-13T00:00:00.000Z');
    assert.equal(result.plan.allTasks.length, 3);
    assert.equal(result.plan.workTasks.length, 1);
    assert.equal(result.plan.reviewTasks.length, 2);
    assert.equal(result.plan.workTasks[0].id, 'task-001');
  });

  it('collects activity log entries and groups by status', async () => {
    const entries = [
      makeLogEntry({ id: 'log-1', status: 'completed', duration: 10000 }),
      makeLogEntry({ id: 'log-2', status: 'failed', duration: 5000 }),
      makeLogEntry({ id: 'log-3', status: 'completed', duration: 20000 }),
    ];
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(entries),
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(result.activityLog.entries.length, 3);
    assert.equal(result.activityLog.byStatus.completed.length, 2);
    assert.equal(result.activityLog.byStatus.failed.length, 1);
    assert.equal(result.activityLog.totalDurationMs, 35000);
  });

  it('returns zero budget when no usage store provided', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
      // usageStore deliberately omitted
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(result.budget.totalTokens, 0);
    assert.equal(result.budget.remainingTokens, null);
    assert.equal(result.budget.utilizationPct, null);
    assert.equal(result.budget.paused, false);
  });

  it('computes budget utilization from usage and agent config', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
      usageStore: makeUsageStore({
        inputTokens: 30000,
        outputTokens: 20000,
        totalTokens: 50000,
        costUsd: 0.5,
        recordCount: 10,
      }),
      agentStore: makeAgentStore({
        weeklyTokenBudget: 100000,
        budget: { weeklyTokenLimit: 100000, paused: false },
      }),
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(result.budget.weeklyTokenLimit, 100000);
    assert.equal(result.budget.inputTokens, 30000);
    assert.equal(result.budget.outputTokens, 20000);
    assert.equal(result.budget.totalTokens, 50000);
    assert.equal(result.budget.costUsd, 0.5);
    assert.equal(result.budget.sessionCount, 10);
    assert.equal(result.budget.remainingTokens, 50000);
    assert.equal(result.budget.utilizationPct, 50);
    assert.equal(result.budget.paused, false);
  });

  it('reflects agent paused state in budget', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
      usageStore: makeUsageStore({
        inputTokens: 80000,
        outputTokens: 40000,
        totalTokens: 120000,
        costUsd: 1.2,
        recordCount: 20,
      }),
      agentStore: makeAgentStore({
        weeklyTokenBudget: 100000,
        budget: { weeklyTokenLimit: 100000, paused: true },
      }),
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(result.budget.paused, true);
    assert.equal(result.budget.utilizationPct, 100);
    assert.equal(result.budget.remainingTokens, 0);
  });

  it('derives weekMonday from the week key when not overridden', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(result.weekMonday, '2026-04-13');
  });

  it('accepts a weekMonday override', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16', {
      weekMonday: '2026-04-13',
    });
    assert.equal(result.weekMonday, '2026-04-13');
  });

  it('accepts a collectedAt override', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
    };
    const ts = '2026-04-19T10:00:00.000Z';
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16', {
      collectedAt: ts,
    });
    assert.equal(result.collectedAt, ts);
  });

  it('returns structured shape with all top-level fields', async () => {
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(typeof result.agentId, 'string');
    assert.equal(typeof result.week, 'string');
    assert.equal(typeof result.weekMonday, 'string');
    assert.equal(typeof result.collectedAt, 'string');
    assert.ok(result.plan && typeof result.plan === 'object');
    assert.ok(result.activityLog && typeof result.activityLog === 'object');
    assert.ok(result.budget && typeof result.budget === 'object');
  });

  it('handles store errors gracefully (budget fields default to zero)', async () => {
    const failingUsageStore = {
      weeklyTotal: async () => {
        throw new Error('disk read failure');
      },
    };
    const failingAgentStore = {
      load: async () => {
        throw new Error('agent not found');
      },
    };
    const deps = {
      weeklyPlanStore: makePlanStore(null),
      activityLogStore: makeLogStore(),
      usageStore: failingUsageStore,
      agentStore: failingAgentStore,
    };
    const result = await collectWeeklyReviewData(deps, 'agent-x', '2026-W16');
    assert.equal(result.budget.totalTokens, 0);
    assert.equal(result.budget.paused, false);
  });
});
