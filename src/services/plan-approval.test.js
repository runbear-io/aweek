/**
 * Tests for approve-plan skill logic.
 *
 * Subagent-wrapper invariant under test
 * -------------------------------------
 * After the aweek ↔ Claude Code subagent 1-to-1 refactor, each aweek agent
 * is a thin scheduling wrapper around a subagent .md at
 * `.claude/agents/SLUG.md`. The .md is the SOLE source of truth for identity
 * (name, description, system prompt, model, tools, skills, MCP servers); the
 * aweek JSON owns ONLY scheduling concerns — goals, monthly/weekly plans,
 * token budget, inbox, execution logs.
 *
 * The approve-plan skill is a scheduling-only operation, so these tests
 * assert that running approve/reject/edit:
 *   1. mutates ONLY the scheduling fields of the aweek JSON,
 *   2. leaves the agent's identity-bearing fields (`id`, `subagentRef`,
 *      `createdAt`) byte-for-byte unchanged,
 *   3. never reads, writes, or otherwise touches the subagent .md file.
 *
 * Per the `single_source_of_truth` evaluation principle, identity is not
 * duplicated into aweek JSON anymore — there is no `identity`, `name`,
 * `role`, or `systemPrompt` field on the agent config. These tests use the
 * slug-based `createAgentConfig({ subagentRef })` factory and, where
 * relevant, pin a subagent .md on disk to verify it survives the approval
 * flow unchanged.
 *
 * Covers:
 *  - findPendingPlan (with/without pending plans)
 *  - formatPlanForReview (output content, traceability, optional live .md
 *    identity passthrough)
 *  - validateDecision (valid/invalid decisions)
 *  - validateEdits (add/remove/update validations)
 *  - applyEdits (add/remove/update mutations)
 *  - processApproval — approve (first and subsequent)
 *  - processApproval — reject (with/without reason)
 *  - processApproval — edit (with/without auto-approve)
 *  - formatApprovalResult (all decision types)
 *  - loadPlanForReview (convenience wrapper)
 *  - Subagent-wrapper invariants (scheduling-only; .md file untouched)
 *  - Edge cases and error handling
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findPendingPlan,
  formatPlanForReview,
  validateDecision,
  validateEdits,
  applyEdits,
  processApproval,
  formatApprovalResult,
  loadPlanForReview,
  APPROVAL_DECISIONS,
} from './plan-approval.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import {
  buildSubagentMarkdown,
  subagentFilePath,
} from '../subagents/subagent-file.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SLUG = 'test-bot';

/** Build a standard test agent with a pending weekly plan. Weekly plans
 *  live in their own file store — returned as a separate `weeklyPlans`
 *  array so callers can choose to persist them via `saveTestAgent`.
 */
function buildTestAgent({ subagentRef = TEST_SLUG } = {}) {
  const config = createAgentConfig({ subagentRef });

  const goal = createGoal('Build a great product', '3mo');
  config.goals.push(goal);

  const obj = createObjective('Implement core features', goal.id);
  const monthlyPlan = createMonthlyPlan('2026-04', [obj]);
  config.monthlyPlans.push(monthlyPlan);

  const task1 = createTask({ title: 'Design database schema', prompt: 'Design database schema' }, obj.id, { priority: 'high', estimatedMinutes: 60 });
  const task2 = createTask({ title: 'Write API endpoints', prompt: 'Write API endpoints' }, obj.id, { priority: 'medium', estimatedMinutes: 120 });
  const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task1, task2]);
  // The approval-flow tests in this file expect a pending plan so they can
  // exercise the approve/reject/edit gate. `createWeeklyPlan` now defaults
  // plans to `approved: true`; flip it back here to preserve test intent.
  weeklyPlan.approved = false;
  const weeklyPlans = [weeklyPlan];

  return { config, weeklyPlans, goal, obj, monthlyPlan, weeklyPlan, task1, task2 };
}

/**
 * Save the agent config and every weekly plan in the returned array to
 * the file store. Returns the stores + tmpDir for assertions.
 */
async function saveTestAgent(config, weeklyPlans = []) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-approve-'));
  const store = new AgentStore(tmpDir);
  await store.save(config);
  const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
  for (const plan of weeklyPlans) {
    await weeklyPlanStore.save(config.id, plan);
  }
  return { store, weeklyPlanStore, tmpDir };
}

/**
 * Scaffold a full project tree with an aweek JSON wrapper AND a subagent .md
 * file pinned on disk. Returns everything the subagent-wrapper invariant
 * tests need to later verify the .md was not touched.
 */
async function scaffoldProjectWithSubagentMd({ subagentRef = TEST_SLUG } = {}) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-approve-md-'));
  const dataDir = join(tmpDir, '.aweek', 'agents');
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(tmpDir, '.claude', 'agents'), { recursive: true });

  // Write the subagent .md — single source of truth for identity.
  const mdContents = buildSubagentMarkdown({
    name: subagentRef,
    description: 'Scheduling wrapper test subject',
    systemPrompt:
      'You are the approve-plan test subject. Do not write to disk.\n' +
      'Slug: ' + subagentRef + '.',
  });
  const mdPath = subagentFilePath(subagentRef, tmpDir);
  await writeFile(mdPath, mdContents, 'utf8');
  const stBefore = await stat(mdPath);
  const mdMtimeMs = stBefore.mtimeMs;

  const { config, weeklyPlans, goal, obj, monthlyPlan, weeklyPlan, task1, task2 } = buildTestAgent({ subagentRef });
  const store = new AgentStore(dataDir);
  await store.save(config);
  const weeklyPlanStore = new WeeklyPlanStore(dataDir);
  for (const plan of weeklyPlans) {
    await weeklyPlanStore.save(config.id, plan);
  }

  return {
    tmpDir,
    dataDir,
    mdPath,
    mdContents,
    mdMtimeMs,
    store,
    weeklyPlanStore,
    config,
    goal,
    obj,
    monthlyPlan,
    weeklyPlan,
    task1,
    task2,
  };
}

// ---------------------------------------------------------------------------
// findPendingPlan
// ---------------------------------------------------------------------------

describe('findPendingPlan', () => {
  it('finds the first unapproved weekly plan', () => {
    const { weeklyPlans, weeklyPlan } = buildTestAgent();
    const result = findPendingPlan(weeklyPlans);
    assert.ok(result);
    assert.equal(result.plan.week, weeklyPlan.week);
    assert.equal(result.week, '2026-W16');
  });

  it('returns null when all plans are approved', () => {
    const { weeklyPlans } = buildTestAgent();
    weeklyPlans[0].approved = true;
    const result = findPendingPlan(weeklyPlans);
    assert.equal(result, null);
  });

  it('returns null when there are no weekly plans', () => {
    const result = findPendingPlan([]);
    assert.equal(result, null);
  });

  it('returns null for null input', () => {
    assert.equal(findPendingPlan(null), null);
  });

  it('returns null for input without weeklyPlans (legacy config shape)', () => {
    assert.equal(findPendingPlan({}), null);
  });

  it('skips approved plans and finds the pending one', () => {
    const { weeklyPlans } = buildTestAgent();
    // Add an approved plan first
    const approvedPlan = createWeeklyPlan('2026-W15', '2026-04', []);
    approvedPlan.approved = true;
    approvedPlan.approvedAt = new Date().toISOString();
    weeklyPlans.unshift(approvedPlan);

    const result = findPendingPlan(weeklyPlans);
    assert.ok(result);
    assert.equal(result.week, '2026-W16');
  });
});

// ---------------------------------------------------------------------------
// formatPlanForReview
// ---------------------------------------------------------------------------

describe('formatPlanForReview', () => {
  it('falls back to the subagent slug when no live identity is provided', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan);
    assert.ok(text.includes(TEST_SLUG), `expected slug ${TEST_SLUG} in output`);
    assert.ok(text.includes('2026-W16'));
    // Must not re-introduce any reference to the removed identity field.
    assert.ok(!text.includes('undefined'));
  });

  it('uses the live .md name + description when subagentIdentity is passed', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan, {
      subagentIdentity: {
        missing: false,
        name: 'Design Lead',
        description: 'Leads design system work',
        path: '/ignored',
      },
    });
    assert.ok(text.includes('Design Lead'));
    assert.ok(text.includes('Leads design system work'));
    // Slug line still present for traceability.
    assert.ok(text.includes(`Slug:   ${TEST_SLUG}`));
  });

  it('falls back to slug when subagentIdentity is marked missing', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan, {
      subagentIdentity: { missing: true, name: '', description: '', path: '/x' },
    });
    assert.ok(text.includes(TEST_SLUG));
  });

  it('lists all tasks with priority and description', () => {
    const { config, weeklyPlan, task1, task2 } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan);
    assert.ok(text.includes(task1.title));
    assert.ok(text.includes(task2.title));
    assert.ok(text.includes('[HIGH]'));
    assert.ok(text.includes('[MEDIUM]'));
  });

  it('shows estimated minutes when present', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan);
    assert.ok(text.includes('~60min'));
    assert.ok(text.includes('~120min'));
  });

  it('shows traceability section', () => {
    const { config, weeklyPlan, obj, goal } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan);
    assert.ok(text.includes('Traceability'));
    assert.ok(text.includes(obj.id));
    assert.ok(text.includes(goal.description));
  });

  it('handles plan with no tasks', () => {
    const { config } = buildTestAgent();
    const emptyPlan = createWeeklyPlan('2026-W17', '2026-04', []);
    const text = formatPlanForReview(config, emptyPlan);
    assert.ok(text.includes('(no tasks)'));
  });

  it('shows Pending Approval status for unapproved plans', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan);
    assert.ok(text.includes('Pending Approval'));
  });
});

// ---------------------------------------------------------------------------
// validateDecision
// ---------------------------------------------------------------------------

describe('validateDecision', () => {
  it('accepts "approve"', () => {
    assert.ok(validateDecision('approve').valid);
  });

  it('accepts "reject"', () => {
    assert.ok(validateDecision('reject').valid);
  });

  it('accepts "edit"', () => {
    assert.ok(validateDecision('edit').valid);
  });

  it('rejects invalid decision', () => {
    const result = validateDecision('maybe');
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('must be one of'));
  });

  it('rejects null decision', () => {
    const result = validateDecision(null);
    assert.equal(result.valid, false);
  });

  it('rejects empty string', () => {
    const result = validateDecision('');
    assert.equal(result.valid, false);
  });

  it('APPROVAL_DECISIONS constant is correct', () => {
    assert.deepStrictEqual(APPROVAL_DECISIONS, ['approve', 'reject', 'edit']);
  });
});

// ---------------------------------------------------------------------------
// validateEdits
// ---------------------------------------------------------------------------

describe('validateEdits', () => {
  it('accepts valid add edit', () => {
    const { config, weeklyPlan, obj } = buildTestAgent();
    const edits = [{ action: 'add', title: 'New task', prompt: 'New task', objectiveId: obj.id }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.ok(result.valid, JSON.stringify(result.errors));
  });

  it('accepts valid remove edit', () => {
    const { config, weeklyPlan, task1 } = buildTestAgent();
    const edits = [{ action: 'remove', taskId: task1.id }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.ok(result.valid, JSON.stringify(result.errors));
  });

  it('accepts valid update edit', () => {
    const { config, weeklyPlan, task1 } = buildTestAgent();
    const edits = [{ action: 'update', taskId: task1.id, title: 'Updated desc', prompt: 'Updated desc' }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.ok(result.valid, JSON.stringify(result.errors));
  });

  it('rejects empty edits array', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const result = validateEdits([], weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('At least one edit'));
  });

  it('rejects non-array edits', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const result = validateEdits(null, weeklyPlan, config);
    assert.equal(result.valid, false);
  });

  it('rejects add with missing title/prompt', () => {
    const { config, weeklyPlan, obj } = buildTestAgent();
    const edits = [{ action: 'add', objectiveId: obj.id }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('title') || e.includes('prompt')));
  });

  it('rejects add with nonexistent objective', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const edits = [{ action: 'add', title: 'Task', prompt: 'Task', objectiveId: 'obj-nonexistent' }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('objective not found')));
  });

  it('rejects remove with nonexistent task', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const edits = [{ action: 'remove', taskId: 'task-nonexistent' }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('task not found')));
  });

  it('rejects update with no fields to change', () => {
    const { config, weeklyPlan, task1 } = buildTestAgent();
    const edits = [{ action: 'update', taskId: task1.id }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('at least one field')));
  });

  it('rejects update with invalid priority', () => {
    const { config, weeklyPlan, task1 } = buildTestAgent();
    const edits = [{ action: 'update', taskId: task1.id, priority: 'urgent' }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('priority')));
  });

  it('rejects update with invalid estimatedMinutes', () => {
    const { config, weeklyPlan, task1 } = buildTestAgent();
    const edits = [{ action: 'update', taskId: task1.id, estimatedMinutes: 999 }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('estimatedMinutes')));
  });

  it('rejects invalid action', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const edits = [{ action: 'delete' }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('action must be')));
  });

  it('accepts multiple valid edits', () => {
    const { config, weeklyPlan, task1, task2, obj } = buildTestAgent();
    const edits = [
      { action: 'add', title: 'New task', prompt: 'New task', objectiveId: obj.id },
      { action: 'update', taskId: task1.id, priority: 'critical' },
      { action: 'remove', taskId: task2.id },
    ];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.ok(result.valid, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// applyEdits
// ---------------------------------------------------------------------------

describe('applyEdits', () => {
  it('adds a task', () => {
    const { weeklyPlan, obj } = buildTestAgent();
    const origCount = weeklyPlan.tasks.length;
    const { applied, plan } = applyEdits(weeklyPlan, [
      { action: 'add', title: 'New task', prompt: 'New task', objectiveId: obj.id, priority: 'high' },
    ]);
    assert.equal(plan.tasks.length, origCount + 1);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].action, 'add');
    assert.ok(applied[0].taskId.startsWith('task-'));
  });

  it('removes a task', () => {
    const { weeklyPlan, task1 } = buildTestAgent();
    const origCount = weeklyPlan.tasks.length;
    const { applied, plan } = applyEdits(weeklyPlan, [
      { action: 'remove', taskId: task1.id },
    ]);
    assert.equal(plan.tasks.length, origCount - 1);
    assert.equal(applied[0].action, 'remove');
    assert.equal(applied[0].taskId, task1.id);
    assert.ok(!plan.tasks.find((t) => t.id === task1.id));
  });

  it('updates a task title', () => {
    const { weeklyPlan, task1 } = buildTestAgent();
    const { applied, plan } = applyEdits(weeklyPlan, [
      { action: 'update', taskId: task1.id, title: 'Updated description', prompt: 'Updated description' },
    ]);
    const task = plan.tasks.find((t) => t.id === task1.id);
    assert.equal(task.title, 'Updated description');
    assert.equal(applied[0].changes.title.to, 'Updated description');
  });

  it('updates task priority', () => {
    const { weeklyPlan, task1 } = buildTestAgent();
    applyEdits(weeklyPlan, [
      { action: 'update', taskId: task1.id, priority: 'critical' },
    ]);
    const task = weeklyPlan.tasks.find((t) => t.id === task1.id);
    assert.equal(task.priority, 'critical');
  });

  it('updates estimatedMinutes', () => {
    const { weeklyPlan, task1 } = buildTestAgent();
    applyEdits(weeklyPlan, [
      { action: 'update', taskId: task1.id, estimatedMinutes: 90 },
    ]);
    const task = weeklyPlan.tasks.find((t) => t.id === task1.id);
    assert.equal(task.estimatedMinutes, 90);
  });

  it('sets updatedAt on the plan', () => {
    const { weeklyPlan, task1 } = buildTestAgent();
    // Force an old timestamp so the update is always different
    weeklyPlan.updatedAt = '2020-01-01T00:00:00.000Z';
    applyEdits(weeklyPlan, [
      { action: 'update', taskId: task1.id, title: 'Changed', prompt: 'Changed' },
    ]);
    assert.notEqual(weeklyPlan.updatedAt, '2020-01-01T00:00:00.000Z');
  });

  it('applies multiple edits in sequence', () => {
    const { weeklyPlan, task1, task2, obj } = buildTestAgent();
    const { applied } = applyEdits(weeklyPlan, [
      { action: 'add', title: 'Third task', prompt: 'Third task', objectiveId: obj.id },
      { action: 'update', taskId: task1.id, priority: 'low' },
      { action: 'remove', taskId: task2.id },
    ]);
    assert.equal(applied.length, 3);
    // 2 original - 1 removed + 1 added = 2
    assert.equal(weeklyPlan.tasks.length, 2);
  });
});

// ---------------------------------------------------------------------------
// processApproval — approve
// ---------------------------------------------------------------------------

describe('processApproval — approve', () => {
  it('approves a pending plan', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.ok(result.plan.approvedAt);
  });

  it('detects first approval', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
    });

    assert.equal(result.isFirstApproval, true);
  });

  it('detects subsequent approval (not first)', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    // Add an already-approved plan
    const oldPlan = createWeeklyPlan('2026-W15', '2026-04', []);
    oldPlan.approved = true;
    oldPlan.approvedAt = new Date().toISOString();
    weeklyPlans.unshift(oldPlan);

    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.equal(result.isFirstApproval, false);
  });

  it('persists approval to file', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
    });

    // Reload and verify
    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    const plans = await weeklyPlanStore.loadAll(config.id);
    assert.equal(plans[0].approved, true);
    assert.ok(plans[0].approvedAt);
  });

  it('fails when no pending plan exists', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    weeklyPlans[0].approved = true;
    weeklyPlans[0].approvedAt = new Date().toISOString();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('No pending'));
  });

  it('fails when agent not found', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-approve-'));
    const result = await processApproval({
      agentId: 'agent-nonexistent',
      decision: 'approve',
      dataDir: tmpDir,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('Agent not found'));
  });
});

// ---------------------------------------------------------------------------
// processApproval — reject
// ---------------------------------------------------------------------------

describe('processApproval — reject', () => {
  it('removes the pending plan', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'reject',
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.ok(result.plan._rejected);

    // Verify plan is removed from file
    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    const remainingPlans = await weeklyPlanStore.loadAll(config.id);
    assert.equal(remainingPlans.length, 0);
  });

  it('preserves rejection reason', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'reject',
      rejectionReason: 'Tasks are too vague',
      dataDir: tmpDir,
    });

    assert.equal(result.plan._rejectionReason, 'Tasks are too vague');
  });

  it('isFirstApproval is false on rejection', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'reject',
      dataDir: tmpDir,
    });

    assert.equal(result.isFirstApproval, false);
  });
});

// ---------------------------------------------------------------------------
// processApproval — edit
// ---------------------------------------------------------------------------

describe('processApproval — edit', () => {
  it('applies edits and keeps plan pending', async () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [
        { action: 'update', taskId: task1.id, title: 'Revised schema design', prompt: 'Revised schema design' },
      ],
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, false);
    assert.equal(result.editResults.length, 1);
  });

  it('applies edits with auto-approve', async () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [
        { action: 'update', taskId: task1.id, priority: 'critical' },
      ],
      autoApproveAfterEdit: true,
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.ok(result.plan.approvedAt);
    assert.equal(result.isFirstApproval, true);
  });

  it('fails with invalid edits', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [{ action: 'remove', taskId: 'task-nonexistent' }],
      dataDir: tmpDir,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors.some((e) => e.includes('task not found')));
  });

  it('fails with no edits provided', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [],
      dataDir: tmpDir,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors.some((e) => e.includes('At least one edit')));
  });

  it('persists edits to file', async () => {
    const { config, weeklyPlans, obj } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [
        { action: 'add', title: 'New task added', prompt: 'New task added', objectiveId: obj.id },
      ],
      dataDir: tmpDir,
    });

    const weeklyPlanStore = new WeeklyPlanStore(tmpDir);
    const editedPlan = await weeklyPlanStore.load(config.id, '2026-W16');
    assert.equal(editedPlan.tasks.length, 3); // 2 original + 1 added
  });
});

// ---------------------------------------------------------------------------
// processApproval — invalid decision
// ---------------------------------------------------------------------------

describe('processApproval — invalid decision', () => {
  it('fails with invalid decision string', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'maybe',
      dataDir: tmpDir,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('must be one of'));
  });
});

// ---------------------------------------------------------------------------
// formatApprovalResult
// ---------------------------------------------------------------------------

describe('formatApprovalResult', () => {
  it('formats approve result', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { week: '2026-W16', tasks: [{ id: 't1' }, { id: 't2' }], approvedAt: '2026-04-16T10:00:00Z' },
      isFirstApproval: false,
    }, 'approve');
    assert.ok(text.includes('approved'));
    assert.ok(text.includes('2026-W16'));
    assert.ok(text.includes('Tasks: 2'));
  });

  it('formats first approval with project-heartbeat notice', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { week: '2026-W16', tasks: [], approvedAt: '2026-04-16T10:00:00Z' },
      isFirstApproval: true,
    }, 'approve');
    assert.ok(text.includes('FIRST APPROVAL'));
    assert.ok(text.includes('project heartbeat'));
  });

  it('formats reject result', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { _rejected: true, _rejectionReason: 'Too vague' },
    }, 'reject');
    assert.ok(text.includes('rejected'));
    assert.ok(text.includes('Too vague'));
  });

  it('formats edit result', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { approved: false },
      editResults: [
        { action: 'add', taskId: 'task-new', title: 'Added task' },
        { action: 'remove', taskId: 'task-old', title: 'Removed task' },
        { action: 'update', taskId: 'task-upd', changes: { title: { from: 'Old', to: 'New' } } },
      ],
    }, 'edit');
    assert.ok(text.includes('Added task'));
    assert.ok(text.includes('Removed task'));
    assert.ok(text.includes('Updated'));
    assert.ok(text.includes('still pending'));
  });

  it('formats edit with auto-approve and first approval', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { approved: true },
      editResults: [{ action: 'add', taskId: 'task-new', title: 'T' }],
      isFirstApproval: true,
    }, 'edit');
    assert.ok(text.includes('auto-approved'));
    assert.ok(text.includes('FIRST APPROVAL'));
  });

  it('formats error result', () => {
    const text = formatApprovalResult({
      success: false,
      errors: ['Agent not found', 'Invalid decision'],
    }, 'approve');
    assert.ok(text.includes('failed'));
    assert.ok(text.includes('Agent not found'));
    assert.ok(text.includes('Invalid decision'));
  });
});

// ---------------------------------------------------------------------------
// loadPlanForReview
// ---------------------------------------------------------------------------

describe('loadPlanForReview', () => {
  it('loads agent and formats pending plan', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await loadPlanForReview({
      agentId: config.id,
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.ok(result.config);
    assert.ok(result.plan);
    assert.ok(result.formatted.includes(TEST_SLUG));
    assert.ok(result.formatted.includes('2026-W16'));
  });

  it('fails when agent not found', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-approve-'));
    const result = await loadPlanForReview({
      agentId: 'agent-nonexistent',
      dataDir: tmpDir,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('Agent not found'));
  });

  it('fails when no pending plan', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    weeklyPlans[0].approved = true;
    weeklyPlans[0].approvedAt = new Date().toISOString();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await loadPlanForReview({
      agentId: config.id,
      dataDir: tmpDir,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('No pending'));
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('processApproval — idempotency', () => {
  it('approving an already-rejected agent (no plan) returns appropriate error', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    // Reject first
    await processApproval({ agentId: config.id, decision: 'reject', dataDir: tmpDir });

    // Try to approve — should fail since plan was removed
    const result = await processApproval({ agentId: config.id, decision: 'approve', dataDir: tmpDir });
    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('No pending'));
  });

  it('double approval returns no-pending error on second call', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const first = await processApproval({ agentId: config.id, decision: 'approve', dataDir: tmpDir });
    assert.ok(first.success);

    const second = await processApproval({ agentId: config.id, decision: 'approve', dataDir: tmpDir });
    assert.equal(second.success, false);
    assert.ok(second.errors[0].includes('No pending'));
  });
});

// ---------------------------------------------------------------------------
// processApproval — no per-agent crontab side-effects
//
// Approval is scheduling-state only: the project-level heartbeat installed by
// `/aweek:init` is the sole automated scheduling mechanism. These tests pin
// the contract that the approval surface no longer accepts heartbeat-related
// params and does not report any `heartbeatActivated` flag on the result.
// ---------------------------------------------------------------------------

describe('processApproval — scheduling-state only (no per-agent crontab)', () => {
  it('approve does not set a heartbeatActivated flag on the result', async () => {
    const { config, weeklyPlans } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, 'heartbeatActivated'),
      false,
      'approve result must not carry a heartbeatActivated flag',
    );
  });

  it('edit+auto-approve does not set a heartbeatActivated flag on the result', async () => {
    const { config, weeklyPlans, task1 } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config, weeklyPlans);

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [{ action: 'update', taskId: task1.id, priority: 'critical' }],
      autoApproveAfterEdit: true,
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, 'heartbeatActivated'),
      false,
      'edit+auto-approve result must not carry a heartbeatActivated flag',
    );
  });
});

// ---------------------------------------------------------------------------
// Subagent-wrapper invariants
//
// These tests enforce the 1-to-1 refactor's contract: approve-plan is a
// scheduling-only skill. It must never read or write `.claude/agents/<slug>.md`
// and must never reintroduce an `identity` / `name` / `role` /
// `systemPrompt` blob into aweek JSON (single_source_of_truth principle).
// ---------------------------------------------------------------------------

describe('Subagent-wrapper invariant — subagent .md is untouched', () => {
  it('approve leaves the subagent .md byte-for-byte unchanged', async () => {
    const ctx = await scaffoldProjectWithSubagentMd();

    const result = await processApproval({
      agentId: ctx.config.id,
      decision: 'approve',
      dataDir: ctx.dataDir,
    });
    assert.ok(result.success);
    assert.equal(result.plan.approved, true);

    const after = await readFile(ctx.mdPath, 'utf8');
    assert.equal(
      after,
      ctx.mdContents,
      'approve must not rewrite the subagent .md identity file',
    );
    const stAfter = await stat(ctx.mdPath);
    assert.equal(
      stAfter.mtimeMs,
      ctx.mdMtimeMs,
      'subagent .md mtime must be unchanged — approve is scheduling-only',
    );
  });

  it('reject leaves the subagent .md byte-for-byte unchanged', async () => {
    const ctx = await scaffoldProjectWithSubagentMd();

    const result = await processApproval({
      agentId: ctx.config.id,
      decision: 'reject',
      dataDir: ctx.dataDir,
    });
    assert.ok(result.success);

    const after = await readFile(ctx.mdPath, 'utf8');
    assert.equal(after, ctx.mdContents);
    const stAfter = await stat(ctx.mdPath);
    assert.equal(stAfter.mtimeMs, ctx.mdMtimeMs);
  });

  it('edit leaves the subagent .md byte-for-byte unchanged', async () => {
    const ctx = await scaffoldProjectWithSubagentMd();

    const result = await processApproval({
      agentId: ctx.config.id,
      decision: 'edit',
      edits: [
        { action: 'update', taskId: ctx.task1.id, title: 'Revised description', prompt: 'Revised description' },
      ],
      dataDir: ctx.dataDir,
    });
    assert.ok(result.success);

    const after = await readFile(ctx.mdPath, 'utf8');
    assert.equal(after, ctx.mdContents);
    const stAfter = await stat(ctx.mdPath);
    assert.equal(stAfter.mtimeMs, ctx.mdMtimeMs);
  });

  it('edit+auto-approve leaves the subagent .md byte-for-byte unchanged', async () => {
    const ctx = await scaffoldProjectWithSubagentMd();

    const result = await processApproval({
      agentId: ctx.config.id,
      decision: 'edit',
      edits: [
        { action: 'update', taskId: ctx.task1.id, priority: 'critical' },
      ],
      autoApproveAfterEdit: true,
      dataDir: ctx.dataDir,
    });
    assert.ok(result.success);
    assert.equal(result.plan.approved, true);

    const after = await readFile(ctx.mdPath, 'utf8');
    assert.equal(after, ctx.mdContents);
    const stAfter = await stat(ctx.mdPath);
    assert.equal(stAfter.mtimeMs, ctx.mdMtimeMs);
  });

  it('loadPlanForReview leaves the subagent .md byte-for-byte unchanged', async () => {
    const ctx = await scaffoldProjectWithSubagentMd();

    const result = await loadPlanForReview({
      agentId: ctx.config.id,
      dataDir: ctx.dataDir,
    });
    assert.ok(result.success);

    const after = await readFile(ctx.mdPath, 'utf8');
    assert.equal(after, ctx.mdContents);
    const stAfter = await stat(ctx.mdPath);
    assert.equal(stAfter.mtimeMs, ctx.mdMtimeMs);
  });
});

describe('Subagent-wrapper invariant — aweek JSON never reintroduces identity', () => {
  it('approve mutates scheduling fields only; id/subagentRef/createdAt unchanged', async () => {
    const ctx = await scaffoldProjectWithSubagentMd();
    const before = await ctx.store.load(ctx.config.id);

    // Confirm no stale identity ever landed on the persisted JSON.
    assert.equal(before.identity, undefined);
    assert.equal(before.name, undefined);
    assert.equal(before.role, undefined);
    assert.equal(before.systemPrompt, undefined);

    const snapshotBefore = {
      id: before.id,
      subagentRef: before.subagentRef,
      createdAt: before.createdAt,
      weeklyTokenBudget: before.weeklyTokenBudget,
    };

    const result = await processApproval({
      agentId: ctx.config.id,
      decision: 'approve',
      dataDir: ctx.dataDir,
    });
    assert.ok(result.success);

    const after = await ctx.store.load(ctx.config.id);
    assert.equal(after.id, snapshotBefore.id, 'id must not change');
    assert.equal(after.subagentRef, snapshotBefore.subagentRef, 'subagentRef must not change');
    assert.equal(after.createdAt, snapshotBefore.createdAt, 'createdAt must not change');
    assert.equal(after.weeklyTokenBudget, snapshotBefore.weeklyTokenBudget);
    // Identity fields still absent.
    assert.equal(after.identity, undefined, 'identity must not be reintroduced');
    assert.equal(after.name, undefined);
    assert.equal(after.role, undefined);
    assert.equal(after.systemPrompt, undefined);
    // Scheduling mutation is observable.
    const afterPlans = await ctx.weeklyPlanStore.loadAll(ctx.config.id);
    assert.equal(afterPlans[0].approved, true);
    assert.ok(afterPlans[0].approvedAt);
  });

  it('reject removes pending plan but preserves id/subagentRef/createdAt', async () => {
    const ctx = await scaffoldProjectWithSubagentMd();
    const before = await ctx.store.load(ctx.config.id);

    const result = await processApproval({
      agentId: ctx.config.id,
      decision: 'reject',
      dataDir: ctx.dataDir,
    });
    assert.ok(result.success);

    const after = await ctx.store.load(ctx.config.id);
    assert.equal(after.id, before.id);
    assert.equal(after.subagentRef, before.subagentRef);
    assert.equal(after.createdAt, before.createdAt);
    const afterPlansR = await ctx.weeklyPlanStore.loadAll(ctx.config.id);
    assert.equal(afterPlansR.length, 0);
    assert.equal(after.identity, undefined);
  });

  it('edit mutates only plan.tasks; id/subagentRef/createdAt unchanged', async () => {
    const ctx = await scaffoldProjectWithSubagentMd();
    const before = await ctx.store.load(ctx.config.id);
    const beforePlans = await ctx.weeklyPlanStore.loadAll(ctx.config.id);

    const result = await processApproval({
      agentId: ctx.config.id,
      decision: 'edit',
      edits: [
        { action: 'add', title: 'Added by edit', prompt: 'Added by edit', objectiveId: ctx.obj.id },
      ],
      dataDir: ctx.dataDir,
    });
    assert.ok(result.success);

    const after = await ctx.store.load(ctx.config.id);
    const afterPlansE = await ctx.weeklyPlanStore.loadAll(ctx.config.id);
    assert.equal(after.id, before.id);
    assert.equal(after.subagentRef, before.subagentRef);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(afterPlansE[0].tasks.length, beforePlans[0].tasks.length + 1);
    assert.equal(after.identity, undefined);
  });
});
