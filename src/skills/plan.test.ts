/**
 * Tests for the `plan` skill adapter.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  adjustPlan,
  approve,
  reject,
  edit,
  reviewPlan,
  formatAdjustmentResult,
  detectLayoutAmbiguity,
  autoApprovePlan,
  // Skip-questions escape hatch
  generateSkipAssumptions,
  formatAssumptionsBlock,
  generateAssumptionForTrigger,
  // Re-exports
  adjustGoals,
  formatAdjustmentSummary,
  validateGoalAdjustment,
  validateMonthlyAdjustment,
  validateWeeklyAdjustment,
  applyGoalAdjustment,
  applyMonthlyAdjustment,
  applyWeeklyAdjustment,
  APPROVAL_DECISIONS,
  findPendingPlan,
  formatPlanForReview,
  validateDecision,
  validateEdits,
  applyEdits,
  processApproval,
  formatApprovalResult,
  loadPlanForReview,
} from './plan.js';
import { writePlan } from '../storage/plan-markdown-store.js';
import * as adjustmentsService from '../services/plan-adjustments.js';
import * as approvalService from '../services/plan-approval.js';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';

const TEST_SLUG = 'test-agent';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function buildTestAgent({ subagentRef = TEST_SLUG, planApproved = false } = {}) {
  const config = createAgentConfig({
    subagentRef,
    weeklyTokenLimit: 100000,
  });

  const goal = createGoal('Ship the new feature', '3mo');
  config.goals!.push(goal);

  const objective = createObjective('Land MVP this month', goal.id);
  const monthlyPlan = createMonthlyPlan('2026-04', [objective]);
  config.monthlyPlans!.push(monthlyPlan);

  const task = createTask({ title: 'Draft the spec', prompt: 'Draft the spec' }, objective.id, {
    priority: 'high',
    estimatedMinutes: 60,
  });
  const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task]);
  weeklyPlan.approved = planApproved;

  return { config, goal, objective, task, monthlyPlan, weeklyPlan };
}

/** Persist both the config and the weekly plan to the file store. */
async function saveFixture({
  store,
  dir,
  config,
  weeklyPlan,
}: {
  store: AgentStore;
  dir: string;
  config: ReturnType<typeof createAgentConfig>;
  weeklyPlan: ReturnType<typeof createWeeklyPlan>;
}) {
  await store.save(config);
  const weeklyPlanStore = new WeeklyPlanStore(dir);
  await weeklyPlanStore.save(config.id, weeklyPlan);
}

async function withTempStore(fn: (args: { store: AgentStore; dir: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aweek-plan-adapter-'));
  try {
    const store = new AgentStore(dir);
    await fn({ store, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Re-export identity
// ---------------------------------------------------------------------------

describe('plan skill adapter — re-export identity', () => {
  it('re-exports the adjustment pipeline verbatim', () => {
    assert.equal(adjustGoals, adjustmentsService.adjustGoals);
    assert.equal(formatAdjustmentSummary, adjustmentsService.formatAdjustmentSummary);
    assert.equal(validateGoalAdjustment, adjustmentsService.validateGoalAdjustment);
    assert.equal(validateMonthlyAdjustment, adjustmentsService.validateMonthlyAdjustment);
    assert.equal(validateWeeklyAdjustment, adjustmentsService.validateWeeklyAdjustment);
    assert.equal(applyGoalAdjustment, adjustmentsService.applyGoalAdjustment);
    assert.equal(applyMonthlyAdjustment, adjustmentsService.applyMonthlyAdjustment);
    assert.equal(applyWeeklyAdjustment, adjustmentsService.applyWeeklyAdjustment);
  });

  it('re-exports the approval pipeline verbatim', () => {
    assert.deepEqual(APPROVAL_DECISIONS, approvalService.APPROVAL_DECISIONS);
    assert.equal(findPendingPlan, approvalService.findPendingPlan);
    assert.equal(formatPlanForReview, approvalService.formatPlanForReview);
    assert.equal(validateDecision, approvalService.validateDecision);
    assert.equal(validateEdits, approvalService.validateEdits);
    assert.equal(applyEdits, approvalService.applyEdits);
    assert.equal(processApproval, approvalService.processApproval);
    assert.equal(formatApprovalResult, approvalService.formatApprovalResult);
    assert.equal(loadPlanForReview, approvalService.loadPlanForReview);
  });
});

// ---------------------------------------------------------------------------
// formatAdjustmentResult — alias of formatAdjustmentSummary
// ---------------------------------------------------------------------------

describe('plan skill adapter — formatAdjustmentResult', () => {
  it('produces the same output as the underlying formatter for the same input', () => {
    const sampleResults = {
      goals: [{ result: { id: 'goal-x', description: 'Sample goal' } }],
      monthly: [],
      weekly: [],
    };
    assert.equal(
      formatAdjustmentResult(sampleResults),
      adjustmentsService.formatAdjustmentSummary(sampleResults),
    );
  });
});

// ---------------------------------------------------------------------------
// reject — destructive confirmation gate
// ---------------------------------------------------------------------------

describe('plan skill adapter — reject confirmation gate', () => {
  it('refuses to run when confirmed is missing', async () => {
    const result = await reject({ agentId: 'agent-x', dataDir: '/tmp/unused' });
    assert.equal(result.success, false);
    assert.ok(result.errors!.some((e: string) => /explicit confirmation/i.test(e)));
  });

  it('refuses to run when confirmed is false', async () => {
    const result = await reject({
      agentId: 'agent-x',
      dataDir: '/tmp/unused',
      confirmed: false,
    });
    assert.equal(result.success, false);
    assert.ok(result.errors!.some((e: string) => /explicit confirmation/i.test(e)));
  });

  it('refuses to run when confirmed is truthy but not strictly true', async () => {
    for (const sneaky of [1, 'yes', 'true', {}, []]) {
      const result = await reject({
        agentId: 'agent-x',
        dataDir: '/tmp/unused',
        confirmed: sneaky as unknown as boolean,
      });
      assert.equal(
        result.success,
        false,
        `confirmed=${JSON.stringify(sneaky)} should not bypass the gate`,
      );
      assert.ok(result.errors!.some((e: string) => /explicit confirmation/i.test(e)));
    }
  });

  it('refuses to run when called with no params at all', async () => {
    const result = await reject();
    assert.equal(result.success, false);
    assert.ok(result.errors!.some((e: string) => /explicit confirmation/i.test(e)));
  });

  it('strips `confirmed` before delegating to the service', async () => {
    await withTempStore(async ({ store, dir }) => {
      const { config, weeklyPlan } = buildTestAgent();
      await saveFixture({ store, dir, config, weeklyPlan });

      const result = await reject({
        agentId: config.id,
        dataDir: dir,
        rejectionReason: 'not enough detail',
        confirmed: true,
      });

      assert.equal(result.success, true, JSON.stringify(result.errors));
      const reloaded = await store.load(config.id);
      // Pending plan removed — WeeklyPlanStore has no entry left.
      const weeklyPlanStore = new WeeklyPlanStore(dir);
      const remaining = await weeklyPlanStore.loadAll(config.id).catch(() => []);
      assert.equal(remaining.length, 0);
      // No `confirmed` field anywhere on the persisted config.
      const serialised = JSON.stringify(reloaded);
      assert.equal(
        serialised.includes('"confirmed"'),
        false,
        'adapter leaked the `confirmed` flag into persisted state',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end happy paths through the adapter
// ---------------------------------------------------------------------------

describe('plan skill adapter — adjustPlan happy path', () => {
  let tempDir: string;
  let store: AgentStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aweek-plan-adjust-'));
    store = new AgentStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects goalAdjustments and points at plan.md', async () => {
    const { config } = buildTestAgent();
    await store.save(config);

    const result = await adjustPlan({
      agentId: config.id,
      dataDir: tempDir,
      goalAdjustments: [
        { action: 'add', description: 'Improve test coverage', horizon: '1mo' },
      ],
    });

    assert.equal(result.success, false);
    assert.ok(
      result.errors!.some((e: string) => /plan\.md/.test(e)),
      JSON.stringify(result.errors),
    );
    const reloaded = await store.load(config.id);
    assert.equal(reloaded.goals!.length, 1, 'goals must be unchanged');
  });

  it('rejects monthlyAdjustments and points at plan.md', async () => {
    const { config } = buildTestAgent();
    await store.save(config);

    const result = await adjustPlan({
      agentId: config.id,
      dataDir: tempDir,
      monthlyAdjustments: [
        { action: 'add', month: '2026-04', description: 'obj', goalId: config.goals![0]!.id },
      ],
    });

    assert.equal(result.success, false);
    assert.ok(
      result.errors!.some((e: string) => /plan\.md/.test(e)),
      JSON.stringify(result.errors),
    );
  });
});

describe('plan skill adapter — approve / edit / reviewPlan happy paths', () => {
  let tempDir: string;
  let store: AgentStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aweek-plan-approval-'));
    store = new AgentStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reviewPlan returns a formatted summary of the pending plan', async () => {
    const { config, task, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await reviewPlan({ agentId: config.id, dataDir: tempDir });
    assert.equal(result.success, true, JSON.stringify(result.errors));
    assert.ok(result.formatted, 'expected a `formatted` field');
    assert.match(result.formatted!, /2026-W16/);
    assert.ok(
      result.formatted!.includes(task.title),
      'formatted output should mention the task description',
    );
  });

  it('approve marks the plan as approved (scheduling-state only)', async () => {
    const { config, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await approve({
      agentId: config.id,
      dataDir: tempDir,
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persistedPlan = await weeklyPlanStore.load(config.id, weeklyPlan.week!);
    assert.equal(persistedPlan!.approved, true);
  });

  it('edit applies an add-task operation and leaves the plan pending by default', async () => {
    const { config, objective, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await edit({
      agentId: config.id,
      dataDir: tempDir,
      edits: [
        {
          action: 'add',
          title: 'Write the README',
          prompt: 'Write the README',
          objectiveId: objective.id,
          priority: 'medium',
          estimatedMinutes: 45,
        },
      ],
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persistedPlan = await weeklyPlanStore.load(config.id, weeklyPlan.week!);
    assert.equal(persistedPlan!.tasks.length, 2);
    assert.ok(persistedPlan!.tasks.some((t) => t.title === 'Write the README'));
    // Default behavior: still pending.
    assert.equal(persistedPlan!.approved, false);
  });

  it('edit + autoApproveAfterEdit:true approves and persists in one call', async () => {
    const { config, objective, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await edit({
      agentId: config.id,
      dataDir: tempDir,
      edits: [
        {
          action: 'add',
          title: 'Cut a release branch',
          prompt: 'Cut a release branch',
          objectiveId: objective.id,
          priority: 'high',
          estimatedMinutes: 30,
        },
      ],
      autoApproveAfterEdit: true,
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persistedPlan = await weeklyPlanStore.load(config.id, weeklyPlan.week!);
    assert.equal(persistedPlan!.approved, true);
    assert.equal(persistedPlan!.tasks.length, 2);
  });
});

// ---------------------------------------------------------------------------
// detectLayoutAmbiguity — adapter (Sub-AC 7c)
// ---------------------------------------------------------------------------

describe('plan skill adapter — detectLayoutAmbiguity', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aweek-layout-ambiguity-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns absent-signals when plan.md does not exist', async () => {
    const result = await detectLayoutAmbiguity({
      agentsDir: tempDir,
      agentId: 'no-such-agent',
    });
    assert.equal(result.mode, 'mixed');
    assert.equal(result.confident, false);
    assert.equal(result.ambiguityReason, 'absent-signals');
    assert.equal(result.themeScore, 0);
    assert.equal(result.priorityScore, 0);
  });

  it('returns absent-signals when called with no params', async () => {
    const result = await detectLayoutAmbiguity();
    assert.equal(result.confident, false);
    assert.equal(result.ambiguityReason, 'absent-signals');
  });

  it('returns confident theme-days when plan.md has only day-theme signals', async () => {
    await writePlan(tempDir, 'theme-agent', `
# Agent Plan

## Monday
Deep work and coding.

## Tuesday
Code review and PRs.

## Wednesday
Planning.
`);
    const result = await detectLayoutAmbiguity({
      agentsDir: tempDir,
      agentId: 'theme-agent',
    });
    assert.equal(result.mode, 'theme-days');
    assert.equal(result.confident, true);
    assert.equal(result.ambiguityReason, null);
    assert.ok(result.themeScore > 0);
    assert.equal(result.priorityScore, 0);
  });

  it('returns confident priority-waterfall when plan.md has only priority signals', async () => {
    await writePlan(tempDir, 'priority-agent', `
# Agent Plan

Priority 1: Complete the auth module
Priority 2: Write API documentation
Priority 3: Add analytics dashboard
`);
    const result = await detectLayoutAmbiguity({
      agentsDir: tempDir,
      agentId: 'priority-agent',
    });
    assert.equal(result.mode, 'priority-waterfall');
    assert.equal(result.confident, true);
    assert.equal(result.ambiguityReason, null);
    assert.equal(result.themeScore, 0);
    assert.ok(result.priorityScore > 0);
  });

  it('returns conflicting-signals when plan.md has both day-theme and priority signals', async () => {
    await writePlan(tempDir, 'mixed-agent', `
# Agent Plan

## Monday
Priority 1: Ship the auth module.
Priority 2: Write tests.
`);
    const result = await detectLayoutAmbiguity({
      agentsDir: tempDir,
      agentId: 'mixed-agent',
    });
    assert.equal(result.mode, 'mixed');
    assert.equal(result.confident, false);
    assert.equal(result.ambiguityReason, 'conflicting-signals');
    assert.ok(result.themeScore > 0);
    assert.ok(result.priorityScore > 0);
  });

  it('always includes a modeLabel string field', async () => {
    const result = await detectLayoutAmbiguity({
      agentsDir: tempDir,
      agentId: 'no-plan-agent',
    });
    assert.equal(typeof result.modeLabel, 'string');
    assert.ok(result.modeLabel.length > 0);
  });

  it('modeLabel matches the detected mode', async () => {
    await writePlan(tempDir, 'td-agent', '## Monday\nDeep work.\n## Tuesday\nReview.');
    const result = await detectLayoutAmbiguity({ agentsDir: tempDir, agentId: 'td-agent' });
    assert.equal(result.mode, 'theme-days');
    assert.equal(result.modeLabel, 'Theme Days');
  });

  it('result always contains all required fields', async () => {
    const result = await detectLayoutAmbiguity({
      agentsDir: tempDir,
      agentId: 'shape-check-agent',
    });
    for (const field of ['mode', 'confident', 'ambiguityReason', 'themeScore', 'priorityScore', 'modeLabel']) {
      assert.ok(field in result, `missing field: ${field}`);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 8: backward-compatibility — plans containing advisor-mode review tasks
// ---------------------------------------------------------------------------

describe('plan skill adapter — AC 8 backward compatibility with advisor-mode review tasks', () => {
  let tempDir: string;
  let store: AgentStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aweek-plan-compat-'));
    store = new AgentStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function buildAgentWithReviewTasks() {
    const { config, goal, objective, task, monthlyPlan, weeklyPlan } = buildTestAgent();

    const dailyReviewTasks = [
      ['Mon review: week orientation', "Week orientation: open your weekly plan, confirm today's top two priorities."],
      ['Tue review: day-two check-in', 'Day-two check-in: note what moved forward yesterday, update task statuses.'],
      ['Wed review: mid-week pulse', 'Mid-week pulse: you are halfway through — assess overall pacing.'],
      ['Thu review: pre-close prep', 'Pre-close prep: drive open items toward done, escalate any unresolved blockers.'],
      ['Fri review: end-of-day wrap-up', 'End-of-day Friday: record today\'s outcomes, note what carries forward.'],
    ].map(([title, prompt], i) =>
      createTask({ title: title as string, prompt: prompt as string }, DAILY_REVIEW_OBJECTIVE_ID, {
        priority: 'medium',
        estimatedMinutes: 30,
        runAt: `2026-04-${20 + i}T17:00:00Z`,
        track: DAILY_REVIEW_OBJECTIVE_ID,
      }),
    );

    const weeklyReviewTask = createTask(
      {
        title: 'Weekly review',
        prompt: 'Weekly review: assess outcomes against this week\'s plan, capture wins / misses / learnings.',
      },
      WEEKLY_REVIEW_OBJECTIVE_ID,
      {
        priority: 'high',
        estimatedMinutes: 60,
        runAt: '2026-04-24T18:00:00Z',
        track: WEEKLY_REVIEW_OBJECTIVE_ID,
      },
    );

    weeklyPlan.tasks.push(...dailyReviewTasks, weeklyReviewTask);

    return {
      config, goal, objective, task, monthlyPlan, weeklyPlan,
      dailyReviewTasks, weeklyReviewTask,
    };
  }

  it('reviewPlan returns a formatted summary that includes both work and review tasks', async () => {
    const { config, task, dailyReviewTasks, weeklyReviewTask, weeklyPlan } =
      buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await reviewPlan({ agentId: config.id, dataDir: tempDir });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    assert.ok(result.formatted, 'expected a `formatted` field');
    assert.ok(
      result.formatted!.includes(task.title),
      'existing work task should appear in the formatted output',
    );
    assert.ok(
      result.formatted!.includes(dailyReviewTasks[0]!.title),
      'first daily-review task should appear in the formatted output',
    );
    assert.ok(
      result.formatted!.includes(weeklyReviewTask.title),
      'weekly-review task should appear in the formatted output',
    );
    assert.match(
      result.formatted!,
      /Tasks \(\d+\)/,
      'formatted output should declare the total task count',
    );
  });

  it('reviewPlan reports the correct total task count when review tasks are present', async () => {
    const { config, weeklyPlan } = buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await reviewPlan({ agentId: config.id, dataDir: tempDir });
    assert.equal(result.success, true, JSON.stringify(result.errors));
    assert.match(result.formatted!, /Tasks \(7\)/);
  });

  it('approve marks the plan as approved even when it contains review tasks', async () => {
    const { config, weeklyPlan } = buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await approve({
      agentId: config.id,
      dataDir: tempDir,
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persisted = await weeklyPlanStore.load(config.id, weeklyPlan.week!);
    assert.equal(persisted!.approved, true, 'plan should be approved');
  });

  it('approve preserves all review tasks in the persisted plan', async () => {
    const { config, weeklyPlan } = buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    await approve({
      agentId: config.id,
      dataDir: tempDir,
    });

    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persisted = await weeklyPlanStore.load(config.id, weeklyPlan.week!);
    const dailyReviewCount = persisted!.tasks.filter(
      (t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID,
    ).length;
    const weeklyReviewCount = persisted!.tasks.filter(
      (t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID,
    ).length;
    assert.equal(dailyReviewCount, 5, 'all 5 daily-review tasks should survive approval');
    assert.equal(weeklyReviewCount, 1, 'the weekly-review task should survive approval');
  });

  it('edit (add) appends a new work task without removing review tasks', async () => {
    const { config, objective, weeklyPlan } = buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });
    const originalCount = weeklyPlan.tasks.length;

    const result = await edit({
      agentId: config.id,
      dataDir: tempDir,
      edits: [
        {
          action: 'add',
          title: 'Write changelog entry',
          prompt: 'Write changelog entry',
          objectiveId: objective.id,
          priority: 'low',
          estimatedMinutes: 20,
        },
      ],
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persisted = await weeklyPlanStore.load(config.id, weeklyPlan.week!);

    assert.equal(persisted!.tasks.length, originalCount + 1, 'total task count should be +1');
    assert.ok(
      persisted!.tasks.some((t) => t.title === 'Write changelog entry'),
      'new work task should be present',
    );
    assert.equal(
      persisted!.tasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID).length,
      5,
      'all 5 daily-review tasks should still be present after edit',
    );
    assert.equal(
      persisted!.tasks.filter((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID).length,
      1,
      'weekly-review task should still be present after edit',
    );
    assert.equal(persisted!.approved, false, 'plan should remain pending after plain edit');
  });

  it('edit + autoApproveAfterEdit:true approves even when review tasks are present', async () => {
    const { config, objective, weeklyPlan } = buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await edit({
      agentId: config.id,
      dataDir: tempDir,
      edits: [
        {
          action: 'add',
          title: 'Cut a release branch',
          prompt: 'Cut a release branch',
          objectiveId: objective.id,
          priority: 'high',
          estimatedMinutes: 30,
        },
      ],
      autoApproveAfterEdit: true,
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persisted = await weeklyPlanStore.load(config.id, weeklyPlan.week!);
    assert.equal(persisted!.approved, true, 'plan should be approved after autoApprove edit');
    assert.ok(
      persisted!.tasks.some((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID),
      'daily-review tasks should survive auto-approve edit',
    );
    assert.ok(
      persisted!.tasks.some((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID),
      'weekly-review task should survive auto-approve edit',
    );
  });

  it('reject (confirmed) removes the plan even when it contains review tasks', async () => {
    const { config, weeklyPlan } = buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await reject({
      agentId: config.id,
      dataDir: tempDir,
      confirmed: true,
      rejectionReason: 'review tasks should not block rejection',
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const remaining = await weeklyPlanStore.loadAll(config.id).catch(() => []);
    assert.equal(remaining.length, 0, 'plan should be fully removed even when it had review tasks');
  });

  it('reject without confirmed still refuses even when the plan has review tasks', async () => {
    const { config, weeklyPlan } = buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await reject({ agentId: config.id, dataDir: tempDir });

    assert.equal(result.success, false, 'reject without confirmed must fail');
    assert.ok(result.errors!.some((e: string) => /explicit confirmation/i.test(e)));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const remaining = await weeklyPlanStore.loadAll(config.id).catch(() => []);
    assert.equal(remaining.length, 1, 'plan should survive a rejected rejection attempt');
  });

  it('adjustPlan weekly add-task works when the plan already has review tasks', async () => {
    const { config, objective, weeklyPlan } = buildAgentWithReviewTasks();
    weeklyPlan.approved = true;
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });
    const originalCount = weeklyPlan.tasks.length;

    const result = await adjustPlan({
      agentId: config.id,
      dataDir: tempDir,
      weeklyAdjustments: [
        {
          action: 'add',
          week: weeklyPlan.week!,
          title: 'Draft release notes',
          prompt: 'Draft release notes',
          objectiveId: objective.id,
          priority: 'medium',
        },
      ],
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persisted = await weeklyPlanStore.load(config.id, weeklyPlan.week!);

    assert.equal(
      persisted!.tasks.length,
      originalCount + 1,
      'one additional work task should have been added',
    );
    assert.ok(
      persisted!.tasks.some((t) => t.title === 'Draft release notes'),
      'added task should be present in the persisted plan',
    );
    assert.equal(
      persisted!.tasks.filter((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID).length,
      5,
      'daily-review tasks should be untouched by weekly adjustPlan add',
    );
    assert.equal(
      persisted!.tasks.filter((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID).length,
      1,
      'weekly-review task should be untouched by weekly adjustPlan add',
    );
  });

  it('adjustPlan weekly update-task works on a work task in a plan that also has review tasks', async () => {
    const { config, task, weeklyPlan } = buildAgentWithReviewTasks();
    weeklyPlan.approved = true;
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await adjustPlan({
      agentId: config.id,
      dataDir: tempDir,
      weeklyAdjustments: [
        {
          action: 'update',
          week: weeklyPlan.week!,
          taskId: task.id,
          status: 'completed',
        },
      ],
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persisted = await weeklyPlanStore.load(config.id, weeklyPlan.week!);

    const updatedTask = persisted!.tasks.find((t) => t.id === task.id);
    assert.equal(updatedTask!.status, 'completed', 'work task status should be updated');
    for (const t of persisted!.tasks.filter(
      (t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID ||
             t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID,
    )) {
      assert.equal(t.status, 'pending', `review task ${t.id} should still be pending`);
    }
  });

  it('adjustPlan still rejects goalAdjustments and points at plan.md (review tasks in plan does not change this)', async () => {
    const { config, weeklyPlan } = buildAgentWithReviewTasks();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await adjustPlan({
      agentId: config.id,
      dataDir: tempDir,
      goalAdjustments: [
        { action: 'add', description: 'New goal', horizon: '1mo' },
      ],
    });

    assert.equal(result.success, false, 'goalAdjustments should still be rejected');
    assert.ok(
      result.errors!.some((e: string) => /plan\.md/.test(e)),
      'rejection error should point at plan.md',
    );
  });
});

// ---------------------------------------------------------------------------
// autoApprovePlan — autonomous approval (Sub-AC 4b-iii)
// ---------------------------------------------------------------------------

describe('plan skill adapter — autoApprovePlan (Sub-AC 4b-iii)', () => {
  let tempDir: string;
  let store: AgentStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aweek-plan-autoapprove-'));
    store = new AgentStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('sets approved:true on the pending plan', async () => {
    const { config, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await autoApprovePlan({
      agentId: config.id,
      dataDir: tempDir,
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persisted = await weeklyPlanStore.load(config.id, weeklyPlan.week!);
    assert.equal(persisted!.approved, true, 'plan must be approved after autoApprovePlan');
    assert.ok(persisted!.approvedAt, 'approvedAt timestamp must be set');
  });

  it('returns noPendingPlanRemains:true after a successful auto-approval', async () => {
    const { config, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await autoApprovePlan({
      agentId: config.id,
      dataDir: tempDir,
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    assert.equal(
      result.noPendingPlanRemains,
      true,
      'noPendingPlanRemains must be true — no pending plan should survive auto-approval',
    );
  });

  it('returns noPendingPlanRemains:false when approval fails', async () => {
    const result = await autoApprovePlan({
      agentId: 'non-existent-agent',
      dataDir: tempDir,
    });

    assert.equal(result.success, false);
    assert.equal(
      result.noPendingPlanRemains,
      false,
      'noPendingPlanRemains must be false when approval itself failed',
    );
  });

  it('returns noPendingPlanRemains:false when there is no pending plan', async () => {
    const { config, weeklyPlan } = buildTestAgent({ planApproved: true });
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await autoApprovePlan({
      agentId: config.id,
      dataDir: tempDir,
    });

    assert.equal(result.success, false);
    assert.equal(result.noPendingPlanRemains, false);
  });

  it('does not require any AskUserQuestion interaction — call completes without user prompts', async () => {
    const { config, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    let resolved = false;
    const resultPromise = autoApprovePlan({
      agentId: config.id,
      dataDir: tempDir,
    }).then((r) => {
      resolved = true;
      return r;
    });

    const result = await resultPromise;
    assert.equal(resolved, true, 'autoApprovePlan must resolve without user interaction');
    assert.equal(result.success, true, JSON.stringify(result.errors));
  });

  it('returns the approved plan object in the result', async () => {
    const { config, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await autoApprovePlan({
      agentId: config.id,
      dataDir: tempDir,
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    assert.ok(result.plan, 'result must include the approved plan object');
    assert.equal(result.plan!.approved, true);
    assert.equal(result.plan!.week, weeklyPlan.week);
  });

  it('works correctly when the plan contains advisor-mode review tasks', async () => {
    const { config, weeklyPlan } = buildTestAgent();

    const dailyReviewTask = createTask({ title: 'Week orientation: open your weekly plan, confirm priorities.', prompt: 'Week orientation: open your weekly plan, confirm priorities.' },
      DAILY_REVIEW_OBJECTIVE_ID,
      { priority: 'medium', estimatedMinutes: 30, runAt: '2026-04-20T17:00:00Z',
        track: DAILY_REVIEW_OBJECTIVE_ID },
    );
    const weeklyReviewTask = createTask({ title: 'Weekly review: assess outcomes and hand off to next-week planner.', prompt: 'Weekly review: assess outcomes and hand off to next-week planner.' },
      WEEKLY_REVIEW_OBJECTIVE_ID,
      { priority: 'high', estimatedMinutes: 60, runAt: '2026-04-24T18:00:00Z',
        track: WEEKLY_REVIEW_OBJECTIVE_ID },
    );
    weeklyPlan.tasks.push(dailyReviewTask, weeklyReviewTask);

    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await autoApprovePlan({
      agentId: config.id,
      dataDir: tempDir,
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    assert.equal(result.noPendingPlanRemains, true);

    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persisted = await weeklyPlanStore.load(config.id, weeklyPlan.week!);
    assert.equal(persisted!.approved, true);
    assert.ok(
      persisted!.tasks.some((t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID),
      'daily-review task must be preserved',
    );
    assert.ok(
      persisted!.tasks.some((t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID),
      'weekly-review task must be preserved',
    );
  });

  it('result shape always includes noPendingPlanRemains regardless of outcome', async () => {
    const failResult = await autoApprovePlan({
      agentId: 'ghost-agent',
      dataDir: tempDir,
    });
    assert.ok(
      'noPendingPlanRemains' in failResult,
      'noPendingPlanRemains must be present in failure result',
    );

    const { config, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });
    const okResult = await autoApprovePlan({
      agentId: config.id,
      dataDir: tempDir,
    });
    assert.ok(
      'noPendingPlanRemains' in okResult,
      'noPendingPlanRemains must be present in success result',
    );
  });
});

// ---------------------------------------------------------------------------
// Skip-questions escape hatch — adapter re-exports (Sub-AC 5c)
// ---------------------------------------------------------------------------

import * as interviewTriggers from './plan-interview-triggers.js';

describe('plan skill adapter — skip-questions escape hatch re-exports', () => {
  it('generateSkipAssumptions is the same reference as the underlying module export', () => {
    assert.equal(
      generateSkipAssumptions,
      interviewTriggers.generateSkipAssumptions,
      'generateSkipAssumptions must be the same function reference',
    );
  });

  it('formatAssumptionsBlock is the same reference as the underlying module export', () => {
    assert.equal(
      formatAssumptionsBlock,
      interviewTriggers.formatAssumptionsBlock,
      'formatAssumptionsBlock must be the same function reference',
    );
  });

  it('generateAssumptionForTrigger is the same reference as the underlying module export', () => {
    assert.equal(
      generateAssumptionForTrigger,
      interviewTriggers.generateAssumptionForTrigger,
      'generateAssumptionForTrigger must be the same function reference',
    );
  });

  it('generateSkipAssumptions returns the correct shape for a first-ever-plan trigger', () => {
    const triggers = [
      { trigger: 'first-ever-plan', reason: 'no plans yet', details: {} },
    ];
    const result = generateSkipAssumptions(triggers);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.trigger, 'first-ever-plan');
    assert.equal(result[0]!.label, 'First-Ever Plan');
    assert.equal(typeof result[0]!.assumption, 'string');
    assert.ok(result[0]!.assumption.length > 0);
  });

  it('generateSkipAssumptions returns an empty array for an empty triggers input', () => {
    assert.deepEqual(generateSkipAssumptions([]), []);
  });

  it('formatAssumptionsBlock returns an empty string for an empty assumptions array', () => {
    assert.equal(formatAssumptionsBlock([]), '');
  });

  it('formatAssumptionsBlock returns a non-empty string containing the assumption text', () => {
    const assumptions = [
      {
        trigger: 'first-ever-plan',
        label: 'First-Ever Plan',
        assumption: 'Calibration starter week assumption.',
      },
    ];
    const block = formatAssumptionsBlock(assumptions);
    assert.equal(typeof block, 'string');
    assert.ok(block.length > 0);
    assert.ok(block.includes('First-Ever Plan'), 'block should include the label');
    assert.ok(
      block.includes('Calibration starter week assumption.'),
      'block should include the assumption text',
    );
    assert.match(block, /Skipped Questions/i, 'block should have the escape-hatch header');
  });

  it('formatAssumptionsBlock output prompts user to approve or decline', () => {
    const assumptions = [
      { trigger: 'first-ever-plan', label: 'First-Ever Plan', assumption: 'Some assumption.' },
    ];
    const block = formatAssumptionsBlock(assumptions);
    assert.match(block, /decline/i);
  });
});
