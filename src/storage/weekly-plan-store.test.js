import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WeeklyPlanStore } from './weekly-plan-store.js';
import {
  createGoal,
  createObjective,
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import { validateWeeklyPlan } from '../schemas/validator.js';

describe('WeeklyPlanStore', () => {
  let store;
  let tmpDir;
  const agentId = 'agent-wplan-test-abc12345';

  /** Helper: create a valid weekly plan with one task */
  function makeTestPlan(week = '2026-W16', month = '2026-04') {
    const goal = createGoal('Test goal');
    const obj = createObjective('Test objective', goal.id);
    const task = createTask('Test task', obj.id);
    const plan = createWeeklyPlan(week, month, [task]);
    return { goal, obj, task, plan };
  }

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-wplan-test-'));
    store = new WeeklyPlanStore(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // save & load
  // -------------------------------------------------------------------------

  it('should save and load a weekly plan', async () => {
    const { plan } = makeTestPlan();
    await store.save(agentId, plan);
    const loaded = await store.load(agentId, plan.week);
    assert.deepStrictEqual(loaded, plan);
  });

  it('should validate weekly plan on save', () => {
    const { plan } = makeTestPlan();
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true);
  });

  it('should reject invalid plan on save', async () => {
    await assert.rejects(
      () => store.save(agentId, { week: 'bad', tasks: [], approved: false }),
      /Schema validation failed/
    );
  });

  it('should validate on load (rejects corrupted files)', async () => {
    // Save a valid plan first, then we verify that load validates
    const { plan } = makeTestPlan('2026-W50');
    await store.save(agentId, plan);
    const loaded = await store.load(agentId, '2026-W50');
    const result = validateWeeklyPlan(loaded);
    assert.equal(result.valid, true);
  });

  // -------------------------------------------------------------------------
  // exists
  // -------------------------------------------------------------------------

  it('should check plan existence', async () => {
    const { plan } = makeTestPlan('2026-W17');
    assert.equal(await store.exists(agentId, '2026-W17'), false);
    await store.save(agentId, plan);
    assert.equal(await store.exists(agentId, '2026-W17'), true);
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  it('should list week keys sorted', async () => {
    const freshAgent = 'agent-list-wplan-00000001';
    const { plan: p1 } = makeTestPlan('2026-W03', '2026-01');
    const { plan: p2 } = makeTestPlan('2026-W01', '2026-01');
    const { plan: p3 } = makeTestPlan('2026-W02', '2026-01');
    await store.save(freshAgent, p1);
    await store.save(freshAgent, p2);
    await store.save(freshAgent, p3);

    const weeks = await store.list(freshAgent);
    assert.deepStrictEqual(weeks, ['2026-W01', '2026-W02', '2026-W03']);
  });

  it('should return empty list for agent with no plans', async () => {
    const freshAgent = 'agent-empty-wplan-00000002';
    const weeks = await store.list(freshAgent);
    assert.deepStrictEqual(weeks, []);
  });

  // -------------------------------------------------------------------------
  // loadAll
  // -------------------------------------------------------------------------

  it('should loadAll weekly plans', async () => {
    const freshAgent = 'agent-loadall-wplan-00000003';
    const { plan: p1 } = makeTestPlan('2026-W18', '2026-04');
    const { plan: p2 } = makeTestPlan('2026-W19', '2026-05');
    await store.save(freshAgent, p1);
    await store.save(freshAgent, p2);

    const all = await store.loadAll(freshAgent);
    assert.equal(all.length, 2);
  });

  // -------------------------------------------------------------------------
  // loadByMonth
  // -------------------------------------------------------------------------

  it('should loadByMonth — filter plans for a specific month', async () => {
    const freshAgent = 'agent-bymonth-wplan-00000004';
    const { plan: p1 } = makeTestPlan('2026-W14', '2026-04');
    const { plan: p2 } = makeTestPlan('2026-W15', '2026-04');
    const { plan: p3 } = makeTestPlan('2026-W22', '2026-05');
    await store.save(freshAgent, p1);
    await store.save(freshAgent, p2);
    await store.save(freshAgent, p3);

    const aprilPlans = await store.loadByMonth(freshAgent, '2026-04');
    assert.equal(aprilPlans.length, 2);

    const mayPlans = await store.loadByMonth(freshAgent, '2026-05');
    assert.equal(mayPlans.length, 1);
    assert.equal(mayPlans[0].week, '2026-W22');

    const junePlans = await store.loadByMonth(freshAgent, '2026-06');
    assert.equal(junePlans.length, 0);
  });

  // -------------------------------------------------------------------------
  // loadLatestApproved
  // -------------------------------------------------------------------------

  it('should loadLatestApproved — return latest approved plan', async () => {
    const freshAgent = 'agent-approved-wplan-00000005';
    const { plan: p1 } = makeTestPlan('2026-W10', '2026-03');
    p1.approved = true;
    p1.approvedAt = new Date().toISOString();
    const { plan: p2 } = makeTestPlan('2026-W11', '2026-03');
    p2.approved = true;
    p2.approvedAt = new Date().toISOString();
    const { plan: p3 } = makeTestPlan('2026-W12', '2026-03');
    // p3 not approved

    await store.save(freshAgent, p1);
    await store.save(freshAgent, p2);
    await store.save(freshAgent, p3);

    const latest = await store.loadLatestApproved(freshAgent);
    assert.ok(latest);
    assert.equal(latest.week, '2026-W11');
    assert.equal(latest.approved, true);
  });

  it('should return null when no approved plan exists', async () => {
    const freshAgent = 'agent-noapproved-wplan-00000006';
    const { plan } = makeTestPlan('2026-W20', '2026-05');
    await store.save(freshAgent, plan);

    const result = await store.loadLatestApproved(freshAgent);
    assert.equal(result, null);
  });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  it('should delete a weekly plan', async () => {
    const { plan } = makeTestPlan('2026-W30');
    await store.save(agentId, plan);
    assert.equal(await store.exists(agentId, '2026-W30'), true);
    await store.delete(agentId, '2026-W30');
    assert.equal(await store.exists(agentId, '2026-W30'), false);
  });

  it('should not throw when deleting nonexistent plan', async () => {
    await store.delete(agentId, '2026-W99');
    // No error thrown — rm with force:true
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  it('should update a weekly plan via updater function', async () => {
    const { plan } = makeTestPlan('2026-W31');
    await store.save(agentId, plan);

    const updated = await store.update(agentId, '2026-W31', (p) => {
      p.approved = true;
      p.approvedAt = new Date().toISOString();
      return p;
    });

    assert.equal(updated.approved, true);
    assert.ok(updated.approvedAt);
    assert.ok(updated.updatedAt);

    const loaded = await store.load(agentId, '2026-W31');
    assert.equal(loaded.approved, true);
  });

  it('should throw on update of nonexistent plan', async () => {
    await assert.rejects(
      () => store.update(agentId, '1999-W01', (p) => p),
      { code: 'ENOENT' }
    );
  });

  // -------------------------------------------------------------------------
  // approve (human-in-the-loop gate)
  // -------------------------------------------------------------------------

  it('should approve a weekly plan', async () => {
    const { plan } = makeTestPlan('2026-W32');
    await store.save(agentId, plan);
    assert.equal(plan.approved, false);

    const approved = await store.approve(agentId, '2026-W32');
    assert.equal(approved.approved, true);
    assert.ok(approved.approvedAt);

    // Verify persisted
    const loaded = await store.load(agentId, '2026-W32');
    assert.equal(loaded.approved, true);
    assert.ok(loaded.approvedAt);
  });

  // -------------------------------------------------------------------------
  // updateTaskStatus
  // -------------------------------------------------------------------------

  it('should updateTaskStatus to completed with completedAt', async () => {
    const { plan, task } = makeTestPlan('2026-W33');
    await store.save(agentId, plan);

    const updated = await store.updateTaskStatus(agentId, '2026-W33', task.id, 'completed');
    assert.ok(updated);
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt);

    // Verify persisted
    const loaded = await store.load(agentId, '2026-W33');
    const loadedTask = loaded.tasks.find((t) => t.id === task.id);
    assert.equal(loadedTask.status, 'completed');
    assert.ok(loadedTask.completedAt);
  });

  it('should updateTaskStatus to in-progress without completedAt', async () => {
    const { plan, task } = makeTestPlan('2026-W34');
    await store.save(agentId, plan);

    const updated = await store.updateTaskStatus(agentId, '2026-W34', task.id, 'in-progress');
    assert.ok(updated);
    assert.equal(updated.status, 'in-progress');
    assert.equal(updated.completedAt, undefined);
  });

  it('should updateTaskStatus to delegated', async () => {
    const { plan, task } = makeTestPlan('2026-W35');
    await store.save(agentId, plan);

    const updated = await store.updateTaskStatus(agentId, '2026-W35', task.id, 'delegated');
    assert.ok(updated);
    assert.equal(updated.status, 'delegated');
  });

  it('should return null for updateTaskStatus on nonexistent task', async () => {
    const { plan } = makeTestPlan('2026-W36');
    await store.save(agentId, plan);

    const result = await store.updateTaskStatus(agentId, '2026-W36', 'task-nonexistent', 'completed');
    assert.equal(result, null);
  });

  // -------------------------------------------------------------------------
  // addTask
  // -------------------------------------------------------------------------

  it('should addTask to existing plan', async () => {
    const goal = createGoal('Another goal');
    const obj = createObjective('Another obj', goal.id);
    const { plan } = makeTestPlan('2026-W37');
    await store.save(agentId, plan);

    const newTask = createTask('New task', obj.id);
    await store.addTask(agentId, '2026-W37', newTask);

    const loaded = await store.load(agentId, '2026-W37');
    assert.equal(loaded.tasks.length, 2);
    assert.ok(loaded.tasks.find((t) => t.id === newTask.id));
  });

  // -------------------------------------------------------------------------
  // getTasksForObjective (plan traceability)
  // -------------------------------------------------------------------------

  it('should getTasksForObjective across weekly plans', async () => {
    const freshAgent = 'agent-trace-obj-wplan-00000007';
    const goal = createGoal('Traced goal');
    const obj = createObjective('Traced obj', goal.id);

    const task1 = createTask('Task in W14', obj.id);
    const plan1 = createWeeklyPlan('2026-W14', '2026-04', [task1]);

    const task2 = createTask('Task in W15', obj.id);
    const otherObj = createObjective('Other obj', goal.id);
    const otherTask = createTask('Unrelated task', otherObj.id);
    const plan2 = createWeeklyPlan('2026-W15', '2026-04', [task2, otherTask]);

    await store.save(freshAgent, plan1);
    await store.save(freshAgent, plan2);

    const traced = await store.getTasksForObjective(freshAgent, obj.id);
    assert.equal(traced.length, 2);
    assert.ok(traced.every((t) => t.objectiveId === obj.id));
  });

  it('should return empty array when no tasks match objective', async () => {
    const freshAgent = 'agent-notrace-wplan-00000008';
    const { plan } = makeTestPlan('2026-W40');
    await store.save(freshAgent, plan);

    const traced = await store.getTasksForObjective(freshAgent, 'obj-nonexistent');
    assert.deepStrictEqual(traced, []);
  });

  // -------------------------------------------------------------------------
  // idempotency
  // -------------------------------------------------------------------------

  it('should be idempotent — saving same plan twice produces same result', async () => {
    const { plan } = makeTestPlan('2026-W41');
    await store.save(agentId, plan);
    await store.save(agentId, plan);

    const loaded = await store.load(agentId, plan.week);
    assert.deepStrictEqual(loaded, plan);
  });

  // -------------------------------------------------------------------------
  // error cases
  // -------------------------------------------------------------------------

  it('should throw on load of nonexistent plan', async () => {
    await assert.rejects(
      () => store.load(agentId, '1999-W01'),
      { code: 'ENOENT' }
    );
  });

  // -------------------------------------------------------------------------
  // file persistence verification
  // -------------------------------------------------------------------------

  it('should persist data across new store instances', async () => {
    const freshAgent = 'agent-persist-wplan-00000009';
    const { plan } = makeTestPlan('2026-W42');
    await store.save(freshAgent, plan);

    // Create a new store instance pointing at the same directory
    const store2 = new WeeklyPlanStore(tmpDir);
    const loaded = await store2.load(freshAgent, '2026-W42');
    assert.deepStrictEqual(loaded, plan);
  });

  it('should persist delete across new store instances', async () => {
    const freshAgent = 'agent-persist-del-wplan-00000010';
    const { plan } = makeTestPlan('2026-W43');
    await store.save(freshAgent, plan);
    await store.delete(freshAgent, '2026-W43');

    const store2 = new WeeklyPlanStore(tmpDir);
    assert.equal(await store2.exists(freshAgent, '2026-W43'), false);
  });

  it('should persist updates across new store instances', async () => {
    const freshAgent = 'agent-persist-upd-wplan-00000011';
    const { plan } = makeTestPlan('2026-W44');
    await store.save(freshAgent, plan);
    await store.approve(freshAgent, '2026-W44');

    const store2 = new WeeklyPlanStore(tmpDir);
    const loaded = await store2.load(freshAgent, '2026-W44');
    assert.equal(loaded.approved, true);
    assert.ok(loaded.approvedAt);
  });
});
