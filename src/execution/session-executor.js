/**
 * Session Executor — integrates CLI session launching with automatic token usage tracking.
 *
 * This module wraps the raw `launchSession` function to automatically:
 *   1. Launch a Claude Code CLI session for a given agent + task
 *   2. Parse token usage from the session's JSON output
 *   3. Create a structured usage record
 *   4. Persist the usage record via UsageStore
 *   5. Return the session result enriched with usage data
 *
 * Design:
 * - Composable: can be used standalone or as the `executeFn` for LockedSessionRunner
 * - Idempotent: repeated calls produce independent sessions; usage records are deduped by ID
 * - Graceful degradation: if token parsing fails, the session result is still returned (usage = null)
 * - File source of truth: usage records are persisted to disk via UsageStore
 *
 * Identity contract: callers pass a `subagentRef` (slug) — NOT an identity
 * object. Identity is owned by `.claude/agents/<slug>.md` and resolved by
 * the Claude Code CLI at invocation time via `--agent <slug>`.
 */

import { launchSession, parseTokenUsage } from './cli-session.js';
import { createUsageRecord, UsageStore } from '../storage/usage-store.js';
import {
  openTranscriptWriter,
  transcriptPath,
} from '../storage/transcript-store.js';

/**
 * @typedef {import('./cli-session.js').SessionResult} SessionResult
 * @typedef {import('./cli-session.js').TaskContext} TaskContext
 */

/**
 * @typedef {object} ExecutionResult
 * @property {SessionResult} sessionResult - Raw session result from CLI
 * @property {{ inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number } | null} tokenUsage - Parsed token usage (null if parsing failed)
 * @property {object | null} usageRecord - Persisted usage record (null if tracking failed or no usage data)
 * @property {boolean} usageTracked - Whether usage was successfully tracked
 * @property {string | null} transcriptPath - Absolute path of the NDJSON
 *   transcript file when `agentsDir` was provided; otherwise `null`.
 */

/**
 * Execute a CLI session and automatically track token usage.
 *
 * This is the primary entry point for running agent tasks with usage tracking.
 * It launches the session, parses tokens from the output, and persists a usage record.
 *
 * @param {string} agentId - Agent identifier (equals subagent slug)
 * @param {string} subagentRef - Subagent slug (`--agent <slug>` for the CLI)
 * @param {TaskContext} task - Task context (taskId, description, etc.)
 * @param {object} [opts]
 * @param {string} [opts.cli] - CLI binary path
 * @param {string} [opts.cwd] - Working directory
 * @param {number} [opts.timeoutMs] - Session timeout
 * @param {string} [opts.model] - Model override
 * @param {boolean} [opts.dangerouslySkipPermissions] - Skip permissions
 * @param {function} [opts.spawnFn] - Injectable spawn (for testing)
 * @param {object} [opts.env] - Extra environment variables
 * @param {UsageStore} [opts.usageStore] - UsageStore instance for persisting usage
 * @param {string} [opts.sessionId] - Optional session identifier for deduplication
 *   (also used as the execution id when recording a transcript).
 * @param {string} [opts.agentsDir] - `.aweek/agents` root. When provided
 *   (and `task.taskId` is set), the session's full NDJSON stream is
 *   persisted to `<agentsDir>/<agent>/executions/<taskId>-<sessionId>.jsonl`.
 *   Omit to skip transcript capture.
 * @returns {Promise<ExecutionResult>}
 */
export async function executeSessionWithTracking(agentId, subagentRef, task, opts = {}) {
  if (!agentId) throw new Error('agentId is required');
  if (typeof subagentRef !== 'string' || subagentRef.length === 0) {
    throw new Error('subagentRef is required and must be a non-empty string');
  }
  if (!task) throw new Error('task is required');

  const { usageStore, sessionId, agentsDir, ...launchOpts } = opts;
  const effectiveSessionId = sessionId || `session-${Date.now()}`;

  // Optional transcript capture — only when the caller supplied agentsDir
  // AND the task has an id we can namespace under.
  let transcriptWriter = null;
  let recordedTranscriptPath = null;
  if (agentsDir && task.taskId) {
    try {
      transcriptWriter = await openTranscriptWriter(
        agentsDir,
        agentId,
        task.taskId,
        effectiveSessionId,
      );
      recordedTranscriptPath = transcriptWriter.path;
    } catch {
      // Never let transcript setup prevent a tick from running.
      transcriptWriter = null;
      recordedTranscriptPath = null;
    }
  }

  // Step 1: Launch the CLI session (subagent-first)
  let sessionResult;
  try {
    sessionResult = await launchSession(agentId, subagentRef, task, {
      ...launchOpts,
      transcriptWriter,
    });
  } finally {
    if (transcriptWriter) {
      try {
        await transcriptWriter.close();
      } catch { /* best-effort */ }
    }
  }

  // Step 2: Parse token usage from session output
  const tokenUsage = parseTokenUsage(sessionResult.stdout);

  // Step 3: Create and persist usage record (if we have usage data and a store)
  let usageRecord = null;
  let usageTracked = false;

  if (tokenUsage && usageStore) {
    try {
      usageRecord = createUsageRecord({
        agentId,
        taskId: task.taskId,
        sessionId: effectiveSessionId,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        costUsd: tokenUsage.costUsd || 0,
        durationMs: sessionResult.durationMs,
        model: opts.model,
        week: task.week ? weekFromPlanWeek(task.week) : undefined,
      });

      await usageStore.append(agentId, usageRecord);
      usageTracked = true;
    } catch {
      // Graceful degradation: session succeeded even if usage tracking fails
      usageTracked = false;
    }
  }

  return {
    sessionResult,
    tokenUsage,
    usageRecord,
    usageTracked,
    transcriptPath: recordedTranscriptPath,
  };
}

/**
 * Re-export of the transcript path helper so callers that only import
 * from the executor module can resolve paths without also importing the
 * storage module.
 */
export { transcriptPath };

/**
 * Convert a plan week string (e.g., "2026-W16") to a Monday date for usage storage.
 *
 * Usage store keys by Monday ISO date (e.g., "2026-04-13"), not ISO week.
 * This converts ISO week notation to the Monday date of that week.
 *
 * @param {string} planWeek - ISO week string like "2026-W16"
 * @returns {string|undefined} Monday ISO date string, or undefined if parsing fails
 */
export function weekFromPlanWeek(planWeek) {
  if (!planWeek || typeof planWeek !== 'string') return undefined;

  const match = planWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return undefined;

  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);

  // ISO 8601: Week 1 contains January 4th
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const mondayOfWeek1 = new Date(jan4);
  mondayOfWeek1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);

  const targetMonday = new Date(mondayOfWeek1);
  targetMonday.setUTCDate(mondayOfWeek1.getUTCDate() + (week - 1) * 7);

  return targetMonday.toISOString().slice(0, 10);
}

/**
 * Create an executor function suitable for use with LockedSessionRunner.
 *
 * Returns an async function with signature `(agentId, taskInfo) => Promise<ExecutionResult>`
 * that the locked session runner can call as its `executeFn`.
 *
 * Each agent config is expected to expose its `subagentRef` (the 1-to-1
 * slug of its backing `.claude/agents/<slug>.md` file). Identity fields
 * (name, role, system prompt) are deliberately ignored — the Claude Code
 * CLI resolves them from the subagent file at invocation time.
 *
 * @param {object} config
 * @param {object} config.agentConfigs - Map of agentId → agent config (from AgentStore)
 * @param {UsageStore} [config.usageStore] - UsageStore for tracking
 * @param {object} [config.sessionOpts] - Default options passed to launchSession
 * @returns {function(string, object): Promise<ExecutionResult>}
 */
export function createTrackedExecutor(config = {}) {
  const { agentConfigs, usageStore, sessionOpts = {} } = config;
  if (!agentConfigs) throw new Error('agentConfigs is required');

  return async function trackedExecutor(agentId, taskInfo) {
    const agentConfig = agentConfigs[agentId];
    if (!agentConfig) {
      throw new Error(`No agent config found for ${agentId}`);
    }

    const subagentRef = agentConfig.subagentRef;
    if (typeof subagentRef !== 'string' || subagentRef.length === 0) {
      throw new Error(`Agent config for ${agentId} is missing subagentRef`);
    }

    const task = {
      taskId: taskInfo.taskId,
      title: taskInfo.payload?.title || taskInfo.taskId,
      prompt: taskInfo.payload?.prompt || taskInfo.taskId,
      objectiveId: taskInfo.payload?.objectiveId,
      week: taskInfo.payload?.week,
      additionalContext: taskInfo.payload?.additionalContext,
    };

    return executeSessionWithTracking(agentId, subagentRef, task, {
      ...sessionOpts,
      usageStore,
      sessionId: `${agentId}-${taskInfo.taskId}-${Date.now()}`,
    });
  };
}
