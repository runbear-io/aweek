/**
 * Tests for weekly plan generation service.
 * Covers:
 *  - Input validation (bad week/month format, missing data)
 *  - Objective filtering (eligible statuses, active goal gating)
 *  - Task generation (default tasks, custom overrides, priority mapping)
 *  - Plan traceability (tasks -> objectives -> goals chain)
 *  - Schema validity of generated plans
 *  - Edge cases (no objectives, all skipped, empty goals)
 *  - generateAndSaveWeeklyPlan integration
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generateWeeklyPlan,
  generateAndSaveWeeklyPlan,
  filterEligibleObjectives,
  filterActiveGoals,
  defaultPriorityForObjective,
  generateTasksForObjective,
} from './weekly-plan-generator.js';
import {
  createGoal,
  createObjective,
  createMonthlyPlan,
} from '../models/agent.js';
import { validateWeeklyPlan } from '../schemas/validator.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a standard test fixture: 2 active goals, 1 completed goal, monthly plan with 3 objectives */
function buildFixture() {
  const goalA = createGoal('Build REST API', '1mo');
  const goalB = createGoal('Write documentation', '3mo');
  const goalC = createGoal('Old goal', '1yr');
  goalC.status = 'completed';

  const obj1 = createObjective('Implement endpoints', goalA.id);
  // planned (default)
  const obj2 = createObjective('Write API docs', goalB.id);
  obj2.status = 'in-progress';
  const obj3 = createObjective('Legacy cleanup', goalC.id);
  obj3.status = 'completed';

  const monthlyPlan = createMonthlyPlan('2026-04', [obj1, obj2, obj3]);

  return {
    goals: [goalA, goalB, goalC],
    monthlyPlan,
    goalA,
    goalB,
    goalC,
    obj1,
    obj2,
    obj3,
  };
}

// ---------------------------------------------------------------------------
// filterEligibleObjectives
// ---------------------------------------------------------------------------

describe('filterEligibleObjectives', () => {
  it('keeps planned and in-progress objectives', () => {
    const objs = [
      { id: 'obj-a', status: 'planned' },
      { id: 'obj-b', status: 'in-progress' },
      { id: 'obj-c', status: 'completed' },
      { id: 'obj-d', status: 'dropped' },
    ];
    const result = filterEligibleObjectives(objs);
    assert.equal(result.length, 2);
    assert.deepStrictEqual(result.map((o) => o.id), ['obj-a', 'obj-b']);
  });

  it('returns empty array when no objectives are eligible', () => {
    const objs = [
      { id: 'obj-a', status: 'completed' },
      { id: 'obj-b', status: 'dropped' },
    ];
    assert.equal(filterEligibleObjectives(objs).length, 0);
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(filterEligibleObjectives([]), []);
  });
});

// ---------------------------------------------------------------------------
// filterActiveGoals
// ---------------------------------------------------------------------------

describe('filterActiveGoals', () => {
  it('keeps only active goals', () => {
    const goals = [
      { id: 'g1', status: 'active' },
      { id: 'g2', status: 'completed' },
      { id: 'g3', status: 'paused' },
      { id: 'g4', status: 'active' },
    ];
    const result = filterActiveGoals(goals);
    assert.equal(result.length, 2);
    assert.deepStrictEqual(result.map((g) => g.id), ['g1', 'g4']);
  });
});

// ---------------------------------------------------------------------------
// defaultPriorityForObjective
// ---------------------------------------------------------------------------

describe('defaultPriorityForObjective', () => {
  it('returns high for in-progress objectives', () => {
    assert.equal(defaultPriorityForObjective({ status: 'in-progress' }), 'high');
  });

  it('returns medium for planned objectives', () => {
    assert.equal(defaultPriorityForObjective({ status: 'planned' }), 'medium');
  });

  it('returns medium for unknown statuses', () => {
    assert.equal(defaultPriorityForObjective({ status: 'other' }), 'medium');
  });
});

// ---------------------------------------------------------------------------
// generateTasksForObjective
// ---------------------------------------------------------------------------

describe('generateTasksForObjective', () => {
  it('generates one default task from objective description', () => {
    const obj = createObjective('Build login page', 'goal-abc12345');
    const tasks = generateTasksForObjective(obj);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].description, 'Build login page');
    assert.equal(tasks[0].objectiveId, obj.id);
    assert.equal(tasks[0].priority, 'medium'); // planned -> medium
    assert.equal(tasks[0].status, 'pending');
  });

  it('uses high priority for in-progress objectives', () => {
    const obj = createObjective('Active work', 'goal-abc12345');
    obj.status = 'in-progress';
    const tasks = generateTasksForObjective(obj);
    assert.equal(tasks[0].priority, 'high');
  });

  it('generates custom tasks from taskDescriptors', () => {
    const obj = createObjective('Build API', 'goal-abc12345');
    const tasks = generateTasksForObjective(obj, {
      taskDescriptors: [
        { description: 'Design schema', priority: 'critical', estimatedMinutes: 60 },
        { description: 'Write routes', estimatedMinutes: 120 },
      ],
    });
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].description, 'Design schema');
    assert.equal(tasks[0].priority, 'critical');
    assert.equal(tasks[0].estimatedMinutes, 60);
    assert.equal(tasks[0].objectiveId, obj.id);
    assert.equal(tasks[1].description, 'Write routes');
    assert.equal(tasks[1].priority, 'medium'); // defaults from objective
    assert.equal(tasks[1].estimatedMinutes, 120);
  });

  it('ignores empty taskDescriptors and falls back to default', () => {
    const obj = createObjective('Fallback', 'goal-abc12345');
    const tasks = generateTasksForObjective(obj, { taskDescriptors: [] });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].description, 'Fallback');
  });

  it('all generated tasks have valid IDs', () => {
    const obj = createObjective('Check IDs', 'goal-abc12345');
    const tasks = generateTasksForObjective(obj, {
      taskDescriptors: [{ description: 'A' }, { description: 'B' }, { description: 'C' }],
    });
    for (const t of tasks) {
      assert.match(t.id, /^task-[a-z0-9]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — input validation
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — input validation', () => {
  const { goals, monthlyPlan } = buildFixture();

  it('throws on invalid week format', () => {
    assert.throws(
      () => generateWeeklyPlan({ week: '2026-16', month: '2026-04', goals, monthlyPlan }),
      /Invalid week format/,
    );
  });

  it('throws on missing week', () => {
    assert.throws(
      () => generateWeeklyPlan({ week: '', month: '2026-04', goals, monthlyPlan }),
      /Invalid week format/,
    );
  });

  it('throws on invalid month format', () => {
    assert.throws(
      () => generateWeeklyPlan({ week: '2026-W16', month: '2026/04', goals, monthlyPlan }),
      /Invalid month format/,
    );
  });

  it('throws on missing monthlyPlan', () => {
    assert.throws(
      () => generateWeeklyPlan({ week: '2026-W16', month: '2026-04', goals, monthlyPlan: null }),
      /monthlyPlan must have an objectives array/,
    );
  });

  it('throws on missing goals', () => {
    assert.throws(
      () => generateWeeklyPlan({ week: '2026-W16', month: '2026-04', goals: null, monthlyPlan }),
      /goals must be an array/,
    );
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — objective filtering
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — objective filtering', () => {
  it('skips completed objectives', () => {
    const { goals, monthlyPlan, obj3 } = buildFixture();
    const { meta } = generateWeeklyPlan({ week: '2026-W16', month: '2026-04', goals, monthlyPlan });
    const skippedIds = meta.skippedReasons.map((r) => r.objectiveId);
    assert.ok(skippedIds.includes(obj3.id));
  });

  it('skips objectives whose parent goal is not active (requireActiveGoal=true)', () => {
    const goalActive = createGoal('Active', '1mo');
    const goalPaused = createGoal('Paused', '3mo');
    goalPaused.status = 'paused';

    const obj1 = createObjective('From active goal', goalActive.id);
    const obj2 = createObjective('From paused goal', goalPaused.id);
    const mp = createMonthlyPlan('2026-04', [obj1, obj2]);

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goalActive, goalPaused],
      monthlyPlan: mp,
    });
    assert.equal(meta.objectivesIncluded, 1);
    assert.equal(meta.objectivesSkipped, 1);
    assert.ok(meta.skippedReasons[0].reason.includes('not active'));
  });

  it('includes objectives from inactive goals when requireActiveGoal=false', () => {
    const goalPaused = createGoal('Paused', '3mo');
    goalPaused.status = 'paused';
    const obj = createObjective('From paused goal', goalPaused.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goalPaused],
      monthlyPlan: mp,
      options: { requireActiveGoal: false },
    });
    assert.equal(meta.objectivesIncluded, 1);
    assert.equal(meta.objectivesSkipped, 0);
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — task generation and traceability
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — task generation', () => {
  it('generates one task per eligible objective by default', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    // obj1 (planned) and obj2 (in-progress) are eligible; obj3 (completed) skipped
    assert.equal(meta.objectivesIncluded, 2);
    assert.equal(plan.tasks.length, 2);
  });

  it('tasks trace back to their parent objectives', () => {
    const { goals, monthlyPlan, obj1, obj2 } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    const objectiveIds = plan.tasks.map((t) => t.objectiveId);
    assert.ok(objectiveIds.includes(obj1.id));
    assert.ok(objectiveIds.includes(obj2.id));
  });

  it('in-progress objectives produce high-priority tasks', () => {
    const { goals, monthlyPlan, obj2 } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    const inProgressTask = plan.tasks.find((t) => t.objectiveId === obj2.id);
    assert.equal(inProgressTask.priority, 'high');
  });

  it('planned objectives produce medium-priority tasks', () => {
    const { goals, monthlyPlan, obj1 } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    const plannedTask = plan.tasks.find((t) => t.objectiveId === obj1.id);
    assert.equal(plannedTask.priority, 'medium');
  });

  it('respects taskOverrides for specific objectives', () => {
    const goal = createGoal('G', '1mo');
    const obj = createObjective('Build it', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        taskOverrides: {
          [obj.id]: [
            { description: 'Step 1', priority: 'critical', estimatedMinutes: 30 },
            { description: 'Step 2', estimatedMinutes: 60 },
          ],
        },
      },
    });
    assert.equal(plan.tasks.length, 2);
    assert.equal(plan.tasks[0].description, 'Step 1');
    assert.equal(plan.tasks[0].priority, 'critical');
    assert.equal(plan.tasks[0].estimatedMinutes, 30);
    assert.equal(plan.tasks[1].description, 'Step 2');
  });

  it('all generated tasks start with pending status', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    for (const task of plan.tasks) {
      assert.equal(task.status, 'pending');
    }
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — plan structure
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — plan structure', () => {
  it('sets correct week and month on the plan', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    assert.equal(plan.week, '2026-W16');
    assert.equal(plan.month, '2026-04');
  });

  it('plan starts unapproved', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    assert.equal(plan.approved, false);
  });

  it('plan has createdAt and updatedAt timestamps', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    assert.ok(plan.createdAt);
    assert.ok(plan.updatedAt);
    assert.ok(!Number.isNaN(new Date(plan.createdAt).getTime()));
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — schema validation
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — schema validation', () => {
  it('output passes weekly plan schema validation', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('output survives JSON round-trip and stays valid', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    const restored = JSON.parse(JSON.stringify(plan));
    const result = validateWeeklyPlan(restored);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('plan with custom task overrides passes schema validation', () => {
    const goal = createGoal('G', '1mo');
    const obj = createObjective('O', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        taskOverrides: {
          [obj.id]: [
            { description: 'Custom task', priority: 'low', estimatedMinutes: 120 },
          ],
        },
      },
    });
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — edge cases
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — edge cases', () => {
  it('produces empty task list when all objectives are completed', () => {
    const goal = createGoal('Done goal', '1mo');
    const obj = createObjective('Done obj', goal.id);
    obj.status = 'completed';
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });
    assert.equal(plan.tasks.length, 0);
    assert.equal(meta.objectivesIncluded, 0);
    assert.equal(meta.objectivesSkipped, 1);
  });

  it('produces empty task list when all goals are inactive', () => {
    const goal = createGoal('Paused', '1mo');
    goal.status = 'paused';
    const obj = createObjective('O', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });
    assert.equal(plan.tasks.length, 0);
    assert.equal(meta.objectivesSkipped, 1);
  });

  it('handles monthly plan with empty objectives array', () => {
    const mp = { month: '2026-04', objectives: [], status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [],
      monthlyPlan: mp,
    });
    assert.equal(plan.tasks.length, 0);
    assert.equal(meta.totalTasks, 0);
  });

  it('handles empty goals array with requireActiveGoal=false', () => {
    const goal = createGoal('G', '1mo');
    const obj = createObjective('O', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [],
      monthlyPlan: mp,
      options: { requireActiveGoal: false },
    });
    assert.equal(plan.tasks.length, 1);
  });

  it('meta.skippedReasons contains useful information', () => {
    const goal = createGoal('G', '1mo');
    goal.status = 'dropped';
    const obj1 = createObjective('Dropped goal obj', goal.id);
    const obj2 = createObjective('Completed obj', goal.id);
    obj2.status = 'completed';
    const mp = createMonthlyPlan('2026-04', [obj1, obj2]);

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });
    assert.equal(meta.skippedReasons.length, 2);
    // One skipped for completed status, one for inactive goal
    const reasons = meta.skippedReasons.map((r) => r.reason);
    assert.ok(reasons.some((r) => r.includes('not eligible')));
    assert.ok(reasons.some((r) => r.includes('not active')));
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — full traceability chain
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — full traceability', () => {
  it('maintains goal -> objective -> task chain', () => {
    const goal = createGoal('Ship feature', '1mo');
    const obj = createObjective('Build backend', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });

    // Trace: task -> objective -> goal
    const task = plan.tasks[0];
    assert.equal(task.objectiveId, obj.id);
    assert.equal(obj.goalId, goal.id);
  });

  it('multiple goals produce tasks traced to correct objectives', () => {
    const g1 = createGoal('API', '1mo');
    const g2 = createGoal('Docs', '3mo');
    const obj1 = createObjective('Build endpoints', g1.id);
    const obj2 = createObjective('Write guides', g2.id);
    const mp = createMonthlyPlan('2026-04', [obj1, obj2]);

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [g1, g2],
      monthlyPlan: mp,
    });

    assert.equal(plan.tasks.length, 2);
    const t1 = plan.tasks.find((t) => t.objectiveId === obj1.id);
    const t2 = plan.tasks.find((t) => t.objectiveId === obj2.id);
    assert.ok(t1, 'task for obj1 should exist');
    assert.ok(t2, 'task for obj2 should exist');
    assert.equal(t1.description, 'Build endpoints');
    assert.equal(t2.description, 'Write guides');
  });
});

// ---------------------------------------------------------------------------
// generateAndSaveWeeklyPlan — integration with store
// ---------------------------------------------------------------------------

describe('generateAndSaveWeeklyPlan — store integration', () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-wpg-'));
    store = new WeeklyPlanStore(tmpDir);
  });

  it('generates and persists a valid weekly plan', async () => {
    const goal = createGoal('G', '1mo');
    const obj = createObjective('O', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    const { plan, meta } = await generateAndSaveWeeklyPlan(
      { week: '2026-W16', month: '2026-04', goals: [goal], monthlyPlan: mp },
      store,
      'agent-test-abc123',
    );
    assert.equal(meta.totalTasks, 1);
    assert.equal(plan.approved, false);

    // Verify persisted
    const loaded = await store.load('agent-test-abc123', '2026-W16');
    assert.equal(loaded.week, '2026-W16');
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.tasks[0].objectiveId, obj.id);
  });

  it('saved plan passes schema validation on reload', async () => {
    const goal = createGoal('G', '1mo');
    const obj = createObjective('O', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);

    await generateAndSaveWeeklyPlan(
      { week: '2026-W16', month: '2026-04', goals: [goal], monthlyPlan: mp },
      store,
      'agent-test-abc123',
    );

    const loaded = await store.load('agent-test-abc123', '2026-W16');
    const result = validateWeeklyPlan(loaded);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('idempotent: saving twice overwrites without error', async () => {
    const goal = createGoal('G', '1mo');
    const obj = createObjective('O', goal.id);
    const mp = createMonthlyPlan('2026-04', [obj]);
    const params = { week: '2026-W16', month: '2026-04', goals: [goal], monthlyPlan: mp };

    await generateAndSaveWeeklyPlan(params, store, 'agent-test-abc123');
    await generateAndSaveWeeklyPlan(params, store, 'agent-test-abc123');

    const weeks = await store.list('agent-test-abc123');
    assert.equal(weeks.length, 1);
  });
});
