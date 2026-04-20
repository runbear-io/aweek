/**
 * Tests for locked-session-runner — lock acquisition + task queuing integration
 * into the heartbeat/session execution flow.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  runWithLockAndQueue,
  drainQueuedTasks,
  runAllWithLockAndQueue,
  createLockedSessionRunner,
  createDispatchingExecutor,
} from './locked-session-runner.js';
import { acquireLock, releaseLock, queryLock } from '../lock/lock-manager.js';
import { enqueue, readQueue, clearQueue } from '../queue/task-queue.js';
import { DAILY_REVIEW_OBJECTIVE_ID } from '../schemas/weekly-plan.schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => randomBytes(4).toString('hex');

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

async function makeTempDir(prefix = 'aweek-lsr-') {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Simple execute function that records calls and returns a result */
function createMockExecutor(results = {}) {
  const calls = [];
  async function executor(agentId, taskInfo) {
    calls.push({ agentId, taskInfo });
    if (results.error) throw results.error;
    return results.result || { completed: true, taskId: taskInfo.taskId };
  }
  executor.calls = calls;
  return executor;
}

/** Execute function that blocks until released — for concurrency tests */
function createBlockingExecutor() {
  const calls = [];
  let resolveBlock;
  const blockPromise = new Promise((resolve) => {
    resolveBlock = resolve;
  });

  async function executor(agentId, taskInfo) {
    calls.push({ agentId, taskInfo });
    await blockPromise;
    return { completed: true, taskId: taskInfo.taskId };
  }

  executor.calls = calls;
  executor.release = () => resolveBlock();
  return executor;
}

// ---------------------------------------------------------------------------
// runWithLockAndQueue — basic lock acquisition
// ---------------------------------------------------------------------------

describe('runWithLockAndQueue — lock acquisition', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('lsr-lock-');
    queueDir = await makeTempDir('lsr-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  it('throws if agentId not provided', async () => {
    await assert.rejects(
      () => runWithLockAndQueue('', makeTaskInfo(), () => {}, { lockDir, queueDir }),
      /agentId is required/
    );
  });

  it('throws if taskInfo not provided', async () => {
    await assert.rejects(
      () => runWithLockAndQueue('agent-x', null, () => {}, { lockDir, queueDir }),
      /taskInfo is required/
    );
  });

  it('throws if taskInfo.taskId not provided', async () => {
    await assert.rejects(
      () => runWithLockAndQueue('agent-x', { type: 'heartbeat' }, () => {}, { lockDir, queueDir }),
      /taskInfo.taskId is required/
    );
  });

  it('throws if executeFn is not a function', async () => {
    await assert.rejects(
      () => runWithLockAndQueue('agent-x', makeTaskInfo(), 'not-fn', { lockDir, queueDir }),
      /executeFn must be a function/
    );
  });

  it('acquires lock and executes task when agent is unlocked', async () => {
    const agentId = `agent-${uid()}`;
    const taskInfo = makeTaskInfo();
    const executor = createMockExecutor({ result: { output: 'success' } });

    const result = await runWithLockAndQueue(agentId, taskInfo, executor, { lockDir, queueDir });

    assert.equal(result.status, 'executed');
    assert.equal(result.agentId, agentId);
    assert.equal(result.taskId, taskInfo.taskId);
    assert.deepEqual(result.sessionResult, { output: 'success' });
    assert.ok(result.startedAt);
    assert.equal(executor.calls.length, 1);
    assert.equal(executor.calls[0].agentId, agentId);
    assert.equal(executor.calls[0].taskInfo.taskId, taskInfo.taskId);
  });

  it('releases lock after successful execution', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor();

    await runWithLockAndQueue(agentId, makeTaskInfo(), executor, { lockDir, queueDir });

    const lockState = await queryLock(agentId, { lockDir });
    assert.equal(lockState.locked, false);
    assert.equal(lockState.status, 'absent');
  });

  it('releases lock after execution error', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor({ error: new Error('boom') });

    const result = await runWithLockAndQueue(agentId, makeTaskInfo(), executor, { lockDir, queueDir });

    assert.equal(result.status, 'error');
    assert.ok(result.error);
    assert.ok(result.reason.includes('boom'));

    const lockState = await queryLock(agentId, { lockDir });
    assert.equal(lockState.locked, false);
  });
});

// ---------------------------------------------------------------------------
// runWithLockAndQueue — task queuing when locked
// ---------------------------------------------------------------------------

describe('runWithLockAndQueue — task queuing on lock contention', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('lsr-q-lock-');
    queueDir = await makeTempDir('lsr-q-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  it('enqueues task when agent lock is already held', async () => {
    const agentId = `agent-${uid()}`;
    const taskInfo = makeTaskInfo();

    // Acquire lock externally to simulate a running session
    await acquireLock(agentId, { lockDir, sessionInfo: { taskId: 'running-task' } });

    const executor = createMockExecutor();
    const result = await runWithLockAndQueue(agentId, taskInfo, executor, { lockDir, queueDir });

    assert.equal(result.status, 'queued');
    assert.equal(result.agentId, agentId);
    assert.equal(result.taskId, taskInfo.taskId);
    assert.ok(result.queueEntry);
    assert.equal(result.queueEntry.taskId, taskInfo.taskId);
    assert.ok(result.queuePosition > 0);
    assert.equal(result.duplicate, false);
    assert.ok(result.reason.includes('enqueued'));
    assert.ok(result.startedAt);

    // Executor should NOT have been called
    assert.equal(executor.calls.length, 0);

    // Verify the queue file has the task
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].taskId, taskInfo.taskId);

    // Clean up
    await releaseLock(agentId, { lockDir });
  });

  it('detects duplicate taskId when enqueuing', async () => {
    const agentId = `agent-${uid()}`;
    const taskInfo = makeTaskInfo({ taskId: 'dup-task-001' });

    // Pre-enqueue the same taskId
    await enqueue({ agentId, taskId: 'dup-task-001', type: 'heartbeat' }, { queueDir });

    // Acquire lock to force queuing path
    await acquireLock(agentId, { lockDir });

    const executor = createMockExecutor();
    const result = await runWithLockAndQueue(agentId, taskInfo, executor, { lockDir, queueDir });

    assert.equal(result.status, 'queued');
    assert.equal(result.duplicate, true);
    assert.ok(result.reason.includes('duplicate'));

    // Queue should still have only 1 entry
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 1);

    await releaseLock(agentId, { lockDir });
  });

  it('sequential attempts for same locked agent queue tasks in order', async () => {
    const agentId = `agent-${uid()}`;
    const task2 = makeTaskInfo({ taskId: 'second-task' });
    const task3 = makeTaskInfo({ taskId: 'third-task' });

    // Pre-acquire the lock externally to simulate a running session
    await acquireLock(agentId, { lockDir, sessionInfo: { taskId: 'first-task' } });

    const executor = createMockExecutor();

    // Sequential attempts — both should be queued since the lock is held
    const r2 = await runWithLockAndQueue(agentId, task2, executor, { lockDir, queueDir });
    const r3 = await runWithLockAndQueue(agentId, task3, executor, { lockDir, queueDir });

    assert.equal(r2.status, 'queued');
    assert.equal(r3.status, 'queued');
    assert.equal(executor.calls.length, 0);

    // Queue should have 2 tasks
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 2);
    const queuedIds = queue.map((q) => q.taskId);
    assert.ok(queuedIds.includes('second-task'));
    assert.ok(queuedIds.includes('third-task'));

    await releaseLock(agentId, { lockDir });
  });

  it('preserves task priority and payload when enqueuing', async () => {
    const agentId = `agent-${uid()}`;
    const taskInfo = makeTaskInfo({
      priority: 5,
      payload: { key: 'value', nested: { a: 1 } },
      source: 'agent:other-bot',
    });

    await acquireLock(agentId, { lockDir });

    await runWithLockAndQueue(agentId, taskInfo, createMockExecutor(), { lockDir, queueDir });

    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue[0].priority, 5);
    assert.deepEqual(queue[0].payload, { key: 'value', nested: { a: 1 } });
    assert.equal(queue[0].source, 'agent:other-bot');

    await releaseLock(agentId, { lockDir });
  });
});

// ---------------------------------------------------------------------------
// drainQueuedTasks
// ---------------------------------------------------------------------------

describe('drainQueuedTasks', () => {
  let queueDir;

  beforeEach(async () => {
    queueDir = await makeTempDir('lsr-drain-');
  });

  afterEach(async () => {
    await rm(queueDir, { recursive: true, force: true });
  });

  it('throws if agentId not provided', async () => {
    await assert.rejects(
      () => drainQueuedTasks('', () => {}),
      /agentId is required/
    );
  });

  it('throws if executeFn is not a function', async () => {
    await assert.rejects(
      () => drainQueuedTasks('agent-x', 'not-fn'),
      /executeFn must be a function/
    );
  });

  it('returns empty array when queue is empty', async () => {
    const results = await drainQueuedTasks(`agent-${uid()}`, createMockExecutor(), { queueDir });
    assert.deepEqual(results, []);
  });

  it('executes queued tasks in priority order', async () => {
    const agentId = `agent-${uid()}`;

    // Enqueue tasks with different priorities
    await enqueue({ agentId, taskId: 'low-task', type: 'heartbeat', priority: 1, payload: {} }, { queueDir });
    await enqueue({ agentId, taskId: 'high-task', type: 'heartbeat', priority: 5, payload: {} }, { queueDir });
    await enqueue({ agentId, taskId: 'mid-task', type: 'heartbeat', priority: 3, payload: {} }, { queueDir });

    const executor = createMockExecutor();
    const results = await drainQueuedTasks(agentId, executor, { queueDir });

    assert.equal(results.length, 3);
    // Highest priority first
    assert.equal(results[0].taskId, 'high-task');
    assert.equal(results[1].taskId, 'mid-task');
    assert.equal(results[2].taskId, 'low-task');
    assert.ok(results.every((r) => r.status === 'executed'));
  });

  it('empties the queue after draining', async () => {
    const agentId = `agent-${uid()}`;
    await enqueue({ agentId, taskId: 'drain-me', type: 'heartbeat', payload: {} }, { queueDir });

    await drainQueuedTasks(agentId, createMockExecutor(), { queueDir });

    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 0);
  });

  it('continues draining even if one task errors', async () => {
    const agentId = `agent-${uid()}`;
    await enqueue({ agentId, taskId: 'good-1', type: 'heartbeat', priority: 5, payload: {} }, { queueDir });
    await enqueue({ agentId, taskId: 'bad-task', type: 'heartbeat', priority: 3, payload: {} }, { queueDir });
    await enqueue({ agentId, taskId: 'good-2', type: 'heartbeat', priority: 1, payload: {} }, { queueDir });

    let callCount = 0;
    const executor = async (agentId, taskInfo) => {
      callCount++;
      if (taskInfo.taskId === 'bad-task') throw new Error('task failed');
      return { completed: true };
    };

    const results = await drainQueuedTasks(agentId, executor, { queueDir });

    assert.equal(results.length, 3);
    assert.equal(callCount, 3);

    assert.equal(results[0].status, 'executed'); // good-1 (priority 5)
    assert.equal(results[1].status, 'error');    // bad-task (priority 3)
    assert.ok(results[1].error.message.includes('task failed'));
    assert.equal(results[2].status, 'executed'); // good-2 (priority 1)

    // Queue should be empty
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 0);
  });

  it('passes task metadata to executor', async () => {
    const agentId = `agent-${uid()}`;
    await enqueue({
      agentId,
      taskId: 'meta-task',
      type: 'delegated',
      priority: 4,
      payload: { action: 'review' },
      source: 'agent:reviewer',
    }, { queueDir });

    const executor = createMockExecutor();
    await drainQueuedTasks(agentId, executor, { queueDir });

    assert.equal(executor.calls.length, 1);
    assert.equal(executor.calls[0].taskInfo.taskId, 'meta-task');
    assert.equal(executor.calls[0].taskInfo.type, 'delegated');
    assert.equal(executor.calls[0].taskInfo.priority, 4);
    assert.deepEqual(executor.calls[0].taskInfo.payload, { action: 'review' });
    assert.equal(executor.calls[0].taskInfo.source, 'agent:reviewer');
  });
});

// ---------------------------------------------------------------------------
// runWithLockAndQueue — automatic queue draining after execution
// ---------------------------------------------------------------------------

describe('runWithLockAndQueue — queue draining', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('lsr-qdrain-lock-');
    queueDir = await makeTempDir('lsr-qdrain-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  it('drains queued tasks after primary task execution', async () => {
    const agentId = `agent-${uid()}`;

    // Pre-enqueue some tasks
    await enqueue({ agentId, taskId: 'queued-1', type: 'heartbeat', payload: {} }, { queueDir });
    await enqueue({ agentId, taskId: 'queued-2', type: 'heartbeat', payload: {} }, { queueDir });

    const executor = createMockExecutor();
    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo({ taskId: 'primary-task' }),
      executor,
      { lockDir, queueDir }
    );

    assert.equal(result.status, 'executed');
    assert.equal(result.taskId, 'primary-task');
    assert.ok(result.drainResults);
    assert.equal(result.drainResults.length, 2);
    assert.ok(result.drainResults.every((r) => r.status === 'executed'));

    // Total calls: 1 primary + 2 drained
    assert.equal(executor.calls.length, 3);

    // Queue should be empty after drain
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 0);
  });

  it('does not include drainResults when no queued tasks', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor();

    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir }
    );

    assert.equal(result.status, 'executed');
    assert.equal(result.drainResults, undefined);
    assert.equal(executor.calls.length, 1);
  });

  it('skips queue drain when drainQueue=false', async () => {
    const agentId = `agent-${uid()}`;

    // Pre-enqueue
    await enqueue({ agentId, taskId: 'queued-skip', type: 'heartbeat', payload: {} }, { queueDir });

    const executor = createMockExecutor();
    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir, drainQueue: false }
    );

    assert.equal(result.status, 'executed');
    assert.equal(result.drainResults, undefined);
    assert.equal(executor.calls.length, 1);

    // Queue still has the task
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 1);
  });

  it('does not drain queue when primary task errors', async () => {
    const agentId = `agent-${uid()}`;

    await enqueue({ agentId, taskId: 'queued-after-err', type: 'heartbeat', payload: {} }, { queueDir });

    const executor = createMockExecutor({ error: new Error('primary failed') });
    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir }
    );

    assert.equal(result.status, 'error');

    // Queue should still have the task (not drained)
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].taskId, 'queued-after-err');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('runWithLockAndQueue — idempotency', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('lsr-idem-lock-');
    queueDir = await makeTempDir('lsr-idem-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  it('repeated calls with no lock contention execute independently', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor();

    const r1 = await runWithLockAndQueue(agentId, makeTaskInfo({ taskId: 'run-1' }), executor, { lockDir, queueDir });
    const r2 = await runWithLockAndQueue(agentId, makeTaskInfo({ taskId: 'run-2' }), executor, { lockDir, queueDir });

    assert.equal(r1.status, 'executed');
    assert.equal(r2.status, 'executed');
    assert.equal(executor.calls.length, 2);
  });

  it('duplicate taskId in queue is rejected (no double-enqueue)', async () => {
    const agentId = `agent-${uid()}`;
    const taskId = `dup-${uid()}`;

    // Hold the lock
    await acquireLock(agentId, { lockDir });

    const executor = createMockExecutor();
    const r1 = await runWithLockAndQueue(agentId, makeTaskInfo({ taskId }), executor, { lockDir, queueDir });
    const r2 = await runWithLockAndQueue(agentId, makeTaskInfo({ taskId }), executor, { lockDir, queueDir });

    assert.equal(r1.status, 'queued');
    assert.equal(r1.duplicate, false);
    assert.equal(r2.status, 'queued');
    assert.equal(r2.duplicate, true);

    // Queue has only 1 entry
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 1);

    await releaseLock(agentId, { lockDir });
  });
});

// ---------------------------------------------------------------------------
// runAllWithLockAndQueue
// ---------------------------------------------------------------------------

describe('runAllWithLockAndQueue', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('lsr-all-lock-');
    queueDir = await makeTempDir('lsr-all-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  it('throws if agentTasks is not an array', async () => {
    await assert.rejects(
      () => runAllWithLockAndQueue('not-array', () => {}),
      /agentTasks must be an array/
    );
  });

  it('throws if executeFn is not a function', async () => {
    await assert.rejects(
      () => runAllWithLockAndQueue([], 'not-fn'),
      /executeFn must be a function/
    );
  });

  it('runs multiple agents in parallel with independent locks', async () => {
    const agent1 = `agent-${uid()}`;
    const agent2 = `agent-${uid()}`;
    const executor = createMockExecutor();

    const results = await runAllWithLockAndQueue(
      [
        { agentId: agent1, taskInfo: makeTaskInfo({ taskId: 'a1-task' }) },
        { agentId: agent2, taskInfo: makeTaskInfo({ taskId: 'a2-task' }) },
      ],
      executor,
      { lockDir, queueDir }
    );

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'executed'));

    const r1 = results.find((r) => r.agentId === agent1);
    const r2 = results.find((r) => r.agentId === agent2);
    assert.equal(r1.taskId, 'a1-task');
    assert.equal(r2.taskId, 'a2-task');

    // Both locks released
    const l1 = await queryLock(agent1, { lockDir });
    const l2 = await queryLock(agent2, { lockDir });
    assert.equal(l1.locked, false);
    assert.equal(l2.locked, false);
  });

  it('returns empty array for empty input', async () => {
    const results = await runAllWithLockAndQueue([], createMockExecutor(), { lockDir, queueDir });
    assert.deepEqual(results, []);
  });

  it('one agent locked does not affect other agents', async () => {
    const lockedAgent = `agent-${uid()}`;
    const freeAgent = `agent-${uid()}`;

    // Lock one agent externally
    await acquireLock(lockedAgent, { lockDir });

    const executor = createMockExecutor();
    const results = await runAllWithLockAndQueue(
      [
        { agentId: lockedAgent, taskInfo: makeTaskInfo({ taskId: 'locked-task' }) },
        { agentId: freeAgent, taskInfo: makeTaskInfo({ taskId: 'free-task' }) },
      ],
      executor,
      { lockDir, queueDir }
    );

    const locked = results.find((r) => r.agentId === lockedAgent);
    const free = results.find((r) => r.agentId === freeAgent);

    assert.equal(locked.status, 'queued');
    assert.equal(free.status, 'executed');

    await releaseLock(lockedAgent, { lockDir });
  });
});

// ---------------------------------------------------------------------------
// createLockedSessionRunner (factory)
// ---------------------------------------------------------------------------

describe('createLockedSessionRunner', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('lsr-factory-lock-');
    queueDir = await makeTempDir('lsr-factory-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  it('creates a runner with bound configuration', () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    assert.equal(runner.lockDir, lockDir);
    assert.equal(runner.queueDir, queueDir);
    assert.equal(typeof runner.run, 'function');
    assert.equal(typeof runner.runAll, 'function');
    assert.equal(typeof runner.drain, 'function');
    assert.equal(typeof runner.queryLock, 'function');
    assert.equal(typeof runner.queueLength, 'function');
    assert.equal(typeof runner.peek, 'function');
  });

  it('run() executes task with lock isolation', async () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor();

    const result = await runner.run(agentId, makeTaskInfo(), executor);

    assert.equal(result.status, 'executed');
    assert.equal(executor.calls.length, 1);
  });

  it('run() enqueues when locked', async () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    const agentId = `agent-${uid()}`;

    await acquireLock(agentId, { lockDir });

    const result = await runner.run(agentId, makeTaskInfo(), createMockExecutor());
    assert.equal(result.status, 'queued');

    await releaseLock(agentId, { lockDir });
  });

  it('queryLock() returns lock state', async () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    const agentId = `agent-${uid()}`;

    const before = await runner.queryLock(agentId);
    assert.equal(before.locked, false);

    await acquireLock(agentId, { lockDir });

    const after = await runner.queryLock(agentId);
    assert.equal(after.locked, true);

    await releaseLock(agentId, { lockDir });
  });

  it('queueLength() returns correct count', async () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    const agentId = `agent-${uid()}`;

    assert.equal(await runner.queueLength(agentId), 0);

    await enqueue({ agentId, taskId: 'q1', type: 'heartbeat', payload: {} }, { queueDir });
    await enqueue({ agentId, taskId: 'q2', type: 'heartbeat', payload: {} }, { queueDir });

    assert.equal(await runner.queueLength(agentId), 2);
  });

  it('peek() shows next queued task', async () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    const agentId = `agent-${uid()}`;

    const empty = await runner.peek(agentId);
    assert.equal(empty.hasTask, false);

    await enqueue({ agentId, taskId: 'peek-me', type: 'heartbeat', priority: 5, payload: {} }, { queueDir });

    const peeked = await runner.peek(agentId);
    assert.equal(peeked.hasTask, true);
    assert.equal(peeked.entry.taskId, 'peek-me');
  });

  it('drain() processes queued tasks', async () => {
    const runner = createLockedSessionRunner({ lockDir, queueDir });
    const agentId = `agent-${uid()}`;

    await enqueue({ agentId, taskId: 'drain-1', type: 'heartbeat', payload: {} }, { queueDir });

    const executor = createMockExecutor();
    const results = await runner.drain(agentId, executor);

    assert.equal(results.length, 1);
    assert.equal(results[0].taskId, 'drain-1');
    assert.equal(results[0].status, 'executed');
  });
});

// ---------------------------------------------------------------------------
// Execution isolation — cross-agent independence
// ---------------------------------------------------------------------------

describe('execution isolation — cross-agent independence', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('lsr-iso-lock-');
    queueDir = await makeTempDir('lsr-iso-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  it('different agents have independent locks and queues', async () => {
    const agentA = `agent-${uid()}`;
    const agentB = `agent-${uid()}`;

    // Lock agent A
    await acquireLock(agentA, { lockDir });

    const executor = createMockExecutor();

    // Agent A task → queued (locked)
    const rA = await runWithLockAndQueue(agentA, makeTaskInfo({ taskId: 'a-task' }), executor, { lockDir, queueDir });
    // Agent B task → executed (not locked)
    const rB = await runWithLockAndQueue(agentB, makeTaskInfo({ taskId: 'b-task' }), executor, { lockDir, queueDir });

    assert.equal(rA.status, 'queued');
    assert.equal(rB.status, 'executed');

    // Agent A queue has 1, Agent B queue has 0
    const qA = await readQueue(agentA, { queueDir });
    const qB = await readQueue(agentB, { queueDir });
    assert.equal(qA.length, 1);
    assert.equal(qB.length, 0);

    await releaseLock(agentA, { lockDir });
  });

  it('stale locks are replaced — not treated as active', async () => {
    const agentId = `agent-${uid()}`;

    // Acquire a lock and then manually set it to stale (maxLockAgeMs=1ms)
    const executor = createMockExecutor();
    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir, maxLockAgeMs: 1 }
    );

    // Should execute, not queue (stale lock replaced)
    assert.equal(result.status, 'executed');
  });
});

// ---------------------------------------------------------------------------
// Resume guard — runWithLockAndQueue skips paused agents
// ---------------------------------------------------------------------------

describe('runWithLockAndQueue resume guard (paused agents)', () => {
  let lockDir;
  let queueDir;

  beforeEach(async () => {
    lockDir = await makeTempDir('lsr-pause-lock-');
    queueDir = await makeTempDir('lsr-pause-queue-');
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
    await rm(queueDir, { recursive: true, force: true });
  });

  function mockAgentStore(paused) {
    return {
      load: async () => ({
        id: 'agent-test',
        budget: { paused, weeklyTokenLimit: 100000, currentUsage: 0, periodStart: new Date().toISOString() },
      }),
    };
  }

  it('skips execution when agent is paused — no lock acquired', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor();

    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir, agentStore: mockAgentStore(true) }
    );

    assert.equal(result.status, 'skipped');
    assert.ok(result.reason.includes('paused'));
    assert.equal(result.pausedReason, 'budget_exhausted');
    assert.equal(result.agentId, agentId);
    assert.ok(result.startedAt);

    // Executor was never called
    assert.equal(executor.calls.length, 0);

    // Lock was never acquired
    const lockState = await queryLock(agentId, { lockDir });
    assert.equal(lockState.locked, false);
  });

  it('proceeds normally when agent is NOT paused', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor();

    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir, agentStore: mockAgentStore(false) }
    );

    assert.equal(result.status, 'executed');
    assert.equal(executor.calls.length, 1);
  });

  it('proceeds normally when agentStore is not provided (backward compatible)', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor();

    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir }
    );

    assert.equal(result.status, 'executed');
  });

  it('gracefully degrades if agentStore.load throws', async () => {
    const agentId = `agent-${uid()}`;
    const executor = createMockExecutor();

    const brokenStore = {
      load: async () => { throw new Error('store unavailable'); },
    };

    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir, agentStore: brokenStore }
    );

    // Should proceed (graceful degradation)
    assert.equal(result.status, 'executed');
    assert.equal(executor.calls.length, 1);
  });

  it('paused check runs before lock acquisition — no lock contention for paused agents', async () => {
    const agentId = `agent-${uid()}`;

    // Pre-acquire lock to prove we never try to acquire it
    await acquireLock(agentId, { lockDir });

    const executor = createMockExecutor();
    const result = await runWithLockAndQueue(
      agentId,
      makeTaskInfo(),
      executor,
      { lockDir, queueDir, agentStore: mockAgentStore(true) }
    );

    // Paused check returns before hitting the lock
    assert.equal(result.status, 'skipped');
    assert.ok(result.reason.includes('paused'));

    // Task was NOT enqueued (paused, not locked-and-queued)
    const queue = await readQueue(agentId, { queueDir });
    assert.equal(queue.length, 0);

    await releaseLock(agentId, { lockDir });
  });
});

// ---------------------------------------------------------------------------
// createDispatchingExecutor — daily-review dispatch
// ---------------------------------------------------------------------------

describe('createDispatchingExecutor', () => {
  it('throws if normalExecuteFn is not a function', () => {
    assert.throws(
      () => createDispatchingExecutor('not-fn'),
      /normalExecuteFn must be a function/,
    );
  });

  it('routes normal tasks to normalExecuteFn', async () => {
    const normalCalls = [];
    const reviewCalls = [];

    const normalFn = async (agentId, taskInfo) => {
      normalCalls.push({ agentId, taskInfo });
      return { result: 'normal' };
    };
    const reviewFn = async (agentId, taskInfo) => {
      reviewCalls.push({ agentId, taskInfo });
      return { result: 'review' };
    };

    const executor = createDispatchingExecutor(normalFn, { dailyReviewExecuteFn: reviewFn });

    const result = await executor('agent-1', {
      taskId: 'task-work-01',
      objectiveId: 'obj-some-work',
    });

    assert.deepEqual(result, { result: 'normal' });
    assert.equal(normalCalls.length, 1);
    assert.equal(reviewCalls.length, 0);
  });

  it('routes daily-review tasks (top-level objectiveId) to dailyReviewExecuteFn', async () => {
    const normalCalls = [];
    const reviewCalls = [];

    const normalFn = async (_a, ti) => { normalCalls.push(ti); return {}; };
    const reviewFn = async (_a, ti) => { reviewCalls.push(ti); return { result: 'daily-review' }; };

    const executor = createDispatchingExecutor(normalFn, { dailyReviewExecuteFn: reviewFn });

    const taskInfo = {
      taskId: 'task-dr-01',
      objectiveId: DAILY_REVIEW_OBJECTIVE_ID,
    };
    const result = await executor('agent-1', taskInfo);

    assert.deepEqual(result, { result: 'daily-review' });
    assert.equal(reviewCalls.length, 1);
    assert.equal(normalCalls.length, 0);
    assert.equal(reviewCalls[0].taskId, 'task-dr-01');
  });

  it('routes daily-review tasks (nested payload.objectiveId) to dailyReviewExecuteFn', async () => {
    const normalCalls = [];
    const reviewCalls = [];

    const normalFn = async (_a, ti) => { normalCalls.push(ti); return {}; };
    const reviewFn = async (_a, ti) => { reviewCalls.push(ti); return { result: 'review-via-payload' }; };

    const executor = createDispatchingExecutor(normalFn, { dailyReviewExecuteFn: reviewFn });

    // objectiveId nested in payload (legacy / alternate callers)
    const taskInfo = {
      taskId: 'task-dr-02',
      payload: { objectiveId: DAILY_REVIEW_OBJECTIVE_ID },
    };
    const result = await executor('agent-1', taskInfo);

    assert.deepEqual(result, { result: 'review-via-payload' });
    assert.equal(reviewCalls.length, 1);
    assert.equal(normalCalls.length, 0);
  });

  it('falls through to normalExecuteFn when no dailyReviewExecuteFn is provided', async () => {
    const normalCalls = [];
    const normalFn = async (_a, ti) => { normalCalls.push(ti); return { result: 'fallthrough' }; };

    const executor = createDispatchingExecutor(normalFn); // no opts

    const result = await executor('agent-1', {
      taskId: 'task-dr-03',
      objectiveId: DAILY_REVIEW_OBJECTIVE_ID,
    });

    // No handler registered → falls through to normalFn
    assert.deepEqual(result, { result: 'fallthrough' });
    assert.equal(normalCalls.length, 1);
  });

  it('forwards agentId and taskInfo unchanged to the routed handler', async () => {
    let capturedAgentId;
    let capturedTaskInfo;

    const reviewFn = async (agentId, taskInfo) => {
      capturedAgentId = agentId;
      capturedTaskInfo = taskInfo;
      return {};
    };
    const executor = createDispatchingExecutor(async () => ({}), { dailyReviewExecuteFn: reviewFn });

    const taskInfo = {
      taskId: 'task-dr-04',
      objectiveId: DAILY_REVIEW_OBJECTIVE_ID,
      priority: 3,
      payload: { runAt: '2026-04-14T17:00:00.000Z' },
    };
    await executor('agent-xyz', taskInfo);

    assert.equal(capturedAgentId, 'agent-xyz');
    assert.deepEqual(capturedTaskInfo, taskInfo);
  });

  it('top-level objectiveId takes precedence over payload.objectiveId', async () => {
    const normalCalls = [];
    const reviewCalls = [];

    const normalFn = async (_a, ti) => { normalCalls.push(ti); return {}; };
    const reviewFn = async (_a, ti) => { reviewCalls.push(ti); return {}; };

    const executor = createDispatchingExecutor(normalFn, { dailyReviewExecuteFn: reviewFn });

    // top-level objectiveId is a non-review id; payload has the review id — top-level wins
    await executor('agent-1', {
      taskId: 'task-conflict-01',
      objectiveId: 'obj-regular-work',
      payload: { objectiveId: DAILY_REVIEW_OBJECTIVE_ID },
    });

    assert.equal(normalCalls.length, 1);
    assert.equal(reviewCalls.length, 0);
  });

  it('works as a drop-in executeFn inside runWithLockAndQueue', async () => {
    const { mkdtemp: mk, rm: rmd } = await import('node:fs/promises');
    const { join: pj } = await import('node:path');
    const { tmpdir: td } = await import('node:os');
    const lockDir2 = await mk(pj(td(), 'lsr-disp-lk-'));
    const queueDir2 = await mk(pj(td(), 'lsr-disp-q-'));

    try {
      const reviewCalls = [];
      const normalCalls = [];

      const normalFn = async (_a, ti) => { normalCalls.push(ti); return { type: 'normal' }; };
      const reviewFn = async (_a, ti) => { reviewCalls.push(ti); return { type: 'review' }; };

      const executor = createDispatchingExecutor(normalFn, { dailyReviewExecuteFn: reviewFn });

      const agentId = `agent-${uid()}`;
      const reviewTaskInfo = {
        taskId: `task-${uid()}`,
        objectiveId: DAILY_REVIEW_OBJECTIVE_ID,
        type: 'heartbeat',
        priority: 2,
      };

      const result = await runWithLockAndQueue(agentId, reviewTaskInfo, executor, {
        lockDir: lockDir2,
        queueDir: queueDir2,
      });

      assert.equal(result.status, 'executed');
      assert.deepEqual(result.sessionResult, { type: 'review' });
      assert.equal(reviewCalls.length, 1);
      assert.equal(normalCalls.length, 0);
    } finally {
      await rmd(lockDir2, { recursive: true, force: true });
      await rmd(queueDir2, { recursive: true, force: true });
    }
  });

  it('dispatching executor works correctly inside drainQueuedTasks', async () => {
    const { mkdtemp: mk, rm: rmd } = await import('node:fs/promises');
    const { join: pj } = await import('node:path');
    const { tmpdir: td } = await import('node:os');
    const queueDir2 = await mk(pj(td(), 'lsr-disp-drain-'));

    try {
      const reviewCalls = [];
      const normalCalls = [];

      const normalFn = async (_a, ti) => { normalCalls.push(ti); return { type: 'normal' }; };
      const reviewFn = async (_a, ti) => { reviewCalls.push(ti); return { type: 'review' }; };

      const executor = createDispatchingExecutor(normalFn, { dailyReviewExecuteFn: reviewFn });

      const agentId = `agent-${uid()}`;

      // Enqueue a mix: one daily-review, one normal.
      // drainQueuedTasks passes objectiveId via payload (the queue entry's
      // payload field is the only user-data envelope that survives dequeue).
      await enqueue({
        agentId,
        taskId: `task-dr-${uid()}`,
        type: 'heartbeat',
        priority: 2,
        payload: { objectiveId: DAILY_REVIEW_OBJECTIVE_ID },
      }, { queueDir: queueDir2 });
      await enqueue({
        agentId,
        taskId: `task-work-${uid()}`,
        type: 'heartbeat',
        priority: 1,
        payload: { objectiveId: 'obj-regular' },
      }, { queueDir: queueDir2 });

      const results = await drainQueuedTasks(agentId, executor, { queueDir: queueDir2 });

      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.status === 'executed'));

      // The daily-review task went to reviewFn, normal to normalFn
      assert.equal(reviewCalls.length, 1);
      assert.equal(normalCalls.length, 1);
    } finally {
      await rmd(queueDir2, { recursive: true, force: true });
    }
  });
});
