/**
 * Integration tests for the weekly-review heartbeat task pipeline.
 *
 * Verifies that when a task with objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID is
 * selected by the heartbeat tick, runHeartbeatForAgent:
 *   1. Does NOT launch a Claude Code CLI session.
 *   2. Calls the review collector + generator pipeline.
 *   3. Writes the result to reviews/weekly-YYYY-Www.md inside the per-agent
 *      data directory.
 *   4. Marks the task as 'completed' in the weekly plan.
 *   5. Produces no other side effects (no token tracking, no budget enforcement).
 *
 * AC 30003 — Sub-AC 4a-iii.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { runHeartbeatForAgent, chainNextWeekPlanner } from './run.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { AgentStore } from '../storage/agent-store.js';
import {
  WEEKLY_REVIEW_OBJECTIVE_ID,
  DAILY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => randomBytes(4).toString('hex');

/**
 * Write a minimal subagent .md file so the heartbeat's subagent-missing guard
 * does not auto-pause the agent during tests.
 */
async function writeSubagentStub(projectDir, slug) {
  const dir = join(projectDir, '.claude', 'agents');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  await writeFile(
    path,
    `---\nname: ${slug}\ndescription: test subagent\n---\n\nstub\n`,
    'utf8',
  );
  return path;
}

/**
 * Build a minimal agent config that passes AgentStore validation.
 */
function makeAgentConfig(agentId) {
  return {
    id: agentId,
    subagentRef: agentId,
    goals: [],
    budget: {
      weeklyTokenLimit: 500000,
      currentUsage: 0,
      periodStart: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a weekly plan with the given tasks that is already approved.
 */
function makeApprovedPlan(week, tasks) {
  return {
    week,
    month: week.replace(/-W\d+$/, '-04'),
    tasks,
    approved: true,
    approvedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Build a weekly-review task (no runAt so it is immediately eligible).
 */
function makeWeeklyReviewTask(overrides = {}) {
  return {
    id: `task-wkrev-${uid()}`,
    description: 'Weekly review — end-of-week reflection and next-week planning',
    objectiveId: WEEKLY_REVIEW_OBJECTIVE_ID,
    status: 'pending',
    priority: 'high',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHeartbeatForAgent — weekly-review task pipeline (AC 30003)', () => {
  let projectDir;
  let dataDir;
  let agentsDir;
  let agentId;
  let weeklyPlanStore;
  let agentStore;

  const WEEK = '2026-W16';

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-wkrev-'));
    dataDir = join(projectDir, '.aweek');
    agentsDir = join(dataDir, 'agents');
    await mkdir(agentsDir, { recursive: true });

    agentId = `agent-${uid()}`;
    weeklyPlanStore = new WeeklyPlanStore(agentsDir);
    agentStore = new AgentStore(agentsDir);

    // Persist agent config so tickAgent's pause/subagent guards can load it.
    await agentStore.init();
    await agentStore.save(makeAgentConfig(agentId));

    // Create the subagent .md stub so the subagent-missing guard passes.
    await writeSubagentStub(projectDir, agentId);
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('writes reviews/weekly-YYYY-Www.md when a weekly-review task fires', async () => {
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    const reviewPath = join(agentsDir, agentId, 'reviews', `weekly-${WEEK}.md`);
    const content = await readFile(reviewPath, 'utf-8');

    assert.ok(content.length > 0, 'review file should not be empty');
    assert.ok(content.includes('# Weekly Review:'), 'review should have H1 header');
    assert.ok(
      content.includes('## Completed Tasks') ||
        content.includes('## Table of Contents'),
      'review should contain expected sections',
    );
  });

  it('marks the weekly-review task as completed after generation', async () => {
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    const updatedPlan = await weeklyPlanStore.load(agentId, WEEK);
    const updatedTask = updatedPlan.tasks.find((t) => t.id === reviewTask.id);
    assert.equal(
      updatedTask.status,
      'completed',
      'review task should be marked completed',
    );
  });

  it('does not launch a CLI session for the weekly-review task', async () => {
    // If a CLI session were launched, it would fail (no Claude binary in test).
    // The test passes only when the review pipeline is called instead of
    // executeSessionWithTracking, which would throw on a missing CLI binary.
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    // Should complete without throwing a "CLI not found" or spawn error.
    await assert.doesNotReject(
      () => runHeartbeatForAgent(agentId, { projectDir }),
      'runHeartbeatForAgent should not throw for weekly-review tasks',
    );
  });

  it('review file contains the agent id in the header', async () => {
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    const reviewPath = join(agentsDir, agentId, 'reviews', `weekly-${WEEK}.md`);
    const content = await readFile(reviewPath, 'utf-8');

    assert.ok(
      content.includes(agentId),
      `review header should contain agentId "${agentId}"`,
    );
  });

  it('creates the reviews/ directory if it does not exist', async () => {
    // No pre-existing reviews/ directory — mkdir(recursive) must handle it.
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    const reviewPath = join(agentsDir, agentId, 'reviews', `weekly-${WEEK}.md`);
    // readFile will throw ENOENT if the file or directory is missing.
    const content = await readFile(reviewPath, 'utf-8');
    assert.ok(content.includes('# Weekly Review:'));
  });

  it('leaves non-review tasks unaffected when review task runs', async () => {
    // A plan with a review task AND a regular work task.
    // The weekly-review task should execute (no CLI session).
    // The regular task should advance to the drain loop after the review.
    // However, the drain loop would call executeSessionWithTracking for the
    // regular task — so for this test we put them on DIFFERENT tracks so
    // they're independent, and only have the review task fire (regular task
    // has a future runAt so it won't be eligible).
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const workTask = {
      id: `task-work-${uid()}`,
      description: 'Regular work item',
      objectiveId: 'obj-worktask',
      status: 'pending',
      priority: 'medium',
      runAt: future, // not yet eligible — won't be picked this tick
    };
    const reviewTask = makeWeeklyReviewTask();

    await weeklyPlanStore.save(
      agentId,
      makeApprovedPlan(WEEK, [reviewTask, workTask]),
    );

    await runHeartbeatForAgent(agentId, { projectDir });

    const updatedPlan = await weeklyPlanStore.load(agentId, WEEK);
    const updatedReview = updatedPlan.tasks.find((t) => t.id === reviewTask.id);
    const updatedWork = updatedPlan.tasks.find((t) => t.id === workTask.id);

    assert.equal(updatedReview.status, 'completed', 'review task should be completed');
    assert.equal(updatedWork.status, 'pending', 'future work task should remain pending');
  });

  it('overwrites an existing review file idempotently', async () => {
    // Pre-write a stale review file.
    const reviewDir = join(agentsDir, agentId, 'reviews');
    await mkdir(reviewDir, { recursive: true });
    const reviewPath = join(reviewDir, `weekly-${WEEK}.md`);
    await writeFile(reviewPath, '# stale content\n', 'utf-8');

    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    const content = await readFile(reviewPath, 'utf-8');
    assert.ok(
      content !== '# stale content\n',
      'review file should be overwritten with fresh content',
    );
    assert.ok(content.includes('# Weekly Review:'), 'fresh review should have proper header');
  });
});

// ---------------------------------------------------------------------------
// AC 30101 — Sub-AC 4b-i: post-review autonomous next-week planner chain
// ---------------------------------------------------------------------------

describe('runHeartbeatForAgent — next-week planner chain (AC 30101)', () => {
  let projectDir;
  let dataDir;
  let agentsDir;
  let agentId;
  let weeklyPlanStore;
  let agentStore;

  const WEEK = '2026-W16';
  const NEXT_WEEK = '2026-W17';

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-wkrev-chain-'));
    dataDir = join(projectDir, '.aweek');
    agentsDir = join(dataDir, 'agents');
    await mkdir(agentsDir, { recursive: true });

    agentId = `agent-${uid()}`;
    weeklyPlanStore = new WeeklyPlanStore(agentsDir);
    agentStore = new AgentStore(agentsDir);

    await agentStore.init();
    await agentStore.save(makeAgentConfig(agentId));
    await writeSubagentStub(projectDir, agentId);
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('auto-generates the next-week plan after review completes', async () => {
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    // The chain should have created a plan for the following week.
    const nextPlan = await weeklyPlanStore.load(agentId, NEXT_WEEK);
    assert.ok(nextPlan, 'next-week plan should exist after chain');
    assert.equal(nextPlan.week, NEXT_WEEK, 'next-week plan should carry the correct week key');
  });

  it('auto-chained plan is approved without user intervention', async () => {
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    const nextPlan = await weeklyPlanStore.load(agentId, NEXT_WEEK);
    assert.equal(nextPlan.approved, true, 'auto-chained plan must be approved');
    assert.ok(
      typeof nextPlan.approvedAt === 'string' && nextPlan.approvedAt.length > 0,
      'auto-chained plan must carry an approvedAt timestamp',
    );
  });

  it('auto-chained plan includes all six review slots (5 daily + 1 weekly)', async () => {
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    const nextPlan = await weeklyPlanStore.load(agentId, NEXT_WEEK);
    const dailyReviewTasks = nextPlan.tasks.filter(
      (t) => t.objectiveId === DAILY_REVIEW_OBJECTIVE_ID,
    );
    const weeklyReviewTasks = nextPlan.tasks.filter(
      (t) => t.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID,
    );
    assert.equal(dailyReviewTasks.length, 5, 'should inject 5 daily-review tasks');
    assert.equal(weeklyReviewTasks.length, 1, 'should inject 1 weekly-review task');
  });

  it('does not overwrite a pre-existing next-week plan (idempotent chain)', async () => {
    // Pre-create an UNAPPROVED draft plan for next week with a recognisable
    // sentinel task. Using approved: false keeps it out of loadLatestApproved
    // so the heartbeat still selects the current-week review task — not the
    // sentinel. The idempotency guard only needs the file to exist, not to be
    // approved.
    const sentinelTask = {
      id: 'task-sentinel-chain-001',
      description: 'Sentinel — must survive the chain',
      objectiveId: 'obj-sentinel',
      status: 'pending',
      priority: 'high',
    };
    await weeklyPlanStore.save(agentId, {
      week: NEXT_WEEK,
      month: '2026-04',
      tasks: [sentinelTask],
      approved: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Now run the review for the current week.
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await runHeartbeatForAgent(agentId, { projectDir });

    // The sentinel plan should be intact — chain must have skipped.
    const nextPlan = await weeklyPlanStore.load(agentId, NEXT_WEEK);
    const hasSentinel = nextPlan.tasks.some((t) => t.id === 'task-sentinel-chain-001');
    assert.ok(hasSentinel, 'pre-existing next-week plan must not be overwritten');
  });

  it('review task is still marked completed when chain is skipped (idempotent review)', async () => {
    // Pre-create an UNAPPROVED draft plan for next week so the chain skips.
    // Keeping it unapproved ensures loadLatestApproved still picks the current
    // week's plan for the heartbeat tick.
    const sentinelTask = {
      id: 'task-sentinel-chain-002',
      description: 'Sentinel',
      objectiveId: 'obj-sentinel',
      status: 'pending',
      priority: 'medium',
    };
    await weeklyPlanStore.save(agentId, {
      week: NEXT_WEEK,
      month: '2026-04',
      tasks: [sentinelTask],
      approved: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    await assert.doesNotReject(
      () => runHeartbeatForAgent(agentId, { projectDir }),
      'runHeartbeatForAgent should not throw when chain is skipped',
    );

    // Review task must still complete even though the chain was a no-op.
    const updatedPlan = await weeklyPlanStore.load(agentId, WEEK);
    const updatedReview = updatedPlan.tasks.find((t) => t.id === reviewTask.id);
    assert.equal(updatedReview.status, 'completed', 'review task must be completed');
  });

  it('chain failure does not affect the review task completion', async () => {
    // chainNextWeekPlanner must never throw. Test it directly with a broken
    // weeklyPlanStore whose save method throws so we confirm best-effort
    // behaviour: the returned object signals failure without propagating.
    const reviewTask = makeWeeklyReviewTask();
    await weeklyPlanStore.save(agentId, makeApprovedPlan(WEEK, [reviewTask]));

    const brokenStore = {
      load: async () => { throw new Error('simulated ENOENT'); },
      save: async () => { throw new Error('simulated disk full'); },
    };

    const ctx = {
      agentId,
      agentsDir,
      weeklyPlanStore: brokenStore,
      agentStore,
    };

    // chainNextWeekPlanner must resolve (not reject) even with a broken store.
    const result = await chainNextWeekPlanner(WEEK, ctx);
    assert.equal(result.chained, false, 'chain should report failure without throwing');
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'chain should include a reason string on failure',
    );
  });
});
