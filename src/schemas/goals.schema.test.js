/**
 * Tests for goals schema with time horizons (1mo/3mo/1yr).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGoal } from './validator.js';
import { createGoal } from '../models/agent.js';
import { GOAL_HORIZONS } from './goals.schema.js';

describe('goals schema', () => {
  describe('GOAL_HORIZONS', () => {
    it('should define exactly three horizons', () => {
      assert.deepStrictEqual(GOAL_HORIZONS, ['1mo', '3mo', '1yr']);
    });
  });

  describe('goalSchema validation', () => {
    it('should accept a valid goal with 1mo horizon', () => {
      const goal = createGoal('Short-term delivery goal', '1mo');
      const result = validateGoal(goal);
      assert.equal(result.valid, true);
      assert.equal(result.errors, null);
    });

    it('should accept a valid goal with 3mo horizon', () => {
      const goal = createGoal('Medium-term milestone', '3mo');
      const result = validateGoal(goal);
      assert.equal(result.valid, true);
    });

    it('should accept a valid goal with 1yr horizon', () => {
      const goal = createGoal('Long-term strategic vision', '1yr');
      const result = validateGoal(goal);
      assert.equal(result.valid, true);
    });

    it('should default to 3mo horizon when not specified', () => {
      const goal = createGoal('Default horizon goal');
      assert.equal(goal.horizon, '3mo');
      const result = validateGoal(goal);
      assert.equal(result.valid, true);
    });

    it('should reject a goal without horizon', () => {
      const goal = {
        id: 'goal-abc12345',
        description: 'Missing horizon field',
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      const result = validateGoal(goal);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.message.includes('horizon') || e.instancePath === ''));
    });

    it('should reject invalid horizon value', () => {
      const goal = {
        id: 'goal-abc12345',
        description: 'Invalid horizon',
        horizon: '6mo',
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      const result = validateGoal(goal);
      assert.equal(result.valid, false);
    });

    it('should reject goal without description', () => {
      const result = validateGoal({
        id: 'goal-abc12345',
        horizon: '1mo',
        status: 'active',
      });
      assert.equal(result.valid, false);
    });

    it('should reject goal with invalid id pattern', () => {
      const result = validateGoal({
        id: 'bad-id',
        description: 'Test',
        horizon: '3mo',
        status: 'active',
      });
      assert.equal(result.valid, false);
    });

    it('should accept goal with optional targetDate', () => {
      const goal = createGoal('Goal with target', '1mo');
      goal.targetDate = '2026-05-15';
      const result = validateGoal(goal);
      assert.equal(result.valid, true);
    });

    it('should reject goal with invalid targetDate format', () => {
      const goal = createGoal('Goal with bad target', '1mo');
      goal.targetDate = 'not-a-date';
      const result = validateGoal(goal);
      assert.equal(result.valid, false);
    });

    it('should accept all valid status values', () => {
      for (const status of ['active', 'completed', 'paused', 'dropped']) {
        const goal = createGoal('Status test', '3mo');
        goal.status = status;
        const result = validateGoal(goal);
        assert.equal(result.valid, true, `Status '${status}' should be valid`);
      }
    });

    it('should reject unknown additional properties', () => {
      const goal = createGoal('Extra props', '3mo');
      goal.extraField = 'not allowed';
      const result = validateGoal(goal);
      assert.equal(result.valid, false);
    });
  });
});
