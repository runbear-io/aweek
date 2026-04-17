import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  recordTokenUsage,
  getWeeklyUsage,
  checkBudget,
  createTokenTracker,
} from './token-tracker.js';
import { UsageStore } from '../storage/usage-store.js';

describe('token-tracker', () => {
  let tmpDir;
  let usageStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'token-tracker-test-'));
    usageStore = new UsageStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('recordTokenUsage', () => {
    it('records usage and returns success with weekly totals', async () => {
      const result = await recordTokenUsage(
        'agent-1',
        { inputTokens: 100, outputTokens: 50 },
        { taskId: 'task-1', week: '2026-04-13' },
        { usageStore },
      );

      assert.equal(result.success, true);
      assert.equal(result.error, null);
      assert.ok(result.record);
      assert.equal(result.record.agentId, 'agent-1');
      assert.equal(result.record.inputTokens, 100);
      assert.equal(result.record.outputTokens, 50);
      assert.equal(result.record.totalTokens, 150);
      assert.equal(result.record.week, '2026-04-13');
      assert.ok(result.weeklyTotals);
      assert.equal(result.weeklyTotals.totalTokens, 150);
      assert.equal(result.weeklyTotals.recordCount, 1);
    });

    it('accumulates usage across multiple recordings', async () => {
      await recordTokenUsage(
        'agent-1',
        { inputTokens: 100, outputTokens: 50 },
        { taskId: 'task-1', week: '2026-04-13' },
        { usageStore },
      );
      const result = await recordTokenUsage(
        'agent-1',
        { inputTokens: 200, outputTokens: 100 },
        { taskId: 'task-2', week: '2026-04-13' },
        { usageStore },
      );

      assert.equal(result.success, true);
      assert.equal(result.weeklyTotals.totalTokens, 450); // 150 + 300
      assert.equal(result.weeklyTotals.recordCount, 2);
    });

    it('defaults taskId to "unknown" when not provided', async () => {
      const result = await recordTokenUsage(
        'agent-1',
        { inputTokens: 10, outputTokens: 5 },
        { week: '2026-04-13' },
        { usageStore },
      );

      assert.equal(result.success, true);
      assert.equal(result.record.taskId, 'unknown');
    });

    it('resolves current week key when no week provided', async () => {
      const result = await recordTokenUsage(
        'agent-1',
        { inputTokens: 10, outputTokens: 5 },
        {},
        { usageStore },
      );

      assert.equal(result.success, true);
      // The week should be a Monday date string
      assert.match(result.record.week, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns error for missing agentId', async () => {
      const result = await recordTokenUsage(null, { inputTokens: 10, outputTokens: 5 }, {}, { usageStore });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('agentId'));
    });

    it('returns error for empty string agentId', async () => {
      const result = await recordTokenUsage('', { inputTokens: 10, outputTokens: 5 }, {}, { usageStore });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('agentId'));
    });

    it('returns error for missing tokens', async () => {
      const result = await recordTokenUsage('agent-1', null, {}, { usageStore });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('tokens'));
    });

    it('returns error for non-numeric token counts', async () => {
      const result = await recordTokenUsage('agent-1', { inputTokens: 'abc', outputTokens: 5 }, {}, { usageStore });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('tokens'));
    });

    it('returns error for missing usageStore', async () => {
      const result = await recordTokenUsage('agent-1', { inputTokens: 10, outputTokens: 5 }, {}, {});
      assert.equal(result.success, false);
      assert.ok(result.error.includes('usageStore'));
    });

    it('includes optional context fields in the record', async () => {
      const result = await recordTokenUsage(
        'agent-1',
        { inputTokens: 100, outputTokens: 50, costUsd: 0.005 },
        {
          taskId: 'task-x',
          sessionId: 'sess-123',
          durationMs: 5000,
          model: 'claude-sonnet',
          week: '2026-04-13',
        },
        { usageStore },
      );

      assert.equal(result.success, true);
      assert.equal(result.record.taskId, 'task-x');
      assert.equal(result.record.sessionId, 'sess-123');
      assert.equal(result.record.durationMs, 5000);
      assert.equal(result.record.model, 'claude-sonnet');
    });

    it('tracks cost in weekly totals', async () => {
      await recordTokenUsage(
        'agent-1',
        { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
        { taskId: 'task-1', week: '2026-04-13' },
        { usageStore },
      );
      const result = await recordTokenUsage(
        'agent-1',
        { inputTokens: 200, outputTokens: 100, costUsd: 0.02 },
        { taskId: 'task-2', week: '2026-04-13' },
        { usageStore },
      );

      assert.equal(result.weeklyTotals.costUsd, 0.03);
    });

    it('keeps separate weeks independent', async () => {
      await recordTokenUsage(
        'agent-1',
        { inputTokens: 1000, outputTokens: 500 },
        { taskId: 'task-1', week: '2026-04-06' },
        { usageStore },
      );
      const result = await recordTokenUsage(
        'agent-1',
        { inputTokens: 100, outputTokens: 50 },
        { taskId: 'task-2', week: '2026-04-13' },
        { usageStore },
      );

      // Week 2 totals should only include week 2 data
      assert.equal(result.weeklyTotals.totalTokens, 150);
      assert.equal(result.weeklyTotals.recordCount, 1);
    });
  });

  describe('getWeeklyUsage', () => {
    it('returns zero totals for a fresh agent', async () => {
      const totals = await getWeeklyUsage('agent-new', { usageStore }, '2026-04-13');
      assert.equal(totals.totalTokens, 0);
      assert.equal(totals.recordCount, 0);
    });

    it('returns accumulated totals after recordings', async () => {
      await recordTokenUsage(
        'agent-1',
        { inputTokens: 100, outputTokens: 50 },
        { taskId: 'task-1', week: '2026-04-13' },
        { usageStore },
      );
      await recordTokenUsage(
        'agent-1',
        { inputTokens: 200, outputTokens: 100 },
        { taskId: 'task-2', week: '2026-04-13' },
        { usageStore },
      );

      const totals = await getWeeklyUsage('agent-1', { usageStore }, '2026-04-13');
      assert.equal(totals.totalTokens, 450);
      assert.equal(totals.inputTokens, 300);
      assert.equal(totals.outputTokens, 150);
      assert.equal(totals.recordCount, 2);
    });

    it('throws for missing agentId', async () => {
      await assert.rejects(() => getWeeklyUsage(null, { usageStore }), /agentId/);
    });

    it('throws for missing usageStore', async () => {
      await assert.rejects(() => getWeeklyUsage('agent-1', {}), /usageStore/);
    });
  });

  describe('checkBudget', () => {
    it('reports not exceeded when under budget', async () => {
      await recordTokenUsage(
        'agent-1',
        { inputTokens: 100, outputTokens: 50 },
        { taskId: 'task-1', week: '2026-04-13' },
        { usageStore },
      );

      const status = await checkBudget('agent-1', 1000, { usageStore }, '2026-04-13');
      assert.equal(status.exceeded, false);
      assert.equal(status.used, 150);
      assert.equal(status.budget, 1000);
      assert.equal(status.remaining, 850);
    });

    it('reports exceeded when at or over budget', async () => {
      await recordTokenUsage(
        'agent-1',
        { inputTokens: 500, outputTokens: 500 },
        { taskId: 'task-1', week: '2026-04-13' },
        { usageStore },
      );

      const status = await checkBudget('agent-1', 1000, { usageStore }, '2026-04-13');
      assert.equal(status.exceeded, true);
      assert.equal(status.used, 1000);
      assert.equal(status.remaining, 0);
    });

    it('reports exceeded when over budget', async () => {
      await recordTokenUsage(
        'agent-1',
        { inputTokens: 800, outputTokens: 500 },
        { taskId: 'task-1', week: '2026-04-13' },
        { usageStore },
      );

      const status = await checkBudget('agent-1', 1000, { usageStore }, '2026-04-13');
      assert.equal(status.exceeded, true);
      assert.equal(status.used, 1300);
      assert.equal(status.remaining, 0);
    });

    it('reports not exceeded for a fresh agent', async () => {
      const status = await checkBudget('agent-new', 1000, { usageStore }, '2026-04-13');
      assert.equal(status.exceeded, false);
      assert.equal(status.used, 0);
      assert.equal(status.remaining, 1000);
    });

    it('throws for invalid budgetTokens', async () => {
      await assert.rejects(() => checkBudget('agent-1', -1, { usageStore }), /budgetTokens/);
      await assert.rejects(() => checkBudget('agent-1', 0, { usageStore }), /budgetTokens/);
      await assert.rejects(() => checkBudget('agent-1', 'abc', { usageStore }), /budgetTokens/);
    });

    it('includes weekMonday in the result', async () => {
      const status = await checkBudget('agent-1', 1000, { usageStore }, '2026-04-13');
      assert.equal(status.weekMonday, '2026-04-13');
    });
  });

  describe('createTokenTracker', () => {
    it('creates a tracker with bound usageStore', () => {
      const tracker = createTokenTracker({ usageStore });
      assert.equal(typeof tracker.record, 'function');
      assert.equal(typeof tracker.getUsage, 'function');
      assert.equal(typeof tracker.checkBudget, 'function');
    });

    it('throws if usageStore is not provided', () => {
      assert.throws(() => createTokenTracker({}), /usageStore/);
    });

    it('record() works without passing deps', async () => {
      const tracker = createTokenTracker({ usageStore });

      const result = await tracker.record(
        'agent-1',
        { inputTokens: 100, outputTokens: 50 },
        { taskId: 'task-1', week: '2026-04-13' },
      );

      assert.equal(result.success, true);
      assert.equal(result.weeklyTotals.totalTokens, 150);
    });

    it('getUsage() works without passing deps', async () => {
      const tracker = createTokenTracker({ usageStore });

      await tracker.record(
        'agent-1',
        { inputTokens: 100, outputTokens: 50 },
        { taskId: 'task-1', week: '2026-04-13' },
      );

      const totals = await tracker.getUsage('agent-1', '2026-04-13');
      assert.equal(totals.totalTokens, 150);
    });

    it('checkBudget() works without passing deps', async () => {
      const tracker = createTokenTracker({ usageStore });

      await tracker.record(
        'agent-1',
        { inputTokens: 500, outputTokens: 500 },
        { taskId: 'task-1', week: '2026-04-13' },
      );

      const status = await tracker.checkBudget('agent-1', 800, '2026-04-13');
      assert.equal(status.exceeded, true);
      assert.equal(status.used, 1000);
    });
  });

  describe('accumulation logic', () => {
    it('accumulates tokens progressively across many recordings', async () => {
      const tracker = createTokenTracker({ usageStore });
      let expectedTotal = 0;

      for (let i = 0; i < 8; i++) {
        const input = 100 * (i + 1);
        const output = 50 * (i + 1);
        expectedTotal += input + output;

        const result = await tracker.record(
          'agent-1',
          { inputTokens: input, outputTokens: output },
          { taskId: `task-${i}`, week: '2026-04-13' },
        );

        assert.equal(result.success, true);
        assert.equal(result.weeklyTotals.totalTokens, expectedTotal);
        assert.equal(result.weeklyTotals.recordCount, i + 1);
      }

      // Final check via getUsage
      const totals = await tracker.getUsage('agent-1', '2026-04-13');
      assert.equal(totals.totalTokens, expectedTotal);
    });

    it('accumulates cost accurately across recordings', async () => {
      const tracker = createTokenTracker({ usageStore });

      await tracker.record(
        'agent-1',
        { inputTokens: 100, outputTokens: 50, costUsd: 0.003 },
        { taskId: 'task-1', week: '2026-04-13' },
      );
      await tracker.record(
        'agent-1',
        { inputTokens: 200, outputTokens: 100, costUsd: 0.007 },
        { taskId: 'task-2', week: '2026-04-13' },
      );
      const result = await tracker.record(
        'agent-1',
        { inputTokens: 300, outputTokens: 150, costUsd: 0.01 },
        { taskId: 'task-3', week: '2026-04-13' },
      );

      assert.equal(result.weeklyTotals.costUsd, 0.02);
      assert.equal(result.weeklyTotals.totalTokens, 900);
    });

    it('budget check reflects accumulated usage correctly', async () => {
      const tracker = createTokenTracker({ usageStore });
      const budget = 1000;

      // Record 400 tokens
      await tracker.record(
        'agent-1',
        { inputTokens: 200, outputTokens: 200 },
        { taskId: 'task-1', week: '2026-04-13' },
      );

      let status = await tracker.checkBudget('agent-1', budget, '2026-04-13');
      assert.equal(status.exceeded, false);
      assert.equal(status.remaining, 600);

      // Record 400 more (total 800)
      await tracker.record(
        'agent-1',
        { inputTokens: 200, outputTokens: 200 },
        { taskId: 'task-2', week: '2026-04-13' },
      );

      status = await tracker.checkBudget('agent-1', budget, '2026-04-13');
      assert.equal(status.exceeded, false);
      assert.equal(status.remaining, 200);

      // Record 300 more (total 1100, exceeds budget)
      await tracker.record(
        'agent-1',
        { inputTokens: 150, outputTokens: 150 },
        { taskId: 'task-3', week: '2026-04-13' },
      );

      status = await tracker.checkBudget('agent-1', budget, '2026-04-13');
      assert.equal(status.exceeded, true);
      assert.equal(status.used, 1100);
      assert.equal(status.remaining, 0);
    });
  });

  describe('weekly rollover', () => {
    it('budget resets to zero on new week', async () => {
      const tracker = createTokenTracker({ usageStore });
      const budget = 5000;

      // Exhaust budget in week 1
      await tracker.record(
        'agent-1',
        { inputTokens: 3000, outputTokens: 2000 },
        { taskId: 'task-1', week: '2026-04-06' },
      );

      const statusW1 = await tracker.checkBudget('agent-1', budget, '2026-04-06');
      assert.equal(statusW1.exceeded, true);
      assert.equal(statusW1.used, 5000);

      // New week — budget should be fresh
      const statusW2 = await tracker.checkBudget('agent-1', budget, '2026-04-13');
      assert.equal(statusW2.exceeded, false);
      assert.equal(statusW2.used, 0);
      assert.equal(statusW2.remaining, 5000);
    });

    it('recording in a new week does not affect previous week totals', async () => {
      const tracker = createTokenTracker({ usageStore });

      await tracker.record(
        'agent-1',
        { inputTokens: 1000, outputTokens: 500 },
        { taskId: 'task-w1', week: '2026-04-06' },
      );
      await tracker.record(
        'agent-1',
        { inputTokens: 200, outputTokens: 100 },
        { taskId: 'task-w2', week: '2026-04-13' },
      );

      const w1 = await tracker.getUsage('agent-1', '2026-04-06');
      const w2 = await tracker.getUsage('agent-1', '2026-04-13');

      assert.equal(w1.totalTokens, 1500); // unchanged by week 2 recording
      assert.equal(w2.totalTokens, 300);
    });

    it('budget exceeded in one week does not carry over', async () => {
      const tracker = createTokenTracker({ usageStore });
      const budget = 500;

      // Way over budget in week 1
      await tracker.record(
        'agent-1',
        { inputTokens: 5000, outputTokens: 5000 },
        { taskId: 'task-1', week: '2026-04-06' },
      );

      const w1 = await tracker.checkBudget('agent-1', budget, '2026-04-06');
      assert.equal(w1.exceeded, true);
      assert.equal(w1.used, 10000);

      // Next week is clean slate
      const w2 = await tracker.checkBudget('agent-1', budget, '2026-04-13');
      assert.equal(w2.exceeded, false);
      assert.equal(w2.used, 0);
      assert.equal(w2.remaining, 500);
    });

    it('records spanning multiple weeks accumulate independently', async () => {
      const tracker = createTokenTracker({ usageStore });
      const weeks = ['2026-03-30', '2026-04-06', '2026-04-13'];

      for (const week of weeks) {
        for (let j = 0; j < 3; j++) {
          await tracker.record(
            'agent-1',
            { inputTokens: 100, outputTokens: 50 },
            { taskId: `task-${week}-${j}`, week },
          );
        }
      }

      for (const week of weeks) {
        const totals = await tracker.getUsage('agent-1', week);
        assert.equal(totals.recordCount, 3);
        assert.equal(totals.totalTokens, 450); // 3 * 150
      }
    });
  });

  describe('concurrent agent tracking', () => {
    it('tracks multiple agents independently in the same week', async () => {
      const tracker = createTokenTracker({ usageStore });
      const agents = ['agent-alpha', 'agent-beta', 'agent-gamma'];

      // Record different amounts for each agent
      for (let i = 0; i < agents.length; i++) {
        await tracker.record(
          agents[i],
          { inputTokens: 1000 * (i + 1), outputTokens: 500 * (i + 1) },
          { taskId: `task-${i}`, week: '2026-04-13' },
        );
      }

      const t0 = await tracker.getUsage('agent-alpha', '2026-04-13');
      const t1 = await tracker.getUsage('agent-beta', '2026-04-13');
      const t2 = await tracker.getUsage('agent-gamma', '2026-04-13');

      assert.equal(t0.totalTokens, 1500);
      assert.equal(t1.totalTokens, 3000);
      assert.equal(t2.totalTokens, 4500);
    });

    it('parallel recording for multiple agents produces correct independent totals', async () => {
      const tracker = createTokenTracker({ usageStore });
      const agents = ['agent-a', 'agent-b', 'agent-c'];

      // Simulate parallel heartbeat — all agents record at the same time
      await Promise.all(
        agents.map((agentId, i) =>
          tracker.record(
            agentId,
            { inputTokens: 500 * (i + 1), outputTokens: 250 * (i + 1) },
            { taskId: 'heartbeat-task', week: '2026-04-13' },
          ),
        ),
      );

      for (let i = 0; i < agents.length; i++) {
        const totals = await tracker.getUsage(agents[i], '2026-04-13');
        assert.equal(totals.totalTokens, 750 * (i + 1));
        assert.equal(totals.recordCount, 1);
      }
    });

    it('budget check is per-agent — one exhausted does not block others', async () => {
      const tracker = createTokenTracker({ usageStore });
      const budget = 1000;

      // Agent 1 exceeds budget
      await tracker.record(
        'agent-heavy',
        { inputTokens: 800, outputTokens: 500 },
        { taskId: 'heavy-task', week: '2026-04-13' },
      );
      // Agent 2 uses a little
      await tracker.record(
        'agent-light',
        { inputTokens: 50, outputTokens: 25 },
        { taskId: 'light-task', week: '2026-04-13' },
      );

      const heavyStatus = await tracker.checkBudget('agent-heavy', budget, '2026-04-13');
      const lightStatus = await tracker.checkBudget('agent-light', budget, '2026-04-13');

      assert.equal(heavyStatus.exceeded, true);
      assert.equal(heavyStatus.used, 1300);
      assert.equal(lightStatus.exceeded, false);
      assert.equal(lightStatus.used, 75);
      assert.equal(lightStatus.remaining, 925);
    });

    it('agents can have different budget limits', async () => {
      const tracker = createTokenTracker({ usageStore });

      // Both agents use 500 tokens
      await tracker.record(
        'agent-premium',
        { inputTokens: 300, outputTokens: 200 },
        { taskId: 'task-1', week: '2026-04-13' },
      );
      await tracker.record(
        'agent-basic',
        { inputTokens: 300, outputTokens: 200 },
        { taskId: 'task-1', week: '2026-04-13' },
      );

      // Premium agent has high budget — not exceeded
      const premStatus = await tracker.checkBudget('agent-premium', 10000, '2026-04-13');
      assert.equal(premStatus.exceeded, false);
      assert.equal(premStatus.remaining, 9500);

      // Basic agent has low budget — exceeded
      const basicStatus = await tracker.checkBudget('agent-basic', 400, '2026-04-13');
      assert.equal(basicStatus.exceeded, true);
      assert.equal(basicStatus.remaining, 0);
    });

    it('each agent accumulates across sessions independently', async () => {
      const tracker = createTokenTracker({ usageStore });
      const agents = ['agent-x', 'agent-y'];

      // 3 sessions each, interleaved
      for (let session = 0; session < 3; session++) {
        for (const agentId of agents) {
          await tracker.record(
            agentId,
            { inputTokens: 100, outputTokens: 50 },
            { taskId: `task-${session}`, week: '2026-04-13' },
          );
        }
      }

      for (const agentId of agents) {
        const totals = await tracker.getUsage(agentId, '2026-04-13');
        assert.equal(totals.recordCount, 3);
        assert.equal(totals.totalTokens, 450); // 3 * 150
      }
    });

    it('weekly rollover applies independently to each agent', async () => {
      const tracker = createTokenTracker({ usageStore });

      // Agent 1 records in week 1
      await tracker.record(
        'agent-1',
        { inputTokens: 5000, outputTokens: 3000 },
        { taskId: 'w1-task', week: '2026-04-06' },
      );
      // Agent 2 records in week 2
      await tracker.record(
        'agent-2',
        { inputTokens: 200, outputTokens: 100 },
        { taskId: 'w2-task', week: '2026-04-13' },
      );

      // Agent 1 in week 2 should be zero
      const a1w2 = await tracker.getUsage('agent-1', '2026-04-13');
      assert.equal(a1w2.totalTokens, 0);

      // Agent 2 in week 1 should be zero
      const a2w1 = await tracker.getUsage('agent-2', '2026-04-06');
      assert.equal(a2w1.totalTokens, 0);

      // Each agent retains its own week's data
      const a1w1 = await tracker.getUsage('agent-1', '2026-04-06');
      assert.equal(a1w1.totalTokens, 8000);
      const a2w2 = await tracker.getUsage('agent-2', '2026-04-13');
      assert.equal(a2w2.totalTokens, 300);
    });
  });
});
