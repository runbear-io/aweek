/**
 * Tests for `materializeRecurringForWeek` — the heartbeat-time projection
 * of RecurringTask records into the existing WeeklyPlanStore.
 *
 * AC5 focus: a second run on the same `(agentId, weekKey, recurring-tasks
 * set, tz)` must leave the weekly-plan file BYTE-IDENTICAL on disk. The
 * core test compares both the raw file bytes AND the file's `mtime` after
 * two consecutive materializations — if the materializer accidentally
 * re-wrote the file with the same content (or updated `updatedAt`), the
 * mtime check would catch the silent regression even when the bytes match.
 *
 * Coverage:
 *   - AC5 byte-identity across two runs (the headline check).
 *   - AC5 mtime stability (no silent re-write).
 *   - First-run creation produces a valid weekly plan (`approved: false`).
 *   - Existing-plan merge: new occurrence ids appended; pre-existing
 *     tasks pass through unchanged (status preservation across runs).
 *   - Empty-state idempotence: no agent recurring-tasks + no plan on disk
 *     → unchanged: true on every call, no plan file created.
 *   - Skip exception: occurrence dropped, materialized list shrinks.
 *   - Override exception: title/runAt overlay applied to the materialized
 *     task; the occurrence id remains anchored to the original runAt so
 *     idempotence still holds.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RecurringTaskStore, type RecurringTask } from '../storage/recurring-task-store.js';
import { WeeklyPlanStore, type WeeklyPlan } from '../storage/weekly-plan-store.js';
import { materializeRecurringForWeek } from './recurring-materializer.js';

const AGENT_ID = 'agent-materializer-test';
const TZ = 'America/Los_Angeles';
// W19 of 2026 = the week containing Mon May 4, 2026. Chosen to match the
// AC1 fixture so the biweekly Mon/Wed rule produces occurrences this week.
const WEEK_KEY = '2026-W19';

/**
 * AC1-shaped fixture: biweekly Mon/Wed status report, anchored at
 * 09:00 PT on Mon 2026-05-04 (= 16:00 UTC, the dtStart below).
 */
function buildBiweeklyMonWedTask(): RecurringTask {
  return {
    id: 'rec-biweekly-mon-wed',
    template: {
      title: 'Biweekly status report',
      prompt: "Compile this week's status report and send to the CEO.",
      priority: 'medium',
      estimatedMinutes: 45,
      objectiveId: '2026-05',
    },
    rule: {
      freq: 'weekly',
      interval: 2,
      byDay: ['MO', 'WE'],
      dtStart: '2026-05-04T16:00:00.000Z',
      timeZone: TZ,
    },
    createdAt: '2026-05-01T00:00:00.000Z',
  };
}

describe('materializeRecurringForWeek', () => {
  let tmpRoot: string;
  let weeklyPlanStore: WeeklyPlanStore;
  let recurringTaskStore: RecurringTaskStore;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'aweek-materializer-test-'));
    weeklyPlanStore = new WeeklyPlanStore(tmpRoot);
    recurringTaskStore = new RecurringTaskStore(tmpRoot);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function planPath(): string {
    return join(tmpRoot, AGENT_ID, 'weekly-plans', `${WEEK_KEY}.json`);
  }

  // -------------------------------------------------------------------------
  // AC5 — idempotence (headline)
  // -------------------------------------------------------------------------

  describe('AC5 — idempotence', () => {
    it('second run on same week leaves weekly-plan file byte-identical', async () => {
      await recurringTaskStore.save(AGENT_ID, buildBiweeklyMonWedTask());

      // First materialization: writes the file fresh.
      const r1 = await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
        now: new Date('2026-05-04T00:00:00.000Z'),
      });
      assert.equal(r1.unchanged, false, 'first run should write the plan');
      assert.equal(r1.addedTaskIds.length, 2, 'biweekly Mon/Wed → 2 occurrences this week');

      const bytes1 = await readFile(planPath());
      const mtime1 = (await stat(planPath())).mtimeMs;

      // Pause long enough that any silent re-write would bump mtime.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Second materialization: identical inputs, must NOT touch the file.
      const r2 = await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
        // Deliberately a DIFFERENT `now` — proves the result is
        // independent of wall-clock drift between runs.
        now: new Date('2026-05-04T12:34:56.000Z'),
      });
      assert.equal(r2.unchanged, true, 'second run should be a no-op');
      assert.deepStrictEqual(r2.addedTaskIds, [], 'no new ids added on second run');

      const bytes2 = await readFile(planPath());
      const mtime2 = (await stat(planPath())).mtimeMs;

      assert.equal(
        bytes1.equals(bytes2),
        true,
        'weekly-plan file bytes must be identical across runs (AC5)',
      );
      assert.equal(
        mtime2,
        mtime1,
        'mtime must be unchanged — silent re-writes are not allowed (AC5)',
      );
    });

    it('three consecutive runs all converge to the same bytes', async () => {
      await recurringTaskStore.save(AGENT_ID, buildBiweeklyMonWedTask());
      const opts = {
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
        now: new Date('2026-05-04T00:00:00.000Z'),
      };
      await materializeRecurringForWeek(opts);
      const bytes1 = await readFile(planPath());
      await materializeRecurringForWeek(opts);
      const bytes2 = await readFile(planPath());
      await materializeRecurringForWeek(opts);
      const bytes3 = await readFile(planPath());
      assert.equal(bytes1.equals(bytes2), true);
      assert.equal(bytes2.equals(bytes3), true);
    });

    it('returns unchanged: true on every call when the agent has no recurring tasks AND no plan', async () => {
      const opts = {
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
      };
      const r1 = await materializeRecurringForWeek(opts);
      assert.equal(r1.unchanged, true);
      assert.deepStrictEqual(r1.addedTaskIds, []);
      assert.equal(await weeklyPlanStore.exists(AGENT_ID, WEEK_KEY), false);

      const r2 = await materializeRecurringForWeek(opts);
      assert.equal(r2.unchanged, true);
      assert.equal(await weeklyPlanStore.exists(AGENT_ID, WEEK_KEY), false);
    });
  });

  // -------------------------------------------------------------------------
  // First-run plan shape
  // -------------------------------------------------------------------------

  describe('first run', () => {
    it('creates a valid WeeklyPlan with the recurring tasks pending', async () => {
      await recurringTaskStore.save(AGENT_ID, buildBiweeklyMonWedTask());
      await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
        now: new Date('2026-05-04T00:00:00.000Z'),
      });

      const plan = await weeklyPlanStore.load(AGENT_ID, WEEK_KEY);
      assert.equal(plan.week, WEEK_KEY);
      assert.equal(plan.tasks.length, 2);
      for (const t of plan.tasks) {
        assert.equal(t.status, 'pending');
        assert.equal(t.title, 'Biweekly status report');
        assert.equal(t.priority, 'medium');
        assert.equal(t.estimatedMinutes, 45);
        assert.equal(t.objectiveId, '2026-05');
        assert.ok(t.id.startsWith('task-rec-rec-biweekly-mon-wed-'), `unexpected id: ${t.id}`);
      }
    });

    it('does not create a plan file when there are no recurring tasks', async () => {
      await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
      });
      assert.equal(await weeklyPlanStore.exists(AGENT_ID, WEEK_KEY), false);
    });
  });

  // -------------------------------------------------------------------------
  // Existing-plan merge
  // -------------------------------------------------------------------------

  describe('merge into existing plan', () => {
    it('preserves existing tasks and appends new recurring occurrences', async () => {
      // Seed an existing plan with an unrelated task already in-progress.
      const seedPlan: WeeklyPlan = {
        week: WEEK_KEY,
        month: '2026-05',
        approved: true,
        approvedAt: '2026-05-03T00:00:00.000Z',
        tasks: [
          {
            id: 'task-hand-crafted-1',
            title: 'Manual task',
            prompt: 'Hand-crafted, not from a recurrence rule.',
            status: 'in-progress',
          },
        ],
      };
      await weeklyPlanStore.save(AGENT_ID, seedPlan);

      await recurringTaskStore.save(AGENT_ID, buildBiweeklyMonWedTask());

      const r = await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
      });
      assert.equal(r.unchanged, false);
      assert.equal(r.addedTaskIds.length, 2);

      const plan = await weeklyPlanStore.load(AGENT_ID, WEEK_KEY);
      assert.equal(plan.tasks.length, 3);
      assert.equal(plan.tasks[0].id, 'task-hand-crafted-1');
      assert.equal(plan.tasks[0].status, 'in-progress', 'existing task state preserved');
      assert.equal(plan.approved, true, 'existing approval bit preserved');
    });

    it('preserves heartbeat-updated status on the second run (existing recurring task is sacred)', async () => {
      await recurringTaskStore.save(AGENT_ID, buildBiweeklyMonWedTask());

      // First run materializes the two pending tasks.
      await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
        now: new Date('2026-05-04T00:00:00.000Z'),
      });

      // Simulate the heartbeat flipping the first occurrence to completed.
      let plan = await weeklyPlanStore.load(AGENT_ID, WEEK_KEY);
      const firstTaskId = plan.tasks[0].id;
      await weeklyPlanStore.updateTaskStatus(AGENT_ID, WEEK_KEY, firstTaskId, 'completed');

      // Second run must NOT regress the completed status back to pending.
      const r2 = await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
      });
      assert.equal(r2.unchanged, true, 'no new ids → no write');

      plan = await weeklyPlanStore.load(AGENT_ID, WEEK_KEY);
      const firstTask = plan.tasks.find((t) => t.id === firstTaskId);
      assert.ok(firstTask, 'first task still present');
      assert.equal(firstTask!.status, 'completed', 'heartbeat-set status not regressed');
    });
  });

  // -------------------------------------------------------------------------
  // Exceptions
  // -------------------------------------------------------------------------

  describe('exception handling', () => {
    it('skip exception drops the targeted occurrence', async () => {
      const record = buildBiweeklyMonWedTask();
      // Drop the Wednesday occurrence — Wed 2026-05-06 09:00 PT = 16:00 UTC.
      record.exceptions = [
        { originalRunAt: '2026-05-06T16:00:00.000Z', kind: 'skip' },
      ];
      await recurringTaskStore.save(AGENT_ID, record);

      const r = await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
      });
      assert.equal(r.addedTaskIds.length, 1, 'skip drops one of the two occurrences');

      const plan = await weeklyPlanStore.load(AGENT_ID, WEEK_KEY);
      assert.equal(plan.tasks.length, 1);
    });

    it('override exception applies title overlay and stays idempotent', async () => {
      const record = buildBiweeklyMonWedTask();
      record.exceptions = [
        {
          originalRunAt: '2026-05-06T16:00:00.000Z',
          kind: 'override',
          override: { title: 'Mid-week sync (one-off)' },
        },
      ];
      await recurringTaskStore.save(AGENT_ID, record);

      await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
        now: new Date('2026-05-04T00:00:00.000Z'),
      });

      const plan = await weeklyPlanStore.load(AGENT_ID, WEEK_KEY);
      const overridden = plan.tasks.find((t) => t.title === 'Mid-week sync (one-off)');
      assert.ok(overridden, 'override title applied to materialized task');
      const original = plan.tasks.find((t) => t.title === 'Biweekly status report');
      assert.ok(original, 'non-overridden occurrence keeps the template title');

      // And the idempotence guarantee still holds with an override present.
      const bytes1 = await readFile(planPath());
      const r2 = await materializeRecurringForWeek({
        weeklyPlanStore,
        recurringTaskStore,
        agentId: AGENT_ID,
        weekKey: WEEK_KEY,
        tz: TZ,
      });
      assert.equal(r2.unchanged, true);
      const bytes2 = await readFile(planPath());
      assert.equal(bytes1.equals(bytes2), true, 'override path stays byte-identical');
    });
  });
});
