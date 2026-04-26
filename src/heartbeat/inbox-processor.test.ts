/**
 * Tests for inbox-processor — delegated tasks picked up on recipient's next heartbeat.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  sortInboxByPriority,
  inboxMessageToTask,
  pickupInboxTasks,
  completeInboxTask,
  failInboxTask,
  extractInboxMessageId,
  isInboxTask,
  processInboxOnHeartbeat,
} from './inbox-processor.js';
import { InboxStore } from '../storage/inbox-store.js';
import { createInboxMessage } from '../models/agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => randomBytes(4).toString('hex');

function makeMessage(overrides = {}) {
  const from = overrides.from || `agent-${uid()}`;
  const to = overrides.to || `agent-${uid()}`;
  const desc = overrides.taskDescription || `Do task ${uid()}`;
  return createInboxMessage(from, to, desc, {
    priority: overrides.priority || 'medium',
    context: overrides.context,
    sourceTaskId: overrides.sourceTaskId,
  });
}

async function makeTempDir(prefix = 'aweek-inbox-proc-') {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// sortInboxByPriority
// ---------------------------------------------------------------------------

describe('sortInboxByPriority', () => {
  it('sorts by priority: critical > high > medium > low', () => {
    const msgs = [
      { priority: 'low', createdAt: '2026-01-01T00:00:00Z' },
      { priority: 'critical', createdAt: '2026-01-01T00:00:00Z' },
      { priority: 'medium', createdAt: '2026-01-01T00:00:00Z' },
      { priority: 'high', createdAt: '2026-01-01T00:00:00Z' },
    ];
    const sorted = sortInboxByPriority(msgs);
    assert.deepEqual(
      sorted.map((m) => m.priority),
      ['critical', 'high', 'medium', 'low']
    );
  });

  it('uses FIFO (createdAt) within same priority', () => {
    const msgs = [
      { priority: 'high', createdAt: '2026-01-03T00:00:00Z', id: 'c' },
      { priority: 'high', createdAt: '2026-01-01T00:00:00Z', id: 'a' },
      { priority: 'high', createdAt: '2026-01-02T00:00:00Z', id: 'b' },
    ];
    const sorted = sortInboxByPriority(msgs);
    assert.deepEqual(
      sorted.map((m) => m.id),
      ['a', 'b', 'c']
    );
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(sortInboxByPriority([]), []);
  });

  it('does not mutate the original array', () => {
    const msgs = [
      { priority: 'low', createdAt: '2026-01-01T00:00:00Z' },
      { priority: 'critical', createdAt: '2026-01-01T00:00:00Z' },
    ];
    const original = [...msgs];
    sortInboxByPriority(msgs);
    assert.deepEqual(msgs, original);
  });
});

// ---------------------------------------------------------------------------
// inboxMessageToTask
// ---------------------------------------------------------------------------

describe('inboxMessageToTask', () => {
  it('converts inbox message to task descriptor', () => {
    const msg = makeMessage({
      from: 'agent-sender',
      to: 'agent-receiver',
      taskDescription: 'Write a report',
      priority: 'high',
      context: 'Extra info',
      sourceTaskId: 'task-abc123def',
    });

    const task = inboxMessageToTask(msg);

    assert.equal(task.taskId, `inbox-${msg.id}`);
    assert.equal(task.type, 'delegated');
    assert.equal(task.priority, 4); // high → 4
    assert.equal(task.payload.description, 'Write a report');
    assert.equal(task.payload.context, 'Extra info');
    assert.equal(task.payload.sourceTaskId, 'task-abc123def');
    assert.equal(task.payload.delegatedFrom, 'agent-sender');
    assert.equal(task.payload.delegatedTo, 'agent-receiver');
    assert.equal(task.payload.inboxMessageId, msg.id);
    assert.equal(task.source, 'agent:agent-sender');
  });

  it('maps priority levels correctly', () => {
    const priorities = { critical: 5, high: 4, medium: 3, low: 2 };
    for (const [strPri, numPri] of Object.entries(priorities)) {
      const msg = makeMessage({ priority: strPri });
      const task = inboxMessageToTask(msg);
      assert.equal(task.priority, numPri, `${strPri} should map to ${numPri}`);
    }
  });

  it('throws on invalid message (missing id)', () => {
    assert.throws(() => inboxMessageToTask(null), /Invalid inbox message/);
    assert.throws(() => inboxMessageToTask({}), /Invalid inbox message/);
  });

  it('omits undefined optional fields', () => {
    const msg = makeMessage(); // no context, no sourceTaskId
    const task = inboxMessageToTask(msg);
    assert.equal(task.payload.context, undefined);
    assert.equal(task.payload.sourceTaskId, undefined);
  });
});

// ---------------------------------------------------------------------------
// extractInboxMessageId
// ---------------------------------------------------------------------------

describe('extractInboxMessageId', () => {
  it('extracts message ID from inbox task ID', () => {
    assert.equal(extractInboxMessageId('inbox-msg-abc123'), 'msg-abc123');
  });

  it('returns null for non-inbox task IDs', () => {
    assert.equal(extractInboxMessageId('task-abc'), null);
    assert.equal(extractInboxMessageId(''), null);
    assert.equal(extractInboxMessageId(null), null);
    assert.equal(extractInboxMessageId(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// isInboxTask
// ---------------------------------------------------------------------------

describe('isInboxTask', () => {
  it('returns true for delegated type', () => {
    assert.equal(isInboxTask({ type: 'delegated', taskId: 'whatever' }), true);
  });

  it('returns true for inbox- prefixed taskId', () => {
    assert.equal(isInboxTask({ type: 'heartbeat', taskId: 'inbox-msg-abc' }), true);
  });

  it('returns false for regular tasks', () => {
    assert.equal(isInboxTask({ type: 'heartbeat', taskId: 'task-abc' }), false);
  });

  it('returns false for null/undefined', () => {
    assert.equal(isInboxTask(null), false);
    assert.equal(isInboxTask(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// pickupInboxTasks
// ---------------------------------------------------------------------------

describe('pickupInboxTasks', () => {
  let dataDir;
  let inboxStore;

  beforeEach(async () => {
    dataDir = await makeTempDir();
    inboxStore = new InboxStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('throws if agentId missing', async () => {
    await assert.rejects(() => pickupInboxTasks('', inboxStore), /agentId is required/);
  });

  it('throws if inboxStore missing', async () => {
    await assert.rejects(() => pickupInboxTasks('agent-x', null), /inboxStore is required/);
  });

  it('returns empty results when no pending messages', async () => {
    const agentId = `agent-${uid()}`;
    await inboxStore.init(agentId);

    const result = await pickupInboxTasks(agentId, inboxStore);

    assert.equal(result.agentId, agentId);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.acceptedCount, 0);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.errors, []);
    assert.ok(result.processedAt);
  });

  it('picks up pending messages and marks them accepted', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });

    await inboxStore.enqueue(agentId, msg);

    const result = await pickupInboxTasks(agentId, inboxStore);

    assert.equal(result.pendingCount, 1);
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].taskId, `inbox-${msg.id}`);
    assert.equal(result.tasks[0].type, 'delegated');

    // Verify message was marked as accepted in the store
    const updated = await inboxStore.get(agentId, msg.id);
    assert.equal(updated.status, 'accepted');
    assert.ok(updated.processedAt);
  });

  it('picks up multiple messages in priority order', async () => {
    const agentId = `agent-${uid()}`;
    const lowMsg = makeMessage({ to: agentId, priority: 'low', taskDescription: 'low task' });
    const criticalMsg = makeMessage({ to: agentId, priority: 'critical', taskDescription: 'critical task' });
    const highMsg = makeMessage({ to: agentId, priority: 'high', taskDescription: 'high task' });

    await inboxStore.enqueue(agentId, lowMsg);
    await inboxStore.enqueue(agentId, criticalMsg);
    await inboxStore.enqueue(agentId, highMsg);

    const result = await pickupInboxTasks(agentId, inboxStore);

    assert.equal(result.pendingCount, 3);
    assert.equal(result.acceptedCount, 3);
    assert.equal(result.tasks[0].payload.description, 'critical task');
    assert.equal(result.tasks[1].payload.description, 'high task');
    assert.equal(result.tasks[2].payload.description, 'low task');
  });

  it('is idempotent — already-accepted messages are not re-picked', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });

    await inboxStore.enqueue(agentId, msg);

    // First pickup
    const r1 = await pickupInboxTasks(agentId, inboxStore);
    assert.equal(r1.pendingCount, 1);
    assert.equal(r1.acceptedCount, 1);

    // Second pickup — message is now 'accepted', not 'pending'
    const r2 = await pickupInboxTasks(agentId, inboxStore);
    assert.equal(r2.pendingCount, 0);
    assert.equal(r2.acceptedCount, 0);
    assert.deepEqual(r2.tasks, []);
  });

  it('ignores completed and rejected messages', async () => {
    const agentId = `agent-${uid()}`;
    const msg1 = makeMessage({ to: agentId });
    const msg2 = makeMessage({ to: agentId });
    const msg3 = makeMessage({ to: agentId, taskDescription: 'still pending' });

    await inboxStore.enqueue(agentId, msg1);
    await inboxStore.enqueue(agentId, msg2);
    await inboxStore.enqueue(agentId, msg3);

    // Complete and reject first two
    await inboxStore.complete(agentId, msg1.id, 'done');
    await inboxStore.reject(agentId, msg2.id, 'nope');

    const result = await pickupInboxTasks(agentId, inboxStore);

    assert.equal(result.pendingCount, 1);
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.tasks[0].payload.description, 'still pending');
  });

  it('handles errors during acceptance gracefully', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });

    // Create a store that fails on accept
    const brokenStore = {
      pending: async () => [msg],
      accept: async () => { throw new Error('disk error'); },
    };

    const result = await pickupInboxTasks(agentId, brokenStore);

    assert.equal(result.pendingCount, 1);
    assert.equal(result.acceptedCount, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].messageId, msg.id);
    assert.ok(result.errors[0].error.includes('disk error'));
  });
});

// ---------------------------------------------------------------------------
// completeInboxTask / failInboxTask
// ---------------------------------------------------------------------------

describe('completeInboxTask', () => {
  let dataDir;
  let inboxStore;

  beforeEach(async () => {
    dataDir = await makeTempDir();
    inboxStore = new InboxStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('marks message as completed with result', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });
    await inboxStore.enqueue(agentId, msg);
    await inboxStore.accept(agentId, msg.id);

    const updated = await completeInboxTask(agentId, msg.id, inboxStore, 'All done');
    assert.equal(updated.status, 'completed');
    assert.equal(updated.result, 'All done');
    assert.ok(updated.completedAt);
  });

  it('throws on missing parameters', async () => {
    await assert.rejects(() => completeInboxTask('', 'x', inboxStore), /agentId is required/);
    await assert.rejects(() => completeInboxTask('a', '', inboxStore), /messageId is required/);
    await assert.rejects(() => completeInboxTask('a', 'x', null), /inboxStore is required/);
  });
});

describe('failInboxTask', () => {
  let dataDir;
  let inboxStore;

  beforeEach(async () => {
    dataDir = await makeTempDir();
    inboxStore = new InboxStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('marks message as rejected with reason', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });
    await inboxStore.enqueue(agentId, msg);
    await inboxStore.accept(agentId, msg.id);

    const updated = await failInboxTask(agentId, msg.id, inboxStore, 'Timeout');
    assert.equal(updated.status, 'rejected');
    assert.equal(updated.rejectionReason, 'Timeout');
  });

  it('uses default reason when none provided', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });
    await inboxStore.enqueue(agentId, msg);

    const updated = await failInboxTask(agentId, msg.id, inboxStore);
    assert.equal(updated.status, 'rejected');
    assert.equal(updated.rejectionReason, 'Execution failed');
  });

  it('throws on missing parameters', async () => {
    await assert.rejects(() => failInboxTask('', 'x', inboxStore), /agentId is required/);
    await assert.rejects(() => failInboxTask('a', '', inboxStore), /messageId is required/);
    await assert.rejects(() => failInboxTask('a', 'x', null), /inboxStore is required/);
  });
});

// ---------------------------------------------------------------------------
// processInboxOnHeartbeat — full integration
// ---------------------------------------------------------------------------

describe('processInboxOnHeartbeat', () => {
  let dataDir;
  let inboxStore;

  beforeEach(async () => {
    dataDir = await makeTempDir();
    inboxStore = new InboxStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('throws if agentId missing', async () => {
    await assert.rejects(() => processInboxOnHeartbeat('', inboxStore), /agentId is required/);
  });

  it('throws if inboxStore missing', async () => {
    await assert.rejects(() => processInboxOnHeartbeat('agent-x', null), /inboxStore is required/);
  });

  it('returns empty results when no pending messages and no executeFn', async () => {
    const agentId = `agent-${uid()}`;
    await inboxStore.init(agentId);

    const result = await processInboxOnHeartbeat(agentId, inboxStore);

    assert.equal(result.agentId, agentId);
    assert.equal(result.pickup.pendingCount, 0);
    assert.deepEqual(result.executionResults, []);
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
  });

  it('picks up tasks without execution when no executeFn provided', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });
    await inboxStore.enqueue(agentId, msg);

    const result = await processInboxOnHeartbeat(agentId, inboxStore);

    assert.equal(result.pickup.pendingCount, 1);
    assert.equal(result.pickup.acceptedCount, 1);
    assert.deepEqual(result.executionResults, []);

    // Message should be accepted but not completed
    const updated = await inboxStore.get(agentId, msg.id);
    assert.equal(updated.status, 'accepted');
  });

  it('executes tasks and marks them completed on success', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId, taskDescription: 'test task' });
    await inboxStore.enqueue(agentId, msg);

    const executeFn = async (_agentId, taskInfo) => {
      return { output: `Executed: ${taskInfo.payload.description}` };
    };

    const result = await processInboxOnHeartbeat(agentId, inboxStore, executeFn);

    assert.equal(result.pickup.acceptedCount, 1);
    assert.equal(result.executionResults.length, 1);
    assert.equal(result.executionResults[0].status, 'completed');
    assert.equal(result.executionResults[0].messageId, msg.id);
    assert.ok(result.executionResults[0].result);

    // Inbox message should be marked completed
    const updated = await inboxStore.get(agentId, msg.id);
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt);
  });

  it('marks tasks as failed on execution error', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });
    await inboxStore.enqueue(agentId, msg);

    const executeFn = async () => {
      throw new Error('CLI crashed');
    };

    const result = await processInboxOnHeartbeat(agentId, inboxStore, executeFn);

    assert.equal(result.executionResults.length, 1);
    assert.equal(result.executionResults[0].status, 'failed');
    assert.equal(result.executionResults[0].error, 'CLI crashed');

    // Inbox message should be marked rejected
    const updated = await inboxStore.get(agentId, msg.id);
    assert.equal(updated.status, 'rejected');
    assert.equal(updated.rejectionReason, 'CLI crashed');
  });

  it('processes multiple tasks — failure in one does not block others', async () => {
    const agentId = `agent-${uid()}`;
    const msg1 = makeMessage({ to: agentId, priority: 'critical', taskDescription: 'task 1' });
    const msg2 = makeMessage({ to: agentId, priority: 'high', taskDescription: 'will fail' });
    const msg3 = makeMessage({ to: agentId, priority: 'medium', taskDescription: 'task 3' });

    await inboxStore.enqueue(agentId, msg1);
    await inboxStore.enqueue(agentId, msg2);
    await inboxStore.enqueue(agentId, msg3);

    let callCount = 0;
    const executeFn = async (_agentId, taskInfo) => {
      callCount++;
      if (taskInfo.payload.description === 'will fail') {
        throw new Error('Intentional failure');
      }
      return 'success';
    };

    const result = await processInboxOnHeartbeat(agentId, inboxStore, executeFn);

    assert.equal(callCount, 3);
    assert.equal(result.executionResults.length, 3);

    // First task (critical) — completed
    assert.equal(result.executionResults[0].status, 'completed');
    // Second task (high) — failed
    assert.equal(result.executionResults[1].status, 'failed');
    assert.equal(result.executionResults[1].error, 'Intentional failure');
    // Third task (medium) — completed
    assert.equal(result.executionResults[2].status, 'completed');
  });

  it('is idempotent — repeated heartbeats do not re-process accepted tasks', async () => {
    const agentId = `agent-${uid()}`;
    const msg = makeMessage({ to: agentId });
    await inboxStore.enqueue(agentId, msg);

    let execCount = 0;
    const executeFn = async () => { execCount++; return 'done'; };

    // First heartbeat
    const r1 = await processInboxOnHeartbeat(agentId, inboxStore, executeFn);
    assert.equal(r1.pickup.acceptedCount, 1);
    assert.equal(execCount, 1);

    // Second heartbeat — message is now 'completed', not 'pending'
    const r2 = await processInboxOnHeartbeat(agentId, inboxStore, executeFn);
    assert.equal(r2.pickup.pendingCount, 0);
    assert.equal(r2.pickup.acceptedCount, 0);
    assert.equal(execCount, 1); // executeFn was NOT called again
  });

  it('new delegated tasks arriving between heartbeats are picked up', async () => {
    const agentId = `agent-${uid()}`;
    const executeFn = async () => 'done';

    // First heartbeat — empty inbox
    const r1 = await processInboxOnHeartbeat(agentId, inboxStore, executeFn);
    assert.equal(r1.pickup.pendingCount, 0);

    // Delegation arrives between heartbeats
    const newMsg = makeMessage({ to: agentId, taskDescription: 'new delegation' });
    await inboxStore.enqueue(agentId, newMsg);

    // Second heartbeat — picks up the new task
    const r2 = await processInboxOnHeartbeat(agentId, inboxStore, executeFn);
    assert.equal(r2.pickup.pendingCount, 1);
    assert.equal(r2.pickup.acceptedCount, 1);
    assert.equal(r2.executionResults.length, 1);
    assert.equal(r2.executionResults[0].status, 'completed');
  });

  it('handles mixed existing (completed) and new (pending) messages', async () => {
    const agentId = `agent-${uid()}`;
    const executeFn = async () => 'done';

    // Enqueue and process first message
    const oldMsg = makeMessage({ to: agentId, taskDescription: 'old task' });
    await inboxStore.enqueue(agentId, oldMsg);
    await processInboxOnHeartbeat(agentId, inboxStore, executeFn);

    // New message arrives
    const newMsg = makeMessage({ to: agentId, taskDescription: 'new task' });
    await inboxStore.enqueue(agentId, newMsg);

    // Next heartbeat should only pick up the new one
    const result = await processInboxOnHeartbeat(agentId, inboxStore, executeFn);
    assert.equal(result.pickup.pendingCount, 1);
    assert.equal(result.pickup.acceptedCount, 1);
    assert.equal(result.executionResults[0].status, 'completed');

    // Verify both messages are now completed in the store
    const old = await inboxStore.get(agentId, oldMsg.id);
    const newer = await inboxStore.get(agentId, newMsg.id);
    assert.equal(old.status, 'completed');
    assert.equal(newer.status, 'completed');
  });

  it('preserves task traceability — delegatedFrom, sourceTaskId in payload', async () => {
    const senderId = `agent-${uid()}`;
    const recipientId = `agent-${uid()}`;

    const msg = makeMessage({
      from: senderId,
      to: recipientId,
      taskDescription: 'Traceable task',
      sourceTaskId: 'task-abc123def',
      context: 'Some background info',
    });
    await inboxStore.enqueue(recipientId, msg);

    let capturedTask = null;
    const executeFn = async (_agentId, taskInfo) => {
      capturedTask = taskInfo;
      return 'traced';
    };

    await processInboxOnHeartbeat(recipientId, inboxStore, executeFn);

    assert.ok(capturedTask);
    assert.equal(capturedTask.payload.delegatedFrom, senderId);
    assert.equal(capturedTask.payload.delegatedTo, recipientId);
    assert.equal(capturedTask.payload.sourceTaskId, 'task-abc123def');
    assert.equal(capturedTask.payload.context, 'Some background info');
    assert.equal(capturedTask.source, `agent:${senderId}`);
  });
});
