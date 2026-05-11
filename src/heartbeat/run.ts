/**
 * Heartbeat runner — wires stores, scheduler, and task execution for CLI invocation.
 *
 * This is the runtime entry point that crontab (via bin/aweek.js) calls every 10 minutes.
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
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import type { WeeklyPlan, WeeklyTask } from '../storage/weekly-plan-store.js';
import { ExecutionStore, createExecutionRecord } from '../storage/execution-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { ActivityLogStore, createLogEntry } from '../storage/activity-log-store.js';
import type { ActivityLogStatus } from '../storage/activity-log-store.js';
import { InboxStore } from '../storage/inbox-store.js';
import { NotificationStore } from '../storage/notification-store.js';
import { createScheduler } from './scheduler.js';
import { tickAgent } from './heartbeat-task-runner.js';
import type { TaskTickResult } from './heartbeat-task-runner.js';
import {
  selectTasksForTickFromPlan,
  trackKeyOf,
  findStaleTasks,
  setStaleTaskWindowMsRuntime,
} from './task-selector.js';
import type { TickPick } from './task-selector.js';
import { executeSessionWithTracking } from '../execution/session-executor.js';
import { enforceBudget } from '../services/budget-enforcer.js';
import { maybeEmitRepeatedFailureNotification } from '../services/repeated-failure-notifier.js';
import { verifyTaskOutcome } from '../services/task-verifier.js';
import { maybeEmitTaskWarningsNotification } from '../services/task-warning-notifier.js';
import { loadConfig } from '../storage/config-store.js';
import { detectSystemTimeZone, mondayOfWeek } from '../time/zone.js';
import { WEEKLY_REVIEW_OBJECTIVE_ID, DAILY_REVIEW_OBJECTIVE_ID } from '../schemas/weekly-plan.schema.js';
import { generateWeeklyReview, nextISOWeek } from '../services/weekly-review-orchestrator.js';
import { generateDailyReview, utcToLocalDate } from '../services/daily-review-writer.js';
import { MonthlyPlanStore } from '../storage/monthly-plan-store.js';
import type { MonthlyPlan } from '../storage/monthly-plan-store.js';
import { generateWeeklyPlan } from '../services/weekly-plan-generator.js';
import { readPlan } from '../storage/plan-markdown-store.js';
import { loadAgentEnv } from '../storage/agent-env-store.js';

interface RunHeartbeatForAgentOptions {
  projectDir?: string;
}

interface ExecutionContext {
  agentId: string;
  subagentRef: string;
  projectDir: string;
  dataDir: string;
  agentsDir: string;
  weeklyPlanStore: WeeklyPlanStore;
  usageStore: UsageStore;
  activityLogStore: ActivityLogStore;
  agentStore: AgentStore;
  inboxStore: InboxStore;
  notificationStore: NotificationStore;
}

interface TaskSelection {
  task: WeeklyTask;
  week: string;
}

interface ExecuteOneSelectionResult {
  execResult: unknown;
  error: Error | null;
  finalStatus: 'completed' | 'failed';
  chainResult?: ChainNextWeekResult | null;
}

interface ChainNextWeekResult {
  nextWeek: string | null;
  chained: boolean;
  reason?: string;
}

interface SweepStaleArgs {
  agentId: string;
  weeklyPlanStore: WeeklyPlanStore;
  activityLogStore?: ActivityLogStore;
  now?: Date;
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
const toError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

/**
 * Extract URLs and file paths from session stdout.
 * Kept permissive — false positives are cheaper than missing an artifact.
 *
 * @param {string} text
 * @returns {{ urls: string[], filePaths: string[] }}
 */
export function extractResources(text: string | null | undefined): { urls: string[]; filePaths: string[] } {
  if (!text || typeof text !== 'string') return { urls: [], filePaths: [] };

  const urlRe = /https?:\/\/[^\s<>")\]]+/g;
  const urls = Array.from(new Set(text.match(urlRe) || []));

  // File paths: absolute unix paths OR relative paths with a file extension
  const absPathRe = /(?:^|\s|=|"|')(\/[A-Za-z0-9._~/-]+)(?=[\s"'.,;)\]:]|$)/g;
  const relPathRe = /(?:^|\s|=|"|')([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,6})(?=[\s"'.,;)\]:]|$)/g;

  const filePaths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = absPathRe.exec(text)) !== null) filePaths.add(match[1]!);
  while ((match = relPathRe.exec(text)) !== null) filePaths.add(match[1]!);

  return { urls, filePaths: Array.from(filePaths) };
}


/**
 * Run a heartbeat tick for a single agent.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (default: cwd)
 */
export async function runHeartbeatForAgent(
  agentId: string,
  opts: RunHeartbeatForAgentOptions = {},
): Promise<TaskTickResult | {
  tickResult: TaskTickResult;
  execResult: unknown;
  extraResults: ExecuteOneSelectionResult[];
  drainedTrackCount: number;
}> {
  const projectDir = opts.projectDir || process.cwd();
  const dataDir = join(projectDir, '.aweek');

  const agentsDir = join(dataDir, 'agents');
  const agentStore = new AgentStore(agentsDir);
  const weeklyPlanStore = new WeeklyPlanStore(agentsDir);
  const executionStore = new ExecutionStore(agentsDir);
  const usageStore = new UsageStore(agentsDir);
  const activityLogStore = new ActivityLogStore(agentsDir);
  const inboxStore = new InboxStore(agentsDir);
  const notificationStore = new NotificationStore(agentsDir);
  const lockDir = join(dataDir, 'locks');

  const scheduler = createScheduler({ lockDir });

  // Step 0.9: Sweep stale pending tasks.
  //
  // Any pending task whose `runAt` is older than the 60-minute window is
  // flipped to `skipped` and logged, so the heartbeat doesn't fire an
  // avalanche of missed tasks after a cron gap (laptop closed, cron
  // paused, etc.). The rule is a fixed 60-minute window regardless of
  // the user's cron cadence — see STALE_TASK_WINDOW_MS in
  // task-selector.js. Best-effort: per-task failures log a warning and
  // the tick continues.
  await _sweepStaleTasks({
    agentId,
    weeklyPlanStore,
    activityLogStore,
    now: new Date(),
  });

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

  // task_selected guarantees task and week are populated; narrow for TS.
  if (!tickResult.task || !tickResult.week) {
    return tickResult;
  }

  // Step 2: Run the first task through the full per-task pipeline.
  const config = await agentStore.load(agentId);
  const subagentRef = config.subagentRef || agentId;

  const execCtx: ExecutionContext = {
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
    notificationStore,
  };

  const firstResult = await executeOneSelection(
    { task: tickResult.task, week: tickResult.week },
    execCtx,
  );

  // Track which "tracks" have already fired a task this tick so the
  // drain loop picks from DIFFERENT tracks rather than the next task in
  // the same track — that's the whole point of the track primitive.
  const firedTrackKeys = new Set<string>([trackKeyOf(tickResult.task)]);
  const extraResults: ExecuteOneSelectionResult[] = [];
  const firstError = firstResult.error;

  // Step 3: Drain other tracks within this tick.
  //
  // Budget enforcement ran inside executeOneSelection. If it paused the
  // agent, stop draining — the next tick will respect the pause anyway,
  // but there's no point queuing another session we know will fail.
  while (true) {
    const paused = await _isAgentPaused(agentStore, agentId);
    if (paused) break;

    // Walk approved plans oldest-first (same priority as the initial
    // selectTasksForTick call): finish W19's tracks before borrowing
    // from W20. Returns the first plan that has any unfired pick left.
    const approvedPlans = await weeklyPlanStore.loadAllApproved(agentId);
    if (approvedPlans.length === 0) break;
    let plan: WeeklyPlan | null = null;
    let nextPick: TickPick | undefined;
    for (const candidate of approvedPlans) {
      const picks = selectTasksForTickFromPlan(candidate);
      nextPick = picks.find((p) => !firedTrackKeys.has(p.trackKey));
      if (nextPick) {
        plan = candidate;
        break;
      }
    }
    if (!plan || !nextPick) break;

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
export async function chainNextWeekPlanner(
  currentWeek: string,
  ctx: ExecutionContext,
): Promise<ChainNextWeekResult> {
  const { agentId, agentsDir, weeklyPlanStore, agentStore } = ctx;
  let nextWeek: string | null = null;

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
    let goals: unknown[] = [];
    try {
      const agentConfig = await agentStore.load(agentId);
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
    let monthlyPlan: MonthlyPlan = {
      month: nextMonth,
      objectives: [],
      status: 'active',
    };
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
    // Cast at the boundary: generateWeeklyPlan declares its own structurally
    // identical local Goal/MonthlyPlan/WeeklyPlan interfaces (not imported from
    // ../storage/*), so explicit casts bridge the two parallel type universes
    // without introducing `any`.
    const { plan, meta } = generateWeeklyPlan({
      week: nextWeek,
      month: nextMonth,
      goals: goals as unknown as Parameters<typeof generateWeeklyPlan>[0]['goals'],
      monthlyPlan: monthlyPlan as unknown as Parameters<typeof generateWeeklyPlan>[0]['monthlyPlan'],
      options: { planMarkdown, tz },
    });

    // Auto-approve: this is the autonomous chain — no human gate is needed.
    // The review that triggered this chain already confirmed the week is done.
    plan.approved = true;
    plan.approvedAt = new Date().toISOString();

    // Persist the auto-approved plan.
    await weeklyPlanStore.save(
      agentId,
      plan as unknown as Parameters<WeeklyPlanStore['save']>[1],
    );

    console.log(
      `[${agentId}] auto-chained next-week plan for ${nextWeek}: ` +
        `${meta.totalTasks} tasks (${meta.reviewTasksAdded} review slots, auto-approved)`,
    );

    return { nextWeek, chained: true };
  } catch (err) {
    const m = errMsg(err);
    console.warn(`[${agentId}] next-week planner chain error: ${m}`);
    return { nextWeek, chained: false, reason: m };
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
async function executeDailyReviewTask(
  selection: TaskSelection,
  ctx: ExecutionContext,
): Promise<ExecuteOneSelectionResult> {
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
  const reviewDate: string =
    (task.runAt ? utcToLocalDate(task.runAt, tz) : null) ??
    new Date().toISOString().slice(0, 10);

  console.log(`[${agentId}] generating daily review for ${reviewDate}`);

  const startedAt = new Date();
  let error: Error | null = null;
  let finalStatus: 'completed' | 'failed' = 'completed';

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
    error = toError(err);
    finalStatus = 'failed';
    console.error(`[${agentId}] daily review error: ${error.message}`);
  }

  // Always update the task status — completed on success, failed on error.
  await weeklyPlanStore
    .updateTaskStatus(agentId, week, task.id, finalStatus)
    .catch((e: unknown) =>
      console.warn(`[${agentId}] daily review status update warning: ${errMsg(e)}`),
    );

  // Append an activity-log entry so review-task runs are debuggable from
  // the dashboard's activity tab — same surface as regular CLI tasks.
  // Best-effort: a logging failure must not flip the task back to failed.
  await appendReviewActivityLog({
    activityLogStore,
    agentId,
    task,
    week,
    finalStatus,
    error,
    startedAt,
    completedAt: new Date(),
    review: {
      kind: 'daily',
      stem: `daily-${reviewDate}`,
      path: join(agentsDir, agentId, 'reviews', `daily-${reviewDate}.md`),
      date: reviewDate,
      week,
      tz,
    },
  });

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
async function executeWeeklyReviewTask(
  selection: TaskSelection,
  ctx: ExecutionContext,
): Promise<ExecuteOneSelectionResult> {
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
  const reviewStem = `weekly-${week}`;
  const reviewPath = join(reviewDir, `${reviewStem}.md`);

  console.log(`[${agentId}] generating weekly review for ${week}`);

  const startedAt = new Date();
  let error: Error | null = null;
  let finalStatus: 'completed' | 'failed' = 'completed';
  let chainResult: ChainNextWeekResult | null = null;

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
    // Cast at boundary: weekly-review-orchestrator declares its own structurally
    // looser OrchestratorDeps interface; the runtime contract is satisfied by
    // our concrete stores.
    const result = await generateWeeklyReview(
      deps as unknown as Parameters<typeof generateWeeklyReview>[0],
      agentId,
      week,
      { persist: false },
    );

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
    error = toError(err);
    finalStatus = 'failed';
    console.error(`[${agentId}] weekly review error: ${error.message}`);
  }

  // Always update the task status — completed on success, failed on error.
  await weeklyPlanStore
    .updateTaskStatus(agentId, week, task.id, finalStatus)
    .catch((e: unknown) =>
      console.warn(`[${agentId}] weekly review status update warning: ${errMsg(e)}`),
    );

  // Append an activity-log entry so review-task runs are debuggable from
  // the dashboard's activity tab — same surface as regular CLI tasks.
  // Best-effort: a logging failure must not flip the task back to failed.
  await appendReviewActivityLog({
    activityLogStore,
    agentId,
    task,
    week,
    finalStatus,
    error,
    startedAt,
    completedAt: new Date(),
    review: {
      kind: 'weekly',
      stem: reviewStem,
      path: reviewPath,
      week,
      chained: chainResult?.chained ?? false,
      nextWeek: chainResult?.nextWeek ?? null,
      chainReason: chainResult?.reason ?? null,
    },
  });

  return { execResult: null, error, finalStatus, chainResult };
}

/**
 * Build + append an activity-log entry for a review-task run (daily or
 * weekly). Mirrors the rich entry shape `runOneTaskPipeline` writes for
 * regular CLI tasks so the dashboard's activity tab can render review
 * runs alongside ordinary executions.
 *
 * Logging is best-effort — a failure to write the entry only emits a
 * warning. The review document itself is the durable record; the
 * activity entry is the debugging surface on top.
 */
async function appendReviewActivityLog({
  activityLogStore,
  agentId,
  task,
  week,
  finalStatus,
  error,
  startedAt,
  completedAt,
  review,
}: {
  activityLogStore: ActivityLogStore;
  agentId: string;
  task: WeeklyTask;
  week: string;
  finalStatus: 'completed' | 'failed';
  error: Error | null;
  startedAt: Date;
  completedAt: Date;
  review: Record<string, unknown> & { kind: 'daily' | 'weekly'; stem: string };
}): Promise<void> {
  const durationMs = completedAt.getTime() - startedAt.getTime();
  const metadata: Record<string, unknown> = {
    task: {
      id: task.id,
      title: task.title,
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
    },
    result: {
      success: finalStatus === 'completed',
    },
    review,
  };
  if (error) {
    metadata.error = {
      message: error.message,
      stack: error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : undefined,
    };
  }
  try {
    await activityLogStore.append(
      agentId,
      createLogEntry({
        agentId,
        taskId: task.id,
        status: finalStatus as ActivityLogStatus,
        title: task.title,
        duration: durationMs,
        metadata,
      }),
    );
  } catch (logErr) {
    console.warn(`[${agentId}] review activity log warning: ${errMsg(logErr)}`);
  }
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
async function executeOneSelection(
  selection: TaskSelection,
  ctx: ExecutionContext,
): Promise<ExecuteOneSelectionResult> {
  const {
    agentId,
    subagentRef,
    projectDir,
    dataDir,
    agentsDir,
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

  console.log(`[${agentId}] executing task: ${task.title}`);

  const startedAt = new Date();
  let execResult: Awaited<ReturnType<typeof executeSessionWithTracking>> | null = null;
  let error: Error | null = null;
  let finalStatus: 'completed' | 'failed' = 'completed';

  let agentEnv: Record<string, string> = {};
  try {
    agentEnv = await loadAgentEnv(agentsDir, agentId);
  } catch (err) {
    console.error(`[${agentId}] failed to load agent env: ${errMsg(err)}`);
  }

  try {
    execResult = await executeSessionWithTracking(
      agentId,
      subagentRef,
      {
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        objectiveId: task.objectiveId,
        week,
      },
      {
        cwd: projectDir,
        usageStore,
        env: agentEnv,
        agentsDir,
        // Heartbeat ticks run without a TTY — there's no human to
        // approve permission prompts, so default-gate would silently
        // block every tool call. Safety guards belong in the
        // subagent's system prompt, not in a dialog the heartbeat
        // can't answer.
        dangerouslySkipPermissions: true,
      },
    );
  } catch (err) {
    error = toError(err);
    finalStatus = 'failed';
    console.error(`[${agentId}] execution error: ${error.message}`);
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

  // Repeated-task-failure detector — fires after the failure counter has
  // been incremented by `updateTaskStatus`. Best-effort: a failing task
  // must still log activity and trip the budget enforcer below even if
  // the notification surface is broken. The emitter is itself idempotent
  // (latch + dedupKey) so an extra invocation is safe; we only call it
  // on the failure branch to keep the success path zero-overhead.
  if (finalStatus === 'failed') {
    try {
      const outcome = await maybeEmitRepeatedFailureNotification({
        weeklyPlanStore,
        notificationStore: ctx.notificationStore,
        agentId,
        week,
        task: {
          id: task.id,
          title: task.title,
          objectiveId: task.objectiveId,
        },
      });
      if (outcome.fired) {
        console.log(
          `[${agentId}] repeated-task-failure notification emitted ` +
            `(${outcome.consecutiveFailures} consecutive failures, id=${outcome.notificationId})`,
        );
      } else if (outcome.reason === 'send_failed') {
        console.warn(
          `[${agentId}] repeated-task-failure notification send failed: ${outcome.error.message}`,
        );
      }
    } catch (err) {
      console.warn(
        `[${agentId}] repeated-task-failure notifier warning: ${errMsg(err)}`,
      );
    }
  }

  // Post-execution outcome verifier — fires only on the success path.
  // Asks an Anthropic model whether the agent's captured output actually
  // achieved the task's stated outcome (e.g. "publish a post" → did a
  // publish action run?). Best-effort: a `skipped` result leaves the
  // task's `warnings` / `outcomeAchieved` fields untouched and the
  // pipeline continues normally. Skipped on the failed path because the
  // task already carries a hard-failure status — verifying it would burn
  // tokens for no actionable signal.
  let verifierConcerns: string[] = [];
  let verifierAchieved: boolean | undefined;
  if (finalStatus === 'completed') {
    try {
      const session = execResult?.sessionResult;
      const verdict = await verifyTaskOutcome({
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        output: session?.stdout || '',
        ...(session?.stderr ? { stderr: session.stderr } : {}),
        cwd: projectDir,
      });
      if (verdict.kind === 'verdict') {
        verifierAchieved = verdict.achieved;
        verifierConcerns = verdict.concerns;
        await weeklyPlanStore.setTaskOutcome(agentId, week, task.id, {
          achieved: verdict.achieved,
          concerns: verdict.concerns,
        });
      } else {
        console.log(
          `[${agentId}] task verifier skipped: ${verdict.reason}`,
        );
      }
    } catch (verifyErr) {
      console.warn(
        `[${agentId}] task verifier warning: ${errMsg(verifyErr)}`,
      );
    }
  }

  // Fire the warning notification when the verifier flagged concerns.
  // Idempotent via dedupKey so the heartbeat won't re-fire the same
  // warning on a subsequent retry of the same task.
  if (verifierAchieved === false && verifierConcerns.length > 0) {
    try {
      await maybeEmitTaskWarningsNotification({
        notificationStore: ctx.notificationStore,
        agentId,
        week,
        task: {
          id: task.id,
          title: task.title,
          objectiveId: task.objectiveId,
        },
        concerns: verifierConcerns,
      });
    } catch (notifErr) {
      console.warn(
        `[${agentId}] task-warnings notifier warning: ${errMsg(notifErr)}`,
      );
    }
  }

  try {
    const session = execResult?.sessionResult;
    const stdout = session?.stdout || '';
    const stderr = session?.stderr || '';
    const resources = extractResources(stdout + '\n' + stderr);

    const metadata: Record<string, unknown> = {
      task: {
        id: task.id,
        title: task.title,
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
        executionLogPath: execResult?.executionLogPath || null,
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

    if (verifierAchieved !== undefined) {
      metadata.outcomeAchieved = verifierAchieved;
    }
    if (verifierConcerns.length > 0) {
      metadata.warnings = verifierConcerns;
    }

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
        status: finalStatus as ActivityLogStatus,
        title: task.title,
        duration: durationMs,
        metadata,
      }),
    );
  } catch (logErr) {
    console.warn(`[${agentId}] activity log warning: ${errMsg(logErr)}`);
  }

  try {
    await enforceBudget(agentId, {
      agentStore,
      usageStore,
      baseDir: agentsDir,
      notificationStore: ctx.notificationStore,
    });
  } catch (err) {
    console.warn(`[${agentId}] budget enforcement warning: ${errMsg(err)}`);
  }

  return { execResult, error, finalStatus };
}

/**
 * Probe whether the agent is currently budget-paused without throwing.
 * Used to abort the per-track drain once a session exhausts the
 * weekly token budget.
 */
async function _isAgentPaused(agentStore: AgentStore, agentId: string): Promise<boolean> {
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
async function _recordStarted(
  executionStore: ExecutionStore,
  agentId: string,
  taskId: string,
): Promise<void> {
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
 * Flip any pending task whose `runAt` is older than the 60-minute
 * staleness window to `skipped`, logging each one to the activity log.
 * Runs once at the top of each heartbeat tick (see {@link runHeartbeatForAgent}).
 *
 * Non-fatal by design: a broken store, a missing plan, or a per-task
 * update failure all degrade to a warning and let the tick continue.
 * Callers without an activity log (unit tests) still get the skip write
 * — logging is best-effort on top.
 *
 * @param {object} args
 * @param {string} args.agentId
 * @param {object} args.weeklyPlanStore
 * @param {object} [args.activityLogStore]
 * @param {Date} [args.now]
 */
async function _sweepStaleTasks({
  agentId,
  weeklyPlanStore,
  activityLogStore,
  now = new Date(),
}: SweepStaleArgs): Promise<void> {
  // Sweep every approved plan, not just the latest. Once the user has
  // approved next week's plan ahead of time, `loadLatestApproved`
  // returns that future plan — leaving this week's past-due pending
  // tasks orphaned (selector skips them, sweep doesn't see them, they
  // stay `pending` in the calendar forever). Walking every approved
  // plan fixes both the immediate symptom AND the recurring class:
  // any plan with pending stragglers (past or current week) gets its
  // stale tasks flipped to `skipped` on the next tick. Cost stays
  // bounded by the per-plan `tasks.some(pending)` early-out below —
  // historical plans whose stragglers are already reconciled bail in
  // microseconds.
  let plans: WeeklyPlan[];
  try {
    plans = await weeklyPlanStore.loadAllApproved(agentId);
  } catch (err) {
    console.warn(`[${agentId}] stale-sweep: load failed: ${errMsg(err)}`);
    return;
  }
  if (plans.length === 0) return;

  for (const plan of plans) {
    // Early-out: once a plan has zero `pending` tasks left, every
    // remaining task is either `completed`, `skipped`, or in-progress
    // — none of which the sweep can touch. Bails before findStaleTasks
    // walks the array a second time.
    if (!plan.tasks.some((t) => t.status === 'pending')) continue;

    const stale = findStaleTasks(plan, { nowMs: now.getTime() });
    if (stale.length === 0) continue;

    for (const item of stale) {
      try {
        await weeklyPlanStore.updateTaskStatus(agentId, plan.week, item.taskId, 'skipped');
      } catch (err) {
        console.warn(
          `[${agentId}] stale-sweep: failed to skip ${item.taskId}: ${errMsg(err)}`,
        );
        continue;
      }

      const ageMin = Math.round(item.ageMs / 60000);
      console.log(
        `[${agentId}] stale task ${item.taskId} (${plan.week}, ${ageMin}m past runAt) → skipped`,
      );

      if (activityLogStore) {
        const task = plan.tasks.find((t: WeeklyTask) => t.id === item.taskId);
        try {
          await activityLogStore.append(
            agentId,
            createLogEntry({
              agentId,
              taskId: item.taskId,
              status: 'skipped',
              title: task?.title || `(task ${item.taskId})`,
              metadata: {
                reason: 'stale_runAt',
                runAt: item.runAt,
                ageMs: item.ageMs,
                week: plan.week,
                tickedAt: now.toISOString(),
              },
            }),
          );
        } catch (err) {
          console.warn(`[${agentId}] stale-sweep log warning: ${errMsg(err)}`);
        }
      }
    }
  }
}

/**
 * Dispatch heartbeat ticks for all agents in the data directory as
 * detached child processes, then return immediately.
 *
 * Why detached children, not Promise.allSettled in-process:
 *   The previous design awaited every per-agent runner in the same
 *   process, which meant the slowest CLI session held the whole
 *   heartbeat process alive. launchd's `StartInterval` skips firings
 *   whose previous instance is still running, so a 30-min planning
 *   session for one agent silently dropped the next 2-3 ticks for ALL
 *   agents — sibling agents with quick or already-eligible tasks were
 *   delayed until the slow one finished. Spawning each per-agent run
 *   as a detached `aweek heartbeat <slug>` decouples sibling lifetimes:
 *   the parent dispatcher exits in ~1s, the next launchd firing always
 *   lands on schedule, and per-agent overlap is still caught by
 *   `runWithHeartbeatLock` (PID-tracked, in `heartbeat-lock.ts`).
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (default: cwd)
 */
export async function runHeartbeatForAll(
  opts: RunHeartbeatForAgentOptions = {},
): Promise<Array<{ agentId: string; dispatched: boolean; pid?: number; error?: string }>> {
  const projectDir = opts.projectDir || process.cwd();
  const agentsDir = join(projectDir, '.aweek', 'agents');

  // Cron fires in the system local zone, but the user's scheduling
  // intent lives in the zone they configured in .aweek/config.json.
  // When those differ, print a single one-line warning so the mismatch
  // is visible in the heartbeat log rather than silently drifting hours.
  // Each per-agent child loads the same config and re-applies its own
  // staleTaskWindowMs override; running it here too is harmless and
  // keeps the parent's warning behavior intact.
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
    if (typeof config?.staleTaskWindowMs === 'number') {
      setStaleTaskWindowMsRuntime(config.staleTaskWindowMs);
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

  // Open the heartbeat log once and pass the FD to each detached child.
  // Children outlive the parent, so they can't inherit the parent's
  // stdout pipe (launchd would close it). A direct file FD survives.
  // Best-effort: if the open fails, fall back to 'ignore'; the children
  // still record their own state via the execution store.
  const logsDir = join(projectDir, '.aweek', 'logs');
  let outFd: number | 'ignore' = 'ignore';
  try {
    await mkdir(logsDir, { recursive: true });
    outFd = openSync(join(logsDir, 'heartbeat.out.log'), 'a');
  } catch {
    outFd = 'ignore';
  }

  const aweekScript = process.argv[1];
  if (!aweekScript) {
    console.error('Cannot dispatch per-agent heartbeats: process.argv[1] is empty.');
    return agentIds.map((agentId) => ({
      agentId,
      dispatched: false,
      error: 'process.argv[1] is empty',
    }));
  }

  console.log(
    `Dispatching heartbeat for ${agentIds.length} agent(s) as detached children...`,
  );

  const results: Array<{ agentId: string; dispatched: boolean; pid?: number; error?: string }> = [];
  for (const agentId of agentIds) {
    try {
      const child = spawn(
        process.execPath,
        [aweekScript, 'heartbeat', agentId, '--project-dir', projectDir],
        {
          detached: true,
          stdio: ['ignore', outFd, outFd],
          env: process.env,
        },
      );
      child.unref();
      const entry: { agentId: string; dispatched: boolean; pid?: number } = {
        agentId,
        dispatched: true,
      };
      if (typeof child.pid === 'number') entry.pid = child.pid;
      results.push(entry);
    } catch (err) {
      const m = errMsg(err);
      console.error(`[${agentId}] dispatch error: ${m}`);
      results.push({ agentId, dispatched: false, error: m });
    }
  }

  return results;
}
