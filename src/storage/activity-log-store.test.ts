/**
 * Tests for ActivityLogStore and activity log schema validation.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActivityLogStore,
  createLogEntry,
  getMondayDate,
  type ActivityLogEntry,
} from './activity-log-store.js';
import { validateActivityLogEntry, validateActivityLog } from '../schemas/validator.js';

describe('getMondayDate', () => {
  it('returns Monday for a Monday date', () => {
    // 2026-04-13 is a Monday
    const result = getMondayDate(new Date('2026-04-13T12:00:00Z'));
    assert.equal(result, '2026-04-13');
  });

  it('returns previous Monday for a Wednesday', () => {
    // 2026-04-15 is a Wednesday
    const result = getMondayDate(new Date('2026-04-15T12:00:00Z'));
    assert.equal(result, '2026-04-13');
  });

  it('returns previous Monday for a Sunday', () => {
    // 2026-04-19 is a Sunday
    const result = getMondayDate(new Date('2026-04-19T12:00:00Z'));
    assert.equal(result, '2026-04-13');
  });

  it('returns previous Monday for a Saturday', () => {
    // 2026-04-18 is a Saturday
    const result = getMondayDate(new Date('2026-04-18T12:00:00Z'));
    assert.equal(result, '2026-04-13');
  });
});

describe('createLogEntry', () => {
  it('creates a valid log entry with required fields', () => {
    const entry = createLogEntry({
      agentId: 'agent-test-abc123',
      status: 'completed',
      title: 'Ran weekly report generation',
    });

    assert.match(entry.id, /^log-[a-f0-9]+$/);
    assert.ok(entry.timestamp);
    assert.equal(entry.agentId, 'agent-test-abc123');
    assert.equal(entry.status, 'completed');
    assert.equal(entry.title, 'Ran weekly report generation');
    assert.equal(entry.taskId, undefined);
    assert.equal(entry.duration, undefined);
    assert.equal(entry.metadata, undefined);
  });

  it('includes optional fields when provided', () => {
    const entry = createLogEntry({
      agentId: 'agent-test-abc123',
      taskId: 'task-abc12345',
      status: 'completed',
      title: 'Completed code review',
      duration: 45000,
      metadata: { tokensUsed: 12500, filesReviewed: 3 },
    });

    assert.equal(entry.taskId, 'task-abc12345');
    assert.equal(entry.duration, 45000);
    assert.deepEqual(entry.metadata, { tokensUsed: 12500, filesReviewed: 3 });
  });

  it('passes schema validation', () => {
    const entry = createLogEntry({
      agentId: 'agent-test-abc123',
      taskId: 'task-abc12345',
      status: 'started',
      title: 'Starting task execution',
      duration: 0,
    });

    const result = validateActivityLogEntry(entry);
    assert.equal(result.valid, true, `Validation errors: ${JSON.stringify(result.errors)}`);
  });
});

describe('activityLogEntry schema validation', () => {
  it('rejects entry without required fields', () => {
    const result = validateActivityLogEntry({ id: 'log-aabb0011' });
    assert.equal(result.valid, false);
  });

  it('rejects invalid status', () => {
    const result = validateActivityLogEntry({
      id: 'log-aabb0011',
      timestamp: new Date().toISOString(),
      agentId: 'agent-test-abc123',
      status: 'invalid-status',
      title: 'Test',
    });
    assert.equal(result.valid, false);
  });

  it('rejects invalid id pattern', () => {
    const result = validateActivityLogEntry({
      id: 'bad-id',
      timestamp: new Date().toISOString(),
      agentId: 'agent-test-abc123',
      status: 'completed',
      title: 'Test',
    });
    assert.equal(result.valid, false);
  });

  it('rejects empty description', () => {
    const result = validateActivityLogEntry({
      id: 'log-aabb0011',
      timestamp: new Date().toISOString(),
      agentId: 'agent-test-abc123',
      status: 'completed',
      title: '',
    });
    assert.equal(result.valid, false);
  });

  it('rejects negative duration', () => {
    const result = validateActivityLogEntry({
      id: 'log-aabb0011',
      timestamp: new Date().toISOString(),
      agentId: 'agent-test-abc123',
      status: 'completed',
      title: 'Test',
      duration: -1,
    });
    assert.equal(result.valid, false);
  });

  it('accepts all valid statuses', () => {
    for (const status of ['started', 'completed', 'failed', 'skipped', 'delegated']) {
      const result = validateActivityLogEntry({
        id: 'log-aabb0011',
        timestamp: new Date().toISOString(),
        agentId: 'agent-test-abc123',
        status,
        title: 'Test',
      });
      assert.equal(result.valid, true, `Status "${status}" should be valid`);
    }
  });

  it('rejects additional properties', () => {
    const result = validateActivityLogEntry({
      id: 'log-aabb0011',
      timestamp: new Date().toISOString(),
      agentId: 'agent-test-abc123',
      status: 'completed',
      title: 'Test',
      extraField: 'not allowed',
    });
    assert.equal(result.valid, false);
  });
});

describe('activityLog (array) schema validation', () => {
  it('validates an empty array', () => {
    const result = validateActivityLog([]);
    assert.equal(result.valid, true);
  });

  it('validates an array of valid entries', () => {
    const entries: ActivityLogEntry[] = [
      createLogEntry({ agentId: 'agent-a-1234abcd', status: 'started', title: 'Begin' }),
      createLogEntry({ agentId: 'agent-a-1234abcd', status: 'completed', title: 'Done', duration: 5000 }),
    ];
    const result = validateActivityLog(entries);
    assert.equal(result.valid, true);
  });

  it('rejects array with invalid entry', () => {
    const result = validateActivityLog([{ bad: 'entry' }]);
    assert.equal(result.valid, false);
  });
});

describe('ActivityLogStore', () => {
  let tmpDir: string;
  let store: ActivityLogStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-log-test-'));
    store = new ActivityLogStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const AGENT_ID = 'agent-test-abc12345';

  describe('init', () => {
    it('creates the logs directory', async () => {
      await store.init(AGENT_ID);
      const { stat } = await import('node:fs/promises');
      const s = await stat(join(tmpDir, AGENT_ID, 'logs'));
      assert.ok(s.isDirectory());
    });

    it('is idempotent', async () => {
      await store.init(AGENT_ID);
      await store.init(AGENT_ID);
      // No error thrown
    });
  });

  describe('load', () => {
    it('returns empty array when no log file exists', async () => {
      const entries = await store.load(AGENT_ID, '2026-04-13');
      assert.deepEqual(entries, []);
    });

    it('loads previously saved entries', async () => {
      const entry = createLogEntry({
        agentId: AGENT_ID,
        status: 'completed',
        title: 'Test task',
        duration: 1000,
      });
      await store.append(AGENT_ID, entry);

      const monday = getMondayDate(new Date(entry.timestamp));
      const loaded = await store.load(AGENT_ID, monday);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.id, entry.id);
    });
  });

  describe('append', () => {
    it('appends a valid entry to the log', async () => {
      const entry = createLogEntry({
        agentId: AGENT_ID,
        status: 'started',
        title: 'Starting task',
      });

      const result = await store.append(AGENT_ID, entry);
      assert.equal(result.id, entry.id);

      const monday = getMondayDate(new Date(entry.timestamp));
      const loaded = await store.load(AGENT_ID, monday);
      assert.equal(loaded.length, 1);
    });

    it('appends multiple entries to the same week', async () => {
      const entry1 = createLogEntry({
        agentId: AGENT_ID,
        status: 'started',
        title: 'Starting task',
      });
      const entry2 = createLogEntry({
        agentId: AGENT_ID,
        status: 'completed',
        title: 'Task done',
        duration: 5000,
      });

      await store.append(AGENT_ID, entry1);
      await store.append(AGENT_ID, entry2);

      const monday = getMondayDate(new Date(entry1.timestamp));
      const loaded = await store.load(AGENT_ID, monday);
      assert.equal(loaded.length, 2);
    });

    it('is idempotent — same entry ID not duplicated', async () => {
      const entry = createLogEntry({
        agentId: AGENT_ID,
        status: 'completed',
        title: 'Idempotent test',
      });

      await store.append(AGENT_ID, entry);
      await store.append(AGENT_ID, entry);
      await store.append(AGENT_ID, entry);

      const monday = getMondayDate(new Date(entry.timestamp));
      const loaded = await store.load(AGENT_ID, monday);
      assert.equal(loaded.length, 1, 'Duplicate entries must not be created');
    });

    it('rejects invalid entries', async () => {
      await assert.rejects(
        () => store.append(AGENT_ID, { bad: 'data' } as unknown as ActivityLogEntry),
        /Schema validation failed/,
      );
    });

    it('preserves all entry fields', async () => {
      const entry = createLogEntry({
        agentId: AGENT_ID,
        taskId: 'task-xyz99887',
        status: 'completed',
        title: 'Full entry',
        duration: 12345,
        metadata: { tokensUsed: 5000 },
      });

      await store.append(AGENT_ID, entry);
      const monday = getMondayDate(new Date(entry.timestamp));
      const loaded = await store.load(AGENT_ID, monday);
      assert.deepEqual(loaded[0], entry);
    });
  });

  describe('listWeeks', () => {
    it('returns empty array when no logs exist', async () => {
      const weeks = await store.listWeeks(AGENT_ID);
      assert.deepEqual(weeks, []);
    });

    it('lists week keys after appending entries', async () => {
      const entry = createLogEntry({
        agentId: AGENT_ID,
        status: 'completed',
        title: 'Test',
      });
      await store.append(AGENT_ID, entry);

      const weeks = await store.listWeeks(AGENT_ID);
      assert.equal(weeks.length, 1);
      assert.match(weeks[0] as string, /^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('query', () => {
    it('returns all entries when no filters provided', async () => {
      const e1 = createLogEntry({ agentId: AGENT_ID, status: 'started', title: 'A' });
      const e2 = createLogEntry({ agentId: AGENT_ID, status: 'completed', title: 'B' });
      await store.append(AGENT_ID, e1);
      await store.append(AGENT_ID, e2);

      const results = await store.query(AGENT_ID);
      assert.equal(results.length, 2);
    });

    it('filters by status', async () => {
      const e1 = createLogEntry({ agentId: AGENT_ID, status: 'started', title: 'A' });
      const e2 = createLogEntry({ agentId: AGENT_ID, status: 'completed', title: 'B' });
      const e3 = createLogEntry({ agentId: AGENT_ID, status: 'failed', title: 'C' });
      await store.append(AGENT_ID, e1);
      await store.append(AGENT_ID, e2);
      await store.append(AGENT_ID, e3);

      const results = await store.query(AGENT_ID, { status: 'completed' });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.status, 'completed');
    });

    it('filters by taskId', async () => {
      const e1 = createLogEntry({ agentId: AGENT_ID, taskId: 'task-aaa', status: 'started', title: 'A' });
      const e2 = createLogEntry({ agentId: AGENT_ID, taskId: 'task-bbb', status: 'started', title: 'B' });
      await store.append(AGENT_ID, e1);
      await store.append(AGENT_ID, e2);

      const results = await store.query(AGENT_ID, { taskId: 'task-aaa' });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.taskId, 'task-aaa');
    });

    it('combines status and taskId filters', async () => {
      const e1 = createLogEntry({ agentId: AGENT_ID, taskId: 'task-aaa', status: 'started', title: 'A' });
      const e2 = createLogEntry({ agentId: AGENT_ID, taskId: 'task-aaa', status: 'completed', title: 'B' });
      const e3 = createLogEntry({ agentId: AGENT_ID, taskId: 'task-bbb', status: 'completed', title: 'C' });
      await store.append(AGENT_ID, e1);
      await store.append(AGENT_ID, e2);
      await store.append(AGENT_ID, e3);

      const results = await store.query(AGENT_ID, { taskId: 'task-aaa', status: 'completed' });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.title, 'B');
    });

    it('returns empty when no matches', async () => {
      const e1 = createLogEntry({ agentId: AGENT_ID, status: 'started', title: 'A' });
      await store.append(AGENT_ID, e1);

      const results = await store.query(AGENT_ID, { status: 'failed' });
      assert.equal(results.length, 0);
    });
  });

  describe('summary', () => {
    it('returns zero counts for empty log', async () => {
      const result = await store.summary(AGENT_ID, '2026-04-13');
      assert.equal(result.entryCount, 0);
      assert.deepEqual(result.byStatus, {});
      assert.equal(result.totalDuration, 0);
    });

    it('computes correct counts and duration', async () => {
      const e1 = createLogEntry({ agentId: AGENT_ID, status: 'started', title: 'A', duration: 1000 });
      const e2 = createLogEntry({ agentId: AGENT_ID, status: 'completed', title: 'B', duration: 2000 });
      const e3 = createLogEntry({ agentId: AGENT_ID, status: 'completed', title: 'C', duration: 3000 });
      const e4 = createLogEntry({ agentId: AGENT_ID, status: 'failed', title: 'D' });
      await store.append(AGENT_ID, e1);
      await store.append(AGENT_ID, e2);
      await store.append(AGENT_ID, e3);
      await store.append(AGENT_ID, e4);

      const monday = getMondayDate(new Date(e1.timestamp));
      const result = await store.summary(AGENT_ID, monday);
      assert.equal(result.entryCount, 4);
      assert.equal(result.byStatus.started, 1);
      assert.equal(result.byStatus.completed, 2);
      assert.equal(result.byStatus.failed, 1);
      assert.equal(result.totalDuration, 6000);
    });

    it('includes weekMonday in summary', async () => {
      const result = await store.summary(AGENT_ID, '2026-04-13');
      assert.equal(result.weekMonday, '2026-04-13');
    });
  });
});
