import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  enforceBudget,
  enforceAllBudgets,
  isAgentPaused,
  resumeAgent,
  topUpResume,
  loadAlert,
  alertFilePath,
  alertsDir,
  createBudgetEnforcer,
  type BudgetEnforcerDeps,
} from './budget-enforcer.js';
import { AgentStore } from '../storage/agent-store.js';
import { UsageStore, createUsageRecord } from '../storage/usage-store.js';
import { NotificationStore } from '../storage/notification-store.js';
import { createAgentConfig } from '../models/agent.js';

interface TestAgentConfig {
  id: string;
  subagentRef: string;
  weeklyTokenBudget: number;
  budget: {
    weeklyTokenLimit: number;
    paused: boolean;
    currentUsage: number;
    periodStart: string;
    sessions: unknown[];
  };
  [key: string]: unknown;
}

describe('budget-enforcer', () => {
  let tmpDir: string;
  let agentStore: AgentStore;
  let usageStore: UsageStore;
  let deps: BudgetEnforcerDeps;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'budget-enforcer-test-'));
    agentStore = new AgentStore(tmpDir);
    usageStore = new UsageStore(tmpDir);
    deps = { agentStore, usageStore, baseDir: tmpDir };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create and save a test agent */
  async function createTestAgent(name = 'tester', weeklyTokenLimit = 1000): Promise<TestAgentConfig> {
    // createAgentConfig's JSDoc only surfaces `weeklyTokenLimit` to TS but its
    // body destructures `subagentRef` too. Cast through unknown to pass both.
    const config = createAgentConfig({ subagentRef: name, weeklyTokenLimit }) as TestAgentConfig;
    await agentStore.save(config);
    return config;
  }

  /** Helper: add usage records for an agent */
  async function addUsage(
    agentId: string,
    inputTokens: number,
    outputTokens: number,
    week = '2026-04-13',
  ): Promise<unknown> {
    const record = createUsageRecord({
      agentId,
      taskId: 'task-1',
      inputTokens,
      outputTokens,
      week,
    });
    await usageStore.append(agentId, record);
    return record;
  }

  describe('alertsDir', () => {
    it('returns correct alerts directory path', () => {
      const dir = alertsDir('/data/agents', 'agent-foo-1234');
      assert.equal(dir, '/data/agents/agent-foo-1234/alerts');
    });
  });

  describe('alertFilePath', () => {
    it('returns correct alert file path', () => {
      const p = alertFilePath('/data/agents', 'agent-foo-1234', '2026-04-13');
      assert.equal(p, '/data/agents/agent-foo-1234/alerts/budget-exhausted-2026-04-13.json');
    });
  });

  describe('enforceBudget', () => {
    it('throws if agentId is missing', async () => {
      await assert.rejects(() => enforceBudget('', deps), /agentId is required/);
    });

    it('throws if agentStore is missing', async () => {
      await assert.rejects(() => enforceBudget('agent-x', {} as unknown as BudgetEnforcerDeps), /agentStore dependency is required/);
    });

    it('throws if usageStore is missing', async () => {
      await assert.rejects(() => enforceBudget('agent-x', { agentStore } as unknown as BudgetEnforcerDeps), /usageStore dependency is required/);
    });

    it('returns not-exceeded when usage is under budget', async () => {
      const agent = await createTestAgent('under', 10000);
      await addUsage(agent.id, 100, 50, '2026-04-13');

      const result = await enforceBudget(agent.id, deps, '2026-04-13');

      assert.equal(result.agentId, agent.id);
      assert.equal(result.exceeded, false);
      assert.equal(result.paused, false);
      assert.equal(result.used, 150);
      assert.equal(result.budget, 10000);
      assert.equal(result.remaining, 9850);
      assert.equal(result.alertWritten, false);
      assert.equal(result.alertPath, null);
    });

    it('returns not-exceeded when no usage exists', async () => {
      const agent = await createTestAgent('clean', 5000);

      const result = await enforceBudget(agent.id, deps, '2026-04-13');

      assert.equal(result.exceeded, false);
      assert.equal(result.used, 0);
      assert.equal(result.remaining, 5000);
      assert.equal(result.paused, false);
    });

    it('pauses agent and writes alert when budget exceeded', async () => {
      const agent = await createTestAgent('over', 500);
      await addUsage(agent.id, 300, 250, '2026-04-13'); // 550 > 500

      const result = await enforceBudget(agent.id, deps, '2026-04-13', '2026-04-15T10:00:00Z');

      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.used, 550);
      assert.equal(result.budget, 500);
      assert.equal(result.remaining, 0);
      assert.equal(result.alertWritten, true);
      assert.ok(result.alertPath);

      // Verify agent config was updated
      const updated = (await agentStore.load(agent.id)) as TestAgentConfig;
      assert.equal(updated.budget.paused, true);
      assert.equal(updated.budget.currentUsage, 550);

      // Verify alert file was written
      const alertRaw = await readFile(result.alertPath, 'utf-8');
      const alert = JSON.parse(alertRaw);
      assert.equal(alert.type, 'budget-exhausted');
      assert.equal(alert.agentId, agent.id);
      assert.equal(alert.weekMonday, '2026-04-13');
      assert.equal(alert.used, 550);
      assert.equal(alert.budget, 500);
      assert.equal(alert.exceededBy, 50);
      assert.equal(alert.timestamp, '2026-04-15T10:00:00Z');
      assert.ok(alert.message.includes('exhausted'));
    });

    it('pauses when usage exactly equals budget', async () => {
      const agent = await createTestAgent('exact', 200);
      await addUsage(agent.id, 100, 100, '2026-04-13'); // 200 == 200

      const result = await enforceBudget(agent.id, deps, '2026-04-13');

      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.alertWritten, true);
    });

    it('is idempotent — second call does not duplicate alert or re-pause', async () => {
      const agent = await createTestAgent('idem', 100);
      await addUsage(agent.id, 80, 80, '2026-04-13'); // 160 > 100

      const first = await enforceBudget(agent.id, deps, '2026-04-13', '2026-04-15T10:00:00Z');
      assert.equal(first.exceeded, true);
      assert.equal(first.paused, true);
      assert.equal(first.alertWritten, true);

      // Second call — already paused, alert already exists
      const second = await enforceBudget(agent.id, deps, '2026-04-13', '2026-04-15T11:00:00Z');
      assert.equal(second.exceeded, true);
      assert.equal(second.paused, true);
      assert.equal(second.alertWritten, false); // No duplicate alert

      // Alert file still has original timestamp
      const alert = await loadAlert(tmpDir, agent.id, '2026-04-13');
      assert.ok(alert);
      assert.equal(alert.timestamp, '2026-04-15T10:00:00Z');
    });

    it('does not affect a different week', async () => {
      const agent = await createTestAgent('weekly', 500);
      await addUsage(agent.id, 300, 300, '2026-04-13'); // 600 > 500 for week 1

      const week1 = await enforceBudget(agent.id, deps, '2026-04-13');
      assert.equal(week1.exceeded, true);

      // Different week — no usage yet
      const week2 = await enforceBudget(agent.id, deps, '2026-04-20');
      // Note: agent is still paused from week 1, but week 2 usage is 0
      assert.equal(week2.used, 0);
      assert.equal(week2.exceeded, false);
      assert.equal(week2.alertWritten, false);
    });

    it('handles zero budget gracefully', async () => {
      const config = createAgentConfig({ subagentRef: 'zero', weeklyTokenLimit: 0 }) as TestAgentConfig;
      // Override budget to 0
      config.weeklyTokenBudget = 0;
      config.budget.weeklyTokenLimit = 0;
      await agentStore.save(config);

      const result = await enforceBudget(config.id, deps, '2026-04-13');
      assert.equal(result.exceeded, false);
      assert.equal(result.budget, 0);
      assert.equal(result.paused, false);
    });
  });

  describe('enforceAllBudgets', () => {
    it('throws if agentStore missing', async () => {
      await assert.rejects(() => enforceAllBudgets({} as unknown as BudgetEnforcerDeps), /agentStore dependency is required/);
    });

    it('enforces budgets for all agents', async () => {
      const a1 = await createTestAgent('ok-agent', 10000);
      const a2 = await createTestAgent('over-agent', 100);
      await addUsage(a1.id, 50, 50, '2026-04-13'); // 100 < 10000
      await addUsage(a2.id, 80, 80, '2026-04-13'); // 160 > 100

      const results = await enforceAllBudgets(deps, '2026-04-13');

      assert.equal(results.length, 2);
      const ok = results.find((r) => r.agentId === a1.id);
      const over = results.find((r) => r.agentId === a2.id);

      assert.ok(ok);
      assert.ok(over);
      assert.equal(ok.exceeded, false);
      assert.equal(ok.paused, false);

      assert.equal(over.exceeded, true);
      assert.equal(over.paused, true);
      assert.equal(over.alertWritten, true);
    });

    it('returns empty array when no agents exist', async () => {
      const results = await enforceAllBudgets(deps, '2026-04-13');
      assert.deepEqual(results, []);
    });
  });

  describe('isAgentPaused', () => {
    it('returns false for un-paused agent', async () => {
      const agent = await createTestAgent('active', 5000);
      const paused = await isAgentPaused(agent.id, deps);
      assert.equal(paused, false);
    });

    it('returns true after budget enforcement pauses agent', async () => {
      const agent = await createTestAgent('will-pause', 100);
      await addUsage(agent.id, 80, 80, '2026-04-13');
      await enforceBudget(agent.id, deps, '2026-04-13');

      const paused = await isAgentPaused(agent.id, deps);
      assert.equal(paused, true);
    });

    it('throws if agentStore missing', async () => {
      await assert.rejects(() => isAgentPaused('x', {} as unknown as { agentStore: AgentStore }), /agentStore dependency is required/);
    });
  });

  describe('resumeAgent', () => {
    it('clears paused flag on a paused agent', async () => {
      const agent = await createTestAgent('paused', 100);
      await addUsage(agent.id, 80, 80, '2026-04-13');
      await enforceBudget(agent.id, deps, '2026-04-13');

      assert.equal(await isAgentPaused(agent.id, deps), true);

      await resumeAgent(agent.id, deps);

      assert.equal(await isAgentPaused(agent.id, deps), false);
    });

    it('is no-op on already un-paused agent', async () => {
      const agent = await createTestAgent('running', 5000);
      await resumeAgent(agent.id, deps);
      assert.equal(await isAgentPaused(agent.id, deps), false);
    });

    it('throws if agentStore missing', async () => {
      await assert.rejects(() => resumeAgent('x', {} as unknown as { agentStore: AgentStore }), /agentStore dependency is required/);
    });
  });

  describe('topUpResume', () => {
    it('throws if agentId is missing', async () => {
      await assert.rejects(() => topUpResume('', deps), /agentId is required/);
    });

    it('throws if agentStore is missing', async () => {
      await assert.rejects(() => topUpResume('agent-x', {} as unknown as { agentStore: AgentStore }), /agentStore dependency is required/);
    });

    it('throws if newLimit is not a positive number', async () => {
      const agent = await createTestAgent('bad-limit', 1000);
      await assert.rejects(() => topUpResume(agent.id, deps, { newLimit: -100 }), /newLimit must be a positive number/);
      await assert.rejects(() => topUpResume(agent.id, deps, { newLimit: 0 }), /newLimit must be a positive number/);
      await assert.rejects(() => topUpResume(agent.id, deps, { newLimit: 'abc' as unknown as number }), /newLimit must be a positive number/);
    });

    it('resumes a paused agent and resets usage to zero', async () => {
      const agent = await createTestAgent('paused-topup', 500);
      await addUsage(agent.id, 300, 250, '2026-04-13'); // 550 > 500
      await enforceBudget(agent.id, deps, '2026-04-13');

      // Verify agent is paused
      assert.equal(await isAgentPaused(agent.id, deps), true);

      const result = await topUpResume(agent.id, deps, { timestamp: '2026-04-15T12:00:00Z' });

      assert.equal(result.agentId, agent.id);
      assert.equal(result.wasPaused, true);
      assert.equal(result.resumed, true);
      assert.equal(result.previousUsage, 550);
      assert.equal(result.previousLimit, 500);
      assert.equal(result.newLimit, 500); // unchanged
      assert.equal(result.timestamp, '2026-04-15T12:00:00Z');

      // Agent should now be active
      assert.equal(await isAgentPaused(agent.id, deps), false);

      // Budget currentUsage should be reset
      const updated = (await agentStore.load(agent.id)) as TestAgentConfig;
      assert.equal(updated.budget.currentUsage, 0);
      assert.equal(updated.budget.paused, false);
    });

    it('allows setting a new higher budget limit', async () => {
      const agent = await createTestAgent('upgrade', 500);
      await addUsage(agent.id, 300, 250, '2026-04-13');
      await enforceBudget(agent.id, deps, '2026-04-13');

      const result = await topUpResume(agent.id, deps, { newLimit: 2000 });

      assert.equal(result.previousLimit, 500);
      assert.equal(result.newLimit, 2000);

      const updated = (await agentStore.load(agent.id)) as TestAgentConfig;
      assert.equal(updated.budget.weeklyTokenLimit, 2000);
      assert.equal(updated.weeklyTokenBudget, 2000);
      assert.equal(updated.budget.paused, false);
      assert.equal(updated.budget.currentUsage, 0);
    });

    it('is safe to call on an already-active agent (idempotent)', async () => {
      const agent = await createTestAgent('active-topup', 5000);

      const result = await topUpResume(agent.id, deps);

      assert.equal(result.wasPaused, false);
      assert.equal(result.resumed, false);
      assert.equal(result.previousUsage, 0);

      // Agent remains active
      assert.equal(await isAgentPaused(agent.id, deps), false);
      const updated = (await agentStore.load(agent.id)) as TestAgentConfig;
      assert.equal(updated.budget.currentUsage, 0);
    });

    it('preserves budget limit when newLimit is not provided', async () => {
      const agent = await createTestAgent('keep-limit', 7500);

      await topUpResume(agent.id, deps);

      const updated = (await agentStore.load(agent.id)) as TestAgentConfig;
      assert.equal(updated.weeklyTokenBudget, 7500);
      assert.equal(updated.budget.weeklyTokenLimit, 7500);
    });

    it('works through createBudgetEnforcer bound instance', async () => {
      const agent = await createTestAgent('bound-topup', 300);
      await addUsage(agent.id, 200, 200, '2026-04-13'); // 400 > 300
      const enforcer = createBudgetEnforcer({ agentStore, usageStore, baseDir: tmpDir });

      await enforcer.enforce(agent.id, '2026-04-13');
      assert.equal(await enforcer.isPaused(agent.id), true);

      const result = await enforcer.topUp(agent.id, { newLimit: 1000 });
      assert.equal(result.wasPaused, true);
      assert.equal(result.resumed, true);
      assert.equal(result.newLimit, 1000);
      assert.equal(await enforcer.isPaused(agent.id), false);
    });
  });

  describe('loadAlert', () => {
    it('returns null when no alert exists', async () => {
      const alert = await loadAlert(tmpDir, 'agent-none', '2026-04-13');
      assert.equal(alert, null);
    });

    it('returns alert data after enforcement writes one', async () => {
      const agent = await createTestAgent('alerter', 100);
      await addUsage(agent.id, 80, 80, '2026-04-13');
      await enforceBudget(agent.id, deps, '2026-04-13', '2026-04-15T10:00:00Z');

      const alert = await loadAlert(tmpDir, agent.id, '2026-04-13');
      assert.ok(alert);
      assert.equal(alert.type, 'budget-exhausted');
      assert.equal(alert.agentId, agent.id);
      assert.equal(alert.weekMonday, '2026-04-13');
    });
  });

  describe('createBudgetEnforcer', () => {
    it('throws if agentStore missing', () => {
      assert.throws(() => createBudgetEnforcer({ usageStore }), /agentStore is required/);
    });

    it('throws if usageStore missing', () => {
      assert.throws(() => createBudgetEnforcer({ agentStore }), /usageStore is required/);
    });

    it('creates a bound enforcer with all methods', () => {
      const enforcer = createBudgetEnforcer({ agentStore, usageStore, baseDir: tmpDir });
      assert.equal(typeof enforcer.enforce, 'function');
      assert.equal(typeof enforcer.enforceAll, 'function');
      assert.equal(typeof enforcer.isPaused, 'function');
      assert.equal(typeof enforcer.resume, 'function');
      assert.equal(typeof enforcer.loadAlert, 'function');
    });

    it('enforce works through bound instance', async () => {
      const agent = await createTestAgent('bound', 200);
      await addUsage(agent.id, 150, 100, '2026-04-13'); // 250 > 200

      const enforcer = createBudgetEnforcer({ agentStore, usageStore, baseDir: tmpDir });
      const result = await enforcer.enforce(agent.id, '2026-04-13');

      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.alertWritten, true);

      // isPaused via bound instance
      assert.equal(await enforcer.isPaused(agent.id), true);

      // resume via bound instance
      await enforcer.resume(agent.id);
      assert.equal(await enforcer.isPaused(agent.id), false);

      // loadAlert via bound instance
      const alert = await enforcer.loadAlert(agent.id, '2026-04-13');
      assert.ok(alert);
      assert.equal(alert.type, 'budget-exhausted');
    });

    it('enforceAll works through bound instance', async () => {
      await createTestAgent('b1', 10000);
      await createTestAgent('b2', 10000);

      const enforcer = createBudgetEnforcer({ agentStore, usageStore, baseDir: tmpDir });
      const results = await enforcer.enforceAll('2026-04-13');
      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.exceeded === false));
    });
  });

  // -----------------------------------------------------------------------
  // AC 4 — budget-exhausted system notification emission
  //
  // When an optional NotificationStore is passed via BudgetEnforcerDeps,
  // enforcement that pauses an agent must auto-emit a system notification
  // attributed to the paused agent. The notification carries:
  //   - source: 'system'
  //   - systemEvent: 'budget-exhausted'
  //   - sender slug = the paused agent (system event subject)
  //   - dedupKey = `budget-exhausted:<agent>:<weekMonday>` (no re-emit
  //     while the prior is still unread)
  //
  // Re-emission is gated on a fresh alert flag write, mirroring the
  // existing alertWritten idempotency. The notification store's own
  // dedupKey path is a belt-and-suspenders second line of defense.
  // -----------------------------------------------------------------------
  describe('budget-exhausted notification emission (AC 4)', () => {
    it('does not require a notificationStore — legacy callers stay working', async () => {
      const agent = await createTestAgent('legacy', 100);
      await addUsage(agent.id, 80, 80, '2026-04-13'); // 160 > 100

      const result = await enforceBudget(agent.id, deps, '2026-04-13');

      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.alertWritten, true);
      assert.equal(result.notificationEmitted, false);
      assert.equal(result.notificationId, null);
    });

    it('emits a system notification when pause-on-exhaust fires', async () => {
      const notificationStore = new NotificationStore(tmpDir);
      const agent = await createTestAgent('notified', 200);
      await addUsage(agent.id, 150, 100, '2026-04-13'); // 250 > 200

      const result = await enforceBudget(
        agent.id,
        { agentStore, usageStore, baseDir: tmpDir, notificationStore },
        '2026-04-13',
        '2026-04-15T10:00:00.000Z',
      );

      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.alertWritten, true);
      assert.equal(result.notificationEmitted, true);
      assert.ok(result.notificationId);
      assert.match(result.notificationId, /^notif-[a-f0-9]+$/);

      // Verify the notification persisted under the paused agent's slug
      const feed = await notificationStore.load(agent.id);
      assert.equal(feed.length, 1);
      const n = feed[0]!;
      assert.equal(n.id, result.notificationId);
      assert.equal(n.agentId, agent.id, 'sender slug = paused agent');
      assert.equal(n.source, 'system');
      assert.equal(n.systemEvent, 'budget-exhausted');
      assert.equal(n.read, false);
      assert.equal(n.createdAt, '2026-04-15T10:00:00.000Z');
      assert.equal(n.dedupKey, `budget-exhausted:${agent.id}:2026-04-13`);
      assert.ok(n.title.length > 0);
      assert.ok(n.body.includes(agent.id));
      assert.ok(n.body.includes('200')); // budget
      assert.ok(n.body.includes('250')); // used
      assert.ok(n.body.includes('2026-04-13')); // week
      assert.ok(n.metadata);
      assert.equal(n.metadata.weekMonday, '2026-04-13');
      assert.equal(n.metadata.used, 250);
      assert.equal(n.metadata.budget, 200);
      assert.equal(n.metadata.exceededBy, 50);
      assert.ok(typeof n.metadata.alertPath === 'string');
    });

    it('does not emit a duplicate notification on a re-enforce while still paused', async () => {
      const notificationStore = new NotificationStore(tmpDir);
      const agent = await createTestAgent('idem-notif', 100);
      await addUsage(agent.id, 80, 80, '2026-04-13'); // 160 > 100
      const localDeps: BudgetEnforcerDeps = {
        agentStore,
        usageStore,
        baseDir: tmpDir,
        notificationStore,
      };

      const first = await enforceBudget(agent.id, localDeps, '2026-04-13', '2026-04-15T10:00:00Z');
      assert.equal(first.notificationEmitted, true);
      assert.equal((await notificationStore.load(agent.id)).length, 1);

      const second = await enforceBudget(agent.id, localDeps, '2026-04-13', '2026-04-15T11:00:00Z');
      assert.equal(second.exceeded, true);
      assert.equal(second.alertWritten, false, 'second call must be alert-idempotent');
      assert.equal(second.notificationEmitted, false, 'second call must not re-emit');
      assert.equal(second.notificationId, null);

      // Feed unchanged — same single entry as after the first emission.
      const feed = await notificationStore.load(agent.id);
      assert.equal(feed.length, 1);
      assert.equal(feed[0]!.id, first.notificationId);
    });

    it('does not emit when enforcement reports not-exceeded', async () => {
      const notificationStore = new NotificationStore(tmpDir);
      const agent = await createTestAgent('under', 10000);
      await addUsage(agent.id, 100, 50, '2026-04-13');

      const result = await enforceBudget(
        agent.id,
        { agentStore, usageStore, baseDir: tmpDir, notificationStore },
        '2026-04-13',
      );

      assert.equal(result.exceeded, false);
      assert.equal(result.notificationEmitted, false);
      assert.equal(result.notificationId, null);
      const feed = await notificationStore.load(agent.id);
      assert.equal(feed.length, 0);
    });

    it('attributes one notification per paused agent in enforceAllBudgets', async () => {
      const notificationStore = new NotificationStore(tmpDir);
      const a1 = await createTestAgent('still-ok', 10000);
      const a2 = await createTestAgent('over-quota', 100);
      await addUsage(a1.id, 50, 50, '2026-04-13');
      await addUsage(a2.id, 80, 80, '2026-04-13'); // exceeds

      const results = await enforceAllBudgets(
        { agentStore, usageStore, baseDir: tmpDir, notificationStore },
        '2026-04-13',
      );

      const ok = results.find((r) => r.agentId === a1.id);
      const over = results.find((r) => r.agentId === a2.id);
      assert.ok(ok && over);
      assert.equal(ok.notificationEmitted, false);
      assert.equal(over.notificationEmitted, true);

      const okFeed = await notificationStore.load(a1.id);
      const overFeed = await notificationStore.load(a2.id);
      assert.equal(okFeed.length, 0);
      assert.equal(overFeed.length, 1);
      assert.equal(overFeed[0]!.agentId, a2.id, 'sender = the paused agent only');
      assert.equal(overFeed[0]!.systemEvent, 'budget-exhausted');
    });

    it('flows through the createBudgetEnforcer bound instance', async () => {
      const notificationStore = new NotificationStore(tmpDir);
      const agent = await createTestAgent('bound-notif', 200);
      await addUsage(agent.id, 150, 100, '2026-04-13'); // 250 > 200

      const enforcer = createBudgetEnforcer({
        agentStore,
        usageStore,
        baseDir: tmpDir,
        notificationStore,
      });

      const result = await enforcer.enforce(agent.id, '2026-04-13');
      assert.equal(result.notificationEmitted, true);
      assert.ok(result.notificationId);
      const feed = await notificationStore.load(agent.id);
      assert.equal(feed.length, 1);
      assert.equal(feed[0]!.systemEvent, 'budget-exhausted');
    });

    it('survives notification-store failures without breaking enforcement', async () => {
      // Replace the store's append with a throwing impl to simulate a
      // disk write failure. enforcement must still pause the agent and
      // write the alert flag; only `notificationEmitted` should be false.
      const notificationStore = new NotificationStore(tmpDir);
      (notificationStore as unknown as {
        append: (...args: unknown[]) => Promise<unknown>;
      }).append = async () => {
        throw new Error('simulated disk failure');
      };

      const agent = await createTestAgent('flaky-notif', 100);
      await addUsage(agent.id, 80, 80, '2026-04-13');

      const result = await enforceBudget(
        agent.id,
        { agentStore, usageStore, baseDir: tmpDir, notificationStore },
        '2026-04-13',
      );

      assert.equal(result.exceeded, true);
      assert.equal(result.paused, true);
      assert.equal(result.alertWritten, true);
      assert.equal(result.notificationEmitted, false);
      assert.equal(result.notificationId, null);
      assert.equal(await isAgentPaused(agent.id, deps), true);
    });
  });
});
