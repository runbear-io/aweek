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
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import type { WeeklyTask } from '../storage/weekly-plan-store.js';
import { ExecutionStore, createExecutionRecord } from '../storage/execution-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { ActivityLogStore, createLogEntry } from '../storage/activity-log-store.js';
import type { ActivityLogStatus } from '../storage/activity-log-store.js';
import { InboxStore } from '../storage/inbox-store.js';
import { createScheduler } from './scheduler.js';
import { tickAgent } from './heartbeat-task-runner.js';
import type { TaskTickResult } from './heartbeat-task-runner.js';
import {
  selectTasksForTickFromPlan,
  trackKeyOf,
  findStaleTasks,
} from './task-selector.js';
import { executeSessionWithTracking } from '../execution/session-executor.js';
import { enforceBudget } from '../services/budget-enforcer.js';
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
  const reviewPath = join(reviewDir, `weekly-${week}.md`);

  console.log(`[${agentId}] generating weekly review for ${week}`);

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
  let plan: Awaited<ReturnType<WeeklyPlanStore['loadLatestApproved']>>;
  try {
    plan = await weeklyPlanStore.loadLatestApproved(agentId);
  } catch (err) {
    console.warn(`[${agentId}] stale-sweep: load failed: ${errMsg(err)}`);
    return;
  }
  if (!plan) return;

  const stale = findStaleTasks(plan, { nowMs: now.getTime() });
  if (stale.length === 0) return;

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
      `[${agentId}] stale task ${item.taskId} (${ageMin}m past runAt) → skipped`,
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

/**
 * Run heartbeat ticks for all agents in the data directory.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (default: cwd)
 */
export async function runHeartbeatForAll(
  opts: RunHeartbeatForAgentOptions = {},
): Promise<Array<{ agentId: string; result?: unknown; error?: string }>> {
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

  console.log(`Running heartbeat for ${agentIds.length} agent(s) in parallel...`);

  // Run agents concurrently — each per-agent invocation is already
  // sequential internally (inbox drain → queue drain → main task), and
  // the per-agent file lock in `lock-manager.ts` protects against two
  // ticks racing on the same agent. Crossing agents in parallel saves
  // wall-clock time on multi-agent fleets without changing per-agent
  // semantics. Failures are absorbed via `Promise.allSettled` so one
  // agent's crash doesn't abort siblings (matches the previous
  // `try/catch` per-agent guard).
  const settled = await Promise.allSettled(
    agentIds.map((agentId) =>
      runHeartbeatForAgent(agentId, { projectDir }).then(
        (result) => ({ agentId, result }),
        (err: unknown) => {
          const m = errMsg(err);
          console.error(`[${agentId}] heartbeat error: ${m}`);
          return { agentId, error: m };
        },
      ),
    ),
  );
  // `Promise.allSettled` only rejects when the array itself rejects,
  // never when an inner promise rejects. The inner mapper above already
  // converts both branches to a fulfilled value, so every entry here is
  // a fulfilled `{ agentId, … }` record.
  return settled.map(
    (s) =>
      (s.status === 'fulfilled' ? s.value : { agentId: '', error: 'unknown' }) as {
        agentId: string;
        result?: unknown;
        error?: string;
      },
  );
}
