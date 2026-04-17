import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonthlyPlanStore } from './monthly-plan-store.js';
import { createGoal, createObjective, createMonthlyPlan } from '../models/agent.js';
import { validateMonthlyPlan } from '../schemas/validator.js';

describe('MonthlyPlanStore', () => {
  let store;
  let tmpDir;
  const agentId = 'agent-plan-test-abc12345';

  /** Helper: create a valid monthly plan with one objective */
  function makeTestPlan(month = '2026-04') {
    const goal = createGoal('Test goal');
    const obj = createObjective('Test objective', goal.id);
    const plan = createMonthlyPlan(month, [obj]);
    return { goal, obj, plan };
  }

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-mplan-test-'));
    store = new MonthlyPlanStore(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should save and load a monthly plan', async () => {
    const { plan } = makeTestPlan();
    await store.save(agentId, plan);
    const loaded = await store.load(agentId, plan.month);
    assert.deepStrictEqual(loaded, plan);
  });

  it('should validate monthly plan on save', () => {
    const { plan } = makeTestPlan();
    const result = validateMonthlyPlan(plan);
    assert.equal(result.valid, true);
  });

  it('should reject invalid plan on save', async () => {
    await assert.rejects(
      () => store.save(agentId, { month: 'bad', objectives: [], status: 'active' }),
      /Schema validation failed/
    );
  });

  it('should check plan existence', async () => {
    const { plan } = makeTestPlan('2026-05');
    assert.equal(await store.exists(agentId, '2026-05'), false);
    await store.save(agentId, plan);
    assert.equal(await store.exists(agentId, '2026-05'), true);
  });

  it('should list month keys sorted', async () => {
    const freshAgent = 'agent-list-plan-00000001';
    const { plan: p1 } = makeTestPlan('2026-03');
    const { plan: p2 } = makeTestPlan('2026-01');
    const { plan: p3 } = makeTestPlan('2026-02');
    await store.save(freshAgent, p1);
    await store.save(freshAgent, p2);
    await store.save(freshAgent, p3);

    const months = await store.list(freshAgent);
    assert.deepStrictEqual(months, ['2026-01', '2026-02', '2026-03']);
  });

  it('should loadAll monthly plans', async () => {
    const freshAgent = 'agent-loadall-plan-00000002';
    const { plan: p1 } = makeTestPlan('2026-06');
    const { plan: p2 } = makeTestPlan('2026-07');
    await store.save(freshAgent, p1);
    await store.save(freshAgent, p2);

    const all = await store.loadAll(freshAgent);
    assert.equal(all.length, 2);
  });

  it('should loadActive monthly plan', async () => {
    const freshAgent = 'agent-active-plan-00000003';
    const { plan: activePlan } = makeTestPlan('2026-08');
    const { plan: archivedPlan } = makeTestPlan('2026-07');
    archivedPlan.status = 'archived';
    archivedPlan.updatedAt = new Date().toISOString();

    await store.save(freshAgent, activePlan);
    await store.save(freshAgent, archivedPlan);

    const active = await store.loadActive(freshAgent);
    assert.ok(active);
    assert.equal(active.month, '2026-08');
    assert.equal(active.status, 'active');
  });

  it('should return null when no active plan exists', async () => {
    const freshAgent = 'agent-no-active-00000004';
    const { plan } = makeTestPlan('2026-09');
    plan.status = 'archived';
    plan.updatedAt = new Date().toISOString();
    await store.save(freshAgent, plan);

    const active = await store.loadActive(freshAgent);
    assert.equal(active, null);
  });

  it('should delete a monthly plan', async () => {
    const { plan } = makeTestPlan('2026-10');
    await store.save(agentId, plan);
    assert.equal(await store.exists(agentId, '2026-10'), true);
    await store.delete(agentId, '2026-10');
    assert.equal(await store.exists(agentId, '2026-10'), false);
  });

  it('should update a monthly plan via updater function', async () => {
    const { plan } = makeTestPlan('2026-11');
    await store.save(agentId, plan);

    const updated = await store.update(agentId, '2026-11', (p) => {
      p.summary = 'Updated summary';
      return p;
    });

    assert.equal(updated.summary, 'Updated summary');
    assert.ok(updated.updatedAt);

    const loaded = await store.load(agentId, '2026-11');
    assert.equal(loaded.summary, 'Updated summary');
  });

  it('should updateStatus', async () => {
    const { plan } = makeTestPlan('2026-12');
    await store.save(agentId, plan);

    const updated = await store.updateStatus(agentId, '2026-12', 'completed');
    assert.equal(updated.status, 'completed');
  });

  it('should updateObjectiveStatus to completed with completedAt', async () => {
    const { plan, obj } = makeTestPlan('2025-01');
    await store.save(agentId, plan);

    const updated = await store.updateObjectiveStatus(agentId, '2025-01', obj.id, 'completed');
    assert.ok(updated);
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt);

    // Verify persisted
    const loaded = await store.load(agentId, '2025-01');
    const loadedObj = loaded.objectives.find((o) => o.id === obj.id);
    assert.equal(loadedObj.status, 'completed');
  });

  it('should return null for updateObjectiveStatus on nonexistent objective', async () => {
    const { plan } = makeTestPlan('2025-02');
    await store.save(agentId, plan);

    const result = await store.updateObjectiveStatus(agentId, '2025-02', 'obj-nonexistent', 'completed');
    assert.equal(result, null);
  });

  it('should addObjective to existing plan', async () => {
    const goal = createGoal('Another goal');
    const { plan } = makeTestPlan('2025-03');
    await store.save(agentId, plan);

    const newObj = createObjective('New objective', goal.id);
    await store.addObjective(agentId, '2025-03', newObj);

    const loaded = await store.load(agentId, '2025-03');
    assert.equal(loaded.objectives.length, 2);
    assert.ok(loaded.objectives.find((o) => o.id === newObj.id));
  });

  it('should getObjectivesForGoal across monthly plans', async () => {
    const freshAgent = 'agent-trace-goal-00000005';
    const goal = createGoal('Traced goal');

    const obj1 = createObjective('Obj in March', goal.id);
    const plan1 = createMonthlyPlan('2025-03', [obj1]);

    const obj2 = createObjective('Obj in April', goal.id);
    const otherObj = createObjective('Unrelated obj', 'goal-other-00000000');
    const plan2 = createMonthlyPlan('2025-04', [obj2, otherObj]);

    await store.save(freshAgent, plan1);
    await store.save(freshAgent, plan2);

    const traced = await store.getObjectivesForGoal(freshAgent, goal.id);
    assert.equal(traced.length, 2);
    assert.ok(traced.every((o) => o.goalId === goal.id));
  });

  it('should be idempotent — saving same plan twice produces same result', async () => {
    const { plan } = makeTestPlan('2025-05');
    await store.save(agentId, plan);
    await store.save(agentId, plan);

    const loaded = await store.load(agentId, plan.month);
    assert.deepStrictEqual(loaded, plan);
  });

  it('should throw on load of nonexistent plan', async () => {
    await assert.rejects(
      () => store.load(agentId, '1999-01'),
      { code: 'ENOENT' }
    );
  });

  it('should return empty list for agent with no plans', async () => {
    const freshAgent = 'agent-empty-plan-00000006';
    const months = await store.list(freshAgent);
    assert.deepStrictEqual(months, []);
  });
});
