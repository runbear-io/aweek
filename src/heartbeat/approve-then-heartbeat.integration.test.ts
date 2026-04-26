/**
 * Integration test — AC 7: newly approved weekly plans are picked up by
 * `aweek heartbeat --all` on next tick without per-agent crontab activation.
 *
 * Verifies the scheduling-state-only invariant after the per-agent crontab
 * path was removed:
 *
 *   1. A pending weekly plan is created on disk via WeeklyPlanStore.
 *   2. The plan is approved through the public `processApproval` flow
 *      (`/aweek:plan` calls into this service). The approval mutates only
 *      disk state — no crontab interaction, no heartbeat activation call.
 *   3. The next `runHeartbeatForAll` tick (the function backing
 *      `aweek heartbeat --all`) reads the freshly approved plan from disk
 *      via `WeeklyPlanStore.loadLatestApproved` and selects a pending task.
 *
 * The post-approval pipeline (CLI session launch, token tracking, budget
 * enforcement) is exercised by other integration tests; this test focuses
 * narrowly on the discovery handoff between approval and the heartbeat tick.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { processApproval } from '../services/plan-approval.js';
import { tickAgent } from './heartbeat-task-runner.js';
import { runHeartbeatForAll } from './run.js';
import {
  createAgentConfig,
  createGoal,
  createObjective,
  createMonthlyPlan,
  createTask,
  createWeeklyPlan,
} from '../models/agent.js';

const uid = () => randomBytes(4).toString('hex');

async function setupProject() {
  const projectDir = await mkdtemp(join(tmpdir(), 'aweek-ac7-'));
  const dataDir = join(projectDir, '.aweek');
  const agentsDir = join(dataDir, 'agents');
  await mkdir(agentsDir, { recursive: true });
  return { projectDir, dataDir, agentsDir };
}

/**
 * Seed an agent on disk with a pending (unapproved) weekly plan and the
 * goals/objectives it traces to.
 */
async function seedAgentWithPendingPlan({ agentsDir, week = '2026-W17', month = '2026-04' }) {
  const subagentRef = `agent-${uid()}`;
  const config = createAgentConfig({ subagentRef });

  const goal = createGoal('Grow weekly newsletter to 1k subscribers');
  const objective = createObjective('Publish two long-form essays', goal.id);
  config.goals = [goal];
  config.monthlyPlans = [createMonthlyPlan(month, [objective])];

  const task = createTask({ title: 'Outline the first essay', prompt: 'Outline the first essay' }, objective.id, {
    priority: 'high',
  });
  const plan = createWeeklyPlan(week, month, [task]);
  // `createWeeklyPlan` now defaults to `approved: true`; flip back to pending
  // so this AC-7 seed exercises the approve-then-heartbeat handoff.
  plan.approved = false;

  const agentStore = new AgentStore(agentsDir);
  await agentStore.save(config);

  const weeklyPlanStore = new WeeklyPlanStore(agentsDir);
  await weeklyPlanStore.save(subagentRef, plan);

  return { agentId: subagentRef, plan, task, week };
}

describe('AC 7 — approval → heartbeat handoff (no per-agent crontab)', () => {
  let projectDir;
  let dataDir;
  let agentsDir;

  beforeEach(async () => {
    ({ projectDir, dataDir, agentsDir } = await setupProject());
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('approving a pending plan via processApproval flips it to approved on disk only', async () => {
    const { agentId, week } = await seedAgentWithPendingPlan({ agentsDir });

    // Sanity: before approval, no approved plan exists.
    const weeklyPlanStore = new WeeklyPlanStore(agentsDir);
    assert.equal(await weeklyPlanStore.loadLatestApproved(agentId), null);

    const result = await processApproval({
      agentId,
      decision: 'approve',
      dataDir: agentsDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.isFirstApproval, true);
    assert.equal(result.plan.approved, true);
    assert.equal(result.plan.week, week);

    // The freshly approved plan is now the latest approved on disk.
    const persisted = await weeklyPlanStore.loadLatestApproved(agentId);
    assert.ok(persisted);
    assert.equal(persisted.week, week);
    assert.equal(persisted.approved, true);
  });

  it('next tickAgent run picks up the freshly approved plan and selects its pending task', async () => {
    const { agentId, week, task } = await seedAgentWithPendingPlan({ agentsDir });

    // Approve via the same code path the /aweek:plan skill takes.
    const approveResult = await processApproval({
      agentId,
      decision: 'approve',
      dataDir: agentsDir,
    });
    assert.equal(approveResult.success, true);

    // The next heartbeat tick discovers the plan by reading from disk —
    // there is no in-process subscription, no crontab refresh, nothing.
    const weeklyPlanStore = new WeeklyPlanStore(agentsDir);
    const tick = await tickAgent(agentId, { weeklyPlanStore });

    assert.equal(tick.outcome, 'task_selected');
    assert.equal(tick.week, week);
    assert.equal(tick.task.id, task.id);
    assert.equal(tick.task.title, 'Outline the first essay');
  });

  it('runHeartbeatForAll (aweek heartbeat --all entry point) picks up the freshly approved plan', async () => {
    // A subagent .md file at .claude/agents/<slug>.md is required by the
    // tickAgent's subagent-file guard. Provide a minimal one so the tick
    // proceeds past the auto-pause check.
    const claudeAgentsDir = join(projectDir, '.claude', 'agents');
    await mkdir(claudeAgentsDir, { recursive: true });

    const { agentId, week, task } = await seedAgentWithPendingPlan({ agentsDir });

    await writeFile(
      join(claudeAgentsDir, `${agentId}.md`),
      `---\nname: ${agentId}\ndescription: AC 7 fixture\n---\n\nFixture body.\n`,
      'utf-8',
    );

    // Approve through the public service surface.
    const approveResult = await processApproval({
      agentId,
      decision: 'approve',
      dataDir: agentsDir,
    });
    assert.equal(approveResult.success, true);

    // Drive the same code path bin/aweek.ts calls for `aweek heartbeat --all`.
    // We pre-mark the task as completed so the post-selection CLI launch is
    // a no-op (no Claude binary needed in unit tests). The narrow assertion
    // is "the heartbeat saw the agent and tried to act on the approved
    // plan," not "the CLI session ran."
    //
    // To avoid the CLI launch entirely we mark the task completed AFTER
    // approval but BEFORE the tick — the heartbeat will then see the
    // approved plan, find no pending tasks, and return all_tasks_finished.
    // That outcome can ONLY be reached if the heartbeat saw the approved
    // plan (it would otherwise return no_approved_plan).
    const weeklyPlanStore = new WeeklyPlanStore(agentsDir);
    await weeklyPlanStore.updateTaskStatus(agentId, week, task.id, 'completed');

    const results = await runHeartbeatForAll({ projectDir });

    assert.equal(Array.isArray(results), true);
    assert.equal(results.length, 1);
    const [entry] = results;
    assert.equal(entry.agentId, agentId);
    assert.equal(entry.error, undefined, `heartbeat threw: ${entry.error}`);

    // The tick result the runner returns when no task is selected is the
    // raw TaskTickResult from tickAgent. Outcome must be all_tasks_finished
    // — proof that the approved plan was discovered (otherwise it would be
    // no_approved_plan) and inspected (otherwise no task summary).
    const tickResult = entry.result;
    assert.equal(tickResult.outcome, 'all_tasks_finished');
    assert.equal(tickResult.week, week);
    assert.equal(tickResult.summary.completed, 1);
    assert.equal(tickResult.summary.pending, 0);
  });

  it('approving a plan does not surface any per-agent crontab activation symbols', async () => {
    // Defence-in-depth: the plan-approval module must NOT re-introduce
    // activateHeartbeat / buildHeartbeatCommand. The only sanctioned
    // crontab surface lives in src/skills/init.js (project-level
    // heartbeat), and approval must reach disk only.
    const { agentId } = await seedAgentWithPendingPlan({ agentsDir });

    const result = await processApproval({
      agentId,
      decision: 'approve',
      dataDir: agentsDir,
    });
    assert.equal(result.success, true);

    const approvalModule = await import('../services/plan-approval.js');
    const approvalKeys = Object.keys(approvalModule);
    assert.equal(
      approvalKeys.includes('activateHeartbeat'),
      false,
      'plan-approval.js must not export activateHeartbeat',
    );
    assert.equal(
      approvalKeys.includes('buildHeartbeatCommand'),
      false,
      'plan-approval.js must not export buildHeartbeatCommand',
    );
  });
});
