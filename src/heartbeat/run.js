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
import { createScheduler } from './scheduler.js';
import { tickAgent } from './heartbeat-task-runner.js';
import { executeSessionWithTracking } from '../execution/session-executor.js';
import { enforceBudget } from '../services/budget-enforcer.js';

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

  const agentStore = new AgentStore(join(dataDir, 'agents'));
  const weeklyPlanStore = new WeeklyPlanStore(join(dataDir, 'agents'));
  const executionStore = new ExecutionStore(join(dataDir, 'executions'));
  const usageStore = new UsageStore(join(dataDir, 'usage'));
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

  // Step 3: Execute CLI session with token tracking
  const execResult = await executeSessionWithTracking(agentId, identity, {
    taskId: task.id,
    description: task.description,
    objectiveId: task.objectiveId,
    week: tickResult.week,
  }, {
    cwd: projectDir,
    usageStore,
  });

  // Step 4: Mark task as completed
  await weeklyPlanStore.updateTaskStatus(agentId, tickResult.week, task.id, 'completed');
  console.log(`[${agentId}] task completed: ${task.id}`);

  // Step 5: Enforce budget
  try {
    await enforceBudget(agentId, {
      agentStore,
      usageStore,
      alertDir: join(dataDir, 'alerts'),
    });
  } catch (err) {
    console.warn(`[${agentId}] budget enforcement warning: ${err.message}`);
  }

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
