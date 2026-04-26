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
import type {
  ExecutionLogWriter,
  LaunchSessionOpts,
  SessionResult,
  SpawnFn,
  TaskContext,
  TokenUsage,
} from './cli-session.js';
import { createUsageRecord, UsageStore } from '../storage/usage-store.js';
import {
  openExecutionLogWriter,
  executionLogPath,
} from '../storage/execution-log-store.js';

/**
 * Persistent usage record returned by `createUsageRecord` and written to
 * `<agentsDir>/<agentId>/usage/<weekMonday>.json` by `UsageStore`. Mirrors
 * the JSDoc shape in `src/storage/usage-store.js`.
 */
export interface UsageRecord {
  id: string;
  timestamp: string;
  agentId: string;
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  week: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
}

/**
 * Minimal duck-typed UsageStore so test doubles can stand in for the real
 * class without re-implementing the full storage surface.
 */
export interface UsageStoreLike {
  append: (agentId: string, record: UsageRecord) => Promise<unknown>;
  init?: (agentId: string) => Promise<unknown>;
}

export interface ExecutionResult {
  /** Raw session result from CLI */
  sessionResult: SessionResult;
  /** Parsed token usage (null if parsing failed) */
  tokenUsage: TokenUsage | null;
  /** Persisted usage record (null if tracking failed or no usage data) */
  usageRecord: UsageRecord | null;
  /** Whether usage was successfully tracked */
  usageTracked: boolean;
  /**
   * Absolute path of the NDJSON execution-log file when `agentsDir` was
   * provided; otherwise `null`.
   */
  executionLogPath: string | null;
}

/**
 * Options accepted by `executeSessionWithTracking`. Extends the underlying
 * `LaunchSessionOpts` with usage-tracking fields.
 */
export interface ExecuteSessionWithTrackingOpts extends LaunchSessionOpts {
  /** UsageStore instance for persisting usage */
  usageStore?: UsageStoreLike;
  /**
   * Optional session identifier for deduplication (also used as the
   * execution id when recording an execution log).
   */
  sessionId?: string;
  /**
   * `.aweek/agents` root. When provided (and `task.taskId` is set), the
   * session's full NDJSON stream is persisted to
   * `<agentsDir>/<agent>/executions/<taskId>-<sessionId>.jsonl`. Omit to
   * skip execution-log capture.
   */
  agentsDir?: string;
}

/**
 * Per-tick task envelope handed to the executor returned by
 * `createTrackedExecutor`. The `payload` matches the queue task structure
 * the heartbeat populates.
 */
export interface TrackedExecutorTaskInfo {
  taskId: string;
  payload?: {
    title?: string;
    prompt?: string;
    objectiveId?: string;
    week?: string;
    additionalContext?: string;
  };
}

/**
 * Agent config shape that `createTrackedExecutor` reads. The full
 * `AgentStore` record carries many more fields, but only `id` and
 * `subagentRef` are consumed here.
 */
export interface TrackedExecutorAgentConfig {
  id?: string;
  subagentRef?: string;
}

export interface CreateTrackedExecutorConfig {
  /** Map of agentId → agent config (from AgentStore) */
  agentConfigs: Record<string, TrackedExecutorAgentConfig>;
  /** UsageStore for tracking */
  usageStore?: UsageStoreLike;
  /** Default options passed to launchSession */
  sessionOpts?: LaunchSessionOpts;
}

/**
 * Async executor signature suitable for use as `executeFn` in
 * LockedSessionRunner.
 */
export type TrackedExecutor = (
  agentId: string,
  taskInfo: TrackedExecutorTaskInfo,
) => Promise<ExecutionResult>;

/**
 * Execute a CLI session and automatically track token usage.
 *
 * This is the primary entry point for running agent tasks with usage tracking.
 * It launches the session, parses tokens from the output, and persists a usage record.
 */
export async function executeSessionWithTracking(
  agentId: string,
  subagentRef: string,
  task: TaskContext,
  opts: ExecuteSessionWithTrackingOpts = {},
): Promise<ExecutionResult> {
  if (!agentId) throw new Error('agentId is required');
  if (typeof subagentRef !== 'string' || subagentRef.length === 0) {
    throw new Error('subagentRef is required and must be a non-empty string');
  }
  if (!task) throw new Error('task is required');

  const { usageStore, sessionId, agentsDir, ...launchOpts } = opts;
  const effectiveSessionId = sessionId || `session-${Date.now()}`;

  // Optional execution-log capture — only when the caller supplied
  // agentsDir AND the task has an id we can namespace under.
  let executionLogWriter: (ExecutionLogWriter & { close: () => Promise<void>; path: string }) | null = null;
  let recordedExecutionLogPath: string | null = null;
  if (agentsDir && task.taskId) {
    try {
      executionLogWriter = await openExecutionLogWriter(
        agentsDir,
        agentId,
        task.taskId,
        effectiveSessionId,
      );
      recordedExecutionLogPath = executionLogWriter ? executionLogWriter.path : null;
    } catch {
      // Never let execution-log setup prevent a tick from running.
      executionLogWriter = null;
      recordedExecutionLogPath = null;
    }
  }

  // Step 1: Launch the CLI session (subagent-first)
  let sessionResult: SessionResult;
  try {
    sessionResult = await launchSession(agentId, subagentRef, task, {
      ...launchOpts,
      executionLogWriter,
    });
  } finally {
    if (executionLogWriter) {
      try {
        await executionLogWriter.close();
      } catch { /* best-effort */ }
    }
  }

  // Step 2: Parse token usage from session output
  const tokenUsage = parseTokenUsage(sessionResult.stdout);

  // Step 3: Create and persist usage record (if we have usage data and a store)
  let usageRecord: UsageRecord | null = null;
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
      }) as UsageRecord;

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
    executionLogPath: recordedExecutionLogPath,
  };
}

/**
 * Re-export of the execution-log path helper so callers that only
 * import from the executor module can resolve paths without also
 * importing the storage module.
 */
export { executionLogPath };

/**
 * Convert a plan week string (e.g., "2026-W16") to a Monday date for usage storage.
 *
 * Usage store keys by Monday ISO date (e.g., "2026-04-13"), not ISO week.
 * This converts ISO week notation to the Monday date of that week.
 */
export function weekFromPlanWeek(planWeek: unknown): string | undefined {
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
 */
export function createTrackedExecutor(
  config: Partial<CreateTrackedExecutorConfig> = {},
): TrackedExecutor {
  const { agentConfigs, usageStore, sessionOpts = {} } = config;
  if (!agentConfigs) throw new Error('agentConfigs is required');

  return async function trackedExecutor(
    agentId: string,
    taskInfo: TrackedExecutorTaskInfo,
  ): Promise<ExecutionResult> {
    const agentConfig = agentConfigs[agentId];
    if (!agentConfig) {
      throw new Error(`No agent config found for ${agentId}`);
    }

    const subagentRef = agentConfig.subagentRef;
    if (typeof subagentRef !== 'string' || subagentRef.length === 0) {
      throw new Error(`Agent config for ${agentId} is missing subagentRef`);
    }

    const task: TaskContext = {
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

// Re-export upstream types for downstream callers that prefer importing
// from this module.
export type {
  ExecutionLogWriter,
  LaunchSessionOpts,
  SessionResult,
  SpawnFn,
  TaskContext,
  TokenUsage,
};
