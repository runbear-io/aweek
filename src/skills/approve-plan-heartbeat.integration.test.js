/**
 * Integration tests: approve-plan → heartbeat/crontab auto-activation.
 *
 * These tests verify the end-to-end wiring between processApproval and the
 * crontab manager. Instead of a noop mock, the installFn uses the same
 * in-memory crontab harness from crontab-manager.test.js, so we can assert
 * that crontab entries are actually built, parsed, and managed correctly
 * across the full approval lifecycle.
 *
 * Covers:
 *  - First approval triggers crontab install with correct agent/schedule/command
 *  - Subsequent approvals replace (not duplicate) the crontab entry
 *  - Edit+auto-approve triggers crontab install
 *  - Edit without auto-approve does NOT touch crontab
 *  - Reject does NOT touch crontab
 *  - Heartbeat activation failure is non-fatal (plan still approved)
 *  - Multi-agent: approving different agents produces separate crontab entries
 *  - Custom schedule and command propagate through the full flow
 *  - Idempotency: repeated approval cycles never create duplicate entries
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import {
  processApproval,
  buildHeartbeatCommand,
} from './approve-plan.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import { AgentStore } from '../storage/agent-store.js';
import {
  buildCronEntry,
  parseHeartbeatEntries,
  removeLinesForAgent,
} from '../heartbeat/crontab-manager.js';

// ---------------------------------------------------------------------------
// In-memory crontab harness (same pattern as crontab-manager.test.js)
// ---------------------------------------------------------------------------

function createCrontabHarness() {
  let crontabContent = '';
  const installCalls = [];

  async function install({ agentId, command, schedule = '0 * * * *' }) {
    installCalls.push({ agentId, command, schedule });
    const cleaned = removeLinesForAgent(crontabContent, agentId);
    const entry = buildCronEntry({ agentId, command, schedule });
    const base = cleaned.trimEnd();
    crontabContent = base ? `${base}\n${entry}\n` : `${entry}\n`;
    return { installed: true, entry };
  }

  return {
    install,
    get content() { return crontabContent; },
    set content(val) { crontabContent = val; },
    get calls() { return installCalls; },
    entries() { return parseHeartbeatEntries(crontabContent); },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildTestAgent(overrides = {}) {
  // Post-refactor identity (name, role, system prompt) lives in the
  // `.claude/agents/<slug>.md` file — aweek JSON only holds scheduling state.
  // Tests use the slug-based `createAgentConfig({ subagentRef })` factory and
  // derive a unique slug per call from the `name` override so multi-agent
  // isolation checks still work.
  const slug = (overrides.subagentRef || overrides.name || 'integ-bot')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const config = createAgentConfig({ subagentRef: slug });

  const goal = createGoal('Ship the product', '3mo');
  config.goals.push(goal);

  const obj = createObjective('Build core module', goal.id);
  const monthlyPlan = createMonthlyPlan('2026-04', [obj]);
  config.monthlyPlans.push(monthlyPlan);

  const task1 = createTask('Implement data layer', obj.id, { priority: 'high', estimatedMinutes: 60 });
  const task2 = createTask('Write unit tests', obj.id, { priority: 'medium', estimatedMinutes: 90 });
  const weeklyPlan = createWeeklyPlan(overrides.week || '2026-W16', '2026-04', [task1, task2]);
  config.weeklyPlans.push(weeklyPlan);

  return { config, goal, obj, monthlyPlan, weeklyPlan, task1, task2 };
}

async function saveAgent(config) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-integ-'));
  const store = new AgentStore(tmpDir);
  await store.save(config);
  return { store, tmpDir };
}

// ---------------------------------------------------------------------------
// Integration: first approval activates heartbeat
// ---------------------------------------------------------------------------

describe('Integration: approve-plan → heartbeat auto-activation', () => {
  it('first approval installs a crontab entry with correct agent ID', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
      projectDir: '/test/project',
    });

    assert.ok(result.success);
    assert.equal(result.heartbeatActivated, true);
    assert.equal(result.isFirstApproval, true);

    // Verify the crontab harness has exactly one entry for this agent
    const entries = harness.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agentId, config.id);
    assert.equal(entries[0].schedule, '0 * * * *');
    assert.ok(entries[0].command.includes(config.id));
  });

  it('crontab entry command matches buildHeartbeatCommand output', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();
    const projectDir = '/home/user/aweek';

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
      projectDir,
    });

    const expectedCmd = buildHeartbeatCommand(config.id, projectDir);
    assert.equal(harness.calls[0].command, expectedCmd);
  });

  it('custom schedule propagates to crontab entry', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
      heartbeatSchedule: '*/15 * * * *',
    });

    const entries = harness.entries();
    assert.equal(entries[0].schedule, '*/15 * * * *');
    assert.equal(harness.calls[0].schedule, '*/15 * * * *');
  });

  it('custom heartbeat command propagates to crontab entry', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
      heartbeatCommand: '/usr/local/bin/custom-heartbeat --agent ' + config.id,
    });

    const entries = harness.entries();
    assert.ok(entries[0].command.includes('custom-heartbeat'));
    assert.equal(harness.calls[0].command, `/usr/local/bin/custom-heartbeat --agent ${config.id}`);
  });
});

// ---------------------------------------------------------------------------
// Integration: subsequent approval replaces (no duplicates)
// ---------------------------------------------------------------------------

describe('Integration: subsequent approvals are idempotent', () => {
  it('approving two plans for the same agent produces exactly one crontab entry', async () => {
    const { config, obj } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    // First approval
    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
    });

    // Add a second pending plan and approve it
    const store = new AgentStore(tmpDir);
    const reloaded = await store.load(config.id);
    const task = createTask('Follow-up work', obj.id, { priority: 'medium' });
    const plan2 = createWeeklyPlan('2026-W17', '2026-04', [task]);
    reloaded.weeklyPlans.push(plan2);
    await store.save(reloaded);

    const result2 = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
    });

    assert.ok(result2.success);
    assert.equal(result2.isFirstApproval, false);

    // install was called twice, but crontab should have exactly ONE entry
    assert.equal(harness.calls.length, 2);
    const entries = harness.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agentId, config.id);
  });

  it('reinstalling with different schedule replaces the entry', async () => {
    const { config, obj } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    // First approval with default schedule
    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
    });

    // Add second plan and approve with custom schedule
    const store = new AgentStore(tmpDir);
    const reloaded = await store.load(config.id);
    const task = createTask('More work', obj.id);
    const plan2 = createWeeklyPlan('2026-W17', '2026-04', [task]);
    reloaded.weeklyPlans.push(plan2);
    await store.save(reloaded);

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
      heartbeatSchedule: '*/30 * * * *',
    });

    const entries = harness.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].schedule, '*/30 * * * *');
  });
});

// ---------------------------------------------------------------------------
// Integration: edit + auto-approve activates heartbeat
// ---------------------------------------------------------------------------

describe('Integration: edit+auto-approve → heartbeat activation', () => {
  it('edit with autoApproveAfterEdit installs crontab entry', async () => {
    const { config, task1 } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [{ action: 'update', taskId: task1.id, priority: 'critical' }],
      autoApproveAfterEdit: true,
      dataDir: tmpDir,
      installFn: harness.install,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.equal(result.heartbeatActivated, true);
    assert.equal(result.isFirstApproval, true);

    const entries = harness.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agentId, config.id);
  });

  it('edit without autoApproveAfterEdit does NOT install crontab entry', async () => {
    const { config, task1 } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [{ action: 'update', taskId: task1.id, priority: 'low' }],
      autoApproveAfterEdit: false,
      dataDir: tmpDir,
      installFn: harness.install,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, false);
    assert.equal(result.heartbeatActivated, false);

    const entries = harness.entries();
    assert.equal(entries.length, 0);
    assert.equal(harness.calls.length, 0);
  });

  it('edit+auto-approve with custom schedule installs correct schedule', async () => {
    const { config, task1 } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [{ action: 'update', taskId: task1.id, description: 'Revised task' }],
      autoApproveAfterEdit: true,
      dataDir: tmpDir,
      installFn: harness.install,
      heartbeatSchedule: '0 */2 * * *',
    });

    const entries = harness.entries();
    assert.equal(entries[0].schedule, '0 */2 * * *');
  });
});

// ---------------------------------------------------------------------------
// Integration: reject does NOT touch crontab
// ---------------------------------------------------------------------------

describe('Integration: reject does NOT activate heartbeat', () => {
  it('rejecting a plan does not install any crontab entry', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    const result = await processApproval({
      agentId: config.id,
      decision: 'reject',
      dataDir: tmpDir,
      installFn: harness.install,
    });

    assert.ok(result.success);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.entries().length, 0);
  });

  it('reject after a previous approval does not remove existing crontab entry', async () => {
    const { config, obj } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    // First: approve the plan
    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
    });
    assert.equal(harness.entries().length, 1);

    // Add a new pending plan
    const store = new AgentStore(tmpDir);
    const reloaded = await store.load(config.id);
    const task = createTask('New work', obj.id);
    const plan2 = createWeeklyPlan('2026-W17', '2026-04', [task]);
    reloaded.weeklyPlans.push(plan2);
    await store.save(reloaded);

    // Reject the new plan
    await processApproval({
      agentId: config.id,
      decision: 'reject',
      dataDir: tmpDir,
      installFn: harness.install,
    });

    // Crontab entry from the first approval should still exist
    assert.equal(harness.entries().length, 1);
    assert.equal(harness.calls.length, 1); // only 1 install call total
  });
});

// ---------------------------------------------------------------------------
// Integration: heartbeat failure is non-fatal
// ---------------------------------------------------------------------------

describe('Integration: heartbeat activation failure is non-fatal', () => {
  it('plan is still approved even when installFn throws', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);

    const failingInstall = async () => {
      throw new Error('crontab: permission denied');
    };

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: failingInstall,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.ok(result.plan.approvedAt);
    assert.equal(result.heartbeatActivated, false);

    // Verify persisted state — plan is approved in file
    const store = new AgentStore(tmpDir);
    const reloaded = await store.load(config.id);
    assert.equal(reloaded.weeklyPlans[0].approved, true);
  });

  it('edit+auto-approve persists even when heartbeat fails', async () => {
    const { config, task1 } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);

    const failingInstall = async () => {
      throw new Error('crontab: not available');
    };

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [{ action: 'update', taskId: task1.id, priority: 'critical' }],
      autoApproveAfterEdit: true,
      dataDir: tmpDir,
      installFn: failingInstall,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.equal(result.heartbeatActivated, false);
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-agent crontab isolation
// ---------------------------------------------------------------------------

describe('Integration: multi-agent crontab isolation', () => {
  it('approving different agents creates separate crontab entries', async () => {
    const harness = createCrontabHarness();

    // Create and save agent A
    const agentA = buildTestAgent({ name: 'AlphaBot' });
    const { tmpDir: dirA } = await saveAgent(agentA.config);

    // Create and save agent B
    const agentB = buildTestAgent({ name: 'BetaBot' });
    const { tmpDir: dirB } = await saveAgent(agentB.config);

    // Approve agent A
    await processApproval({
      agentId: agentA.config.id,
      decision: 'approve',
      dataDir: dirA,
      installFn: harness.install,
    });

    // Approve agent B
    await processApproval({
      agentId: agentB.config.id,
      decision: 'approve',
      dataDir: dirB,
      installFn: harness.install,
    });

    const entries = harness.entries();
    assert.equal(entries.length, 2);

    const ids = entries.map((e) => e.agentId).sort();
    const expected = [agentA.config.id, agentB.config.id].sort();
    assert.deepStrictEqual(ids, expected);
  });

  it('each agent gets its own schedule when specified', async () => {
    const harness = createCrontabHarness();

    const agentA = buildTestAgent({ name: 'FastBot' });
    const { tmpDir: dirA } = await saveAgent(agentA.config);
    const agentB = buildTestAgent({ name: 'SlowBot' });
    const { tmpDir: dirB } = await saveAgent(agentB.config);

    await processApproval({
      agentId: agentA.config.id,
      decision: 'approve',
      dataDir: dirA,
      installFn: harness.install,
      heartbeatSchedule: '*/10 * * * *',
    });

    await processApproval({
      agentId: agentB.config.id,
      decision: 'approve',
      dataDir: dirB,
      installFn: harness.install,
      heartbeatSchedule: '0 */6 * * *',
    });

    const entries = harness.entries();
    const scheduleA = entries.find((e) => e.agentId === agentA.config.id);
    const scheduleB = entries.find((e) => e.agentId === agentB.config.id);

    assert.equal(scheduleA.schedule, '*/10 * * * *');
    assert.equal(scheduleB.schedule, '0 */6 * * *');
  });

  it('reinstalling one agent does not affect the other', async () => {
    const harness = createCrontabHarness();

    const agentA = buildTestAgent({ name: 'StableBot' });
    const { tmpDir: dirA } = await saveAgent(agentA.config);
    const agentB = buildTestAgent({ name: 'ChangingBot' });
    const { tmpDir: dirB } = await saveAgent(agentB.config);

    // Approve both
    await processApproval({
      agentId: agentA.config.id,
      decision: 'approve',
      dataDir: dirA,
      installFn: harness.install,
    });
    await processApproval({
      agentId: agentB.config.id,
      decision: 'approve',
      dataDir: dirB,
      installFn: harness.install,
    });

    assert.equal(harness.entries().length, 2);

    // Add new plan for agent B and re-approve with different schedule
    const storeB = new AgentStore(dirB);
    const reloadedB = await storeB.load(agentB.config.id);
    const task = createTask('New task', agentB.obj?.id || reloadedB.monthlyPlans[0].objectives[0].id);
    const plan2 = createWeeklyPlan('2026-W17', '2026-04', [task]);
    reloadedB.weeklyPlans.push(plan2);
    await storeB.save(reloadedB);

    await processApproval({
      agentId: agentB.config.id,
      decision: 'approve',
      dataDir: dirB,
      installFn: harness.install,
      heartbeatSchedule: '*/5 * * * *',
    });

    // Agent A entry should be untouched
    const entries = harness.entries();
    assert.equal(entries.length, 2);
    const entryA = entries.find((e) => e.agentId === agentA.config.id);
    assert.equal(entryA.schedule, '0 * * * *');

    // Agent B should have new schedule
    const entryB = entries.find((e) => e.agentId === agentB.config.id);
    assert.equal(entryB.schedule, '*/5 * * * *');
  });
});

// ---------------------------------------------------------------------------
// Integration: full lifecycle — create → approve → reject next → approve next
// ---------------------------------------------------------------------------

describe('Integration: full approval lifecycle with crontab', () => {
  it('approve → add plan → reject → add plan → approve maintains single entry', async () => {
    const { config, obj } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    // Step 1: Approve first plan
    const r1 = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
    });
    assert.ok(r1.success);
    assert.equal(r1.isFirstApproval, true);
    assert.equal(harness.entries().length, 1);

    // Step 2: Add second plan and reject it
    const store = new AgentStore(tmpDir);
    let reloaded = await store.load(config.id);
    const task2 = createTask('Plan 2 work', obj.id);
    const plan2 = createWeeklyPlan('2026-W17', '2026-04', [task2]);
    reloaded.weeklyPlans.push(plan2);
    await store.save(reloaded);

    const r2 = await processApproval({
      agentId: config.id,
      decision: 'reject',
      dataDir: tmpDir,
      installFn: harness.install,
    });
    assert.ok(r2.success);
    // Crontab should still have the entry from the first approval
    assert.equal(harness.entries().length, 1);

    // Step 3: Add third plan and approve it
    reloaded = await store.load(config.id);
    const task3 = createTask('Plan 3 work', obj.id);
    const plan3 = createWeeklyPlan('2026-W18', '2026-04', [task3]);
    reloaded.weeklyPlans.push(plan3);
    await store.save(reloaded);

    const r3 = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
    });
    assert.ok(r3.success);
    assert.equal(r3.isFirstApproval, false);

    // Still exactly one crontab entry
    assert.equal(harness.entries().length, 1);
    assert.equal(harness.entries()[0].agentId, config.id);
  });
});

// ---------------------------------------------------------------------------
// Integration: crontab content survives pre-existing entries
// ---------------------------------------------------------------------------

describe('Integration: crontab preserves pre-existing entries', () => {
  it('approval does not clobber existing non-aweek crontab entries', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveAgent(config);
    const harness = createCrontabHarness();

    // Simulate existing system crontab entries
    harness.content = '30 2 * * * /usr/bin/backup.sh\n0 4 * * 0 /usr/bin/weekly-cleanup.sh\n';

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: harness.install,
    });

    // Verify system entries still present
    assert.ok(harness.content.includes('/usr/bin/backup.sh'));
    assert.ok(harness.content.includes('/usr/bin/weekly-cleanup.sh'));

    // And the aweek entry is also there
    const entries = harness.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agentId, config.id);
  });
});
