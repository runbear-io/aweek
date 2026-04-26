/**
 * Tests for weekly plan generation service.
 * Covers:
 *  - Input validation (bad week/month format, missing data)
 *  - Objective filtering (eligible statuses, active goal gating)
 *  - Task generation (default tasks, custom overrides, priority mapping)
 *  - Plan traceability (tasks -> objectives -> goals chain)
 *  - Schema validity of generated plans
 *  - Edge cases (no objectives, all skipped, empty goals)
 *  - Advisor-mode review task injection (buildReviewTasks + generateWeeklyPlan)
 *  - generateAndSaveWeeklyPlan integration
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generateWeeklyPlan,
  generateAndSaveWeeklyPlan,
  filterEligibleObjectives,
  filterActiveGoals,
  defaultPriorityForObjective,
  generateTasksForObjective,
  buildReviewTasks,
} from './weekly-plan-generator.js';
import {
  createGoal,
  createObjective,
  createMonthlyPlan,
} from '../models/agent.js';
import { validateWeeklyPlan } from '../schemas/validator.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
  isReviewObjectiveId,
} from '../schemas/weekly-plan.schema.js';

interface TestObjective {
  id: string;
  description?: string;
  goalId?: string;
  status?: string;
  [key: string]: unknown;
}

interface TestGoal {
  id: string;
  description?: string;
  horizon?: string;
  status?: string;
  [key: string]: unknown;
}

interface TestMonthlyPlan {
  month: string;
  objectives: TestObjective[];
  status?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Shared constant: total review tasks injected per plan (5 daily + 1 weekly)
// ---------------------------------------------------------------------------

const REVIEW_TASKS_COUNT = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Fixture {
  goals: TestGoal[];
  monthlyPlan: TestMonthlyPlan;
  goalA: TestGoal;
  goalB: TestGoal;
  goalC: TestGoal;
  obj1: TestObjective;
  obj2: TestObjective;
  obj3: TestObjective;
}

/** Build a standard test fixture: 2 active goals, 1 completed goal, monthly plan with 3 objectives */
function buildFixture(): Fixture {
  const goalA = createGoal('Build REST API', '1mo') as TestGoal;
  const goalB = createGoal('Write documentation', '3mo') as TestGoal;
  const goalC = createGoal('Old goal', '1yr') as TestGoal;
  goalC.status = 'completed';

  const obj1 = createObjective('Implement endpoints', goalA.id) as TestObjective;
  // planned (default)
  const obj2 = createObjective('Write API docs', goalB.id) as TestObjective;
  obj2.status = 'in-progress';
  const obj3 = createObjective('Legacy cleanup', goalC.id) as TestObjective;
  obj3.status = 'completed';

  const monthlyPlan = createMonthlyPlan('2026-04', [obj1, obj2, obj3]) as TestMonthlyPlan;

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
    assert.equal(defaultPriorityForObjective({ id: 'o', status: 'in-progress' }), 'high');
  });

  it('returns medium for planned objectives', () => {
    assert.equal(defaultPriorityForObjective({ id: 'o', status: 'planned' }), 'medium');
  });

  it('returns medium for unknown statuses', () => {
    assert.equal(defaultPriorityForObjective({ id: 'o', status: 'other' }), 'medium');
  });
});

// ---------------------------------------------------------------------------
// generateTasksForObjective
// ---------------------------------------------------------------------------

describe('generateTasksForObjective', () => {
  it('generates one default task from objective description', () => {
    const obj = createObjective('Build login page', 'goal-abc12345') as TestObjective;
    const tasks = generateTasksForObjective(obj);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].prompt, 'Build login page');
    assert.equal(tasks[0].objectiveId, obj.id);
    assert.equal(tasks[0].priority, 'medium'); // planned -> medium
    assert.equal(tasks[0].status, 'pending');
  });

  it('uses high priority for in-progress objectives', () => {
    const obj = createObjective('Active work', 'goal-abc12345') as TestObjective;
    obj.status = 'in-progress';
    const tasks = generateTasksForObjective(obj);
    assert.equal(tasks[0].priority, 'high');
  });

  it('generates custom tasks from taskDescriptors', () => {
    const obj = createObjective('Build API', 'goal-abc12345') as TestObjective;
    const tasks = generateTasksForObjective(obj, {
      taskDescriptors: [
        { title: 'Design schema', prompt: 'Design schema', priority: 'critical', estimatedMinutes: 60 },
        { title: 'Write routes', prompt: 'Write routes', estimatedMinutes: 120 },
      ],
    });
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].prompt, 'Design schema');
    assert.equal(tasks[0].priority, 'critical');
    assert.equal(tasks[0].estimatedMinutes, 60);
    assert.equal(tasks[0].objectiveId, obj.id);
    assert.equal(tasks[1].prompt, 'Write routes');
    assert.equal(tasks[1].priority, 'medium'); // defaults from objective
    assert.equal(tasks[1].estimatedMinutes, 120);
  });

  it('ignores empty taskDescriptors and falls back to default', () => {
    const obj = createObjective('Fallback', 'goal-abc12345') as TestObjective;
    const tasks = generateTasksForObjective(obj, { taskDescriptors: [] });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].prompt, 'Fallback');
  });

  it('all generated tasks have valid IDs', () => {
    const obj = createObjective('Check IDs', 'goal-abc12345') as TestObjective;
    const tasks = generateTasksForObjective(obj, {
      taskDescriptors: [
        { title: 'A', prompt: 'A' },
        { title: 'B', prompt: 'B' },
        { title: 'C', prompt: 'C' },
      ],
    });
    for (const t of tasks) {
      assert.match(t.id, /^task-[a-z0-9]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// buildReviewTasks
// ---------------------------------------------------------------------------

describe('buildReviewTasks', () => {
  // ISO week 2026-W16: Monday April 13 → Friday April 17 (UTC)

  it('returns exactly 6 tasks (5 daily-review + 1 weekly-review)', () => {
    const tasks = buildReviewTasks('2026-W16');
    assert.equal(tasks.length, REVIEW_TASKS_COUNT);
  });

  it('exactly 5 tasks carry DAILY_REVIEW_OBJECTIVE_ID', () => {
    const tasks = buildReviewTasks('2026-W16');
    const daily = tasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID);
    assert.equal(daily.length, 5);
  });

  it('exactly 1 task carries WEEKLY_REVIEW_OBJECTIVE_ID', () => {
    const tasks = buildReviewTasks('2026-W16');
    const weekly = tasks.filter((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID);
    assert.equal(weekly.length, 1);
  });

  it('daily review tasks fire at 17:00 UTC when tz is UTC', () => {
    const tasks = buildReviewTasks('2026-W16', 'UTC');
    const daily = tasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID);
    for (const t of daily) {
      assert.ok(t.runAt, 'daily review must have runAt');
      assert.equal(new Date(t.runAt!).getUTCHours(), 17);
    }
  });

  it('weekly review task fires at 18:00 UTC when tz is UTC (one hour after daily)', () => {
    const tasks = buildReviewTasks('2026-W16', 'UTC');
    const weekly = tasks.find((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID)!;
    assert.ok(weekly.runAt, 'weekly review must have runAt');
    assert.equal(new Date(weekly.runAt!).getUTCHours(), 18);
  });

  it('daily tasks span Monday through Friday of 2026-W16 in UTC', () => {
    const tasks = buildReviewTasks('2026-W16', 'UTC');
    const daily = tasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID);
    // Mon Apr 13 → Fri Apr 17
    const dates = daily.map((t) => new Date(t.runAt!).getUTCDate()).sort((a, b) => a - b);
    assert.deepStrictEqual(dates, [13, 14, 15, 16, 17]);
  });

  it('weekly review task falls on Friday of the given week in UTC', () => {
    const tasks = buildReviewTasks('2026-W16', 'UTC');
    const weekly = tasks.find((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID)!;
    // Friday of 2026-W16 = April 17
    assert.equal(new Date(weekly.runAt!).getUTCDate(), 17);
    assert.equal(new Date(weekly.runAt!).getUTCMonth(), 3); // April = month 3 (0-indexed)
  });

  it('all tasks start with pending status and valid task IDs', () => {
    const tasks = buildReviewTasks('2026-W16');
    for (const t of tasks) {
      assert.match(t.id, /^task-[a-z0-9-]+$/);
      assert.equal(t.status, 'pending');
    }
  });

  it('daily review tasks have track equal to DAILY_REVIEW_OBJECTIVE_ID', () => {
    const tasks = buildReviewTasks('2026-W16');
    const daily = tasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID);
    for (const t of daily) {
      assert.equal(t.track, DAILY_REVIEW_OBJECTIVE_ID);
    }
  });

  it('weekly review task has track equal to WEEKLY_REVIEW_OBJECTIVE_ID', () => {
    const tasks = buildReviewTasks('2026-W16');
    const weekly = tasks.find((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID)!;
    assert.equal(weekly.track, WEEKLY_REVIEW_OBJECTIVE_ID);
  });

  it('daily review has estimatedMinutes=30, weekly review has estimatedMinutes=60', () => {
    const tasks = buildReviewTasks('2026-W16');
    const daily = tasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID);
    for (const t of daily) assert.equal(t.estimatedMinutes, 30);
    const weekly = tasks.find((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID)!;
    assert.equal(weekly.estimatedMinutes, 60);
  });

  it('weekly review task has priority=high', () => {
    const tasks = buildReviewTasks('2026-W16');
    const weekly = tasks.find((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID)!;
    assert.equal(weekly.priority, 'high');
  });

  it('accepts a valid IANA timezone and adjusts runAt accordingly', () => {
    // America/New_York is UTC-4 in April (EDT)
    const tasks = buildReviewTasks('2026-W16', 'America/New_York');
    assert.equal(tasks.length, REVIEW_TASKS_COUNT);
    const daily = tasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID);
    // 17:00 New York (EDT=UTC-4) = 21:00 UTC
    for (const t of daily) {
      assert.equal(new Date(t.runAt!).getUTCHours(), 21);
    }
  });

  it('falls back to UTC for an invalid timezone', () => {
    const utcTasks = buildReviewTasks('2026-W16', 'UTC');
    const invalidTasks = buildReviewTasks('2026-W16', 'Not/AZone');
    assert.equal(invalidTasks.length, REVIEW_TASKS_COUNT);
    for (let i = 0; i < REVIEW_TASKS_COUNT; i++) {
      assert.equal(invalidTasks[i].runAt, utcTasks[i].runAt);
    }
  });

  it('handles month roll-over correctly (week spanning month boundary)', () => {
    // 2026-W18 starts Monday April 27; Friday is May 1
    const tasks = buildReviewTasks('2026-W18', 'UTC');
    assert.equal(tasks.length, REVIEW_TASKS_COUNT);
    const weekly = tasks.find((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID)!;
    const fridayDate = new Date(weekly.runAt!);
    assert.equal(fridayDate.getUTCMonth(), 4);  // May (0-indexed)
    assert.equal(fridayDate.getUTCDate(), 1);
  });

  it('all review tasks pass schema validation via validateWeeklyPlan', () => {
    const tasks = buildReviewTasks('2026-W16');
    const plan = { week: '2026-W16', month: '2026-04', tasks, approved: false };
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('all tasks have non-empty descriptions', () => {
    const tasks = buildReviewTasks('2026-W16');
    for (const t of tasks) {
      assert.ok(typeof t.prompt === 'string' && t.prompt.length > 0,
        `task ${t.id} has empty prompt`);
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
      () => generateWeeklyPlan({ week: '2026-W16', month: '2026-04', goals, monthlyPlan: null as unknown as TestMonthlyPlan }),
      /monthlyPlan must have an objectives array/,
    );
  });

  it('throws on missing goals', () => {
    assert.throws(
      () => generateWeeklyPlan({ week: '2026-W16', month: '2026-04', goals: null as unknown as TestGoal[], monthlyPlan }),
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
    const goalActive = createGoal('Active', '1mo') as TestGoal;
    const goalPaused = createGoal('Paused', '3mo') as TestGoal;
    goalPaused.status = 'paused';

    const obj1 = createObjective('From active goal', goalActive.id) as TestObjective;
    const obj2 = createObjective('From paused goal', goalPaused.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj1, obj2]) as TestMonthlyPlan;

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
    const goalPaused = createGoal('Paused', '3mo') as TestGoal;
    goalPaused.status = 'paused';
    const obj = createObjective('From paused goal', goalPaused.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

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
  it('generates one task per eligible objective by default (plus review tasks)', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    // obj1 (planned) and obj2 (in-progress) are eligible; obj3 (completed) skipped
    assert.equal(meta.objectivesIncluded, 2);
    // 2 work tasks + REVIEW_TASKS_COUNT advisor review tasks always injected
    const workTasks = plan.tasks.filter((t) => !isReviewObjectiveId(t.objectiveId));
    assert.equal(workTasks.length, 2);
    assert.equal(plan.tasks.length, 2 + REVIEW_TASKS_COUNT);
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
    const inProgressTask = plan.tasks.find((t) => t.objectiveId === obj2.id)!;
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
    const plannedTask = plan.tasks.find((t) => t.objectiveId === obj1.id)!;
    assert.equal(plannedTask.priority, 'medium');
  });

  it('respects taskOverrides for specific objectives (work tasks appear before review tasks)', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('Build it', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        taskOverrides: {
          [obj.id]: [
            { title: 'Step 1', prompt: 'Step 1', priority: 'critical', estimatedMinutes: 30 },
            { title: 'Step 2', prompt: 'Step 2', estimatedMinutes: 60 },
          ],
        },
      },
    });
    // 2 work tasks + REVIEW_TASKS_COUNT review tasks
    assert.equal(plan.tasks.length, 2 + REVIEW_TASKS_COUNT);
    // Work tasks are prepended before review tasks
    assert.equal(plan.tasks[0].prompt, 'Step 1');
    assert.equal(plan.tasks[0].priority, 'critical');
    assert.equal(plan.tasks[0].estimatedMinutes, 30);
    assert.equal(plan.tasks[1].prompt, 'Step 2');
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

  it('plan starts auto-approved so tasks are immediately pending for the heartbeat', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    assert.equal(plan.approved, true);
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
    assert.ok(!Number.isNaN(new Date(plan.createdAt!).getTime()));
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
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        taskOverrides: {
          [obj.id]: [
            { title: 'Custom task', prompt: 'Custom task', priority: 'low', estimatedMinutes: 120 },
          ],
        },
      },
    });
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — advisor-mode review task injection
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — review task injection', () => {
  it('injects exactly REVIEW_TASKS_COUNT review tasks into every generated plan', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    const reviewTasks = plan.tasks.filter((t) => isReviewObjectiveId(t.objectiveId));
    assert.equal(reviewTasks.length, REVIEW_TASKS_COUNT);
    assert.equal(meta.reviewTasksAdded, REVIEW_TASKS_COUNT);
  });

  it('injects review tasks even when no work objectives are eligible', () => {
    const goal = createGoal('Done goal', '1mo') as TestGoal;
    const obj = createObjective('Done obj', goal.id) as TestObjective;
    obj.status = 'completed';
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });
    const reviewTasks = plan.tasks.filter((t) => isReviewObjectiveId(t.objectiveId));
    assert.equal(reviewTasks.length, REVIEW_TASKS_COUNT);
    assert.equal(plan.tasks.length, REVIEW_TASKS_COUNT); // no work tasks
  });

  it('review tasks are appended after work tasks preserving work task order', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals,
      monthlyPlan,
    });
    const workCount = plan.tasks.length - REVIEW_TASKS_COUNT;
    // All work tasks come before review tasks
    for (let i = 0; i < workCount; i++) {
      assert.ok(!isReviewObjectiveId(plan.tasks[i].objectiveId),
        `expected work task at index ${i}`);
    }
    for (let i = workCount; i < plan.tasks.length; i++) {
      assert.ok(isReviewObjectiveId(plan.tasks[i].objectiveId),
        `expected review task at index ${i}`);
    }
  });

  it('review tasks use tz option for runAt computation', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan: utcPlan } = generateWeeklyPlan({
      week: '2026-W16', month: '2026-04', goals, monthlyPlan,
      options: { tz: 'UTC' },
    });
    const { plan: nyPlan } = generateWeeklyPlan({
      week: '2026-W16', month: '2026-04', goals, monthlyPlan,
      options: { tz: 'America/New_York' },
    });

    const utcReview = utcPlan.tasks.find((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID)!;
    const nyReview = nyPlan.tasks.find((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID)!;

    // New York (EDT=UTC-4) daily review at 17:00 local = 21:00 UTC ≠ UTC 17:00
    assert.notEqual(utcReview.runAt, nyReview.runAt);
    assert.equal(new Date(nyReview.runAt!).getUTCHours(), 21);
  });

  it('meta.reviewTasksAdded is always REVIEW_TASKS_COUNT', () => {
    const mp: TestMonthlyPlan = {
      month: '2026-04', objectives: [], status: 'active',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const { meta } = generateWeeklyPlan({
      week: '2026-W16', month: '2026-04', goals: [], monthlyPlan: mp,
    });
    assert.equal(meta.reviewTasksAdded, REVIEW_TASKS_COUNT);
  });

  it('generated plan including review tasks passes schema validation', () => {
    const { goals, monthlyPlan } = buildFixture();
    const { plan } = generateWeeklyPlan({
      week: '2026-W16', month: '2026-04', goals, monthlyPlan,
    });
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — edge cases
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — edge cases', () => {
  it('only review tasks present when all objectives are completed', () => {
    const goal = createGoal('Done goal', '1mo') as TestGoal;
    const obj = createObjective('Done obj', goal.id) as TestObjective;
    obj.status = 'completed';
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });
    const workTasks = plan.tasks.filter((t) => !isReviewObjectiveId(t.objectiveId));
    assert.equal(workTasks.length, 0);
    assert.equal(plan.tasks.length, REVIEW_TASKS_COUNT);
    assert.equal(meta.objectivesIncluded, 0);
    assert.equal(meta.objectivesSkipped, 1);
  });

  it('only review tasks present when all goals are inactive', () => {
    const goal = createGoal('Paused', '1mo') as TestGoal;
    goal.status = 'paused';
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });
    const workTasks = plan.tasks.filter((t) => !isReviewObjectiveId(t.objectiveId));
    assert.equal(workTasks.length, 0);
    assert.equal(plan.tasks.length, REVIEW_TASKS_COUNT);
    assert.equal(meta.objectivesSkipped, 1);
  });

  it('handles monthly plan with empty objectives array (only review tasks)', () => {
    const mp: TestMonthlyPlan = { month: '2026-04', objectives: [], status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const { plan, meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [],
      monthlyPlan: mp,
    });
    assert.equal(plan.tasks.length, REVIEW_TASKS_COUNT);
    assert.equal(meta.totalTasks, REVIEW_TASKS_COUNT);
  });

  it('handles empty goals array with requireActiveGoal=false', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [],
      monthlyPlan: mp,
      options: { requireActiveGoal: false },
    });
    assert.equal(plan.tasks.length, 1 + REVIEW_TASKS_COUNT);
  });

  it('meta.skippedReasons contains useful information', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    goal.status = 'dropped';
    const obj1 = createObjective('Dropped goal obj', goal.id) as TestObjective;
    const obj2 = createObjective('Completed obj', goal.id) as TestObjective;
    obj2.status = 'completed';
    const mp = createMonthlyPlan('2026-04', [obj1, obj2]) as TestMonthlyPlan;

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
  it('maintains goal -> objective -> task chain (first task is a work task)', () => {
    const goal = createGoal('Ship feature', '1mo') as TestGoal;
    const obj = createObjective('Build backend', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });

    // Work tasks are prepended before review tasks; first task traces to obj
    const task = plan.tasks[0];
    assert.equal(task.objectiveId, obj.id);
    assert.equal(obj.goalId, goal.id);
  });

  it('multiple goals produce tasks traced to correct objectives', () => {
    const g1 = createGoal('API', '1mo') as TestGoal;
    const g2 = createGoal('Docs', '3mo') as TestGoal;
    const obj1 = createObjective('Build endpoints', g1.id) as TestObjective;
    const obj2 = createObjective('Write guides', g2.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj1, obj2]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [g1, g2],
      monthlyPlan: mp,
    });

    assert.equal(plan.tasks.length, 2 + REVIEW_TASKS_COUNT);
    const t1 = plan.tasks.find((t) => t.objectiveId === obj1.id);
    const t2 = plan.tasks.find((t) => t.objectiveId === obj2.id);
    assert.ok(t1, 'task for obj1 should exist');
    assert.ok(t2, 'task for obj2 should exist');
    assert.equal(t1.prompt, 'Build endpoints');
    assert.equal(t2.prompt, 'Write guides');
  });
});

// ---------------------------------------------------------------------------
// generateAndSaveWeeklyPlan — integration with store
// ---------------------------------------------------------------------------

describe('generateAndSaveWeeklyPlan — store integration', () => {
  let tmpDir: string;
  let store: WeeklyPlanStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-wpg-'));
    store = new WeeklyPlanStore(tmpDir);
  });

  it('generates and persists a valid weekly plan', async () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan, meta } = await generateAndSaveWeeklyPlan(
      { week: '2026-W16', month: '2026-04', goals: [goal], monthlyPlan: mp },
      store,
      'agent-test-abc123',
    );
    // 1 work task + REVIEW_TASKS_COUNT review tasks
    assert.equal(meta.totalTasks, 1 + REVIEW_TASKS_COUNT);
    assert.equal(plan.approved, true);

    // Verify persisted
    const loaded = (await store.load('agent-test-abc123', '2026-W16')) as { week: string; tasks: Array<{ objectiveId?: string }> };
    assert.equal(loaded.week, '2026-W16');
    assert.equal(loaded.tasks.length, 1 + REVIEW_TASKS_COUNT);
    // The work task traces back to its objective
    const workTask = loaded.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.equal(workTask.objectiveId, obj.id);
  });

  it('saved plan passes schema validation on reload', async () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

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
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;
    const params = { week: '2026-W16', month: '2026-04', goals: [goal], monthlyPlan: mp };

    await generateAndSaveWeeklyPlan(params, store, 'agent-test-abc123');
    await generateAndSaveWeeklyPlan(params, store, 'agent-test-abc123');

    const weeks = await store.list('agent-test-abc123');
    assert.equal(weeks.length, 1);
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — day-layout detection (Sub-AC 7b)
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — day-layout detection', () => {
  /** Plan markdown with clear theme-day signals (day headings). */
  const THEME_DAYS_PLAN = `
# Agent Plan

## Long-term goals

Ship features.

## Monday

Deep work and coding.

## Tuesday

Code review and PRs.

## Wednesday

Planning and retros.
`;

  /** Plan markdown with clear priority-waterfall signals. */
  const PRIORITY_WATERFALL_PLAN = `
# Agent Plan

## Long-term goals

Build something great.

## Monthly plans

Priority 1: Complete the auth module
Priority 2: Write API documentation
Priority 3: Add analytics dashboard
`;

  /** Plan markdown with no recognisable layout signals — defaults to mixed. */
  const NEUTRAL_PLAN = `
# Agent Plan

## Long-term goals

Become a domain expert.

## Strategies

Work through foundational material.
`;

  it('defaults to layoutMode="mixed" when no planMarkdown is supplied', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });
    assert.equal(meta.layoutMode, 'mixed');
    assert.equal(meta.spreadStrategy, 'pack');
  });

  it('defaults to layoutMode="mixed" when planMarkdown is null', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: null },
    });
    assert.equal(meta.layoutMode, 'mixed');
    assert.equal(meta.spreadStrategy, 'pack');
  });

  it('detects theme-days layout and maps to spreadStrategy="spread"', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: THEME_DAYS_PLAN },
    });
    assert.equal(meta.layoutMode, 'theme-days');
    assert.equal(meta.spreadStrategy, 'spread');
  });

  it('detects priority-waterfall layout and maps to spreadStrategy="pack"', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PRIORITY_WATERFALL_PLAN },
    });
    assert.equal(meta.layoutMode, 'priority-waterfall');
    assert.equal(meta.spreadStrategy, 'pack');
  });

  it('neutral plan (no layout signals) defaults to mixed / pack', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: NEUTRAL_PLAN },
    });
    assert.equal(meta.layoutMode, 'mixed');
    assert.equal(meta.spreadStrategy, 'pack');
  });

  it('priority-waterfall mode pre-sorts work tasks by priority (critical first, review tasks after)', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const objA = createObjective('Low priority work', goal.id) as TestObjective;      // planned → medium
    const objB = createObjective('Critical path work', goal.id) as TestObjective;
    objB.status = 'in-progress'; // → high
    const objC = createObjective('Ship MVP', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [objA, objB, objC]) as TestMonthlyPlan;

    // Use taskOverrides to inject a critical-priority task for objC
    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        planMarkdown: PRIORITY_WATERFALL_PLAN,
        taskOverrides: {
          [objC.id]: [{ title: 'Ship MVP now', prompt: 'Ship MVP now', priority: 'critical' }],
        },
      },
    });

    // Work tasks (first 3) should be sorted: critical → high → medium
    const workTasks = plan.tasks.filter((t) => !isReviewObjectiveId(t.objectiveId));
    assert.equal(workTasks[0].priority, 'critical');
    assert.equal(workTasks[1].priority, 'high');
    assert.equal(workTasks[2].priority, 'medium');
  });

  it('theme-days mode does NOT reorder tasks by priority', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    // Intentionally create medium before high
    const objA = createObjective('Medium task', goal.id) as TestObjective;  // planned → medium
    const objB = createObjective('High task', goal.id) as TestObjective;
    objB.status = 'in-progress'; // → high
    const mp = createMonthlyPlan('2026-04', [objA, objB]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: THEME_DAYS_PLAN },
    });

    // Objectives are processed in input order for theme-days, no priority sort
    assert.equal(plan.tasks[0].objectiveId, objA.id);
    assert.equal(plan.tasks[1].objectiveId, objB.id);
  });

  it('meta includes layoutMode, spreadStrategy, and reviewTasksAdded alongside existing fields', () => {
    const goal = createGoal('G', '1mo') as TestGoal;
    const obj = createObjective('O', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { meta } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: THEME_DAYS_PLAN },
    });

    // All existing meta fields still present
    assert.ok('totalTasks' in meta, 'missing totalTasks');
    assert.ok('objectivesIncluded' in meta, 'missing objectivesIncluded');
    assert.ok('objectivesSkipped' in meta, 'missing objectivesSkipped');
    assert.ok('skippedReasons' in meta, 'missing skippedReasons');
    // Layout fields
    assert.ok('layoutMode' in meta, 'missing layoutMode');
    assert.ok('spreadStrategy' in meta, 'missing spreadStrategy');
    // Review injection field
    assert.ok('reviewTasksAdded' in meta, 'missing reviewTasksAdded');
    assert.equal(meta.reviewTasksAdded, REVIEW_TASKS_COUNT);
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyPlan — advisor brief composition (AC 2)
// ---------------------------------------------------------------------------

describe('generateWeeklyPlan — advisor brief composition', () => {
  /** Minimal plan.md with a Strategies section the brief can reference. */
  const PLAN_MD_WITH_STRATEGY = `
# Dev Agent

## Long-term goals

- (3mo) Ship a production REST API

## Monthly plans

### 2026-04

- Implement endpoints

## Strategies

- Work in 2-hour deep work blocks
- Test-first development

## Notes

Focus on API quality over breadth.
`;

  it('uses objective description directly when planMarkdown is absent (backward compat)', () => {
    const goal = createGoal('Ship a REST API', '1mo') as TestGoal;
    const obj = createObjective('Implement endpoints', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.equal(workTask.prompt, 'Implement endpoints',
      'Without planMarkdown, description should be raw objective description');
  });

  it('uses objective description directly when planMarkdown is null (backward compat)', () => {
    const goal = createGoal('Ship a REST API', '1mo') as TestGoal;
    const obj = createObjective('Write documentation', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: null },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.equal(workTask.prompt, 'Write documentation',
      'planMarkdown: null should preserve raw objective description');
  });

  it('generates an advisor brief (longer than raw description) when planMarkdown is supplied', () => {
    const goal = createGoal('Ship a production REST API', '1mo') as TestGoal;
    const obj = createObjective('Implement endpoints', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PLAN_MD_WITH_STRATEGY },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.ok(
      workTask.prompt.length > 'Implement endpoints'.length,
      `Expected advisor brief (longer than objective description), got: "${workTask.prompt}"`,
    );
  });

  it('advisor brief still contains the objective description text', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj = createObjective('Build rate limiter', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PLAN_MD_WITH_STRATEGY },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.ok(
      workTask.prompt.includes('Build rate limiter'),
      `Advisor brief should contain the objective description: "${workTask.prompt}"`,
    );
  });

  it('advisor brief references plan.md strategy when the Strategies section has content', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj = createObjective('Build auth module', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PLAN_MD_WITH_STRATEGY },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.ok(
      workTask.prompt.includes('plan.md') ||
        workTask.prompt.toLowerCase().includes('deep work') ||
        workTask.prompt.toLowerCase().includes('test-first'),
      `Advisor brief should reference plan.md strategy: "${workTask.prompt}"`,
    );
  });

  it('advisor brief references prior day outcomes when priorDayOutcomes is supplied', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj = createObjective('Add rate limiting', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const priorDayOutcomes = 'Completed the endpoint scaffolding and wrote the first integration test';

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PLAN_MD_WITH_STRATEGY, priorDayOutcomes },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.ok(
      workTask.prompt.toLowerCase().includes('yesterday'),
      `Advisor brief should reference prior day outcomes: "${workTask.prompt}"`,
    );
  });

  it('taskOverrides are NOT replaced by advisor brief composer (user intent preserved)', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj = createObjective('Build login', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const customDescription = 'My custom task description that must not be changed';

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        planMarkdown: PLAN_MD_WITH_STRATEGY,
        taskOverrides: {
          [obj.id]: [{ title: customDescription, prompt: customDescription, priority: 'high' }],
        },
      },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.equal(workTask.prompt, customDescription,
      'taskOverrides must take precedence over advisor brief composer');
  });

  it('advisor brief task retains correct objectiveId traceability', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj = createObjective('Design schema', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PLAN_MD_WITH_STRATEGY },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.equal(workTask.objectiveId, obj.id, 'objectiveId traceability must be preserved');
    assert.equal(workTask.priority, 'medium', 'planned objective should get medium priority');
    assert.equal(workTask.status, 'pending');
  });

  it('in-progress objective gets high priority in advisor brief task', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj = createObjective('Finish auth module', goal.id) as TestObjective;
    obj.status = 'in-progress';
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PLAN_MD_WITH_STRATEGY },
    });

    const workTask = plan.tasks.find((t) => !isReviewObjectiveId(t.objectiveId))!;
    assert.equal(workTask.priority, 'high', 'in-progress objective should get high priority');
  });

  it('multiple objectives with planMarkdown all get advisor briefs', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj1 = createObjective('Build auth', goal.id) as TestObjective;
    const obj2 = createObjective('Write docs', goal.id) as TestObjective;
    obj2.status = 'in-progress';
    const mp = createMonthlyPlan('2026-04', [obj1, obj2]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PLAN_MD_WITH_STRATEGY },
    });

    const workTasks = plan.tasks.filter((t) => !isReviewObjectiveId(t.objectiveId));
    assert.equal(workTasks.length, 2);
    // Both briefs should be longer than the raw objective descriptions
    assert.ok(
      workTasks[0].prompt.length > 'Build auth'.length,
      `First task brief should be expanded: "${workTasks[0].prompt}"`,
    );
    assert.ok(
      workTasks[1].prompt.length > 'Write docs'.length,
      `Second task brief should be expanded: "${workTasks[1].prompt}"`,
    );
  });

  it('generated plan with advisor briefs passes schema validation', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj = createObjective('Write API docs', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: {
        planMarkdown: PLAN_MD_WITH_STRATEGY,
        priorDayOutcomes: 'Finished the first API draft and updated the changelog',
      },
    });

    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('advisor brief composition does not affect review tasks (they keep their fixed descriptions)', () => {
    const goal = createGoal('Ship API', '1mo') as TestGoal;
    const obj = createObjective('Build feature', goal.id) as TestObjective;
    const mp = createMonthlyPlan('2026-04', [obj]) as TestMonthlyPlan;

    const { plan } = generateWeeklyPlan({
      week: '2026-W16',
      month: '2026-04',
      goals: [goal],
      monthlyPlan: mp,
      options: { planMarkdown: PLAN_MD_WITH_STRATEGY },
    });

    const reviewTasks = plan.tasks.filter((t) => isReviewObjectiveId(t.objectiveId));
    assert.equal(reviewTasks.length, REVIEW_TASKS_COUNT);
    // Review tasks should have their fixed descriptions (not advisor briefs)
    for (const t of reviewTasks) {
      assert.ok(
        typeof t.prompt === 'string' && t.prompt.length > 0,
        `Review task ${t.id} should have non-empty description`,
      );
    }
  });
});
