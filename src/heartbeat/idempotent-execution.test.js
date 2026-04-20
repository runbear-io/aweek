/**
 * Tests for idempotent execution — verifies that repeated heartbeat calls
 * for the same agent and time window produce exactly one set of actions,
 * and that concurrent invocations are safely rejected.
 *
 * These tests exercise idempotency across multiple layers:
 *   1. HeartbeatLock (PID-tracked lock isolation)
 *   2. LockedSessionRunner (lock + queue deduplication)
 *   3. HeartbeatTaskRunner + ExecutionStore (time-window deduplication)
 *
 * Evaluation principle: idempotent_execution — repeated heartbeats never
 * produce duplicate work or side effects.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  runWithHeartbeatLock,
  createHeartbeatLock,
} from './heartbeat-lock.js';
import {
  runWithLockAndQueue,
  createLockedSessionRunner,
} from './locked-session-runner.js';
import { acquireLock, releaseLock } from '../lock/lock-manager.js';
import { enqueue, readQueue } from '../queue/task-queue.js';
import { createScheduler } from './scheduler.js';
import { tickAgent, runHeartbeatTick, runHeartbeatTickAll } from './heartbeat-task-runner.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ExecutionStore } from '../storage/execution-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => randomBytes(4).toString('hex');

async function makeTempDir(prefix = 'aweek-idempotent-') {
  return mkdtemp(join(tmpdir(), prefix));
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || `task-${uid()}`,
    description: overrides.description || 'Test task',
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

function makeTaskInfo(overrides = {}) {
  return {
    taskId: overrides.taskId || `task-${uid()}`,
    type: overrides.type || 'heartbeat',
    priority: overrides.priority || 3,
    payload: overrides.payload || { description: 'test task' },
    source: overrides.source || 'test',
    ...overrides,
  };
}

function createMockExecutor(results = {}) {
  const calls = [];
  async function executor(agentId, taskInfo) {
    calls.push({ agentId, taskInfo, timestamp: Date.now() });
    if (results.error) throw results.error;
    if (results.delay) await new Promise((r) => setTimeout(r, results.delay));
    return results.result || { completed: true, taskId: taskInfo?.taskId || 'n/a' };
  }
  executor.calls = calls;
  return executor;
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: HeartbeatLock — concurrent invocation rejection
// ═══════════════════════════════════════════════════════════════════════════

describe('Idempotent execution — HeartbeatLock layer', () => {
  let lockDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('idem-hbl-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('concurrent heartbeats for same agent — second is rejected while first runs', async () => {
    const agentId = `agent-${uid()}`;
    let executeCount = 0;

    const slowCallback = async () => {
      executeCount++;
      await new Promise((r) => setTimeout(r, 100));
      return { value: 'work-done' };
    };

    // Fire first heartbeat, let it acquire lock, then fire second
    const p1 = runWithHeartbeatLock(agentId, slowCallback, { lockDir });
    await new Promise((r) => setTimeout(r, 10)); // let p1 acquire lock
    const p2 = runWithHeartbeatLock(agentId, slowCallback, { lockDir });

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.status, 'completed', 'First heartbeat should complete');
    assert.equal(r2.status, 'skipped', 'Second heartbeat should be skipped');
    assert.equal(executeCount, 1, 'Callback should execute exactly once');
    assert.deepStrictEqual(r1.result, { value: 'work-done' });
    assert.ok(r2.reason.includes('already in progress'));
    assert.ok(r2.existingLock);
  });

  it('repeated sequential heartbeats after completion each execute independently', async () => {
    const agentId = `agent-${uid()}`;
    let callCount = 0;

    const callback = async () => {
      callCount++;
      return { run: callCount };
    };

    // Sequential calls — lock is released between each
    const r1 = await runWithHeartbeatLock(agentId, callback, { lockDir });
    const r2 = await runWithHeartbeatLock(agentId, callback, { lockDir });
    const r3 = await runWithHeartbeatLock(agentId, callback, { lockDir });

    assert.equal(r1.status, 'completed');
    assert.equal(r2.status, 'completed');
    assert.equal(r3.status, 'completed');
    assert.equal(callCount, 3, 'Each sequential heartbeat executes');
  });

  it('concurrent heartbeats for different agents all execute', async () => {
    const agents = Array.from({ length: 5 }, () => `agent-${uid()}`);
    let callCount = 0;

    const callback = async (id) => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { agentId: id };
    };

    const results = await Promise.all(
      agents.map((id) => runWithHeartbeatLock(id, callback, { lockDir }))
    );

    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.status === 'completed'));
    assert.equal(callCount, 5, 'All 5 agents should execute');
  });

  it('second wave after first completes — lock is available again', async () => {
    const agentId = `agent-${uid()}`;
    let callCount = 0;

    const callback = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return 'done';
    };

    // Wave 1: first acquires lock, second is rejected
    const p1 = runWithHeartbeatLock(agentId, callback, { lockDir });
    await new Promise((r) => setTimeout(r, 10));
    const p2 = runWithHeartbeatLock(agentId, callback, { lockDir });
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.status, 'completed');
    assert.equal(r2.status, 'skipped');
    assert.equal(callCount, 1);

    // Wave 2: after lock released, new heartbeat succeeds
    const p3 = runWithHeartbeatLock(agentId, callback, { lockDir });
    await new Promise((r) => setTimeout(r, 10));
    const p4 = runWithHeartbeatLock(agentId, callback, { lockDir });
    const [r3, r4] = await Promise.all([p3, p4]);

    assert.equal(r3.status, 'completed');
    assert.equal(r4.status, 'skipped');
    assert.equal(callCount, 2, 'Only 2 total executions across both waves');
  });

  it('callback error does not prevent next heartbeat', async () => {
    const agentId = `agent-${uid()}`;
    let attempt = 0;

    const callback = async () => {
      attempt++;
      if (attempt === 1) throw new Error('transient failure');
      return 'success';
    };

    const r1 = await runWithHeartbeatLock(agentId, callback, { lockDir });
    assert.equal(r1.status, 'error');

    // Lock should be released — next heartbeat can proceed
    const r2 = await runWithHeartbeatLock(agentId, callback, { lockDir });
    assert.equal(r2.status, 'completed');
    assert.equal(r2.result, 'success');
    assert.equal(attempt, 2);
  });

  it('createHeartbeatLock instance — concurrent runAll is safe', async () => {
    const hbLock = createHeartbeatLock({ lockDir });
    const agents = ['agent-a', 'agent-b', 'agent-c'];
    const callLog = [];

    const callback = async (id) => {
      callLog.push(id);
      await new Promise((r) => setTimeout(r, 50));
      return `done-${id}`;
    };

    // Two runAll calls in parallel — agents should not conflict with each other
    // but same agent across calls should be deduplicated
    const [r1, r2] = await Promise.all([
      hbLock.runAll(agents, callback),
      hbLock.runAll(agents, callback),
    ]);

    // Each agent should have at most 1 completed across both runs
    for (const agentId of agents) {
      const completedCount =
        r1.filter((r) => r.agentId === agentId && r.status === 'completed').length +
        r2.filter((r) => r.agentId === agentId && r.status === 'completed').length;
      assert.ok(completedCount >= 1, `${agentId}: at least one completed`);
      assert.ok(completedCount <= 2, `${agentId}: at most two completed (sequential)`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: LockedSessionRunner — lock + queue deduplication
// ═══════════════════════════════════════════════════════════════════════════

describe('Idempotent execution — LockedSessionRunner layer', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('idem-lsr-lock-');
    queueDir = await makeTempDir('idem-lsr-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  it('same taskId sent twice while locked — only enqueued once', async () => {
    const agentId = `agent-${uid()}`;
    const taskId = `task-${uid()}`;

    // Hold the lock to force queuing
    await acquireLock(agentId, { lockDir });

    const executor = createMockExecutor();

    // Send same taskId twice
    const r1 = await runWithLockAndQueue(agentId, makeTaskInfo({ taskId }), executor, { lockDir, queueDir });
    const r2 = await runWithLockAndQueue(agentId, makeTaskInfo({ taskId }), executor, { lockDir, queueDir });

    assert.equal(r1.status, 'queued');
    assert.equal(r1.duplicate, false);
    assert.equal(r2.status, 'queued');
    assert.equal(r2.duplicate, true);

    // Queue has exactly 1 entry
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 1, 'Duplicate taskId should not create second queue entry');
    assert.equal(queue[0].taskId, taskId);

    // Executor never called (lock was held externally)
    assert.equal(executor.calls.length, 0);

    await releaseLock(agentId, { lockDir });
  });

  it('same taskId sent N times while locked — exactly 1 queue entry', async () => {
    const agentId = `agent-${uid()}`;
    const taskId = `task-${uid()}`;

    await acquireLock(agentId, { lockDir });

    const executor = createMockExecutor();
    const N = 10;
    const results = [];

    for (let i = 0; i < N; i++) {
      results.push(
        await runWithLockAndQueue(agentId, makeTaskInfo({ taskId }), executor, { lockDir, queueDir })
      );
    }

    // First one is not duplicate, rest are
    assert.equal(results[0].duplicate, false);
    for (let i = 1; i < N; i++) {
      assert.equal(results[i].duplicate, true, `Attempt ${i + 1} should be duplicate`);
    }

    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 1);
    assert.equal(executor.calls.length, 0);

    await releaseLock(agentId, { lockDir });
  });

  it('concurrent runWithLockAndQueue for same agent — second is queued while first runs', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor({ delay: 100 });

    // Fire first call, let it acquire lock, then fire second
    const p1 = runWithLockAndQueue(
      agentId,
      makeTaskInfo({ taskId: 'concurrent-0' }),
      executor,
      { lockDir, queueDir, drainQueue: false }
    );
    await new Promise((r) => setTimeout(r, 10)); // let p1 acquire lock
    const p2 = runWithLockAndQueue(
      agentId,
      makeTaskInfo({ taskId: 'concurrent-1' }),
      executor,
      { lockDir, queueDir, drainQueue: false }
    );

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.status, 'executed', 'First should execute');
    assert.equal(r2.status, 'queued', 'Second should be queued');
    assert.equal(executor.calls.length, 1, 'Executor called exactly once');
  });

  it('drain after primary execution — queued tasks run sequentially', async () => {
    const agentId = `agent-${uid()}`;

    // Pre-enqueue 3 tasks
    await enqueue({ agentId, taskId: 'q-1', type: 'heartbeat', priority: 1, payload: {} }, { queueDir });
    await enqueue({ agentId, taskId: 'q-2', type: 'heartbeat', priority: 5, payload: {} }, { queueDir });
    await enqueue({ agentId, taskId: 'q-3', type: 'heartbeat', priority: 3, payload: {} }, { queueDir });

    const executor = createMockExecutor();

    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo({ taskId: 'primary' }),
      executor,
      { lockDir, queueDir, drainQueue: true }
    );

    assert.equal(result.status, 'executed');
    assert.equal(result.taskId, 'primary');
    assert.ok(result.drainResults);
    assert.equal(result.drainResults.length, 3);

    // Total calls: 1 primary + 3 drained = 4
    assert.equal(executor.calls.length, 4);

    // After drain, queue is empty — no leftover work
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 0, 'Queue must be empty after drain');
  });

  it('createLockedSessionRunner — repeated run() same taskId is idempotent in queue', async () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    const agentId = `agent-${uid()}`;
    const taskId = `task-${uid()}`;

    // Grab lock externally to force queueing
    await acquireLock(agentId, { lockDir });

    const executor = createMockExecutor();
    await runner.run(agentId, makeTaskInfo({ taskId }), executor);
    await runner.run(agentId, makeTaskInfo({ taskId }), executor);
    await runner.run(agentId, makeTaskInfo({ taskId }), executor);

    const len = await runner.queueLength(agentId);
    assert.equal(len, 1, 'Same taskId should only appear once in queue');

    await releaseLock(agentId, { lockDir });
  });

  it('cross-agent isolation — locked agent does not affect unlocked agent', async () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    const lockedAgent = `locked-${uid()}`;
    const freeAgent = `free-${uid()}`;
    const executor = createMockExecutor();

    // Lock one agent
    await acquireLock(lockedAgent, { lockDir });

    const rLocked = await runner.run(lockedAgent, makeTaskInfo(), executor);
    const rFree = await runner.run(freeAgent, makeTaskInfo(), executor);

    assert.equal(rLocked.status, 'queued');
    assert.equal(rFree.status, 'executed');
    assert.equal(executor.calls.length, 1, 'Only free agent executor called');

    await releaseLock(lockedAgent, { lockDir });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 3: HeartbeatTaskRunner + ExecutionStore — time-window deduplication
// ═══════════════════════════════════════════════════════════════════════════

describe('Idempotent execution — HeartbeatTaskRunner + ExecutionStore layer', () => {
  let dataDir;
  let lockDir;
  let wpStore;
  let execStore;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('idem-htr-data-');
    lockDir = await makeTempDir('idem-htr-lock-');
    wpStore = new WeeklyPlanStore(dataDir);
    execStore = new ExecutionStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('tickAgent — repeated ticks pick the single task once, then report no_pending_tasks', async () => {
    // Window dedup is gone. The first tick picks and marks the task
    // `in-progress`; the second tick sees no remaining `pending` task and
    // reports `no_pending_tasks` instead of `skipped`.
    const agentId = `agent-${uid()}`;
    const task = makeTask({ priority: 'high' });

    await wpStore.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task],
    }));

    const r1 = await tickAgent(agentId, { weeklyPlanStore: wpStore, executionStore: execStore });
    const r2 = await tickAgent(agentId, { weeklyPlanStore: wpStore, executionStore: execStore });

    assert.equal(r1.outcome, 'task_selected');
    assert.equal(r2.outcome, 'no_pending_tasks');
  });

  it('tickAgent N times — selects every pending task exactly once, then reports no_pending_tasks', async () => {
    const agentId = `agent-${uid()}`;
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ priority: 'high', description: `task-${i}` })
    );

    await wpStore.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks,
    }));

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await tickAgent(agentId, { weeklyPlanStore: wpStore, executionStore: execStore }));
    }

    const selected = results.filter((r) => r.outcome === 'task_selected');
    const exhausted = results.filter((r) => r.outcome === 'no_pending_tasks');
    assert.equal(selected.length, 5, 'All five tasks should be selected across ticks');
    assert.equal(exhausted.length, 1, 'The trailing tick should report no_pending_tasks');

    // One audit row per tick — no dedup collapse.
    const records = await execStore.load(agentId);
    assert.equal(records.length, 6);
  });

  it('tickAgent in different time windows — each selects a task', async () => {
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical', description: 'first' });
    const task2 = makeTask({ priority: 'high', description: 'second' });

    await wpStore.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2],
    }));

    // Use very small window (1ms) so each tick falls in a different window
    const r1 = await tickAgent(agentId, {
      weeklyPlanStore: wpStore,
      executionStore: execStore,
      windowMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await tickAgent(agentId, {
      weeklyPlanStore: wpStore,
      executionStore: execStore,
      windowMs: 1,
    });

    assert.equal(r1.outcome, 'task_selected');
    assert.equal(r2.outcome, 'task_selected');
    assert.notEqual(r1.task.id, r2.task.id, 'Different tasks should be selected');
  });

  it('runHeartbeatTick with scheduler — consecutive ticks advance through tasks', async () => {
    // Window dedup removed: each tick picks the next `pending` task; the
    // trailing tick (after all tasks moved to `in-progress`) reports
    // `no_pending_tasks` instead of `skipped`.
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical', description: 'only-task' });
    const task2 = makeTask({ priority: 'high', description: 'second-task' });

    await wpStore.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2],
    }));

    const r1 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: wpStore, executionStore: execStore });
    const r2 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: wpStore, executionStore: execStore });
    const r3 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: wpStore, executionStore: execStore });

    assert.equal(r1.result.outcome, 'task_selected');
    assert.equal(r1.result.task.id, task1.id);
    assert.equal(r2.result.outcome, 'task_selected');
    assert.equal(r2.result.task.id, task2.id);
    assert.equal(r3.result.outcome, 'no_pending_tasks');

    // One audit row per tick.
    const records = await execStore.load(agentId);
    assert.equal(records.length, 3);
  });

  it('runHeartbeatTickAll — each agent advances independently on every round', async () => {
    const agent1 = `agent-${uid()}`;
    const agent2 = `agent-${uid()}`;

    await wpStore.save(agent1, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'a1-task-1' }), makeTask({ description: 'a1-task-2' })],
    }));
    await wpStore.save(agent2, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'a2-task-1' }), makeTask({ description: 'a2-task-2' })],
    }));

    // Round 1: both agents pick their first pending task.
    const round1 = await runHeartbeatTickAll([agent1, agent2], {
      scheduler, weeklyPlanStore: wpStore, executionStore: execStore,
    });
    assert.equal(round1.length, 2);
    assert.ok(round1.every((r) => r.result.outcome === 'task_selected'));

    // Round 2: both agents pick their second pending task (NOT skipped).
    const round2 = await runHeartbeatTickAll([agent1, agent2], {
      scheduler, weeklyPlanStore: wpStore, executionStore: execStore,
    });
    assert.equal(round2.length, 2);
    assert.ok(round2.every((r) => r.result.outcome === 'task_selected'));
  });

  it('failed heartbeat does not block follow-up ticks — every tick is retried', async () => {
    const agentId = `agent-${uid()}`;
    const brokenStore = {
      loadLatestApproved: async () => { throw new Error('disk error'); },
    };

    const r1 = await tickAgent(agentId, {
      weeklyPlanStore: brokenStore,
      executionStore: execStore,
    });
    assert.equal(r1.outcome, 'error');

    // Window dedup is gone — the second tick retries the failing path.
    const r2 = await tickAgent(agentId, {
      weeklyPlanStore: brokenStore,
      executionStore: execStore,
    });
    assert.equal(r2.outcome, 'error');

    // Both failures are audited.
    const records = await execStore.load(agentId);
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.status === 'failed'));
  });

  it('shell-agent outcome (no_weekly_plans) — every tick audits a fresh skipped row', async () => {
    // Post-AC 11 Sub-AC 2: an agent initialised with no weekly plan files
    // surfaces as a shell (no_weekly_plans). With window dedup removed,
    // every tick records its own `skipped` audit row.
    const agentId = `agent-${uid()}`;
    await wpStore.init(agentId);

    const r1 = await tickAgent(agentId, { weeklyPlanStore: wpStore, executionStore: execStore });
    const r2 = await tickAgent(agentId, { weeklyPlanStore: wpStore, executionStore: execStore });

    assert.equal(r1.outcome, 'no_weekly_plans');
    assert.equal(r2.outcome, 'no_weekly_plans');

    const records = await execStore.load(agentId);
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.status === 'skipped'));
    assert.notEqual(records[0].idempotencyKey, records[1].idempotencyKey);
  });

  it('without executionStore — no deduplication, tasks advance normally', async () => {
    const agentId = `agent-${uid()}`;
    const task1 = makeTask({ priority: 'critical' });
    const task2 = makeTask({ priority: 'high' });

    await wpStore.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [task1, task2],
    }));

    // Without executionStore, each tick selects next task (no dedup)
    const r1 = await tickAgent(agentId, { weeklyPlanStore: wpStore });
    const r2 = await tickAgent(agentId, { weeklyPlanStore: wpStore });

    assert.equal(r1.outcome, 'task_selected');
    assert.equal(r1.task.id, task1.id);
    assert.equal(r2.outcome, 'task_selected');
    assert.equal(r2.task.id, task2.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 4: Combined — scheduler lock + execution store deduplication
// ═══════════════════════════════════════════════════════════════════════════

describe('Idempotent execution — combined lock + dedup integration', () => {
  let dataDir;
  let lockDir;
  let wpStore;
  let execStore;
  let scheduler;

  beforeEach(async () => {
    dataDir = await makeTempDir('idem-combo-data-');
    lockDir = await makeTempDir('idem-combo-lock-');
    wpStore = new WeeklyPlanStore(dataDir);
    execStore = new ExecutionStore(dataDir);
    scheduler = createScheduler({ lockDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  });

  it('sequential heartbeat ticks — lock serializes them, task-state dedup drives progression', async () => {
    // The scheduler lock prevents overlap within a single tick. The
    // pending → in-progress transition (atomic inside the lock) is what
    // keeps two ticks from picking the same task — no time-window
    // rate-limiter is in the picture any more.
    const agentId = `agent-${uid()}`;
    const tasks = Array.from({ length: 3 }, (_, i) =>
      makeTask({ priority: ['critical', 'high', 'medium'][i], description: `task-${i}` })
    );

    await wpStore.save(agentId, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks,
    }));

    const r1 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: wpStore, executionStore: execStore });
    const r2 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: wpStore, executionStore: execStore });
    const r3 = await runHeartbeatTick(agentId, { scheduler, weeklyPlanStore: wpStore, executionStore: execStore });

    assert.ok([r1, r2, r3].every((r) => r.result.outcome === 'task_selected'));
    const pickedIds = new Set([r1.result.task.id, r2.result.task.id, r3.result.task.id]);
    assert.equal(pickedIds.size, 3, 'Every tick should pick a distinct pending task');
  });

  it('mixed agent scenario — each agent advances through its own tasks independently', async () => {
    const agentA = `agent-a-${uid()}`;
    const agentB = `agent-b-${uid()}`;

    await wpStore.save(agentA, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'A-task-1' }), makeTask({ description: 'A-task-2' })],
    }));
    await wpStore.save(agentB, makePlan({
      approved: true,
      approvedAt: new Date().toISOString(),
      tasks: [makeTask({ description: 'B-task-1' })],
    }));

    const round1 = await runHeartbeatTickAll([agentA, agentB], {
      scheduler, weeklyPlanStore: wpStore, executionStore: execStore,
    });
    assert.ok(round1.every((r) => r.result.outcome === 'task_selected'));

    const round2 = await runHeartbeatTickAll([agentA, agentB], {
      scheduler, weeklyPlanStore: wpStore, executionStore: execStore,
    });
    const round2ByAgent = Object.fromEntries(round2.map((r) => [r.agentId, r.result.outcome]));
    // Agent A still has task 2 pending.
    assert.equal(round2ByAgent[agentA], 'task_selected');
    // Agent B had only one task, so round 2 reports no_pending_tasks.
    assert.equal(round2ByAgent[agentB], 'no_pending_tasks');

    const planA = await wpStore.load(agentA, '2026-W16');
    const inProgressA = planA.tasks.filter((t) => t.status === 'in-progress');
    assert.equal(inProgressA.length, 2, 'Both of agent A\'s tasks should now be in-progress');
  });

  it('execution store — every tick gets a unique idempotencyKey (no window collapse)', async () => {
    const agentId = `agent-${uid()}`;
    await wpStore.init(agentId);

    const r1 = await tickAgent(agentId, { weeklyPlanStore: wpStore, executionStore: execStore });
    const r2 = await tickAgent(agentId, { weeklyPlanStore: wpStore, executionStore: execStore });

    // Post-AC 11 Sub-AC 2: shell agents surface as no_weekly_plans.
    assert.equal(r1.outcome, 'no_weekly_plans');
    assert.equal(r2.outcome, 'no_weekly_plans');

    const records = await execStore.load(agentId);
    assert.equal(records.length, 2);
    assert.notEqual(records[0].idempotencyKey, records[1].idempotencyKey);
  });
});
