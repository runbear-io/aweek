/**
 * Tests for weekly plan schema validation (valid and invalid inputs).
 * Weekly plans contain tasks that trace back to monthly objectives,
 * completing the plan traceability chain: goal -> objective -> task.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateWeeklyPlan } from './validator.js';
import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
  REVIEW_OBJECTIVE_IDS,
  isReviewObjectiveId,
} from './weekly-plan.schema.js';
import {
  createWeeklyPlan,
  createTask,
  createObjective,
  createGoal,
} from '../models/agent.js';

describe('weekly plan schema', () => {
  // Helper: build a valid task linked to an objective
  const makeTask = () => {
    const goal = createGoal('Test goal', '3mo');
    const obj = createObjective('Test objective', goal.id);
    return { task: createTask({ title: 'Do something', prompt: 'Do something' }, obj.id), obj, goal };
  };

  describe('valid inputs', () => {
    it('should accept a valid weekly plan with tasks', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
      assert.equal(result.errors, null);
    });

    it('should accept a weekly plan with empty tasks array', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', []);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should accept a weekly plan with multiple tasks', () => {
      const { task: task1 } = makeTask();
      const { task: task2 } = makeTask();
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task1, task2]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should default approved to true', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      assert.equal(plan.approved, true);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should accept approved plan with approvedAt timestamp', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      plan.approved = true;
      plan.approvedAt = new Date().toISOString();
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should accept all valid task statuses', () => {
      const validStatuses = ['pending', 'in-progress', 'completed', 'failed', 'delegated', 'skipped'];
      for (const status of validStatuses) {
        const { task } = makeTask();
        task.status = status;
        const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
        const result = validateWeeklyPlan(plan);
        assert.equal(result.valid, true, `Task status '${status}' should be valid`);
      }
    });

    it('should accept task with optional delegatedTo field', () => {
      const { task } = makeTask();
      task.status = 'delegated';
      task.delegatedTo = 'agent-helper-abc123';
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should accept task with optional completedAt', () => {
      const { task } = makeTask();
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
    });
  });

  describe('invalid inputs — missing required fields', () => {
    it('should reject plan without week', () => {
      const { task } = makeTask();
      const result = validateWeeklyPlan({
        month: '2026-04',
        tasks: [task],
        approved: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('should reject plan without month', () => {
      const { task } = makeTask();
      const result = validateWeeklyPlan({
        week: '2026-W16',
        tasks: [task],
        approved: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.equal(result.valid, false);
    });

    it('should reject plan without tasks', () => {
      const result = validateWeeklyPlan({
        week: '2026-W16',
        month: '2026-04',
        approved: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.equal(result.valid, false);
    });

    it('should reject plan without approved field', () => {
      const { task } = makeTask();
      const result = validateWeeklyPlan({
        week: '2026-W16',
        month: '2026-04',
        tasks: [task],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.equal(result.valid, false);
    });
  });

  describe('invalid inputs — format violations', () => {
    it('should reject invalid week format (missing W prefix)', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('2026-16', '2026-04', [task]);
      plan.week = '2026-16';
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject invalid week format (plain text)', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('Week 16', '2026-04', [task]);
      plan.week = 'Week 16';
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject invalid month format', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('2026-W16', 'April', [task]);
      plan.month = 'April';
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject invalid approvedAt format', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      plan.approved = true;
      plan.approvedAt = 'not-a-date';
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });
  });

  describe('invalid inputs — task validation', () => {
    it('should reject task without id', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        title: 'Missing id',
        prompt: 'Missing id',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with invalid id pattern', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'bad-id',
        title: 'Bad ID pattern',
        prompt: 'Bad ID pattern',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task without title', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        prompt: 'No title supplied',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task without prompt', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        title: 'No prompt supplied',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with empty title', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        title: '',
        prompt: 'Blank title',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with title longer than 80 characters', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        title: 'a'.repeat(81),
        prompt: 'Title too long',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with empty prompt', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        title: 'Has title',
        prompt: '',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('accepts a task without objectiveId (free-form in the plan.md world)', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        title: 'No objective ref',
        prompt: 'No objective ref',
        priority: 'medium',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('accepts any non-empty objectiveId string (e.g. a plan.md section heading)', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        title: 'Links to a plan.md section',
        prompt: 'Links to a plan.md section',
        objectiveId: '2026-04',
        priority: 'medium',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it('rejects an empty-string objectiveId', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        title: 'Empty tag',
        prompt: 'Empty tag',
        objectiveId: '',
        priority: 'medium',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with invalid status', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        title: 'Bad status',
        prompt: 'Bad status',
        objectiveId: 'obj-abc12345',
        status: 'unknown',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with unknown additional properties', () => {
      const { task } = makeTask();
      task.extraField = 'not allowed';
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });
  });

  describe('invalid inputs — additional properties', () => {
    it('should reject unknown properties on the plan', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      plan.extraField = 'not allowed';
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });
  });

  describe('plan traceability', () => {
    it('should verify tasks trace back to objectives via objectiveId', () => {
      const goal = createGoal('Ship feature', '1mo');
      const obj = createObjective('Build API', goal.id);
      const task = createTask({ title: 'Implement endpoint', prompt: 'Implement endpoint' }, obj.id);

      // Verify the traceability chain: task -> objective -> goal
      assert.equal(task.objectiveId, obj.id);
      assert.equal(obj.goalId, goal.id);

      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should support tasks from multiple objectives', () => {
      const goal = createGoal('Multi-objective goal', '3mo');
      const obj1 = createObjective('Objective A', goal.id);
      const obj2 = createObjective('Objective B', goal.id);
      const task1 = createTask({ title: 'Task for A', prompt: 'Task for A' }, obj1.id);
      const task2 = createTask({ title: 'Task for B', prompt: 'Task for B' }, obj2.id);

      const plan = createWeeklyPlan('2026-W16', '2026-04', [task1, task2]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
      assert.notEqual(task1.objectiveId, task2.objectiveId);
    });
  });
});

describe('weekly task schema — track field', () => {
  const makeTask = () => {
    const goal = createGoal('Test goal', '3mo');
    const obj = createObjective('Test objective', goal.id);
    return createTask({ title: 'Publish one X.com post', prompt: 'Publish one X.com post' }, obj.id);
  };

  it('accepts a task with a valid track', () => {
    const task = makeTask();
    task.track = 'x-com';
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    assert.equal(validateWeeklyPlan(plan).valid, true);
  });

  it('accepts a task without a track (optional field)', () => {
    const plan = createWeeklyPlan('2026-W17', '2026-04', [makeTask()]);
    assert.equal(validateWeeklyPlan(plan).valid, true);
  });

  it('rejects an empty-string track', () => {
    const task = makeTask();
    task.track = '';
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    assert.equal(validateWeeklyPlan(plan).valid, false);
  });

  it('rejects a track longer than 64 chars', () => {
    const task = makeTask();
    task.track = 'a'.repeat(65);
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    assert.equal(validateWeeklyPlan(plan).valid, false);
  });

  it('createTask attaches track when provided via opts', () => {
    const goal = createGoal('Test goal', '3mo');
    const obj = createObjective('Test objective', goal.id);
    const task = createTask({ title: 'X post 1', prompt: 'X post 1' }, obj.id, { track: 'x-com' });
    assert.equal(task.track, 'x-com');
  });

  it('createTask omits track when not provided', () => {
    const goal = createGoal('Test goal', '3mo');
    const obj = createObjective('Test objective', goal.id);
    const task = createTask({ title: 'Just do it', prompt: 'Just do it' }, obj.id);
    assert.equal(task.track, undefined);
  });
});

describe('weekly task schema — runAt field', () => {
  const makeTask = () => {
    const goal = createGoal('Test goal', '3mo');
    const obj = createObjective('Test objective', goal.id);
    return createTask({ title: 'Publish one X.com post', prompt: 'Publish one X.com post' }, obj.id);
  };

  it('accepts a task with a valid ISO 8601 runAt', () => {
    const task = makeTask();
    task.runAt = '2026-04-20T09:00:00Z';
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    assert.equal(validateWeeklyPlan(plan).valid, true);
  });

  it('rejects a malformed runAt (not a date-time)', () => {
    const task = makeTask();
    task.runAt = 'tomorrow morning';
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /runAt/.test(JSON.stringify(e))));
  });

  it('createTask attaches runAt when provided', () => {
    const goal = createGoal('Test goal', '3mo');
    const obj = createObjective('Test objective', goal.id);
    const task = createTask({ title: 'Publish', prompt: 'Publish' }, obj.id, {
      runAt: '2026-04-20T14:00:00Z',
    });
    assert.equal(task.runAt, '2026-04-20T14:00:00Z');
  });

  it('createTask omits runAt when not provided', () => {
    const goal = createGoal('Test goal', '3mo');
    const obj = createObjective('Test objective', goal.id);
    const task = createTask({ title: 'No schedule', prompt: 'No schedule' }, obj.id);
    assert.equal(task.runAt, undefined);
  });

  it('accepts combined track + runAt on the same task', () => {
    const task = makeTask();
    task.track = 'x-com';
    task.runAt = '2026-04-20T09:00:00Z';
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    assert.equal(validateWeeklyPlan(plan).valid, true);
  });
});

describe('weekly task schema — reserved objectiveId values', () => {
  const makeReviewTask = (objectiveId, runAt = '2026-04-21T17:00:00Z') => ({
    id: `task-${Math.random().toString(16).slice(2, 10)}`,
    title: 'Review task',
    prompt: 'Review task',
    objectiveId,
    priority: 'high',
    status: 'pending',
    runAt,
  });

  // --- DAILY_REVIEW_OBJECTIVE_ID ---

  it('exports DAILY_REVIEW_OBJECTIVE_ID as "daily-review"', () => {
    assert.equal(DAILY_REVIEW_OBJECTIVE_ID, 'daily-review');
  });

  it('schema accepts daily-review objectiveId', () => {
    const task = makeReviewTask(DAILY_REVIEW_OBJECTIVE_ID);
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('createTask accepts DAILY_REVIEW_OBJECTIVE_ID as objectiveId', () => {
    const task = createTask({ title: 'End-of-day reflection', prompt: 'End-of-day reflection' }, DAILY_REVIEW_OBJECTIVE_ID);
    assert.equal(task.objectiveId, DAILY_REVIEW_OBJECTIVE_ID);
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    assert.equal(validateWeeklyPlan(plan).valid, true);
  });

  // --- WEEKLY_REVIEW_OBJECTIVE_ID ---

  it('exports WEEKLY_REVIEW_OBJECTIVE_ID as "weekly-review"', () => {
    assert.equal(WEEKLY_REVIEW_OBJECTIVE_ID, 'weekly-review');
  });

  it('schema accepts weekly-review objectiveId', () => {
    const task = makeReviewTask(WEEKLY_REVIEW_OBJECTIVE_ID);
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('createTask accepts WEEKLY_REVIEW_OBJECTIVE_ID as objectiveId', () => {
    const task = createTask({ title: 'End-of-week review', prompt: 'End-of-week review' }, WEEKLY_REVIEW_OBJECTIVE_ID);
    assert.equal(task.objectiveId, WEEKLY_REVIEW_OBJECTIVE_ID);
    const plan = createWeeklyPlan('2026-W17', '2026-04', [task]);
    assert.equal(validateWeeklyPlan(plan).valid, true);
  });

  // --- REVIEW_OBJECTIVE_IDS array ---

  it('REVIEW_OBJECTIVE_IDS contains both reserved values', () => {
    assert.ok(Array.isArray(REVIEW_OBJECTIVE_IDS));
    assert.ok(REVIEW_OBJECTIVE_IDS.includes(DAILY_REVIEW_OBJECTIVE_ID));
    assert.ok(REVIEW_OBJECTIVE_IDS.includes(WEEKLY_REVIEW_OBJECTIVE_ID));
    assert.equal(REVIEW_OBJECTIVE_IDS.length, 2);
  });

  it('schema accepts a plan that mixes regular and review tasks', () => {
    const goal = createGoal('Ship feature', '1mo');
    const obj = createGoal('Build API', '1mo');
    const regularTask = createTask({ title: 'Implement endpoint', prompt: 'Implement endpoint' }, obj.id);
    const dailyTask = createTask({ title: 'Daily reflection', prompt: 'Daily reflection' }, DAILY_REVIEW_OBJECTIVE_ID);
    const weeklyTask = createTask({ title: 'Week-in-review', prompt: 'Week-in-review' }, WEEKLY_REVIEW_OBJECTIVE_ID);
    weeklyTask.runAt = '2026-04-24T16:00:00Z';

    const plan = createWeeklyPlan('2026-W17', '2026-04', [regularTask, dailyTask, weeklyTask]);
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  // --- isReviewObjectiveId helper ---

  it('isReviewObjectiveId returns true for DAILY_REVIEW_OBJECTIVE_ID', () => {
    assert.equal(isReviewObjectiveId(DAILY_REVIEW_OBJECTIVE_ID), true);
  });

  it('isReviewObjectiveId returns true for WEEKLY_REVIEW_OBJECTIVE_ID', () => {
    assert.equal(isReviewObjectiveId(WEEKLY_REVIEW_OBJECTIVE_ID), true);
  });

  it('isReviewObjectiveId returns true for the raw string "daily-review"', () => {
    assert.equal(isReviewObjectiveId('daily-review'), true);
  });

  it('isReviewObjectiveId returns true for the raw string "weekly-review"', () => {
    assert.equal(isReviewObjectiveId('weekly-review'), true);
  });

  it('isReviewObjectiveId returns false for a regular objectiveId', () => {
    assert.equal(isReviewObjectiveId('2026-04'), false);
    assert.equal(isReviewObjectiveId('obj-abc12345'), false);
  });

  it('isReviewObjectiveId returns false for undefined', () => {
    assert.equal(isReviewObjectiveId(undefined), false);
  });

  it('isReviewObjectiveId returns false for empty string', () => {
    assert.equal(isReviewObjectiveId(''), false);
  });

  it('isReviewObjectiveId returns false for a non-string value', () => {
    assert.equal(isReviewObjectiveId(null), false);
    assert.equal(isReviewObjectiveId(42), false);
  });
});
