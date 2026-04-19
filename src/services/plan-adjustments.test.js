/**
 * Tests for adjust-goal skill logic.
 *
 * Subagent-wrapper invariant under test
 * -------------------------------------
 * After the aweek ↔ Claude Code subagent 1-to-1 refactor, every aweek agent
 * is a thin scheduling wrapper around a subagent .md at
 * `.claude/agents/SLUG.md`. The .md is the SOLE source of truth for identity
 * (name, description, system prompt, model, tools, skills, MCP servers); the
 * aweek JSON owns ONLY scheduling concerns — goals, monthly/weekly plans,
 * token budget, inbox, execution logs.
 *
 * The adjust-goal skill is a scheduling-only operation, so these tests assert
 * that running goal/monthly/weekly adjustments:
 *   1. mutates ONLY the scheduling fields of the aweek JSON,
 *   2. leaves the agent's identity-bearing fields (`id`, `subagentRef`,
 *      `createdAt`) byte-for-byte unchanged,
 *   3. never reads, writes, or otherwise touches the subagent .md file.
 *
 * Per the `single_source_of_truth` evaluation principle, identity is not
 * duplicated into aweek JSON anymore — there is no `identity`, `name`,
 * `role`, or `systemPrompt` field on the agent config. So these tests use
 * the slug-based `createAgentConfig({ subagentRef })` factory and pin
 * a subagent .md on disk to verify it survives the adjustment unchanged.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
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
  buildSubagentMarkdown,
  subagentFilePath,
} from '../subagents/subagent-file.js';
import {
  validateGoalAdjustment,
  validateMonthlyAdjustment,
  validateWeeklyAdjustment,
  applyGoalAdjustment,
  applyMonthlyAdjustment,
  applyWeeklyAdjustment,
  adjustGoals,
  formatAdjustmentSummary,
} from './plan-adjustments.js';

const TEST_SLUG = 'test-agent';

/**
 * Build a full agent config with goals, monthly plan, and a weekly plan
 * for testing.
 *
 * Weekly plans are no longer embedded on the agent config — they live
 * in `WeeklyPlanStore`. The helper returns the weekly plan and a
 * mutable `weeklyPlans` array so callers can hand them to the apply
 * functions without having to reassemble the shape every time.
 */
function buildTestAgent({ subagentRef = TEST_SLUG } = {}) {
  const config = createAgentConfig({
    subagentRef,
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
  const weeklyPlans = [weeklyPlan];

  return { config, weeklyPlans, weeklyPlan, goal1, goal2, obj1, obj2, task1, task2 };
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
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'add', week: '2026-W16', description: 'New task', objectiveId: obj1.id },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, true);
  });

  it('rejects add with nonexistent objectiveId', () => {
    const { config, weeklyPlans } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'add', week: '2026-W16', description: 'Task', objectiveId: 'obj-nonexistent' },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Objective not found')));
  });

  it('rejects when weekly plan does not exist', () => {
    const { config, weeklyPlans } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'add', week: '2026-W99', description: 'Task', objectiveId: 'obj-x' },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('No weekly plan')));
  });

  it('validates a valid update task', () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'update', week: '2026-W16', taskId: task1.id, status: 'in-progress' },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, true);
  });

  it('rejects update with nonexistent taskId', () => {
    const { config, weeklyPlans } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'update', week: '2026-W16', taskId: 'task-nonexistent', status: 'completed' },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Task not found')));
  });

  it('rejects invalid week format', () => {
    const { config, weeklyPlans } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'add', week: 'week16', description: 'Task', objectiveId: 'obj-x' },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('YYYY-Www')));
  });

  it('accepts a valid track on add', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'add',
        week: '2026-W16',
        description: 'Publish X post',
        objectiveId: obj1.id,
        track: 'x-com',
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, true);
  });

  it('rejects an empty-string track on add', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'add',
        week: '2026-W16',
        description: 'X',
        objectiveId: obj1.id,
        track: '',
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /track/.test(e)));
  });

  it('rejects an over-long track on add', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'add',
        week: '2026-W16',
        description: 'X',
        objectiveId: obj1.id,
        track: 'a'.repeat(65),
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
  });

  it('accepts a track update (setting track)', () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'update',
        week: '2026-W16',
        taskId: task1.id,
        track: 'x-com',
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, true);
  });

  it('accepts null track on update (clear the track)', () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'update',
        week: '2026-W16',
        taskId: task1.id,
        track: null,
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, true);
  });

  it('rejects update with no fields changed', () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      { action: 'update', week: '2026-W16', taskId: task1.id },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) =>
        /status, description, track, or runAt/.test(e),
      ),
    );
  });

  it('accepts track on seed tasks in create', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'create',
        week: '2026-W17',
        month: '2026-04',
        tasks: [
          { description: 'X post 1', objectiveId: obj1.id, track: 'x-com' },
          { description: 'Reddit 1', objectiveId: obj1.id, track: 'reddit' },
        ],
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, true);
  });

  it('rejects an empty-string track on a seed task in create', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'create',
        week: '2026-W17',
        month: '2026-04',
        tasks: [{ description: 'X', objectiveId: obj1.id, track: '' }],
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /tasks\[0\]\.track/.test(e)));
  });

  it('accepts a valid runAt on add', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'add',
        week: '2026-W16',
        description: 'X',
        objectiveId: obj1.id,
        runAt: '2026-04-20T09:00:00Z',
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, true);
  });

  it('rejects a malformed runAt on add', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'add',
        week: '2026-W16',
        description: 'X',
        objectiveId: obj1.id,
        runAt: 'tomorrow',
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /runAt/.test(e)));
  });

  it('accepts runAt on update; null clears', () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const setResult = validateWeeklyAdjustment(
      {
        action: 'update',
        week: '2026-W16',
        taskId: task1.id,
        runAt: '2026-04-20T14:00:00Z',
      },
      config,
      weeklyPlans,
    );
    assert.equal(setResult.valid, true);
    const clearResult = validateWeeklyAdjustment(
      { action: 'update', week: '2026-W16', taskId: task1.id, runAt: null },
      config,
      weeklyPlans,
    );
    assert.equal(clearResult.valid, true);
  });

  it('accepts runAt on seed tasks in create', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'create',
        week: '2026-W17',
        month: '2026-04',
        tasks: [
          {
            description: 'Post 1',
            objectiveId: obj1.id,
            track: 'x-com',
            runAt: '2026-04-20T09:00:00Z',
          },
        ],
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, true);
  });

  it('rejects malformed runAt on a seed task in create', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const result = validateWeeklyAdjustment(
      {
        action: 'create',
        week: '2026-W17',
        month: '2026-04',
        tasks: [
          { description: 'Post', objectiveId: obj1.id, runAt: '2026-04-20 09:00' },
        ],
      },
      config,
      weeklyPlans,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /tasks\[0\]\.runAt/.test(e)));
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

  it('does not mutate identity-bearing fields when adding a goal (subagent-wrapper invariant)', () => {
    const { config } = buildTestAgent();
    // Snapshot every field that belongs to the subagent identity contract.
    // After the refactor the agent JSON only carries `id`, `subagentRef`,
    // and `createdAt` as identity-related stable values — there is no
    // identity blob anymore. None of these may move under a goal write.
    const idBefore = config.id;
    const refBefore = config.subagentRef;
    const createdBefore = config.createdAt;

    applyGoalAdjustment(config, { action: 'add', description: 'New', horizon: '1mo' });

    assert.equal(config.id, idBefore, 'id must not change');
    assert.equal(config.subagentRef, refBefore, 'subagentRef must not change');
    assert.equal(config.createdAt, createdBefore, 'createdAt must not change');
    // Defensive: make sure nobody re-introduced a denormalised identity blob.
    assert.equal(config.identity, undefined, 'identity must not be reintroduced on the JSON wrapper');
    assert.equal(config.name, undefined, 'name must live in the .md only');
    assert.equal(config.role, undefined, 'role must live in the .md only');
    assert.equal(config.systemPrompt, undefined, 'systemPrompt must live in the .md only');
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
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const before = weeklyPlans[0].tasks.length;
    const r = applyWeeklyAdjustment(
      config,
      {
        action: 'add',
        week: '2026-W16',
        description: 'New task',
        objectiveId: obj1.id,
      },
      weeklyPlans,
    );
    assert.equal(r.applied, true);
    assert.equal(weeklyPlans[0].tasks.length, before + 1);
    assert.ok(r.result.id.startsWith('task-'));
  });

  it('updates a task status to completed', () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const r = applyWeeklyAdjustment(
      config,
      {
        action: 'update',
        week: '2026-W16',
        taskId: task1.id,
        status: 'completed',
      },
      weeklyPlans,
    );
    assert.equal(r.applied, true);
    assert.equal(r.result.status, 'completed');
    assert.ok(r.result.completedAt);
  });

  it('updates a task description', () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const r = applyWeeklyAdjustment(
      config,
      {
        action: 'update',
        week: '2026-W16',
        taskId: task1.id,
        description: 'Revised task',
      },
      weeklyPlans,
    );
    assert.equal(r.applied, true);
    assert.equal(r.result.description, 'Revised task');
  });

  it('fails for nonexistent week', () => {
    const { config, weeklyPlans, obj1 } = buildTestAgent();
    const r = applyWeeklyAdjustment(
      config,
      {
        action: 'add',
        week: '2026-W99',
        description: 'Task',
        objectiveId: obj1.id,
      },
      weeklyPlans,
    );
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
    const { config, weeklyPlans, weeklyPlan, goal1, goal2, obj1, obj2, task1, task2 } = buildTestAgent();
    await store.save(config);
    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    for (const plan of weeklyPlans) {
      await weeklyPlanStore.save(config.id, plan);
    }
    return { config, weeklyPlan, goal1, goal2, obj1, obj2, task1, task2 };
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

    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    const reloadedPlan = await weeklyPlanStore.load(config.id, '2026-W16');
    assert.equal(reloadedPlan.tasks.length, 3);
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
// Subagent-wrapper invariants
//
// The aweek JSON owns scheduling data only. Identity (name, description,
// system prompt, model, tools, skills, MCP servers) lives in the subagent
// .md. These tests pin a subagent .md on disk and verify that adjust-goal
// (the canonical scheduling-only operation) leaves the .md byte-for-byte
// untouched and never extends the persisted JSON with identity fields.
// ---------------------------------------------------------------------------
describe('adjustGoals subagent-wrapper invariants', () => {
  let tmpDir;       // serves as both projectDir and the parent of dataDir
  let dataDir;      // .aweek/agents
  let mdPath;       // .claude/agents/<slug>.md
  let mdContents;   // canonical bytes pinned at setup
  let mdMtimeMs;    // mtime in ms pinned at setup
  let store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aweek-adjust-goal-md-'));
    dataDir = join(tmpDir, '.aweek', 'agents');
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(tmpDir, '.claude', 'agents'), { recursive: true });

    // Write the subagent .md — single source of truth for identity.
    mdContents = buildSubagentMarkdown({
      name: TEST_SLUG,
      description: 'Quality and docs steward',
      systemPrompt:
        'You are the test agent. Improve quality and ship docs.\n' +
        'Mention the slug verbatim when prompted: ' + TEST_SLUG + '.',
    });
    mdPath = subagentFilePath(TEST_SLUG, tmpDir);
    await writeFile(mdPath, mdContents, 'utf8');
    // Pin mtime so we can detect any incidental write later.
    const stBefore = await stat(mdPath);
    mdMtimeMs = stBefore.mtimeMs;

    // Persist the aweek JSON wrapper into the same project tree,
    // and seed the weekly-plan file store so the adjust-goal tests can
    // exercise the weekly branch.
    store = new AgentStore(dataDir);
    const { config, weeklyPlans } = buildTestAgent({ subagentRef: TEST_SLUG });
    await store.save(config);
    const weeklyPlanStore = new WeeklyPlanStore(dataDir);
    for (const plan of weeklyPlans) {
      await weeklyPlanStore.save(config.id, plan);
    }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('leaves the subagent .md byte-for-byte unchanged after a goal adjustment', async () => {
    const result = await adjustGoals({
      agentId: TEST_SLUG,
      goalAdjustments: [{ action: 'add', description: 'Q3 launch', horizon: '3mo' }],
      dataDir,
    });
    assert.equal(result.success, true);

    const after = await readFile(mdPath, 'utf8');
    assert.equal(
      after,
      mdContents,
      'goal adjustment must not rewrite the subagent .md identity file',
    );
    const stAfter = await stat(mdPath);
    assert.equal(
      stAfter.mtimeMs,
      mdMtimeMs,
      'subagent .md mtime must be unchanged — adjust-goal is scheduling-only',
    );
  });

  it('leaves the subagent .md byte-for-byte unchanged after a monthly adjustment', async () => {
    // Need a goalId for the new monthly objective — load and grab one.
    const before = await store.load(TEST_SLUG);
    const goalId = before.goals[0].id;

    const result = await adjustGoals({
      agentId: TEST_SLUG,
      monthlyAdjustments: [
        { action: 'add', month: '2026-04', description: 'Extra objective', goalId },
      ],
      dataDir,
    });
    assert.equal(result.success, true);

    const after = await readFile(mdPath, 'utf8');
    assert.equal(after, mdContents);
    const stAfter = await stat(mdPath);
    assert.equal(stAfter.mtimeMs, mdMtimeMs);
  });

  it('leaves the subagent .md byte-for-byte unchanged after a weekly adjustment', async () => {
    const before = await store.load(TEST_SLUG);
    const objectiveId = before.monthlyPlans[0].objectives[0].id;

    const result = await adjustGoals({
      agentId: TEST_SLUG,
      weeklyAdjustments: [
        { action: 'add', week: '2026-W16', description: 'Extra task', objectiveId },
      ],
      dataDir,
    });
    assert.equal(result.success, true);

    const after = await readFile(mdPath, 'utf8');
    assert.equal(after, mdContents);
    const stAfter = await stat(mdPath);
    assert.equal(stAfter.mtimeMs, mdMtimeMs);
  });

  it('mutates only scheduling fields on the persisted aweek JSON', async () => {
    // Snapshot identity-bearing fields and the budget envelope before mutation.
    const before = await store.load(TEST_SLUG);
    const identitySnapshotBefore = {
      id: before.id,
      subagentRef: before.subagentRef,
      createdAt: before.createdAt,
      weeklyTokenBudget: before.weeklyTokenBudget,
      budgetWeeklyTokenLimit: before.budget.weeklyTokenLimit,
      budgetCurrentUsage: before.budget.currentUsage,
      budgetPaused: before.budget.paused,
      budgetSessionsCount: before.budget.sessions.length,
      inboxCount: before.inbox?.length ?? 0,
    };
    // Confirm no stale identity blob ever existed in the persisted JSON.
    assert.equal(before.identity, undefined);
    assert.equal(before.name, undefined);
    assert.equal(before.role, undefined);
    assert.equal(before.systemPrompt, undefined);

    const goalId = before.goals[0].id;
    const objectiveId = before.monthlyPlans[0].objectives[0].id;

    const result = await adjustGoals({
      agentId: TEST_SLUG,
      goalAdjustments: [
        { action: 'add', description: 'Stretch goal', horizon: '1yr' },
        { action: 'update', goalId, status: 'paused' },
      ],
      monthlyAdjustments: [
        { action: 'update', month: '2026-04', objectiveId, status: 'in-progress' },
      ],
      weeklyAdjustments: [
        { action: 'add', week: '2026-W16', description: 'Polish docs', objectiveId },
      ],
      dataDir,
    });
    assert.equal(result.success, true);

    const after = await store.load(TEST_SLUG);

    // Identity-bearing fields must NOT change.
    assert.equal(after.id, identitySnapshotBefore.id, 'id (= slug) is immutable');
    assert.equal(after.subagentRef, identitySnapshotBefore.subagentRef, 'subagentRef is immutable');
    assert.equal(after.createdAt, identitySnapshotBefore.createdAt, 'createdAt is immutable');

    // Budget envelope must NOT change — adjust-goal is not a budget operation.
    assert.equal(
      after.weeklyTokenBudget,
      identitySnapshotBefore.weeklyTokenBudget,
      'weeklyTokenBudget is unchanged',
    );
    assert.equal(
      after.budget.weeklyTokenLimit,
      identitySnapshotBefore.budgetWeeklyTokenLimit,
      'budget.weeklyTokenLimit is unchanged',
    );
    assert.equal(
      after.budget.currentUsage,
      identitySnapshotBefore.budgetCurrentUsage,
      'budget.currentUsage is unchanged',
    );
    assert.equal(
      after.budget.paused,
      identitySnapshotBefore.budgetPaused,
      'budget.paused is unchanged',
    );
    assert.equal(
      after.budget.sessions.length,
      identitySnapshotBefore.budgetSessionsCount,
      'budget.sessions is unchanged',
    );

    // Inbox is also a scheduling concern OUTSIDE of adjust-goal — must not move.
    assert.equal(
      (after.inbox?.length ?? 0),
      identitySnapshotBefore.inboxCount,
      'inbox is unchanged by adjust-goal',
    );

    // No identity blob may be re-introduced post-write.
    assert.equal(after.identity, undefined, 'identity blob must not be persisted into aweek JSON');
    assert.equal(after.name, undefined, 'name must live in the .md only');
    assert.equal(after.role, undefined, 'role must live in the .md only');
    assert.equal(after.systemPrompt, undefined, 'systemPrompt must live in the .md only');

    // Scheduling fields DID change (sanity check this isn't a no-op).
    assert.equal(after.goals.length, before.goals.length + 1, 'a goal was added');
    assert.equal(
      after.monthlyPlans[0].objectives.find((o) => o.id === objectiveId).status,
      'in-progress',
      'objective status updated',
    );
    // Weekly plans live in the file store — load and count there.
    const weeklyPlanStore = new WeeklyPlanStore(dataDir);
    const planBefore = await weeklyPlanStore.load(TEST_SLUG, '2026-W16');
    // (planBefore reflects what's on disk AFTER mutation; we assert the
    // +1 delta relative to the fixture's seed count of 2.)
    assert.equal(planBefore.tasks.length, 3, 'a task was added');

    // updatedAt is allowed to move (it's a scheduling bookkeeping field, not
    // an identity one) but we don't *require* the timestamp to advance —
    // when the whole call completes inside a single millisecond the new
    // value can equal the old one. The invariant we care about is monotonic:
    // updatedAt must never go backwards.
    assert.ok(
      Date.parse(after.updatedAt) >= Date.parse(before.updatedAt),
      'updatedAt is monotonic (never moves backwards)',
    );
  });

  it('does not create or read the subagent .md when the file is absent', async () => {
    // Remove the .md to prove adjust-goal is filesystem-isolated from
    // identity. The aweek JSON for this slug remains, but the .md does not.
    await rm(mdPath, { force: true });

    const before = await store.load(TEST_SLUG);

    const result = await adjustGoals({
      agentId: TEST_SLUG,
      goalAdjustments: [{ action: 'add', description: 'Even without .md', horizon: '1mo' }],
      dataDir,
    });
    assert.equal(
      result.success,
      true,
      'adjust-goal does not depend on the .md — it only touches aweek JSON',
    );

    // The .md must still be absent — adjust-goal must never write one.
    let mdRecreated = false;
    try {
      await stat(mdPath);
      mdRecreated = true;
    } catch {
      // expected: ENOENT
    }
    assert.equal(mdRecreated, false, 'adjust-goal must not create the subagent .md');

    // And the persisted scheduling-side change is intact.
    const after = await store.load(TEST_SLUG);
    assert.equal(after.goals.length, before.goals.length + 1);
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
