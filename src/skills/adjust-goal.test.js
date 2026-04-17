/**
 * Tests for adjust-goal skill logic.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../storage/agent-store.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
  addGoal,
} from '../models/agent.js';
import {
  validateGoalAdjustment,
  validateMonthlyAdjustment,
  validateWeeklyAdjustment,
  applyGoalAdjustment,
  applyMonthlyAdjustment,
  applyWeeklyAdjustment,
  adjustGoals,
  formatAdjustmentSummary,
} from './adjust-goal.js';

/** Build a full agent config with goals, monthly plan, and weekly plan for testing. */
function buildTestAgent() {
  const config = createAgentConfig({
    name: 'Test Agent',
    role: 'Test role',
    systemPrompt: 'You are a test agent.',
    weeklyTokenLimit: 100_000,
  });

  const goal1 = createGoal('Improve code quality', '3mo');
  const goal2 = createGoal('Write documentation', '1mo');
  addGoal(config, goal1);
  addGoal(config, goal2);

  const obj1 = createObjective('Refactor module A', goal1.id);
  const obj2 = createObjective('Write API docs', goal2.id);
  const monthlyPlan = createMonthlyPlan('2026-04', [obj1, obj2]);
  config.monthlyPlans.push(monthlyPlan);

  const task1 = createTask('Refactor utils.js', obj1.id);
  const task2 = createTask('Draft API overview', obj2.id);
  const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task1, task2]);
  config.weeklyPlans.push(weeklyPlan);

  return { config, goal1, goal2, obj1, obj2, task1, task2 };
}

// ---------------------------------------------------------------------------
// validateGoalAdjustment
// ---------------------------------------------------------------------------
describe('validateGoalAdjustment', () => {
  it('validates a valid add operation', () => {
    const { config } = buildTestAgent();
    const result = validateGoalAdjustment(
      { action: 'add', description: 'New goal', horizon: '1yr' },
      config
    );
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects add without description', () => {
    const { config } = buildTestAgent();
    const result = validateGoalAdjustment(
      { action: 'add', horizon: '1mo' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('description')));
  });

  it('rejects add with invalid horizon', () => {
    const { config } = buildTestAgent();
    const result = validateGoalAdjustment(
      { action: 'add', description: 'New goal', horizon: '2yr' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('horizon')));
  });

  it('validates a valid update operation', () => {
    const { config, goal1 } = buildTestAgent();
    const result = validateGoalAdjustment(
      { action: 'update', goalId: goal1.id, status: 'completed' },
      config
    );
    assert.equal(result.valid, true);
  });

  it('rejects update with nonexistent goalId', () => {
    const { config } = buildTestAgent();
    const result = validateGoalAdjustment(
      { action: 'update', goalId: 'goal-nonexistent', status: 'active' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('not found')));
  });

  it('rejects update with no fields to change', () => {
    const { config, goal1 } = buildTestAgent();
    const result = validateGoalAdjustment(
      { action: 'update', goalId: goal1.id },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('At least one field')));
  });

  it('validates a valid remove operation', () => {
    const { config, goal1 } = buildTestAgent();
    const result = validateGoalAdjustment(
      { action: 'remove', goalId: goal1.id },
      config
    );
    assert.equal(result.valid, true);
  });

  it('rejects remove with nonexistent goalId', () => {
    const { config } = buildTestAgent();
    const result = validateGoalAdjustment(
      { action: 'remove', goalId: 'goal-nonexistent' },
      config
    );
    assert.equal(result.valid, false);
  });

  it('rejects invalid action', () => {
    const { config } = buildTestAgent();
    const result = validateGoalAdjustment({ action: 'destroy' }, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('action')));
  });

  it('rejects non-object input', () => {
    const { config } = buildTestAgent();
    const result = validateGoalAdjustment(null, config);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// validateMonthlyAdjustment
// ---------------------------------------------------------------------------
describe('validateMonthlyAdjustment', () => {
  it('validates a valid add objective', () => {
    const { config, goal1 } = buildTestAgent();
    const result = validateMonthlyAdjustment(
      { action: 'add', month: '2026-04', description: 'New objective', goalId: goal1.id },
      config
    );
    assert.equal(result.valid, true);
  });

  it('rejects add with missing goalId', () => {
    const { config } = buildTestAgent();
    const result = validateMonthlyAdjustment(
      { action: 'add', month: '2026-04', description: 'New objective' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('goalId')));
  });

  it('rejects add with nonexistent goalId', () => {
    const { config } = buildTestAgent();
    const result = validateMonthlyAdjustment(
      { action: 'add', month: '2026-04', description: 'Obj', goalId: 'goal-nonexistent' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Goal not found')));
  });

  it('rejects when monthly plan does not exist', () => {
    const { config } = buildTestAgent();
    const result = validateMonthlyAdjustment(
      { action: 'add', month: '2025-01', description: 'Obj', goalId: 'goal-x' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('No monthly plan')));
  });

  it('validates a valid update objective', () => {
    const { config, obj1 } = buildTestAgent();
    const result = validateMonthlyAdjustment(
      { action: 'update', month: '2026-04', objectiveId: obj1.id, status: 'in-progress' },
      config
    );
    assert.equal(result.valid, true);
  });

  it('rejects update with nonexistent objectiveId', () => {
    const { config } = buildTestAgent();
    const result = validateMonthlyAdjustment(
      { action: 'update', month: '2026-04', objectiveId: 'obj-nonexistent', status: 'completed' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Objective not found')));
  });

  it('rejects invalid month format', () => {
    const { config } = buildTestAgent();
    const result = validateMonthlyAdjustment(
      { action: 'add', month: 'April', description: 'Obj', goalId: 'goal-x' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('YYYY-MM')));
  });
});

// ---------------------------------------------------------------------------
// validateWeeklyAdjustment
// ---------------------------------------------------------------------------
describe('validateWeeklyAdjustment', () => {
  it('validates a valid add task', () => {
    const { config, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'add', week: '2026-W16', description: 'New task', objectiveId: obj1.id },
      config
    );
    assert.equal(result.valid, true);
  });

  it('rejects add with nonexistent objectiveId', () => {
    const { config } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'add', week: '2026-W16', description: 'Task', objectiveId: 'obj-nonexistent' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Objective not found')));
  });

  it('rejects when weekly plan does not exist', () => {
    const { config } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'add', week: '2026-W99', description: 'Task', objectiveId: 'obj-x' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('No weekly plan')));
  });

  it('validates a valid update task', () => {
    const { config, task1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'update', week: '2026-W16', taskId: task1.id, status: 'in-progress' },
      config
    );
    assert.equal(result.valid, true);
  });

  it('rejects update with nonexistent taskId', () => {
    const { config } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'update', week: '2026-W16', taskId: 'task-nonexistent', status: 'completed' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Task not found')));
  });

  it('rejects invalid week format', () => {
    const { config } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'add', week: 'week16', description: 'Task', objectiveId: 'obj-x' },
      config
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('YYYY-Www')));
  });
});

// ---------------------------------------------------------------------------
// applyGoalAdjustment
// ---------------------------------------------------------------------------
describe('applyGoalAdjustment', () => {
  it('adds a goal', () => {
    const { config } = buildTestAgent();
    const before = config.goals.length;
    const r = applyGoalAdjustment(config, { action: 'add', description: 'Ship v2', horizon: '1yr' });
    assert.equal(r.applied, true);
    assert.equal(config.goals.length, before + 1);
    assert.equal(r.result.description, 'Ship v2');
    assert.equal(r.result.horizon, '1yr');
  });

  it('updates a goal description and horizon', () => {
    const { config, goal1 } = buildTestAgent();
    const r = applyGoalAdjustment(config, {
      action: 'update',
      goalId: goal1.id,
      description: 'Updated desc',
      horizon: '1yr',
    });
    assert.equal(r.applied, true);
    assert.equal(r.result.description, 'Updated desc');
    assert.equal(r.result.horizon, '1yr');
  });

  it('updates a goal status to completed', () => {
    const { config, goal1 } = buildTestAgent();
    const r = applyGoalAdjustment(config, {
      action: 'update',
      goalId: goal1.id,
      status: 'completed',
    });
    assert.equal(r.applied, true);
    assert.equal(r.result.status, 'completed');
    assert.ok(r.result.completedAt);
  });

  it('removes a goal', () => {
    const { config, goal1 } = buildTestAgent();
    const before = config.goals.length;
    const r = applyGoalAdjustment(config, { action: 'remove', goalId: goal1.id });
    assert.equal(r.applied, true);
    assert.equal(config.goals.length, before - 1);
    assert.equal(r.result.removed, true);
  });

  it('fails to remove nonexistent goal', () => {
    const { config } = buildTestAgent();
    const r = applyGoalAdjustment(config, { action: 'remove', goalId: 'goal-nonexistent' });
    assert.equal(r.applied, false);
    assert.ok(r.error);
  });
});

// ---------------------------------------------------------------------------
// applyMonthlyAdjustment
// ---------------------------------------------------------------------------
describe('applyMonthlyAdjustment', () => {
  it('adds an objective to a monthly plan', () => {
    const { config, goal1 } = buildTestAgent();
    const before = config.monthlyPlans[0].objectives.length;
    const r = applyMonthlyAdjustment(config, {
      action: 'add',
      month: '2026-04',
      description: 'New obj',
      goalId: goal1.id,
    });
    assert.equal(r.applied, true);
    assert.equal(config.monthlyPlans[0].objectives.length, before + 1);
    assert.ok(r.result.id.startsWith('obj-'));
  });

  it('updates an objective status', () => {
    const { config, obj1 } = buildTestAgent();
    const r = applyMonthlyAdjustment(config, {
      action: 'update',
      month: '2026-04',
      objectiveId: obj1.id,
      status: 'completed',
    });
    assert.equal(r.applied, true);
    assert.equal(r.result.status, 'completed');
  });

  it('updates an objective description', () => {
    const { config, obj1 } = buildTestAgent();
    const r = applyMonthlyAdjustment(config, {
      action: 'update',
      month: '2026-04',
      objectiveId: obj1.id,
      description: 'Revised objective',
    });
    assert.equal(r.applied, true);
    assert.equal(r.result.description, 'Revised objective');
  });

  it('fails for nonexistent month', () => {
    const { config, goal1 } = buildTestAgent();
    const r = applyMonthlyAdjustment(config, {
      action: 'add',
      month: '2025-01',
      description: 'Obj',
      goalId: goal1.id,
    });
    assert.equal(r.applied, false);
    assert.ok(r.error);
  });
});

// ---------------------------------------------------------------------------
// applyWeeklyAdjustment
// ---------------------------------------------------------------------------
describe('applyWeeklyAdjustment', () => {
  it('adds a task to a weekly plan', () => {
    const { config, obj1 } = buildTestAgent();
    const before = config.weeklyPlans[0].tasks.length;
    const r = applyWeeklyAdjustment(config, {
      action: 'add',
      week: '2026-W16',
      description: 'New task',
      objectiveId: obj1.id,
    });
    assert.equal(r.applied, true);
    assert.equal(config.weeklyPlans[0].tasks.length, before + 1);
    assert.ok(r.result.id.startsWith('task-'));
  });

  it('updates a task status to completed', () => {
    const { config, task1 } = buildTestAgent();
    const r = applyWeeklyAdjustment(config, {
      action: 'update',
      week: '2026-W16',
      taskId: task1.id,
      status: 'completed',
    });
    assert.equal(r.applied, true);
    assert.equal(r.result.status, 'completed');
    assert.ok(r.result.completedAt);
  });

  it('updates a task description', () => {
    const { config, task1 } = buildTestAgent();
    const r = applyWeeklyAdjustment(config, {
      action: 'update',
      week: '2026-W16',
      taskId: task1.id,
      description: 'Revised task',
    });
    assert.equal(r.applied, true);
    assert.equal(r.result.description, 'Revised task');
  });

  it('fails for nonexistent week', () => {
    const { config, obj1 } = buildTestAgent();
    const r = applyWeeklyAdjustment(config, {
      action: 'add',
      week: '2026-W99',
      description: 'Task',
      objectiveId: obj1.id,
    });
    assert.equal(r.applied, false);
    assert.ok(r.error);
  });
});

// ---------------------------------------------------------------------------
// adjustGoals (integration with persistence)
// ---------------------------------------------------------------------------
describe('adjustGoals', () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-adjust-goal-'));
    store = new AgentStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function saveTestAgent() {
    const { config, goal1, goal2, obj1, obj2, task1, task2 } = buildTestAgent();
    await store.save(config);
    return { config, goal1, goal2, obj1, obj2, task1, task2 };
  }

  it('adds a goal and persists', async () => {
    const { config } = await saveTestAgent();
    const result = await adjustGoals({
      agentId: config.id,
      goalAdjustments: [{ action: 'add', description: 'Launch beta', horizon: '1yr' }],
      dataDir: tmpDir,
    });
    assert.equal(result.success, true);
    assert.equal(result.results.goals.length, 1);
    assert.equal(result.results.goals[0].applied, true);

    // Verify persistence
    const reloaded = await store.load(config.id);
    assert.equal(reloaded.goals.length, 3);
  });

  it('removes a goal and persists', async () => {
    const { config, goal1 } = await saveTestAgent();
    const result = await adjustGoals({
      agentId: config.id,
      goalAdjustments: [{ action: 'remove', goalId: goal1.id }],
      dataDir: tmpDir,
    });
    assert.equal(result.success, true);

    const reloaded = await store.load(config.id);
    assert.equal(reloaded.goals.length, 1);
    assert.ok(!reloaded.goals.find((g) => g.id === goal1.id));
  });

  it('adds a monthly objective and persists', async () => {
    const { config, goal1 } = await saveTestAgent();
    const result = await adjustGoals({
      agentId: config.id,
      monthlyAdjustments: [
        { action: 'add', month: '2026-04', description: 'Extra objective', goalId: goal1.id },
      ],
      dataDir: tmpDir,
    });
    assert.equal(result.success, true);

    const reloaded = await store.load(config.id);
    assert.equal(reloaded.monthlyPlans[0].objectives.length, 3);
  });

  it('adds a weekly task and persists', async () => {
    const { config, obj1 } = await saveTestAgent();
    const result = await adjustGoals({
      agentId: config.id,
      weeklyAdjustments: [
        { action: 'add', week: '2026-W16', description: 'Extra task', objectiveId: obj1.id },
      ],
      dataDir: tmpDir,
    });
    assert.equal(result.success, true);

    const reloaded = await store.load(config.id);
    assert.equal(reloaded.weeklyPlans[0].tasks.length, 3);
  });

  it('applies multiple adjustments atomically', async () => {
    const { config, goal1, obj1 } = await saveTestAgent();
    const result = await adjustGoals({
      agentId: config.id,
      goalAdjustments: [{ action: 'add', description: 'New strategic goal', horizon: '1yr' }],
      monthlyAdjustments: [
        { action: 'update', month: '2026-04', objectiveId: obj1.id, status: 'in-progress' },
      ],
      weeklyAdjustments: [
        { action: 'add', week: '2026-W16', description: 'Another task', objectiveId: obj1.id },
      ],
      dataDir: tmpDir,
    });
    assert.equal(result.success, true);
    assert.equal(result.results.goals.length, 1);
    assert.equal(result.results.monthly.length, 1);
    assert.equal(result.results.weekly.length, 1);
  });

  it('fails when agent not found', async () => {
    const result = await adjustGoals({
      agentId: 'agent-nonexistent',
      goalAdjustments: [{ action: 'add', description: 'Goal', horizon: '1mo' }],
      dataDir: tmpDir,
    });
    assert.equal(result.success, false);
    assert.ok(result.errors.some((e) => e.includes('Agent not found')));
  });

  it('fails with no adjustments', async () => {
    const { config } = await saveTestAgent();
    const result = await adjustGoals({
      agentId: config.id,
      dataDir: tmpDir,
    });
    assert.equal(result.success, false);
    assert.ok(result.errors.some((e) => e.includes('At least one adjustment')));
  });

  it('rejects all adjustments if any validation fails', async () => {
    const { config, goal1 } = await saveTestAgent();
    const goalsBefore = config.goals.length;

    const result = await adjustGoals({
      agentId: config.id,
      goalAdjustments: [
        { action: 'add', description: 'Valid goal', horizon: '1mo' },
        { action: 'remove', goalId: 'goal-nonexistent' }, // invalid
      ],
      dataDir: tmpDir,
    });
    assert.equal(result.success, false);

    // Verify nothing was persisted
    const reloaded = await store.load(config.id);
    assert.equal(reloaded.goals.length, goalsBefore);
  });

  it('is idempotent for status updates', async () => {
    const { config, goal1 } = await saveTestAgent();
    const args = {
      agentId: config.id,
      goalAdjustments: [{ action: 'update', goalId: goal1.id, status: 'paused' }],
      dataDir: tmpDir,
    };

    const r1 = await adjustGoals(args);
    assert.equal(r1.success, true);

    const r2 = await adjustGoals(args);
    assert.equal(r2.success, true);

    const reloaded = await store.load(config.id);
    const goal = reloaded.goals.find((g) => g.id === goal1.id);
    assert.equal(goal.status, 'paused');
  });
});

// ---------------------------------------------------------------------------
// formatAdjustmentSummary
// ---------------------------------------------------------------------------
describe('formatAdjustmentSummary', () => {
  it('formats goal additions', () => {
    const summary = formatAdjustmentSummary({
      goals: [{ applied: true, result: { id: 'goal-abc', description: 'Ship v2' } }],
      monthly: [],
      weekly: [],
    });
    assert.ok(summary.includes('Goal adjustments applied'));
    assert.ok(summary.includes('goal-abc'));
    assert.ok(summary.includes('Ship v2'));
  });

  it('formats removals', () => {
    const summary = formatAdjustmentSummary({
      goals: [{ applied: true, result: { goalId: 'goal-abc', removed: true } }],
      monthly: [],
      weekly: [],
    });
    assert.ok(summary.includes('Removed'));
    assert.ok(summary.includes('goal-abc'));
  });

  it('formats mixed adjustments', () => {
    const summary = formatAdjustmentSummary({
      goals: [{ applied: true, result: { id: 'goal-x', description: 'G' } }],
      monthly: [{ applied: true, result: { id: 'obj-y', description: 'O' } }],
      weekly: [{ applied: true, result: { id: 'task-z', description: 'T' } }],
    });
    assert.ok(summary.includes('Goals: 1 change'));
    assert.ok(summary.includes('Monthly objectives: 1 change'));
    assert.ok(summary.includes('Weekly tasks: 1 change'));
  });
});
