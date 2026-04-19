/**
 * Tests for weekly plan schema validation (valid and invalid inputs).
 * Weekly plans contain tasks that trace back to monthly objectives,
 * completing the plan traceability chain: goal -> objective -> task.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateWeeklyPlan } from './validator.js';
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
    return { task: createTask('Do something', obj.id), obj, goal };
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

    it('should default approved to false', () => {
      const { task } = makeTask();
      const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
      assert.equal(plan.approved, false);
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
        description: 'Missing id',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with invalid id pattern', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'bad-id',
        description: 'Bad ID pattern',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task without description', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with empty description', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        description: '',
        objectiveId: 'obj-abc12345',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task without objectiveId', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        description: 'Missing objective ref',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with invalid objectiveId pattern', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        description: 'Bad objective ref',
        objectiveId: 'not-an-obj-id',
        status: 'pending',
      }]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject task with invalid status', () => {
      const plan = createWeeklyPlan('2026-W16', '2026-04', [{
        id: 'task-abc12345',
        description: 'Bad status',
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
      const task = createTask('Implement endpoint', obj.id);

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
      const task1 = createTask('Task for A', obj1.id);
      const task2 = createTask('Task for B', obj2.id);

      const plan = createWeeklyPlan('2026-W16', '2026-04', [task1, task2]);
      const result = validateWeeklyPlan(plan);
      assert.equal(result.valid, true);
      assert.notEqual(task1.objectiveId, task2.objectiveId);
    });
  });
});
