/**
 * Heartbeat runner — wires stores, scheduler, and task execution for CLI invocation.
 *
 * This is the runtime entry point that crontab (via bin/aweek.js) calls every hour.
 * It assembles the full execution pipeline:
 *   1. Initialize stores (agent, weekly-plan, execution, usage) rooted at projectDir
 *   2. Create scheduler with lock isolation
 *   3. Run heartbeat tick (select next task, mark in-progress)
 *   4. Launch a Claude Code CLI session for the selected task
 *   5. Track token usage and enforce budget
 *
 * Designed to work when aweek is installed as an npm package — all file paths
 * are resolved relative to the user's project directory, not the package location.
 */

import { join } from 'node:path';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ExecutionStore, createExecutionRecord } from '../storage/execution-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { ActivityLogStore, createLogEntry } from '../storage/activity-log-store.js';
import { InboxStore } from '../storage/inbox-store.js';
import { createScheduler } from './scheduler.js';
import { tickAgent } from './heartbeat-task-runner.js';
import {
  selectTasksForTickFromPlan,
  trackKeyOf,
} from './task-selector.js';
import { executeSessionWithTracking } from '../execution/session-executor.js';
import { enforceBudget } from '../services/budget-enforcer.js';
import { loadConfig } from '../storage/config-store.js';
import { detectSystemTimeZone, mondayOfWeek } from '../time/zone.js';
import { WEEKLY_REVIEW_OBJECTIVE_ID, DAILY_REVIEW_OBJECTIVE_ID } from '../schemas/weekly-plan.schema.js';
import { generateWeeklyReview, nextISOWeek } from '../services/weekly-review-orchestrator.js';
import { generateDailyReview, utcToLocalDate } from '../services/daily-review-writer.js';
import { MonthlyPlanStore } from '../storage/monthly-plan-store.js';
import { generateWeeklyPlan } from '../services/weekly-plan-generator.js';
import { readPlan } from '../storage/plan-markdown-store.js';

/**
 * Extract URLs and file paths from session stdout.
 * Kept permissive — false positives are cheaper than missing an artifact.
 *
 * @param {string} text
 * @returns {{ urls: string[], filePaths: string[] }}
 */
export function extractResources(text) {
  if (!text || typeof text !== 'string') return { urls: [], filePaths: [] };

  const urlRe = /https?:\/\/[^\s<>")\]]+/g;
  const urls = Array.from(new Set(text.match(urlRe) || []));

  // File paths: absolute unix paths OR relative paths with a file extension
  const absPathRe = /(?:^|\s|=|"|')(\/[A-Za-z0-9._~/-]+)(?=[\s"'.,;)\]:]|$)/g;
  const relPathRe = /(?:^|\s|=|"|')([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,6})(?=[\s"'.,;)\]:]|$)/g;

  const filePaths = new Set();
  let match;
  while ((match = absPathRe.exec(text)) !== null) filePaths.add(match[1]);
  while ((match = relPathRe.exec(text)) !== null) filePaths.add(match[1]);

  return { urls, filePaths: Array.from(filePaths) };
}


/**
 * Run a heartbeat tick for a single agent.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (default: cwd)
 */
export async function runHeartbeatForAgent(agentId, opts = {}) {
  const projectDir = opts.projectDir || process.cwd();
  const dataDir = join(projectDir, '.aweek');

  const agentsDir = join(dataDir, 'agents');
  const agentStore = new AgentStore(agentsDir);
  const weeklyPlanStore = new WeeklyPlanStore(agentsDir);
  const executionStore = new ExecutionStore(agentsDir);
  const usageStore = new UsageStore(agentsDir);
  const activityLogStore = new ActivityLogStore(agentsDir);
  const inboxStore = new InboxStore(agentsDir);
  const lockDir = join(dataDir, 'locks');

  const scheduler = createScheduler({ lockDir });

  // Step 1: Select next task (first pick goes through tickAgent so the
  // dedup/shell/no-plan guards fire once per cron invocation).
  //
  // `projectDir` is forwarded so the tick's subagent-file guard can probe
  // `<projectDir>/.claude/agents/<slug>.md` without relying on a CWD that
  // cron may not preserve. If that file is missing AND the user-level
  // fallback (`~/.claude/agents/<slug>.md`) is also missing, the tick
  // persists `pausedReason: 'subagent_missing'` and returns a skipped
  // outcome rather than spawning a session that would crash-loop.
  const tickResult = await tickAgent(agentId, {
    weeklyPlanStore,
    executionStore,
    agentStore,
    projectDir,
  });

  console.log(`[${agentId}] tick outcome: ${tickResult.outcome}`);

  if (tickResult.outcome !== 'task_selected') {
    if (tickResult.reason) console.log(`  reason: ${tickResult.reason}`);
    return tickResult;
  }

  // Step 2: Run the first task through the full per-task pipeline.
  const config = await agentStore.load(agentId);
  const subagentRef = config.subagentRef || agentId;

  const execCtx = {
    agentId,
    subagentRef,
    projectDir,
    dataDir,
    agentsDir,
    weeklyPlanStore,
    usageStore,
    activityLogStore,
    agentStore,
    inboxStore,
  };

  const firstResult = await executeOneSelection(
    { task: tickResult.task, week: tickResult.week },
    execCtx,
  );

  // Track which "tracks" have already fired a task this tick so the
  // drain loop picks from DIFFERENT tracks rather than the next task in
  // the same track — that's the whole point of the track primitive.
  const firedTrackKeys = new Set([trackKeyOf(tickResult.task)]);
  const extraResults = [];
  const firstError = firstResult.error;

  // Step 3: Drain other tracks within this tick.
  //
  // Budget enforcement ran inside executeOneSelection. If it paused the
  // agent, stop draining — the next tick will respect the pause anyway,
  // but there's no point queuing another session we know will fail.
  while (true) {
    const paused = await _isAgentPaused(agentStore, agentId);
    if (paused) break;

    const plan = await weeklyPlanStore.loadLatestApproved(agentId);
    if (!plan) break;

    const picks = selectTasksForTickFromPlan(plan);
    const nextPick = picks.find((p) => !firedTrackKeys.has(p.trackKey));
    if (!nextPick) break;

    firedTrackKeys.add(nextPick.trackKey);
    await _recordStarted(executionStore, agentId, nextPick.task.id);

    const extra = await executeOneSelection(
      { task: nextPick.task, week: plan.week },
      execCtx,
    );
    extraResults.push(extra);
  }

  if (firstError) throw firstError;
  return {
    tickResult,
    execResult: firstResult.execResult,
    extraResults,
    drainedTrackCount: firedTrackKeys.size,
  };
}

/**
 * Autonomous post-review chain — generate and auto-approve the next week's plan.
 *
 * Triggered after a successful weekly review write. The generated plan is
 * immediately approved so the heartbeat can resume next week without waiting
 * for a manual approval step.
 *
 * Deterministic: given the same agent state the same plan structure is
 * produced. If a plan for the target week already exists on disk, the chain
 * is skipped (idempotent).
 *
 * Best-effort: every internal failure is caught and logged. The function
 * never throws so chain errors do NOT affect the review task's finalStatus.
 *
 * @param {string} currentWeek - The week that was just reviewed (e.g. '2026-W16')
 * @param {object} ctx - Store context captured in runHeartbeatForAgent
 * @param {string} ctx.agentId
 * @param {string} ctx.agentsDir
 * @param {import('../storage/weekly-plan-store.js').WeeklyPlanStore} ctx.weeklyPlanStore
 * @param {import('../storage/agent-store.js').AgentStore} ctx.agentStore
 * @returns {Promise<{ nextWeek: string | null, chained: boolean, reason?: string }>}
 */
export async function chainNextWeekPlanner(currentWeek, ctx) {
  const { agentId, agentsDir, weeklyPlanStore, agentStore } = ctx;
  let nextWeek = null;

  try {
    nextWeek = nextISOWeek(currentWeek);

    // Idempotency: skip if a plan for next week already exists on disk.
    // Prevents overwriting a plan the user (or a prior chain run) has already
    // created and possibly approved.
    let alreadyExists = false;
    try {
      await weeklyPlanStore.load(agentId, nextWeek);
      alreadyExists = true;
    } catch {
      // ENOENT or parse error → plan doesn't exist; proceed with generation.
    }

    if (alreadyExists) {
      console.log(`[${agentId}] next-week plan for ${nextWeek} already exists — skipping auto-chain`);
      return { nextWeek, chained: false, reason: 'plan_already_exists' };
    }

    // Load agent config for goals.
    let goals = [];
    let agentConfig;
    try {
      agentConfig = await agentStore.load(agentId);
      goals = Array.isArray(agentConfig.goals) ? agentConfig.goals : [];
    } catch {
      // Graceful: missing goals → plan will have only review tasks.
    }

    // Resolve the configured IANA time zone from .aweek/config.json.
    // loadConfig accepts agentsDir and walks up one level to .aweek/config.json.
    let tz = 'UTC';
    try {
      const aweekConfig = await loadConfig(agentsDir);
      if (aweekConfig?.timeZone) tz = aweekConfig.timeZone;
    } catch {
      // Graceful: fall back to UTC.
    }

    // Derive next week's month from its Monday date so we know which monthly
    // plan to look up. mondayOfWeek returns a UTC Date; slice gives YYYY-MM.
    const nextMondayUtc = mondayOfWeek(nextWeek, tz);
    const nextMonth =
      `${nextMondayUtc.getUTCFullYear()}-${String(nextMondayUtc.getUTCMonth() + 1).padStart(2, '0')}`;

    // Load the monthly plan. Prefer the exact month for next week; fall back
    // to the currently active plan; fall back to empty objectives.
    const monthlyPlanStore = new MonthlyPlanStore(agentsDir);
    let monthlyPlan = { objectives: [] };
    try {
      monthlyPlan = await monthlyPlanStore.load(agentId, nextMonth);
    } catch {
      try {
        const active = await monthlyPlanStore.loadActive(agentId);
        if (active) monthlyPlan = active;
      } catch {
        // Graceful: empty objectives → plan has only review tasks.
      }
    }

    // Load plan.md for advisor brief composition.
    let planMarkdown = null;
    try {
      planMarkdown = await readPlan(agentsDir, agentId);
    } catch {
      // Graceful: plan.md absence falls back to objective descriptions.
    }

    // Generate the next week's plan.
    const { plan, meta } = generateWeeklyPlan({
      week: nextWeek,
      month: nextMonth,
      goals,
      monthlyPlan,
      options: { planMarkdown, tz },
    });

    // Auto-approve: this is the autonomous chain — no human gate is needed.
    // The review that triggered this chain already confirmed the week is done.
    plan.approved = true;
    plan.approvedAt = new Date().toISOString();

    // Persist the auto-approved plan.
    await weeklyPlanStore.save(agentId, plan);

    console.log(
      `[${agentId}] auto-chained next-week plan for ${nextWeek}: ` +
        `${meta.totalTasks} tasks (${meta.reviewTasksAdded} review slots, auto-approved)`,
    );

    return { nextWeek, chained: true };
  } catch (err) {
    console.warn(`[${agentId}] next-week planner chain error: ${err.message}`);
    return { nextWeek, chained: false, reason: err.message };
  }
}

/**
 * Handle a daily-review heartbeat task: run the daily review pipeline and
 * write the result to `reviews/daily-YYYY-MM-DD.md` inside the per-agent
 * data directory.
 *
 * No CLI session is launched, no token usage is tracked, and no budget is
 * enforced for these synthetic tasks — the only side effects are:
 *   1. Writing the daily review markdown + JSON metadata files to disk.
 *   2. Marking the plan task as `completed` (or `failed` on error).
 *
 * The review date is derived from `task.runAt` converted to the configured
 * IANA timezone (falls back to UTC). Daily-review tasks always carry a
 * `runAt` set to the end-of-day wall-clock slot for their calendar day.
 *
 * @param {object} selection - { task, week }
 * @param {object} ctx - Stores + paths from runHeartbeatForAgent.
 * @returns {Promise<{ execResult: null, error: Error | null, finalStatus: 'completed' | 'failed' }>}
 */
async function executeDailyReviewTask(selection, ctx) {
  const {
    agentId,
    agentsDir,
    weeklyPlanStore,
    activityLogStore,
    agentStore,
  } = ctx;
  const { task, week } = selection;

  // Resolve the configured IANA timezone so the local date matches the user's
  // calendar day, not the UTC date. loadConfig walks up from agentsDir.
  let tz = 'UTC';
  try {
    const aweekConfig = await loadConfig(agentsDir);
    if (aweekConfig?.timeZone) tz = aweekConfig.timeZone;
  } catch {
    // Graceful: fall back to UTC.
  }

  // Derive the local review date from task.runAt (always set on daily-review
  // tasks by the weekly-plan generator). Falls back to today's UTC date when
  // runAt is missing so an orphaned task still produces a valid document.
  const reviewDate = task.runAt
    ? utcToLocalDate(task.runAt, tz)
    : new Date().toISOString().slice(0, 10);

  console.log(`[${agentId}] generating daily review for ${reviewDate}`);

  let error = null;
  let finalStatus = 'completed';

  try {
    const deps = { agentStore, weeklyPlanStore, activityLogStore };

    // Generate + persist the review document. persist:true writes both the
    // .md and companion .json to .aweek/agents/<agentId>/reviews/daily-<date>.
    await generateDailyReview(deps, agentId, reviewDate, {
      week,
      tz,
      persist: true,
      baseDir: agentsDir,
    });

    console.log(`[${agentId}] daily review written for ${reviewDate}`);
  } catch (err) {
    error = err;
    finalStatus = 'failed';
    console.error(`[${agentId}] daily review error: ${err.message}`);
  }

  // Always update the task status — completed on success, failed on error.
  await weeklyPlanStore
    .updateTaskStatus(agentId, week, task.id, finalStatus)
    .catch((e) =>
      console.warn(`[${agentId}] daily review status update warning: ${e.message}`),
    );

  return { execResult: null, error, finalStatus };
}

/**
 * Handle a weekly-review heartbeat task: run the review pipeline and write
 * the result to `reviews/weekly-YYYY-Www.md` inside the per-agent data
 * directory.
 *
 * No CLI session is launched, no token usage is tracked, and no budget is
 * enforced for these synthetic tasks — the only side effects are:
 *   1. Writing the review markdown file to disk.
 *   2. Marking the plan task as `completed` (or `failed` on error).
 *
 * @param {object} selection - { task, week }
 * @param {object} ctx - Stores + paths from runHeartbeatForAgent.
 * @returns {Promise<{
 *   execResult: null,
 *   error: Error | null,
 *   finalStatus: 'completed' | 'failed',
 *   chainResult: { nextWeek: string | null, chained: boolean, reason?: string } | null,
 * }>}
 */
async function executeWeeklyReviewTask(selection, ctx) {
  const {
    agentId,
    agentsDir,
    weeklyPlanStore,
    usageStore,
    activityLogStore,
    agentStore,
    inboxStore,
  } = ctx;
  const { task, week } = selection;

  const reviewDir = join(agentsDir, agentId, 'reviews');
  const reviewPath = join(reviewDir, `weekly-${week}.md`);

  console.log(`[${agentId}] generating weekly review for ${week}`);

  let error = null;
  let finalStatus = 'completed';
  let chainResult = null;

  try {
    const deps = {
      agentStore,
      weeklyPlanStore,
      activityLogStore,
      usageStore,
      inboxStore,
    };

    // Generate the full review document. persist: false so we control the path
    // (heartbeat writes to reviews/weekly-YYYY-Www.md, not reviews/YYYY-Www.md).
    const result = await generateWeeklyReview(deps, agentId, week, { persist: false });

    // Write to reviews/weekly-YYYY-Www.md inside the per-agent data directory.
    await mkdir(reviewDir, { recursive: true });
    await writeFile(reviewPath, result.markdown, 'utf-8');

    console.log(`[${agentId}] weekly review written: ${reviewPath}`);

    // Autonomous chain: after a successful review write, immediately generate
    // and auto-approve the next week's plan so the heartbeat can resume without
    // manual intervention. chainNextWeekPlanner is best-effort — it never
    // throws, so chain failures do NOT affect finalStatus.
    chainResult = await chainNextWeekPlanner(week, ctx);
  } catch (err) {
    error = err;
    finalStatus = 'failed';
    console.error(`[${agentId}] weekly review error: ${err.message}`);
  }

  // Always update the task status — completed on success, failed on error.
  await weeklyPlanStore
    .updateTaskStatus(agentId, week, task.id, finalStatus)
    .catch((e) =>
      console.warn(`[${agentId}] weekly review status update warning: ${e.message}`),
    );

  return { execResult: null, error, finalStatus, chainResult };
}

/**
 * Run the full per-task pipeline for one selection: execute the CLI
 * session with token tracking, mark the task status, append the rich
 * activity-log entry, and enforce the weekly budget.
 *
 * Weekly-review tasks (objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID) are
 * intercepted before the CLI session and handled by executeWeeklyReviewTask,
 * which calls the review pipeline directly and writes the result to disk
 * with no other side effects.
 *
 * Extracted so the heartbeat runner can call it for both the first
 * tickAgent selection AND every subsequent per-track drain pick. Errors
 * from the CLI session are captured on the return value so the caller
 * can decide whether to continue draining.
 *
 * @param {object} selection - { task, week }
 * @param {object} ctx - Stores + paths captured from runHeartbeatForAgent.
 * @returns {Promise<{ execResult: object | null, error: Error | null, finalStatus: 'completed' | 'failed' }>}
 */
async function executeOneSelection(selection, ctx) {
  const {
    agentId,
    subagentRef,
    projectDir,
    dataDir,
    weeklyPlanStore,
    usageStore,
    activityLogStore,
    agentStore,
  } = ctx;
  const { task, week } = selection;

  // Daily-review tasks bypass the CLI session — call the daily review
  // pipeline directly and write the result to reviews/daily-YYYY-MM-DD.md.
  if (task.objectiveId === DAILY_REVIEW_OBJECTIVE_ID) {
    return executeDailyReviewTask(selection, ctx);
  }

  // Weekly-review tasks bypass the CLI session — call the review pipeline
  // directly and write the result to reviews/weekly-YYYY-Www.md.
  if (task.objectiveId === WEEKLY_REVIEW_OBJECTIVE_ID) {
    return executeWeeklyReviewTask(selection, ctx);
  }

  console.log(`[${agentId}] executing task: ${task.description}`);

  const startedAt = new Date();
  let execResult = null;
  let error = null;
  let finalStatus = 'completed';

  try {
    execResult = await executeSessionWithTracking(
      agentId,
      subagentRef,
      {
        taskId: task.id,
        description: task.description,
        objectiveId: task.objectiveId,
        week,
      },
      { cwd: projectDir, usageStore },
    );
  } catch (err) {
    error = err;
    finalStatus = 'failed';
    console.error(`[${agentId}] execution error: ${err.message}`);
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  await weeklyPlanStore.updateTaskStatus(
    agentId,
    week,
    task.id,
    finalStatus === 'completed' ? 'completed' : 'failed',
  );
  console.log(`[${agentId}] task ${finalStatus}: ${task.id}`);

  try {
    const session = execResult?.sessionResult;
    const stdout = session?.stdout || '';
    const stderr = session?.stderr || '';
    const resources = extractResources(stdout + '\n' + stderr);

    const metadata = {
      task: {
        id: task.id,
        description: task.description,
        objectiveId: task.objectiveId,
        priority: task.priority,
        estimatedMinutes: task.estimatedMinutes,
        track: task.track,
        week,
      },
      execution: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs,
        exitCode: session?.exitCode ?? null,
        timedOut: session?.timedOut ?? false,
      },
      result: {
        success: finalStatus === 'completed',
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 2000),
      },
      resources,
      tokenUsage: execResult?.tokenUsage || null,
      usageTracked: execResult?.usageTracked ?? false,
    };

    if (error) {
      metadata.error = {
        message: error.message,
        stack: error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : undefined,
      };
    }

    await activityLogStore.append(
      agentId,
      createLogEntry({
        agentId,
        taskId: task.id,
        status: finalStatus,
        description: task.description,
        duration: durationMs,
        metadata,
      }),
    );
  } catch (logErr) {
    console.warn(`[${agentId}] activity log warning: ${logErr.message}`);
  }

  try {
    await enforceBudget(agentId, {
      agentStore,
      usageStore,
      alertDir: join(dataDir, 'alerts'),
    });
  } catch (err) {
    console.warn(`[${agentId}] budget enforcement warning: ${err.message}`);
  }

  return { execResult, error, finalStatus };
}

/**
 * Probe whether the agent is currently budget-paused without throwing.
 * Used to abort the per-track drain once a session exhausts the
 * weekly token budget.
 */
async function _isAgentPaused(agentStore, agentId) {
  try {
    const fresh = await agentStore.load(agentId);
    return fresh?.budget?.paused === true;
  } catch {
    return false;
  }
}

/**
 * Record an extra "started" execution row for a per-track drain pick.
 * The first selection of the tick already got its row recorded inside
 * tickAgent's idempotency guard; follow-up drains record their own so
 * operators can count how many tasks a tick ran.
 */
async function _recordStarted(executionStore, agentId, taskId) {
  try {
    const record = createExecutionRecord({
      agentId,
      date: new Date(),
      status: 'started',
      taskId,
    });
    await executionStore.record(agentId, record);
  } catch {
    // Graceful degradation — recording failure must not break the drain.
  }
}

/**
 * Run heartbeat ticks for all agents in the data directory.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (default: cwd)
 */
export async function runHeartbeatForAll(opts = {}) {
  const projectDir = opts.projectDir || process.cwd();
  const agentsDir = join(projectDir, '.aweek', 'agents');

  // Cron fires in the system local zone, but the user's scheduling
  // intent lives in the zone they configured in .aweek/config.json.
  // When those differ, print a single one-line warning so the mismatch
  // is visible in the heartbeat log rather than silently drifting hours.
  try {
    const config = await loadConfig(agentsDir);
    const systemTz = detectSystemTimeZone();
    if (
      config?.timeZone &&
      systemTz &&
      config.timeZone !== 'UTC' &&
      config.timeZone !== systemTz
    ) {
      console.warn(
        `[heartbeat] config timeZone (${config.timeZone}) differs from system zone (${systemTz}). ` +
          `Cron fires on system time, so task selection may drift relative to your configured week. ` +
          `Run crontab in the configured zone or update .aweek/config.json to silence this warning.`,
      );
    }
  } catch {
    // Config read is best-effort; never block heartbeat on it.
  }

  let files;
  try {
    files = await readdir(agentsDir);
  } catch {
    console.log('No agents directory found. Nothing to do.');
    return [];
  }

  const agentIds = files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));

  if (agentIds.length === 0) {
    console.log('No agents found. Nothing to do.');
    return [];
  }

  console.log(`Running heartbeat for ${agentIds.length} agent(s)...`);

  const results = [];
  for (const agentId of agentIds) {
    try {
      const result = await runHeartbeatForAgent(agentId, { projectDir });
      results.push({ agentId, result });
    } catch (err) {
      console.error(`[${agentId}] heartbeat error: ${err.message}`);
      results.push({ agentId, error: err.message });
    }
  }

  return results;
}
