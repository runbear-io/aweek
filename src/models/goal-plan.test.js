/**
 * Tests for goal/plan model building — construction, defaults, serialization.
 * Covers createGoal, createObjective, createMonthlyPlan, createTask,
 * createWeeklyPlan, and createInboxMessage factory functions with focus on:
 *   - Construction: correct field population from arguments
 *   - Defaults: default values applied when optional params omitted
 *   - Serialization: JSON round-trip preserves validity and structure
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
  createInboxMessage,
} from './agent.js';
import {
  validateGoal,
  validateMonthlyObjective,
  validateMonthlyPlan,
  validateWeeklyPlan,
  validateInboxMessage,
} from '../schemas/validator.js';

// ---------------------------------------------------------------------------
// createGoal — construction, defaults, serialization
// ---------------------------------------------------------------------------

describe('createGoal — construction', () => {
  it('populates all required fields from arguments', () => {
    const g = createGoal('Ship v2 of the API', '1yr');
    assert.equal(g.description, 'Ship v2 of the API');
    assert.equal(g.horizon, '1yr');
    assert.equal(g.status, 'active');
    assert.ok(g.id.startsWith('goal-'));
    assert.ok(g.createdAt);
  });

  it('generates unique IDs across multiple calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createGoal('G').id));
    assert.equal(ids.size, 20, 'Expected 20 unique goal IDs');
  });

  it('stores an ISO 8601 createdAt timestamp', () => {
    const g = createGoal('G');
    // Must parse without NaN
    const parsed = new Date(g.createdAt);
    assert.ok(!Number.isNaN(parsed.getTime()), 'createdAt should be a valid date');
  });

  it('accepts each valid horizon value', () => {
    for (const h of ['1mo', '3mo', '1yr']) {
      const g = createGoal('G', h);
      assert.equal(g.horizon, h);
      assert.equal(validateGoal(g).valid, true, `horizon '${h}' should produce a valid goal`);
    }
  });
});

describe('createGoal — defaults', () => {
  it('defaults horizon to 3mo when omitted', () => {
    const g = createGoal('Default horizon goal');
    assert.equal(g.horizon, '3mo');
  });

  it('defaults status to active', () => {
    const g = createGoal('Active by default');
    assert.equal(g.status, 'active');
  });

  it('does not include optional fields (targetDate, completedAt) by default', () => {
    const g = createGoal('No extras');
    assert.equal(g.targetDate, undefined);
    assert.equal(g.completedAt, undefined);
  });
});

describe('createGoal — serialization', () => {
  it('survives JSON round-trip', () => {
    const original = createGoal('Round-trip goal', '1yr');
    const restored = JSON.parse(JSON.stringify(original));
    assert.deepStrictEqual(restored, original);
  });

  it('remains schema-valid after JSON round-trip', () => {
    const original = createGoal('Valid after round-trip', '1mo');
    const restored = JSON.parse(JSON.stringify(original));
    const result = validateGoal(restored);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('serializes to a plain object with no prototype methods', () => {
    const g = createGoal('Plain object');
    const json = JSON.stringify(g);
    const parsed = JSON.parse(json);
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  });
});

// ---------------------------------------------------------------------------
// createObjective — construction, defaults, serialization
// ---------------------------------------------------------------------------

describe('createObjective — construction', () => {
  it('populates description and goalId from arguments', () => {
    const obj = createObjective('Build REST endpoints', 'goal-abc12345');
    assert.equal(obj.description, 'Build REST endpoints');
    assert.equal(obj.goalId, 'goal-abc12345');
    assert.ok(obj.id.startsWith('obj-'));
  });

  it('generates unique IDs across multiple calls', () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => createObjective('O', 'goal-x').id),
    );
    assert.equal(ids.size, 20);
  });

  it('passes schema validation', () => {
    const obj = createObjective('Schema valid', 'goal-test1234');
    const result = validateMonthlyObjective(obj);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

describe('createObjective — defaults', () => {
  it('defaults status to planned', () => {
    const obj = createObjective('Planned by default', 'goal-x');
    assert.equal(obj.status, 'planned');
  });

  it('does not include completedAt by default', () => {
    const obj = createObjective('Not done yet', 'goal-x');
    assert.equal(obj.completedAt, undefined);
  });
});

describe('createObjective — serialization', () => {
  it('survives JSON round-trip', () => {
    const original = createObjective('Round-trip', 'goal-abc12345');
    const restored = JSON.parse(JSON.stringify(original));
    assert.deepStrictEqual(restored, original);
  });

  it('remains schema-valid after JSON round-trip', () => {
    const original = createObjective('Valid RT', 'goal-abc12345');
    const restored = JSON.parse(JSON.stringify(original));
    const result = validateMonthlyObjective(restored);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// createMonthlyPlan — construction, defaults, serialization
// ---------------------------------------------------------------------------

describe('createMonthlyPlan — construction', () => {
  it('populates month and objectives from arguments', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const plan = createMonthlyPlan('2026-04', [obj]);
    assert.equal(plan.month, '2026-04');
    assert.equal(plan.objectives.length, 1);
    assert.equal(plan.objectives[0].id, obj.id);
  });

  it('stores ISO 8601 timestamps for createdAt and updatedAt', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const plan = createMonthlyPlan('2026-04', [obj]);
    assert.ok(!Number.isNaN(new Date(plan.createdAt).getTime()));
    assert.ok(!Number.isNaN(new Date(plan.updatedAt).getTime()));
  });

  it('accepts multiple objectives', () => {
    const objs = [
      createObjective('A', 'goal-aaa11111'),
      createObjective('B', 'goal-bbb22222'),
      createObjective('C', 'goal-aaa11111'),
    ];
    const plan = createMonthlyPlan('2026-05', objs);
    assert.equal(plan.objectives.length, 3);
  });

  it('accepts optional summary', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const plan = createMonthlyPlan('2026-06', [obj], { summary: 'Focus on API work' });
    assert.equal(plan.summary, 'Focus on API work');
  });

  it('accepts optional status override', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const plan = createMonthlyPlan('2026-06', [obj], { status: 'draft' });
    assert.equal(plan.status, 'draft');
  });

  it('passes schema validation with all valid statuses', () => {
    const statuses = ['draft', 'active', 'completed', 'archived'];
    for (const status of statuses) {
      const obj = createObjective('O', 'goal-aaa11111');
      const plan = createMonthlyPlan('2026-04', [obj], { status });
      const result = validateMonthlyPlan(plan);
      assert.equal(result.valid, true, `status '${status}' should be valid`);
    }
  });
});

describe('createMonthlyPlan — defaults', () => {
  it('defaults status to active', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const plan = createMonthlyPlan('2026-04', [obj]);
    assert.equal(plan.status, 'active');
  });

  it('does not include summary when omitted', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const plan = createMonthlyPlan('2026-04', [obj]);
    assert.equal(plan.summary, undefined);
  });

  it('defaults without opts object at all', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const plan = createMonthlyPlan('2026-04', [obj]);
    assert.equal(plan.status, 'active');
    assert.equal(plan.summary, undefined);
  });
});

describe('createMonthlyPlan — serialization', () => {
  it('survives JSON round-trip', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const original = createMonthlyPlan('2026-04', [obj], { summary: 'Test' });
    const restored = JSON.parse(JSON.stringify(original));
    assert.deepStrictEqual(restored, original);
  });

  it('remains schema-valid after JSON round-trip', () => {
    const obj = createObjective('O', 'goal-aaa11111');
    const original = createMonthlyPlan('2026-04', [obj]);
    const restored = JSON.parse(JSON.stringify(original));
    const result = validateMonthlyPlan(restored);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('preserves nested objective structure through round-trip', () => {
    const obj1 = createObjective('First', 'goal-aaa11111');
    const obj2 = createObjective('Second', 'goal-bbb22222');
    const original = createMonthlyPlan('2026-07', [obj1, obj2]);
    const restored = JSON.parse(JSON.stringify(original));
    assert.equal(restored.objectives.length, 2);
    assert.equal(restored.objectives[0].description, 'First');
    assert.equal(restored.objectives[1].goalId, 'goal-bbb22222');
  });
});

// ---------------------------------------------------------------------------
// createTask — construction, defaults, serialization
// ---------------------------------------------------------------------------

describe('createTask — construction', () => {
  it('populates description and objectiveId from arguments', () => {
    const task = createTask('Implement login', 'obj-abc12345');
    assert.equal(task.description, 'Implement login');
    assert.equal(task.objectiveId, 'obj-abc12345');
    assert.ok(task.id.startsWith('task-'));
  });

  it('generates unique IDs across multiple calls', () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => createTask('T', 'obj-x').id),
    );
    assert.equal(ids.size, 20);
  });
});

describe('createTask — defaults', () => {
  it('defaults status to pending', () => {
    const task = createTask('Pending task', 'obj-abc12345');
    assert.equal(task.status, 'pending');
  });

  it('does not include optional fields (completedAt, delegatedTo) by default', () => {
    const task = createTask('Simple task', 'obj-abc12345');
    assert.equal(task.completedAt, undefined);
    assert.equal(task.delegatedTo, undefined);
  });
});

describe('createTask — serialization', () => {
  it('survives JSON round-trip', () => {
    const original = createTask('RT task', 'obj-abc12345');
    const restored = JSON.parse(JSON.stringify(original));
    assert.deepStrictEqual(restored, original);
  });

  it('task within a weekly plan remains valid after round-trip', () => {
    const task = createTask('Nested task', 'obj-abc12345');
    const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
    const restored = JSON.parse(JSON.stringify(plan));
    const result = validateWeeklyPlan(restored);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// createWeeklyPlan — construction, defaults, serialization
// ---------------------------------------------------------------------------

describe('createWeeklyPlan — construction', () => {
  it('populates week, month, and tasks from arguments', () => {
    const task = createTask('T', 'obj-abc12345');
    const plan = createWeeklyPlan('2026-W16', '2026-04', [task]);
    assert.equal(plan.week, '2026-W16');
    assert.equal(plan.month, '2026-04');
    assert.equal(plan.tasks.length, 1);
  });

  it('stores ISO 8601 timestamps', () => {
    const plan = createWeeklyPlan('2026-W16', '2026-04', []);
    assert.ok(!Number.isNaN(new Date(plan.createdAt).getTime()));
    assert.ok(!Number.isNaN(new Date(plan.updatedAt).getTime()));
  });

  it('accepts empty tasks array', () => {
    const plan = createWeeklyPlan('2026-W16', '2026-04', []);
    assert.deepStrictEqual(plan.tasks, []);
    const result = validateWeeklyPlan(plan);
    assert.equal(result.valid, true);
  });

  it('accepts multiple tasks', () => {
    const tasks = [
      createTask('A', 'obj-aaa11111'),
      createTask('B', 'obj-bbb22222'),
      createTask('C', 'obj-aaa11111'),
    ];
    const plan = createWeeklyPlan('2026-W16', '2026-04', tasks);
    assert.equal(plan.tasks.length, 3);
  });
});

describe('createWeeklyPlan — defaults', () => {
  it('defaults approved to false', () => {
    const plan = createWeeklyPlan('2026-W16', '2026-04', []);
    assert.equal(plan.approved, false);
  });

  it('does not include approvedAt by default', () => {
    const plan = createWeeklyPlan('2026-W16', '2026-04', []);
    assert.equal(plan.approvedAt, undefined);
  });
});

describe('createWeeklyPlan — serialization', () => {
  it('survives JSON round-trip', () => {
    const task = createTask('T', 'obj-abc12345');
    const original = createWeeklyPlan('2026-W16', '2026-04', [task]);
    const restored = JSON.parse(JSON.stringify(original));
    assert.deepStrictEqual(restored, original);
  });

  it('remains schema-valid after JSON round-trip', () => {
    const task = createTask('Validated', 'obj-abc12345');
    const original = createWeeklyPlan('2026-W16', '2026-04', [task]);
    const restored = JSON.parse(JSON.stringify(original));
    const result = validateWeeklyPlan(restored);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('preserves nested task structure through round-trip', () => {
    const t1 = createTask('First', 'obj-aaa11111');
    const t2 = createTask('Second', 'obj-bbb22222');
    const original = createWeeklyPlan('2026-W17', '2026-04', [t1, t2]);
    const restored = JSON.parse(JSON.stringify(original));
    assert.equal(restored.tasks.length, 2);
    assert.equal(restored.tasks[0].description, 'First');
    assert.equal(restored.tasks[1].objectiveId, 'obj-bbb22222');
  });
});

// ---------------------------------------------------------------------------
// createInboxMessage — construction, defaults, serialization
// ---------------------------------------------------------------------------

describe('createInboxMessage — construction', () => {
  it('populates from, to, taskDescription from arguments', () => {
    const msg = createInboxMessage('agent-helper-abc123', 'agent-recv-xyz789', 'Review PR #42');
    assert.equal(msg.from, 'agent-helper-abc123');
    assert.equal(msg.to, 'agent-recv-xyz789');
    assert.equal(msg.taskDescription, 'Review PR #42');
    assert.ok(msg.id.startsWith('msg-'));
  });

  it('generates unique IDs across multiple calls', () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => createInboxMessage('agent-x-12345678', 'agent-y-12345678', 'M').id),
    );
    assert.equal(ids.size, 20);
  });

  it('stores an ISO 8601 createdAt timestamp', () => {
    const msg = createInboxMessage('agent-x-12345678', 'agent-y-12345678', 'M');
    assert.ok(!Number.isNaN(new Date(msg.createdAt).getTime()));
  });

  it('includes context when provided via opts', () => {
    const msg = createInboxMessage('agent-x-12345678', 'agent-y-12345678', 'Do X', { context: 'Extra context here' });
    assert.equal(msg.context, 'Extra context here');
  });

  it('passes schema validation', () => {
    const msg = createInboxMessage('agent-helper-abc123', 'agent-recv-xyz789', 'Validate me');
    const result = validateInboxMessage(msg);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it('passes schema validation with context', () => {
    const msg = createInboxMessage('agent-helper-abc123', 'agent-recv-xyz789', 'With context', { context: 'Some ctx' });
    const result = validateInboxMessage(msg);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

describe('createInboxMessage — defaults', () => {
  it('defaults status to pending', () => {
    const msg = createInboxMessage('agent-x-12345678', 'agent-y-12345678', 'M');
    assert.equal(msg.status, 'pending');
  });

  it('defaults type to task-delegation', () => {
    const msg = createInboxMessage('agent-x-12345678', 'agent-y-12345678', 'M');
    assert.equal(msg.type, 'task-delegation');
  });

  it('defaults priority to medium', () => {
    const msg = createInboxMessage('agent-x-12345678', 'agent-y-12345678', 'M');
    assert.equal(msg.priority, 'medium');
  });

  it('does not include context when omitted', () => {
    const msg = createInboxMessage('agent-x-12345678', 'agent-y-12345678', 'No context');
    assert.equal(msg.context, undefined);
  });
});

describe('createInboxMessage — serialization', () => {
  it('survives JSON round-trip without context', () => {
    const original = createInboxMessage('agent-helper-abc123', 'agent-recv-xyz789', 'RT msg');
    const restored = JSON.parse(JSON.stringify(original));
    assert.deepStrictEqual(restored, original);
  });

  it('survives JSON round-trip with context', () => {
    const original = createInboxMessage('agent-helper-abc123', 'agent-recv-xyz789', 'RT msg', { context: 'ctx' });
    const restored = JSON.parse(JSON.stringify(original));
    assert.deepStrictEqual(restored, original);
  });

  it('remains schema-valid after JSON round-trip', () => {
    const original = createInboxMessage('agent-helper-abc123', 'agent-recv-xyz789', 'Valid RT');
    const restored = JSON.parse(JSON.stringify(original));
    const result = validateInboxMessage(restored);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// Cross-model serialization: full plan hierarchy round-trips
// ---------------------------------------------------------------------------

describe('full plan hierarchy — serialization', () => {
  it('goal -> objective -> monthly plan round-trips correctly', () => {
    const goal = createGoal('Ship feature', '1mo');
    const obj = createObjective('Build backend', goal.id);
    const plan = createMonthlyPlan('2026-04', [obj]);

    const hierarchy = { goal, plan };
    const restored = JSON.parse(JSON.stringify(hierarchy));

    assert.deepStrictEqual(restored.goal, goal);
    assert.deepStrictEqual(restored.plan, plan);
    // Traceability preserved
    assert.equal(restored.plan.objectives[0].goalId, restored.goal.id);
  });

  it('goal -> objective -> task -> weekly plan round-trips correctly', () => {
    const goal = createGoal('Quarterly OKR', '3mo');
    const obj = createObjective('Sprint deliverable', goal.id);
    const task = createTask('Write tests', obj.id);
    const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task]);
    const monthlyPlan = createMonthlyPlan('2026-04', [obj]);

    const snapshot = { goal, monthlyPlan, weeklyPlan };
    const restored = JSON.parse(JSON.stringify(snapshot));

    // Traceability chain preserved through serialization
    assert.equal(restored.weeklyPlan.tasks[0].objectiveId, restored.monthlyPlan.objectives[0].id);
    assert.equal(restored.monthlyPlan.objectives[0].goalId, restored.goal.id);

    // Individual schemas still valid
    assert.equal(validateGoal(restored.goal).valid, true);
    assert.equal(validateMonthlyPlan(restored.monthlyPlan).valid, true);
    assert.equal(validateWeeklyPlan(restored.weeklyPlan).valid, true);
  });

  it('complex multi-goal, multi-plan hierarchy serializes correctly', () => {
    const g1 = createGoal('Short-term', '1mo');
    const g2 = createGoal('Long-term', '1yr');
    const obj1 = createObjective('Obj for g1', g1.id);
    const obj2 = createObjective('Obj for g2', g2.id);
    const obj3 = createObjective('Another for g1', g1.id);
    const mp1 = createMonthlyPlan('2026-04', [obj1, obj2]);
    const mp2 = createMonthlyPlan('2026-05', [obj3], { summary: 'Follow-up month' });
    const t1 = createTask('Task A', obj1.id);
    const t2 = createTask('Task B', obj2.id);
    const wp = createWeeklyPlan('2026-W16', '2026-04', [t1, t2]);

    // This is a pure serialisation test — the hierarchy is kept as a
    // plain bag for round-trip verification. It intentionally does not
    // shape the object like an agent config (which no longer carries
    // `weeklyPlans` as a field).
    const full = { goals: [g1, g2], monthlyPlans: [mp1, mp2], weeklyPlans: [wp] };
    const restored = JSON.parse(JSON.stringify(full));

    assert.equal(restored.goals.length, 2);
    assert.equal(restored.monthlyPlans.length, 2);
    assert.equal(restored.weeklyPlans[0].tasks.length, 2);
    assert.equal(restored.monthlyPlans[1].summary, 'Follow-up month');

    // All individual pieces validate
    for (const g of restored.goals) {
      assert.equal(validateGoal(g).valid, true);
    }
    for (const mp of restored.monthlyPlans) {
      assert.equal(validateMonthlyPlan(mp).valid, true);
    }
    assert.equal(validateWeeklyPlan(restored.weeklyPlans[0]).valid, true);
  });
});
