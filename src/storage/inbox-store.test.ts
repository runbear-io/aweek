/**
 * Tests for InboxStore — file-based inbox queue storage for inter-agent delegation.
 * Covers: load/save, enqueue (idempotent), get, update, lifecycle transitions
 * (accept/complete/reject), remove, pending (priority-sorted), query, count,
 * summary, clearProcessed, schema validation, and edge cases.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InboxStore, type InboxMessage, type InboxMessagePriority, type InboxMessageType } from './inbox-store.js';
import { createInboxMessage } from '../models/agent.js';

const AGENT_A = 'agent-alice-11111111';
const AGENT_B = 'agent-bob-22222222';
const AGENT_C = 'agent-carol-33333333';

/** Create a temp dir for each test */
let tmpDir: string;
let store: InboxStore;

async function setup(): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), 'inbox-store-test-'));
  store = new InboxStore(tmpDir);
}

async function teardown(): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

interface MsgOpts {
  type?: InboxMessageType;
  priority?: InboxMessagePriority;
  context?: string;
  sourceTaskId?: string;
}

/** Helper: build a valid message via the factory */
function msg(
  from: string = AGENT_A,
  to: string = AGENT_B,
  desc: string = 'Do something',
  opts: MsgOpts = {},
): InboxMessage {
  return createInboxMessage(from, to, desc, opts) as InboxMessage;
}

// ---------------------------------------------------------------------------
// Load — empty / missing
// ---------------------------------------------------------------------------

describe('InboxStore — load', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty array when no inbox file exists', async () => {
    const result = await store.load(AGENT_A);
    assert.deepStrictEqual(result, []);
  });

  it('returns empty array for nonexistent agent directory', async () => {
    const result = await store.load('agent-nonexistent-00000000');
    assert.deepStrictEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

describe('InboxStore — enqueue', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('enqueues a message and persists it to disk', async () => {
    const m = msg();
    const result = await store.enqueue(AGENT_B, m);
    assert.equal(result.id, m.id);

    // Verify on disk
    const raw = await readFile(store._filePath(AGENT_B), 'utf-8');
    const parsed = JSON.parse(raw) as InboxMessage[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, m.id);
  });

  it('enqueues multiple messages in order', async () => {
    const m1 = msg(AGENT_A, AGENT_B, 'Task 1');
    const m2 = msg(AGENT_C, AGENT_B, 'Task 2');
    await store.enqueue(AGENT_B, m1);
    await store.enqueue(AGENT_B, m2);

    const loaded = await store.load(AGENT_B);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.id, m1.id);
    assert.equal(loaded[1]?.id, m2.id);
  });

  it('is idempotent — duplicate enqueue is a no-op', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    await store.enqueue(AGENT_B, m);

    const loaded = await store.load(AGENT_B);
    assert.equal(loaded.length, 1);
  });

  it('rejects invalid message (schema validation)', async () => {
    // Cast through `unknown` so the test can probe the runtime validator
    // without the type system rejecting the malformed shape ahead of AJV.
    const bad = { id: 'bad', status: 'pending' } as unknown as InboxMessage;
    await assert.rejects(
      () => store.enqueue(AGENT_B, bad),
      /Schema validation failed/,
    );
  });

  it('creates agent directory if it does not exist', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    // No error means directory was created
    const loaded = await store.load(AGENT_B);
    assert.equal(loaded.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

describe('InboxStore — get', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns a message by ID', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const found = await store.get(AGENT_B, m.id);
    assert.ok(found);
    assert.equal(found.id, m.id);
    assert.equal(found.taskDescription, m.taskDescription);
  });

  it('returns null for nonexistent message ID', async () => {
    await store.enqueue(AGENT_B, msg());
    const found = await store.get(AGENT_B, 'msg-nonexistent');
    assert.equal(found, null);
  });

  it('returns null for empty inbox', async () => {
    const found = await store.get(AGENT_B, 'msg-nonexistent');
    assert.equal(found, null);
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('InboxStore — update', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('updates a message via updater function', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);

    const updated = await store.update(AGENT_B, m.id, (current) => {
      current.status = 'accepted';
      current.processedAt = new Date().toISOString();
      return current;
    });

    assert.equal(updated.status, 'accepted');
    assert.ok(updated.processedAt);

    // Verify persisted
    const loaded = await store.load(AGENT_B);
    assert.equal(loaded[0]?.status, 'accepted');
  });

  it('throws on nonexistent message', async () => {
    await assert.rejects(
      () => store.update(AGENT_B, 'msg-nonexistent', (m) => m),
      /Message not found/,
    );
  });

  it('rejects update that produces invalid message', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);

    await assert.rejects(
      () => store.update(AGENT_B, m.id, (current) => {
        // Force an invalid status to exercise the validator at the
        // runtime boundary; the type system would otherwise reject it.
        (current as { status: string }).status = 'invalid-status';
        return current;
      }),
      /Schema validation failed/,
    );
  });

  it('does not mutate original message in queue on validation failure', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);

    try {
      await store.update(AGENT_B, m.id, (current) => {
        (current as { status: string }).status = 'invalid-status';
        return current;
      });
    } catch {
      // expected
    }

    // Original should be unchanged
    const loaded = await store.load(AGENT_B);
    assert.equal(loaded[0]?.status, 'pending');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle transitions: accept, complete, reject
// ---------------------------------------------------------------------------

describe('InboxStore — accept', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('transitions pending → accepted with processedAt', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const updated = await store.accept(AGENT_B, m.id);

    assert.equal(updated.status, 'accepted');
    assert.ok(updated.processedAt);
  });

  it('is idempotent — accepting already accepted returns same', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const first = await store.accept(AGENT_B, m.id);
    const second = await store.accept(AGENT_B, m.id);
    assert.equal(first.processedAt, second.processedAt);
  });
});

describe('InboxStore — complete', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('transitions to completed with completedAt', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const updated = await store.complete(AGENT_B, m.id);

    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt);
    assert.ok(updated.processedAt); // auto-set if missing
  });

  it('includes result when provided', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const updated = await store.complete(AGENT_B, m.id, 'All done!');

    assert.equal(updated.result, 'All done!');
  });

  it('is idempotent — completing already completed returns same', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const first = await store.complete(AGENT_B, m.id, 'Done');
    const second = await store.complete(AGENT_B, m.id, 'Done again');

    assert.equal(first.completedAt, second.completedAt);
    assert.equal(second.result, 'Done'); // original result preserved
  });
});

describe('InboxStore — reject', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('transitions to rejected with processedAt', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const updated = await store.reject(AGENT_B, m.id);

    assert.equal(updated.status, 'rejected');
    assert.ok(updated.processedAt);
  });

  it('includes rejectionReason when provided', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const updated = await store.reject(AGENT_B, m.id, 'Not my responsibility');

    assert.equal(updated.rejectionReason, 'Not my responsibility');
  });

  it('is idempotent — rejecting already rejected returns same', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const first = await store.reject(AGENT_B, m.id, 'Nope');
    const second = await store.reject(AGENT_B, m.id, 'Different reason');

    assert.equal(first.processedAt, second.processedAt);
    assert.equal(second.rejectionReason, 'Nope'); // original reason preserved
  });
});

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

describe('InboxStore — remove', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('removes a message and returns true', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    const removed = await store.remove(AGENT_B, m.id);

    assert.equal(removed, true);
    const loaded = await store.load(AGENT_B);
    assert.equal(loaded.length, 0);
  });

  it('returns false for nonexistent message (idempotent)', async () => {
    const removed = await store.remove(AGENT_B, 'msg-nonexistent');
    assert.equal(removed, false);
  });

  it('removes only the targeted message', async () => {
    const m1 = msg(AGENT_A, AGENT_B, 'Task 1');
    const m2 = msg(AGENT_C, AGENT_B, 'Task 2');
    await store.enqueue(AGENT_B, m1);
    await store.enqueue(AGENT_B, m2);

    await store.remove(AGENT_B, m1.id);
    const loaded = await store.load(AGENT_B);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, m2.id);
  });
});

// ---------------------------------------------------------------------------
// Pending — priority-sorted
// ---------------------------------------------------------------------------

describe('InboxStore — pending', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns only pending messages', async () => {
    const m1 = msg(AGENT_A, AGENT_B, 'Task 1');
    const m2 = msg(AGENT_C, AGENT_B, 'Task 2');
    await store.enqueue(AGENT_B, m1);
    await store.enqueue(AGENT_B, m2);
    await store.accept(AGENT_B, m1.id);

    const pending = await store.pending(AGENT_B);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.id, m2.id);
  });

  it('sorts by priority: critical > high > medium > low', async () => {
    const mLow = msg(AGENT_A, AGENT_B, 'Low task', { priority: 'low' });
    const mCrit = msg(AGENT_A, AGENT_B, 'Critical task', { priority: 'critical' });
    const mHigh = msg(AGENT_A, AGENT_B, 'High task', { priority: 'high' });
    const mMed = msg(AGENT_A, AGENT_B, 'Medium task', { priority: 'medium' });

    await store.enqueue(AGENT_B, mLow);
    await store.enqueue(AGENT_B, mCrit);
    await store.enqueue(AGENT_B, mHigh);
    await store.enqueue(AGENT_B, mMed);

    const pending = await store.pending(AGENT_B);
    assert.equal(pending.length, 4);
    assert.equal(pending[0]?.priority, 'critical');
    assert.equal(pending[1]?.priority, 'high');
    assert.equal(pending[2]?.priority, 'medium');
    assert.equal(pending[3]?.priority, 'low');
  });

  it('returns empty array when no pending messages', async () => {
    const m = msg();
    await store.enqueue(AGENT_B, m);
    await store.complete(AGENT_B, m.id);

    const pending = await store.pending(AGENT_B);
    assert.deepStrictEqual(pending, []);
  });

  it('returns empty array for empty inbox', async () => {
    const pending = await store.pending(AGENT_B);
    assert.deepStrictEqual(pending, []);
  });
});

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

describe('InboxStore — query', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns all messages with no filters', async () => {
    await store.enqueue(AGENT_B, msg(AGENT_A, AGENT_B, 'Task 1'));
    await store.enqueue(AGENT_B, msg(AGENT_C, AGENT_B, 'Task 2'));

    const results = await store.query(AGENT_B);
    assert.equal(results.length, 2);
  });

  it('filters by status', async () => {
    const m1 = msg(AGENT_A, AGENT_B, 'Task 1');
    const m2 = msg(AGENT_C, AGENT_B, 'Task 2');
    await store.enqueue(AGENT_B, m1);
    await store.enqueue(AGENT_B, m2);
    await store.accept(AGENT_B, m1.id);

    const results = await store.query(AGENT_B, { status: 'accepted' });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, m1.id);
  });

  it('filters by type', async () => {
    const m1 = msg(AGENT_A, AGENT_B, 'Delegation', { type: 'task-delegation' });
    const m2 = msg(AGENT_C, AGENT_B, 'Status', { type: 'status-update' });
    await store.enqueue(AGENT_B, m1);
    await store.enqueue(AGENT_B, m2);

    const results = await store.query(AGENT_B, { type: 'status-update' });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.type, 'status-update');
  });

  it('filters by sender (from)', async () => {
    await store.enqueue(AGENT_B, msg(AGENT_A, AGENT_B, 'From A'));
    await store.enqueue(AGENT_B, msg(AGENT_C, AGENT_B, 'From C'));

    const results = await store.query(AGENT_B, { from: AGENT_C });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.from, AGENT_C);
  });

  it('filters by priority', async () => {
    await store.enqueue(AGENT_B, msg(AGENT_A, AGENT_B, 'High', { priority: 'high' }));
    await store.enqueue(AGENT_B, msg(AGENT_A, AGENT_B, 'Low', { priority: 'low' }));

    const results = await store.query(AGENT_B, { priority: 'high' });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.priority, 'high');
  });

  it('combines multiple filters', async () => {
    await store.enqueue(AGENT_B, msg(AGENT_A, AGENT_B, 'Task', { priority: 'high', type: 'task-delegation' }));
    await store.enqueue(AGENT_B, msg(AGENT_A, AGENT_B, 'Info', { priority: 'high', type: 'info' }));
    await store.enqueue(AGENT_B, msg(AGENT_C, AGENT_B, 'Task', { priority: 'low', type: 'task-delegation' }));

    const results = await store.query(AGENT_B, { priority: 'high', type: 'task-delegation' });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.taskDescription, 'Task');
    assert.equal(results[0]?.from, AGENT_A);
  });

  it('returns empty array when no matches', async () => {
    await store.enqueue(AGENT_B, msg());
    const results = await store.query(AGENT_B, { status: 'completed' });
    assert.deepStrictEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

describe('InboxStore — count', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns total count with no status filter', async () => {
    await store.enqueue(AGENT_B, msg(AGENT_A, AGENT_B, 'T1'));
    await store.enqueue(AGENT_B, msg(AGENT_C, AGENT_B, 'T2'));
    assert.equal(await store.count(AGENT_B), 2);
  });

  it('returns filtered count by status', async () => {
    const m1 = msg(AGENT_A, AGENT_B, 'T1');
    await store.enqueue(AGENT_B, m1);
    await store.enqueue(AGENT_B, msg(AGENT_C, AGENT_B, 'T2'));
    await store.accept(AGENT_B, m1.id);

    assert.equal(await store.count(AGENT_B, 'accepted'), 1);
    assert.equal(await store.count(AGENT_B, 'pending'), 1);
    assert.equal(await store.count(AGENT_B, 'completed'), 0);
  });

  it('returns 0 for empty inbox', async () => {
    assert.equal(await store.count(AGENT_B), 0);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('InboxStore — summary', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty summary for empty inbox', async () => {
    const s = await store.summary(AGENT_B);
    assert.equal(s.total, 0);
    assert.deepStrictEqual(s.byStatus, {});
    assert.deepStrictEqual(s.byType, {});
  });

  it('returns correct counts by status and type', async () => {
    const m1 = msg(AGENT_A, AGENT_B, 'Task', { type: 'task-delegation' });
    const m2 = msg(AGENT_C, AGENT_B, 'Info', { type: 'info' });
    await store.enqueue(AGENT_B, m1);
    await store.enqueue(AGENT_B, m2);
    await store.accept(AGENT_B, m1.id);

    const s = await store.summary(AGENT_B);
    assert.equal(s.total, 2);
    assert.equal(s.byStatus.accepted, 1);
    assert.equal(s.byStatus.pending, 1);
    assert.equal(s.byType['task-delegation'], 1);
    assert.equal(s.byType.info, 1);
  });
});

// ---------------------------------------------------------------------------
// clearProcessed
// ---------------------------------------------------------------------------

describe('InboxStore — clearProcessed', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('removes completed and rejected messages', async () => {
    const m1 = msg(AGENT_A, AGENT_B, 'Will complete');
    const m2 = msg(AGENT_C, AGENT_B, 'Will reject');
    const m3 = msg(AGENT_A, AGENT_B, 'Still pending');
    const m4 = msg(AGENT_C, AGENT_B, 'Accepted');

    await store.enqueue(AGENT_B, m1);
    await store.enqueue(AGENT_B, m2);
    await store.enqueue(AGENT_B, m3);
    await store.enqueue(AGENT_B, m4);

    await store.complete(AGENT_B, m1.id);
    await store.reject(AGENT_B, m2.id, 'Nope');
    await store.accept(AGENT_B, m4.id);

    const removed = await store.clearProcessed(AGENT_B);
    assert.equal(removed, 2);

    const loaded = await store.load(AGENT_B);
    assert.equal(loaded.length, 2);
    assert.ok(loaded.some((m) => m.id === m3.id));
    assert.ok(loaded.some((m) => m.id === m4.id));
  });

  it('returns 0 when nothing to clear', async () => {
    await store.enqueue(AGENT_B, msg());
    const removed = await store.clearProcessed(AGENT_B);
    assert.equal(removed, 0);
  });

  it('returns 0 for empty inbox', async () => {
    const removed = await store.clearProcessed(AGENT_B);
    assert.equal(removed, 0);
  });
});

// ---------------------------------------------------------------------------
// Isolation — separate agents have separate inboxes
// ---------------------------------------------------------------------------

describe('InboxStore — agent isolation', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('messages to different agents are stored independently', async () => {
    await store.enqueue(AGENT_A, msg(AGENT_B, AGENT_A, 'For A'));
    await store.enqueue(AGENT_B, msg(AGENT_A, AGENT_B, 'For B'));

    const aInbox = await store.load(AGENT_A);
    const bInbox = await store.load(AGENT_B);

    assert.equal(aInbox.length, 1);
    assert.equal(bInbox.length, 1);
    assert.equal(aInbox[0]?.taskDescription, 'For A');
    assert.equal(bInbox[0]?.taskDescription, 'For B');
  });

  it('operations on one agent inbox do not affect another', async () => {
    const mA = msg(AGENT_B, AGENT_A, 'For A');
    const mB = msg(AGENT_A, AGENT_B, 'For B');
    await store.enqueue(AGENT_A, mA);
    await store.enqueue(AGENT_B, mB);

    await store.remove(AGENT_A, mA.id);

    assert.equal((await store.load(AGENT_A)).length, 0);
    assert.equal((await store.load(AGENT_B)).length, 1);
  });
});
