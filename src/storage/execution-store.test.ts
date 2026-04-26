/**
 * Tests for ExecutionStore and execution record schema validation.
 *
 * The runtime/contract assertions are unchanged from the original `.js`
 * test — this file is the strict-mode TypeScript port that lands as part
 * of seed-03-storage-C-final's storage migration. Types are imported
 * from the migrated `./execution-store.js` source via NodeNext extension
 * resolution; the record shape is inferred from the factory's return
 * type so the test stays in lockstep with the source without forcing
 * a hard re-export of an internal type alias.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ExecutionStore,
  createExecutionRecord,
  generateIdempotencyKey,
  computeTimeWindow,
  getMondayDate,
} from './execution-store.js';
import { validateExecutionRecord, validateExecutionLog } from '../schemas/validator.js';

/**
 * Inferred from the migrated `createExecutionRecord` factory so the
 * test stays in lockstep with the source's declared return shape.
 */
type ExecutionRecord = ReturnType<typeof createExecutionRecord>;

/**
 * Loose mutable variant used by negative-path schema assertions that
 * intentionally smuggle invalid status/id/key strings or extra fields
 * onto the record before re-validating. Indexing through this record
 * keeps those mutations type-safe without resorting to `as any`.
 */
type MutableRecord = ExecutionRecord & Record<string, unknown>;

// ── Helper ──────────────────────────────────────────────────────────────────
const AGENT = 'test-agent';

interface MakeRecordOverrides {
  agentId?: string;
  status?: ExecutionRecord['status'];
  date?: Date;
  windowMs?: number;
  taskId?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

function makeRecord(overrides: MakeRecordOverrides = {}): ExecutionRecord {
  return createExecutionRecord({
    agentId: AGENT,
    status: 'completed',
    date: new Date('2026-04-15T10:30:00Z'),
    ...overrides,
  });
}

// ── Schema validation ───────────────────────────────────────────────────────
describe('execution.schema', () => {
  it('validates a minimal execution record', () => {
    const rec = makeRecord();
    const result = validateExecutionRecord(rec);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('validates a record with all optional fields', () => {
    const rec = makeRecord({ taskId: 'task-1', duration: 5000, metadata: { tokens: 100 } });
    const result = validateExecutionRecord(rec);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects record missing required fields', () => {
    const result = validateExecutionRecord({ id: 'exec-abc' });
    assert.equal(result.valid, false);
  });

  it('rejects invalid status', () => {
    const rec = makeRecord() as MutableRecord;
    rec.status = 'invalid-status';
    const result = validateExecutionRecord(rec);
    assert.equal(result.valid, false);
  });

  it('accepts all valid statuses', () => {
    const statuses: Array<ExecutionRecord['status']> = ['started', 'completed', 'failed', 'skipped'];
    for (const status of statuses) {
      const rec = makeRecord({ status });
      const result = validateExecutionRecord(rec);
      assert.equal(result.valid, true, `Status "${status}" should be valid`);
    }
  });

  it('rejects invalid id pattern', () => {
    const rec = makeRecord() as MutableRecord;
    rec.id = 'bad-id';
    const result = validateExecutionRecord(rec);
    assert.equal(result.valid, false);
  });

  it('rejects invalid idempotencyKey pattern', () => {
    const rec = makeRecord() as MutableRecord;
    rec.idempotencyKey = 'bad-key';
    const result = validateExecutionRecord(rec);
    assert.equal(result.valid, false);
  });

  it('validates an execution log (array)', () => {
    const log: ExecutionRecord[] = [makeRecord(), makeRecord({ status: 'failed' })];
    const result = validateExecutionLog(log);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('validates empty array as valid log', () => {
    const result = validateExecutionLog([]);
    assert.equal(result.valid, true);
  });

  it('rejects additional properties', () => {
    const rec = makeRecord() as MutableRecord;
    rec.extraField = 'nope';
    const result = validateExecutionRecord(rec);
    assert.equal(result.valid, false);
  });
});

// ── Idempotency key generation ──────────────────────────────────────────────
describe('generateIdempotencyKey', () => {
  it('produces deterministic keys for same inputs', () => {
    const k1 = generateIdempotencyKey('agent-a', '2026-04-15T10:00:00.000Z');
    const k2 = generateIdempotencyKey('agent-a', '2026-04-15T10:00:00.000Z');
    assert.equal(k1, k2);
  });

  it('produces different keys for different agents', () => {
    const k1 = generateIdempotencyKey('agent-a', '2026-04-15T10:00:00.000Z');
    const k2 = generateIdempotencyKey('agent-b', '2026-04-15T10:00:00.000Z');
    assert.notEqual(k1, k2);
  });

  it('produces different keys for different windows', () => {
    const k1 = generateIdempotencyKey('agent-a', '2026-04-15T10:00:00.000Z');
    const k2 = generateIdempotencyKey('agent-a', '2026-04-15T11:00:00.000Z');
    assert.notEqual(k1, k2);
  });

  it('matches idem-hex pattern', () => {
    const key = generateIdempotencyKey('agent-a', '2026-04-15T10:00:00.000Z');
    assert.match(key, /^idem-[a-f0-9]+$/);
  });
});

// ── Time window computation ─────────────────────────────────────────────────
describe('computeTimeWindow', () => {
  it('floors to hour boundary by default', () => {
    const { windowStart, windowEnd } = computeTimeWindow(new Date('2026-04-15T10:30:00Z'));
    assert.equal(windowStart, '2026-04-15T10:00:00.000Z');
    assert.equal(windowEnd, '2026-04-15T11:00:00.000Z');
  });

  it('handles exact hour boundary', () => {
    const { windowStart, windowEnd } = computeTimeWindow(new Date('2026-04-15T10:00:00Z'));
    assert.equal(windowStart, '2026-04-15T10:00:00.000Z');
    assert.equal(windowEnd, '2026-04-15T11:00:00.000Z');
  });

  it('supports custom window sizes', () => {
    const { windowStart, windowEnd } = computeTimeWindow(
      new Date('2026-04-15T10:15:00Z'),
      30 * 60 * 1000, // 30 minutes
    );
    assert.equal(windowStart, '2026-04-15T10:00:00.000Z');
    assert.equal(windowEnd, '2026-04-15T10:30:00.000Z');
  });
});

// ── getMondayDate ───────────────────────────────────────────────────────────
describe('getMondayDate', () => {
  it('returns Monday for a Wednesday', () => {
    assert.equal(getMondayDate(new Date('2026-04-15T12:00:00Z')), '2026-04-13');
  });

  it('returns Monday for a Monday', () => {
    assert.equal(getMondayDate(new Date('2026-04-13T00:00:00Z')), '2026-04-13');
  });

  it('returns Monday for a Sunday', () => {
    assert.equal(getMondayDate(new Date('2026-04-19T23:59:59Z')), '2026-04-13');
  });
});

// ── createExecutionRecord ───────────────────────────────────────────────────
describe('createExecutionRecord', () => {
  it('creates a valid record with defaults', () => {
    const rec = makeRecord();
    assert.match(rec.id, /^exec-[a-f0-9]+$/);
    assert.match(rec.idempotencyKey, /^idem-[a-f0-9]+$/);
    assert.equal(rec.agentId, AGENT);
    assert.equal(rec.status, 'completed');
  });

  it('includes optional fields when provided', () => {
    const rec = makeRecord({ taskId: 'task-42', duration: 1234, metadata: { foo: 'bar' } });
    assert.equal(rec.taskId, 'task-42');
    assert.equal(rec.duration, 1234);
    assert.deepEqual(rec.metadata, { foo: 'bar' });
  });

  it('omits optional fields when not provided', () => {
    const rec = makeRecord();
    assert.equal(rec.taskId, undefined);
    assert.equal(rec.duration, undefined);
    assert.equal(rec.metadata, undefined);
  });

  it('produces same idempotency key for same agent+window', () => {
    const r1 = createExecutionRecord({ agentId: AGENT, status: 'started', date: new Date('2026-04-15T10:05:00Z') });
    const r2 = createExecutionRecord({ agentId: AGENT, status: 'completed', date: new Date('2026-04-15T10:55:00Z') });
    assert.equal(r1.idempotencyKey, r2.idempotencyKey);
  });

  it('produces different idempotency keys for different windows', () => {
    const r1 = createExecutionRecord({ agentId: AGENT, status: 'started', date: new Date('2026-04-15T10:30:00Z') });
    const r2 = createExecutionRecord({ agentId: AGENT, status: 'started', date: new Date('2026-04-15T11:30:00Z') });
    assert.notEqual(r1.idempotencyKey, r2.idempotencyKey);
  });
});

// ── ExecutionStore ──────────────────────────────────────────────────────────
describe('ExecutionStore', () => {
  let tmpDir: string;
  let store: ExecutionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'exec-store-'));
    store = new ExecutionStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('creates executions directory', async () => {
      await store.init(AGENT);
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(join(tmpDir, AGENT, 'executions'));
      assert.ok(Array.isArray(entries));
    });

    it('is idempotent', async () => {
      await store.init(AGENT);
      await store.init(AGENT); // No error
    });
  });

  describe('load', () => {
    it('returns empty array for nonexistent file', async () => {
      const records = await store.load(AGENT, '2026-04-13');
      assert.deepEqual(records, []);
    });

    it('returns stored records', async () => {
      const rec = makeRecord();
      await store.record(AGENT, rec);
      const records = await store.load(AGENT, '2026-04-13');
      assert.equal(records.length, 1);
      assert.equal(records[0].id, rec.id);
    });
  });

  describe('record', () => {
    it('stores a new execution record', async () => {
      const rec = makeRecord();
      const result = await store.record(AGENT, rec);
      assert.equal(result.duplicate, false);
      assert.equal(result.record.id, rec.id);
    });

    it('returns duplicate=true for same idempotency key', async () => {
      const rec1 = makeRecord();
      await store.record(AGENT, rec1);

      // Create another record with same idempotency key (same agent+window)
      const rec2 = makeRecord();
      rec2.idempotencyKey = rec1.idempotencyKey;
      const result = await store.record(AGENT, rec2);
      assert.equal(result.duplicate, true);

      // Only one record stored
      const records = await store.load(AGENT, '2026-04-13');
      assert.equal(records.length, 1);
    });

    it('stores records with different idempotency keys', async () => {
      const rec1 = makeRecord({ date: new Date('2026-04-15T10:30:00Z') });
      const rec2 = makeRecord({ date: new Date('2026-04-15T11:30:00Z') });
      await store.record(AGENT, rec1);
      await store.record(AGENT, rec2);

      const records = await store.load(AGENT, '2026-04-13');
      assert.equal(records.length, 2);
    });

    it('validates record before storing', async () => {
      await assert.rejects(
        () => store.record(AGENT, { id: 'bad' } as unknown as ExecutionRecord),
        /Schema validation failed/,
      );
    });
  });

  describe('exists', () => {
    it('returns false when key does not exist', async () => {
      const result = await store.exists(AGENT, 'idem-000000000000', '2026-04-13');
      assert.equal(result, false);
    });

    it('returns true when key exists', async () => {
      const rec = makeRecord();
      await store.record(AGENT, rec);
      const result = await store.exists(AGENT, rec.idempotencyKey, '2026-04-13');
      assert.equal(result, true);
    });
  });

  describe('listWeeks', () => {
    it('returns empty array for new agent', async () => {
      const weeks = await store.listWeeks(AGENT);
      assert.deepEqual(weeks, []);
    });

    it('returns weeks with stored records', async () => {
      const rec1 = makeRecord({ date: new Date('2026-04-15T10:00:00Z') }); // week of 2026-04-13
      const rec2 = makeRecord({ date: new Date('2026-04-22T10:00:00Z') }); // week of 2026-04-20
      await store.record(AGENT, rec1);
      await store.record(AGENT, rec2);

      const weeks = await store.listWeeks(AGENT);
      assert.deepEqual(weeks, ['2026-04-13', '2026-04-20']);
    });
  });

  describe('listRecent', () => {
    it('returns records sorted by timestamp descending', async () => {
      const rec1 = makeRecord({ date: new Date('2026-04-15T10:30:00Z') });
      const rec2 = makeRecord({ date: new Date('2026-04-15T11:30:00Z') });
      await store.record(AGENT, rec1);
      await store.record(AGENT, rec2);

      const recent = await store.listRecent(AGENT, { weekMonday: '2026-04-13' });
      assert.equal(recent.length, 2);
      assert.equal(recent[0].id, rec2.id); // more recent first
    });

    it('filters by status', async () => {
      const rec1 = makeRecord({ status: 'completed', date: new Date('2026-04-15T10:30:00Z') });
      const rec2 = makeRecord({ status: 'failed', date: new Date('2026-04-15T11:30:00Z') });
      await store.record(AGENT, rec1);
      await store.record(AGENT, rec2);

      const recent = await store.listRecent(AGENT, { weekMonday: '2026-04-13', status: 'completed' });
      assert.equal(recent.length, 1);
      assert.equal(recent[0].status, 'completed');
    });

    it('respects limit', async () => {
      const rec1 = makeRecord({ date: new Date('2026-04-15T10:30:00Z') });
      const rec2 = makeRecord({ date: new Date('2026-04-15T11:30:00Z') });
      const rec3 = makeRecord({ date: new Date('2026-04-15T12:30:00Z') });
      await store.record(AGENT, rec1);
      await store.record(AGENT, rec2);
      await store.record(AGENT, rec3);

      const recent = await store.listRecent(AGENT, { weekMonday: '2026-04-13', limit: 2 });
      assert.equal(recent.length, 2);
    });
  });

  describe('summary', () => {
    it('returns zero summary for empty week', async () => {
      const summary = await store.summary(AGENT, '2026-04-13');
      assert.equal(summary.recordCount, 0);
      assert.deepEqual(summary.byStatus, {});
      assert.equal(summary.totalDuration, 0);
    });

    it('aggregates correctly', async () => {
      const rec1 = makeRecord({ status: 'completed', duration: 1000, date: new Date('2026-04-15T10:30:00Z') });
      const rec2 = makeRecord({ status: 'completed', duration: 2000, date: new Date('2026-04-15T11:30:00Z') });
      const rec3 = makeRecord({ status: 'failed', duration: 500, date: new Date('2026-04-15T12:30:00Z') });
      await store.record(AGENT, rec1);
      await store.record(AGENT, rec2);
      await store.record(AGENT, rec3);

      const summary = await store.summary(AGENT, '2026-04-13');
      assert.equal(summary.recordCount, 3);
      assert.equal(summary.byStatus.completed, 2);
      assert.equal(summary.byStatus.failed, 1);
      assert.equal(summary.totalDuration, 3500);
    });
  });
});
