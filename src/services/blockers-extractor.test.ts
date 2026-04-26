import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKER_CATEGORIES,
  classifyBlocker,
  extractBlockersFromPlan,
  extractBlockersFromActivityLog,
  mergeBlockers,
  categoryLabel,
  formatBlockerItem,
  formatBlockersSection,
  generateBlockersReview,
  type ActivityLogEntry,
  type BlockersDeps,
  type LogBlocker,
  type MergedBlocker,
  type PlanBlocker,
} from './blockers-extractor.js';

interface MockWeeklyPlanStore {
  load: ReturnType<typeof mock.fn> & BlockersDeps['weeklyPlanStore']['load'];
}
interface MockActivityLogStore {
  load: ReturnType<typeof mock.fn> & BlockersDeps['activityLogStore']['load'];
}

// ---------------------------------------------------------------------------
// classifyBlocker
// ---------------------------------------------------------------------------

describe('classifyBlocker', () => {
  it('classifies failed tasks', () => {
    assert.equal(classifyBlocker({ status: 'failed' }), 'failed');
  });

  it('classifies skipped tasks', () => {
    assert.equal(classifyBlocker({ status: 'skipped' }), 'skipped');
  });

  it('classifies in-progress tasks as stuck', () => {
    assert.equal(classifyBlocker({ status: 'in-progress' }), 'stuck');
  });

  it('classifies tasks with delegatedTo as dependency', () => {
    assert.equal(
      classifyBlocker({ status: 'pending', delegatedTo: 'agent-b' }),
      'dependency'
    );
  });

  it('classifies tasks with metadata.delegatedTo as dependency', () => {
    assert.equal(
      classifyBlocker({ status: 'pending', metadata: { delegatedTo: 'agent-b' } }),
      'dependency'
    );
  });

  it('defaults to failed for unknown status', () => {
    assert.equal(classifyBlocker({ status: 'unknown' }), 'failed');
  });
});

// ---------------------------------------------------------------------------
// BLOCKER_CATEGORIES
// ---------------------------------------------------------------------------

describe('BLOCKER_CATEGORIES', () => {
  it('contains all expected categories', () => {
    assert.deepEqual(BLOCKER_CATEGORIES, ['failed', 'stuck', 'skipped', 'dependency']);
  });
});

// ---------------------------------------------------------------------------
// extractBlockersFromPlan
// ---------------------------------------------------------------------------

describe('extractBlockersFromPlan', () => {
  it('returns empty array for null plan', () => {
    assert.deepEqual(extractBlockersFromPlan(null), []);
  });

  it('returns empty array for plan without tasks', () => {
    assert.deepEqual(extractBlockersFromPlan({ tasks: [] }), []);
  });

  it('returns empty array when all tasks are completed', () => {
    const plan = {
      tasks: [
        { id: 'task-a', title: 'Done', prompt: 'Done', objectiveId: 'obj-a', status: 'completed' },
        { id: 'task-b', title: 'Also done', prompt: 'Also done', objectiveId: 'obj-a', status: 'completed' },
      ],
    };
    assert.deepEqual(extractBlockersFromPlan(plan), []);
  });

  it('extracts failed tasks', () => {
    const plan = {
      tasks: [
        { id: 'task-a', title: 'Broken', prompt: 'Broken', objectiveId: 'obj-a', status: 'failed', priority: 'high' },
        { id: 'task-b', title: 'Done', prompt: 'Done', objectiveId: 'obj-a', status: 'completed' },
      ],
    };
    const result = extractBlockersFromPlan(plan);
    assert.equal(result.length, 1);
    assert.equal(result[0].taskId, 'task-a');
    assert.equal(result[0].category, 'failed');
    assert.equal(result[0].priority, 'high');
    assert.equal(result[0].source, 'weekly-plan');
  });

  it('extracts skipped tasks', () => {
    const plan = {
      tasks: [
        { id: 'task-a', title: 'Skipped one', prompt: 'Skipped one', objectiveId: 'obj-b', status: 'skipped' },
      ],
    };
    const result = extractBlockersFromPlan(plan);
    assert.equal(result.length, 1);
    assert.equal(result[0].category, 'skipped');
  });

  it('extracts in-progress (stuck) tasks', () => {
    const plan = {
      tasks: [
        { id: 'task-a', title: 'Stuck task', prompt: 'Stuck task', objectiveId: 'obj-a', status: 'in-progress' },
      ],
    };
    const result = extractBlockersFromPlan(plan);
    assert.equal(result.length, 1);
    assert.equal(result[0].category, 'stuck');
  });

  it('does not extract pending or delegated tasks', () => {
    const plan = {
      tasks: [
        { id: 'task-a', title: 'Pending', prompt: 'Pending', objectiveId: 'obj-a', status: 'pending' },
        { id: 'task-b', title: 'Delegated', prompt: 'Delegated', objectiveId: 'obj-a', status: 'delegated', delegatedTo: 'agent-b' },
      ],
    };
    assert.deepEqual(extractBlockersFromPlan(plan), []);
  });

  it('defaults priority to medium', () => {
    const plan = {
      tasks: [
        { id: 'task-a', title: 'No priority', prompt: 'No priority', objectiveId: 'obj-a', status: 'failed' },
      ],
    };
    const result = extractBlockersFromPlan(plan);
    assert.equal(result[0].priority, 'medium');
  });

  it('preserves delegatedTo from plan tasks', () => {
    const plan = {
      tasks: [
        {
          id: 'task-a',
          title: 'Stuck delegation', prompt: 'Stuck delegation',
          objectiveId: 'obj-a',
          status: 'in-progress',
          delegatedTo: 'agent-b',
        },
      ],
    };
    const result = extractBlockersFromPlan(plan);
    assert.equal(result[0].delegatedTo, 'agent-b');
  });
});

// ---------------------------------------------------------------------------
// extractBlockersFromActivityLog
// ---------------------------------------------------------------------------

describe('extractBlockersFromActivityLog', () => {
  it('returns empty array for null input', () => {
    assert.deepEqual(extractBlockersFromActivityLog(null), []);
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(extractBlockersFromActivityLog('not-an-array' as unknown as ActivityLogEntry[]), []);
  });

  it('returns empty array when no failed entries', () => {
    const entries = [
      { id: 'log-abc1', status: 'completed', title: 'OK', timestamp: '2026-04-13T10:00:00Z' },
    ];
    assert.deepEqual(extractBlockersFromActivityLog(entries), []);
  });

  it('extracts failed entries', () => {
    const entries = [
      {
        id: 'log-abc1',
        status: 'failed',
        description: 'Build failed',
        taskId: 'task-a',
        timestamp: '2026-04-13T10:00:00Z',
        duration: 5000,
        metadata: { error: 'Compilation error' },
      },
    ];
    const result = extractBlockersFromActivityLog(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].logId, 'log-abc1');
    assert.equal(result[0].taskId, 'task-a');
    assert.equal(result[0].errorMessage, 'Compilation error');
    assert.equal(result[0].durationMs, 5000);
    assert.equal(result[0].category, 'failed');
    assert.equal(result[0].source, 'activity-log');
  });

  it('extracts errorMessage from metadata.errorMessage', () => {
    const entries = [
      {
        id: 'log-abc2',
        status: 'failed',
        description: 'Deploy failed',
        timestamp: '2026-04-13T11:00:00Z',
        metadata: { errorMessage: 'Timeout exceeded' },
      },
    ];
    const result = extractBlockersFromActivityLog(entries);
    assert.equal(result[0].errorMessage, 'Timeout exceeded');
  });

  it('returns null errorMessage when no error in metadata', () => {
    const entries = [
      {
        id: 'log-abc3',
        status: 'failed',
        title: 'Unknown failure',
        timestamp: '2026-04-13T12:00:00Z',
      },
    ];
    const result = extractBlockersFromActivityLog(entries);
    assert.equal(result[0].errorMessage, null);
  });
});

// ---------------------------------------------------------------------------
// mergeBlockers
// ---------------------------------------------------------------------------

describe('mergeBlockers', () => {
  it('returns empty array when both inputs are empty', () => {
    assert.deepEqual(mergeBlockers([], []), []);
  });

  it('returns plan blockers when no log blockers', () => {
    const planBlockers: PlanBlocker[] = [
      {
        taskId: 'task-a',
        description: 'Failed task',
        objectiveId: 'obj-a',
        priority: 'high',
        status: 'failed',
        category: 'failed',
        delegatedTo: null,
        estimatedMinutes: 30,
        source: 'weekly-plan',
      },
    ];
    const result = mergeBlockers(planBlockers, []);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.source, 'weekly-plan');
  });

  it('returns log blockers when no plan blockers', () => {
    const logBlockers: LogBlocker[] = [
      {
        logId: 'log-abc1',
        taskId: 'task-x',
        description: 'Runtime error',
        timestamp: '2026-04-13T10:00:00Z',
        durationMs: 3000,
        metadata: null,
        errorMessage: 'OOM',
        category: 'failed',
        source: 'activity-log',
      },
    ];
    const result = mergeBlockers([], logBlockers);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.source, 'activity-log');
    assert.equal(result[0]!.errorMessage, 'OOM');
  });

  it('merges matching plan and log blockers', () => {
    const planBlockers: PlanBlocker[] = [
      {
        taskId: 'task-a',
        description: 'Build step',
        objectiveId: 'obj-a',
        priority: 'critical',
        status: 'failed',
        category: 'failed',
        delegatedTo: null,
        estimatedMinutes: 60,
        source: 'weekly-plan',
      },
    ];
    const logBlockers: LogBlocker[] = [
      {
        logId: 'log-abc1',
        taskId: 'task-a',
        description: 'Build step failed',
        timestamp: '2026-04-14T08:00:00Z',
        durationMs: 12000,
        metadata: { error: 'Exit code 1' },
        errorMessage: 'Exit code 1',
        category: 'failed',
        source: 'activity-log',
      },
    ];
    const result = mergeBlockers(planBlockers, logBlockers);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.source, 'merged');
    assert.equal(result[0]!.errorMessage, 'Exit code 1');
    assert.equal(result[0]!.priority, 'critical');
    assert.equal(result[0]!.durationMs, 12000);
    assert.equal(result[0]!.objectiveId, 'obj-a');
  });

  it('includes unmatched log blockers as standalone', () => {
    const planBlockers: PlanBlocker[] = [
      {
        taskId: 'task-a',
        description: 'Plan task',
        objectiveId: 'obj-a',
        priority: 'high',
        status: 'failed',
        category: 'failed',
        delegatedTo: null,
        estimatedMinutes: null,
        source: 'weekly-plan',
      },
    ];
    const logBlockers: LogBlocker[] = [
      {
        logId: 'log-abc1',
        taskId: 'task-a',
        description: 'Plan task fail',
        timestamp: '2026-04-13T10:00:00Z',
        durationMs: null,
        metadata: null,
        errorMessage: null,
        category: 'failed',
        source: 'activity-log',
      },
      {
        logId: 'log-abc2',
        taskId: 'task-z',
        description: 'Standalone fail',
        timestamp: '2026-04-13T11:00:00Z',
        durationMs: 1000,
        metadata: null,
        errorMessage: 'Crash',
        category: 'failed',
        source: 'activity-log',
      },
    ];
    const result = mergeBlockers(planBlockers, logBlockers);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.source, 'merged');
    assert.equal(result[1]!.source, 'activity-log');
    assert.equal(result[1]!.errorMessage, 'Crash');
  });

  it('sorts by category then priority', () => {
    const planBlockers: PlanBlocker[] = [
      {
        taskId: 'task-a', description: 'Skipped', objectiveId: 'obj-a',
        priority: 'high', status: 'skipped', category: 'skipped',
        delegatedTo: null, estimatedMinutes: null, source: 'weekly-plan',
      },
      {
        taskId: 'task-b', description: 'Failed critical', objectiveId: 'obj-a',
        priority: 'critical', status: 'failed', category: 'failed',
        delegatedTo: null, estimatedMinutes: null, source: 'weekly-plan',
      },
      {
        taskId: 'task-c', description: 'Failed low', objectiveId: 'obj-a',
        priority: 'low', status: 'failed', category: 'failed',
        delegatedTo: null, estimatedMinutes: null, source: 'weekly-plan',
      },
      {
        taskId: 'task-d', description: 'Stuck', objectiveId: 'obj-a',
        priority: 'medium', status: 'in-progress', category: 'stuck',
        delegatedTo: null, estimatedMinutes: null, source: 'weekly-plan',
      },
    ];
    const result = mergeBlockers(planBlockers, []);
    // failed-critical, failed-low, stuck-medium, skipped-high
    assert.equal(result[0]!.taskId, 'task-b'); // failed, critical
    assert.equal(result[1]!.taskId, 'task-c'); // failed, low
    assert.equal(result[2]!.taskId, 'task-d'); // stuck, medium
    assert.equal(result[3]!.taskId, 'task-a'); // skipped, high
  });

  it('does not duplicate log entries across multiple plan matches', () => {
    const planBlockers: PlanBlocker[] = [
      {
        taskId: 'task-a', description: 'A', objectiveId: 'obj-a',
        priority: 'high', status: 'failed', category: 'failed',
        delegatedTo: null, estimatedMinutes: null, source: 'weekly-plan',
      },
      {
        taskId: 'task-a', description: 'A dup', objectiveId: 'obj-a',
        priority: 'high', status: 'failed', category: 'failed',
        delegatedTo: null, estimatedMinutes: null, source: 'weekly-plan',
      },
    ];
    const logBlockers: LogBlocker[] = [
      {
        logId: 'log-abc1', taskId: 'task-a', description: 'A log',
        timestamp: '2026-04-13T10:00:00Z', durationMs: null,
        metadata: null, errorMessage: null, category: 'failed',
        source: 'activity-log',
      },
    ];
    const result = mergeBlockers(planBlockers, logBlockers);
    // Log entry should only be used once
    assert.equal(result.length, 2);
    const mergedCount = result.filter((r: MergedBlocker) => r.source === 'merged').length;
    assert.equal(mergedCount, 1);
  });
});

// ---------------------------------------------------------------------------
// categoryLabel
// ---------------------------------------------------------------------------

describe('categoryLabel', () => {
  it('returns labels for all known categories', () => {
    assert.equal(categoryLabel('failed'), '❌ Failed');
    assert.equal(categoryLabel('stuck'), '⏳ Stuck');
    assert.equal(categoryLabel('skipped'), '⏭️ Skipped');
    assert.equal(categoryLabel('dependency'), '🔗 Dependency');
  });

  it('returns raw value for unknown category', () => {
    assert.equal(categoryLabel('custom'), 'custom');
  });
});

// ---------------------------------------------------------------------------
// formatBlockerItem
// ---------------------------------------------------------------------------

describe('formatBlockerItem', () => {
  it('formats a basic blocker', () => {
    const blocker = {
      description: 'Deploy failed',
      status: 'failed',
      priority: 'medium',
    };
    const result = formatBlockerItem(blocker);
    assert.ok(result.startsWith('- [ ] **Deploy failed**'));
    assert.ok(result.includes('status:failed'));
  });

  it('includes priority when not medium', () => {
    const blocker = {
      description: 'Critical bug',
      status: 'failed',
      priority: 'critical',
    };
    const result = formatBlockerItem(blocker);
    assert.ok(result.includes('priority:critical'));
  });

  it('omits priority tag for medium', () => {
    const blocker = {
      description: 'Normal fail',
      status: 'failed',
      priority: 'medium',
    };
    const result = formatBlockerItem(blocker);
    assert.ok(!result.includes('priority:'));
  });

  it('includes error message as sub-item', () => {
    const blocker = {
      description: 'Build broke',
      status: 'failed',
      priority: 'high',
      errorMessage: 'Segfault',
    };
    const result = formatBlockerItem(blocker);
    assert.ok(result.includes('\n  - Error: Segfault'));
  });

  it('omits error when includeError is false', () => {
    const blocker = {
      description: 'Build broke',
      status: 'failed',
      priority: 'high',
      errorMessage: 'Segfault',
    };
    const result = formatBlockerItem(blocker, { includeError: false });
    assert.ok(!result.includes('Error:'));
  });

  it('includes objective reference', () => {
    const blocker = {
      description: 'Task X',
      status: 'failed',
      objectiveId: 'obj-setup',
    };
    const result = formatBlockerItem(blocker);
    assert.ok(result.includes('objective:obj-setup'));
  });

  it('omits objective when includeObjective is false', () => {
    const blocker = {
      description: 'Task X',
      status: 'failed',
      objectiveId: 'obj-setup',
    };
    const result = formatBlockerItem(blocker, { includeObjective: false });
    assert.ok(!result.includes('objective:'));
  });

  it('includes duration when available', () => {
    const blocker = {
      description: 'Slow fail',
      status: 'failed',
      durationMs: 120000,
    };
    const result = formatBlockerItem(blocker);
    assert.ok(result.includes('ran:2m'));
  });

  it('includes delegatedTo when present', () => {
    const blocker = {
      description: 'Dep blocker',
      status: 'in-progress',
      delegatedTo: 'agent-writer',
    };
    const result = formatBlockerItem(blocker);
    assert.ok(result.includes('delegated-to:agent-writer'));
  });

  it('includes timestamp date', () => {
    const blocker = {
      description: 'Timed fail',
      status: 'failed',
      timestamp: '2026-04-14T08:30:00Z',
    };
    const result = formatBlockerItem(blocker);
    assert.ok(result.includes('at:2026-04-14'));
  });
});

// ---------------------------------------------------------------------------
// formatBlockersSection
// ---------------------------------------------------------------------------

describe('formatBlockersSection', () => {
  it('shows celebration message when no blockers', () => {
    const result = formatBlockersSection([]);
    assert.ok(result.includes('## Blockers'));
    assert.ok(result.includes('No blockers this week'));
    assert.ok(result.includes('🎉'));
  });

  it('includes summary line with counts', () => {
    const blockers: Array<Partial<MergedBlocker>> = [
      { category: 'failed', description: 'A', status: 'failed' },
      { category: 'failed', description: 'B', status: 'failed' },
      { category: 'stuck', description: 'C', status: 'in-progress' },
    ];
    const result = formatBlockersSection(blockers);
    assert.ok(result.includes('**3** blockers'));
    assert.ok(result.includes('2 failed'));
    assert.ok(result.includes('1 stuck'));
  });

  it('uses singular "blocker" for count of 1', () => {
    const blockers: Array<Partial<MergedBlocker>> = [
      { category: 'failed', description: 'A', status: 'failed' },
    ];
    const result = formatBlockersSection(blockers);
    assert.ok(result.includes('**1** blocker:'));
  });

  it('groups by category with headers', () => {
    const blockers: Array<Partial<MergedBlocker>> = [
      { category: 'failed', description: 'Fail 1', status: 'failed' },
      { category: 'skipped', description: 'Skip 1', status: 'skipped' },
    ];
    const result = formatBlockersSection(blockers);
    assert.ok(result.includes('### ❌ Failed'));
    assert.ok(result.includes('### ⏭️ Skipped'));
  });

  it('renders flat list when groupByCategory is false', () => {
    const blockers: Array<Partial<MergedBlocker>> = [
      { category: 'failed', description: 'Fail 1', status: 'failed' },
      { category: 'skipped', description: 'Skip 1', status: 'skipped' },
    ];
    const result = formatBlockersSection(blockers, { groupByCategory: false });
    assert.ok(!result.includes('### ❌'));
    assert.ok(result.includes('**Fail 1**'));
    assert.ok(result.includes('**Skip 1**'));
  });

  it('omits summary when includeSummary is false', () => {
    const blockers: Array<Partial<MergedBlocker>> = [
      { category: 'failed', description: 'A', status: 'failed' },
    ];
    const result = formatBlockersSection(blockers, { includeSummary: false });
    assert.ok(!result.includes('blocker'));
    assert.ok(result.includes('**A**'));
  });

  it('renders all four category sections when present', () => {
    const blockers: Array<Partial<MergedBlocker>> = [
      { category: 'failed', description: 'F', status: 'failed' },
      { category: 'stuck', description: 'S', status: 'in-progress' },
      { category: 'dependency', description: 'D', status: 'pending', delegatedTo: 'x' },
      { category: 'skipped', description: 'K', status: 'skipped' },
    ];
    const result = formatBlockersSection(blockers);
    assert.ok(result.includes('### ❌ Failed'));
    assert.ok(result.includes('### ⏳ Stuck'));
    assert.ok(result.includes('### 🔗 Dependency'));
    assert.ok(result.includes('### ⏭️ Skipped'));
  });

  it('omits empty category sections', () => {
    const blockers: Array<Partial<MergedBlocker>> = [
      { category: 'stuck', description: 'S', status: 'in-progress' },
    ];
    const result = formatBlockersSection(blockers);
    assert.ok(!result.includes('### ❌ Failed'));
    assert.ok(result.includes('### ⏳ Stuck'));
  });
});

// ---------------------------------------------------------------------------
// generateBlockersReview (integration with mock stores)
// ---------------------------------------------------------------------------

describe('generateBlockersReview', () => {
  let mockWeeklyPlanStore: MockWeeklyPlanStore;
  let mockActivityLogStore: MockActivityLogStore;

  beforeEach(() => {
    mockWeeklyPlanStore = {
      load: mock.fn() as MockWeeklyPlanStore['load'],
    };
    mockActivityLogStore = {
      load: mock.fn() as MockActivityLogStore['load'],
    };
  });

  it('returns empty blockers when plan has no failures and log is empty', async () => {
    mockWeeklyPlanStore.load.mock.mockImplementation(async () => ({
      tasks: [
        { id: 'task-a', title: 'Done', prompt: 'Done', objectiveId: 'obj-a', status: 'completed' },
      ],
    }));
    mockActivityLogStore.load.mock.mockImplementation(async () => []);

    const result = await generateBlockersReview(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-1',
      '2026-W16',
      '2026-04-13'
    );

    assert.equal(result.blockers.length, 0);
    assert.ok(result.markdown.includes('No blockers this week'));
  });

  it('extracts blockers from plan failures', async () => {
    mockWeeklyPlanStore.load.mock.mockImplementation(async () => ({
      tasks: [
        { id: 'task-a', title: 'Broken build', prompt: 'Broken build', objectiveId: 'obj-a', status: 'failed', priority: 'critical' },
        { id: 'task-b', title: 'Done', prompt: 'Done', objectiveId: 'obj-a', status: 'completed' },
      ],
    }));
    mockActivityLogStore.load.mock.mockImplementation(async () => []);

    const result = await generateBlockersReview(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-1',
      '2026-W16',
      '2026-04-13'
    );

    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].taskId, 'task-a');
    assert.ok(result.markdown.includes('Broken build'));
  });

  it('extracts blockers from activity log failures', async () => {
    mockWeeklyPlanStore.load.mock.mockImplementation(async () => ({
      tasks: [],
    }));
    mockActivityLogStore.load.mock.mockImplementation(async () => [
      {
        id: 'log-abc1',
        status: 'failed',
        title: 'API timeout',
        agentId: 'agent-1',
        timestamp: '2026-04-14T09:00:00Z',
        duration: 30000,
        metadata: { error: 'Request timed out' },
      },
    ]);

    const result = await generateBlockersReview(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-1',
      '2026-W16',
      '2026-04-13'
    );

    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].errorMessage, 'Request timed out');
    assert.ok(result.markdown.includes('API timeout'));
  });

  it('merges plan and log blockers for matching tasks', async () => {
    mockWeeklyPlanStore.load.mock.mockImplementation(async () => ({
      tasks: [
        { id: 'task-a', title: 'Deploy service', prompt: 'Deploy service', objectiveId: 'obj-a', status: 'failed', priority: 'high' },
      ],
    }));
    mockActivityLogStore.load.mock.mockImplementation(async () => [
      {
        id: 'log-abc1',
        taskId: 'task-a',
        status: 'failed',
        description: 'Deploy service failed',
        agentId: 'agent-1',
        timestamp: '2026-04-14T10:00:00Z',
        duration: 5000,
        metadata: { error: 'Container crash' },
      },
    ]);

    const result = await generateBlockersReview(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-1',
      '2026-W16',
      '2026-04-13'
    );

    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].source, 'merged');
    assert.equal(result.blockers[0].errorMessage, 'Container crash');
    assert.equal(result.blockers[0].priority, 'high');
  });

  it('handles missing weekly plan gracefully', async () => {
    mockWeeklyPlanStore.load.mock.mockImplementation(async () => {
      throw new Error('ENOENT');
    });
    mockActivityLogStore.load.mock.mockImplementation(async () => [
      {
        id: 'log-abc1',
        status: 'failed',
        title: 'Orphan failure',
        agentId: 'agent-1',
        timestamp: '2026-04-14T10:00:00Z',
      },
    ]);

    const result = await generateBlockersReview(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-1',
      '2026-W16',
      '2026-04-13'
    );

    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].description, 'Orphan failure');
  });

  it('passes formatting options through', async () => {
    mockWeeklyPlanStore.load.mock.mockImplementation(async () => ({
      tasks: [
        { id: 'task-a', title: 'Failed X', prompt: 'Failed X', objectiveId: 'obj-a', status: 'failed' },
      ],
    }));
    mockActivityLogStore.load.mock.mockImplementation(async () => []);

    const result = await generateBlockersReview(
      { weeklyPlanStore: mockWeeklyPlanStore, activityLogStore: mockActivityLogStore },
      'agent-1',
      '2026-W16',
      '2026-04-13',
      { groupByCategory: false, includeSummary: false }
    );

    assert.ok(!result.markdown.includes('### ❌'));
    assert.ok(!result.markdown.includes('blocker'));
    assert.ok(result.markdown.includes('**Failed X**'));
  });
});
