/**
 * Tests for task queue module — per-agent FIFO queue with priority support.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  queuePathFor,
  readQueue,
  createQueueEntry,
  enqueue,
  dequeue,
  dequeueAll,
  peek,
  queueLength,
  removeTask,
  clearQueue,
  createTaskQueue,
} from './task-queue.js';

describe('task-queue', () => {
  let queueDir;

  beforeEach(async () => {
    queueDir = await mkdtemp(join(tmpdir(), 'aweek-queue-'));
  });

  afterEach(async () => {
    await rm(queueDir, { recursive: true, force: true });
  });

  // ── queuePathFor ──────────────────────────────────────────────

  describe('queuePathFor', () => {
    it('returns path with agent ID and .queue.json suffix', () => {
      const p = queuePathFor('agent-1', queueDir);
      assert.ok(p.endsWith('agent-1.queue.json'));
    });

    it('throws if agentId is missing', () => {
      assert.throws(() => queuePathFor(''), /agentId is required/);
      assert.throws(() => queuePathFor(null), /agentId is required/);
    });
  });

  // ── createQueueEntry ──────────────────────────────────────────

  describe('createQueueEntry', () => {
    it('creates entry with defaults', () => {
      const entry = createQueueEntry({ agentId: 'a1' });
      assert.equal(entry.agentId, 'a1');
      assert.equal(entry.type, 'heartbeat');
      assert.equal(entry.priority, 3);
      assert.deepEqual(entry.payload, {});
      assert.ok(entry.taskId);
      assert.ok(entry.enqueuedAt);
      assert.equal(entry.source, undefined);
    });

    it('accepts custom values', () => {
      const entry = createQueueEntry({
        agentId: 'a1',
        taskId: 'custom-id',
        type: 'delegated',
        priority: 5,
        payload: { key: 'value' },
        source: 'agent:other',
      });
      assert.equal(entry.taskId, 'custom-id');
      assert.equal(entry.type, 'delegated');
      assert.equal(entry.priority, 5);
      assert.deepEqual(entry.payload, { key: 'value' });
      assert.equal(entry.source, 'agent:other');
    });

    it('throws on missing agentId', () => {
      assert.throws(() => createQueueEntry({}), /agentId is required/);
      assert.throws(() => createQueueEntry(null), /agentId is required/);
    });

    it('throws on invalid priority', () => {
      assert.throws(() => createQueueEntry({ agentId: 'a', priority: 0 }), /priority/);
      assert.throws(() => createQueueEntry({ agentId: 'a', priority: 6 }), /priority/);
      assert.throws(() => createQueueEntry({ agentId: 'a', priority: 'high' }), /priority/);
    });
  });

  // ── readQueue ─────────────────────────────────────────────────

  describe('readQueue', () => {
    it('returns empty array when no queue file exists', async () => {
      const entries = await readQueue('nonexistent', { queueDir });
      assert.deepEqual(entries, []);
    });

    it('throws on missing agentId', async () => {
      await assert.rejects(() => readQueue('', { queueDir }), /agentId is required/);
    });
  });

  // ── enqueue ───────────────────────────────────────────────────

  describe('enqueue', () => {
    it('enqueues a task to an empty queue', async () => {
      const result = await enqueue({ agentId: 'a1', type: 'heartbeat' }, { queueDir });
      assert.equal(result.enqueued, true);
      assert.equal(result.position, 1);
      assert.equal(result.entry.agentId, 'a1');

      const entries = await readQueue('a1', { queueDir });
      assert.equal(entries.length, 1);
    });

    it('enqueues multiple tasks preserving order', async () => {
      await enqueue({ agentId: 'a1', taskId: 't1' }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 't2' }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 't3' }, { queueDir });

      const entries = await readQueue('a1', { queueDir });
      assert.equal(entries.length, 3);
      assert.deepEqual(entries.map((e) => e.taskId), ['t1', 't2', 't3']);
    });

    it('rejects duplicate taskIds (idempotent)', async () => {
      await enqueue({ agentId: 'a1', taskId: 'dup' }, { queueDir });
      const result = await enqueue({ agentId: 'a1', taskId: 'dup' }, { queueDir });

      assert.equal(result.enqueued, false);
      assert.equal(result.duplicate, true);

      const entries = await readQueue('a1', { queueDir });
      assert.equal(entries.length, 1);
    });

    it('isolates queues per agent', async () => {
      await enqueue({ agentId: 'a1', taskId: 't1' }, { queueDir });
      await enqueue({ agentId: 'a2', taskId: 't2' }, { queueDir });

      assert.equal(await queueLength('a1', { queueDir }), 1);
      assert.equal(await queueLength('a2', { queueDir }), 1);
    });
  });

  // ── dequeue ───────────────────────────────────────────────────

  describe('dequeue', () => {
    it('returns dequeued: false for empty queue', async () => {
      const result = await dequeue('a1', { queueDir });
      assert.equal(result.dequeued, false);
      assert.equal(result.remaining, 0);
    });

    it('dequeues in FIFO order for same priority', async () => {
      await enqueue({ agentId: 'a1', taskId: 'first', priority: 3 }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 'second', priority: 3 }, { queueDir });

      const r1 = await dequeue('a1', { queueDir });
      assert.equal(r1.dequeued, true);
      assert.equal(r1.entry.taskId, 'first');
      assert.equal(r1.remaining, 1);

      const r2 = await dequeue('a1', { queueDir });
      assert.equal(r2.entry.taskId, 'second');
      assert.equal(r2.remaining, 0);
    });

    it('dequeues highest priority first', async () => {
      await enqueue({ agentId: 'a1', taskId: 'low', priority: 1 }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 'high', priority: 5 }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 'mid', priority: 3 }, { queueDir });

      const r1 = await dequeue('a1', { queueDir });
      assert.equal(r1.entry.taskId, 'high');

      const r2 = await dequeue('a1', { queueDir });
      assert.equal(r2.entry.taskId, 'mid');

      const r3 = await dequeue('a1', { queueDir });
      assert.equal(r3.entry.taskId, 'low');
    });

    it('throws on missing agentId', async () => {
      await assert.rejects(() => dequeue('', { queueDir }), /agentId is required/);
    });
  });

  // ── dequeueAll ────────────────────────────────────────────────

  describe('dequeueAll', () => {
    it('returns empty for empty queue', async () => {
      const result = await dequeueAll('a1', { queueDir });
      assert.deepEqual(result.entries, []);
      assert.equal(result.count, 0);
    });

    it('returns all entries sorted by priority then FIFO', async () => {
      await enqueue({ agentId: 'a1', taskId: 'low', priority: 1 }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 'high', priority: 5 }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 'mid', priority: 3 }, { queueDir });

      const result = await dequeueAll('a1', { queueDir });
      assert.equal(result.count, 3);
      assert.deepEqual(result.entries.map((e) => e.taskId), ['high', 'mid', 'low']);

      // Queue should be empty after dequeueAll
      assert.equal(await queueLength('a1', { queueDir }), 0);
    });
  });

  // ── peek ──────────────────────────────────────────────────────

  describe('peek', () => {
    it('returns hasTask: false for empty queue', async () => {
      const result = await peek('a1', { queueDir });
      assert.equal(result.hasTask, false);
      assert.equal(result.queueLength, 0);
    });

    it('returns highest-priority task without removing it', async () => {
      await enqueue({ agentId: 'a1', taskId: 'low', priority: 1 }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 'high', priority: 5 }, { queueDir });

      const result = await peek('a1', { queueDir });
      assert.equal(result.hasTask, true);
      assert.equal(result.entry.taskId, 'high');
      assert.equal(result.queueLength, 2);

      // Should still have 2 entries (peek doesn't remove)
      assert.equal(await queueLength('a1', { queueDir }), 2);
    });
  });

  // ── queueLength ───────────────────────────────────────────────

  describe('queueLength', () => {
    it('returns 0 for nonexistent queue', async () => {
      assert.equal(await queueLength('a1', { queueDir }), 0);
    });

    it('returns correct count', async () => {
      await enqueue({ agentId: 'a1', taskId: 't1' }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 't2' }, { queueDir });
      assert.equal(await queueLength('a1', { queueDir }), 2);
    });
  });

  // ── removeTask ────────────────────────────────────────────────

  describe('removeTask', () => {
    it('removes a specific task by taskId', async () => {
      await enqueue({ agentId: 'a1', taskId: 't1' }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 't2' }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 't3' }, { queueDir });

      const result = await removeTask('a1', 't2', { queueDir });
      assert.equal(result.removed, true);
      assert.equal(result.entry.taskId, 't2');
      assert.equal(result.remaining, 2);

      const entries = await readQueue('a1', { queueDir });
      assert.deepEqual(entries.map((e) => e.taskId), ['t1', 't3']);
    });

    it('returns removed: false for nonexistent taskId', async () => {
      await enqueue({ agentId: 'a1', taskId: 't1' }, { queueDir });
      const result = await removeTask('a1', 'nope', { queueDir });
      assert.equal(result.removed, false);
      assert.equal(result.remaining, 1);
    });

    it('throws on missing agentId or taskId', async () => {
      await assert.rejects(() => removeTask('', 't1', { queueDir }), /agentId/);
      await assert.rejects(() => removeTask('a1', '', { queueDir }), /taskId/);
    });
  });

  // ── clearQueue ────────────────────────────────────────────────

  describe('clearQueue', () => {
    it('clears all entries', async () => {
      await enqueue({ agentId: 'a1', taskId: 't1' }, { queueDir });
      await enqueue({ agentId: 'a1', taskId: 't2' }, { queueDir });

      const result = await clearQueue('a1', { queueDir });
      assert.equal(result.cleared, true);
      assert.equal(result.previousLength, 2);

      assert.equal(await queueLength('a1', { queueDir }), 0);
    });

    it('is idempotent on empty/nonexistent queue', async () => {
      const result = await clearQueue('a1', { queueDir });
      assert.equal(result.cleared, true);
      assert.equal(result.previousLength, 0);
    });
  });

  // ── createTaskQueue (bound instance) ──────────────────────────

  describe('createTaskQueue', () => {
    it('creates a bound queue instance for an agent', async () => {
      const queue = createTaskQueue('a1', { queueDir });

      assert.equal(queue.agentId, 'a1');
      assert.ok(queue.queuePath().endsWith('a1.queue.json'));
    });

    it('enqueue and dequeue via bound instance', async () => {
      const queue = createTaskQueue('a1', { queueDir });

      await queue.enqueue({ taskId: 't1', type: 'delegated', priority: 4 });
      await queue.enqueue({ taskId: 't2', type: 'heartbeat', priority: 2 });

      assert.equal(await queue.length(), 2);

      const peeked = await queue.peek();
      assert.equal(peeked.entry.taskId, 't1');

      const r1 = await queue.dequeue();
      assert.equal(r1.entry.taskId, 't1');

      const r2 = await queue.dequeue();
      assert.equal(r2.entry.taskId, 't2');

      assert.equal(await queue.length(), 0);
    });

    it('remove and clear via bound instance', async () => {
      const queue = createTaskQueue('a1', { queueDir });

      await queue.enqueue({ taskId: 't1' });
      await queue.enqueue({ taskId: 't2' });
      await queue.enqueue({ taskId: 't3' });

      await queue.remove('t2');
      assert.equal(await queue.length(), 2);

      await queue.clear();
      assert.equal(await queue.length(), 0);
    });

    it('dequeueAll via bound instance', async () => {
      const queue = createTaskQueue('a1', { queueDir });

      await queue.enqueue({ taskId: 't1', priority: 1 });
      await queue.enqueue({ taskId: 't2', priority: 5 });

      const result = await queue.dequeueAll();
      assert.equal(result.count, 2);
      assert.equal(result.entries[0].taskId, 't2'); // higher priority first
      assert.equal(await queue.length(), 0);
    });

    it('throws if agentId is missing', () => {
      assert.throws(() => createTaskQueue(''), /agentId is required/);
    });
  });

  // ── idempotency / edge cases ──────────────────────────────────

  describe('idempotency and edge cases', () => {
    it('repeated enqueue with same taskId produces no duplicates', async () => {
      for (let i = 0; i < 5; i++) {
        await enqueue({ agentId: 'a1', taskId: 'idem' }, { queueDir });
      }
      assert.equal(await queueLength('a1', { queueDir }), 1);
    });

    it('dequeue on empty queue is idempotent', async () => {
      const r1 = await dequeue('a1', { queueDir });
      const r2 = await dequeue('a1', { queueDir });
      assert.equal(r1.dequeued, false);
      assert.equal(r2.dequeued, false);
    });

    it('enqueue after dequeueAll starts fresh', async () => {
      await enqueue({ agentId: 'a1', taskId: 't1' }, { queueDir });
      await dequeueAll('a1', { queueDir });
      await enqueue({ agentId: 'a1', taskId: 't2' }, { queueDir });

      const entries = await readQueue('a1', { queueDir });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].taskId, 't2');
    });

    it('handles concurrent enqueues to different agents', async () => {
      await Promise.all([
        enqueue({ agentId: 'a1', taskId: 't1' }, { queueDir }),
        enqueue({ agentId: 'a2', taskId: 't2' }, { queueDir }),
        enqueue({ agentId: 'a3', taskId: 't3' }, { queueDir }),
      ]);

      assert.equal(await queueLength('a1', { queueDir }), 1);
      assert.equal(await queueLength('a2', { queueDir }), 1);
      assert.equal(await queueLength('a3', { queueDir }), 1);
    });
  });
});
