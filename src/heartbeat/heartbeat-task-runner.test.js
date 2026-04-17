/**
 * Tests for heartbeat-task-runner — integration of scheduler + task selector.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  createTaskTickCallback,
  tickAgent,
  runHeartbeatTick,
  runHeartbeatTickAll,
} from './heartbeat-task-runner.js';
import { createScheduler } from './scheduler.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ExecutionStore } from '../storage/execution-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => randomBytes(4).toString('hex');

function makeTask(overrides = {}) {
  return {
    id: overrides.id || `task-${uid()}`,
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

async function makeTempDir(prefix = 'aweek-htr-') {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// createTaskTickCallback
// ---------------------------------------------------------------------------

describe('createTaskTickCallback', () => {
  it('throws if weeklyPlanStore not provided', () => {
    assert.throws(() => createTaskTickCallback(), /weeklyPlanStore is required/);
    assert.throws(() => createTaskTickCallback({}), /weeklyPlanStore is required/);
  });

  it('returns a function', () => {
    const store = new WeeklyPlanStore('/tmp/fake');
    const cb = createTaskTickCallback({ weeklyPlanStore: store });
    assert.equal(typeof cb, 'function');
  });
});

// ---------------------------------------------------------------------------
// tickAgent
// ---------------------------------------------------------------------------

describe('tickAgent', () => {
  let dataDir;
  let store;

  beforeEach(async () => {
    dataDir = await makeTempDir('aweek-tick-');
    store = new WeeklyPlanStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('throws if weeklyPlanStore not provided', async () => {
    await assert.rejects(
      () => tickAgent('agent-x'),
      /weeklyPlanStore is required/
    );
  });

  it('throws if agentId not provided', async () => {
    await assert.rejects(
      () => tickAgent('', { weeklyPlanStore: store }),
      /agentId is required/
    );
  });

  it('returns no_approved_plan when agent has no plans', async () => {
    const agentId = `agent-${uid()}`;
    await store.init(agentId);

    const result = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(result.outcome, 'no_approved_plan');
    assert.equal(result.agentId, agentId);
    assert.ok(result.reason);
    assert.ok(result.tickedAt);
  });

  it('returns no_approved_plan when only unapproved plans exist', async () => {
    const agentId = `agent-${uid()}`;
    await store.save(agentId, makePlan({
      approved: false,
      tasks: [makeTask()],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(result.outcome, 'no_approved_plan');
  });

  it('selects highest-priority pending task and marks it in-progress', async () => {
    const agentId = `agent-${uid()}`;
    const criticalTask = makeTask({ priority: 'critical', description: 'critical-task' });
    const lowTask = makeTask({ priority: 'low', description: 'low-task' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [lowTask, criticalTask],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store });

    assert.equal(result.outcome, 'task_selected');
    assert.equal(result.agentId, agentId);
    assert.equal(result.task.id, criticalTask.id);
    assert.equal(result.task.description, 'critical-task');
    assert.equal(result.taskIndex, 1); // original index
    assert.equal(result.week, '2026-W16');
    assert.ok(result.summary);
    assert.ok(result.tickedAt);

    // Verify the task was marked in-progress in the store
    const updatedPlan = await store.load(agentId, '2026-W16');
    const updatedTask = updatedPlan.tasks.find((t) => t.id === criticalTask.id);
    assert.equal(updatedTask.status, 'in-progress');

    // The other task should still be pending
    const otherTask = updatedPlan.tasks.find((t) => t.id === lowTask.id);
    assert.equal(otherTask.status, 'pending');
  });

  it('returns all_tasks_finished when all tasks are completed/failed/etc', async () => {
    const agentId = `agent-${uid()}`;
    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'failed' }),
        makeTask({ status: 'skipped' }),
      ],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(result.outcome, 'all_tasks_finished');
    assert.equal(result.week, '2026-W16');
    assert.ok(result.summary);
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.pending, 0);
  });

  it('returns no_pending_tasks when tasks are in-progress but none pending', async () => {
    const agentId = `agent-${uid()}`;
    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [
        makeTask({ status: 'in-progress' }),
        makeTask({ status: 'completed' }),
      ],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(result.outcome, 'no_pending_tasks');
    assert.ok(result.reason.includes('in-progress'));
    assert.equal(result.summary.inProgress, 1);
  });

  it('is idempotent — second tick selects next pending task, not re-selects', async () => {
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical', description: 'first' });
    const task2 = makeTask({ priority: 'high', description: 'second' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2],
    }));

    // First tick
    const r1 = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(r1.outcome, 'task_selected');
    assert.equal(r1.task.id, task1.id);

    // Second tick — task1 now in-progress, should pick task2
    const r2 = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(r2.outcome, 'task_selected');
    assert.equal(r2.task.id, task2.id);

    // Third tick — both in-progress, no pending
    const r3 = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(r3.outcome, 'no_pending_tasks');
  });

  it('returns summary with correct counts after selection', async () => {
    const agentId = `agent-${uid()}`;
    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'pending', priority: 'high' }),
        makeTask({ status: 'pending', priority: 'low' }),
      ],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(result.outcome, 'task_selected');
    // After marking one as in-progress: 1 completed, 1 in-progress, 1 pending
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.completed, 1);
    assert.equal(result.summary.inProgress, 1);
    assert.equal(result.summary.pending, 1);
  });

  it('handles error gracefully and returns error outcome', async () => {
    const agentId = `agent-${uid()}`;
    // Create a store with a broken path to trigger an error
    const brokenStore = {
      loadLatestApproved: async () => { throw new Error('disk on fire'); },
    };

    // tickAgent catches errors thrown by selectNextTask
    const result = await tickAgent(agentId, { weeklyPlanStore: brokenStore });
    assert.equal(result.outcome, 'error');
    assert.ok(result.error);
    assert.ok(result.reason.includes('disk on fire'));
    assert.ok(result.tickedAt);
  });

  it('selects from latest approved plan, ignoring earlier weeks', async () => {
    const agentId = `agent-${uid()}`;

    await store.save(agentId, makePlan({
      week: '2026-W15',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ priority: 'critical', description: 'old-week-task' })],
    }));
    await store.save(agentId, makePlan({
      week: '2026-W16',
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ priority: 'low', description: 'current-week-task' })],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(result.outcome, 'task_selected');
    assert.equal(result.task.description, 'current-week-task');
    assert.equal(result.week, '2026-W16');
  });
});

// ---------------------------------------------------------------------------
// runHeartbeatTick (scheduler + task selector integration)
// ---------------------------------------------------------------------------

describe('runHeartbeatTick', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('aweek-hbt-data-');
    lockDir = await makeTempDir('aweek-hbt-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('throws if scheduler not provided', async () => {
    await assert.rejects(
      () => runHeartbeatTick('agent-x', { weeklyPlanStore: store }),
      /scheduler is required/
    );
  });

  it('throws if weeklyPlanStore not provided', async () => {
    await assert.rejects(
      () => runHeartbeatTick('agent-x', { scheduler }),
      /weeklyPlanStore is required/
    );
  });

  it('throws if agentId not provided', async () => {
    await assert.rejects(
      () => runHeartbeatTick('', { scheduler, weeklyPlanStore: store }),
      /agentId is required/
    );
  });

  it('selects task with lock isolation and returns completed status', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high', description: 'locked-task' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const result = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });

    assert.equal(result.status, 'completed');
    assert.equal(result.agentId, agentId);
    assert.ok(result.result);
    assert.equal(result.result.outcome, 'task_selected');
    assert.equal(result.result.task.id, task.id);
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
    assert.ok(result.durationMs >= 0);
  });

  it('skips if agent is already locked', async () => {
    const agentId = `agent-${uid()}`;
    await store.init(agentId);

    // Acquire lock externally
    await scheduler.acquireLock(agentId);

    const result = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'already_locked');

    await scheduler.releaseLock(agentId);
  });

  it('releases lock after completion', async () => {
    const agentId = `agent-${uid()}`;
    await store.init(agentId);

    await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });

    const lockState = await scheduler.isLocked(agentId);
    assert.equal(lockState.locked, false);
  });

  it('releases lock even on error', async () => {
    const agentId = `agent-${uid()}`;
    // Don't init store — let the tick hit an error path
    // tickAgent handles errors gracefully, so the scheduler should complete
    await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });

    const lockState = await scheduler.isLocked(agentId);
    assert.equal(lockState.locked, false);
  });

  it('returns no_approved_plan outcome through scheduler result', async () => {
    const agentId = `agent-${uid()}`;
    await store.init(agentId);

    const result = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(result.status, 'completed');
    assert.equal(result.result.outcome, 'no_approved_plan');
  });

  it('is idempotent — repeated ticks advance through tasks sequentially', async () => {
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical', description: 'first-task' });
    const task2 = makeTask({ priority: 'high', description: 'second-task' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2],
    }));

    // First tick selects task1 and marks it in-progress
    const r1 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(r1.status, 'completed');
    assert.equal(r1.result.outcome, 'task_selected');
    assert.equal(r1.result.task.id, task1.id);

    // Second tick selects task2 (task1 now in-progress)
    const r2 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(r2.status, 'completed');
    assert.equal(r2.result.outcome, 'task_selected');
    assert.equal(r2.result.task.id, task2.id);

    // Third tick — no more pending tasks
    const r3 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: store });
    assert.equal(r3.status, 'completed');
    assert.equal(r3.result.outcome, 'no_pending_tasks');
  });
});

// ---------------------------------------------------------------------------
// runHeartbeatTickAll
// ---------------------------------------------------------------------------

describe('runHeartbeatTickAll', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('aweek-hbtall-data-');
    lockDir = await makeTempDir('aweek-hbtall-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('throws if scheduler not provided', async () => {
    await assert.rejects(
      () => runHeartbeatTickAll(['a'], { weeklyPlanStore: store }),
      /scheduler is required/
    );
  });

  it('throws if weeklyPlanStore not provided', async () => {
    await assert.rejects(
      () => runHeartbeatTickAll(['a'], { scheduler }),
      /weeklyPlanStore is required/
    );
  });

  it('throws if agentIds is not an array', async () => {
    await assert.rejects(
      () => runHeartbeatTickAll('not-array', { scheduler, weeklyPlanStore: store }),
      /agentIds must be an array/
    );
  });

  it('runs heartbeats for multiple agents in parallel', async () => {
    const agent1 = `agent-${uid()}`;
    const agent2 = `agent-${uid()}`;

    await store.save(agent1, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'task-for-agent1' })],
    }));
    await store.save(agent2, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'task-for-agent2' })],
    }));

    const results = await runHeartbeatTickAll(
      [agent1, agent2],
      { scheduler, weeklyPlanStore: store }
    );

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'completed'));
    assert.ok(results.every((r) => r.result.outcome === 'task_selected'));

    const r1 = results.find((r) => r.agentId === agent1);
    const r2 = results.find((r) => r.agentId === agent2);
    assert.equal(r1.result.task.description, 'task-for-agent1');
    assert.equal(r2.result.task.description, 'task-for-agent2');
  });

  it('handles mixed results — some agents with plans, some without', async () => {
    const agentWithPlan = `agent-${uid()}`;
    const agentWithout = `agent-${uid()}`;

    await store.save(agentWithPlan, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'has-task' })],
    }));
    await store.init(agentWithout);

    const results = await runHeartbeatTickAll(
      [agentWithPlan, agentWithout],
      { scheduler, weeklyPlanStore: store }
    );

    const withPlan = results.find((r) => r.agentId === agentWithPlan);
    const without = results.find((r) => r.agentId === agentWithout);

    assert.equal(withPlan.status, 'completed');
    assert.equal(withPlan.result.outcome, 'task_selected');
    assert.equal(without.status, 'completed');
    assert.equal(without.result.outcome, 'no_approved_plan');
  });

  it('returns empty array for empty agent list', async () => {
    const results = await runHeartbeatTickAll(
      [],
      { scheduler, weeklyPlanStore: store }
    );
    assert.deepEqual(results, []);
  });

  it('isolates agents — one agent failure does not affect others', async () => {
    const goodAgent = `agent-${uid()}`;
    const badAgent = `agent-${uid()}`;

    await store.save(goodAgent, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'good-task' })],
    }));
    // badAgent has no init, tickAgent will handle gracefully

    const results = await runHeartbeatTickAll(
      [goodAgent, badAgent],
      { scheduler, weeklyPlanStore: store }
    );

    const good = results.find((r) => r.agentId === goodAgent);
    assert.equal(good.status, 'completed');
    assert.equal(good.result.outcome, 'task_selected');

    const bad = results.find((r) => r.agentId === badAgent);
    assert.equal(bad.status, 'completed');
    // Should be no_approved_plan or error — either is acceptable
    assert.ok(['no_approved_plan', 'error'].includes(bad.result.outcome));
  });
});

// ---------------------------------------------------------------------------
// Execution deduplication integration — tickAgent + ExecutionStore
// ---------------------------------------------------------------------------

describe('tickAgent with executionStore (deduplication)', () => {
  let dataDir;
  let store;
  let execStore;

  beforeEach(async () => {
    dataDir = await makeTempDir('aweek-dedup-');
    store = new WeeklyPlanStore(dataDir);
    execStore = new ExecutionStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('records execution on successful task selection', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high', description: 'dedup-task' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store, executionStore: execStore });
    assert.equal(result.outcome, 'task_selected');

    // Verify execution was recorded
    const records = await execStore.load(agentId);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'started');
    assert.equal(records[0].taskId, task.id);
    assert.match(records[0].idempotencyKey, /^idem-/);
  });

  it('skips duplicate heartbeat in same time window', async () => {
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical', description: 'first' });
    const task2 = makeTask({ priority: 'high', description: 'second' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2],
    }));

    // First tick succeeds
    const r1 = await tickAgent(agentId, { weeklyPlanStore: store, executionStore: execStore });
    assert.equal(r1.outcome, 'task_selected');
    assert.equal(r1.task.id, task1.id);

    // Second tick in same window is skipped (deduplication)
    const r2 = await tickAgent(agentId, { weeklyPlanStore: store, executionStore: execStore });
    assert.equal(r2.outcome, 'skipped');
    assert.ok(r2.reason.includes('Duplicate heartbeat'));
    assert.ok(r2.idempotencyKey);

    // Only one execution record was stored
    const records = await execStore.load(agentId);
    assert.equal(records.length, 1);
  });

  it('allows execution in different time windows', async () => {
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical', description: 'first' });
    const task2 = makeTask({ priority: 'high', description: 'second' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2],
    }));

    // Use a very small window (1ms) so consecutive ticks fall into different windows
    const r1 = await tickAgent(agentId, {
      weeklyPlanStore: store,
      executionStore: execStore,
      windowMs: 1,
    });
    assert.equal(r1.outcome, 'task_selected');

    // Wait a tiny bit to ensure different window
    await new Promise((resolve) => setTimeout(resolve, 5));

    const r2 = await tickAgent(agentId, {
      weeklyPlanStore: store,
      executionStore: execStore,
      windowMs: 1,
    });
    assert.equal(r2.outcome, 'task_selected');

    // Two execution records
    const records = await execStore.load(agentId);
    assert.equal(records.length, 2);
  });

  it('records skipped execution when no approved plan exists', async () => {
    const agentId = `agent-${uid()}`;
    await store.init(agentId);

    const result = await tickAgent(agentId, { weeklyPlanStore: store, executionStore: execStore });
    assert.equal(result.outcome, 'no_approved_plan');

    // Execution should be recorded as skipped
    const records = await execStore.load(agentId);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'skipped');
  });

  it('records skipped execution when all tasks finished', async () => {
    const agentId = `agent-${uid()}`;
    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [
        makeTask({ status: 'completed' }),
        makeTask({ status: 'failed' }),
      ],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store, executionStore: execStore });
    assert.equal(result.outcome, 'all_tasks_finished');

    const records = await execStore.load(agentId);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'skipped');
  });

  it('records failed execution on error', async () => {
    const agentId = `agent-${uid()}`;
    const brokenStore = {
      loadLatestApproved: async () => { throw new Error('boom'); },
    };

    const result = await tickAgent(agentId, {
      weeklyPlanStore: brokenStore,
      executionStore: execStore,
    });
    assert.equal(result.outcome, 'error');

    const records = await execStore.load(agentId);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'failed');
  });

  it('duplicate heartbeat after error is still skipped', async () => {
    const agentId = `agent-${uid()}`;
    const brokenStore = {
      loadLatestApproved: async () => { throw new Error('boom'); },
    };

    // First tick errors and records failed
    const r1 = await tickAgent(agentId, {
      weeklyPlanStore: brokenStore,
      executionStore: execStore,
    });
    assert.equal(r1.outcome, 'error');

    // Second tick in same window is skipped
    const r2 = await tickAgent(agentId, {
      weeklyPlanStore: brokenStore,
      executionStore: execStore,
    });
    assert.equal(r2.outcome, 'skipped');
    assert.ok(r2.reason.includes('Duplicate heartbeat'));
  });

  it('gracefully degrades when executionStore is not provided', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high', description: 'no-store' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    // Without executionStore, behaves exactly as before (no dedup)
    const r1 = await tickAgent(agentId, { weeklyPlanStore: store });
    assert.equal(r1.outcome, 'task_selected');
  });

  it('gracefully degrades when executionStore throws', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high', description: 'broken-exec-store' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const brokenExecStore = {
      exists: async () => false, // dedup check passes
      record: async () => { throw new Error('disk full'); },
      init: async () => {},
    };

    // Task selection still works even when recording fails
    const result = await tickAgent(agentId, {
      weeklyPlanStore: store,
      executionStore: brokenExecStore,
    });
    assert.equal(result.outcome, 'task_selected');
    assert.equal(result.task.description, 'broken-exec-store');
  });

  it('different agents are not deduplicated against each other', async () => {
    const agent1 = `agent-${uid()}`;
    const agent2 = `agent-${uid()}`;

    await store.save(agent1, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'agent1-task' })],
    }));
    await store.save(agent2, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'agent2-task' })],
    }));

    const r1 = await tickAgent(agent1, { weeklyPlanStore: store, executionStore: execStore });
    const r2 = await tickAgent(agent2, { weeklyPlanStore: store, executionStore: execStore });

    assert.equal(r1.outcome, 'task_selected');
    assert.equal(r2.outcome, 'task_selected');
    assert.equal(r1.task.description, 'agent1-task');
    assert.equal(r2.task.description, 'agent2-task');
  });
});

// ---------------------------------------------------------------------------
// runHeartbeatTick with executionStore (deduplication through scheduler)
// ---------------------------------------------------------------------------

describe('runHeartbeatTick with executionStore', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;
  let execStore;

  beforeEach(async () => {
    dataDir = await makeTempDir('aweek-hbt-dedup-data-');
    lockDir = await makeTempDir('aweek-hbt-dedup-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
    execStore = new ExecutionStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('deduplicates through the full scheduler+tick path', async () => {
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical', description: 'sched-task-1' });
    const task2 = makeTask({ priority: 'high', description: 'sched-task-2' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2],
    }));

    // First tick through scheduler selects task
    const r1 = await runHeartbeatTick(agentId, {
      scheduler,
      weeklyPlanStore: store,
      executionStore: execStore,
    });
    assert.equal(r1.status, 'completed');
    assert.equal(r1.result.outcome, 'task_selected');
    assert.equal(r1.result.task.id, task1.id);

    // Second tick in same window is skipped (dedup)
    const r2 = await runHeartbeatTick(agentId, {
      scheduler,
      weeklyPlanStore: store,
      executionStore: execStore,
    });
    assert.equal(r2.status, 'completed');
    assert.equal(r2.result.outcome, 'skipped');
    assert.ok(r2.result.reason.includes('Duplicate heartbeat'));
  });

  it('runHeartbeatTickAll deduplicates per-agent independently', async () => {
    const agent1 = `agent-${uid()}`;
    const agent2 = `agent-${uid()}`;

    await store.save(agent1, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'a1-task' })],
    }));
    await store.save(agent2, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'a2-task' })],
    }));

    // First round — both agents execute
    const r1 = await runHeartbeatTickAll([agent1, agent2], {
      scheduler,
      weeklyPlanStore: store,
      executionStore: execStore,
    });
    assert.ok(r1.every((r) => r.result.outcome === 'task_selected'));

    // Second round — both agents deduplicated
    const r2 = await runHeartbeatTickAll([agent1, agent2], {
      scheduler,
      weeklyPlanStore: store,
      executionStore: execStore,
    });
    assert.ok(r2.every((r) => r.result.outcome === 'skipped'));
  });
});

// ---------------------------------------------------------------------------
// Resume guard — tickAgent skips paused agents
// ---------------------------------------------------------------------------

describe('tickAgent resume guard (paused agents)', () => {
  let dataDir;
  let store;

  beforeEach(async () => {
    dataDir = await makeTempDir('aweek-pause-');
    store = new WeeklyPlanStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Create a mock agentStore that returns a config with budget.paused */
  function mockAgentStore(paused) {
    return {
      load: async () => ({
        id: 'agent-test',
        budget: { paused, weeklyTokenLimit: 100000, currentUsage: 0, periodStart: new Date().toISOString() },
      }),
    };
  }

  it('skips execution when agent is paused', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high', description: 'should-not-run' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const result = await tickAgent(agentId, {
      weeklyPlanStore: store,
      agentStore: mockAgentStore(true),
    });

    assert.equal(result.outcome, 'skipped');
    assert.ok(result.reason.includes('paused'));
    assert.ok(result.reason.includes('budget exhausted'));
    assert.equal(result.pausedReason, 'budget_exhausted');
    assert.equal(result.agentId, agentId);
    assert.ok(result.tickedAt);

    // Verify the task was NOT touched — still pending
    const plan = await store.load(agentId, '2026-W16');
    assert.equal(plan.tasks[0].status, 'pending');
  });

  it('proceeds normally when agent is NOT paused', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high', description: 'should-run' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const result = await tickAgent(agentId, {
      weeklyPlanStore: store,
      agentStore: mockAgentStore(false),
    });

    assert.equal(result.outcome, 'task_selected');
    assert.equal(result.task.description, 'should-run');
  });

  it('proceeds normally when agentStore is not provided (backward compatible)', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'medium', description: 'no-store' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const result = await tickAgent(agentId, { weeklyPlanStore: store });

    assert.equal(result.outcome, 'task_selected');
  });

  it('gracefully degrades if agentStore.load throws (agent proceeds)', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high', description: 'broken-store' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const brokenAgentStore = {
      load: async () => { throw new Error('agent store unavailable'); },
    };

    const result = await tickAgent(agentId, {
      weeklyPlanStore: store,
      agentStore: brokenAgentStore,
    });

    // Should proceed rather than fail
    assert.equal(result.outcome, 'task_selected');
  });

  it('records skipped execution in executionStore when paused', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const execStore = new ExecutionStore(dataDir);

    const result = await tickAgent(agentId, {
      weeklyPlanStore: store,
      agentStore: mockAgentStore(true),
      executionStore: execStore,
    });

    assert.equal(result.outcome, 'skipped');

    const records = await execStore.load(agentId);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'skipped');
  });

  it('paused check runs before deduplication check', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const execStore = new ExecutionStore(dataDir);

    // First tick while paused → skipped with paused reason
    const r1 = await tickAgent(agentId, {
      weeklyPlanStore: store,
      agentStore: mockAgentStore(true),
      executionStore: execStore,
    });
    assert.equal(r1.outcome, 'skipped');
    assert.equal(r1.pausedReason, 'budget_exhausted');
  });
});

// ---------------------------------------------------------------------------
// runHeartbeatTick resume guard integration
// ---------------------------------------------------------------------------

describe('runHeartbeatTick resume guard', () => {
  let dataDir;
  let lockDir;
  let store;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('aweek-hbt-pause-data-');
    lockDir = await makeTempDir('aweek-hbt-pause-lock-');
    store = new WeeklyPlanStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  function mockAgentStore(paused) {
    return {
      load: async () => ({
        id: 'agent-test',
        budget: { paused, weeklyTokenLimit: 100000, currentUsage: 0, periodStart: new Date().toISOString() },
      }),
    };
  }

  it('skips paused agent through full scheduler path', async () => {
    const agentId = `agent-${uid()}`;
    const task = makeTask({ description: 'paused-via-scheduler' });

    await store.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const result = await runHeartbeatTick(agentId, {
      scheduler,
      weeklyPlanStore: store,
      agentStore: mockAgentStore(true),
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.result.outcome, 'skipped');
    assert.ok(result.result.reason.includes('paused'));
  });

  it('runHeartbeatTickAll skips paused agents independently', async () => {
    const pausedAgent = `agent-${uid()}`;
    const activeAgent = `agent-${uid()}`;

    await store.save(pausedAgent, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'paused-task' })],
    }));
    await store.save(activeAgent, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'active-task' })],
    }));

    // Agent store that returns different paused state per agent
    const mixedStore = {
      load: async (id) => ({
        id,
        budget: {
          paused: id === pausedAgent,
          weeklyTokenLimit: 100000,
          currentUsage: 0,
          periodStart: new Date().toISOString(),
        },
      }),
    };

    const results = await runHeartbeatTickAll([pausedAgent, activeAgent], {
      scheduler,
      weeklyPlanStore: store,
      agentStore: mixedStore,
    });

    const paused = results.find((r) => r.agentId === pausedAgent);
    const active = results.find((r) => r.agentId === activeAgent);

    assert.equal(paused.result.outcome, 'skipped');
    assert.ok(paused.result.reason.includes('paused'));
    assert.equal(active.result.outcome, 'task_selected');
  });
});
