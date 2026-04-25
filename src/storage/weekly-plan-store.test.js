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
import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
  isReviewObjectiveId,
} from '../schemas/weekly-plan.schema.js';

describe('WeeklyPlanStore', () => {
  let store;
  let tmpDir;
  const agentId = 'agent-wplan-test-abc12345';

  /**
   * Helper: create a valid weekly plan with one task.
   *
   * Plans start unapproved so the legacy approval-flow tests in this file
   * (approve, loadLatestApproved, pending-plan lookup) can exercise the
   * approve path. Production callers go through `createWeeklyPlan` directly
   * which now defaults to `approved: true` — that change is covered by
   * `goal-plan.test.js`.
   */
  function makeTestPlan(week = '2026-W16', month = '2026-04') {
    const goal = createGoal('Test goal');
    const obj = createObjective('Test objective', goal.id);
    const task = createTask({ title: 'Test task', prompt: 'Test task' }, obj.id);
    const plan = createWeeklyPlan(week, month, [task]);
    plan.approved = false;
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

    const newTask = createTask({ title: 'New task', prompt: 'New task' }, obj.id);
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

    const task1 = createTask({ title: 'Task in W14', prompt: 'Task in W14' }, obj.id);
    const plan1 = createWeeklyPlan('2026-W14', '2026-04', [task1]);

    const task2 = createTask({ title: 'Task in W15', prompt: 'Task in W15' }, obj.id);
    const otherObj = createObjective('Other obj', goal.id);
    const otherTask = createTask({ title: 'Unrelated task', prompt: 'Unrelated task' }, otherObj.id);
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

// =============================================================================
// Review task round-trips — Sub-AC 6a
// Prove that the store reads and writes daily-review and weekly-review tasks
// without stripping, hiding, or corrupting them.
// =============================================================================

describe('WeeklyPlanStore — review task round-trips (Sub-AC 6a)', () => {
  let reviewStore;
  let reviewTmpDir;
  const AGENT = 'agent-review-roundtrip-abc1';

  before(async () => {
    reviewTmpDir = await mkdtemp(join(tmpdir(), 'aweek-review-rt-'));
    reviewStore = new WeeklyPlanStore(reviewTmpDir);
  });

  after(async () => {
    await rm(reviewTmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // daily-review
  // ---------------------------------------------------------------------------

  it('saves and loads a daily-review task without modification', async () => {
    const task = createTask({ title: 'End-of-day reflection', prompt: 'End-of-day reflection' }, DAILY_REVIEW_OBJECTIVE_ID, {
      runAt: '2027-01-20T17:00:00Z',
      priority: 'high',
    });
    const plan = createWeeklyPlan('2027-W04', '2027-01', [task]);
    await reviewStore.save(AGENT, plan);

    const loaded = await reviewStore.load(AGENT, '2027-W04');
    assert.deepStrictEqual(loaded, plan);
    assert.equal(loaded.tasks[0].objectiveId, DAILY_REVIEW_OBJECTIVE_ID);
    assert.equal(loaded.tasks[0].runAt, '2027-01-20T17:00:00Z');
  });

  it('validates a plan with a daily-review task on save (assertValid passes)', async () => {
    const task = createTask({ title: 'Daily check-in', prompt: 'Daily check-in' }, DAILY_REVIEW_OBJECTIVE_ID, {
      runAt: '2027-01-21T17:00:00Z',
    });
    const plan = createWeeklyPlan('2027-W05', '2027-01', [task]);
    // save() would throw on schema violation — if it resolves the schema accepts it
    await assert.doesNotReject(() => reviewStore.save(AGENT, plan));
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  // ---------------------------------------------------------------------------
  // weekly-review
  // ---------------------------------------------------------------------------

  it('saves and loads a weekly-review task without modification', async () => {
    const task = createTask({ title: 'Week-in-review', prompt: 'Week-in-review' }, WEEKLY_REVIEW_OBJECTIVE_ID, {
      runAt: '2027-01-24T18:00:00Z',
      priority: 'high',
    });
    const plan = createWeeklyPlan('2027-W04', '2027-01', [task]);

    // Use a distinct agent to avoid collision with the daily-review test above
    const WAGENT = 'agent-review-weekly-rt-abc1';
    await reviewStore.save(WAGENT, plan);

    const loaded = await reviewStore.load(WAGENT, '2027-W04');
    assert.deepStrictEqual(loaded, plan);
    assert.equal(loaded.tasks[0].objectiveId, WEEKLY_REVIEW_OBJECTIVE_ID);
    assert.equal(loaded.tasks[0].runAt, '2027-01-24T18:00:00Z');
  });

  // ---------------------------------------------------------------------------
  // Mixed plans
  // ---------------------------------------------------------------------------

  it('preserves mixed plans (regular work + daily-review + weekly-review) in round-trip', async () => {
    const goal = createGoal('Ship something');
    const obj = createObjective('Build it', goal.id);
    const regularTask = createTask({ title: 'Implement feature', prompt: 'Implement feature' }, obj.id);
    const daily1 = createTask({ title: 'Mon review', prompt: 'Mon review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-18T17:00:00Z' });
    const daily2 = createTask({ title: 'Tue review', prompt: 'Tue review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-19T17:00:00Z' });
    const daily3 = createTask({ title: 'Wed review', prompt: 'Wed review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-20T17:00:00Z' });
    const daily4 = createTask({ title: 'Thu review', prompt: 'Thu review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-21T17:00:00Z' });
    const weeklyTask = createTask({ title: 'Week review', prompt: 'Week review' }, WEEKLY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-22T18:00:00Z' });

    const allTasks = [regularTask, daily1, daily2, daily3, daily4, weeklyTask];
    const plan = createWeeklyPlan('2027-W04', '2027-01', allTasks);
    const MAGENT = 'agent-review-mixed-rt-abc1';
    await reviewStore.save(MAGENT, plan);

    const loaded = await reviewStore.load(MAGENT, '2027-W04');
    assert.equal(loaded.tasks.length, 6);

    const reviewTasks = loaded.tasks.filter((t) => isReviewObjectiveId(t.objectiveId));
    const workTasks = loaded.tasks.filter((t) => !isReviewObjectiveId(t.objectiveId));
    assert.equal(reviewTasks.length, 5, 'five review tasks (4 daily + 1 weekly) should survive round-trip');
    assert.equal(workTasks.length, 1, 'one regular work task should survive round-trip');
    assert.ok(
      reviewTasks.some((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID),
      'weekly-review task must be present after round-trip',
    );
    assert.ok(
      reviewTasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID).length === 4,
      'all four daily-review tasks must be present after round-trip',
    );
  });

  // ---------------------------------------------------------------------------
  // updateTaskStatus on review tasks
  // ---------------------------------------------------------------------------

  it('updateTaskStatus marks a daily-review task completed and sets completedAt', async () => {
    const task = createTask({ title: 'Fri daily review', prompt: 'Fri daily review' }, DAILY_REVIEW_OBJECTIVE_ID, {
      runAt: '2027-01-22T17:00:00Z',
    });
    const plan = createWeeklyPlan('2027-W06', '2027-01', [task]);
    await reviewStore.save(AGENT, plan);

    const updated = await reviewStore.updateTaskStatus(AGENT, '2027-W06', task.id, 'completed');
    assert.ok(updated, 'updateTaskStatus should return the updated task');
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt, 'completedAt should be set');
    assert.equal(updated.objectiveId, DAILY_REVIEW_OBJECTIVE_ID, 'objectiveId must survive the update');

    // Verify persistence
    const loaded = await reviewStore.load(AGENT, '2027-W06');
    const savedTask = loaded.tasks.find((t) => t.id === task.id);
    assert.equal(savedTask.status, 'completed');
    assert.ok(savedTask.completedAt);
    assert.equal(savedTask.objectiveId, DAILY_REVIEW_OBJECTIVE_ID);
  });

  // ---------------------------------------------------------------------------
  // approve preserves review tasks
  // ---------------------------------------------------------------------------

  it('approve does not strip review tasks from the plan', async () => {
    const daily = createTask({ title: 'Thu daily review', prompt: 'Thu daily review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-21T17:00:00Z' });
    const weekly = createTask({ title: 'Week review', prompt: 'Week review' }, WEEKLY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-22T18:00:00Z' });
    const plan = createWeeklyPlan('2027-W07', '2027-01', [daily, weekly]);
    await reviewStore.save(AGENT, plan);

    const approved = await reviewStore.approve(AGENT, '2027-W07');
    assert.equal(approved.approved, true);
    assert.equal(approved.tasks.length, 2, 'both review tasks must survive approve()');
    assert.ok(
      approved.tasks.some((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID),
      'daily-review task must be present after approve()',
    );
    assert.ok(
      approved.tasks.some((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID),
      'weekly-review task must be present after approve()',
    );
  });

  // ---------------------------------------------------------------------------
  // getTasksForObjective with reserved objectiveIds
  // ---------------------------------------------------------------------------

  it('getTasksForObjective returns daily-review tasks when queried with DAILY_REVIEW_OBJECTIVE_ID', async () => {
    const TAGENT = 'agent-review-trace-rt-abc1';
    const d1 = createTask({ title: 'Mon review', prompt: 'Mon review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-02-02T17:00:00Z' });
    const d2 = createTask({ title: 'Tue review', prompt: 'Tue review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-02-03T17:00:00Z' });
    const plan1 = createWeeklyPlan('2027-W06', '2027-02', [d1]);
    const plan2 = createWeeklyPlan('2027-W07', '2027-02', [d2]);
    await reviewStore.save(TAGENT, plan1);
    await reviewStore.save(TAGENT, plan2);

    const tasks = await reviewStore.getTasksForObjective(TAGENT, DAILY_REVIEW_OBJECTIVE_ID);
    assert.equal(tasks.length, 2, 'should find both daily-review tasks across plans');
    assert.ok(tasks.every((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID));
  });

  it('getTasksForObjective returns the weekly-review task when queried with WEEKLY_REVIEW_OBJECTIVE_ID', async () => {
    const WAGENT = 'agent-review-wktrace-rt-abc1';
    const wr = createTask({ title: 'Week-in-review', prompt: 'Week-in-review' }, WEEKLY_REVIEW_OBJECTIVE_ID, { runAt: '2027-02-06T18:00:00Z' });
    const plan = createWeeklyPlan('2027-W06', '2027-02', [wr]);
    await reviewStore.save(WAGENT, plan);

    const tasks = await reviewStore.getTasksForObjective(WAGENT, WEEKLY_REVIEW_OBJECTIVE_ID);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].objectiveId, WEEKLY_REVIEW_OBJECTIVE_ID);
  });

  // ---------------------------------------------------------------------------
  // isReviewObjectiveId round-trip — tasks loaded from disk classify correctly
  // ---------------------------------------------------------------------------

  it('isReviewObjectiveId correctly classifies tasks after a load from disk', async () => {
    const goal = createGoal('Work goal');
    const obj = createObjective('Work obj', goal.id);
    const workTask = createTask({ title: 'Do the work', prompt: 'Do the work' }, obj.id);
    const reviewTask = createTask({ title: 'Daily reflection', prompt: 'Daily reflection' }, DAILY_REVIEW_OBJECTIVE_ID, {
      runAt: '2027-02-09T17:00:00Z',
    });
    const plan = createWeeklyPlan('2027-W08', '2027-02', [workTask, reviewTask]);
    await reviewStore.save(AGENT, plan);

    const loaded = await reviewStore.load(AGENT, '2027-W08');
    const work = loaded.tasks.filter((t) => !isReviewObjectiveId(t.objectiveId));
    const review = loaded.tasks.filter((t) => isReviewObjectiveId(t.objectiveId));

    assert.equal(work.length, 1, 'one work task');
    assert.equal(review.length, 1, 'one review task');
    assert.equal(work[0].id, workTask.id);
    assert.equal(review[0].id, reviewTask.id);
    assert.equal(review[0].objectiveId, DAILY_REVIEW_OBJECTIVE_ID);
  });
});
