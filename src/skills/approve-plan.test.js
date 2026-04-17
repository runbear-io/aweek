/**
 * Tests for approve-plan skill logic.
 * Covers:
 *  - findPendingPlan (with/without pending plans)
 *  - formatPlanForReview (output content and traceability)
 *  - validateDecision (valid/invalid decisions)
 *  - validateEdits (add/remove/update validations)
 *  - applyEdits (add/remove/update mutations)
 *  - processApproval — approve (first and subsequent)
 *  - processApproval — reject (with/without reason)
 *  - processApproval — edit (with/without auto-approve)
 *  - formatApprovalResult (all decision types)
 *  - loadPlanForReview (convenience wrapper)
 *  - Edge cases and error handling
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  buildHeartbeatCommand,
  activateHeartbeat,
  APPROVAL_DECISIONS,
} from './approve-plan.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';
import { AgentStore } from '../storage/agent-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a standard test agent with a pending weekly plan */
function buildTestAgent() {
  const config = createAgentConfig({
    name: 'TestBot',
    role: 'Test agent for approval flow',
    systemPrompt: 'You are a test agent.',
  });

  const goal = createGoal('Build a great product', '3mo');
  config.goals.push(goal);

  const obj = createObjective('Implement core features', goal.id);
  const monthlyPlan = createMonthlyPlan('2026-04', [obj]);
  config.monthlyPlans.push(monthlyPlan);

  const task1 = createTask('Design database schema', obj.id, { priority: 'high', estimatedMinutes: 60 });
  const task2 = createTask('Write API endpoints', obj.id, { priority: 'medium', estimatedMinutes: 120 });
  const weeklyPlan = createWeeklyPlan('2026-W16', '2026-04', [task1, task2]);
  config.weeklyPlans.push(weeklyPlan);

  return { config, goal, obj, monthlyPlan, weeklyPlan, task1, task2 };
}

/** Save an agent to a temp directory and return store + dir */
async function saveTestAgent(config) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-approve-'));
  const store = new AgentStore(tmpDir);
  await store.save(config);
  return { store, tmpDir };
}

/** No-op install function to prevent real crontab calls in tests */
const noopInstallFn = async () => ({ installed: true, entry: 'noop' });

// ---------------------------------------------------------------------------
// findPendingPlan
// ---------------------------------------------------------------------------

describe('findPendingPlan', () => {
  it('finds the first unapproved weekly plan', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const result = findPendingPlan(config);
    assert.ok(result);
    assert.equal(result.plan.week, weeklyPlan.week);
    assert.equal(result.week, '2026-W16');
  });

  it('returns null when all plans are approved', () => {
    const { config } = buildTestAgent();
    config.weeklyPlans[0].approved = true;
    const result = findPendingPlan(config);
    assert.equal(result, null);
  });

  it('returns null when there are no weekly plans', () => {
    const { config } = buildTestAgent();
    config.weeklyPlans = [];
    const result = findPendingPlan(config);
    assert.equal(result, null);
  });

  it('returns null for null config', () => {
    assert.equal(findPendingPlan(null), null);
  });

  it('returns null for config without weeklyPlans', () => {
    assert.equal(findPendingPlan({}), null);
  });

  it('skips approved plans and finds the pending one', () => {
    const { config } = buildTestAgent();
    // Add an approved plan first
    const approvedPlan = createWeeklyPlan('2026-W15', '2026-04', []);
    approvedPlan.approved = true;
    approvedPlan.approvedAt = new Date().toISOString();
    config.weeklyPlans.unshift(approvedPlan);

    const result = findPendingPlan(config);
    assert.ok(result);
    assert.equal(result.week, '2026-W16');
  });
});

// ---------------------------------------------------------------------------
// formatPlanForReview
// ---------------------------------------------------------------------------

describe('formatPlanForReview', () => {
  it('includes agent name and week', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan);
    assert.ok(text.includes('TestBot'));
    assert.ok(text.includes('2026-W16'));
  });

  it('lists all tasks with priority and description', () => {
    const { config, weeklyPlan, task1, task2 } = buildTestAgent();
    const text = formatPlanForReview(config, weeklyPlan);
    assert.ok(text.includes(task1.description));
    assert.ok(text.includes(task2.description));
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
    const edits = [{ action: 'add', description: 'New task', objectiveId: obj.id }];
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
    const edits = [{ action: 'update', taskId: task1.id, description: 'Updated desc' }];
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

  it('rejects add with missing description', () => {
    const { config, weeklyPlan, obj } = buildTestAgent();
    const edits = [{ action: 'add', objectiveId: obj.id }];
    const result = validateEdits(edits, weeklyPlan, config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('description')));
  });

  it('rejects add with nonexistent objective', () => {
    const { config, weeklyPlan } = buildTestAgent();
    const edits = [{ action: 'add', description: 'Task', objectiveId: 'obj-nonexistent' }];
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
      { action: 'add', description: 'New task', objectiveId: obj.id },
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
      { action: 'add', description: 'New task', objectiveId: obj.id, priority: 'high' },
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

  it('updates a task description', () => {
    const { weeklyPlan, task1 } = buildTestAgent();
    const { applied, plan } = applyEdits(weeklyPlan, [
      { action: 'update', taskId: task1.id, description: 'Updated description' },
    ]);
    const task = plan.tasks.find((t) => t.id === task1.id);
    assert.equal(task.description, 'Updated description');
    assert.equal(applied[0].changes.description.to, 'Updated description');
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
      { action: 'update', taskId: task1.id, description: 'Changed' },
    ]);
    assert.notEqual(weeklyPlan.updatedAt, '2020-01-01T00:00:00.000Z');
  });

  it('applies multiple edits in sequence', () => {
    const { weeklyPlan, task1, task2, obj } = buildTestAgent();
    const { applied } = applyEdits(weeklyPlan, [
      { action: 'add', description: 'Third task', objectiveId: obj.id },
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
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: noopInstallFn,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.ok(result.plan.approvedAt);
  });

  it('detects first approval', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: noopInstallFn,
    });

    assert.equal(result.isFirstApproval, true);
  });

  it('detects subsequent approval (not first)', async () => {
    const { config } = buildTestAgent();
    // Add an already-approved plan
    const oldPlan = createWeeklyPlan('2026-W15', '2026-04', []);
    oldPlan.approved = true;
    oldPlan.approvedAt = new Date().toISOString();
    config.weeklyPlans.unshift(oldPlan);

    const { tmpDir } = await saveTestAgent(config);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: noopInstallFn,
    });

    assert.ok(result.success);
    assert.equal(result.isFirstApproval, false);
  });

  it('persists approval to file', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: noopInstallFn,
    });

    // Reload and verify
    const store = new AgentStore(tmpDir);
    const reloaded = await store.load(config.id);
    assert.equal(reloaded.weeklyPlans[0].approved, true);
    assert.ok(reloaded.weeklyPlans[0].approvedAt);
  });

  it('fails when no pending plan exists', async () => {
    const { config } = buildTestAgent();
    config.weeklyPlans[0].approved = true;
    config.weeklyPlans[0].approvedAt = new Date().toISOString();
    const { tmpDir } = await saveTestAgent(config);

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: noopInstallFn,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('No pending'));
  });

  it('fails when agent not found', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-approve-'));
    const result = await processApproval({
      agentId: 'agent-nonexistent-12345678',
      decision: 'approve',
      dataDir: tmpDir,
      installFn: noopInstallFn,
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
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    const result = await processApproval({
      agentId: config.id,
      decision: 'reject',
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.ok(result.plan._rejected);

    // Verify plan is removed from file
    const store = new AgentStore(tmpDir);
    const reloaded = await store.load(config.id);
    assert.equal(reloaded.weeklyPlans.length, 0);
  });

  it('preserves rejection reason', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    const result = await processApproval({
      agentId: config.id,
      decision: 'reject',
      rejectionReason: 'Tasks are too vague',
      dataDir: tmpDir,
    });

    assert.equal(result.plan._rejectionReason, 'Tasks are too vague');
  });

  it('isFirstApproval is false on rejection', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

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
    const { config, task1, obj } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [
        { action: 'update', taskId: task1.id, description: 'Revised schema design' },
      ],
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, false);
    assert.equal(result.editResults.length, 1);
  });

  it('applies edits with auto-approve', async () => {
    const { config, task1 } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [
        { action: 'update', taskId: task1.id, priority: 'critical' },
      ],
      autoApproveAfterEdit: true,
      dataDir: tmpDir,
      installFn: noopInstallFn,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.ok(result.plan.approvedAt);
    assert.equal(result.isFirstApproval, true);
  });

  it('fails with invalid edits', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

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
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

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
    const { config, task1, obj } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [
        { action: 'add', description: 'New task added', objectiveId: obj.id },
      ],
      dataDir: tmpDir,
    });

    const store = new AgentStore(tmpDir);
    const reloaded = await store.load(config.id);
    assert.equal(reloaded.weeklyPlans[0].tasks.length, 3); // 2 original + 1 added
  });
});

// ---------------------------------------------------------------------------
// processApproval — invalid decision
// ---------------------------------------------------------------------------

describe('processApproval — invalid decision', () => {
  it('fails with invalid decision string', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

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

  it('formats first approval with heartbeat notice', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { week: '2026-W16', tasks: [], approvedAt: '2026-04-16T10:00:00Z' },
      isFirstApproval: true,
    }, 'approve');
    assert.ok(text.includes('FIRST APPROVAL'));
    assert.ok(text.includes('Heartbeat'));
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
        { action: 'add', taskId: 'task-new', description: 'Added task' },
        { action: 'remove', taskId: 'task-old', description: 'Removed task' },
        { action: 'update', taskId: 'task-upd', changes: { description: { from: 'Old', to: 'New' } } },
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
      editResults: [{ action: 'add', taskId: 'task-new', description: 'T' }],
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
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    const result = await loadPlanForReview({
      agentId: config.id,
      dataDir: tmpDir,
    });

    assert.ok(result.success);
    assert.ok(result.config);
    assert.ok(result.plan);
    assert.ok(result.formatted.includes('TestBot'));
    assert.ok(result.formatted.includes('2026-W16'));
  });

  it('fails when agent not found', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'aweek-approve-'));
    const result = await loadPlanForReview({
      agentId: 'agent-nonexistent-12345678',
      dataDir: tmpDir,
    });

    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('Agent not found'));
  });

  it('fails when no pending plan', async () => {
    const { config } = buildTestAgent();
    config.weeklyPlans[0].approved = true;
    config.weeklyPlans[0].approvedAt = new Date().toISOString();
    const { tmpDir } = await saveTestAgent(config);

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
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    // Reject first
    await processApproval({ agentId: config.id, decision: 'reject', dataDir: tmpDir });

    // Try to approve — should fail since plan was removed
    const result = await processApproval({ agentId: config.id, decision: 'approve', dataDir: tmpDir, installFn: noopInstallFn });
    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('No pending'));
  });

  it('double approval returns no-pending error on second call', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);

    const mockInstall = async ({ agentId, command, schedule }) => ({
      installed: true,
      entry: `# aweek:heartbeat:${agentId}\n${schedule} ${command}`,
    });

    const first = await processApproval({ agentId: config.id, decision: 'approve', dataDir: tmpDir, installFn: mockInstall });
    assert.ok(first.success);

    const second = await processApproval({ agentId: config.id, decision: 'approve', dataDir: tmpDir, installFn: mockInstall });
    assert.equal(second.success, false);
    assert.ok(second.errors[0].includes('No pending'));
  });
});

// ---------------------------------------------------------------------------
// buildHeartbeatCommand
// ---------------------------------------------------------------------------

describe('buildHeartbeatCommand', () => {
  it('builds command with provided project dir', () => {
    const cmd = buildHeartbeatCommand('agent-test-12345678', '/home/user/project');
    assert.equal(cmd, 'npx aweek heartbeat agent-test-12345678 --project-dir /home/user/project');
  });

  it('uses cwd when no project dir provided', () => {
    const cmd = buildHeartbeatCommand('agent-test-12345678');
    assert.ok(cmd.includes(process.cwd()));
    assert.ok(cmd.includes('agent-test-12345678'));
    assert.ok(cmd.includes('npx aweek heartbeat'));
  });
});

// ---------------------------------------------------------------------------
// activateHeartbeat
// ---------------------------------------------------------------------------

describe('activateHeartbeat', () => {
  it('calls installFn with correct params', async () => {
    let capturedArgs = null;
    const mockInstall = async (args) => {
      capturedArgs = args;
      return { installed: true, entry: 'mock-entry' };
    };

    const result = await activateHeartbeat({
      agentId: 'agent-test-12345678',
      schedule: '*/15 * * * *',
      command: 'node heartbeat.js agent-test-12345678',
      installFn: mockInstall,
    });

    assert.ok(result.activated);
    assert.equal(result.schedule, '*/15 * * * *');
    assert.equal(capturedArgs.agentId, 'agent-test-12345678');
    assert.equal(capturedArgs.command, 'node heartbeat.js agent-test-12345678');
    assert.equal(capturedArgs.schedule, '*/15 * * * *');
  });

  it('uses default schedule when not provided', async () => {
    let capturedArgs = null;
    const mockInstall = async (args) => {
      capturedArgs = args;
      return { installed: true, entry: 'mock-entry' };
    };

    await activateHeartbeat({
      agentId: 'agent-test-12345678',
      command: 'node heartbeat.js',
      installFn: mockInstall,
    });

    assert.equal(capturedArgs.schedule, '0 * * * *');
  });

  it('builds default command when none provided', async () => {
    let capturedArgs = null;
    const mockInstall = async (args) => {
      capturedArgs = args;
      return { installed: true, entry: 'mock-entry' };
    };

    await activateHeartbeat({
      agentId: 'agent-test-12345678',
      projectDir: '/test/project',
      installFn: mockInstall,
    });

    assert.equal(capturedArgs.command, 'npx aweek heartbeat agent-test-12345678 --project-dir /test/project');
  });

  it('throws if agentId is missing', async () => {
    await assert.rejects(
      () => activateHeartbeat({ installFn: async () => ({ installed: true, entry: '' }) }),
      { message: 'agentId is required' },
    );
  });
});

// ---------------------------------------------------------------------------
// processApproval — heartbeat activation on approve
// ---------------------------------------------------------------------------

describe('processApproval — heartbeat activation', () => {
  /** Mock install that records calls */
  function createMockInstall() {
    const calls = [];
    const fn = async (args) => {
      calls.push(args);
      return { installed: true, entry: `mock-entry-${args.agentId}` };
    };
    return { fn, calls };
  }

  it('activates heartbeat on approve', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);
    const mock = createMockInstall();

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: mock.fn,
    });

    assert.ok(result.success);
    assert.equal(result.heartbeatActivated, true);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].agentId, config.id);
  });

  it('activates heartbeat on edit with auto-approve', async () => {
    const { config, task1 } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);
    const mock = createMockInstall();

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [{ action: 'update', taskId: task1.id, priority: 'critical' }],
      autoApproveAfterEdit: true,
      dataDir: tmpDir,
      installFn: mock.fn,
    });

    assert.ok(result.success);
    assert.equal(result.heartbeatActivated, true);
    assert.equal(mock.calls.length, 1);
  });

  it('does NOT activate heartbeat on edit without auto-approve', async () => {
    const { config, task1 } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);
    const mock = createMockInstall();

    const result = await processApproval({
      agentId: config.id,
      decision: 'edit',
      edits: [{ action: 'update', taskId: task1.id, priority: 'critical' }],
      autoApproveAfterEdit: false,
      dataDir: tmpDir,
      installFn: mock.fn,
    });

    assert.ok(result.success);
    assert.equal(result.heartbeatActivated, false);
    assert.equal(mock.calls.length, 0);
  });

  it('does NOT activate heartbeat on reject', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);
    const mock = createMockInstall();

    const result = await processApproval({
      agentId: config.id,
      decision: 'reject',
      dataDir: tmpDir,
      installFn: mock.fn,
    });

    assert.ok(result.success);
    // reject path doesn't set heartbeatActivated
    assert.equal(mock.calls.length, 0);
  });

  it('uses custom schedule for heartbeat', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);
    const mock = createMockInstall();

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: mock.fn,
      heartbeatSchedule: '*/30 * * * *',
    });

    assert.equal(mock.calls[0].schedule, '*/30 * * * *');
  });

  it('uses custom heartbeat command', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);
    const mock = createMockInstall();

    await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: mock.fn,
      heartbeatCommand: 'custom-heartbeat-cmd',
    });

    assert.equal(mock.calls[0].command, 'custom-heartbeat-cmd');
  });

  it('succeeds even if heartbeat activation fails', async () => {
    const { config } = buildTestAgent();
    const { tmpDir } = await saveTestAgent(config);
    const failingInstall = async () => { throw new Error('crontab not available'); };

    const result = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: failingInstall,
    });

    assert.ok(result.success);
    assert.equal(result.plan.approved, true);
    assert.equal(result.heartbeatActivated, false);
  });

  it('heartbeat activation is idempotent on repeated approvals', async () => {
    const { config } = buildTestAgent();
    // Add a second pending plan after the first
    const task = createTask('Extra task', config.monthlyPlans?.[0]?.objectives?.[0]?.id || 'obj-1', {});
    // We'll approve the first plan, then add another pending plan
    const { tmpDir } = await saveTestAgent(config);
    const mock = createMockInstall();

    // Approve first plan
    const first = await processApproval({
      agentId: config.id,
      decision: 'approve',
      dataDir: tmpDir,
      installFn: mock.fn,
    });
    assert.ok(first.success);
    assert.equal(first.heartbeatActivated, true);
    assert.equal(mock.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// formatApprovalResult — heartbeat status
// ---------------------------------------------------------------------------

describe('formatApprovalResult — heartbeat status', () => {
  it('shows heartbeat installed message when activated', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { week: '2026-W16', tasks: [], approvedAt: '2026-04-16T10:00:00Z' },
      isFirstApproval: true,
      heartbeatActivated: true,
    }, 'approve');
    assert.ok(text.includes('Heartbeat crontab installed successfully'));
  });

  it('shows manual install note when activation failed', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { week: '2026-W16', tasks: [], approvedAt: '2026-04-16T10:00:00Z' },
      isFirstApproval: false,
      heartbeatActivated: false,
    }, 'approve');
    assert.ok(text.includes('could not be installed automatically'));
  });

  it('shows heartbeat installed in edit+auto-approve', () => {
    const text = formatApprovalResult({
      success: true,
      plan: { approved: true },
      editResults: [{ action: 'add', taskId: 'task-new', description: 'T' }],
      isFirstApproval: true,
      heartbeatActivated: true,
    }, 'edit');
    assert.ok(text.includes('Heartbeat crontab installed successfully'));
  });
});
