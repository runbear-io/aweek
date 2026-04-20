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
  formatTaskStatusSection,
  formatCarryOverSection,
  formatWhatWorkedSection,
  formatBudgetSummarySection,
  generateWeeklyReviewContent,
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

// ---------------------------------------------------------------------------
// formatTaskStatusSection
// ---------------------------------------------------------------------------

describe('formatTaskStatusSection', () => {
  it('renders empty-state message for null/empty input', () => {
    assert.ok(formatTaskStatusSection(null).includes('No work tasks were scheduled'));
    assert.ok(formatTaskStatusSection([]).includes('No work tasks were scheduled'));
  });

  it('renders section heading', () => {
    const md = formatTaskStatusSection([
      makeTask('task-aaa11111', 'completed'),
    ]);
    assert.ok(md.includes('## Task Completion Status'));
  });

  it('includes completion rate summary line', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed'),
      makeTask('task-bbb22222', 'pending'),
    ];
    const md = formatTaskStatusSection(tasks);
    assert.ok(md.includes('**1/2** tasks completed (50%)'));
  });

  it('100% when all tasks completed', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed'),
      makeTask('task-bbb22222', 'completed'),
    ];
    const md = formatTaskStatusSection(tasks);
    assert.ok(md.includes('(100%)'));
  });

  it('uses [x] marker for completed tasks', () => {
    const md = formatTaskStatusSection([makeTask('task-aaa11111', 'completed')]);
    assert.ok(md.includes('- [x]'));
  });

  it('uses [ ] marker for pending tasks', () => {
    const md = formatTaskStatusSection([makeTask('task-aaa11111', 'pending')]);
    assert.ok(md.includes('- [ ]'));
  });

  it('uses [!] marker for failed tasks', () => {
    const md = formatTaskStatusSection([makeTask('task-aaa11111', 'failed')]);
    assert.ok(md.includes('- [!]'));
  });

  it('uses [-] marker for skipped tasks', () => {
    const md = formatTaskStatusSection([makeTask('task-aaa11111', 'skipped')]);
    assert.ok(md.includes('- [-]'));
  });

  it('includes non-medium priority tag', () => {
    const md = formatTaskStatusSection([
      makeTask('task-aaa11111', 'completed', { priority: 'critical' }),
    ]);
    assert.ok(md.includes('priority:critical'));
  });

  it('omits priority tag for medium priority', () => {
    const md = formatTaskStatusSection([
      makeTask('task-aaa11111', 'completed', { priority: 'medium' }),
    ]);
    assert.ok(!md.includes('priority:medium'));
  });

  it('includes objectiveId arrow tag', () => {
    const md = formatTaskStatusSection([
      makeTask('task-aaa11111', 'completed', { objectiveId: 'obj-abc12345' }),
    ]);
    assert.ok(md.includes('→ obj-abc12345'));
  });

  it('includes done date for completed tasks with completedAt', () => {
    const md = formatTaskStatusSection([
      makeTask('task-aaa11111', 'completed', {
        completedAt: '2026-04-14T10:00:00.000Z',
      }),
    ]);
    assert.ok(md.includes('done:2026-04-14'));
  });

  it('does not include done date for pending tasks', () => {
    const md = formatTaskStatusSection([makeTask('task-aaa11111', 'pending')]);
    assert.ok(!md.includes('done:'));
  });

  it('renders each task description', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed', { description: 'First task' }),
      makeTask('task-bbb22222', 'pending', { description: 'Second task' }),
    ];
    const md = formatTaskStatusSection(tasks);
    assert.ok(md.includes('First task'));
    assert.ok(md.includes('Second task'));
  });
});

// ---------------------------------------------------------------------------
// formatCarryOverSection
// ---------------------------------------------------------------------------

describe('formatCarryOverSection', () => {
  it('renders empty-state for null/empty input', () => {
    assert.ok(formatCarryOverSection(null).includes('No tasks were scheduled this week'));
    assert.ok(formatCarryOverSection([]).includes('No tasks were scheduled this week'));
  });

  it('renders section heading', () => {
    const md = formatCarryOverSection([makeTask('task-aaa11111', 'pending')]);
    assert.ok(md.includes('## Carry-Over Tasks'));
  });

  it('renders congratulation message when nothing to carry over', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed'),
      makeTask('task-bbb22222', 'skipped'),
      makeTask('task-ccc33333', 'delegated'),
    ];
    const md = formatCarryOverSection(tasks);
    assert.ok(md.includes('Nothing to carry over'));
  });

  it('includes pending tasks in carry-over', () => {
    const md = formatCarryOverSection([makeTask('task-aaa11111', 'pending')]);
    assert.ok(md.includes('- [ ]'));
    assert.ok(md.includes('Task task-aaa11111'));
  });

  it('includes failed tasks with retry note', () => {
    const md = formatCarryOverSection([
      makeTask('task-aaa11111', 'failed', { description: 'Broken task' }),
    ]);
    assert.ok(md.includes('Broken task'));
    assert.ok(md.includes('failed — needs retry'));
  });

  it('includes in-progress tasks with "was in progress" note', () => {
    const md = formatCarryOverSection([
      makeTask('task-aaa11111', 'in-progress', { description: 'Half done' }),
    ]);
    assert.ok(md.includes('Half done'));
    assert.ok(md.includes('was in progress'));
  });

  it('excludes completed, skipped, delegated tasks', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed', { description: 'Done' }),
      makeTask('task-bbb22222', 'skipped', { description: 'Skipped' }),
      makeTask('task-ccc33333', 'delegated', { description: 'Delegated' }),
      makeTask('task-ddd44444', 'pending', { description: 'Pending' }),
    ];
    const md = formatCarryOverSection(tasks);
    assert.ok(!md.includes('Done'));
    assert.ok(!md.includes('Skipped'));
    assert.ok(!md.includes('Delegated'));
    assert.ok(md.includes('Pending'));
  });

  it('shows count in header', () => {
    const tasks = [
      makeTask('task-aaa11111', 'pending'),
      makeTask('task-bbb22222', 'failed'),
    ];
    const md = formatCarryOverSection(tasks);
    assert.ok(md.includes('**2** tasks to carry forward:'));
  });

  it('singular "task" for single carry-over', () => {
    const md = formatCarryOverSection([makeTask('task-aaa11111', 'pending')]);
    assert.ok(md.includes('**1** task to carry forward:'));
    assert.ok(!md.includes('tasks to carry forward'));
  });

  it('includes objectiveId tag for carry-over tasks', () => {
    const md = formatCarryOverSection([
      makeTask('task-aaa11111', 'pending', { objectiveId: 'obj-abc12345' }),
    ]);
    assert.ok(md.includes('obj-abc12345'));
  });

  it('includes non-medium priority tag', () => {
    const md = formatCarryOverSection([
      makeTask('task-aaa11111', 'pending', { priority: 'high' }),
    ]);
    assert.ok(md.includes('priority:high'));
  });
});

// ---------------------------------------------------------------------------
// formatWhatWorkedSection
// ---------------------------------------------------------------------------

describe('formatWhatWorkedSection', () => {
  function makeCollected(workTasks = [], totalDurationMs = 0, byStatus = {}) {
    return {
      plan: { workTasks },
      activityLog: { totalDurationMs, byStatus },
    };
  }

  it('renders section heading', () => {
    const md = formatWhatWorkedSection(makeCollected([makeTask('task-aaa11111', 'completed')]));
    assert.ok(md.includes('## What Worked'));
  });

  it('renders no-activity message when nothing happened', () => {
    const md = formatWhatWorkedSection(makeCollected());
    assert.ok(md.includes('No significant activity was recorded'));
  });

  it('includes completion rate in opening sentence', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed'),
      makeTask('task-bbb22222', 'pending'),
    ];
    const md = formatWhatWorkedSection(makeCollected(tasks));
    assert.ok(md.includes('1 of 2 planned tasks'));
    assert.ok(md.includes('50% completion rate'));
  });

  it('includes active session time when totalDurationMs > 0', () => {
    const tasks = [makeTask('task-aaa11111', 'completed')];
    const md = formatWhatWorkedSection(makeCollected(tasks, 3_600_000));
    assert.ok(md.includes('1h'));
  });

  it('renders session-time-only sentence when no tasks completed', () => {
    const md = formatWhatWorkedSection(makeCollected([], 1_800_000));
    assert.ok(md.includes('No planned tasks were completed'));
    assert.ok(md.includes('30m'));
  });

  it('highlights critical completions', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed', {
        priority: 'critical',
        description: 'Deploy hotfix',
      }),
    ];
    const md = formatWhatWorkedSection(makeCollected(tasks));
    assert.ok(md.includes('Critical work shipped'));
    assert.ok(md.includes('Deploy hotfix'));
  });

  it('highlights high-priority completions', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed', {
        priority: 'high',
        description: 'Fix performance bug',
      }),
    ];
    const md = formatWhatWorkedSection(makeCollected(tasks));
    assert.ok(md.includes('High-priority wins'));
    assert.ok(md.includes('Fix performance bug'));
  });

  it('does not render priority highlights for medium tasks', () => {
    const tasks = [makeTask('task-aaa11111', 'completed', { priority: 'medium' })];
    const md = formatWhatWorkedSection(makeCollected(tasks));
    assert.ok(!md.includes('Critical work'));
    assert.ok(!md.includes('High-priority'));
  });

  it('renders objective breakdown when multiple objectives contributed', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed', { objectiveId: 'obj-aaa11111' }),
      makeTask('task-bbb22222', 'completed', { objectiveId: 'obj-bbb22222' }),
    ];
    const md = formatWhatWorkedSection(makeCollected(tasks));
    assert.ok(md.includes('Progress by objective'));
    assert.ok(md.includes('obj-aaa11111'));
    assert.ok(md.includes('obj-bbb22222'));
  });

  it('omits objective breakdown when only one objective', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed', { objectiveId: 'obj-aaa11111' }),
      makeTask('task-bbb22222', 'completed', { objectiveId: 'obj-aaa11111' }),
    ];
    const md = formatWhatWorkedSection(makeCollected(tasks));
    assert.ok(!md.includes('Progress by objective'));
  });

  it('labels tasks with no objectiveId as "Other" in breakdown', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed', { objectiveId: 'obj-aaa11111' }),
      makeTask('task-bbb22222', 'completed', { objectiveId: undefined }),
    ];
    // Remove objectiveId from second task
    delete tasks[1].objectiveId;
    const md = formatWhatWorkedSection(makeCollected(tasks));
    assert.ok(md.includes('Other'));
  });
});

// ---------------------------------------------------------------------------
// formatBudgetSummarySection
// ---------------------------------------------------------------------------

describe('formatBudgetSummarySection', () => {
  function makeBudget(overrides = {}) {
    return {
      weeklyTokenLimit: 0,
      inputTokens: 30000,
      outputTokens: 20000,
      totalTokens: 50000,
      costUsd: 0.5,
      sessionCount: 10,
      remainingTokens: null,
      utilizationPct: null,
      paused: false,
      ...overrides,
    };
  }

  it('renders section heading', () => {
    const md = formatBudgetSummarySection(makeBudget());
    assert.ok(md.includes('## Budget Summary'));
  });

  it('renders no-usage message when totalTokens is 0', () => {
    const md = formatBudgetSummarySection({ totalTokens: 0 });
    assert.ok(md.includes('No token usage was recorded'));
  });

  it('renders no-usage message for null input', () => {
    const md = formatBudgetSummarySection(null);
    assert.ok(md.includes('No token usage was recorded'));
  });

  it('includes sessions, token counts and cost', () => {
    const md = formatBudgetSummarySection(makeBudget());
    assert.ok(md.includes('Sessions'));
    assert.ok(md.includes('10'));
    assert.ok(md.includes('30,000'));
    assert.ok(md.includes('20,000'));
    assert.ok(md.includes('50,000'));
    assert.ok(md.includes('$0.50'));
  });

  it('includes weekly limit and remaining tokens when limit is set', () => {
    const md = formatBudgetSummarySection(
      makeBudget({
        weeklyTokenLimit: 100000,
        remainingTokens: 50000,
        utilizationPct: 50,
      })
    );
    assert.ok(md.includes('Weekly token limit'));
    assert.ok(md.includes('100,000'));
    assert.ok(md.includes('Remaining tokens'));
    assert.ok(md.includes('50,000'));
    assert.ok(md.includes('50%'));
  });

  it('omits limit rows when weeklyTokenLimit is 0', () => {
    const md = formatBudgetSummarySection(makeBudget({ weeklyTokenLimit: 0 }));
    assert.ok(!md.includes('Weekly token limit'));
    assert.ok(!md.includes('Remaining tokens'));
  });

  it('adds ⚠️ indicator at 90%+ utilization', () => {
    const md = formatBudgetSummarySection(
      makeBudget({ weeklyTokenLimit: 100000, utilizationPct: 95 })
    );
    assert.ok(md.includes('⚠️'));
  });

  it('adds 🔶 indicator at 75–89% utilization', () => {
    const md = formatBudgetSummarySection(
      makeBudget({ weeklyTokenLimit: 100000, utilizationPct: 80 })
    );
    assert.ok(md.includes('🔶'));
  });

  it('no utilization indicator below 75%', () => {
    const md = formatBudgetSummarySection(
      makeBudget({ weeklyTokenLimit: 100000, utilizationPct: 60 })
    );
    assert.ok(!md.includes('🔶'));
    // Only the paused warning contains ⚠️ — none expected here
    assert.ok(!md.includes('⚠️'));
  });

  it('shows paused warning when agent is paused', () => {
    const md = formatBudgetSummarySection(makeBudget({ paused: true }));
    assert.ok(md.includes('currently paused'));
    assert.ok(md.includes('/aweek:manage'));
  });

  it('no paused warning when agent is running', () => {
    const md = formatBudgetSummarySection(makeBudget({ paused: false }));
    assert.ok(!md.includes('currently paused'));
  });

  it('formats sub-cent cost with 4 decimal places', () => {
    const md = formatBudgetSummarySection(makeBudget({ costUsd: 0.005 }));
    assert.ok(md.includes('$0.0050'));
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyReviewContent (main generator)
// ---------------------------------------------------------------------------

describe('generateWeeklyReviewContent', () => {
  function makeCollectedData(overrides = {}) {
    return {
      agentId: 'agent-test-1234abcd',
      week: '2026-W16',
      weekMonday: '2026-04-13',
      collectedAt: '2026-04-19T10:00:00.000Z',
      plan: {
        exists: true,
        approved: true,
        createdAt: '2026-04-13T00:00:00.000Z',
        allTasks: [],
        workTasks: [],
        reviewTasks: [],
      },
      activityLog: {
        entries: [],
        byStatus: {},
        totalDurationMs: 0,
      },
      budget: {
        weeklyTokenLimit: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        sessionCount: 0,
        remainingTokens: null,
        utilizationPct: null,
        paused: false,
      },
      ...overrides,
    };
  }

  it('returns an object with markdown and sections', () => {
    const result = generateWeeklyReviewContent(makeCollectedData());
    assert.equal(typeof result.markdown, 'string');
    assert.ok(result.sections && typeof result.sections === 'object');
  });

  it('sections object has all four required keys', () => {
    const result = generateWeeklyReviewContent(makeCollectedData());
    assert.ok('taskStatus' in result.sections);
    assert.ok('carryOver' in result.sections);
    assert.ok('whatWorked' in result.sections);
    assert.ok('budgetSummary' in result.sections);
  });

  it('markdown contains all four section headings', () => {
    const result = generateWeeklyReviewContent(makeCollectedData());
    assert.ok(result.markdown.includes('## Task Completion Status'));
    assert.ok(result.markdown.includes('## Carry-Over Tasks'));
    assert.ok(result.markdown.includes('## What Worked'));
    assert.ok(result.markdown.includes('## Budget Summary'));
  });

  it('markdown matches concatenation of the four section strings', () => {
    const result = generateWeeklyReviewContent(makeCollectedData());
    const { taskStatus, carryOver, whatWorked, budgetSummary } = result.sections;
    const expected = [taskStatus, carryOver, whatWorked, budgetSummary].join('\n');
    assert.equal(result.markdown, expected);
  });

  it('sections appear in the correct order', () => {
    const result = generateWeeklyReviewContent(makeCollectedData());
    const ts = result.markdown.indexOf('## Task Completion Status');
    const co = result.markdown.indexOf('## Carry-Over Tasks');
    const ww = result.markdown.indexOf('## What Worked');
    const bs = result.markdown.indexOf('## Budget Summary');
    assert.ok(ts < co, 'Task Status must come before Carry-Over');
    assert.ok(co < ww, 'Carry-Over must come before What Worked');
    assert.ok(ww < bs, 'What Worked must come before Budget Summary');
  });

  it('reflects completed work tasks in task status section', () => {
    const data = makeCollectedData({
      plan: {
        exists: true,
        approved: true,
        createdAt: null,
        allTasks: [],
        workTasks: [
          makeTask('task-aaa11111', 'completed', { description: 'Ship feature' }),
          makeTask('task-bbb22222', 'pending', { description: 'Write docs' }),
        ],
        reviewTasks: [],
      },
    });
    const result = generateWeeklyReviewContent(data);
    assert.ok(result.markdown.includes('Ship feature'));
    assert.ok(result.markdown.includes('Write docs'));
    assert.ok(result.markdown.includes('[x]')); // completed marker
    assert.ok(result.markdown.includes('[ ]')); // pending marker
  });

  it('places pending tasks in carry-over section', () => {
    const data = makeCollectedData({
      plan: {
        exists: true,
        approved: true,
        createdAt: null,
        allTasks: [],
        workTasks: [
          makeTask('task-aaa11111', 'completed', { description: 'Done' }),
          makeTask('task-bbb22222', 'pending', { description: 'Not done' }),
        ],
        reviewTasks: [],
      },
    });
    const result = generateWeeklyReviewContent(data);
    // Carry-over section should mention the pending task
    assert.ok(result.sections.carryOver.includes('Not done'));
    // Completed task should NOT appear in carry-over
    assert.ok(!result.sections.carryOver.includes('Done'));
  });

  it('shows budget usage when tokens are consumed', () => {
    const data = makeCollectedData({
      budget: {
        weeklyTokenLimit: 100000,
        inputTokens: 40000,
        outputTokens: 20000,
        totalTokens: 60000,
        costUsd: 0.6,
        sessionCount: 5,
        remainingTokens: 40000,
        utilizationPct: 60,
        paused: false,
      },
    });
    const result = generateWeeklyReviewContent(data);
    assert.ok(result.sections.budgetSummary.includes('60,000'));
    assert.ok(result.sections.budgetSummary.includes('$0.60'));
  });

  it('handles null/missing collectedData gracefully', () => {
    // Should not throw; should return empty-state sections
    const result = generateWeeklyReviewContent(null);
    assert.equal(typeof result.markdown, 'string');
    assert.ok(result.markdown.includes('## Task Completion Status'));
    assert.ok(result.markdown.includes('No work tasks were scheduled'));
  });

  it('is a pure function — calling twice yields identical output', () => {
    const data = makeCollectedData({
      plan: {
        exists: true,
        approved: true,
        createdAt: null,
        allTasks: [],
        workTasks: [makeTask('task-aaa11111', 'completed')],
        reviewTasks: [],
      },
    });
    const first = generateWeeklyReviewContent(data);
    const second = generateWeeklyReviewContent(data);
    assert.equal(first.markdown, second.markdown);
  });
});
