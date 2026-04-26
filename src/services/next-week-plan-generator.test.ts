/**
 * Tests for the next-week plan section generator.
 * Covers: collection from weekly plans, carry-over detection, inbox pending items,
 * merging with deduplication, formatting, and the orchestrator function.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  collectNextWeekPlannedTasks,
  collectCarryOverTasks,
  collectPendingInboxItems,
  mergeNextWeekItems,
  sourceLabel,
  formatNextWeekItem,
  formatNextWeekSection,
  generateNextWeekPlanSection,
} from './next-week-plan-generator.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { InboxStore } from '../storage/inbox-store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TaskOpts {
  priority?: string;
  estimatedMinutes?: number;
  completedAt?: string;
  delegatedTo?: string;
}

interface InboxOpts {
  type?: string;
  priority?: string;
  createdAt?: string;
  status?: string;
  context?: string;
  sourceTaskId?: string;
}

interface TestTask {
  id: string;
  title: string;
  prompt: string;
  objectiveId: string;
  status: string;
  priority: string;
  estimatedMinutes?: number;
  completedAt?: string;
  delegatedTo?: string;
}

interface TestPlan {
  week: string;
  month: string;
  tasks: TestTask[];
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TestInboxMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  taskDescription: string;
  priority: string;
  createdAt: string;
  status: string;
  context?: string;
  sourceTaskId?: string;
}

function makePlan(week: string, month: string, tasks: TestTask[], approved: boolean = true): TestPlan {
  return {
    week,
    month,
    tasks,
    approved,
    createdAt: '2026-04-13T10:00:00.000Z',
    updatedAt: '2026-04-13T10:00:00.000Z',
  };
}

function makeTask(id: string, description: string, objectiveId: string, status: string = 'pending', opts: TaskOpts = {}): TestTask {
  return {
    id,
    title: description,
    prompt: description,
    objectiveId,
    status,
    priority: opts.priority || 'medium',
    ...(opts.estimatedMinutes ? { estimatedMinutes: opts.estimatedMinutes } : {}),
    ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
    ...(opts.delegatedTo ? { delegatedTo: opts.delegatedTo } : {}),
  };
}

function makeInboxMessage(id: string, from: string, to: string, description: string, opts: InboxOpts = {}): TestInboxMessage {
  return {
    id,
    from,
    to,
    type: opts.type || 'task-delegation',
    taskDescription: description,
    priority: opts.priority || 'medium',
    createdAt: opts.createdAt || '2026-04-14T12:00:00.000Z',
    status: opts.status || 'pending',
    ...(opts.context ? { context: opts.context } : {}),
    ...(opts.sourceTaskId ? { sourceTaskId: opts.sourceTaskId } : {}),
  };
}

// ---------------------------------------------------------------------------
// collectNextWeekPlannedTasks
// ---------------------------------------------------------------------------

describe('collectNextWeekPlannedTasks', () => {
  it('returns empty array for null plan', () => {
    assert.deepStrictEqual(collectNextWeekPlannedTasks(null), []);
  });

  it('returns empty array for plan with no tasks array', () => {
    assert.deepStrictEqual(collectNextWeekPlannedTasks({}), []);
  });

  it('returns empty array for plan with empty tasks', () => {
    const plan = makePlan('2026-W17', '2026-04', []);
    assert.deepStrictEqual(collectNextWeekPlannedTasks(plan), []);
  });

  it('collects all tasks from next-week plan', () => {
    const tasks = [
      makeTask('task-abc', 'Build widget', 'obj-one'),
      makeTask('task-def', 'Write tests', 'obj-two', 'pending', { priority: 'high' }),
    ];
    const plan = makePlan('2026-W17', '2026-04', tasks);
    const result = collectNextWeekPlannedTasks(plan);

    assert.equal(result.length, 2);
    assert.equal(result[0].taskId, 'task-abc');
    assert.equal(result[0].description, 'Build widget');
    assert.equal(result[0].source, 'next-week-plan');
    assert.equal(result[1].priority, 'high');
  });

  it('includes all statuses from the plan', () => {
    const tasks = [
      makeTask('task-a', 'A', 'obj-a', 'pending'),
      makeTask('task-b', 'B', 'obj-b', 'completed'),
      makeTask('task-c', 'C', 'obj-c', 'in-progress'),
    ];
    const plan = makePlan('2026-W17', '2026-04', tasks);
    const result = collectNextWeekPlannedTasks(plan);

    assert.equal(result.length, 3);
    assert.equal(result[1].status, 'completed');
  });

  it('defaults priority to medium when missing', () => {
    const tasks = [{ id: 'task-xyz', title: 'No priority', prompt: 'No priority', objectiveId: 'obj-a', status: 'pending' }] as unknown as TestTask[];
    const plan = makePlan('2026-W17', '2026-04', tasks);
    const result = collectNextWeekPlannedTasks(plan);
    assert.equal(result[0]!.priority, 'medium');
  });
});

// ---------------------------------------------------------------------------
// collectCarryOverTasks
// ---------------------------------------------------------------------------

describe('collectCarryOverTasks', () => {
  it('returns empty array for null plan', () => {
    assert.deepStrictEqual(collectCarryOverTasks(null), []);
  });

  it('returns empty array for plan with no tasks', () => {
    assert.deepStrictEqual(collectCarryOverTasks({}), []);
  });

  it('includes pending tasks', () => {
    const tasks = [makeTask('task-a', 'Pending task', 'obj-a', 'pending')];
    const plan = makePlan('2026-W16', '2026-04', tasks);
    const result = collectCarryOverTasks(plan);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'carry-over');
    assert.equal(result[0].status, 'pending');
  });

  it('includes in-progress tasks', () => {
    const tasks = [makeTask('task-b', 'In progress task', 'obj-a', 'in-progress')];
    const plan = makePlan('2026-W16', '2026-04', tasks);
    const result = collectCarryOverTasks(plan);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'in-progress');
  });

  it('includes failed tasks', () => {
    const tasks = [makeTask('task-c', 'Failed task', 'obj-a', 'failed')];
    const plan = makePlan('2026-W16', '2026-04', tasks);
    const result = collectCarryOverTasks(plan);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'failed');
  });

  it('excludes completed tasks', () => {
    const tasks = [
      makeTask('task-a', 'Done', 'obj-a', 'completed'),
      makeTask('task-b', 'Not done', 'obj-a', 'pending'),
    ];
    const plan = makePlan('2026-W16', '2026-04', tasks);
    const result = collectCarryOverTasks(plan);
    assert.equal(result.length, 1);
    assert.equal(result[0].taskId, 'task-b');
  });

  it('excludes skipped and delegated tasks', () => {
    const tasks = [
      makeTask('task-a', 'Skipped', 'obj-a', 'skipped'),
      makeTask('task-b', 'Delegated', 'obj-a', 'delegated'),
    ];
    const plan = makePlan('2026-W16', '2026-04', tasks);
    const result = collectCarryOverTasks(plan);
    assert.equal(result.length, 0);
  });

  it('preserves estimatedMinutes', () => {
    const tasks = [makeTask('task-a', 'With estimate', 'obj-a', 'pending', { estimatedMinutes: 60 })];
    const plan = makePlan('2026-W16', '2026-04', tasks);
    const result = collectCarryOverTasks(plan);
    assert.equal(result[0].estimatedMinutes, 60);
  });
});

// ---------------------------------------------------------------------------
// collectPendingInboxItems
// ---------------------------------------------------------------------------

describe('collectPendingInboxItems', () => {
  it('returns empty array for null input', () => {
    assert.deepStrictEqual(collectPendingInboxItems(null), []);
  });

  it('returns empty array for non-array input', () => {
    assert.deepStrictEqual(collectPendingInboxItems('not-array'), []);
  });

  it('returns empty array for empty array', () => {
    assert.deepStrictEqual(collectPendingInboxItems([]), []);
  });

  it('converts inbox messages to task items', () => {
    const msgs = [
      makeInboxMessage('msg-abc', 'agent-alice', 'agent-bob', 'Review PR #42', {
        priority: 'high',
        context: 'Needs urgent review',
      }),
    ];
    const result = collectPendingInboxItems(msgs);
    assert.equal(result.length, 1);
    assert.equal(result[0].messageId, 'msg-abc');
    assert.equal(result[0].from, 'agent-alice');
    assert.equal(result[0].description, 'Review PR #42');
    assert.equal(result[0].priority, 'high');
    assert.equal(result[0].context, 'Needs urgent review');
    assert.equal(result[0].source, 'inbox');
  });

  it('handles messages without optional fields', () => {
    const msgs = [
      makeInboxMessage('msg-def', 'agent-x', 'agent-y', 'Simple task'),
    ];
    const result = collectPendingInboxItems(msgs);
    assert.equal(result[0].context, null);
    assert.equal(result[0].sourceTaskId, null);
  });

  it('preserves sourceTaskId for traceability', () => {
    const msgs = [
      makeInboxMessage('msg-ghi', 'agent-a', 'agent-b', 'Delegated work', {
        sourceTaskId: 'task-original',
      }),
    ];
    const result = collectPendingInboxItems(msgs);
    assert.equal(result[0].sourceTaskId, 'task-original');
  });
});

// ---------------------------------------------------------------------------
// mergeNextWeekItems
// ---------------------------------------------------------------------------

describe('mergeNextWeekItems', () => {
  it('returns empty array when all sources are empty', () => {
    assert.deepStrictEqual(mergeNextWeekItems([], [], []), []);
  });

  it('includes all planned tasks', () => {
    const planned = [
      { description: 'A', priority: 'medium', source: 'next-week-plan' },
      { description: 'B', priority: 'high', source: 'next-week-plan' },
    ];
    const result = mergeNextWeekItems(planned, [], []);
    assert.equal(result.length, 2);
  });

  it('includes carry-over tasks not in plan', () => {
    const planned = [{ description: 'A', priority: 'medium', source: 'next-week-plan' }];
    const carryOver = [
      { description: 'B', priority: 'high', source: 'carry-over' },
    ];
    const result = mergeNextWeekItems(planned, carryOver, []);
    assert.equal(result.length, 2);
  });

  it('deduplicates carry-over tasks already in plan (by description)', () => {
    const planned = [{ description: 'Same task', priority: 'medium', source: 'next-week-plan' }];
    const carryOver = [{ description: 'Same task', priority: 'high', source: 'carry-over' }];
    const result = mergeNextWeekItems(planned, carryOver, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'next-week-plan');
  });

  it('includes all inbox items', () => {
    const inbox = [
      { description: 'From alice', priority: 'high', source: 'inbox' },
      { description: 'From bob', priority: 'low', source: 'inbox' },
    ];
    const result = mergeNextWeekItems([], [], inbox);
    assert.equal(result.length, 2);
  });

  it('sorts by priority (critical first)', () => {
    const planned = [{ description: 'Low', priority: 'low', source: 'next-week-plan' }];
    const carryOver = [{ description: 'Critical', priority: 'critical', source: 'carry-over' }];
    const inbox = [{ description: 'High', priority: 'high', source: 'inbox' }];
    const result = mergeNextWeekItems(planned, carryOver, inbox);

    assert.equal(result[0].priority, 'critical');
    assert.equal(result[1].priority, 'high');
    assert.equal(result[2].priority, 'low');
  });

  it('merges all three sources together', () => {
    const planned = [{ description: 'P1', priority: 'medium', source: 'next-week-plan' }];
    const carryOver = [{ description: 'C1', priority: 'medium', source: 'carry-over' }];
    const inbox = [{ description: 'I1', priority: 'medium', source: 'inbox' }];
    const result = mergeNextWeekItems(planned, carryOver, inbox);
    assert.equal(result.length, 3);

    const sources = result.map((r) => r.source);
    assert.ok(sources.includes('next-week-plan'));
    assert.ok(sources.includes('carry-over'));
    assert.ok(sources.includes('inbox'));
  });
});

// ---------------------------------------------------------------------------
// sourceLabel
// ---------------------------------------------------------------------------

describe('sourceLabel', () => {
  it('returns correct labels', () => {
    assert.equal(sourceLabel('next-week-plan'), '📋 Planned');
    assert.equal(sourceLabel('carry-over'), '🔄 Carry-over');
    assert.equal(sourceLabel('inbox'), '📨 Delegated');
  });

  it('returns raw source for unknown values', () => {
    assert.equal(sourceLabel('unknown'), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// formatNextWeekItem
// ---------------------------------------------------------------------------

describe('formatNextWeekItem', () => {
  it('formats a basic planned task', () => {
    const item = { description: 'Build API', priority: 'medium', source: 'next-week-plan' };
    const line = formatNextWeekItem(item);
    assert.ok(line.startsWith('- [ ] Build API'));
    assert.ok(line.includes('📋 Planned'));
  });

  it('includes priority tag for non-medium priority', () => {
    const item = { description: 'Urgent fix', priority: 'critical', source: 'next-week-plan' };
    const line = formatNextWeekItem(item);
    assert.ok(line.includes('priority:critical'));
  });

  it('omits priority tag for medium priority', () => {
    const item = { description: 'Normal task', priority: 'medium', source: 'next-week-plan' };
    const line = formatNextWeekItem(item);
    assert.ok(!line.includes('priority:medium'));
  });

  it('includes objective reference', () => {
    const item = { description: 'Task', priority: 'medium', source: 'next-week-plan', objectiveId: 'obj-abc' };
    const line = formatNextWeekItem(item);
    assert.ok(line.includes('objective:obj-abc'));
  });

  it('includes from agent for inbox items', () => {
    const item = { description: 'Delegated work', priority: 'medium', source: 'inbox', from: 'agent-alice' };
    const line = formatNextWeekItem(item);
    assert.ok(line.includes('from:agent-alice'));
  });

  it('includes was-status for carry-over items', () => {
    const item = { description: 'Leftover', priority: 'medium', source: 'carry-over', status: 'failed' };
    const line = formatNextWeekItem(item);
    assert.ok(line.includes('was:failed'));
  });

  it('includes estimated minutes', () => {
    const item = { description: 'Task', priority: 'medium', source: 'next-week-plan', estimatedMinutes: 30 };
    const line = formatNextWeekItem(item);
    assert.ok(line.includes('est:30m'));
  });

  it('respects includeSource=false', () => {
    const item = { description: 'Task', priority: 'medium', source: 'next-week-plan' };
    const line = formatNextWeekItem(item, { includeSource: false });
    assert.ok(!line.includes('Planned'));
  });

  it('respects includeObjective=false', () => {
    const item = { description: 'Task', priority: 'medium', source: 'next-week-plan', objectiveId: 'obj-x' };
    const line = formatNextWeekItem(item, { includeObjective: false });
    assert.ok(!line.includes('objective:'));
  });

  it('respects includeFrom=false', () => {
    const item = { description: 'Task', priority: 'medium', source: 'inbox', from: 'agent-x' };
    const line = formatNextWeekItem(item, { includeFrom: false });
    assert.ok(!line.includes('from:'));
  });
});

// ---------------------------------------------------------------------------
// formatNextWeekSection
// ---------------------------------------------------------------------------

describe('formatNextWeekSection', () => {
  it('shows empty message when no items', () => {
    const md = formatNextWeekSection([]);
    assert.ok(md.includes('## Next Week'));
    assert.ok(md.includes('No tasks planned for next week yet.'));
  });

  it('includes summary line with counts', () => {
    const items = [
      { description: 'A', priority: 'medium', source: 'next-week-plan' },
      { description: 'B', priority: 'medium', source: 'carry-over' },
      { description: 'C', priority: 'medium', source: 'inbox' },
    ];
    const md = formatNextWeekSection(items);
    assert.ok(md.includes('**3** items for next week'));
    assert.ok(md.includes('1 planned'));
    assert.ok(md.includes('1 carry-over'));
    assert.ok(md.includes('1 from inbox'));
  });

  it('groups by source with correct headers', () => {
    const items = [
      { description: 'Planned task', priority: 'medium', source: 'next-week-plan' },
      { description: 'Carry-over task', priority: 'medium', source: 'carry-over', status: 'pending' },
      { description: 'Inbox task', priority: 'medium', source: 'inbox', from: 'agent-x' },
    ];
    const md = formatNextWeekSection(items);
    assert.ok(md.includes('### 📋 Planned Tasks'));
    assert.ok(md.includes('### 🔄 Carry-over from This Week'));
    assert.ok(md.includes('### 📨 Pending Inbox (Delegated)'));
  });

  it('renders flat list when groupBySource=false', () => {
    const items = [
      { description: 'A', priority: 'medium', source: 'next-week-plan' },
      { description: 'B', priority: 'medium', source: 'carry-over', status: 'pending' },
    ];
    const md = formatNextWeekSection(items, { groupBySource: false });
    assert.ok(!md.includes('### '));
    assert.ok(md.includes('- [ ] A'));
    assert.ok(md.includes('- [ ] B'));
  });

  it('omits summary when includeSummary=false', () => {
    const items = [{ description: 'X', priority: 'medium', source: 'next-week-plan' }];
    const md = formatNextWeekSection(items, { includeSummary: false });
    assert.ok(!md.includes('items for next week'));
  });

  it('skips empty source groups', () => {
    const items = [
      { description: 'Only planned', priority: 'medium', source: 'next-week-plan' },
    ];
    const md = formatNextWeekSection(items);
    assert.ok(md.includes('### 📋 Planned Tasks'));
    assert.ok(!md.includes('Carry-over'));
    assert.ok(!md.includes('Inbox'));
  });

  it('handles singular item count', () => {
    const items = [{ description: 'Solo', priority: 'medium', source: 'next-week-plan' }];
    const md = formatNextWeekSection(items);
    assert.ok(md.includes('**1** item for next week'));
  });
});

// ---------------------------------------------------------------------------
// generateNextWeekPlanSection (orchestrator with real stores)
// ---------------------------------------------------------------------------

describe('generateNextWeekPlanSection', () => {
  let baseDir: string;
  let weeklyPlanStore: WeeklyPlanStore;
  let inboxStore: InboxStore;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `aweek-next-week-test-${randomUUID()}`);
    await mkdir(baseDir, { recursive: true });
    weeklyPlanStore = new WeeklyPlanStore(baseDir);
    inboxStore = new InboxStore(baseDir);
  });

  const AGENT_ID = 'agent-tester';

  it('returns empty section when no data exists', async () => {
    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      AGENT_ID,
      '2026-W16',
      '2026-W17'
    );
    assert.equal(result.items.length, 0);
    assert.ok(result.markdown.includes('No tasks planned'));
    assert.deepStrictEqual(result.counts, { planned: 0, carryOver: 0, inbox: 0 });
  });

  it('collects tasks from next-week plan', async () => {
    const nextPlan = makePlan('2026-W17', '2026-04', [
      makeTask('task-aaa', 'Next week task', 'obj-one'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, nextPlan);

    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      AGENT_ID,
      '2026-W16',
      '2026-W17'
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].source, 'next-week-plan');
    assert.equal(result.counts.planned, 1);
  });

  it('collects carry-over tasks from current week', async () => {
    const currentPlan = makePlan('2026-W16', '2026-04', [
      makeTask('task-bbb', 'Incomplete task', 'obj-one', 'pending'),
      makeTask('task-ccc', 'Done task', 'obj-one', 'completed'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, currentPlan);

    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      AGENT_ID,
      '2026-W16',
      '2026-W17'
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].source, 'carry-over');
    assert.equal(result.counts.carryOver, 1);
  });

  it('collects pending inbox messages', async () => {
    await inboxStore.init(AGENT_ID);
    await inboxStore.enqueue(AGENT_ID, makeInboxMessage(
      'msg-aaa', 'agent-alice', AGENT_ID, 'Please review this'
    ));

    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      AGENT_ID,
      '2026-W16',
      '2026-W17'
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].source, 'inbox');
    assert.equal(result.counts.inbox, 1);
  });

  it('merges all three sources', async () => {
    // Save next-week plan
    const nextPlan = makePlan('2026-W17', '2026-04', [
      makeTask('task-planned', 'Planned task', 'obj-one'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, nextPlan);

    // Save current-week plan with incomplete task
    const currentPlan = makePlan('2026-W16', '2026-04', [
      makeTask('task-leftover', 'Leftover task', 'obj-two', 'in-progress'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, currentPlan);

    // Add pending inbox message
    await inboxStore.init(AGENT_ID);
    await inboxStore.enqueue(AGENT_ID, makeInboxMessage(
      'msg-bbb', 'agent-bob', AGENT_ID, 'Delegated item', { priority: 'high' }
    ));

    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      AGENT_ID,
      '2026-W16',
      '2026-W17'
    );

    assert.equal(result.items.length, 3);
    assert.deepStrictEqual(result.counts, { planned: 1, carryOver: 1, inbox: 1 });

    const sources = result.items.map((i) => i.source);
    assert.ok(sources.includes('next-week-plan'));
    assert.ok(sources.includes('carry-over'));
    assert.ok(sources.includes('inbox'));
  });

  it('deduplicates carry-over tasks already in next-week plan', async () => {
    const nextPlan = makePlan('2026-W17', '2026-04', [
      makeTask('task-new-id', 'Same description', 'obj-one'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, nextPlan);

    const currentPlan = makePlan('2026-W16', '2026-04', [
      makeTask('task-old-id', 'Same description', 'obj-one', 'pending'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, currentPlan);

    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      AGENT_ID,
      '2026-W16',
      '2026-W17'
    );

    // Should not duplicate — carry-over excluded because description matches plan
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].source, 'next-week-plan');
    assert.equal(result.counts.carryOver, 0);
  });

  it('generates valid markdown output', async () => {
    const nextPlan = makePlan('2026-W17', '2026-04', [
      makeTask('task-ddd', 'Write docs', 'obj-one', 'pending', { priority: 'high' }),
    ]);
    await weeklyPlanStore.save(AGENT_ID, nextPlan);

    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      AGENT_ID,
      '2026-W16',
      '2026-W17'
    );

    assert.ok(result.markdown.includes('## Next Week'));
    assert.ok(result.markdown.includes('Write docs'));
    assert.ok(result.markdown.includes('priority:high'));
  });

  it('gracefully handles store errors', async () => {
    // Use a non-existent base dir that will cause load errors
    const badStore = new WeeklyPlanStore('/nonexistent/path');
    const badInbox = new InboxStore('/nonexistent/path');

    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore: badStore, inboxStore: badInbox },
      AGENT_ID,
      '2026-W16',
      '2026-W17'
    );

    // Should not throw, should return empty
    assert.equal(result.items.length, 0);
    assert.ok(result.markdown.includes('No tasks planned'));
  });

  it('passes formatting options through', async () => {
    const nextPlan = makePlan('2026-W17', '2026-04', [
      makeTask('task-eee', 'Task E', 'obj-one'),
    ]);
    await weeklyPlanStore.save(AGENT_ID, nextPlan);

    const result = await generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      AGENT_ID,
      '2026-W16',
      '2026-W17',
      { groupBySource: false, includeSummary: false }
    );

    assert.ok(!result.markdown.includes('###'));
    assert.ok(!result.markdown.includes('items for next week'));
  });
});
