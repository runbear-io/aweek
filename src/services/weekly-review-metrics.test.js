import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

import {
  computeTaskMetrics,
  computeTokenMetrics,
  computeDelegationMetrics,
  formatNumber,
  formatCost,
  formatPercent,
  formatMetricsSection,
  aggregateWeeklyMetrics,
} from './weekly-review-metrics.js';

import { ActivityLogStore, createLogEntry, getMondayDate } from '../storage/activity-log-store.js';
import { UsageStore, createUsageRecord } from '../storage/usage-store.js';
import { InboxStore } from '../storage/inbox-store.js';

// ---------------------------------------------------------------------------
// computeTaskMetrics
// ---------------------------------------------------------------------------

describe('computeTaskMetrics', () => {
  it('returns zeros for empty/null summary', () => {
    const result = computeTaskMetrics(null);
    assert.equal(result.completed, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.delegated, 0);
    assert.equal(result.totalExecuted, 0);
    assert.equal(result.planned, 0);
    assert.equal(result.completionRate, null);
  });

  it('returns zeros for empty byStatus', () => {
    const result = computeTaskMetrics({ byStatus: {}, totalDuration: 0 });
    assert.equal(result.completed, 0);
    assert.equal(result.totalExecuted, 0);
  });

  it('counts activity statuses correctly', () => {
    const summary = {
      byStatus: { completed: 5, failed: 2, skipped: 1, started: 3, delegated: 1 },
      totalDuration: 300000,
    };
    const result = computeTaskMetrics(summary);
    assert.equal(result.completed, 5);
    assert.equal(result.failed, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.started, 3);
    assert.equal(result.delegated, 1);
    assert.equal(result.totalExecuted, 9); // 5+2+1+1
    assert.equal(result.totalDurationMs, 300000);
  });

  it('computes plan-based metrics when plan provided', () => {
    const summary = { byStatus: { completed: 3 }, totalDuration: 0 };
    const plan = {
      tasks: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
        { id: 't3', status: 'completed' },
        { id: 't4', status: 'pending' },
        { id: 't5', status: 'pending' },
      ],
    };
    const result = computeTaskMetrics(summary, plan);
    assert.equal(result.planned, 5);
    assert.equal(result.pending, 2);
    assert.equal(result.completionRate, 60); // 3/5 = 60%
  });

  it('handles 0 planned tasks without dividing by zero', () => {
    const summary = { byStatus: { completed: 1 }, totalDuration: 0 };
    const plan = { tasks: [] };
    const result = computeTaskMetrics(summary, plan);
    assert.equal(result.planned, 0);
    assert.equal(result.completionRate, 0);
  });

  it('returns null completionRate when no plan provided', () => {
    const summary = { byStatus: { completed: 3 }, totalDuration: 0 };
    const result = computeTaskMetrics(summary);
    assert.equal(result.completionRate, null);
  });

  it('counts ready tasks as pending', () => {
    const summary = { byStatus: {}, totalDuration: 0 };
    const plan = {
      tasks: [
        { id: 't1', status: 'ready' },
        { id: 't2', status: 'completed' },
      ],
    };
    const result = computeTaskMetrics(summary, plan);
    assert.equal(result.pending, 1);
  });
});

// ---------------------------------------------------------------------------
// computeTokenMetrics
// ---------------------------------------------------------------------------

describe('computeTokenMetrics', () => {
  it('returns zeros for null input', () => {
    const result = computeTokenMetrics(null);
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 0);
    assert.equal(result.costUsd, 0);
    assert.equal(result.sessionCount, 0);
  });

  it('extracts token counts from usage total', () => {
    const total = {
      inputTokens: 10000,
      outputTokens: 5000,
      totalTokens: 15000,
      costUsd: 0.045,
      recordCount: 3,
    };
    const result = computeTokenMetrics(total);
    assert.equal(result.inputTokens, 10000);
    assert.equal(result.outputTokens, 5000);
    assert.equal(result.totalTokens, 15000);
    assert.equal(result.costUsd, 0.045);
    assert.equal(result.sessionCount, 3);
  });

  it('defaults missing fields to 0', () => {
    const result = computeTokenMetrics({});
    assert.equal(result.inputTokens, 0);
    assert.equal(result.sessionCount, 0);
  });
});

// ---------------------------------------------------------------------------
// computeDelegationMetrics
// ---------------------------------------------------------------------------

describe('computeDelegationMetrics', () => {
  it('returns zeros for empty arrays', () => {
    const result = computeDelegationMetrics([], []);
    assert.equal(result.received.total, 0);
    assert.equal(result.sent.total, 0);
  });

  it('counts received messages by status', () => {
    const received = [
      { status: 'pending' },
      { status: 'completed' },
      { status: 'completed' },
      { status: 'rejected' },
      { status: 'accepted' },
    ];
    const result = computeDelegationMetrics(received, []);
    assert.equal(result.received.total, 5);
    assert.equal(result.received.pending, 1);
    assert.equal(result.received.completed, 2);
    assert.equal(result.received.rejected, 1);
    assert.equal(result.received.accepted, 1);
  });

  it('counts sent messages by status', () => {
    const sent = [
      { status: 'pending' },
      { status: 'completed' },
    ];
    const result = computeDelegationMetrics([], sent);
    assert.equal(result.sent.total, 2);
    assert.equal(result.sent.pending, 1);
    assert.equal(result.sent.completed, 1);
  });

  it('handles undefined inputs gracefully', () => {
    const result = computeDelegationMetrics(undefined, undefined);
    assert.equal(result.received.total, 0);
    assert.equal(result.sent.total, 0);
  });
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe('formatNumber', () => {
  it('formats zero', () => {
    assert.equal(formatNumber(0), '0');
  });

  it('formats null as 0', () => {
    assert.equal(formatNumber(null), '0');
  });

  it('formats large numbers with separators', () => {
    const result = formatNumber(1234567);
    assert.ok(result.includes('1'));
    assert.ok(result.includes('234'));
    assert.ok(result.includes('567'));
  });
});

describe('formatCost', () => {
  it('formats zero cost', () => {
    assert.equal(formatCost(0), '$0.00');
  });

  it('formats null cost', () => {
    assert.equal(formatCost(null), '$0.00');
  });

  it('formats normal cost with 2 decimals', () => {
    assert.equal(formatCost(1.5), '$1.50');
  });

  it('formats tiny cost with 4 decimals', () => {
    assert.equal(formatCost(0.0023), '$0.0023');
  });
});

describe('formatPercent', () => {
  it('formats null as N/A', () => {
    assert.equal(formatPercent(null), 'N/A');
  });

  it('formats percentage', () => {
    assert.equal(formatPercent(75), '75%');
  });

  it('formats zero', () => {
    assert.equal(formatPercent(0), '0%');
  });
});

// ---------------------------------------------------------------------------
// formatMetricsSection
// ---------------------------------------------------------------------------

describe('formatMetricsSection', () => {
  const baseMetrics = {
    tasks: {
      completed: 5,
      failed: 1,
      skipped: 0,
      started: 0,
      delegated: 1,
      totalExecuted: 7,
      planned: 0,
      pending: 0,
      completionRate: null,
      totalDurationMs: 0,
    },
    tokens: {
      inputTokens: 10000,
      outputTokens: 5000,
      totalTokens: 15000,
      costUsd: 0.045,
      sessionCount: 3,
    },
    delegation: {
      received: { total: 0, pending: 0, accepted: 0, completed: 0, rejected: 0 },
      sent: { total: 0, pending: 0, accepted: 0, completed: 0, rejected: 0 },
    },
  };

  it('renders ## Metrics header', () => {
    const md = formatMetricsSection(baseMetrics);
    assert.ok(md.startsWith('## Metrics'));
  });

  it('renders Task Execution table', () => {
    const md = formatMetricsSection(baseMetrics);
    assert.ok(md.includes('### Task Execution'));
    assert.ok(md.includes('| Completed | 5 |'));
    assert.ok(md.includes('| Failed | 1 |'));
    assert.ok(md.includes('| Delegated | 1 |'));
    assert.ok(md.includes('| Total executed | 7 |'));
  });

  it('renders plan metrics when planned > 0', () => {
    const metrics = {
      ...baseMetrics,
      tasks: { ...baseMetrics.tasks, planned: 10, pending: 3, completionRate: 50 },
    };
    const md = formatMetricsSection(metrics);
    assert.ok(md.includes('| Planned | 10 |'));
    assert.ok(md.includes('| Pending | 3 |'));
    assert.ok(md.includes('| Completion rate | 50% |'));
  });

  it('omits plan metrics when planned is 0', () => {
    const md = formatMetricsSection(baseMetrics);
    assert.ok(!md.includes('| Planned |'));
  });

  it('renders total execution time when present', () => {
    const metrics = {
      ...baseMetrics,
      tasks: { ...baseMetrics.tasks, totalDurationMs: 3_600_000 },
    };
    const md = formatMetricsSection(metrics);
    assert.ok(md.includes('| Total execution time | 1h |'));
  });

  it('renders Token Usage table', () => {
    const md = formatMetricsSection(baseMetrics);
    assert.ok(md.includes('### Token Usage'));
    assert.ok(md.includes('| Sessions | 3 |'));
  });

  it('renders "no delegation" message when none', () => {
    const md = formatMetricsSection(baseMetrics);
    assert.ok(md.includes('No delegation activity this week'));
  });

  it('renders delegation tables when present', () => {
    const metrics = {
      ...baseMetrics,
      delegation: {
        received: { total: 3, pending: 1, accepted: 0, completed: 2, rejected: 0 },
        sent: { total: 2, pending: 0, accepted: 1, completed: 1, rejected: 0 },
      },
    };
    const md = formatMetricsSection(metrics);
    assert.ok(md.includes('### Delegation'));
    assert.ok(md.includes('**Received tasks:**'));
    assert.ok(md.includes('**Sent tasks:**'));
    assert.ok(!md.includes('No delegation activity'));
  });

  it('renders only received when no sent', () => {
    const metrics = {
      ...baseMetrics,
      delegation: {
        received: { total: 1, pending: 1, accepted: 0, completed: 0, rejected: 0 },
        sent: { total: 0, pending: 0, accepted: 0, completed: 0, rejected: 0 },
      },
    };
    const md = formatMetricsSection(metrics);
    assert.ok(md.includes('**Received tasks:**'));
    assert.ok(!md.includes('**Sent tasks:**'));
  });
});

// ---------------------------------------------------------------------------
// aggregateWeeklyMetrics (integration)
// ---------------------------------------------------------------------------

describe('aggregateWeeklyMetrics', () => {
  let tmpDir;
  let activityLogStore;
  let usageStore;
  let inboxStore;

  const agentId = 'agent-metrics-test12';
  // Compute the current week's Monday so createLogEntry's Date.now()-stamped
  // entries and the aggregator's week-keyed reads line up. A hardcoded date
  // falls out of range whenever UTC crosses the week boundary during a run.
  const weekMonday = getMondayDate();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-metrics-'));
    activityLogStore = new ActivityLogStore(tmpDir);
    usageStore = new UsageStore(tmpDir);
    inboxStore = new InboxStore(tmpDir);
  });

  it('returns zero metrics when no data exists', async () => {
    const { metrics, markdown } = await aggregateWeeklyMetrics(
      { activityLogStore, usageStore, inboxStore },
      agentId,
      weekMonday
    );

    assert.equal(metrics.agentId, agentId);
    assert.equal(metrics.weekMonday, weekMonday);
    assert.equal(metrics.tasks.completed, 0);
    assert.equal(metrics.tasks.totalExecuted, 0);
    assert.equal(metrics.tokens.totalTokens, 0);
    assert.equal(metrics.delegation.received.total, 0);
    assert.equal(metrics.delegation.sent.total, 0);
    assert.ok(markdown.includes('## Metrics'));
  });

  it('aggregates task metrics from activity log', async () => {
    // Append some activity log entries
    const entry1 = createLogEntry({
      agentId,
      taskId: 'task-aaa11111',
      status: 'completed',
      description: 'Did task 1',
      duration: 60000,
    });
    const entry2 = createLogEntry({
      agentId,
      taskId: 'task-bbb22222',
      status: 'failed',
      description: 'Failed task 2',
    });
    const entry3 = createLogEntry({
      agentId,
      taskId: 'task-ccc33333',
      status: 'completed',
      description: 'Did task 3',
      duration: 30000,
    });

    await activityLogStore.append(agentId, entry1);
    await activityLogStore.append(agentId, entry2);
    await activityLogStore.append(agentId, entry3);

    const { metrics } = await aggregateWeeklyMetrics(
      { activityLogStore, usageStore, inboxStore },
      agentId,
      weekMonday
    );

    assert.equal(metrics.tasks.completed, 2);
    assert.equal(metrics.tasks.failed, 1);
    assert.equal(metrics.tasks.totalExecuted, 3);
    assert.equal(metrics.tasks.totalDurationMs, 90000);
  });

  it('aggregates token usage from usage store', async () => {
    const record1 = createUsageRecord({
      agentId,
      taskId: 'task-aaa11111',
      inputTokens: 5000,
      outputTokens: 2000,
      totalTokens: 7000,
      costUsd: 0.02,
      week: weekMonday,
    });
    const record2 = createUsageRecord({
      agentId,
      taskId: 'task-bbb22222',
      inputTokens: 3000,
      outputTokens: 1000,
      totalTokens: 4000,
      costUsd: 0.01,
      week: weekMonday,
    });

    await usageStore.append(agentId, record1);
    await usageStore.append(agentId, record2);

    const { metrics } = await aggregateWeeklyMetrics(
      { activityLogStore, usageStore, inboxStore },
      agentId,
      weekMonday
    );

    assert.equal(metrics.tokens.inputTokens, 8000);
    assert.equal(metrics.tokens.outputTokens, 3000);
    assert.equal(metrics.tokens.totalTokens, 11000);
    assert.equal(metrics.tokens.sessionCount, 2);
  });

  it('aggregates delegation stats from inbox', async () => {
    // Enqueue messages into this agent's inbox
    await inboxStore.init(agentId);
    await inboxStore.enqueue(agentId, {
      id: 'msg-aaa11111',
      from: 'agent-other-1234ab',
      to: agentId,
      type: 'task-delegation',
      taskDescription: 'Please do X',
      priority: 'medium',
      createdAt: '2026-04-14T10:00:00.000Z',
      status: 'completed',
    });
    await inboxStore.enqueue(agentId, {
      id: 'msg-bbb22222',
      from: 'agent-other-1234ab',
      to: agentId,
      type: 'task-delegation',
      taskDescription: 'Please do Y',
      priority: 'high',
      createdAt: '2026-04-15T10:00:00.000Z',
      status: 'pending',
    });

    const { metrics } = await aggregateWeeklyMetrics(
      { activityLogStore, usageStore, inboxStore },
      agentId,
      weekMonday
    );

    assert.equal(metrics.delegation.received.total, 2);
    assert.equal(metrics.delegation.received.completed, 1);
    assert.equal(metrics.delegation.received.pending, 1);
  });

  it('returns valid markdown with all sections', async () => {
    const entry = createLogEntry({
      agentId,
      taskId: 'task-aaa11111',
      status: 'completed',
      description: 'Task done',
    });
    await activityLogStore.append(agentId, entry);

    const { markdown } = await aggregateWeeklyMetrics(
      { activityLogStore, usageStore, inboxStore },
      agentId,
      weekMonday
    );

    assert.ok(markdown.includes('## Metrics'));
    assert.ok(markdown.includes('### Task Execution'));
    assert.ok(markdown.includes('### Token Usage'));
    assert.ok(markdown.includes('### Delegation'));
  });

  it('handles store errors gracefully', async () => {
    // Create stores with non-existent base dirs — should not throw
    const badUsageStore = new UsageStore('/nonexistent/path');
    const badInboxStore = new InboxStore('/nonexistent/path');

    // activityLogStore needs to work to avoid complete failure
    const { metrics } = await aggregateWeeklyMetrics(
      { activityLogStore, usageStore: badUsageStore, inboxStore: badInboxStore },
      agentId,
      weekMonday
    );

    // Should still return valid metrics with zeros for failed stores
    assert.equal(metrics.tokens.totalTokens, 0);
    assert.equal(metrics.delegation.received.total, 0);
  });
});
