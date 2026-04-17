/**
 * Tests for monthly plan schema with objectives tracing back to goals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMonthlyPlan, validateMonthlyObjective } from './validator.js';
import { createMonthlyPlan, createObjective, createGoal } from '../models/agent.js';
import { OBJECTIVE_STATUSES, MONTHLY_PLAN_STATUSES } from './monthly-plan.schema.js';

describe('monthly plan schema', () => {
  describe('constants', () => {
    it('should define objective statuses', () => {
      assert.deepStrictEqual(OBJECTIVE_STATUSES, ['planned', 'in-progress', 'completed', 'dropped']);
    });

    it('should define monthly plan statuses', () => {
      assert.deepStrictEqual(MONTHLY_PLAN_STATUSES, ['draft', 'active', 'completed', 'archived']);
    });
  });

  describe('monthlyObjectiveSchema', () => {
    it('should accept a valid objective', () => {
      const goal = createGoal('Test goal', '3mo');
      const obj = createObjective('Build core module', goal.id);
      const result = validateMonthlyObjective(obj);
      assert.equal(result.valid, true);
    });

    it('should reject objective without goalId', () => {
      const result = validateMonthlyObjective({
        id: 'obj-abc12345',
        description: 'Missing goal reference',
        status: 'planned',
      });
      assert.equal(result.valid, false);
    });

    it('should reject objective with invalid goalId pattern', () => {
      const result = validateMonthlyObjective({
        id: 'obj-abc12345',
        description: 'Bad goal ref',
        goalId: 'not-a-goal-id',
        status: 'planned',
      });
      assert.equal(result.valid, false);
    });

    it('should accept all valid objective statuses', () => {
      for (const status of OBJECTIVE_STATUSES) {
        const goal = createGoal('Test', '1mo');
        const obj = createObjective('Status test', goal.id);
        obj.status = status;
        const result = validateMonthlyObjective(obj);
        assert.equal(result.valid, true, `Status '${status}' should be valid`);
      }
    });

    it('should accept objective with optional completedAt', () => {
      const goal = createGoal('Test', '1mo');
      const obj = createObjective('Done objective', goal.id);
      obj.status = 'completed';
      obj.completedAt = new Date().toISOString();
      const result = validateMonthlyObjective(obj);
      assert.equal(result.valid, true);
    });

    it('should reject unknown properties on objective', () => {
      const goal = createGoal('Test', '1mo');
      const obj = createObjective('Extra', goal.id);
      obj.unknownField = true;
      const result = validateMonthlyObjective(obj);
      assert.equal(result.valid, false);
    });
  });

  describe('monthlyPlanSchema', () => {
    it('should accept a valid monthly plan with status', () => {
      const goal = createGoal('Test goal', '3mo');
      const obj = createObjective('Build module', goal.id);
      const plan = createMonthlyPlan('2026-04', [obj]);
      const result = validateMonthlyPlan(plan);
      assert.equal(result.valid, true);
      assert.equal(result.errors, null);
    });

    it('should default monthly plan status to active', () => {
      const goal = createGoal('Test', '3mo');
      const obj = createObjective('Objective', goal.id);
      const plan = createMonthlyPlan('2026-04', [obj]);
      assert.equal(plan.status, 'active');
    });

    it('should accept draft status', () => {
      const goal = createGoal('Test', '3mo');
      const obj = createObjective('Objective', goal.id);
      const plan = createMonthlyPlan('2026-04', [obj], { status: 'draft' });
      assert.equal(plan.status, 'draft');
      const result = validateMonthlyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should accept all valid plan statuses', () => {
      for (const status of MONTHLY_PLAN_STATUSES) {
        const goal = createGoal('Test', '1yr');
        const obj = createObjective('Obj', goal.id);
        const plan = createMonthlyPlan('2026-04', [obj], { status });
        const result = validateMonthlyPlan(plan);
        assert.equal(result.valid, true, `Plan status '${status}' should be valid`);
      }
    });

    it('should accept plan with optional summary', () => {
      const goal = createGoal('Test', '3mo');
      const obj = createObjective('Objective', goal.id);
      const plan = createMonthlyPlan('2026-04', [obj], {
        summary: 'Focus on core infrastructure this month',
      });
      assert.ok(plan.summary);
      const result = validateMonthlyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should reject plan without status', () => {
      const goal = createGoal('Test', '3mo');
      const obj = createObjective('Obj', goal.id);
      const plan = {
        month: '2026-04',
        objectives: [obj],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const result = validateMonthlyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject plan with invalid month format', () => {
      const goal = createGoal('Test', '3mo');
      const obj = createObjective('Obj', goal.id);
      const plan = createMonthlyPlan('April 2026', [obj]);
      plan.month = 'April 2026';
      const result = validateMonthlyPlan(plan);
      assert.equal(result.valid, false);
    });

    it('should reject plan with empty objectives array', () => {
      const result = validateMonthlyPlan({
        month: '2026-04',
        objectives: [],
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.equal(result.valid, false);
    });

    it('should verify plan traceability — objectives reference valid goal IDs', () => {
      const goal1 = createGoal('Short-term delivery', '1mo');
      const goal2 = createGoal('Long-term architecture', '1yr');
      const obj1 = createObjective('Deliver feature X', goal1.id);
      const obj2 = createObjective('Design system architecture', goal2.id);
      const plan = createMonthlyPlan('2026-04', [obj1, obj2]);

      // Verify traceability
      assert.equal(obj1.goalId, goal1.id);
      assert.equal(obj2.goalId, goal2.id);

      const result = validateMonthlyPlan(plan);
      assert.equal(result.valid, true);
    });

    it('should reject unknown properties on plan', () => {
      const goal = createGoal('Test', '3mo');
      const obj = createObjective('Obj', goal.id);
      const plan = createMonthlyPlan('2026-04', [obj]);
      plan.extraField = 'not allowed';
      const result = validateMonthlyPlan(plan);
      assert.equal(result.valid, false);
    });
  });
});
