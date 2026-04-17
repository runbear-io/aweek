/**
 * Tests for agent model builder — goals and monthly plan management helpers.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
  createInboxMessage,
  getMondayISO,
  // Goal helpers
  addGoal,
  updateGoalStatus,
  removeGoal,
  getGoalsByHorizon,
  getActiveGoals,
  // Monthly plan helpers
  addMonthlyPlan,
  getMonthlyPlan,
  getActiveMonthlyPlan,
  updateMonthlyPlanStatus,
  updateObjectiveStatus,
  getObjectivesForGoal,
  addObjectiveToMonthlyPlan,
} from './agent.js';
import { validateAgentConfig } from '../schemas/validator.js';

/** Helper: create a fully populated agent config for testing */
function makeTestAgent() {
  const config = createAgentConfig({
    name: 'TestBot',
    role: 'Test agent for unit tests',
    systemPrompt: 'You are a test agent.',
  });
  const g1 = createGoal('Short-term goal', '1mo');
  const g2 = createGoal('Medium-term goal', '3mo');
  const g3 = createGoal('Long-term goal', '1yr');
  config.goals.push(g1, g2, g3);

  const obj1 = createObjective('Objective for short-term', g1.id);
  const obj2 = createObjective('Objective for medium-term', g2.id);
  const plan = createMonthlyPlan('2026-04', [obj1, obj2]);
  config.monthlyPlans.push(plan);

  return { config, goals: [g1, g2, g3], objectives: [obj1, obj2], plan };
}

// ---------------------------------------------------------------------------
// Existing factory function tests
// ---------------------------------------------------------------------------

describe('agent model — factory functions', () => {
  it('createAgentConfig produces valid schema-conformant object', () => {
    const config = createAgentConfig({
      name: 'Alice',
      role: 'Research assistant',
      systemPrompt: 'You help with research.',
    });
    assert.ok(config.id.startsWith('agent-alice-'));
    assert.equal(config.identity.name, 'Alice');
    assert.deepStrictEqual(config.goals, []);
    assert.deepStrictEqual(config.monthlyPlans, []);
    assert.deepStrictEqual(config.weeklyPlans, []);
    assert.equal(config.budget.weeklyTokenLimit, 500_000);
    assert.equal(config.budget.paused, false);
  });

  it('createGoal defaults to 3mo horizon', () => {
    const g = createGoal('Some goal');
    assert.equal(g.horizon, '3mo');
    assert.equal(g.status, 'active');
    assert.ok(g.id.startsWith('goal-'));
  });

  it('createObjective references a goalId', () => {
    const obj = createObjective('Build X', 'goal-abc12345');
    assert.equal(obj.goalId, 'goal-abc12345');
    assert.equal(obj.status, 'planned');
  });

  it('createMonthlyPlan defaults to active status', () => {
    const goal = createGoal('G', '1mo');
    const obj = createObjective('O', goal.id);
    const plan = createMonthlyPlan('2026-04', [obj]);
    assert.equal(plan.status, 'active');
    assert.equal(plan.month, '2026-04');
    assert.equal(plan.objectives.length, 1);
  });

  it('createInboxMessage builds a pending message', () => {
    const msg = createInboxMessage('agent-x-1234', 'agent-y-5678', 'Do something');
    assert.ok(msg.id.startsWith('msg-'));
    assert.equal(msg.from, 'agent-x-1234');
    assert.equal(msg.to, 'agent-y-5678');
    assert.equal(msg.type, 'task-delegation');
    assert.equal(msg.priority, 'medium');
    assert.equal(msg.status, 'pending');
  });

  it('getMondayISO returns a Monday', () => {
    const iso = getMondayISO();
    const d = new Date(iso);
    // getUTCDay: 0=Sun, 1=Mon
    assert.equal(d.getUTCDay(), 1);
  });
});

// ---------------------------------------------------------------------------
// Goal management helpers
// ---------------------------------------------------------------------------

describe('agent model — goal management', () => {
  let config;

  beforeEach(() => {
    config = createAgentConfig({
      name: 'GoalBot',
      role: 'Goal tester',
      systemPrompt: 'Test goals.',
    });
  });

  describe('addGoal', () => {
    it('should add a goal to agent config', () => {
      const goal = createGoal('New goal', '1mo');
      const result = addGoal(config, goal);
      assert.equal(config.goals.length, 1);
      assert.equal(config.goals[0].id, goal.id);
      assert.equal(result, goal);
    });

    it('should update updatedAt timestamp', () => {
      const before = config.updatedAt;
      const goal = createGoal('Goal', '3mo');
      addGoal(config, goal);
      assert.ok(config.updatedAt >= before);
    });

    it('should produce a valid agent config after adding', () => {
      addGoal(config, createGoal('Valid goal', '1yr'));
      // Add a monthly plan so the config is fully populated
      const obj = createObjective('Obj', config.goals[0].id);
      config.monthlyPlans.push(createMonthlyPlan('2026-04', [obj]));
      const result = validateAgentConfig(config);
      assert.equal(result.valid, true);
    });
  });

  describe('updateGoalStatus', () => {
    it('should update status of an existing goal', () => {
      const goal = createGoal('Updatable goal', '3mo');
      addGoal(config, goal);
      const updated = updateGoalStatus(config, goal.id, 'paused');
      assert.equal(updated.status, 'paused');
      assert.equal(config.goals[0].status, 'paused');
    });

    it('should set completedAt when status is completed', () => {
      const goal = createGoal('Completable', '1mo');
      addGoal(config, goal);
      assert.equal(goal.completedAt, undefined);
      updateGoalStatus(config, goal.id, 'completed');
      assert.ok(config.goals[0].completedAt);
    });

    it('should return null for non-existent goal', () => {
      const result = updateGoalStatus(config, 'goal-nonexistent', 'paused');
      assert.equal(result, null);
    });

    it('should update agent updatedAt', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const before = config.updatedAt;
      updateGoalStatus(config, goal.id, 'dropped');
      assert.ok(config.updatedAt >= before);
    });
  });

  describe('removeGoal', () => {
    it('should remove an existing goal', () => {
      const goal = createGoal('Removable', '1yr');
      addGoal(config, goal);
      assert.equal(config.goals.length, 1);
      const removed = removeGoal(config, goal.id);
      assert.equal(removed, true);
      assert.equal(config.goals.length, 0);
    });

    it('should return false for non-existent goal', () => {
      assert.equal(removeGoal(config, 'goal-nope'), false);
    });

    it('should update updatedAt on removal', () => {
      const goal = createGoal('G', '1mo');
      addGoal(config, goal);
      const before = config.updatedAt;
      removeGoal(config, goal.id);
      assert.ok(config.updatedAt >= before);
    });
  });

  describe('getGoalsByHorizon', () => {
    it('should filter goals by horizon', () => {
      addGoal(config, createGoal('Short 1', '1mo'));
      addGoal(config, createGoal('Short 2', '1mo'));
      addGoal(config, createGoal('Medium', '3mo'));
      addGoal(config, createGoal('Long', '1yr'));

      assert.equal(getGoalsByHorizon(config, '1mo').length, 2);
      assert.equal(getGoalsByHorizon(config, '3mo').length, 1);
      assert.equal(getGoalsByHorizon(config, '1yr').length, 1);
    });

    it('should return empty array when no goals match', () => {
      addGoal(config, createGoal('Only short', '1mo'));
      assert.deepStrictEqual(getGoalsByHorizon(config, '1yr'), []);
    });
  });

  describe('getActiveGoals', () => {
    it('should return only active goals', () => {
      const g1 = createGoal('Active 1', '1mo');
      const g2 = createGoal('Active 2', '3mo');
      const g3 = createGoal('Will pause', '1yr');
      addGoal(config, g1);
      addGoal(config, g2);
      addGoal(config, g3);
      updateGoalStatus(config, g3.id, 'paused');

      const active = getActiveGoals(config);
      assert.equal(active.length, 2);
      assert.ok(active.every((g) => g.status === 'active'));
    });

    it('should return empty array when no active goals', () => {
      const g = createGoal('Done', '3mo');
      addGoal(config, g);
      updateGoalStatus(config, g.id, 'completed');
      assert.deepStrictEqual(getActiveGoals(config), []);
    });
  });
});

// ---------------------------------------------------------------------------
// Monthly plan management helpers
// ---------------------------------------------------------------------------

describe('agent model — monthly plan management', () => {
  let config;

  beforeEach(() => {
    config = createAgentConfig({
      name: 'PlanBot',
      role: 'Plan tester',
      systemPrompt: 'Test plans.',
    });
  });

  describe('addMonthlyPlan', () => {
    it('should add a monthly plan to agent config', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const obj = createObjective('O', goal.id);
      const plan = createMonthlyPlan('2026-04', [obj]);

      const result = addMonthlyPlan(config, plan);
      assert.equal(config.monthlyPlans.length, 1);
      assert.equal(config.monthlyPlans[0].month, '2026-04');
      assert.equal(result, plan);
    });

    it('should update updatedAt', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const before = config.updatedAt;
      addMonthlyPlan(config, createMonthlyPlan('2026-05', [createObjective('O', goal.id)]));
      assert.ok(config.updatedAt >= before);
    });
  });

  describe('getMonthlyPlan', () => {
    it('should find plan by month', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const obj = createObjective('O', goal.id);
      addMonthlyPlan(config, createMonthlyPlan('2026-04', [obj]));
      addMonthlyPlan(config, createMonthlyPlan('2026-05', [createObjective('O2', goal.id)]));

      const found = getMonthlyPlan(config, '2026-05');
      assert.equal(found.month, '2026-05');
    });

    it('should return undefined for non-existent month', () => {
      assert.equal(getMonthlyPlan(config, '2099-12'), undefined);
    });
  });

  describe('getActiveMonthlyPlan', () => {
    it('should return the active monthly plan', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const obj = createObjective('O', goal.id);
      addMonthlyPlan(config, createMonthlyPlan('2026-03', [obj], { status: 'archived' }));
      addMonthlyPlan(config, createMonthlyPlan('2026-04', [createObjective('O2', goal.id)]));

      const active = getActiveMonthlyPlan(config);
      assert.equal(active.month, '2026-04');
      assert.equal(active.status, 'active');
    });

    it('should return undefined when no active plan', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      addMonthlyPlan(config, createMonthlyPlan('2026-03', [createObjective('O', goal.id)], { status: 'completed' }));
      assert.equal(getActiveMonthlyPlan(config), undefined);
    });
  });

  describe('updateMonthlyPlanStatus', () => {
    it('should update plan status', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      addMonthlyPlan(config, createMonthlyPlan('2026-04', [createObjective('O', goal.id)]));

      const updated = updateMonthlyPlanStatus(config, '2026-04', 'completed');
      assert.equal(updated.status, 'completed');
      assert.equal(config.monthlyPlans[0].status, 'completed');
    });

    it('should return null for non-existent month', () => {
      assert.equal(updateMonthlyPlanStatus(config, '2099-01', 'archived'), null);
    });

    it('should update timestamps', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const plan = createMonthlyPlan('2026-04', [createObjective('O', goal.id)]);
      addMonthlyPlan(config, plan);
      const beforePlan = plan.updatedAt;
      const beforeConfig = config.updatedAt;

      updateMonthlyPlanStatus(config, '2026-04', 'archived');
      assert.ok(plan.updatedAt >= beforePlan);
      assert.ok(config.updatedAt >= beforeConfig);
    });
  });

  describe('updateObjectiveStatus', () => {
    it('should update objective status across plans', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const obj = createObjective('Updatable obj', goal.id);
      addMonthlyPlan(config, createMonthlyPlan('2026-04', [obj]));

      const updated = updateObjectiveStatus(config, obj.id, 'in-progress');
      assert.equal(updated.status, 'in-progress');
    });

    it('should set completedAt when status is completed', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const obj = createObjective('Complete me', goal.id);
      addMonthlyPlan(config, createMonthlyPlan('2026-04', [obj]));

      updateObjectiveStatus(config, obj.id, 'completed');
      assert.ok(obj.completedAt);
    });

    it('should return null for non-existent objective', () => {
      assert.equal(updateObjectiveStatus(config, 'obj-nope', 'dropped'), null);
    });
  });

  describe('getObjectivesForGoal', () => {
    it('should find objectives tracing back to a goal', () => {
      const { config: tc, goals, objectives } = makeTestAgent();
      const found = getObjectivesForGoal(tc, goals[0].id);
      assert.equal(found.length, 1);
      assert.equal(found[0].goalId, goals[0].id);
    });

    it('should find objectives across multiple monthly plans', () => {
      const goal = createGoal('Multi-plan goal', '3mo');
      addGoal(config, goal);
      const obj1 = createObjective('April obj', goal.id);
      const obj2 = createObjective('May obj', goal.id);
      addMonthlyPlan(config, createMonthlyPlan('2026-04', [obj1]));
      addMonthlyPlan(config, createMonthlyPlan('2026-05', [obj2]));

      const found = getObjectivesForGoal(config, goal.id);
      assert.equal(found.length, 2);
    });

    it('should return empty array when no objectives match', () => {
      const { config: tc } = makeTestAgent();
      assert.deepStrictEqual(getObjectivesForGoal(tc, 'goal-nonexistent'), []);
    });
  });

  describe('addObjectiveToMonthlyPlan', () => {
    it('should add objective to an existing plan', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      const obj1 = createObjective('First', goal.id);
      addMonthlyPlan(config, createMonthlyPlan('2026-04', [obj1]));

      const obj2 = createObjective('Second', goal.id);
      const result = addObjectiveToMonthlyPlan(config, '2026-04', obj2);
      assert.equal(result, obj2);
      assert.equal(config.monthlyPlans[0].objectives.length, 2);
    });

    it('should return null for non-existent plan month', () => {
      const goal = createGoal('G', '3mo');
      const obj = createObjective('Orphan', goal.id);
      assert.equal(addObjectiveToMonthlyPlan(config, '2099-01', obj), null);
    });

    it('should update timestamps', () => {
      const goal = createGoal('G', '3mo');
      addGoal(config, goal);
      addMonthlyPlan(config, createMonthlyPlan('2026-04', [createObjective('O', goal.id)]));
      const before = config.updatedAt;

      addObjectiveToMonthlyPlan(config, '2026-04', createObjective('New', goal.id));
      assert.ok(config.updatedAt >= before);
    });
  });
});

// ---------------------------------------------------------------------------
// Plan traceability integration
// ---------------------------------------------------------------------------

describe('agent model — plan traceability', () => {
  it('goals -> objectives -> tasks form a traceable chain', () => {
    const { config, goals, objectives } = makeTestAgent();

    // Add weekly plan with tasks tracing to objectives
    const task1 = createTask('Task for obj1', objectives[0].id);
    const task2 = createTask('Task for obj2', objectives[1].id);
    const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task1, task2]);
    config.weeklyPlans.push(weeklyPlan);

    // Verify traceability: task -> objective -> goal
    assert.equal(task1.objectiveId, objectives[0].id);
    assert.equal(objectives[0].goalId, goals[0].id);
    assert.equal(task2.objectiveId, objectives[1].id);
    assert.equal(objectives[1].goalId, goals[1].id);

    // Verify full config is schema-valid
    const result = validateAgentConfig(config);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('full agent with goals + monthly plan + weekly plan validates', () => {
    const { config, goals, objectives } = makeTestAgent();
    const task = createTask('Weekly task', objectives[0].id);
    config.weeklyPlans.push(createWeeklyPlan('2026-W16', '2026-04', [task]));

    const result = validateAgentConfig(config);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('getObjectivesForGoal returns correct traceability after mutations', () => {
    const config = createAgentConfig({
      name: 'TraceBot',
      role: 'Traceability tester',
      systemPrompt: 'Test traceability.',
    });
    const goal = createGoal('Traced goal', '3mo');
    addGoal(config, goal);

    const obj1 = createObjective('Month 4 work', goal.id);
    addMonthlyPlan(config, createMonthlyPlan('2026-04', [obj1]));

    // Add a second month with another objective for the same goal
    const obj2 = createObjective('Month 5 work', goal.id);
    addMonthlyPlan(config, createMonthlyPlan('2026-05', [obj2]));

    const traced = getObjectivesForGoal(config, goal.id);
    assert.equal(traced.length, 2);
    assert.ok(traced.some((o) => o.id === obj1.id));
    assert.ok(traced.some((o) => o.id === obj2.id));
  });
});
