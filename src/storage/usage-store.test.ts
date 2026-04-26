/**
 * Tests for UsageStore and usage record schema validation.
 *
 * The runtime/contract assertions are unchanged from the original `.js`
 * test — this file is the strict-mode TypeScript port that lands as part
 * of seed-03-storage-C-final's storage migration. Types are imported
 * from the migrated `./usage-store.js` source via NodeNext extension
 * resolution; type-only imports use `import type` so they erase at
 * runtime under `node --test`.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageStore, createUsageRecord, getMondayDate } from './usage-store.js';
import { validateUsageRecord, validateUsageLog } from '../schemas/validator.js';

/**
 * Inferred from the migrated `createUsageRecord` factory so the test
 * stays in lockstep with the source's declared return shape — without
 * forcing a hard re-export of an internal type alias.
 */
type UsageRecord = ReturnType<typeof createUsageRecord>;

describe('usage-store getMondayDate', () => {
  it('returns Monday for a Monday date', () => {
    const result = getMondayDate(new Date('2026-04-13T12:00:00Z'));
    assert.equal(result, '2026-04-13');
  });

  it('returns previous Monday for a Wednesday', () => {
    const result = getMondayDate(new Date('2026-04-15T12:00:00Z'));
    assert.equal(result, '2026-04-13');
  });

  it('returns previous Monday for a Sunday', () => {
    const result = getMondayDate(new Date('2026-04-19T12:00:00Z'));
    assert.equal(result, '2026-04-13');
  });

  it('returns previous Monday for a Saturday', () => {
    const result = getMondayDate(new Date('2026-04-18T12:00:00Z'));
    assert.equal(result, '2026-04-13');
  });
});

describe('createUsageRecord', () => {
  it('creates a valid record with required fields', () => {
    const record = createUsageRecord({
      agentId: 'agent-test-abc123',
      taskId: 'task-001',
      inputTokens: 1000,
      outputTokens: 500,
      week: '2026-04-13',
    });

    assert.match(record.id, /^usage-[a-f0-9]+$/);
    assert.ok(record.timestamp);
    assert.equal(record.agentId, 'agent-test-abc123');
    assert.equal(record.taskId, 'task-001');
    assert.equal(record.inputTokens, 1000);
    assert.equal(record.outputTokens, 500);
    assert.equal(record.totalTokens, 1500);
    assert.equal(record.week, '2026-04-13');

    const v = validateUsageRecord(record);
    assert.ok(v.valid, `Schema validation failed: ${JSON.stringify(v.errors)}`);
  });

  it('includes optional fields when provided', () => {
    const record = createUsageRecord({
      agentId: 'agent-test',
      taskId: 'task-002',
      sessionId: 'sess-xyz',
      inputTokens: 2000,
      outputTokens: 800,
      costUsd: 0.05,
      durationMs: 30000,
      model: 'opus',
      week: '2026-04-13',
    });

    assert.equal(record.sessionId, 'sess-xyz');
    assert.equal(record.costUsd, 0.05);
    assert.equal(record.durationMs, 30000);
    assert.equal(record.model, 'opus');

    const v = validateUsageRecord(record);
    assert.ok(v.valid, `Schema validation failed: ${JSON.stringify(v.errors)}`);
  });

  it('computes totalTokens as sum of input + output', () => {
    const record = createUsageRecord({
      agentId: 'agent-test',
      taskId: 'task-003',
      inputTokens: 3000,
      outputTokens: 1500,
    });
    assert.equal(record.totalTokens, 4500);
  });

  it('defaults week from timestamp if not provided', () => {
    const record = createUsageRecord({
      agentId: 'agent-test',
      taskId: 'task-004',
      inputTokens: 100,
      outputTokens: 50,
      timestamp: '2026-04-15T10:00:00.000Z', // Wednesday → Monday = 2026-04-13
    });
    assert.equal(record.week, '2026-04-13');
  });

  it('omits costUsd when zero', () => {
    const record = createUsageRecord({
      agentId: 'agent-test',
      taskId: 'task-005',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0,
    });
    assert.equal(record.costUsd, undefined);
  });
});

describe('usage record schema validation', () => {
  it('rejects record missing required fields', () => {
    const v = validateUsageRecord({ id: 'usage-abc123' });
    assert.equal(v.valid, false);
  });

  it('rejects record with invalid id pattern', () => {
    const v = validateUsageRecord({
      id: 'bad-id',
      timestamp: new Date().toISOString(),
      agentId: 'agent-1',
      taskId: 'task-1',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      week: '2026-04-13',
    });
    assert.equal(v.valid, false);
  });

  it('rejects negative token counts', () => {
    const v = validateUsageRecord({
      id: 'usage-abc12345',
      timestamp: new Date().toISOString(),
      agentId: 'agent-1',
      taskId: 'task-1',
      inputTokens: -1,
      outputTokens: 0,
      totalTokens: 0,
      week: '2026-04-13',
    });
    assert.equal(v.valid, false);
  });

  it('validates a valid usage log array', () => {
    const record = createUsageRecord({
      agentId: 'agent-test',
      taskId: 'task-1',
      inputTokens: 100,
      outputTokens: 50,
    });
    const v = validateUsageLog([record]);
    assert.ok(v.valid, `Schema validation failed: ${JSON.stringify(v.errors)}`);
  });

  it('validates empty usage log array', () => {
    const v = validateUsageLog([]);
    assert.ok(v.valid);
  });
});

describe('UsageStore', () => {
  let tmpDir: string;
  let store: UsageStore;
  const agentId = 'agent-usage-test';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-usage-test-'));
    store = new UsageStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('returns empty array when no usage file exists', async () => {
      const records = await store.load(agentId, '2026-04-13');
      assert.deepEqual(records, []);
    });

    it('returns records after appending', async () => {
      const record = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 500,
        outputTokens: 200,
        week: '2026-04-13',
      });
      await store.append(agentId, record);

      const records = await store.load(agentId, '2026-04-13');
      assert.equal(records.length, 1);
      assert.equal(records[0].id, record.id);
    });
  });

  describe('append', () => {
    it('creates file and appends record', async () => {
      const record = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 1000,
        outputTokens: 400,
        week: '2026-04-13',
      });
      const result = await store.append(agentId, record);
      assert.equal(result.id, record.id);

      const records = await store.load(agentId, '2026-04-13');
      assert.equal(records.length, 1);
    });

    it('appends multiple records to same week', async () => {
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 500,
        outputTokens: 200,
        week: '2026-04-13',
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 800,
        outputTokens: 300,
        week: '2026-04-13',
      });
      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const records = await store.load(agentId, '2026-04-13');
      assert.equal(records.length, 2);
    });

    it('is idempotent — duplicate ID is not added', async () => {
      const record = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 500,
        outputTokens: 200,
        week: '2026-04-13',
      });
      await store.append(agentId, record);
      await store.append(agentId, record); // duplicate

      const records = await store.load(agentId, '2026-04-13');
      assert.equal(records.length, 1);
    });

    it('separates records by week', async () => {
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 500,
        outputTokens: 200,
        week: '2026-04-13',
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 600,
        outputTokens: 250,
        week: '2026-04-20',
      });
      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const week1 = await store.load(agentId, '2026-04-13');
      const week2 = await store.load(agentId, '2026-04-20');
      assert.equal(week1.length, 1);
      assert.equal(week2.length, 1);
      assert.equal(week1[0].taskId, 'task-1');
      assert.equal(week2[0].taskId, 'task-2');
    });
  });

  describe('listWeeks', () => {
    it('returns empty array when no usage exists', async () => {
      const weeks = await store.listWeeks(agentId);
      assert.deepEqual(weeks, []);
    });

    it('returns sorted week keys', async () => {
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 100,
        outputTokens: 50,
        week: '2026-04-20',
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 100,
        outputTokens: 50,
        week: '2026-04-13',
      });
      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const weeks = await store.listWeeks(agentId);
      assert.deepEqual(weeks, ['2026-04-13', '2026-04-20']);
    });
  });

  describe('weeklyTotal', () => {
    it('returns zeros for empty week', async () => {
      const total = await store.weeklyTotal(agentId, '2026-04-13');
      assert.equal(total.weekMonday, '2026-04-13');
      assert.equal(total.recordCount, 0);
      assert.equal(total.inputTokens, 0);
      assert.equal(total.outputTokens, 0);
      assert.equal(total.totalTokens, 0);
      assert.equal(total.costUsd, 0);
    });

    it('sums tokens across multiple records', async () => {
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 1000,
        outputTokens: 400,
        costUsd: 0.02,
        week: '2026-04-13',
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 2000,
        outputTokens: 800,
        costUsd: 0.04,
        week: '2026-04-13',
      });
      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const total = await store.weeklyTotal(agentId, '2026-04-13');
      assert.equal(total.recordCount, 2);
      assert.equal(total.inputTokens, 3000);
      assert.equal(total.outputTokens, 1200);
      assert.equal(total.totalTokens, 4200);
      assert.equal(total.costUsd, 0.06);
    });

    it('does not include records from other weeks', async () => {
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 1000,
        outputTokens: 400,
        week: '2026-04-13',
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 5000,
        outputTokens: 2000,
        week: '2026-04-20',
      });
      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const total = await store.weeklyTotal(agentId, '2026-04-13');
      assert.equal(total.totalTokens, 1400);
    });
  });

  describe('query', () => {
    it('returns all records when no filters', async () => {
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 100,
        outputTokens: 50,
        week: '2026-04-13',
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 200,
        outputTokens: 100,
        week: '2026-04-13',
      });
      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const results = await store.query(agentId, { weekMonday: '2026-04-13' });
      assert.equal(results.length, 2);
    });

    it('filters by taskId', async () => {
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 100,
        outputTokens: 50,
        week: '2026-04-13',
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 200,
        outputTokens: 100,
        week: '2026-04-13',
      });
      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const results = await store.query(agentId, { weekMonday: '2026-04-13', taskId: 'task-1' });
      assert.equal(results.length, 1);
      assert.equal(results[0].taskId, 'task-1');
    });

    it('filters by model', async () => {
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 100,
        outputTokens: 50,
        model: 'opus',
        week: '2026-04-13',
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-2',
        inputTokens: 200,
        outputTokens: 100,
        model: 'sonnet',
        week: '2026-04-13',
      });
      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const results = await store.query(agentId, { weekMonday: '2026-04-13', model: 'opus' });
      assert.equal(results.length, 1);
      assert.equal(results[0].model, 'opus');
    });
  });

  describe('delete idempotency', () => {
    it('loading nonexistent agent returns empty without error', async () => {
      const records = await store.load('nonexistent-agent', '2026-04-13');
      assert.deepEqual(records, []);
    });
  });

  describe('accumulation logic', () => {
    it('accumulates tokens across many records in the same week', async () => {
      const records: UsageRecord[] = [];
      for (let i = 0; i < 10; i++) {
        records.push(
          createUsageRecord({
            agentId,
            taskId: `task-${i}`,
            inputTokens: 100 * (i + 1),
            outputTokens: 50 * (i + 1),
            week: '2026-04-13',
          }),
        );
      }

      for (const r of records) {
        await store.append(agentId, r);
      }

      const total = await store.weeklyTotal(agentId, '2026-04-13');
      // sum of 100*(1..10) = 5500, sum of 50*(1..10) = 2750
      assert.equal(total.inputTokens, 5500);
      assert.equal(total.outputTokens, 2750);
      assert.equal(total.totalTokens, 8250);
      assert.equal(total.recordCount, 10);
    });

    it('accumulates cost without floating point drift', async () => {
      // Append many small costs that could cause drift
      for (let i = 0; i < 7; i++) {
        const r = createUsageRecord({
          agentId,
          taskId: `task-${i}`,
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.01,
          week: '2026-04-13',
        });
        await store.append(agentId, r);
      }

      const total = await store.weeklyTotal(agentId, '2026-04-13');
      assert.equal(total.costUsd, 0.07);
    });

    it('idempotent append does not inflate totals', async () => {
      const record = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 500,
        outputTokens: 200,
        week: '2026-04-13',
      });

      // Append same record 5 times (simulates repeated heartbeats)
      for (let i = 0; i < 5; i++) {
        await store.append(agentId, record);
      }

      const total = await store.weeklyTotal(agentId, '2026-04-13');
      assert.equal(total.recordCount, 1);
      assert.equal(total.totalTokens, 700);
    });
  });

  describe('weekly rollover', () => {
    it('each week starts from zero — no carryover between budget periods', async () => {
      // Record heavy usage in week 1
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-1',
        inputTokens: 50000,
        outputTokens: 25000,
        week: '2026-04-06',
      });
      await store.append(agentId, r1);

      // New week (Monday rollover) should have zero usage
      const week2Total = await store.weeklyTotal(agentId, '2026-04-13');
      assert.equal(week2Total.totalTokens, 0);
      assert.equal(week2Total.recordCount, 0);

      // Week 1 still retains its data
      const week1Total = await store.weeklyTotal(agentId, '2026-04-06');
      assert.equal(week1Total.totalTokens, 75000);
    });

    it('tracks usage independently across multiple weeks', async () => {
      const weeks: readonly string[] = ['2026-03-30', '2026-04-06', '2026-04-13', '2026-04-20'];
      for (let i = 0; i < weeks.length; i++) {
        const r = createUsageRecord({
          agentId,
          taskId: `task-week-${i}`,
          inputTokens: 1000 * (i + 1),
          outputTokens: 500 * (i + 1),
          week: weeks[i],
        });
        await store.append(agentId, r);
      }

      const allWeeks = await store.listWeeks(agentId);
      assert.deepEqual(allWeeks, weeks);

      for (let i = 0; i < weeks.length; i++) {
        const total = await store.weeklyTotal(agentId, weeks[i]);
        assert.equal(total.recordCount, 1);
        assert.equal(total.inputTokens, 1000 * (i + 1));
        assert.equal(total.outputTokens, 500 * (i + 1));
      }
    });

    it('records with timestamps in the same week land in the same file', async () => {
      // Tuesday and Friday of the same week → same Monday key
      const r1 = createUsageRecord({
        agentId,
        taskId: 'task-tue',
        inputTokens: 100,
        outputTokens: 50,
        timestamp: '2026-04-14T10:00:00.000Z', // Tuesday
      });
      const r2 = createUsageRecord({
        agentId,
        taskId: 'task-fri',
        inputTokens: 200,
        outputTokens: 100,
        timestamp: '2026-04-17T10:00:00.000Z', // Friday
      });

      assert.equal(r1.week, '2026-04-13');
      assert.equal(r2.week, '2026-04-13');

      await store.append(agentId, r1);
      await store.append(agentId, r2);

      const total = await store.weeklyTotal(agentId, '2026-04-13');
      assert.equal(total.recordCount, 2);
      assert.equal(total.totalTokens, 450);
    });

    it('Sunday record rolls to previous Monday, not next', async () => {
      const r = createUsageRecord({
        agentId,
        taskId: 'task-sun',
        inputTokens: 100,
        outputTokens: 50,
        timestamp: '2026-04-19T23:59:59.000Z', // Sunday night
      });

      assert.equal(r.week, '2026-04-13'); // Should be previous Monday
      await store.append(agentId, r);

      const prevWeek = await store.weeklyTotal(agentId, '2026-04-13');
      assert.equal(prevWeek.recordCount, 1);

      const nextWeek = await store.weeklyTotal(agentId, '2026-04-20');
      assert.equal(nextWeek.recordCount, 0);
    });
  });

  describe('concurrent agent tracking', () => {
    const agent1 = 'agent-alpha';
    const agent2 = 'agent-beta';
    const agent3 = 'agent-gamma';

    it('tracks usage independently for different agents in the same week', async () => {
      const r1 = createUsageRecord({
        agentId: agent1,
        taskId: 'task-a1',
        inputTokens: 1000,
        outputTokens: 500,
        week: '2026-04-13',
      });
      const r2 = createUsageRecord({
        agentId: agent2,
        taskId: 'task-b1',
        inputTokens: 2000,
        outputTokens: 1000,
        week: '2026-04-13',
      });
      await store.append(agent1, r1);
      await store.append(agent2, r2);

      const t1 = await store.weeklyTotal(agent1, '2026-04-13');
      const t2 = await store.weeklyTotal(agent2, '2026-04-13');

      assert.equal(t1.totalTokens, 1500);
      assert.equal(t2.totalTokens, 3000);
    });

    it('parallel appends for multiple agents do not interfere', async () => {
      // Simulate parallel heartbeat: all agents write at the same time
      const agentIds: readonly string[] = [agent1, agent2, agent3];
      const records: UsageRecord[] = agentIds.map((id, i) =>
        createUsageRecord({
          agentId: id,
          taskId: `task-${i}`,
          inputTokens: 1000 * (i + 1),
          outputTokens: 500 * (i + 1),
          week: '2026-04-13',
        }),
      );

      await Promise.all(
        records.map((r, i) => store.append(agentIds[i], r)),
      );

      const t1 = await store.weeklyTotal(agent1, '2026-04-13');
      const t2 = await store.weeklyTotal(agent2, '2026-04-13');
      const t3 = await store.weeklyTotal(agent3, '2026-04-13');

      assert.equal(t1.totalTokens, 1500);
      assert.equal(t2.totalTokens, 3000);
      assert.equal(t3.totalTokens, 4500);
    });

    it('one agent heavy usage does not affect another agent totals', async () => {
      // Agent 1 uses a lot of tokens across many sessions
      for (let i = 0; i < 5; i++) {
        const r = createUsageRecord({
          agentId: agent1,
          taskId: `heavy-${i}`,
          inputTokens: 10000,
          outputTokens: 5000,
          week: '2026-04-13',
        });
        await store.append(agent1, r);
      }

      // Agent 2 uses a small amount
      const r2 = createUsageRecord({
        agentId: agent2,
        taskId: 'light-0',
        inputTokens: 100,
        outputTokens: 50,
        week: '2026-04-13',
      });
      await store.append(agent2, r2);

      const t1 = await store.weeklyTotal(agent1, '2026-04-13');
      const t2 = await store.weeklyTotal(agent2, '2026-04-13');

      assert.equal(t1.totalTokens, 75000);
      assert.equal(t2.totalTokens, 150);
    });

    it('agents track different weeks independently', async () => {
      const r1 = createUsageRecord({
        agentId: agent1,
        taskId: 'task-a-w1',
        inputTokens: 1000,
        outputTokens: 500,
        week: '2026-04-06',
      });
      const r2 = createUsageRecord({
        agentId: agent2,
        taskId: 'task-b-w2',
        inputTokens: 2000,
        outputTokens: 1000,
        week: '2026-04-13',
      });
      await store.append(agent1, r1);
      await store.append(agent2, r2);

      // Agent 1 has nothing in week 2
      const a1w2 = await store.weeklyTotal(agent1, '2026-04-13');
      assert.equal(a1w2.totalTokens, 0);

      // Agent 2 has nothing in week 1
      const a2w1 = await store.weeklyTotal(agent2, '2026-04-06');
      assert.equal(a2w1.totalTokens, 0);

      // Each agent has its data in its own week
      const a1w1 = await store.weeklyTotal(agent1, '2026-04-06');
      const a2w2 = await store.weeklyTotal(agent2, '2026-04-13');
      assert.equal(a1w1.totalTokens, 1500);
      assert.equal(a2w2.totalTokens, 3000);
    });

    it('listWeeks returns different weeks per agent', async () => {
      const r1 = createUsageRecord({
        agentId: agent1,
        taskId: 'task-1',
        inputTokens: 100,
        outputTokens: 50,
        week: '2026-04-06',
      });
      const r2 = createUsageRecord({
        agentId: agent1,
        taskId: 'task-2',
        inputTokens: 100,
        outputTokens: 50,
        week: '2026-04-13',
      });
      const r3 = createUsageRecord({
        agentId: agent2,
        taskId: 'task-3',
        inputTokens: 100,
        outputTokens: 50,
        week: '2026-04-13',
      });
      await store.append(agent1, r1);
      await store.append(agent1, r2);
      await store.append(agent2, r3);

      const weeks1 = await store.listWeeks(agent1);
      const weeks2 = await store.listWeeks(agent2);
      assert.deepEqual(weeks1, ['2026-04-06', '2026-04-13']);
      assert.deepEqual(weeks2, ['2026-04-13']);
    });
  });
});
