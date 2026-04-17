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
import { ExecutionStore } from '../storage/execution-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { ActivityLogStore, createLogEntry } from '../storage/activity-log-store.js';
import { createScheduler } from './scheduler.js';
import { tickAgent } from './heartbeat-task-runner.js';
import { executeSessionWithTracking } from '../execution/session-executor.js';
import { enforceBudget } from '../services/budget-enforcer.js';

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

  // Step 1: Select next task
  const tickResult = await tickAgent(agentId, {
    weeklyPlanStore,
    executionStore,
    agentStore,
  });

  console.log(`[${agentId}] tick outcome: ${tickResult.outcome}`);

  if (tickResult.outcome !== 'task_selected') {
    if (tickResult.reason) console.log(`  reason: ${tickResult.reason}`);
    return tickResult;
  }

  // Step 2: Load agent identity for CLI session
  const config = await agentStore.load(agentId);
  const identity = config.identity;
  const task = tickResult.task;

  console.log(`[${agentId}] executing task: ${task.description}`);

  const startedAt = new Date();
  let execResult = null;
  let error = null;
  let finalStatus = 'completed';

  try {
    // Step 3: Execute CLI session with token tracking
    execResult = await executeSessionWithTracking(agentId, identity, {
      taskId: task.id,
      description: task.description,
      objectiveId: task.objectiveId,
      week: tickResult.week,
    }, {
      cwd: projectDir,
      usageStore,
    });
  } catch (err) {
    error = err;
    finalStatus = 'failed';
    console.error(`[${agentId}] execution error: ${err.message}`);
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  // Step 4: Mark task status
  await weeklyPlanStore.updateTaskStatus(
    agentId,
    tickResult.week,
    task.id,
    finalStatus === 'completed' ? 'completed' : 'failed',
  );
  console.log(`[${agentId}] task ${finalStatus}: ${task.id}`);

  // Step 5: Write rich activity log entry
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
        week: tickResult.week,
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

  // Step 6: Enforce budget
  try {
    await enforceBudget(agentId, {
      agentStore,
      usageStore,
      alertDir: join(dataDir, 'alerts'),
    });
  } catch (err) {
    console.warn(`[${agentId}] budget enforcement warning: ${err.message}`);
  }

  if (error) throw error;
  return { tickResult, execResult };
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
