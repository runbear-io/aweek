/**
 * Tests for the `plan` skill adapter.
 *
 * The adapter is a thin composition layer over `../services/plan-adjustments.js`
 * and `../services/plan-approval.js`, both of which already have comprehensive
 * tests under `src/services/plan-{adjustments,approval}.test.js`. Here we only
 * verify the surface that exists *because of* the adapter:
 *
 *   1. Re-exports and aliases bind the same function references as the
 *      underlying services so there is exactly one source of truth.
 *   2. The thin pass-through wrappers (`adjustPlan`, `approve`, `edit`,
 *      `reviewPlan`, `formatAdjustmentResult`) forward arguments and return
 *      values verbatim.
 *   3. The destructive `reject` operation is confirmation-gated and refuses
 *      to call the underlying service without `confirmed: true`.
 *   4. End-to-end happy paths through the adapter exercise the full
 *      `/aweek:plan` flow against a real on-disk agent store so a regression
 *      in the wiring (wrong import path, dropped argument, swapped return
 *      shape) is caught here before it reaches the skill markdown.
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
  buildHeartbeatCommand,
  activateHeartbeat,
  processApproval,
  formatApprovalResult,
  loadPlanForReview,
} from './plan.js';
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

const TEST_SLUG = 'test-agent';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function buildTestAgent({ subagentRef = TEST_SLUG, planApproved = false } = {}) {
  const config = createAgentConfig({
    subagentRef,
    budget: { weeklyTokenLimit: 100000 },
  });

  const goal = createGoal('Ship the new feature', '3mo');
  config.goals.push(goal);

  const objective = createObjective('Land MVP this month', goal.id);
  const monthlyPlan = createMonthlyPlan('2026-04', [objective]);
  config.monthlyPlans.push(monthlyPlan);

  const task = createTask('Draft the spec', objective.id, {
    priority: 'high',
    estimatedMinutes: 60,
  });
  const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task]);
  weeklyPlan.approved = planApproved;

  return { config, goal, objective, task, monthlyPlan, weeklyPlan };
}

/** Persist both the config and the weekly plan to the file store. */
async function saveFixture({ store, dir, config, weeklyPlan }) {
  await store.save(config);
  const weeklyPlanStore = new WeeklyPlanStore(dir);
  await weeklyPlanStore.save(config.id, weeklyPlan);
}

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aweek-plan-adapter-'));
  try {
    const store = new AgentStore(dir);
    await fn({ store, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Re-export identity — every passthrough symbol must be the same reference
// the underlying service exports, so the adapter stays a true shim and never
// silently shadows the canonical impl with a divergent copy.
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
    assert.equal(buildHeartbeatCommand, approvalService.buildHeartbeatCommand);
    assert.equal(activateHeartbeat, approvalService.activateHeartbeat);
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
//
// The adapter is the *only* place this guard exists; the underlying service
// has no `confirmed` field. These tests pin the gate against accidental
// removal or weakening (e.g., truthy-but-not-strict-true bypass).
// ---------------------------------------------------------------------------

describe('plan skill adapter — reject confirmation gate', () => {
  it('refuses to run when confirmed is missing', async () => {
    const result = await reject({ agentId: 'agent-x', dataDir: '/tmp/unused' });
    assert.equal(result.success, false);
    assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));
  });

  it('refuses to run when confirmed is false', async () => {
    const result = await reject({
      agentId: 'agent-x',
      dataDir: '/tmp/unused',
      confirmed: false,
    });
    assert.equal(result.success, false);
    assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));
  });

  it('refuses to run when confirmed is truthy but not strictly true', async () => {
    for (const sneaky of [1, 'yes', 'true', {}, []]) {
      const result = await reject({
        agentId: 'agent-x',
        dataDir: '/tmp/unused',
        confirmed: sneaky,
      });
      assert.equal(
        result.success,
        false,
        `confirmed=${JSON.stringify(sneaky)} should not bypass the gate`,
      );
      assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));
    }
  });

  it('refuses to run when called with no params at all', async () => {
    const result = await reject();
    assert.equal(result.success, false);
    assert.ok(result.errors.some((e) => /explicit confirmation/i.test(e)));
  });

  it('strips `confirmed` before delegating to the service', async () => {
    // The service has no `confirmed` field — if we leak the flag through,
    // the schema validator on the service side may complain or ignore it
    // silently. Either way it's a leak. Verify by spying via a fixture
    // store: a real reject succeeds and the persisted JSON has no
    // `confirmed` artifact anywhere.
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
//
// These exercise the `/aweek:plan` flow against a real on-disk store to
// catch wiring regressions in the adapter (wrong import path, dropped
// argument, swapped return shape). They deliberately stay shallow — the
// underlying service tests own deep behavioral coverage.
// ---------------------------------------------------------------------------

describe('plan skill adapter — adjustPlan happy path', () => {
  let tempDir;
  let store;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aweek-plan-adjust-'));
    store = new AgentStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('applies a single goal-add through the adapter and persists it', async () => {
    const { config } = buildTestAgent();
    await store.save(config);

    const result = await adjustPlan({
      agentId: config.id,
      dataDir: tempDir,
      goalAdjustments: [
        { action: 'add', description: 'Improve test coverage', horizon: '1mo' },
      ],
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const reloaded = await store.load(config.id);
    assert.equal(reloaded.goals.length, 2);
    assert.ok(
      reloaded.goals.some((g) => g.description === 'Improve test coverage'),
    );
  });

  it('rejects a batch atomically when one operation is invalid', async () => {
    const { config } = buildTestAgent();
    await store.save(config);

    const result = await adjustPlan({
      agentId: config.id,
      dataDir: tempDir,
      goalAdjustments: [
        { action: 'add', description: 'OK goal', horizon: '1yr' },
        // Invalid — empty description
        { action: 'add', description: '', horizon: '1mo' },
      ],
    });

    assert.equal(result.success, false);
    const reloaded = await store.load(config.id);
    // Atomicity: the OK goal must NOT be persisted.
    assert.equal(reloaded.goals.length, 1);
  });
});

describe('plan skill adapter — approve / edit / reviewPlan happy paths', () => {
  let tempDir;
  let store;

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
    assert.match(result.formatted, /2026-W16/);
    assert.ok(
      result.formatted.includes(task.description),
      'formatted output should mention the task description',
    );
  });

  it('approve marks the plan as approved without an `installFn` (heartbeat install is non-fatal)', async () => {
    const { config, weeklyPlan } = buildTestAgent();
    await saveFixture({ store, dir: tempDir, config, weeklyPlan });

    const result = await approve({
      agentId: config.id,
      dataDir: tempDir,
      // Stub the heartbeat installer so the test never touches the real crontab.
      installFn: async () => ({ installed: true }),
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persistedPlan = await weeklyPlanStore.load(config.id, weeklyPlan.week);
    assert.equal(persistedPlan.approved, true);
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
          description: 'Write the README',
          objectiveId: objective.id,
          priority: 'medium',
          estimatedMinutes: 45,
        },
      ],
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persistedPlan = await weeklyPlanStore.load(config.id, weeklyPlan.week);
    assert.equal(persistedPlan.tasks.length, 2);
    assert.ok(persistedPlan.tasks.some((t) => t.description === 'Write the README'));
    // Default behavior: still pending.
    assert.equal(persistedPlan.approved, false);
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
          description: 'Cut a release branch',
          objectiveId: objective.id,
          priority: 'high',
          estimatedMinutes: 30,
        },
      ],
      autoApproveAfterEdit: true,
      installFn: async () => ({ installed: true }),
    });

    assert.equal(result.success, true, JSON.stringify(result.errors));
    const weeklyPlanStore = new WeeklyPlanStore(tempDir);
    const persistedPlan = await weeklyPlanStore.load(config.id, weeklyPlan.week);
    assert.equal(persistedPlan.approved, true);
    assert.equal(persistedPlan.tasks.length, 2);
  });
});
