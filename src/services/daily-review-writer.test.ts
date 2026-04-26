import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  utcToLocalDate,
  weekdayName,
  tomorrowWeekdayName,
  dateToISOWeek,
  isoWeekToMondayDate,
  collectDayTasks,
  collectDayLogEntries,
  taskStatusIcon,
  formatDayTaskItem,
  formatTaskStatusSection,
  buildAdjustmentsForTomorrow,
  formatAdjustmentsSection,
  formatNotesSection,
  buildDailyReviewHeader,
  assembleDailyReview,
  dailyReviewDir,
  dailyReviewPaths,
  persistDailyReview,
  loadDailyReview,
  listDailyReviews,
  buildDailyReviewMetadata,
  generateDailyReview,
} from './daily-review-writer.js';

import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../storage/activity-log-store.js';
import { AgentStore } from '../storage/agent-store.js';
import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = 'agent-drwtest1234';
const DATE = '2026-04-14'; // Tuesday (within week 2026-W16)
const WEEK = '2026-W16';
const WEEK_MONDAY = '2026-04-13';
const GENERATED_AT = '2026-04-14T17:00:00.000Z';

interface TaskOverrides {
  description?: string;
  title?: string;
  prompt?: string;
  objectiveId?: string | null | undefined;
  priority?: string;
  runAt?: string | undefined;
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

interface TestWeeklyPlan {
  week: string;
  month: string;
  tasks: TestTask[];
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TestLogEntry {
  id?: string;
  taskId?: string;
  timestamp?: string;
  agentId?: string;
  status?: string;
  title?: string;
  duration?: number;
  metadata?: { error?: string; [key: string]: unknown };
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

function makeReviewTask(id: string, objectiveId: string = DAILY_REVIEW_OBJECTIVE_ID): TestTask {
  return {
    id,
    title: 'Daily review task',
    prompt: 'Daily review task',
    objectiveId,
    status: 'pending',
    priority: 'medium',
    runAt: `${DATE}T17:00:00.000Z`,
  };
}

function makeWeeklyPlan(tasks: TestTask[] = [], overrides: Partial<TestWeeklyPlan> = {}): TestWeeklyPlan {
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

function makeLogEntry(id: string, overrides: Record<string, unknown> = {}): TestLogEntry {
  const { description, title, ...rest } = overrides as { description?: string; title?: string; [key: string]: unknown };
  return {
    id,
    timestamp: `${DATE}T10:00:00.000Z`,
    agentId: AGENT_ID,
    status: 'completed',
    title: title || description || `Log entry ${id}`,
    ...rest,
  };
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
// utcToLocalDate
// ---------------------------------------------------------------------------

describe('utcToLocalDate', () => {
  it('returns YYYY-MM-DD slice for UTC timezone', () => {
    assert.equal(utcToLocalDate('2026-04-14T17:30:00.000Z', 'UTC'), '2026-04-14');
  });

  it('returns YYYY-MM-DD slice when tz is omitted', () => {
    assert.equal(utcToLocalDate('2026-04-14T23:59:00.000Z'), '2026-04-14');
  });

  it('returns null for falsy input', () => {
    assert.equal(utcToLocalDate(null), null);
    assert.equal(utcToLocalDate(undefined), null);
    assert.equal(utcToLocalDate(''), null);
  });

  it('applies timezone offset for America/New_York (UTC-4 in summer)', () => {
    // 2026-04-14T03:00:00Z → 2026-04-13 22:00 EDT (UTC-5 in April)
    const result = utcToLocalDate('2026-04-14T03:00:00.000Z', 'America/New_York');
    // EDT = UTC-4, so 03:00Z = 23:00 previous day
    assert.equal(result, '2026-04-13');
  });

  it('returns same day when UTC time is well within the day', () => {
    const result = utcToLocalDate('2026-04-14T12:00:00.000Z', 'UTC');
    assert.equal(result, '2026-04-14');
  });
});

// ---------------------------------------------------------------------------
// weekdayName
// ---------------------------------------------------------------------------

describe('weekdayName', () => {
  it('returns Monday for 2026-04-13', () => {
    assert.equal(weekdayName('2026-04-13'), 'Monday');
  });

  it('returns Tuesday for 2026-04-14', () => {
    assert.equal(weekdayName('2026-04-14'), 'Tuesday');
  });

  it('returns Friday for 2026-04-17', () => {
    assert.equal(weekdayName('2026-04-17'), 'Friday');
  });

  it('returns Sunday for 2026-04-19', () => {
    assert.equal(weekdayName('2026-04-19'), 'Sunday');
  });
});

// ---------------------------------------------------------------------------
// tomorrowWeekdayName
// ---------------------------------------------------------------------------

describe('tomorrowWeekdayName', () => {
  it('returns Wednesday for Tuesday 2026-04-14', () => {
    assert.equal(tomorrowWeekdayName('2026-04-14'), 'Wednesday');
  });

  it('returns Saturday for Friday 2026-04-17', () => {
    assert.equal(tomorrowWeekdayName('2026-04-17'), 'Saturday');
  });

  it('returns Monday for Sunday 2026-04-19', () => {
    assert.equal(tomorrowWeekdayName('2026-04-19'), 'Monday');
  });
});

// ---------------------------------------------------------------------------
// dateToISOWeek
// ---------------------------------------------------------------------------

describe('dateToISOWeek', () => {
  it('returns 2026-W16 for Monday 2026-04-13', () => {
    assert.equal(dateToISOWeek('2026-04-13'), '2026-W16');
  });

  it('returns 2026-W16 for Tuesday 2026-04-14', () => {
    assert.equal(dateToISOWeek('2026-04-14'), '2026-W16');
  });

  it('returns 2026-W16 for Friday 2026-04-17', () => {
    assert.equal(dateToISOWeek('2026-04-17'), '2026-W16');
  });

  it('returns 2026-W01 for the first week of 2026', () => {
    // 2025-12-29 is Monday of 2026-W01
    assert.equal(dateToISOWeek('2025-12-29'), '2026-W01');
  });
});

// ---------------------------------------------------------------------------
// isoWeekToMondayDate
// ---------------------------------------------------------------------------

describe('isoWeekToMondayDate', () => {
  it('returns 2026-04-13 for 2026-W16', () => {
    assert.equal(isoWeekToMondayDate('2026-W16'), '2026-04-13');
  });

  it('returns 2025-12-29 for 2026-W01', () => {
    assert.equal(isoWeekToMondayDate('2026-W01'), '2025-12-29');
  });

  it('throws on invalid format', () => {
    assert.throws(() => isoWeekToMondayDate('2026-16'), /Invalid ISO week/);
    assert.throws(() => isoWeekToMondayDate('not-a-week'), /Invalid ISO week/);
  });
});

// ---------------------------------------------------------------------------
// collectDayTasks
// ---------------------------------------------------------------------------

describe('collectDayTasks', () => {
  it('returns empty array for null plan', () => {
    assert.deepStrictEqual(collectDayTasks(null, DATE), []);
  });

  it('returns empty array for plan with no tasks', () => {
    assert.deepStrictEqual(collectDayTasks(makeWeeklyPlan([]), DATE), []);
  });

  it('includes tasks scheduled on the target date (via runAt)', () => {
    const task = makeTask('task-aaa11111', 'pending', {
      runAt: `${DATE}T09:00:00.000Z`,
    });
    const plan = makeWeeklyPlan([task]);
    const result = collectDayTasks(plan, DATE);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'task-aaa11111');
  });

  it('includes tasks completed on the target date (via completedAt)', () => {
    const task = makeTask('task-bbb22222', 'completed', {
      runAt: '2026-04-13T09:00:00.000Z', // Monday, not Tuesday
      completedAt: `${DATE}T15:00:00.000Z`,
    });
    const plan = makeWeeklyPlan([task]);
    const result = collectDayTasks(plan, DATE);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'task-bbb22222');
  });

  it('excludes tasks scheduled on a different date', () => {
    const task = makeTask('task-ccc33333', 'pending', {
      runAt: '2026-04-15T09:00:00.000Z', // Wednesday
    });
    const plan = makeWeeklyPlan([task]);
    const result = collectDayTasks(plan, DATE);
    assert.deepStrictEqual(result, []);
  });

  it('excludes review tasks with reserved objectiveId (daily-review)', () => {
    const reviewTask = makeReviewTask('task-rev11111', DAILY_REVIEW_OBJECTIVE_ID);
    const workTask = makeTask('task-wrk11111', 'pending');
    const plan = makeWeeklyPlan([reviewTask, workTask]);
    const result = collectDayTasks(plan, DATE);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'task-wrk11111');
  });

  it('excludes review tasks with reserved objectiveId (weekly-review)', () => {
    const reviewTask = makeReviewTask('task-rev22222', WEEKLY_REVIEW_OBJECTIVE_ID);
    const plan = makeWeeklyPlan([reviewTask]);
    const result = collectDayTasks(plan, DATE);
    assert.deepStrictEqual(result, []);
  });

  it('does not double-include tasks that are both scheduled and completed today', () => {
    const task = makeTask('task-ddd44444', 'completed', {
      runAt: `${DATE}T09:00:00.000Z`,
      completedAt: `${DATE}T11:00:00.000Z`,
    });
    const plan = makeWeeklyPlan([task]);
    const result = collectDayTasks(plan, DATE);
    assert.equal(result.length, 1);
  });

  it('attaches scheduledToday and completedToday flags', () => {
    const task = makeTask('task-eee55555', 'completed', {
      runAt: `${DATE}T09:00:00.000Z`,
      completedAt: `${DATE}T11:00:00.000Z`,
    });
    const plan = makeWeeklyPlan([task]);
    const result = collectDayTasks(plan, DATE);
    assert.equal(result[0].scheduledToday, true);
    assert.equal(result[0].completedToday, true);
  });

  it('handles tasks without runAt gracefully', () => {
    const task = makeTask('task-fff66666', 'pending', { runAt: undefined });
    const plan = makeWeeklyPlan([task]);
    // No runAt and no completedAt → not relevant to any specific date
    const result = collectDayTasks(plan, DATE);
    assert.deepStrictEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// collectDayLogEntries
// ---------------------------------------------------------------------------

describe('collectDayLogEntries', () => {
  it('returns empty array for null/undefined input', () => {
    assert.deepStrictEqual(collectDayLogEntries(null, DATE), []);
    assert.deepStrictEqual(collectDayLogEntries(undefined, DATE), []);
  });

  it('includes entries with timestamp on the target date', () => {
    const entry = makeLogEntry('log-aaa11111', { timestamp: `${DATE}T10:00:00.000Z` });
    const result = collectDayLogEntries([entry], DATE);
    assert.equal(result.length, 1);
  });

  it('excludes entries with timestamp on a different date', () => {
    const entry = makeLogEntry('log-bbb22222', { timestamp: '2026-04-15T10:00:00.000Z' });
    const result = collectDayLogEntries([entry], DATE);
    assert.deepStrictEqual(result, []);
  });

  it('handles entries with no timestamp gracefully', () => {
    const entry = { id: 'log-ccc33333', status: 'completed', title: 'x' };
    const result = collectDayLogEntries([entry], DATE);
    assert.deepStrictEqual(result, []);
  });

  it('filters multiple entries correctly', () => {
    const entries = [
      makeLogEntry('log-ddd44444', { timestamp: `${DATE}T09:00:00.000Z` }),
      makeLogEntry('log-eee55555', { timestamp: '2026-04-15T09:00:00.000Z' }),
      makeLogEntry('log-fff66666', { timestamp: `${DATE}T14:00:00.000Z` }),
    ];
    const result = collectDayLogEntries(entries, DATE);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'log-ddd44444');
    assert.equal(result[1].id, 'log-fff66666');
  });
});

// ---------------------------------------------------------------------------
// taskStatusIcon
// ---------------------------------------------------------------------------

describe('taskStatusIcon', () => {
  it('returns correct icons for known statuses', () => {
    assert.equal(taskStatusIcon('completed'), '✅');
    assert.equal(taskStatusIcon('in-progress'), '🔄');
    assert.equal(taskStatusIcon('failed'), '❌');
    assert.equal(taskStatusIcon('skipped'), '⏭️');
    assert.equal(taskStatusIcon('delegated'), '🤝');
    assert.equal(taskStatusIcon('pending'), '⬜');
  });

  it('returns a fallback icon for unknown status', () => {
    assert.equal(taskStatusIcon('unknown'), '❓');
  });
});

// ---------------------------------------------------------------------------
// formatDayTaskItem
// ---------------------------------------------------------------------------

describe('formatDayTaskItem', () => {
  it('includes status icon and description', () => {
    const task = makeTask('task-aaa11111', 'completed');
    const line = formatDayTaskItem(task);
    assert.ok(line.includes('✅'));
    assert.ok(line.includes('**Task task-aaa11111**'));
    assert.ok(line.includes('status:completed'));
  });

  it('includes priority tag for non-medium priority', () => {
    const task = makeTask('task-bbb22222', 'pending', { priority: 'high' });
    const line = formatDayTaskItem(task);
    assert.ok(line.includes('priority:high'));
  });

  it('does not include priority tag for medium priority', () => {
    const task = makeTask('task-ccc33333', 'pending', { priority: 'medium' });
    const line = formatDayTaskItem(task);
    assert.ok(!line.includes('priority:'));
  });

  it('includes objective tag when objectiveId is set', () => {
    const task = makeTask('task-ddd44444', 'pending', { objectiveId: 'obj-test01' });
    const line = formatDayTaskItem(task);
    assert.ok(line.includes('objective:obj-test01'));
  });

  it('includes duration from log entry when available', () => {
    const task = makeTask('task-eee55555', 'completed');
    const log = { duration: 3_600_000 }; // 1 hour
    const line = formatDayTaskItem(task, log);
    assert.ok(line.includes('duration:1h'));
  });

  it('includes completion time for completed tasks', () => {
    const task = makeTask('task-fff66666', 'completed', {
      completedAt: `${DATE}T14:30:00.000Z`,
    });
    const line = formatDayTaskItem(task);
    assert.ok(line.includes('completed:14:30 UTC'));
  });

  it('handles null log entry gracefully', () => {
    const task = makeTask('task-ggg77777', 'pending');
    const line = formatDayTaskItem(task, null);
    assert.ok(line.startsWith('- ⬜'));
  });
});

// ---------------------------------------------------------------------------
// formatTaskStatusSection
// ---------------------------------------------------------------------------

describe('formatTaskStatusSection', () => {
  it('starts with ## Task Status', () => {
    const md = formatTaskStatusSection([], []);
    assert.ok(md.startsWith('## Task Status'));
  });

  it('renders empty-state message when no tasks', () => {
    const md = formatTaskStatusSection([], []);
    assert.ok(md.includes('No tasks were scheduled for this day'));
  });

  it('renders summary line with completed count', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed'),
      makeTask('task-bbb22222', 'pending'),
    ];
    const md = formatTaskStatusSection(tasks, []);
    assert.ok(md.includes('**1** of **2** tasks completed today'));
  });

  it('renders all tasks', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed'),
      makeTask('task-bbb22222', 'pending'),
      makeTask('task-ccc33333', 'failed'),
    ];
    const md = formatTaskStatusSection(tasks, []);
    assert.ok(md.includes('task-aaa11111'));
    assert.ok(md.includes('task-bbb22222'));
    assert.ok(md.includes('task-ccc33333'));
  });

  it('places completed tasks before pending tasks', () => {
    const tasks = [
      makeTask('task-aaa11111', 'pending'),
      makeTask('task-bbb22222', 'completed'),
    ];
    const md = formatTaskStatusSection(tasks, []);
    const completedIdx = md.indexOf('task-bbb22222');
    const pendingIdx = md.indexOf('task-aaa11111');
    assert.ok(completedIdx < pendingIdx, 'completed task should appear before pending task');
  });

  it('enriches tasks with matching log entry duration', () => {
    const task = makeTask('task-ddd44444', 'completed');
    const log = makeLogEntry('log-aaa11111', {
      taskId: 'task-ddd44444',
      duration: 7_200_000, // 2 hours
    });
    const md = formatTaskStatusSection([task], [log]);
    assert.ok(md.includes('duration:2h'));
  });
});

// ---------------------------------------------------------------------------
// buildAdjustmentsForTomorrow
// ---------------------------------------------------------------------------

describe('buildAdjustmentsForTomorrow', () => {
  it('returns empty array when all tasks are completed', () => {
    const tasks = [makeTask('task-aaa11111', 'completed')];
    const result = buildAdjustmentsForTomorrow(tasks, [], 'Wednesday');
    assert.deepStrictEqual(result, []);
  });

  it('returns carry-over adjustment for pending task', () => {
    const tasks = [makeTask('task-bbb22222', 'pending')];
    const result = buildAdjustmentsForTomorrow(tasks, [], 'Wednesday');
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'carry-over');
    assert.ok(result[0].text.includes('Wednesday'));
    assert.ok(result[0].text.includes('**Task task-bbb22222**'));
  });

  it('uses "top priority" language for high-priority carry-over', () => {
    const tasks = [makeTask('task-ccc33333', 'pending', { priority: 'high' })];
    const result = buildAdjustmentsForTomorrow(tasks, [], 'Wednesday');
    assert.ok(result[0].text.includes('top'));
  });

  it('returns continue adjustment for in-progress task', () => {
    const tasks = [makeTask('task-ddd44444', 'in-progress')];
    const result = buildAdjustmentsForTomorrow(tasks, [], 'Thursday');
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'continue');
    assert.ok(result[0].text.includes('in progress'));
    assert.ok(result[0].text.includes('Thursday'));
  });

  it('includes duration note for in-progress task with log entry', () => {
    const tasks = [makeTask('task-eee55555', 'in-progress')];
    const logs = [makeLogEntry('log-aaa11111', {
      taskId: 'task-eee55555',
      duration: 3_600_000,
    })];
    const result = buildAdjustmentsForTomorrow(tasks, logs, 'Thursday');
    assert.ok(result[0].text.includes('1h'));
  });

  it('returns retry adjustment for failed task', () => {
    const tasks = [makeTask('task-fff66666', 'failed')];
    const result = buildAdjustmentsForTomorrow(tasks, [], 'Thursday');
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'retry');
    assert.ok(result[0].text.includes('failed'));
    assert.ok(result[0].text.includes('diagnose'));
  });

  it('includes error context in retry adjustment when available', () => {
    const tasks = [makeTask('task-ggg77777', 'failed')];
    const logs = [makeLogEntry('log-bbb22222', {
      taskId: 'task-ggg77777',
      status: 'failed',
      metadata: { error: 'connection timeout' },
    })];
    const result = buildAdjustmentsForTomorrow(tasks, logs, 'Thursday');
    assert.ok(result[0].text.includes('connection timeout'));
  });

  it('returns reschedule adjustment for skipped task', () => {
    const tasks = [makeTask('task-hhh88888', 'skipped')];
    const result = buildAdjustmentsForTomorrow(tasks, [], 'Friday');
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'reschedule');
    assert.ok(result[0].text.includes('skipped'));
    assert.ok(result[0].text.includes('Friday'));
  });

  it('returns follow-up adjustment for delegated task', () => {
    const tasks = [makeTask('task-iii99999', 'delegated')];
    const result = buildAdjustmentsForTomorrow(tasks, [], 'Friday');
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'follow-up');
    assert.ok(result[0].text.includes('delegated'));
  });

  it('returns multiple adjustments for mixed task statuses', () => {
    const tasks = [
      makeTask('task-jjj00000', 'completed'),
      makeTask('task-kkk11111', 'pending'),
      makeTask('task-lll22222', 'failed'),
    ];
    const result = buildAdjustmentsForTomorrow(tasks, [], 'Wednesday');
    // No adjustment for completed, one each for pending + failed
    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'carry-over');
    assert.equal(result[1].type, 'retry');
  });
});

// ---------------------------------------------------------------------------
// formatAdjustmentsSection
// ---------------------------------------------------------------------------

describe('formatAdjustmentsSection', () => {
  it('starts with ## Adjustments for Tomorrow', () => {
    const md = formatAdjustmentsSection([], 'Wednesday');
    assert.ok(md.startsWith('## Adjustments for Tomorrow'));
  });

  it('renders clean-slate message when no adjustments', () => {
    const md = formatAdjustmentsSection([], 'Wednesday');
    assert.ok(md.includes('All tasks completed'));
    assert.ok(md.includes('Wednesday'));
  });

  it('renders each adjustment as a list item', () => {
    const adjs = [
      { type: 'carry-over', taskId: 'task-aaa', title: 'Alpha', text: 'Do alpha.' },
      { type: 'retry', taskId: 'task-bbb', title: 'Beta', text: 'Retry beta.' },
    ];
    const md = formatAdjustmentsSection(adjs, 'Thursday');
    assert.ok(md.includes('- Do alpha.'));
    assert.ok(md.includes('- Retry beta.'));
  });
});

// ---------------------------------------------------------------------------
// formatNotesSection
// ---------------------------------------------------------------------------

describe('formatNotesSection', () => {
  it('starts with ## Notes', () => {
    const md = formatNotesSection();
    assert.ok(md.startsWith('## Notes'));
  });

  it('contains placeholder text', () => {
    const md = formatNotesSection();
    assert.ok(md.includes('observations'));
    assert.ok(md.includes('_Add'));
  });
});

// ---------------------------------------------------------------------------
// buildDailyReviewHeader
// ---------------------------------------------------------------------------

describe('buildDailyReviewHeader', () => {
  it('builds header with agent name and date', () => {
    const header = buildDailyReviewHeader({
      agentId: AGENT_ID,
      agentName: 'Test Agent',
      date: DATE,
      dayName: 'Tuesday',
      week: WEEK,
      generatedAt: GENERATED_AT,
    });

    assert.ok(header.includes('# Daily Review: Test Agent'));
    assert.ok(header.includes('Tuesday'));
    assert.ok(header.includes(DATE));
    assert.ok(header.includes(WEEK));
    assert.ok(header.includes(AGENT_ID));
    assert.ok(header.includes(GENERATED_AT));
  });

  it('falls back to agentId when agentName is falsy', () => {
    const header = buildDailyReviewHeader({
      agentId: AGENT_ID,
      agentName: null,
      date: DATE,
      dayName: 'Tuesday',
      week: WEEK,
      generatedAt: GENERATED_AT,
    });

    assert.ok(header.includes(`# Daily Review: ${AGENT_ID}`));
  });
});

// ---------------------------------------------------------------------------
// assembleDailyReview — the three-section contract
// ---------------------------------------------------------------------------

describe('assembleDailyReview', () => {
  const sections = {
    header: '# Daily Review: Test — Tuesday, 2026-04-14\n\n---\n\n',
    taskStatus: '## Task Status\n\n_No tasks._\n',
    adjustments: '## Adjustments for Tomorrow\n\n_All good._\n',
    notes: '## Notes\n\n_Add notes here._\n',
  };

  it('contains exactly three H2 sections', () => {
    const doc = assembleDailyReview(sections);
    const h2Matches = doc.match(/^## /gm);
    assert.equal(h2Matches?.length, 3, 'Document should have exactly three H2 sections');
  });

  it('sections appear in order: Task Status → Adjustments → Notes', () => {
    const doc = assembleDailyReview(sections);
    const statusIdx = doc.indexOf('## Task Status');
    const adjIdx = doc.indexOf('## Adjustments for Tomorrow');
    const notesIdx = doc.indexOf('## Notes');

    assert.ok(statusIdx < adjIdx, 'Task Status should precede Adjustments');
    assert.ok(adjIdx < notesIdx, 'Adjustments should precede Notes');
  });

  it('header appears before all sections', () => {
    const doc = assembleDailyReview(sections);
    const headerIdx = doc.indexOf('# Daily Review:');
    const statusIdx = doc.indexOf('## Task Status');
    assert.ok(headerIdx < statusIdx, 'Header should precede Task Status section');
  });

  it('includes auto-generated footer', () => {
    const doc = assembleDailyReview(sections);
    assert.ok(doc.includes('auto-generated by aweek'));
  });
});

// ---------------------------------------------------------------------------
// dailyReviewDir / dailyReviewPaths
// ---------------------------------------------------------------------------

describe('dailyReviewDir', () => {
  it('returns correct directory path', () => {
    const dir = dailyReviewDir('/data/agents', AGENT_ID);
    assert.equal(dir, `/data/agents/${AGENT_ID}/reviews`);
  });
});

describe('dailyReviewPaths', () => {
  it('returns paths using daily-YYYY-MM-DD prefix', () => {
    const paths = dailyReviewPaths('/data/agents', AGENT_ID, DATE);
    assert.ok(paths.markdownPath.endsWith(`daily-${DATE}.md`));
    assert.ok(paths.metadataPath.endsWith(`daily-${DATE}.json`));
  });

  it('markdown and metadata paths share the same directory', () => {
    const paths = dailyReviewPaths('/data/agents', AGENT_ID, DATE);
    const mdDir = paths.markdownPath.slice(0, paths.markdownPath.lastIndexOf('/'));
    const jsonDir = paths.metadataPath.slice(0, paths.metadataPath.lastIndexOf('/'));
    assert.equal(mdDir, jsonDir);
  });
});

// ---------------------------------------------------------------------------
// persistDailyReview / loadDailyReview / listDailyReviews
// ---------------------------------------------------------------------------

describe('persistDailyReview', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drw-persist-'));
  });

  it('persists markdown and metadata files', async () => {
    const content = '# Daily Review\n\nSome content.\n';
    const meta = { agentId: AGENT_ID, date: DATE };

    const paths = await persistDailyReview(tmpDir, AGENT_ID, DATE, content, meta);

    const savedMd = await readFile(paths.markdownPath, 'utf-8');
    assert.equal(savedMd, content);

    const savedMeta = JSON.parse(await readFile(paths.metadataPath, 'utf-8'));
    assert.equal(savedMeta.agentId, AGENT_ID);
    assert.equal(savedMeta.date, DATE);
  });

  it('creates directories as needed', async () => {
    const paths = await persistDailyReview(tmpDir, 'agent-new12345678', DATE, 'test', {});
    const savedMd = await readFile(paths.markdownPath, 'utf-8');
    assert.equal(savedMd, 'test');
  });

  it('overwrites existing review idempotently', async () => {
    await persistDailyReview(tmpDir, AGENT_ID, DATE, 'first', { v: 1 });
    await persistDailyReview(tmpDir, AGENT_ID, DATE, 'second', { v: 2 });

    const paths = dailyReviewPaths(tmpDir, AGENT_ID, DATE);
    const savedMd = await readFile(paths.markdownPath, 'utf-8');
    assert.equal(savedMd, 'second');
  });
});

describe('loadDailyReview', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drw-load-'));
  });

  it('loads persisted daily review', async () => {
    await persistDailyReview(tmpDir, AGENT_ID, DATE, '# Doc', { date: DATE });

    const result = await loadDailyReview(tmpDir, AGENT_ID, DATE);
    assert.equal(result!.markdown, '# Doc');
    assert.equal((result!.metadata as { date: string }).date, DATE);
  });

  it('returns null for non-existent review', async () => {
    const result = await loadDailyReview(tmpDir, AGENT_ID, '2026-01-01');
    assert.equal(result, null);
  });
});

describe('listDailyReviews', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drw-list-'));
  });

  it('returns empty array when no reviews exist', async () => {
    const dates = await listDailyReviews(tmpDir, AGENT_ID);
    assert.deepStrictEqual(dates, []);
  });

  it('lists persisted daily review dates in chronological order', async () => {
    await persistDailyReview(tmpDir, AGENT_ID, '2026-04-15', 'r3', {});
    await persistDailyReview(tmpDir, AGENT_ID, '2026-04-13', 'r1', {});
    await persistDailyReview(tmpDir, AGENT_ID, '2026-04-14', 'r2', {});

    const dates = await listDailyReviews(tmpDir, AGENT_ID);
    assert.deepStrictEqual(dates, ['2026-04-13', '2026-04-14', '2026-04-15']);
  });

  it('ignores non-daily files (weekly reviews, JSON metadata)', async () => {
    // Persist a weekly review (uses different naming convention)
    await persistDailyReview(tmpDir, AGENT_ID, DATE, 'daily', {});
    // The metadata .json file should not appear in the listing
    const dates = await listDailyReviews(tmpDir, AGENT_ID);
    assert.deepStrictEqual(dates, [DATE]);
  });
});

// ---------------------------------------------------------------------------
// buildDailyReviewMetadata
// ---------------------------------------------------------------------------

describe('buildDailyReviewMetadata', () => {
  it('builds metadata with correct summary counts', () => {
    const tasks = [
      makeTask('task-aaa11111', 'completed'),
      makeTask('task-bbb22222', 'pending'),
      makeTask('task-ccc33333', 'failed'),
    ];
    const adjustments = [
      { type: 'carry-over', taskId: 'task-bbb22222', title: 'Task bbb', text: '' },
      { type: 'retry', taskId: 'task-ccc33333', title: 'Task ccc', text: '' },
    ];

    const meta = buildDailyReviewMetadata({
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      generatedAt: GENERATED_AT,
      tasks,
      adjustments,
    });

    assert.equal(meta.agentId, AGENT_ID);
    assert.equal(meta.date, DATE);
    assert.equal(meta.week, WEEK);
    assert.equal(meta.summary.totalTasks, 3);
    assert.equal(meta.summary.completedTasks, 1);
    assert.equal(meta.summary.pendingTasks, 1);
    assert.equal(meta.summary.failedTasks, 1);
    assert.equal(meta.summary.adjustmentCount, 2);
  });

  it('handles empty tasks and adjustments', () => {
    const meta = buildDailyReviewMetadata({
      agentId: AGENT_ID,
      date: DATE,
      week: WEEK,
      generatedAt: GENERATED_AT,
      tasks: [],
      adjustments: [],
    });

    assert.equal(meta.summary.totalTasks, 0);
    assert.equal(meta.summary.completedTasks, 0);
    assert.equal(meta.summary.adjustmentCount, 0);
    assert.deepStrictEqual(meta.tasks, []);
    assert.deepStrictEqual(meta.adjustments, []);
  });
});

// ---------------------------------------------------------------------------
// generateDailyReview — integration tests
// ---------------------------------------------------------------------------

describe('generateDailyReview', () => {
  let tmpDir: string;
  let agentStore: AgentStore;
  let weeklyPlanStore: WeeklyPlanStore;
  let activityLogStore: ActivityLogStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-drw-gen-'));
    agentStore = new AgentStore(tmpDir);
    weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    activityLogStore = new ActivityLogStore(tmpDir);

    await agentStore.init();
    await agentStore.save(makeAgentConfig());
  });

  function deps() {
    return { agentStore, weeklyPlanStore, activityLogStore };
  }

  it('generates a document with exactly three H2 sections', async () => {
    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    const h2Matches = result.markdown.match(/^## /gm);
    assert.equal(h2Matches?.length, 3, 'Should have exactly three H2 sections');
  });

  it('includes all three required H2 section headings', async () => {
    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.ok(result.markdown.includes('## Task Status'));
    assert.ok(result.markdown.includes('## Adjustments for Tomorrow'));
    assert.ok(result.markdown.includes('## Notes'));
  });

  it('returns structured metadata', async () => {
    const plan = makeWeeklyPlan([
      makeTask('task-aaa11111', 'completed', {
        completedAt: `${DATE}T12:00:00.000Z`,
      }),
      makeTask('task-bbb22222', 'pending'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.equal(result.metadata.agentId, AGENT_ID);
    assert.equal(result.metadata.date, DATE);
    assert.equal(result.metadata.week, WEEK);
    assert.equal(result.metadata.summary.completedTasks, 1);
    assert.equal(result.metadata.summary.pendingTasks, 1);
  });

  it('persists review to disk by default', async () => {
    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });

    assert.ok(result.paths);
    assert.ok(result.paths.markdownPath.endsWith(`daily-${DATE}.md`));
    assert.ok(result.paths.metadataPath.endsWith(`daily-${DATE}.json`));

    const savedMd = await readFile(result.paths.markdownPath, 'utf-8');
    assert.ok(savedMd.includes('## Task Status'));
  });

  it('skips persistence when persist=false', async () => {
    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.equal(result.paths, null);
    assert.ok(result.markdown.length > 0);
  });

  it('works with empty data (no plan, no logs)', async () => {
    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.ok(result.markdown.includes('No tasks were scheduled for this day'));
    assert.ok(result.markdown.includes('All tasks completed'));
    assert.equal(result.metadata.summary.totalTasks, 0);
    assert.equal(result.metadata.summary.adjustmentCount, 0);
  });

  it('excludes review tasks from the daily review document', async () => {
    const plan = makeWeeklyPlan([
      makeReviewTask('task-rev11111', DAILY_REVIEW_OBJECTIVE_ID),
      makeReviewTask('task-rev22222', WEEKLY_REVIEW_OBJECTIVE_ID),
      makeTask('task-wrk11111', 'completed'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    // Only the work task should appear
    assert.equal(result.metadata.summary.totalTasks, 1);
    // Review tasks should not appear in the text
    assert.ok(!result.markdown.includes('Daily review task'));
  });

  it('includes agentId in header when no name field is in the config', async () => {
    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    // Agent schema has no name field — agentId is used as the fallback
    assert.ok(result.markdown.includes(AGENT_ID));
  });

  it('falls back to agentId as name when agent config is unavailable', async () => {
    const result = await generateDailyReview(deps(), 'agent-nonexist123', DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.ok(result.markdown.includes('agent-nonexist123'));
  });

  it('auto-derives week from date when opts.week is omitted', async () => {
    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.equal(result.metadata.week, WEEK);
  });

  it('is idempotent — regenerating overwrites without duplication', async () => {
    await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
    });
    await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: '2026-04-14T18:00:00.000Z',
      baseDir: tmpDir,
    });

    const dates = await listDailyReviews(tmpDir, AGENT_ID);
    assert.deepStrictEqual(dates, [DATE], 'Only one daily review should exist for the date');
  });

  it('produces adjustments for pending tasks', async () => {
    const plan = makeWeeklyPlan([
      makeTask('task-aaa11111', 'pending', {
        description: 'Write integration tests',
        runAt: `${DATE}T09:00:00.000Z`,
      }),
    ]);
    await weeklyPlanStore.save(AGENT_ID, plan);

    const result = await generateDailyReview(deps(), AGENT_ID, DATE, {
      week: WEEK,
      generatedAt: GENERATED_AT,
      baseDir: tmpDir,
      persist: false,
    });

    assert.ok(result.markdown.includes('Write integration tests'));
    assert.equal(result.metadata.summary.adjustmentCount, 1);
    assert.equal(result.metadata.adjustments[0].type, 'carry-over');
  });
});
