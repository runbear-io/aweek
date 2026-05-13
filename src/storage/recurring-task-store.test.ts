/**
 * Tests for the RecurringTaskStore — round-trip persistence of
 * RecurringTask documents under .aweek/agents/<slug>/recurring-tasks.json,
 * plus AJV validation of the canonical shape.
 *
 * AC1: a RecurringTask created with `freq: 'weekly'`, `interval: 2`, and
 * `byDay: ['MO', 'WE']` (the biweekly Mon/Wed pattern in the seed)
 * persists to .aweek/agents/<slug>/recurring-tasks.json and validates
 * against the AJV schema both on save and on reload.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RECURRING_TASKS_FILENAME,
  RecurringTaskStore,
  type RecurringTask,
} from './recurring-task-store.js';
import {
  validateRecurringTask,
  validateRecurringTaskList,
  validateRecurrenceRule,
} from '../schemas/validator.js';

describe('RecurringTaskStore', () => {
  let store: RecurringTaskStore;
  let tmpDir: string;
  const agentId = 'agent-rec-test-abc12345';

  /**
   * Build the canonical AC1 fixture: a biweekly Mon/Wed recurring task.
   * Freq=weekly, interval=2 = every other week; byDay=[MO, WE] = on
   * Monday and Wednesday of each active week. dtStart anchors the
   * wall-clock hour (09:00 Pacific) and the first eligible week.
   */
  function buildBiweeklyMonWedTask(): RecurringTask {
    return {
      id: 'rec-biweekly-mon-wed',
      template: {
        title: 'Biweekly status report',
        prompt: 'Compile this week\'s status report and send to the CEO.',
        priority: 'medium',
        estimatedMinutes: 45,
        objectiveId: '2026-05',
      },
      rule: {
        freq: 'weekly',
        interval: 2,
        byDay: ['MO', 'WE'],
        dtStart: '2026-05-04T16:00:00Z',
        timeZone: 'America/Los_Angeles',
      },
      createdAt: '2026-05-01T00:00:00Z',
    };
  }

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-rec-task-test-'));
    store = new RecurringTaskStore(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // AC1 — biweekly Mon/Wed RecurringTask round-trips AJV-valid
  // ---------------------------------------------------------------------------

  describe('AC1 — biweekly Mon/Wed recurring task', () => {
    it('validates as a RecurringTask under aweek://schemas/recurring-task', () => {
      const record = buildBiweeklyMonWedTask();
      const result = validateRecurringTask(record);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('rule alone validates as recurrence-rule (freq=weekly, interval=2, byDay=[MO,WE])', () => {
      const { rule } = buildBiweeklyMonWedTask();
      assert.equal(rule.freq, 'weekly');
      assert.equal(rule.interval, 2);
      assert.deepStrictEqual(rule.byDay, ['MO', 'WE']);
      const result = validateRecurrenceRule(rule);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('persists to .aweek/agents/<slug>/recurring-tasks.json and round-trips', async () => {
      const record = buildBiweeklyMonWedTask();
      await store.save(agentId, record);

      const filePath = join(tmpDir, agentId, RECURRING_TASKS_FILENAME);
      const fileStat = await stat(filePath);
      assert.ok(fileStat.isFile(), 'recurring-tasks.json should be a regular file');

      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      assert.ok(Array.isArray(parsed), 'on-disk shape is an array of RecurringTask');
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'rec-biweekly-mon-wed');
      assert.equal(parsed[0].rule.freq, 'weekly');
      assert.equal(parsed[0].rule.interval, 2);
      assert.deepStrictEqual(parsed[0].rule.byDay, ['MO', 'WE']);

      const loaded = await store.load(agentId, record.id);
      assert.deepStrictEqual(loaded, record);
    });

    it('on-disk file validates as recurring-task-list (the whole list shape)', async () => {
      const record = buildBiweeklyMonWedTask();
      await store.save(agentId, record);
      const filePath = join(tmpDir, agentId, RECURRING_TASKS_FILENAME);
      const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
      const result = validateRecurringTaskList(parsed);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('loadAll returns the persisted record', async () => {
      const record = buildBiweeklyMonWedTask();
      await store.save(agentId, record);
      const all = await store.loadAll(agentId);
      assert.equal(all.length, 1);
      assert.deepStrictEqual(all[0], record);
    });

    it('loadAll returns [] for an agent with no recurring-tasks.json (backward compat)', async () => {
      const all = await store.loadAll('agent-no-recurring-tasks-yet');
      assert.deepStrictEqual(all, []);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation guards — reject malformed input on save
  // ---------------------------------------------------------------------------

  describe('validation guards', () => {
    it('rejects an unknown freq value', async () => {
      const bad = buildBiweeklyMonWedTask();
      // Cast through unknown — runtime AJV must reject even when the
      // type system would otherwise refuse.
      (bad.rule as unknown as { freq: string }).freq = 'yearly';
      await assert.rejects(() => store.save(agentId, bad), /Schema validation failed/);
    });

    it('rejects interval < 1', async () => {
      const bad = buildBiweeklyMonWedTask();
      bad.rule.interval = 0;
      await assert.rejects(() => store.save(agentId, bad), /Schema validation failed/);
    });

    it('rejects unknown byDay codes', async () => {
      const bad = buildBiweeklyMonWedTask();
      (bad.rule as unknown as { byDay: string[] }).byDay = ['MO', 'XX'];
      await assert.rejects(() => store.save(agentId, bad), /Schema validation failed/);
    });

    it('rejects when both count and until are present (RFC 5545 XOR)', async () => {
      const bad = buildBiweeklyMonWedTask();
      bad.rule.count = 10;
      bad.rule.until = '2026-12-31T00:00:00Z';
      await assert.rejects(() => store.save(agentId, bad), /Schema validation failed/);
    });

    it('accepts a rule with only count', async () => {
      const ok = buildBiweeklyMonWedTask();
      ok.id = 'rec-count-only';
      ok.rule.count = 5;
      const result = validateRecurringTask(ok);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('accepts a rule with only until', async () => {
      const ok = buildBiweeklyMonWedTask();
      ok.id = 'rec-until-only';
      ok.rule.until = '2026-12-31T00:00:00Z';
      const result = validateRecurringTask(ok);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('rejects an id that does not match rec-<slug>', async () => {
      const bad = buildBiweeklyMonWedTask();
      bad.id = 'task-not-a-recurring-id';
      await assert.rejects(() => store.save(agentId, bad), /Schema validation failed/);
    });

    it('rejects missing required template fields (no prompt)', async () => {
      const bad = buildBiweeklyMonWedTask();
      delete (bad.template as Partial<typeof bad.template>).prompt;
      await assert.rejects(() => store.save(agentId, bad), /Schema validation failed/);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-record + delete + update
  // ---------------------------------------------------------------------------

  describe('multi-record management', () => {
    const freshAgent = 'agent-rec-multi-00000001';

    it('save() preserves prior records and appends the new one', async () => {
      const r1 = buildBiweeklyMonWedTask();
      const r2: RecurringTask = {
        ...buildBiweeklyMonWedTask(),
        id: 'rec-daily-standup',
        rule: {
          freq: 'daily',
          interval: 1,
          dtStart: '2026-05-04T16:00:00Z',
          timeZone: 'America/Los_Angeles',
        },
      };
      await store.save(freshAgent, r1);
      await store.save(freshAgent, r2);
      const all = await store.loadAll(freshAgent);
      assert.equal(all.length, 2);
      const ids = all.map((r) => r.id).sort();
      assert.deepStrictEqual(ids, ['rec-biweekly-mon-wed', 'rec-daily-standup']);
    });

    it('delete() removes a single record', async () => {
      const removed = await store.delete(freshAgent, 'rec-daily-standup');
      assert.equal(removed, true);
      const all = await store.loadAll(freshAgent);
      assert.equal(all.length, 1);
      assert.equal(all[0]?.id, 'rec-biweekly-mon-wed');
    });

    it('delete() removes the file entirely when the last record is gone', async () => {
      await store.delete(freshAgent, 'rec-biweekly-mon-wed');
      const exists = await store.exists(freshAgent);
      assert.equal(exists, false, 'recurring-tasks.json should be removed on emptying');
    });

    it('update() patches a record and stamps updatedAt', async () => {
      const target = 'agent-rec-update-00000002';
      const r = buildBiweeklyMonWedTask();
      await store.save(target, r);
      const updated = await store.update(target, r.id, (current) => {
        current.template.title = 'Renamed';
        return current;
      });
      assert.ok(updated, 'update should return the patched record');
      assert.equal(updated.template.title, 'Renamed');
      assert.ok(updated.updatedAt, 'updatedAt should be stamped');
    });

    it('update() returns null when the record is missing', async () => {
      const target = 'agent-rec-update-missing-00000003';
      const result = await store.update(target, 'rec-does-not-exist', (r) => r);
      assert.equal(result, null);
    });
  });
});
