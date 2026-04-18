/**
 * Integration tests for weekly token budget enforcement.
 *
 * These tests exercise the full budget lifecycle:
 *   record usage (token-tracker) → check budget (budget-enforcer) → pause agent → write alert flag
 *
 * Covers:
 * - Progressive budget tracking across sessions until exhaustion
 * - Pause-on-exhaustion behavior (agent config updated, further work blocked)
 * - Alert flag file written once on first exhaustion (idempotent)
 * - Weekly reset: new week clears budget, un-paused agent can work again
 * - Multi-agent isolation: one agent's exhaustion doesn't affect others
 * - Resume flow: manual resume clears pause, but re-enforcement re-pauses if still over
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { recordTokenUsage, createTokenTracker } from './token-tracker.js';
import {
  enforceBudget,
  enforceAllBudgets,
  isAgentPaused,
  resumeAgent,
  loadAlert,
  alertFilePath,
  createBudgetEnforcer,
} from './budget-enforcer.js';
import { AgentStore } from '../storage/agent-store.js';
import { UsageStore, createUsageRecord } from '../storage/usage-store.js';
import { createAgentConfig } from '../models/agent.js';

describe('weekly-budget-enforcement (integration)', () => {
  let tmpDir;
  let agentStore;
  let usageStore;
  let deps;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'weekly-budget-enforcement-test-'));
    agentStore = new AgentStore(tmpDir);
    usageStore = new UsageStore(tmpDir);
    deps = { agentStore, usageStore, baseDir: tmpDir };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create and save a test agent */
  async function createTestAgent(name, weeklyTokenLimit = 1000) {
    const config = createAgentConfig({ subagentRef: name, weeklyTokenLimit });
    await agentStore.save(config);
    return config;
  }

  /** Helper: record tokens via the tracker and return the result */
  async function recordTokens(agentId, input, output, week = '2026-04-13', taskId = 'task-1') {
    return recordTokenUsage(
      agentId,
      { inputTokens: input, outputTokens: output },
      { taskId, week },
      { usageStore },
    );
  }

  describe('progressive budget tracking to exhaustion', () => {
    it('tracks usage across multiple sessions and triggers pause at threshold', async () => {
      const agent = await createTestAgent('worker', 1000);
      const week = '2026-04-13';

      // Session 1: 300 tokens — under budget
      await recordTokens(agent.id, 200, 100, week, 'session-1');
      let result = await enforceBudget(agent.id, deps, week);
      assert.equal(result.exceeded, false);
      assert.equal(result.paused, false);
      assert.equal(result.used, 300);
      assert.equal(result.remaining, 700);

      // Session 2: +400 tokens (total 700) — still under budget
      await recordTokens(agent.id, 250, 150, week, 'session-2');
      result = await enforceBudget(agent.id, deps, week);
      assert.equal(result.exceeded, false);
      assert.equal(result.paused, false);
      assert.equal(result.used, 700);
      assert.equal(result.remaining, 300);

      // Session 3: +400 tokens (total 1100) — exceeds budget
      await recordTokens(agent.id, 250, 150, week, 'session-3');
      result = await enforceBudget(agent.id, deps, week);
      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.used, 1100);
      assert.equal(result.remaining, 0);
      assert.equal(result.alertWritten, true);
      assert.ok(result.alertPath);
    });

    it('exact budget match triggers pause', async () => {
      const agent = await createTestAgent('exact-worker', 500);
      const week = '2026-04-13';

      await recordTokens(agent.id, 250, 250, week, 'session-1');
      const result = await enforceBudget(agent.id, deps, week);

      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.used, 500);
      assert.equal(result.budget, 500);
      assert.equal(result.remaining, 0);
      assert.equal(result.alertWritten, true);
    });
  });

  describe('pause-on-exhaustion behavior', () => {
    it('persists paused state in agent config', async () => {
      const agent = await createTestAgent('pausable', 500);
      await recordTokens(agent.id, 300, 300, '2026-04-13');

      await enforceBudget(agent.id, deps, '2026-04-13');

      // Verify paused state via isAgentPaused
      assert.equal(await isAgentPaused(agent.id, deps), true);

      // Verify paused state by loading agent config directly
      const config = await agentStore.load(agent.id);
      assert.equal(config.budget.paused, true);
      assert.equal(config.budget.currentUsage, 600);
    });

    it('paused agent stays paused on repeated enforcement checks', async () => {
      const agent = await createTestAgent('stuck', 200);
      await recordTokens(agent.id, 150, 150, '2026-04-13');

      // First enforcement pauses
      await enforceBudget(agent.id, deps, '2026-04-13');
      assert.equal(await isAgentPaused(agent.id, deps), true);

      // Multiple subsequent enforcements keep it paused
      for (let i = 0; i < 3; i++) {
        const result = await enforceBudget(agent.id, deps, '2026-04-13');
        assert.equal(result.paused, true);
        assert.equal(result.exceeded, true);
      }

      assert.equal(await isAgentPaused(agent.id, deps), true);
    });

    it('resumed agent gets re-paused if still over budget', async () => {
      const agent = await createTestAgent('yo-yo', 500);
      await recordTokens(agent.id, 400, 200, '2026-04-13');

      // Exhaust and pause
      await enforceBudget(agent.id, deps, '2026-04-13');
      assert.equal(await isAgentPaused(agent.id, deps), true);

      // Resume manually
      await resumeAgent(agent.id, deps);
      assert.equal(await isAgentPaused(agent.id, deps), false);

      // Re-enforce — still over budget, gets paused again
      const result = await enforceBudget(agent.id, deps, '2026-04-13');
      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(await isAgentPaused(agent.id, deps), true);
    });
  });

  describe('alert flag writing', () => {
    it('writes structured alert JSON on first exhaustion', async () => {
      const agent = await createTestAgent('alertable', 300);
      await recordTokens(agent.id, 200, 200, '2026-04-13');

      const result = await enforceBudget(agent.id, deps, '2026-04-13', '2026-04-15T12:00:00Z');

      assert.equal(result.alertWritten, true);
      assert.ok(result.alertPath);

      // Read and validate alert file contents
      const alertRaw = await readFile(result.alertPath, 'utf-8');
      const alert = JSON.parse(alertRaw);

      assert.equal(alert.type, 'budget-exhausted');
      assert.equal(alert.agentId, agent.id);
      assert.equal(alert.weekMonday, '2026-04-13');
      assert.equal(alert.used, 400);
      assert.equal(alert.budget, 300);
      assert.equal(alert.exceededBy, 100);
      assert.equal(alert.timestamp, '2026-04-15T12:00:00Z');
      assert.ok(alert.message.includes('exhausted'));
      assert.ok(alert.message.includes(agent.id));
    });

    it('does not write duplicate alert on repeated enforcement', async () => {
      const agent = await createTestAgent('no-dup', 100);
      await recordTokens(agent.id, 80, 80, '2026-04-13');

      const first = await enforceBudget(agent.id, deps, '2026-04-13', '2026-04-15T10:00:00Z');
      assert.equal(first.alertWritten, true);

      const second = await enforceBudget(agent.id, deps, '2026-04-13', '2026-04-15T11:00:00Z');
      assert.equal(second.alertWritten, false);
      assert.equal(second.exceeded, true);
      assert.equal(second.paused, true);

      // Original alert timestamp preserved
      const alert = await loadAlert(tmpDir, agent.id, '2026-04-13');
      assert.equal(alert.timestamp, '2026-04-15T10:00:00Z');
    });

    it('alert file path follows expected convention', async () => {
      const agent = await createTestAgent('path-check', 50);
      await recordTokens(agent.id, 30, 30, '2026-04-13');

      const result = await enforceBudget(agent.id, deps, '2026-04-13');
      const expected = alertFilePath(tmpDir, agent.id, '2026-04-13');
      assert.equal(result.alertPath, expected);
      assert.ok(result.alertPath.endsWith('budget-exhausted-2026-04-13.json'));
    });

    it('each week gets its own independent alert file', async () => {
      const agent = await createTestAgent('multi-week', 100);

      // Exhaust in week 1
      await recordTokens(agent.id, 80, 80, '2026-04-06');
      const w1 = await enforceBudget(agent.id, deps, '2026-04-06', '2026-04-08T10:00:00Z');
      assert.equal(w1.alertWritten, true);

      // Resume for week 2
      await resumeAgent(agent.id, deps);

      // Exhaust in week 2
      await recordTokens(agent.id, 80, 80, '2026-04-13');
      const w2 = await enforceBudget(agent.id, deps, '2026-04-13', '2026-04-15T10:00:00Z');
      assert.equal(w2.alertWritten, true);

      // Both alerts exist independently
      const alert1 = await loadAlert(tmpDir, agent.id, '2026-04-06');
      const alert2 = await loadAlert(tmpDir, agent.id, '2026-04-13');
      assert.ok(alert1);
      assert.ok(alert2);
      assert.equal(alert1.weekMonday, '2026-04-06');
      assert.equal(alert2.weekMonday, '2026-04-13');
    });

    it('loadAlert returns null for non-exhausted weeks', async () => {
      const agent = await createTestAgent('under-budget', 10000);
      await recordTokens(agent.id, 50, 50, '2026-04-13');
      await enforceBudget(agent.id, deps, '2026-04-13');

      const alert = await loadAlert(tmpDir, agent.id, '2026-04-13');
      assert.equal(alert, null);
    });
  });

  describe('weekly reset and rollover', () => {
    it('new week has fresh budget regardless of previous week exhaustion', async () => {
      const agent = await createTestAgent('rolly', 500);

      // Exhaust week 1
      await recordTokens(agent.id, 300, 300, '2026-04-06');
      await enforceBudget(agent.id, deps, '2026-04-06');
      assert.equal(await isAgentPaused(agent.id, deps), true);

      // Resume for new week
      await resumeAgent(agent.id, deps);

      // Week 2: no usage yet, budget is fresh
      const w2 = await enforceBudget(agent.id, deps, '2026-04-13');
      assert.equal(w2.exceeded, false);
      assert.equal(w2.used, 0);
      assert.equal(w2.remaining, 500);
      assert.equal(w2.paused, false);
      assert.equal(w2.alertWritten, false);
    });

    it('usage in new week accumulates independently from old week', async () => {
      const agent = await createTestAgent('fresh-start', 1000);
      const tracker = createTokenTracker({ usageStore });

      // Record 800 in week 1
      await tracker.record(agent.id, { inputTokens: 500, outputTokens: 300 }, { taskId: 'w1', week: '2026-04-06' });

      // Record 200 in week 2
      await tracker.record(agent.id, { inputTokens: 100, outputTokens: 100 }, { taskId: 'w2', week: '2026-04-13' });

      // Week 1: 800 tokens, under 1000 budget
      const w1 = await enforceBudget(agent.id, deps, '2026-04-06');
      assert.equal(w1.used, 800);
      assert.equal(w1.exceeded, false);

      // Week 2: only 200 tokens, under 1000 budget
      const w2 = await enforceBudget(agent.id, deps, '2026-04-13');
      assert.equal(w2.used, 200);
      assert.equal(w2.exceeded, false);
    });
  });

  describe('multi-agent isolation', () => {
    it('exhaustion of one agent does not pause others', async () => {
      const heavy = await createTestAgent('heavy-user', 500);
      const light = await createTestAgent('light-user', 500);
      const week = '2026-04-13';

      // Heavy agent exceeds budget
      await recordTokens(heavy.id, 400, 200, week, 'heavy-task');
      // Light agent stays under
      await recordTokens(light.id, 50, 25, week, 'light-task');

      const results = await enforceAllBudgets(deps, week);

      const heavyResult = results.find((r) => r.agentId === heavy.id);
      const lightResult = results.find((r) => r.agentId === light.id);

      assert.equal(heavyResult.exceeded, true);
      assert.equal(heavyResult.paused, true);
      assert.equal(heavyResult.alertWritten, true);

      assert.equal(lightResult.exceeded, false);
      assert.equal(lightResult.paused, false);
      assert.equal(lightResult.alertWritten, false);

      // Verify via individual pause checks
      assert.equal(await isAgentPaused(heavy.id, deps), true);
      assert.equal(await isAgentPaused(light.id, deps), false);
    });

    it('each agent has independent alert files', async () => {
      const a1 = await createTestAgent('agent-alpha', 100);
      const a2 = await createTestAgent('agent-beta', 100);
      const week = '2026-04-13';

      // Both exceed
      await recordTokens(a1.id, 80, 80, week, 'task-a1');
      await recordTokens(a2.id, 90, 90, week, 'task-a2');

      await enforceAllBudgets(deps, week);

      const alert1 = await loadAlert(tmpDir, a1.id, week);
      const alert2 = await loadAlert(tmpDir, a2.id, week);

      assert.ok(alert1);
      assert.ok(alert2);
      assert.equal(alert1.agentId, a1.id);
      assert.equal(alert2.agentId, a2.id);
      assert.equal(alert1.used, 160);
      assert.equal(alert2.used, 180);
    });

    it('agents with different budgets enforce independently', async () => {
      const premium = await createTestAgent('premium', 10000);
      const basic = await createTestAgent('basic', 200);
      const week = '2026-04-13';

      // Both record same usage (500 tokens)
      await recordTokens(premium.id, 300, 200, week, 'task-p');
      await recordTokens(basic.id, 300, 200, week, 'task-b');

      const results = await enforceAllBudgets(deps, week);
      const pResult = results.find((r) => r.agentId === premium.id);
      const bResult = results.find((r) => r.agentId === basic.id);

      assert.equal(pResult.exceeded, false);
      assert.equal(pResult.remaining, 9500);

      assert.equal(bResult.exceeded, true);
      assert.equal(bResult.paused, true);
      assert.equal(bResult.remaining, 0);
    });
  });

  describe('bound enforcer end-to-end', () => {
    it('full lifecycle through createBudgetEnforcer factory', async () => {
      const agent = await createTestAgent('lifecycle', 800);
      const tracker = createTokenTracker({ usageStore });
      const enforcer = createBudgetEnforcer({ agentStore, usageStore, baseDir: tmpDir });
      const week = '2026-04-13';

      // Step 1: Record usage via tracker
      await tracker.record(agent.id, { inputTokens: 200, outputTokens: 100 }, { taskId: 's1', week });
      let result = await enforcer.enforce(agent.id, week);
      assert.equal(result.exceeded, false);
      assert.equal(result.used, 300);
      assert.equal(await enforcer.isPaused(agent.id), false);

      // Step 2: Record more usage, pushing over budget
      await tracker.record(agent.id, { inputTokens: 400, outputTokens: 200 }, { taskId: 's2', week });
      result = await enforcer.enforce(agent.id, week);
      assert.equal(result.exceeded, true);
      assert.equal(result.used, 900);
      assert.equal(result.paused, true);
      assert.equal(result.alertWritten, true);
      assert.equal(await enforcer.isPaused(agent.id), true);

      // Step 3: Verify alert file
      const alert = await enforcer.loadAlert(agent.id, week);
      assert.ok(alert);
      assert.equal(alert.type, 'budget-exhausted');
      assert.equal(alert.used, 900);
      assert.equal(alert.budget, 800);

      // Step 4: Resume and verify
      await enforcer.resume(agent.id);
      assert.equal(await enforcer.isPaused(agent.id), false);

      // Step 5: Re-enforce — still over budget, re-pauses without duplicate alert
      result = await enforcer.enforce(agent.id, week);
      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.alertWritten, false); // no duplicate
    });
  });

  describe('idempotency under repeated heartbeats', () => {
    it('repeated enforcement calls produce identical results', async () => {
      const agent = await createTestAgent('heartbeat-agent', 500);
      await recordTokens(agent.id, 300, 300, '2026-04-13');
      const week = '2026-04-13';
      const ts = '2026-04-15T10:00:00Z';

      // Simulate 5 heartbeat cycles all checking the same state
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(await enforceBudget(agent.id, deps, week, ts));
      }

      // All should report exceeded
      assert.ok(results.every((r) => r.exceeded === true));
      assert.ok(results.every((r) => r.paused === true));
      assert.ok(results.every((r) => r.used === 600));

      // Only first should have written alert
      assert.equal(results[0].alertWritten, true);
      assert.ok(results.slice(1).every((r) => r.alertWritten === false));

      // Only one alert file should exist
      const alert = await loadAlert(tmpDir, agent.id, week);
      assert.equal(alert.timestamp, ts);
    });

    it('under-budget enforcement is safe to repeat without side effects', async () => {
      const agent = await createTestAgent('safe-agent', 10000);
      await recordTokens(agent.id, 50, 50, '2026-04-13');

      for (let i = 0; i < 5; i++) {
        const result = await enforceBudget(agent.id, deps, '2026-04-13');
        assert.equal(result.exceeded, false);
        assert.equal(result.paused, false);
        assert.equal(result.alertWritten, false);
        assert.equal(result.alertPath, null);
      }

      // No alert file should exist
      const alert = await loadAlert(tmpDir, agent.id, '2026-04-13');
      assert.equal(alert, null);
    });
  });

  describe('edge cases', () => {
    it('enforcement with zero usage and positive budget', async () => {
      const agent = await createTestAgent('idle', 5000);
      const result = await enforceBudget(agent.id, deps, '2026-04-13');

      assert.equal(result.exceeded, false);
      assert.equal(result.used, 0);
      assert.equal(result.remaining, 5000);
      assert.equal(result.paused, false);
    });

    it('very small budget gets enforced on first token usage', async () => {
      const agent = await createTestAgent('tiny', 1);
      await recordTokens(agent.id, 1, 0, '2026-04-13');

      const result = await enforceBudget(agent.id, deps, '2026-04-13');
      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.used, 1);
      assert.equal(result.budget, 1);
    });

    it('large usage far exceeding budget is handled correctly', async () => {
      const agent = await createTestAgent('overachiever', 1000);
      await recordTokens(agent.id, 50000, 50000, '2026-04-13');

      const result = await enforceBudget(agent.id, deps, '2026-04-13');
      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.used, 100000);
      assert.equal(result.remaining, 0);

      const alert = await loadAlert(tmpDir, agent.id, '2026-04-13');
      assert.equal(alert.exceededBy, 99000);
    });

    it('many sessions accumulate correctly towards budget', async () => {
      const agent = await createTestAgent('many-sessions', 1000);
      const week = '2026-04-13';

      // 20 small sessions of 50 tokens each = 1000 total (exact match)
      for (let i = 0; i < 20; i++) {
        await recordTokens(agent.id, 30, 20, week, `session-${i}`);
      }

      const result = await enforceBudget(agent.id, deps, week);
      assert.equal(result.used, 1000);
      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
    });
  });
});
