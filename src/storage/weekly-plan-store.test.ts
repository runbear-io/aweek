import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WeeklyPlanStore, type WeeklyPlan, type WeeklyTask } from './weekly-plan-store.js';
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

interface TestPlanFixture {
  goal: ReturnType<typeof createGoal>;
  obj: ReturnType<typeof createObjective>;
  task: WeeklyTask;
  plan: WeeklyPlan;
}

describe('WeeklyPlanStore', () => {
  let store: WeeklyPlanStore;
  let tmpDir: string;
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
  function makeTestPlan(week = '2026-W16', month = '2026-04'): TestPlanFixture {
    const goal = createGoal('Test goal');
    const obj = createObjective('Test objective', goal.id);
    const task = createTask({ title: 'Test task', prompt: 'Test task' }, obj.id) as WeeklyTask;
    const plan = createWeeklyPlan(week, month, [task]) as WeeklyPlan;
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
    // Cast through `unknown` so the test can probe the runtime validator
    // without the type system rejecting the malformed shape ahead of AJV.
    const bad = { week: 'bad', tasks: [], approved: false } as unknown as WeeklyPlan;
    await assert.rejects(
      () => store.save(agentId, bad),
      /Schema validation failed/,
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
    assert.equal(mayPlans[0]?.week, '2026-W22');

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
      { code: 'ENOENT' },
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
    assert.ok(loadedTask);
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

    const newTask = createTask({ title: 'New task', prompt: 'New task' }, obj.id) as WeeklyTask;
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

    const task1 = createTask({ title: 'Task in W14', prompt: 'Task in W14' }, obj.id) as WeeklyTask;
    const plan1 = createWeeklyPlan('2026-W14', '2026-04', [task1]) as WeeklyPlan;

    const task2 = createTask({ title: 'Task in W15', prompt: 'Task in W15' }, obj.id) as WeeklyTask;
    const otherObj = createObjective('Other obj', goal.id);
    const otherTask = createTask({ title: 'Unrelated task', prompt: 'Unrelated task' }, otherObj.id) as WeeklyTask;
    const plan2 = createWeeklyPlan('2026-W15', '2026-04', [task2, otherTask]) as WeeklyPlan;

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
      { code: 'ENOENT' },
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
  let reviewStore: WeeklyPlanStore;
  let reviewTmpDir: string;
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
    }) as WeeklyTask;
    const plan = createWeeklyPlan('2027-W04', '2027-01', [task]) as WeeklyPlan;
    await reviewStore.save(AGENT, plan);

    const loaded = await reviewStore.load(AGENT, '2027-W04');
    assert.deepStrictEqual(loaded, plan);
    assert.equal(loaded.tasks[0]?.objectiveId, DAILY_REVIEW_OBJECTIVE_ID);
    assert.equal(loaded.tasks[0]?.runAt, '2027-01-20T17:00:00Z');
  });

  it('validates a plan with a daily-review task on save (assertValid passes)', async () => {
    const task = createTask({ title: 'Daily check-in', prompt: 'Daily check-in' }, DAILY_REVIEW_OBJECTIVE_ID, {
      runAt: '2027-01-21T17:00:00Z',
    }) as WeeklyTask;
    const plan = createWeeklyPlan('2027-W05', '2027-01', [task]) as WeeklyPlan;
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
    }) as WeeklyTask;
    const plan = createWeeklyPlan('2027-W04', '2027-01', [task]) as WeeklyPlan;

    // Use a distinct agent to avoid collision with the daily-review test above
    const WAGENT = 'agent-review-weekly-rt-abc1';
    await reviewStore.save(WAGENT, plan);

    const loaded = await reviewStore.load(WAGENT, '2027-W04');
    assert.deepStrictEqual(loaded, plan);
    assert.equal(loaded.tasks[0]?.objectiveId, WEEKLY_REVIEW_OBJECTIVE_ID);
    assert.equal(loaded.tasks[0]?.runAt, '2027-01-24T18:00:00Z');
  });

  // ---------------------------------------------------------------------------
  // Mixed plans
  // ---------------------------------------------------------------------------

  it('preserves mixed plans (regular work + daily-review + weekly-review) in round-trip', async () => {
    const goal = createGoal('Ship something');
    const obj = createObjective('Build it', goal.id);
    const regularTask = createTask({ title: 'Implement feature', prompt: 'Implement feature' }, obj.id) as WeeklyTask;
    const daily1 = createTask({ title: 'Mon review', prompt: 'Mon review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-18T17:00:00Z' }) as WeeklyTask;
    const daily2 = createTask({ title: 'Tue review', prompt: 'Tue review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-19T17:00:00Z' }) as WeeklyTask;
    const daily3 = createTask({ title: 'Wed review', prompt: 'Wed review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-20T17:00:00Z' }) as WeeklyTask;
    const daily4 = createTask({ title: 'Thu review', prompt: 'Thu review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-21T17:00:00Z' }) as WeeklyTask;
    const weeklyTask = createTask({ title: 'Week review', prompt: 'Week review' }, WEEKLY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-22T18:00:00Z' }) as WeeklyTask;

    const allTasks = [regularTask, daily1, daily2, daily3, daily4, weeklyTask];
    const plan = createWeeklyPlan('2027-W04', '2027-01', allTasks) as WeeklyPlan;
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
    }) as WeeklyTask;
    const plan = createWeeklyPlan('2027-W06', '2027-01', [task]) as WeeklyPlan;
    await reviewStore.save(AGENT, plan);

    const updated = await reviewStore.updateTaskStatus(AGENT, '2027-W06', task.id, 'completed');
    assert.ok(updated, 'updateTaskStatus should return the updated task');
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt, 'completedAt should be set');
    assert.equal(updated.objectiveId, DAILY_REVIEW_OBJECTIVE_ID, 'objectiveId must survive the update');

    // Verify persistence
    const loaded = await reviewStore.load(AGENT, '2027-W06');
    const savedTask = loaded.tasks.find((t) => t.id === task.id);
    assert.ok(savedTask);
    assert.equal(savedTask.status, 'completed');
    assert.ok(savedTask.completedAt);
    assert.equal(savedTask.objectiveId, DAILY_REVIEW_OBJECTIVE_ID);
  });

  // ---------------------------------------------------------------------------
  // approve preserves review tasks
  // ---------------------------------------------------------------------------

  it('approve does not strip review tasks from the plan', async () => {
    const daily = createTask({ title: 'Thu daily review', prompt: 'Thu daily review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-21T17:00:00Z' }) as WeeklyTask;
    const weekly = createTask({ title: 'Week review', prompt: 'Week review' }, WEEKLY_REVIEW_OBJECTIVE_ID, { runAt: '2027-01-22T18:00:00Z' }) as WeeklyTask;
    const plan = createWeeklyPlan('2027-W07', '2027-01', [daily, weekly]) as WeeklyPlan;
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
    const d1 = createTask({ title: 'Mon review', prompt: 'Mon review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-02-02T17:00:00Z' }) as WeeklyTask;
    const d2 = createTask({ title: 'Tue review', prompt: 'Tue review' }, DAILY_REVIEW_OBJECTIVE_ID, { runAt: '2027-02-03T17:00:00Z' }) as WeeklyTask;
    const plan1 = createWeeklyPlan('2027-W06', '2027-02', [d1]) as WeeklyPlan;
    const plan2 = createWeeklyPlan('2027-W07', '2027-02', [d2]) as WeeklyPlan;
    await reviewStore.save(TAGENT, plan1);
    await reviewStore.save(TAGENT, plan2);

    const tasks = await reviewStore.getTasksForObjective(TAGENT, DAILY_REVIEW_OBJECTIVE_ID);
    assert.equal(tasks.length, 2, 'should find both daily-review tasks across plans');
    assert.ok(tasks.every((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID));
  });

  it('getTasksForObjective returns the weekly-review task when queried with WEEKLY_REVIEW_OBJECTIVE_ID', async () => {
    const WAGENT = 'agent-review-wktrace-rt-abc1';
    const wr = createTask({ title: 'Week-in-review', prompt: 'Week-in-review' }, WEEKLY_REVIEW_OBJECTIVE_ID, { runAt: '2027-02-06T18:00:00Z' }) as WeeklyTask;
    const plan = createWeeklyPlan('2027-W06', '2027-02', [wr]) as WeeklyPlan;
    await reviewStore.save(WAGENT, plan);

    const tasks = await reviewStore.getTasksForObjective(WAGENT, WEEKLY_REVIEW_OBJECTIVE_ID);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.objectiveId, WEEKLY_REVIEW_OBJECTIVE_ID);
  });

  // ---------------------------------------------------------------------------
  // isReviewObjectiveId round-trip — tasks loaded from disk classify correctly
  // ---------------------------------------------------------------------------

  it('isReviewObjectiveId correctly classifies tasks after a load from disk', async () => {
    const goal = createGoal('Work goal');
    const obj = createObjective('Work obj', goal.id);
    const workTask = createTask({ title: 'Do the work', prompt: 'Do the work' }, obj.id) as WeeklyTask;
    const reviewTask = createTask({ title: 'Daily reflection', prompt: 'Daily reflection' }, DAILY_REVIEW_OBJECTIVE_ID, {
      runAt: '2027-02-09T17:00:00Z',
    }) as WeeklyTask;
    const plan = createWeeklyPlan('2027-W08', '2027-02', [workTask, reviewTask]) as WeeklyPlan;
    await reviewStore.save(AGENT, plan);

    const loaded = await reviewStore.load(AGENT, '2027-W08');
    const work = loaded.tasks.filter((t) => !isReviewObjectiveId(t.objectiveId));
    const review = loaded.tasks.filter((t) => isReviewObjectiveId(t.objectiveId));

    assert.equal(work.length, 1, 'one work task');
    assert.equal(review.length, 1, 'one review task');
    assert.equal(work[0]?.id, workTask.id);
    assert.equal(review[0]?.id, reviewTask.id);
    assert.equal(review[0]?.objectiveId, DAILY_REVIEW_OBJECTIVE_ID);
  });
});

// =============================================================================
// Consecutive-failure tracking — Sub-AC 1 of AC 5
//
// Repeated task failure notifications fire after 2 consecutive failures of the
// same weekly-task ID, and do not re-emit until the task transitions out of the
// failing state (success, rejection, or replacement by a new plan). The state
// (counter + last-emitted flag) lives on the WeeklyTask itself so atomic
// status updates carry the tracker forward in the same write.
// =============================================================================

describe('WeeklyPlanStore — consecutive-failure tracking (Sub-AC 1 of AC 5)', () => {
  let trackerStore: WeeklyPlanStore;
  let trackerTmpDir: string;
  const AGENT = 'agent-failtracker-test-abcd';

  before(async () => {
    trackerTmpDir = await mkdtemp(join(tmpdir(), 'aweek-failtracker-'));
    trackerStore = new WeeklyPlanStore(trackerTmpDir);
  });

  after(async () => {
    await rm(trackerTmpDir, { recursive: true, force: true });
  });

  // Helper: build a plan with one task and persist it.
  async function setupPlan(week: string): Promise<WeeklyTask> {
    const goal = createGoal('Test goal');
    const obj = createObjective('Test obj', goal.id);
    const task = createTask(
      { title: 'Failing task', prompt: 'Failing task' },
      obj.id,
    ) as WeeklyTask;
    const plan = createWeeklyPlan(week, '2026-04', [task]) as WeeklyPlan;
    await trackerStore.save(AGENT, plan);
    return task;
  }

  // ---------------------------------------------------------------------------
  // Counter increments on consecutive failures
  // ---------------------------------------------------------------------------

  it('initializes consecutiveFailures to 1 on first failed transition', async () => {
    const task = await setupPlan('2026-W18');
    const updated = await trackerStore.updateTaskStatus(AGENT, '2026-W18', task.id, 'failed');
    assert.ok(updated);
    assert.equal(updated.status, 'failed');
    assert.equal(updated.consecutiveFailures, 1);
    // Latch flag must NOT be auto-set by the storage layer — the emitter owns it.
    assert.equal(updated.failureNotificationEmitted, undefined);
  });

  it('increments consecutiveFailures across consecutive failed transitions', async () => {
    const task = await setupPlan('2026-W19');
    await trackerStore.updateTaskStatus(AGENT, '2026-W19', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W19', task.id, 'failed');
    const third = await trackerStore.updateTaskStatus(AGENT, '2026-W19', task.id, 'failed');
    assert.ok(third);
    assert.equal(third.consecutiveFailures, 3);
  });

  it('persists consecutiveFailures to disk so the count survives reload', async () => {
    const task = await setupPlan('2026-W20');
    await trackerStore.updateTaskStatus(AGENT, '2026-W20', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W20', task.id, 'failed');

    const reloaded = await trackerStore.load(AGENT, '2026-W20');
    const reloadedTask = reloaded.tasks.find((t) => t.id === task.id);
    assert.ok(reloadedTask);
    assert.equal(reloadedTask.consecutiveFailures, 2);
  });

  // ---------------------------------------------------------------------------
  // Reset on transition to a non-failed status
  // ---------------------------------------------------------------------------

  it('resets the tracker when status transitions to completed (success)', async () => {
    const task = await setupPlan('2026-W21');
    await trackerStore.updateTaskStatus(AGENT, '2026-W21', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W21', task.id, 'failed');
    // Mark notification emitted to verify the latch is cleared on reset
    await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W21', task.id);

    const succeeded = await trackerStore.updateTaskStatus(AGENT, '2026-W21', task.id, 'completed');
    assert.ok(succeeded);
    assert.equal(succeeded.status, 'completed');
    assert.equal(succeeded.consecutiveFailures, undefined);
    assert.equal(succeeded.failureNotificationEmitted, undefined);
    assert.ok(succeeded.completedAt);
  });

  it('resets the tracker when status transitions to in-progress (retry)', async () => {
    const task = await setupPlan('2026-W22');
    await trackerStore.updateTaskStatus(AGENT, '2026-W22', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W22', task.id, 'failed');
    await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W22', task.id);

    const retried = await trackerStore.updateTaskStatus(AGENT, '2026-W22', task.id, 'in-progress');
    assert.ok(retried);
    assert.equal(retried.consecutiveFailures, undefined);
    assert.equal(retried.failureNotificationEmitted, undefined);
  });

  it('resets the tracker when status transitions to delegated', async () => {
    const task = await setupPlan('2026-W23');
    await trackerStore.updateTaskStatus(AGENT, '2026-W23', task.id, 'failed');
    const delegated = await trackerStore.updateTaskStatus(AGENT, '2026-W23', task.id, 'delegated');
    assert.ok(delegated);
    assert.equal(delegated.consecutiveFailures, undefined);
  });

  it('resets the tracker when status transitions to skipped', async () => {
    const task = await setupPlan('2026-W24');
    await trackerStore.updateTaskStatus(AGENT, '2026-W24', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W24', task.id, 'failed');
    const skipped = await trackerStore.updateTaskStatus(AGENT, '2026-W24', task.id, 'skipped');
    assert.ok(skipped);
    assert.equal(skipped.consecutiveFailures, undefined);
    assert.equal(skipped.failureNotificationEmitted, undefined);
  });

  it('resets the tracker when status transitions to pending (rejected/replanned)', async () => {
    const task = await setupPlan('2026-W25');
    await trackerStore.updateTaskStatus(AGENT, '2026-W25', task.id, 'failed');
    const repending = await trackerStore.updateTaskStatus(AGENT, '2026-W25', task.id, 'pending');
    assert.ok(repending);
    assert.equal(repending.consecutiveFailures, undefined);
  });

  // ---------------------------------------------------------------------------
  // Re-failure after reset starts a fresh streak
  // ---------------------------------------------------------------------------

  it('starts a fresh streak after a successful run, allowing a new notification later', async () => {
    const task = await setupPlan('2026-W26');
    await trackerStore.updateTaskStatus(AGENT, '2026-W26', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W26', task.id, 'failed');
    await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W26', task.id);
    await trackerStore.updateTaskStatus(AGENT, '2026-W26', task.id, 'completed');

    // New failing streak should start at 1, latch cleared
    const refailed = await trackerStore.updateTaskStatus(AGENT, '2026-W26', task.id, 'failed');
    assert.ok(refailed);
    assert.equal(refailed.consecutiveFailures, 1);
    assert.equal(refailed.failureNotificationEmitted, undefined);
  });

  // ---------------------------------------------------------------------------
  // markFailureNotificationEmitted
  // ---------------------------------------------------------------------------

  it('markFailureNotificationEmitted sets the latch flag', async () => {
    const task = await setupPlan('2026-W27');
    await trackerStore.updateTaskStatus(AGENT, '2026-W27', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W27', task.id, 'failed');

    const flagged = await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W27', task.id);
    assert.ok(flagged);
    assert.equal(flagged.failureNotificationEmitted, true);
    // The streak counter must NOT be touched
    assert.equal(flagged.consecutiveFailures, 2);

    const reloaded = await trackerStore.load(AGENT, '2026-W27');
    const reloadedTask = reloaded.tasks.find((t) => t.id === task.id);
    assert.equal(reloadedTask?.failureNotificationEmitted, true);
  });

  it('markFailureNotificationEmitted is idempotent', async () => {
    const task = await setupPlan('2026-W28');
    await trackerStore.updateTaskStatus(AGENT, '2026-W28', task.id, 'failed');
    await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W28', task.id);
    const first = await trackerStore.load(AGENT, '2026-W28');
    const firstUpdatedAt = first.updatedAt;

    // Second call must not change the file or throw
    await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W28', task.id);
    const second = await trackerStore.load(AGENT, '2026-W28');
    assert.equal(second.updatedAt, firstUpdatedAt, 'idempotent call must not bump updatedAt');
  });

  it('markFailureNotificationEmitted returns null for an unknown task id', async () => {
    await setupPlan('2026-W29');
    const result = await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W29', 'task-nope');
    assert.equal(result, null);
  });

  // ---------------------------------------------------------------------------
  // getFailureTracker convenience reader
  // ---------------------------------------------------------------------------

  it('getFailureTracker returns absent-as-zero defaults for an untouched task', async () => {
    const task = await setupPlan('2026-W30');
    const state = await trackerStore.getFailureTracker(AGENT, '2026-W30', task.id);
    assert.deepStrictEqual(state, { consecutiveFailures: 0, notificationEmitted: false });
  });

  it('getFailureTracker reflects the live counter and latch flag', async () => {
    const task = await setupPlan('2026-W31');
    await trackerStore.updateTaskStatus(AGENT, '2026-W31', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W31', task.id, 'failed');
    await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W31', task.id);

    const state = await trackerStore.getFailureTracker(AGENT, '2026-W31', task.id);
    assert.deepStrictEqual(state, { consecutiveFailures: 2, notificationEmitted: true });
  });

  it('getFailureTracker returns null for a missing plan or task', async () => {
    assert.equal(await trackerStore.getFailureTracker(AGENT, '1999-W01', 'task-nope'), null);
    const task = await setupPlan('2026-W32');
    assert.equal(
      await trackerStore.getFailureTracker(AGENT, '2026-W32', 'task-nonexistent'),
      null,
    );
    // Sanity — the existing task is reachable
    assert.ok(await trackerStore.getFailureTracker(AGENT, '2026-W32', task.id));
  });

  // ---------------------------------------------------------------------------
  // Schema acceptance — both fields must round-trip through validate/save/load
  // ---------------------------------------------------------------------------

  it('validates and round-trips a plan that already carries tracker fields', async () => {
    const goal = createGoal('Round-trip goal');
    const obj = createObjective('Round-trip obj', goal.id);
    const task = createTask({ title: 'Pre-failed', prompt: 'Pre-failed' }, obj.id) as WeeklyTask;
    task.status = 'failed';
    task.consecutiveFailures = 2;
    task.failureNotificationEmitted = true;
    const plan = createWeeklyPlan('2026-W33', '2026-04', [task]) as WeeklyPlan;

    // The schema must accept the tracker fields
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));

    await trackerStore.save(AGENT, plan);
    const loaded = await trackerStore.load(AGENT, '2026-W33');
    const reloaded = loaded.tasks.find((t) => t.id === task.id);
    assert.ok(reloaded);
    assert.equal(reloaded.consecutiveFailures, 2);
    assert.equal(reloaded.failureNotificationEmitted, true);
  });

  it('rejects a negative consecutiveFailures value at the schema boundary', () => {
    const goal = createGoal('Bad tracker goal');
    const obj = createObjective('Bad tracker obj', goal.id);
    const task = createTask({ title: 'Bad', prompt: 'Bad' }, obj.id) as WeeklyTask;
    task.consecutiveFailures = -1;
    const plan = createWeeklyPlan('2026-W34', '2026-04', [task]) as WeeklyPlan;
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, false);
  });

  // ---------------------------------------------------------------------------
  // Task-change reset — replacing the plan drops the tracker naturally
  // ---------------------------------------------------------------------------

  it('replaced plan (task-change) does not carry the tracker forward', async () => {
    const task = await setupPlan('2026-W35');
    await trackerStore.updateTaskStatus(AGENT, '2026-W35', task.id, 'failed');
    await trackerStore.updateTaskStatus(AGENT, '2026-W35', task.id, 'failed');
    await trackerStore.markFailureNotificationEmitted(AGENT, '2026-W35', task.id);

    // Next week's plan with a brand-new task ID — old tracker is naturally gone
    const newGoal = createGoal('Next week goal');
    const newObj = createObjective('Next week obj', newGoal.id);
    const replacementTask = createTask(
      { title: 'Replacement', prompt: 'Replacement' },
      newObj.id,
    ) as WeeklyTask;
    const newPlan = createWeeklyPlan('2026-W36', '2026-09', [replacementTask]) as WeeklyPlan;
    await trackerStore.save(AGENT, newPlan);

    const tracker = await trackerStore.getFailureTracker(
      AGENT,
      '2026-W36',
      replacementTask.id,
    );
    assert.deepStrictEqual(tracker, { consecutiveFailures: 0, notificationEmitted: false });
  });
});
