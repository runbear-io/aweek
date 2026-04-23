/**
 * Run-once skill — manually dispatch an ad-hoc debugging task to an agent.
 *
 * This is the debug-only counterpart of the hourly heartbeat. It reuses the
 * exact execution path of a real tick (per-agent heartbeat lock, per-agent
 * `.env`, `executeSessionWithTracking` with the same `dangerouslySkipPermissions`
 * / `usageStore` / `agentsDir` options) but feeds it an in-memory synthetic
 * task instead of a scheduled weekly-plan entry.
 *
 * Key differences from `heartbeat/run.js:executeOneSelection`:
 *
 *   - Bypasses `config.paused`: the whole point is to poke a paused agent
 *     without resuming it.
 *   - Ephemeral task: the task is never written to the weekly plan, so its
 *     status can't be "completed" / "failed" on disk — there's nothing to
 *     update. The synthetic shape intentionally omits `objectiveId` / `runAt`
 *     which the weekly-plan schema would require for a real task.
 *   - Always writes an activity-log entry so the dashboard can link to the
 *     execution log, both on success and on failure.
 *
 * Budget accounting is intentionally left to `executeSessionWithTracking` —
 * the ad-hoc run consumes tokens exactly like a scheduled tick would.
 */

import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '../storage/agent-store.js';
import { UsageStore } from '../storage/usage-store.js';
import { ActivityLogStore, createLogEntry } from '../storage/activity-log-store.js';
import { runWithHeartbeatLock } from '../heartbeat/heartbeat-lock.js';
import { executeSessionWithTracking } from '../execution/session-executor.js';
import { loadAgentEnv } from '../storage/agent-env-store.js';
import { extractResources } from '../heartbeat/run.js';

/**
 * Build the in-memory ephemeral task. Kept as a helper so tests can assert
 * the shape (and it keeps `execute` short). Does NOT touch disk.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The task prompt fed to the CLI session.
 * @param {string} [opts.title] - Short display label; defaults to "Ad-hoc debug run".
 * @returns {{ id: string, title: string, prompt: string, status: 'in-progress' }}
 */
export function buildAdHocTask({ prompt, title } = {}) {
  return {
    id: `adhoc-${randomUUID().slice(0, 8)}`,
    title: title || 'Ad-hoc debug run',
    prompt,
    status: 'in-progress',
  };
}

/**
 * Manually dispatch an ad-hoc task to an agent through the same execution
 * path the heartbeat uses.
 *
 * @param {object} opts
 * @param {string} opts.agentId - Target agent id.
 * @param {string} opts.prompt - Prompt the synthetic task carries.
 * @param {string} [opts.title] - Optional short title for the activity entry.
 * @param {boolean} opts.confirmed - Must be `true`. Destructive gate.
 * @param {string} [opts.projectDir] - Project root (default: `process.cwd()`).
 * @param {string} [opts.dataDir] - Override for the `.aweek/agents` root.
 *   Useful for tests; production callers should let it default.
 * @param {AgentStore} [opts.agentStore] - Injectable store (tests).
 * @param {UsageStore} [opts.usageStore] - Injectable store (tests).
 * @param {ActivityLogStore} [opts.activityLogStore] - Injectable store (tests).
 * @param {typeof executeSessionWithTracking} [opts.executeFn] - Injectable
 *   executor. Defaults to the real `executeSessionWithTracking`; tests pass
 *   a stub so no real CLI session is launched.
 * @param {typeof runWithHeartbeatLock} [opts.lockFn] - Injectable lock wrapper.
 *   Defaults to the real heartbeat lock.
 * @param {typeof loadAgentEnv} [opts.envLoader] - Injectable `.env` loader.
 * @returns {Promise<{
 *   agentId: string,
 *   task: object,
 *   execResult: object | null,
 *   activityEntry: object | null,
 *   executionLogBasename: string | null,
 *   durationMs: number,
 *   finalStatus: 'completed' | 'failed',
 *   error?: string,
 * }>}
 */
export async function execute(opts = {}) {
  // Step 1: Confirmation gate — matches the destructive-op policy.
  if (opts.confirmed !== true) {
    const err = new Error(
      'run-once requires explicit user confirmation. ' +
        'Collect consent via AskUserQuestion and pass `confirmed: true`.',
    );
    err.code = 'ERUN_NOT_CONFIRMED';
    throw err;
  }

  const agentId = opts.agentId;
  if (!agentId) {
    const err = new Error('run-once: agentId is required');
    err.code = 'ERUN_NOT_CONFIRMED';
    throw err;
  }

  const projectDir = opts.projectDir || process.cwd();
  // Explicit dataDir override takes precedence (tests); otherwise derive from
  // projectDir so the dispatcher can pass a bare `projectDir` in production.
  const agentsDir =
    opts.dataDir || `${projectDir.replace(/\/+$/, '')}/.aweek/agents`;

  const agentStore = opts.agentStore || new AgentStore(agentsDir);
  const usageStore = opts.usageStore || new UsageStore(agentsDir);
  const activityLogStore =
    opts.activityLogStore || new ActivityLogStore(agentsDir);
  const executeFn = opts.executeFn || executeSessionWithTracking;
  const lockFn = opts.lockFn || runWithHeartbeatLock;
  const envLoader = opts.envLoader || loadAgentEnv;

  // Step 2: Agent resolution. AgentStore.load throws on ENOENT; promote to
  // the documented `ERUN_UNKNOWN_AGENT` code so the skill markdown can show
  // a helpful message rather than "ENOENT: no such file or directory".
  let config;
  try {
    config = await agentStore.load(agentId);
  } catch (cause) {
    const err = new Error(`run-once: agent not found: ${agentId}`);
    err.code = 'ERUN_UNKNOWN_AGENT';
    err.cause = cause;
    throw err;
  }

  // Step 3: Force through pause — do NOT read `config.budget?.paused`.
  const subagentRef = config.subagentRef || agentId;
  const task = buildAdHocTask({ prompt: opts.prompt, title: opts.title });

  // Step 4: Wrap the actual run in the per-agent heartbeat lock so a manual
  // dispatch can never collide with a concurrent cron tick. The callback
  // body owns every side effect (env load, executor, activity log).
  const lockResult = await lockFn(agentId, async () => {
    let agentEnv = {};
    try {
      agentEnv = await envLoader(agentsDir, agentId);
    } catch {
      // Graceful degradation — same behavior as heartbeat/run.js.
    }

    const startedAt = new Date();
    let execResult = null;
    let error = null;
    let finalStatus = 'completed';

    try {
      execResult = await executeFn(
        agentId,
        subagentRef,
        // Executor expects the heartbeat's CLI-shaped task (taskId +
        // title + prompt), not the weekly-task schema shape. Mirror
        // the wire at src/heartbeat/run.js:539 so buildRuntimeContext
        // and the execution-log writer find the fields they need.
        {
          taskId: task.id,
          title: task.title,
          prompt: task.prompt,
        },
        {
          cwd: projectDir,
          usageStore,
          env: agentEnv,
          agentsDir,
          dangerouslySkipPermissions: true,
        },
      );
    } catch (err) {
      error = err;
      finalStatus = 'failed';
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    // Derive the `<taskId>_<sessionId>` basename so the caller can build a
    // direct dashboard URL. Null when the executor didn't record a file.
    const executionLogPath = execResult?.executionLogPath || null;
    const executionLogBasename = executionLogPath
      ? basename(executionLogPath).replace(/\.jsonl$/, '')
      : null;

    // Step 5: Activity log — mirror heartbeat/run.js:executeOneSelection so
    // the dashboard drawer can render the ad-hoc run the same way.
    let activityEntry = null;
    try {
      const session = execResult?.sessionResult;
      const stdout = session?.stdout || '';
      const stderr = session?.stderr || '';
      const resources = extractResources(stdout + '\n' + stderr);

      const metadata = {
        task: {
          id: task.id,
          title: task.title,
          adhoc: true,
        },
        execution: {
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs,
          exitCode: session?.exitCode ?? null,
          timedOut: session?.timedOut ?? false,
          executionLogPath,
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
          stack: error.stack
            ? error.stack.split('\n').slice(0, 5).join('\n')
            : undefined,
        };
      }

      activityEntry = await activityLogStore.append(
        agentId,
        createLogEntry({
          agentId,
          taskId: task.id,
          status: finalStatus,
          title: task.title,
          duration: durationMs,
          metadata,
        }),
      );
    } catch {
      // Activity logging is best-effort — a log-write failure must not mask
      // the session result.
    }

    // Step 6: Return the sync result. Errors are reported via `finalStatus`
    // + `error` rather than a throw so the activity entry is always written.
    return {
      agentId,
      task,
      execResult,
      activityEntry,
      executionLogBasename,
      durationMs,
      finalStatus,
      ...(error ? { error: error.message } : {}),
    };
  });

  // The lock wrapper never rethrows — it maps thrown errors into
  // `status: 'error'`. But our callback swallows executor errors into the
  // return value, so `status: 'completed'` is the only expected path. Still
  // handle the unexpected branches defensively.
  if (lockResult.status === 'completed') {
    return lockResult.result;
  }

  if (lockResult.status === 'skipped') {
    const err = new Error(
      `run-once: heartbeat lock held by another process (${lockResult.reason})`,
    );
    err.code = 'ERUN_LOCKED';
    err.existingLock = lockResult.existingLock;
    throw err;
  }

  // status === 'error' — callback threw unexpectedly (not an executor error).
  throw lockResult.error || new Error(lockResult.reason || 'run-once failed');
}
