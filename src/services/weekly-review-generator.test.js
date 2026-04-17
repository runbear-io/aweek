import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  collectCompletedTasksFromPlan,
  collectCompletedFromActivityLog,
  mergeCompletedTasks,
  formatDuration,
  formatCompletedTaskItem,
  formatCompletedTasksSection,
  generateCompletedTasksReview,
} from './weekly-review-generator.js';

import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(tasks = [], overrides = {}) {
  return {
    week: '2026-W16',
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
    agentId: 'agent-test-1234abcd',
    status,
    description: `Log entry ${id}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// collectCompletedTasksFromPlan
// ---------------------------------------------------------------------------

describe('collectCompletedTasksFromPlan', () => {
  it('returns empty array for null/undefined plan', () => {
    assert.deepStrictEqual(collectCompletedTasksFromPlan(null), []);
    assert.deepStrictEqual(collectCompletedTasksFromPlan(undefined), []);
  });

  it('returns empty array for plan with no tasks', () => {
    assert.deepStrictEqual(collectCompletedTasksFromPlan({ tasks: [] }), []);
  });

  it('filters only completed tasks', () => {
    const plan = makePlan([
      makeTask('task-aaa11111', 'completed'),
      makeTask('task-bbb22222', 'pending'),
      makeTask('task-ccc33333', 'failed'),
      makeTask('task-ddd44444', 'completed'),
    ]);
    const result = collectCompletedTasksFromPlan(plan);
    assert.equal(result.length, 2);
    assert.equal(result[0].taskId, 'task-aaa11111');
    assert.equal(result[1].taskId, 'task-ddd44444');
  });

  it('includes priority, objectiveId, completedAt, estimatedMinutes', () => {
    const plan = makePlan([
      makeTask('task-eee55555', 'completed', {
        priority: 'critical',
        completedAt: '2026-04-14T12:00:00.000Z',
        estimatedMinutes: 60,
      }),
    ]);
    const [task] = collectCompletedTasksFromPlan(plan);
    assert.equal(task.priority, 'critical');
    assert.equal(task.objectiveId, 'obj-abc12345');
    assert.equal(task.completedAt, '2026-04-14T12:00:00.000Z');
    assert.equal(task.estimatedMinutes, 60);
    assert.equal(task.source, 'weekly-plan');
  });

  it('defaults missing priority to medium', () => {
    const plan = makePlan([
      makeTask('task-fff66666', 'completed', { priority: undefined }),
    ]);
    // priority field deleted, should default
    delete plan.tasks[0].priority;
    const [task] = collectCompletedTasksFromPlan(plan);
    assert.equal(task.priority, 'medium');
  });
});

// ---------------------------------------------------------------------------
// collectCompletedFromActivityLog
// ---------------------------------------------------------------------------

describe('collectCompletedFromActivityLog', () => {
  it('returns empty array for non-array input', () => {
    assert.deepStrictEqual(collectCompletedFromActivityLog(null), []);
    assert.deepStrictEqual(collectCompletedFromActivityLog(undefined), []);
  });

  it('returns empty array for empty log', () => {
    assert.deepStrictEqual(collectCompletedFromActivityLog([]), []);
  });

  it('filters only completed entries', () => {
    const entries = [
      makeLogEntry('log-aaa11111', 'started'),
      makeLogEntry('log-bbb22222', 'completed'),
      makeLogEntry('log-ccc33333', 'failed'),
      makeLogEntry('log-ddd44444', 'completed'),
    ];
    const result = collectCompletedFromActivityLog(entries);
    assert.equal(result.length, 2);
    assert.equal(result[0].logId, 'log-bbb22222');
    assert.equal(result[1].logId, 'log-ddd44444');
  });

  it('includes duration and metadata when present', () => {
    const entries = [
      makeLogEntry('log-eee55555', 'completed', {
        taskId: 'task-xyz12345',
        duration: 120000,
        metadata: { tokensUsed: 5000 },
      }),
    ];
    const [entry] = collectCompletedFromActivityLog(entries);
    assert.equal(entry.taskId, 'task-xyz12345');
    assert.equal(entry.durationMs, 120000);
    assert.deepStrictEqual(entry.metadata, { tokensUsed: 5000 });
    assert.equal(entry.source, 'activity-log');
  });

  it('defaults missing taskId to null', () => {
    const entries = [makeLogEntry('log-fff66666', 'completed')];
    const [entry] = collectCompletedFromActivityLog(entries);
    assert.equal(entry.taskId, null);
  });
});

// ---------------------------------------------------------------------------
// mergeCompletedTasks
// ---------------------------------------------------------------------------

describe('mergeCompletedTasks', () => {
  it('returns empty array when both inputs are empty', () => {
    assert.deepStrictEqual(mergeCompletedTasks([], []), []);
  });

  it('returns plan tasks when no log entries', () => {
    const planTasks = [
      {
        taskId: 'task-aaa11111',
        description: 'Do X',
        objectiveId: 'obj-abc12345',
        priority: 'high',
        completedAt: '2026-04-14T10:00:00.000Z',
        estimatedMinutes: 30,
        source: 'weekly-plan',
      },
    ];
    const result = mergeCompletedTasks(planTasks, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'weekly-plan');
  });

  it('returns log entries when no plan tasks', () => {
    const logEntries = [
      {
        logId: 'log-aaa11111',
        taskId: null,
        description: 'Ad-hoc work',
        completedAt: '2026-04-14T10:00:00.000Z',
        durationMs: 5000,
        metadata: null,
        source: 'activity-log',
      },
    ];
    const result = mergeCompletedTasks([], logEntries);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'activity-log');
  });

  it('merges matching plan task with log entry', () => {
    const planTasks = [
      {
        taskId: 'task-aaa11111',
        description: 'Do X',
        objectiveId: 'obj-abc12345',
        priority: 'high',
        completedAt: null,
        estimatedMinutes: 30,
        source: 'weekly-plan',
      },
    ];
    const logEntries = [
      {
        logId: 'log-bbb22222',
        taskId: 'task-aaa11111',
        description: 'Completed Do X',
        completedAt: '2026-04-14T11:00:00.000Z',
        durationMs: 120000,
        metadata: { model: 'sonnet' },
        source: 'activity-log',
      },
    ];
    const result = mergeCompletedTasks(planTasks, logEntries);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'merged');
    assert.equal(result[0].taskId, 'task-aaa11111');
    assert.equal(result[0].durationMs, 120000);
    assert.equal(result[0].objectiveId, 'obj-abc12345');
    assert.equal(result[0].completedAt, '2026-04-14T11:00:00.000Z');
    assert.deepStrictEqual(result[0].metadata, { model: 'sonnet' });
  });

  it('sorts by completedAt ascending', () => {
    const planTasks = [
      {
        taskId: 'task-bbb22222',
        description: 'Second',
        objectiveId: 'obj-abc12345',
        priority: 'medium',
        completedAt: '2026-04-15T10:00:00.000Z',
        estimatedMinutes: null,
        source: 'weekly-plan',
      },
      {
        taskId: 'task-aaa11111',
        description: 'First',
        objectiveId: 'obj-abc12345',
        priority: 'medium',
        completedAt: '2026-04-14T10:00:00.000Z',
        estimatedMinutes: null,
        source: 'weekly-plan',
      },
    ];
    const result = mergeCompletedTasks(planTasks, []);
    assert.equal(result[0].description, 'First');
    assert.equal(result[1].description, 'Second');
  });

  it('tasks without completedAt sort last', () => {
    const planTasks = [
      {
        taskId: 'task-aaa11111',
        description: 'No date',
        objectiveId: 'obj-abc12345',
        priority: 'medium',
        completedAt: null,
        estimatedMinutes: null,
        source: 'weekly-plan',
      },
      {
        taskId: 'task-bbb22222',
        description: 'Has date',
        objectiveId: 'obj-abc12345',
        priority: 'medium',
        completedAt: '2026-04-14T10:00:00.000Z',
        estimatedMinutes: null,
        source: 'weekly-plan',
      },
    ];
    const result = mergeCompletedTasks(planTasks, []);
    assert.equal(result[0].description, 'Has date');
    assert.equal(result[1].description, 'No date');
  });

  it('does not duplicate log entries used for merging', () => {
    const planTasks = [
      {
        taskId: 'task-aaa11111',
        description: 'Do X',
        objectiveId: 'obj-abc12345',
        priority: 'medium',
        completedAt: '2026-04-14T10:00:00.000Z',
        estimatedMinutes: null,
        source: 'weekly-plan',
      },
    ];
    const logEntries = [
      {
        logId: 'log-aaa11111',
        taskId: 'task-aaa11111',
        description: 'Did X',
        completedAt: '2026-04-14T10:00:00.000Z',
        durationMs: 5000,
        metadata: null,
        source: 'activity-log',
      },
    ];
    const result = mergeCompletedTasks(planTasks, logEntries);
    assert.equal(result.length, 1); // not 2
    assert.equal(result[0].source, 'merged');
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('returns empty string for null/undefined/zero', () => {
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration(undefined), '');
    assert.equal(formatDuration(0), '');
    assert.equal(formatDuration(-100), '');
  });

  it('formats seconds', () => {
    assert.equal(formatDuration(5000), '5s');
    assert.equal(formatDuration(30000), '30s');
  });

  it('formats minutes', () => {
    assert.equal(formatDuration(60000), '1m');
    assert.equal(formatDuration(300000), '5m');
  });

  it('formats hours and minutes', () => {
    assert.equal(formatDuration(3_600_000), '1h');
    assert.equal(formatDuration(5_400_000), '1h 30m');
    assert.equal(formatDuration(7_200_000), '2h');
  });
});

// ---------------------------------------------------------------------------
// formatCompletedTaskItem
// ---------------------------------------------------------------------------

describe('formatCompletedTaskItem', () => {
  it('formats basic task with checkbox', () => {
    const task = {
      description: 'Write tests',
      priority: 'medium',
      objectiveId: null,
      completedAt: null,
      durationMs: null,
    };
    const result = formatCompletedTaskItem(task);
    assert.equal(result, '- [x] Write tests');
  });

  it('includes non-medium priority', () => {
    const task = {
      description: 'Critical fix',
      priority: 'critical',
      objectiveId: null,
      completedAt: null,
      durationMs: null,
    };
    const result = formatCompletedTaskItem(task);
    assert.ok(result.includes('priority:critical'));
  });

  it('does not show medium priority tag', () => {
    const task = {
      description: 'Normal work',
      priority: 'medium',
      objectiveId: 'obj-abc12345',
      completedAt: '2026-04-14T10:00:00.000Z',
      durationMs: null,
    };
    const result = formatCompletedTaskItem(task);
    assert.ok(!result.includes('priority:medium'));
  });

  it('includes duration when available', () => {
    const task = {
      description: 'Long task',
      priority: 'medium',
      objectiveId: null,
      completedAt: null,
      durationMs: 300000,
    };
    const result = formatCompletedTaskItem(task);
    assert.ok(result.includes('duration:5m'));
  });

  it('includes objective reference', () => {
    const task = {
      description: 'Linked task',
      priority: 'medium',
      objectiveId: 'obj-abc12345',
      completedAt: null,
      durationMs: null,
    };
    const result = formatCompletedTaskItem(task);
    assert.ok(result.includes('objective:obj-abc12345'));
  });

  it('includes completed date (date-only)', () => {
    const task = {
      description: 'Done',
      priority: 'medium',
      objectiveId: null,
      completedAt: '2026-04-14T15:30:00.000Z',
      durationMs: null,
    };
    const result = formatCompletedTaskItem(task);
    assert.ok(result.includes('completed:2026-04-14'));
    assert.ok(!result.includes('T15:30'));
  });

  it('respects includeDuration=false', () => {
    const task = {
      description: 'Task',
      priority: 'medium',
      objectiveId: null,
      completedAt: null,
      durationMs: 300000,
    };
    const result = formatCompletedTaskItem(task, { includeDuration: false });
    assert.ok(!result.includes('duration'));
  });

  it('respects includeObjective=false', () => {
    const task = {
      description: 'Task',
      priority: 'medium',
      objectiveId: 'obj-abc12345',
      completedAt: null,
      durationMs: null,
    };
    const result = formatCompletedTaskItem(task, { includeObjective: false });
    assert.ok(!result.includes('objective'));
  });
});

// ---------------------------------------------------------------------------
// formatCompletedTasksSection
// ---------------------------------------------------------------------------

describe('formatCompletedTasksSection', () => {
  it('renders empty state message when no tasks', () => {
    const md = formatCompletedTasksSection([]);
    assert.ok(md.includes('## Completed Tasks'));
    assert.ok(md.includes('No tasks were completed this week'));
  });

  it('includes summary count', () => {
    const tasks = [
      { description: 'A', objectiveId: 'obj-aaa11111', priority: 'medium', completedAt: '2026-04-14T10:00:00.000Z', durationMs: null },
      { description: 'B', objectiveId: 'obj-aaa11111', priority: 'medium', completedAt: '2026-04-15T10:00:00.000Z', durationMs: null },
    ];
    const md = formatCompletedTasksSection(tasks);
    assert.ok(md.includes('**2** tasks completed'));
  });

  it('includes total duration in summary', () => {
    const tasks = [
      { description: 'A', objectiveId: null, priority: 'medium', completedAt: null, durationMs: 120000 },
      { description: 'B', objectiveId: null, priority: 'medium', completedAt: null, durationMs: 180000 },
    ];
    const md = formatCompletedTasksSection(tasks);
    assert.ok(md.includes('total time: 5m'));
  });

  it('singular "task" for single completion', () => {
    const tasks = [
      { description: 'Only one', objectiveId: null, priority: 'medium', completedAt: null, durationMs: null },
    ];
    const md = formatCompletedTasksSection(tasks);
    assert.ok(md.includes('**1** task completed'));
    assert.ok(!md.includes('tasks completed'));
  });

  it('groups tasks by objective', () => {
    const tasks = [
      { description: 'A', objectiveId: 'obj-aaa11111', priority: 'medium', completedAt: null, durationMs: null },
      { description: 'B', objectiveId: 'obj-bbb22222', priority: 'medium', completedAt: null, durationMs: null },
      { description: 'C', objectiveId: 'obj-aaa11111', priority: 'medium', completedAt: null, durationMs: null },
    ];
    const md = formatCompletedTasksSection(tasks);
    assert.ok(md.includes('### Objective: obj-aaa11111'));
    assert.ok(md.includes('### Objective: obj-bbb22222'));
  });

  it('puts tasks without objective under "Other Completed Work"', () => {
    const tasks = [
      { description: 'Linked', objectiveId: 'obj-aaa11111', priority: 'medium', completedAt: null, durationMs: null },
      { description: 'Orphan', objectiveId: null, priority: 'medium', completedAt: null, durationMs: null },
    ];
    const md = formatCompletedTasksSection(tasks);
    assert.ok(md.includes('### Other Completed Work'));
    assert.ok(md.includes('Orphan'));
  });

  it('flat list when groupByObjective=false', () => {
    const tasks = [
      { description: 'A', objectiveId: 'obj-aaa11111', priority: 'medium', completedAt: null, durationMs: null },
      { description: 'B', objectiveId: 'obj-bbb22222', priority: 'medium', completedAt: null, durationMs: null },
    ];
    const md = formatCompletedTasksSection(tasks, { groupByObjective: false });
    assert.ok(!md.includes('### Objective'));
    assert.ok(md.includes('- [x] A'));
    assert.ok(md.includes('- [x] B'));
  });

  it('omits summary when includeSummary=false', () => {
    const tasks = [
      { description: 'A', objectiveId: null, priority: 'medium', completedAt: null, durationMs: null },
    ];
    const md = formatCompletedTasksSection(tasks, { includeSummary: false });
    assert.ok(!md.includes('task completed'));
    assert.ok(md.includes('- [x] A'));
  });
});

// ---------------------------------------------------------------------------
// generateCompletedTasksReview (integration with stores)
// ---------------------------------------------------------------------------

describe('generateCompletedTasksReview', () => {
  let tmpDir;
  let weeklyPlanStore;
  let activityLogStore;

  const agentId = 'agent-review-test1234';
  const week = '2026-W16';
  const weekMonday = '2026-04-13';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-review-'));
    weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    activityLogStore = new ActivityLogStore(tmpDir);
  });

  it('returns empty completed tasks when no plan and no logs exist', async () => {
    const result = await generateCompletedTasksReview(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      weekMonday
    );
    assert.equal(result.completedTasks.length, 0);
    assert.ok(result.markdown.includes('No tasks were completed'));
  });

  it('collects completed tasks from weekly plan', async () => {
    const plan = makePlan([
      makeTask('task-aaa11111', 'completed', {
        completedAt: '2026-04-14T10:00:00.000Z',
      }),
      makeTask('task-bbb22222', 'pending'),
    ]);
    await weeklyPlanStore.save(agentId, plan);

    const result = await generateCompletedTasksReview(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      weekMonday
    );
    assert.equal(result.completedTasks.length, 1);
    assert.equal(result.completedTasks[0].taskId, 'task-aaa11111');
    assert.ok(result.markdown.includes('**1** task completed'));
  });

  it('collects completed entries from activity log', async () => {
    const entry = makeLogEntry('log-aaa11111', 'completed', {
      agentId,
      description: 'Did something ad-hoc',
      duration: 60000,
    });
    await activityLogStore.append(agentId, entry);

    const result = await generateCompletedTasksReview(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      weekMonday
    );
    assert.equal(result.completedTasks.length, 1);
    assert.ok(result.markdown.includes('Did something ad-hoc'));
  });

  it('merges plan tasks with activity log entries', async () => {
    const plan = makePlan([
      makeTask('task-aaa11111', 'completed', {
        completedAt: '2026-04-14T10:00:00.000Z',
      }),
    ]);
    await weeklyPlanStore.save(agentId, plan);

    const entry = makeLogEntry('log-bbb22222', 'completed', {
      agentId,
      taskId: 'task-aaa11111',
      description: 'Completed Task task-aaa11111',
      duration: 90000,
      metadata: { model: 'sonnet' },
    });
    await activityLogStore.append(agentId, entry);

    const result = await generateCompletedTasksReview(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      weekMonday
    );
    // Should merge into 1 record, not 2
    assert.equal(result.completedTasks.length, 1);
    assert.equal(result.completedTasks[0].source, 'merged');
    assert.equal(result.completedTasks[0].durationMs, 90000);
    assert.ok(result.markdown.includes('**1** task completed'));
  });

  it('handles plan load failure gracefully', async () => {
    // No plan saved — should not throw
    const entry = makeLogEntry('log-aaa11111', 'completed', {
      agentId,
      description: 'Background work',
    });
    await activityLogStore.append(agentId, entry);

    const result = await generateCompletedTasksReview(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      weekMonday
    );
    assert.equal(result.completedTasks.length, 1);
    assert.ok(result.markdown.includes('Background work'));
  });

  it('returns structured data alongside markdown', async () => {
    const plan = makePlan([
      makeTask('task-aaa11111', 'completed', {
        completedAt: '2026-04-14T10:00:00.000Z',
      }),
      makeTask('task-bbb22222', 'completed', {
        completedAt: '2026-04-15T10:00:00.000Z',
        priority: 'critical',
      }),
    ]);
    await weeklyPlanStore.save(agentId, plan);

    const result = await generateCompletedTasksReview(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      weekMonday
    );
    assert.equal(result.completedTasks.length, 2);
    assert.equal(typeof result.markdown, 'string');
    assert.ok(result.markdown.startsWith('## Completed Tasks'));
    assert.ok(result.markdown.includes('**2** tasks completed'));
  });
});
