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
import { readdir } from 'node:fs/promises';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { ExecutionStore, createExecutionRecord } from '../storage/execution-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { ActivityLogStore, createLogEntry } from '../storage/activity-log-store.js';
import { createScheduler } from './scheduler.js';
import { tickAgent } from './heartbeat-task-runner.js';
import {
  selectTasksForTickFromPlan,
  trackKeyOf,
} from './task-selector.js';
import { executeSessionWithTracking } from '../execution/session-executor.js';
import { enforceBudget } from '../services/budget-enforcer.js';
import { loadConfig } from '../storage/config-store.js';
import { detectSystemTimeZone } from '../time/zone.js';

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
    weeklyPlanStore,
    usageStore,
    activityLogStore,
    agentStore,
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
 * Run the full per-task pipeline for one selection: execute the CLI
 * session with token tracking, mark the task status, append the rich
 * activity-log entry, and enforce the weekly budget.
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
