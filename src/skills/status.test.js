/**
 * Tests for status skill — agent status summary aggregation.
 * Covers: single agent status, multi-agent gathering, task counting,
 * formatting, edge cases (no agents, no plans, paused budget).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ActivityLogStore, createLogEntry } from '../storage/activity-log-store.js';
import { UsageStore, createUsageRecord } from '../storage/usage-store.js';
import { InboxStore } from '../storage/inbox-store.js';
import { createAgentConfig, createWeeklyPlan, createTask, createInboxMessage, getMondayISO } from '../models/agent.js';
import {
  getCurrentWeekString,
  getMondayDate,
  computeTaskCounts,
  buildAgentStatus,
  gatherAllAgentStatuses,
  formatAgentStatus,
  formatStatusReport,
  formatNumber,
} from './status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(name, overrides = {}) {
  const config = createAgentConfig({
    subagentRef: String(name).toLowerCase(),
    weeklyTokenLimit: 100000,
  });
  return { ...config, ...overrides };
}

function makePlan(week, tasks = [], approved = true) {
  const plan = createWeeklyPlan(week, '2026-04', tasks);
  plan.approved = approved;
  if (approved) plan.approvedAt = new Date().toISOString();
  return plan;
}

function makeTask(id, status = 'pending') {
  const task = createTask({ title: `Task ${id}`, prompt: `Task ${id}` }, 'obj-1');
  task.id = `task-${id}`;
  task.status = status;
  return task;
}

let tmpDir;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'status-test-'));
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// getCurrentWeekString
// ---------------------------------------------------------------------------

describe('getCurrentWeekString', () => {
  it('returns a YYYY-Www format string', () => {
    const result = getCurrentWeekString(new Date('2026-04-17'));
    assert.match(result, /^\d{4}-W\d{2}$/);
  });

  it('returns correct week for a known date', () => {
    // April 17 2026 is a Friday in ISO week 16
    const result = getCurrentWeekString(new Date('2026-04-17'));
    assert.equal(result, '2026-W16');
  });

  it('defaults to current date when no argument provided', () => {
    const result = getCurrentWeekString();
    assert.match(result, /^\d{4}-W\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// getMondayDate
// ---------------------------------------------------------------------------

describe('status getMondayDate', () => {
  it('returns Monday for a Friday', () => {
    assert.equal(getMondayDate(new Date('2026-04-17')), '2026-04-13');
  });

  it('returns same date for a Monday', () => {
    assert.equal(getMondayDate(new Date('2026-04-13')), '2026-04-13');
  });

  it('returns Monday for a Sunday', () => {
    assert.equal(getMondayDate(new Date('2026-04-19')), '2026-04-13');
  });
});

// ---------------------------------------------------------------------------
// computeTaskCounts
// ---------------------------------------------------------------------------

describe('computeTaskCounts', () => {
  it('returns zeros for null plan', () => {
    const result = computeTaskCounts(null);
    assert.deepEqual(result, { total: 0, byStatus: {}, approved: false });
  });

  it('returns zeros for plan with no tasks', () => {
    const result = computeTaskCounts({ tasks: [], approved: true });
    assert.deepEqual(result, { total: 0, byStatus: {}, approved: true });
  });

  it('counts tasks by status correctly', () => {
    const plan = {
      approved: true,
      tasks: [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'pending' },
        { status: 'in-progress' },
        { status: 'failed' },
      ],
    };
    const result = computeTaskCounts(plan);
    assert.equal(result.total, 5);
    assert.equal(result.byStatus['completed'], 2);
    assert.equal(result.byStatus['pending'], 1);
    assert.equal(result.byStatus['in-progress'], 1);
    assert.equal(result.byStatus['failed'], 1);
    assert.equal(result.approved, true);
  });

  it('reflects unapproved plan', () => {
    const plan = { tasks: [{ status: 'pending' }], approved: false };
    assert.equal(computeTaskCounts(plan).approved, false);
  });
});

// ---------------------------------------------------------------------------
// buildAgentStatus
// ---------------------------------------------------------------------------

describe('buildAgentStatus', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns idle state when no plan exists', async () => {
    const agent = makeAgent('Alpha');
    await new AgentStore(tmpDir).save(agent);

    const stores = {
      weeklyPlanStore: new WeeklyPlanStore(tmpDir),
      activityLogStore: new ActivityLogStore(tmpDir),
      usageStore: new UsageStore(tmpDir),
      inboxStore: new InboxStore(tmpDir),
    };

    const status = await buildAgentStatus({
      agentConfig: agent,
      week: '2026-W16',
      weekMonday: '2026-04-13',
      stores,
    });

    assert.equal(status.id, agent.id);
    // With identity removed, production falls back to the agent id (slug).
    assert.equal(status.name, 'alpha');
    assert.equal(status.state, 'idle');
    assert.equal(status.plan.tasks.total, 0);
    assert.equal(status.usage.totalTokens, 0);
    assert.equal(status.inbox.total, 0);
  });

  it('returns active state when approved plan has pending tasks', async () => {
    const agent = makeAgent('Beta');
    const agentStore = new AgentStore(tmpDir);
    await agentStore.save(agent);

    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    const plan = makePlan('2026-W16', [
      makeTask('t1', 'completed'),
      makeTask('t2', 'pending'),
      makeTask('t3', 'in-progress'),
    ], true);
    await weeklyPlanStore.save(agent.id, plan);

    const stores = {
      weeklyPlanStore,
      activityLogStore: new ActivityLogStore(tmpDir),
      usageStore: new UsageStore(tmpDir),
      inboxStore: new InboxStore(tmpDir),
    };

    const status = await buildAgentStatus({
      agentConfig: agent,
      week: '2026-W16',
      weekMonday: '2026-04-13',
      stores,
    });

    assert.equal(status.state, 'active');
    assert.equal(status.plan.approved, true);
    assert.equal(status.plan.tasks.total, 3);
    assert.equal(status.plan.tasks.byStatus['completed'], 1);
    assert.equal(status.plan.tasks.byStatus['pending'], 1);
    assert.equal(status.plan.tasks.byStatus['in-progress'], 1);
  });

  it('returns paused state when budget is exhausted', async () => {
    const agent = makeAgent('Gamma');
    agent.budget.paused = true;
    const agentStore = new AgentStore(tmpDir);
    await agentStore.save(agent);

    const stores = {
      weeklyPlanStore: new WeeklyPlanStore(tmpDir),
      activityLogStore: new ActivityLogStore(tmpDir),
      usageStore: new UsageStore(tmpDir),
      inboxStore: new InboxStore(tmpDir),
    };

    const status = await buildAgentStatus({
      agentConfig: agent,
      week: '2026-W16',
      weekMonday: '2026-04-13',
      stores,
    });

    assert.equal(status.state, 'paused');
    assert.equal(status.budget.paused, true);
  });

  it('includes usage and activity data', async () => {
    const agent = makeAgent('Delta');
    const agentStore = new AgentStore(tmpDir);
    await agentStore.save(agent);

    const usageStore = new UsageStore(tmpDir);
    const record = createUsageRecord({
      agentId: agent.id,
      taskId: 't1',
      inputTokens: 5000,
      outputTokens: 3000,
      week: '2026-04-13',
      timestamp: '2026-04-15T10:00:00Z',
    });
    await usageStore.append(agent.id, record);

    const activityLogStore = new ActivityLogStore(tmpDir);
    const logEntry = createLogEntry({
      agentId: agent.id,
      taskId: 't1',
      status: 'completed',
      title: 'Did something',
      duration: 5000,
    });
    // Manually set timestamp to match the week
    logEntry.timestamp = '2026-04-15T10:00:00Z';
    await activityLogStore.append(agent.id, logEntry);

    const stores = {
      weeklyPlanStore: new WeeklyPlanStore(tmpDir),
      activityLogStore,
      usageStore,
      inboxStore: new InboxStore(tmpDir),
    };

    const status = await buildAgentStatus({
      agentConfig: agent,
      week: '2026-W16',
      weekMonday: '2026-04-13',
      stores,
    });

    assert.equal(status.usage.totalTokens, 8000);
    assert.equal(status.usage.inputTokens, 5000);
    assert.equal(status.usage.outputTokens, 3000);
    assert.equal(status.usage.sessions, 1);
    assert.equal(status.activity.entries, 1);
  });

  it('includes inbox data', async () => {
    const agent = makeAgent('Epsilon');
    const agentStore = new AgentStore(tmpDir);
    await agentStore.save(agent);

    const inboxStore = new InboxStore(tmpDir);
    const msg = createInboxMessage('agent-other-12345678', agent.id, 'Do this task');
    await inboxStore.enqueue(agent.id, msg);

    const stores = {
      weeklyPlanStore: new WeeklyPlanStore(tmpDir),
      activityLogStore: new ActivityLogStore(tmpDir),
      usageStore: new UsageStore(tmpDir),
      inboxStore,
    };

    const status = await buildAgentStatus({
      agentConfig: agent,
      week: '2026-W16',
      weekMonday: '2026-04-13',
      stores,
    });

    assert.equal(status.inbox.total, 1);
    assert.equal(status.inbox.pending, 1);
  });

  it('computes budget utilization percentage', async () => {
    const agent = makeAgent('Zeta');
    agent.budget.weeklyTokenLimit = 100000;
    const agentStore = new AgentStore(tmpDir);
    await agentStore.save(agent);

    const usageStore = new UsageStore(tmpDir);
    const record = createUsageRecord({
      agentId: agent.id,
      taskId: 't1',
      inputTokens: 30000,
      outputTokens: 20000,
      week: '2026-04-13',
      timestamp: '2026-04-15T10:00:00Z',
    });
    await usageStore.append(agent.id, record);

    const stores = {
      weeklyPlanStore: new WeeklyPlanStore(tmpDir),
      activityLogStore: new ActivityLogStore(tmpDir),
      usageStore,
      inboxStore: new InboxStore(tmpDir),
    };

    const status = await buildAgentStatus({
      agentConfig: agent,
      week: '2026-W16',
      weekMonday: '2026-04-13',
      stores,
    });

    assert.equal(status.budget.utilizationPct, 50);
    assert.equal(status.budget.weeklyTokenLimit, 100000);
  });
});

// ---------------------------------------------------------------------------
// gatherAllAgentStatuses
// ---------------------------------------------------------------------------

describe('gatherAllAgentStatuses', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty agents array when no agents exist', async () => {
    const result = await gatherAllAgentStatuses({
      dataDir: tmpDir,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.agents.length, 0);
    assert.equal(result.week, '2026-W16');
    assert.equal(result.weekMonday, '2026-04-13');
  });

  it('gathers status for multiple agents', async () => {
    const agentStore = new AgentStore(tmpDir);
    const agentA = makeAgent('Alice');
    const agentB = makeAgent('Bob');
    await agentStore.save(agentA);
    await agentStore.save(agentB);

    const result = await gatherAllAgentStatuses({
      dataDir: tmpDir,
      date: new Date('2026-04-17'),
    });

    assert.equal(result.agents.length, 2);
    assert.ok(result.timestamp);
    assert.equal(result.week, '2026-W16');
    assert.equal(result.weekMonday, '2026-04-13');

    const names = result.agents.map((a) => a.name).sort();
    assert.deepEqual(names, ['alice', 'bob']);
  });

  it('includes correct week/date metadata', async () => {
    const result = await gatherAllAgentStatuses({
      dataDir: tmpDir,
      date: new Date('2026-04-20'), // Sunday
    });

    assert.equal(result.week, '2026-W17');
    assert.equal(result.weekMonday, '2026-04-20');
  });
});

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------

describe('formatNumber', () => {
  it('formats integers with commas', () => {
    assert.equal(formatNumber(1000), '1,000');
    assert.equal(formatNumber(1234567), '1,234,567');
  });

  it('handles zero', () => {
    assert.equal(formatNumber(0), '0');
  });
});

// ---------------------------------------------------------------------------
// formatAgentStatus
// ---------------------------------------------------------------------------

describe('formatAgentStatus', () => {
  it('formats idle agent with no plan', () => {
    const status = {
      id: 'agent-test-001',
      name: 'TestBot',
      role: 'tester',
      state: 'idle',
      plan: { week: '2026-W16', approved: false, tasks: { total: 0, byStatus: {} } },
      activity: { weekMonday: '2026-04-13', entries: 0, byStatus: {}, totalDurationMs: 0 },
      usage: { weekMonday: '2026-04-13', totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sessions: 0 },
      inbox: { total: 0, pending: 0, accepted: 0 },
      budget: { weeklyTokenLimit: 100000, currentUsage: 0, paused: false, utilizationPct: 0 },
      lock: { status: 'absent', locked: false },
    };

    const text = formatAgentStatus(status);
    assert.ok(text.includes('[IDLE]'));
    assert.ok(text.includes('TestBot'));
    assert.ok(text.includes('No weekly plan'));
  });

  it('formats active agent with tasks', () => {
    const status = {
      id: 'agent-test-002',
      name: 'WorkBot',
      role: 'worker',
      state: 'active',
      plan: {
        week: '2026-W16',
        approved: true,
        tasks: { total: 5, byStatus: { completed: 2, pending: 2, 'in-progress': 1 } },
      },
      activity: { weekMonday: '2026-04-13', entries: 3, byStatus: {}, totalDurationMs: 0 },
      usage: { weekMonday: '2026-04-13', totalTokens: 50000, inputTokens: 30000, outputTokens: 20000, costUsd: 0.5, sessions: 3 },
      inbox: { total: 2, pending: 1, accepted: 1 },
      budget: { weeklyTokenLimit: 100000, currentUsage: 50000, paused: false, utilizationPct: 50 },
      lock: { status: 'absent', locked: false },
    };

    const text = formatAgentStatus(status);
    assert.ok(text.includes('[ACTIVE]'));
    assert.ok(text.includes('WorkBot'));
    assert.ok(text.includes('2 completed'));
    assert.ok(text.includes('2 pending'));
    assert.ok(text.includes('1 in-progress'));
    assert.ok(text.includes('(approved)'));
    assert.ok(text.includes('50%'));
    assert.ok(text.includes('3 log entries'));
    assert.ok(text.includes('2 messages'));
  });

  it('formats paused agent', () => {
    const status = {
      id: 'agent-test-003',
      name: 'PausedBot',
      role: 'paused',
      state: 'paused',
      plan: { week: '2026-W16', approved: true, tasks: { total: 1, byStatus: { pending: 1 } } },
      activity: { weekMonday: '2026-04-13', entries: 0, byStatus: {}, totalDurationMs: 0 },
      usage: { weekMonday: '2026-04-13', totalTokens: 100000, inputTokens: 60000, outputTokens: 40000, costUsd: 1, sessions: 5 },
      inbox: { total: 0, pending: 0, accepted: 0 },
      budget: { weeklyTokenLimit: 100000, currentUsage: 100000, paused: true, utilizationPct: 100 },
      lock: { status: 'absent', locked: false },
    };

    const text = formatAgentStatus(status);
    assert.ok(text.includes('[PAUSED]'));
    assert.ok(text.includes('PAUSED'));
    assert.ok(text.includes('100%'));
  });

  it('shows lock status when running', () => {
    const status = {
      id: 'agent-test-004',
      name: 'RunBot',
      role: 'runner',
      state: 'running',
      plan: { week: '2026-W16', approved: true, tasks: { total: 1, byStatus: { 'in-progress': 1 } } },
      activity: { weekMonday: '2026-04-13', entries: 0, byStatus: {}, totalDurationMs: 0 },
      usage: { weekMonday: '2026-04-13', totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sessions: 0 },
      inbox: { total: 0, pending: 0, accepted: 0 },
      budget: { weeklyTokenLimit: 100000, currentUsage: 0, paused: false, utilizationPct: 0 },
      lock: { status: 'active', locked: true },
    };

    const text = formatAgentStatus(status);
    assert.ok(text.includes('[RUNNING]'));
    assert.ok(text.includes('Active session running'));
  });
});

// ---------------------------------------------------------------------------
// formatStatusReport
// ---------------------------------------------------------------------------

describe('formatStatusReport', () => {
  it('formats empty report when no agents', () => {
    const report = {
      agents: [],
      timestamp: '2026-04-17T12:00:00Z',
      week: '2026-W16',
      weekMonday: '2026-04-13',
    };

    const text = formatStatusReport(report);
    assert.ok(text.includes('aweek Agent Status'));
    assert.ok(text.includes('Agents: 0'));
    assert.ok(text.includes('No agents found'));
    assert.ok(text.includes('/aweek:create-agent'));
  });

  it('formats multi-agent report with overview', () => {
    const report = {
      agents: [
        {
          id: 'agent-a', name: 'Alice', role: 'dev', state: 'active',
          plan: { week: '2026-W16', approved: true, tasks: { total: 3, byStatus: { completed: 1, pending: 2 } } },
          activity: { weekMonday: '2026-04-13', entries: 2, byStatus: {}, totalDurationMs: 0 },
          usage: { weekMonday: '2026-04-13', totalTokens: 25000, inputTokens: 15000, outputTokens: 10000, costUsd: 0.2, sessions: 2 },
          inbox: { total: 0, pending: 0, accepted: 0 },
          budget: { weeklyTokenLimit: 100000, currentUsage: 25000, paused: false, utilizationPct: 25 },
          lock: { status: 'absent', locked: false },
        },
        {
          id: 'agent-b', name: 'Bob', role: 'qa', state: 'idle',
          plan: { week: '2026-W16', approved: true, tasks: { total: 2, byStatus: { completed: 2 } } },
          activity: { weekMonday: '2026-04-13', entries: 2, byStatus: {}, totalDurationMs: 0 },
          usage: { weekMonday: '2026-04-13', totalTokens: 15000, inputTokens: 10000, outputTokens: 5000, costUsd: 0.1, sessions: 2 },
          inbox: { total: 0, pending: 0, accepted: 0 },
          budget: { weeklyTokenLimit: 100000, currentUsage: 15000, paused: false, utilizationPct: 15 },
          lock: { status: 'absent', locked: false },
        },
      ],
      timestamp: '2026-04-17T12:00:00Z',
      week: '2026-W16',
      weekMonday: '2026-04-13',
    };

    const text = formatStatusReport(report);
    assert.ok(text.includes('aweek Agent Status'));
    assert.ok(text.includes('Agents: 2'));
    assert.ok(text.includes('1 active'));
    assert.ok(text.includes('1 idle'));
    assert.ok(text.includes('40,000')); // total tokens
    assert.ok(text.includes('Alice'));
    assert.ok(text.includes('Bob'));
  });

  it('includes week and monday date in header', () => {
    const report = {
      agents: [],
      timestamp: '2026-04-17T12:00:00Z',
      week: '2026-W16',
      weekMonday: '2026-04-13',
    };

    const text = formatStatusReport(report);
    assert.ok(text.includes('Week: 2026-W16'));
    assert.ok(text.includes('Monday: 2026-04-13'));
  });
});
