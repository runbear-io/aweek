/**
 * Manage skill logic — consolidated entry point for the `/aweek:manage` skill.
 *
 * The `/aweek:manage` skill (see `skills/aweek-manage.md`) is the consolidated
 * replacement for `/aweek:resume-agent` and other agent-lifecycle operations.
 * It covers everything that happens to an agent *after* it's been hired:
 *
 *   1. **Resume a paused agent** — clear the `budget.paused` flag so the agent
 *      starts executing again on the next heartbeat tick.
 *
 *   2. **Top-up a paused agent** — reset the weekly usage counter to zero and
 *      optionally set a new weekly token budget limit.
 *
 *   3. **Pause / stop an agent** — set the `budget.paused` flag so the
 *      heartbeat skips the agent on the next tick. Reversible via `resume`.
 *
 *   4. **Edit identity** — update the `identity.{name, role, systemPrompt}`
 *      fields on an existing agent with schema validation.
 *
 *   5. **Delete / archive an agent** — remove the agent config file from
 *      disk. Destructive and confirmation-gated.
 *
 * This file intentionally mirrors the `src/skills/hire.js` /
 * `src/skills/plan.js` pattern: a thin composition layer that re-exports the
 * canonical implementation from `./resume-agent.js` so there is exactly one
 * source of truth for how a paused agent is resumed.
 */

import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RESUME_ACTIONS,
  listPausedAgents as listPausedAgentsImpl,
  getPausedAgentDetails as getPausedAgentDetailsImpl,
  validateResumeAction as validateResumeActionImpl,
  executeResume as executeResumeImpl,
  formatPausedAgentsList as formatPausedAgentsListImpl,
  formatPausedAgentDetails as formatPausedAgentDetailsImpl,
  formatResumeResult as formatResumeResultImpl,
} from './resume-agent.js';
import type {
  ListPausedAgentsResult,
  PausedAgentDetails,
  ExecuteResumeResult,
  ValidateResumeActionResult,
} from './resume-agent.js';
import {
  createAgentStore,
  loadAgent,
  resolveDataDir,
} from '../storage/agent-helpers.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';

/**
 * Default project-level subagents directory.
 */
function getDefaultSubagentsDir(): string {
  return join(process.cwd(), '.claude', 'agents');
}

// ---------------------------------------------------------------------------
// Discovery — list paused agents and show budget details
// ---------------------------------------------------------------------------

/**
 * List every paused agent with a compact budget snapshot.
 */
export function listPausedAgents(
  params: Parameters<typeof listPausedAgentsImpl>[0],
): ReturnType<typeof listPausedAgentsImpl> {
  return listPausedAgentsImpl(params);
}

/**
 * Load detailed budget / alert info for a single paused agent.
 */
export function getPausedAgentDetails(
  agentId: string,
  opts: Parameters<typeof getPausedAgentDetailsImpl>[1],
): ReturnType<typeof getPausedAgentDetailsImpl> {
  return getPausedAgentDetailsImpl(agentId, opts);
}

// ---------------------------------------------------------------------------
// Action entry points
// ---------------------------------------------------------------------------

/**
 * Resume a paused agent by clearing the `budget.paused` flag.
 */
export function resume(
  { agentId, dataDir, timestamp }: { agentId?: string; dataDir?: string; timestamp?: string } = {},
): Promise<ExecuteResumeResult> {
  return executeResumeImpl(agentId, 'resume', { dataDir, timestamp });
}

/** Params for {@link topUp}. */
export interface TopUpParams {
  agentId?: string;
  dataDir?: string;
  confirmed?: boolean;
  newLimit?: number;
  timestamp?: string;
}

/**
 * Top-up a paused agent: reset weekly usage to zero and optionally set a
 * new weekly token budget limit. Also clears the pause flag.
 *
 * **Destructive** — requires `confirmed: true`.
 */
export function topUp(params: TopUpParams = {}): Promise<ExecuteResumeResult> {
  if (!params || params.confirmed !== true) {
    return Promise.resolve({
      agentId: params?.agentId ?? '',
      action: 'top-up',
      success: false,
      errors: [
        'Top-up requires explicit confirmation. Pass `confirmed: true` after the user confirms the destructive operation.',
      ],
    });
  }

  const { agentId, dataDir, newLimit, timestamp } = params;
  return executeResumeImpl(agentId, 'top-up', { dataDir, newLimit, timestamp });
}

/** Params for {@link executeAction}. */
export interface ExecuteActionOpts {
  dataDir?: string;
  confirmed?: boolean;
  newLimit?: number;
  timestamp?: string;
}

/**
 * Generic action dispatcher kept for parity with the old
 * `/aweek:resume-agent` skill's single-call shape.
 */
export function executeAction(
  agentId: string,
  action: 'resume' | 'top-up',
  opts: ExecuteActionOpts = {},
): Promise<ExecuteResumeResult> {
  if (action === 'top-up' && opts.confirmed !== true) {
    return Promise.resolve({
      agentId,
      action: 'top-up',
      success: false,
      errors: [
        'Top-up requires explicit confirmation. Pass `confirmed: true` after the user confirms the destructive operation.',
      ],
    });
  }
  const { confirmed: _confirmed, ...serviceOpts } = opts;
  void _confirmed;
  return executeResumeImpl(agentId, action, serviceOpts);
}

// ---------------------------------------------------------------------------
// Pause — the inverse of resume.
// ---------------------------------------------------------------------------

/** Result of {@link pause}. */
export interface PauseResult {
  agentId: string | undefined;
  action: 'pause';
  success: boolean;
  wasPaused?: boolean;
  message?: string;
  errors?: string[];
}

/**
 * Pause (stop) an agent by setting the `budget.paused` flag.
 */
export async function pause(
  { agentId, dataDir }: { agentId?: string; dataDir?: string } = {},
): Promise<PauseResult> {
  if (!agentId) {
    return {
      agentId,
      action: 'pause',
      success: false,
      errors: ['agentId is required'],
    };
  }

  const store = createAgentStore(dataDir);
  let wasPaused: boolean;
  try {
    const current = await store.load(agentId);
    wasPaused = current.budget?.paused === true;
    await store.update(agentId, (cfg) => {
      cfg.budget!.paused = true;
      return cfg;
    });
  } catch (err) {
    const e = err as Error;
    return {
      agentId,
      action: 'pause',
      success: false,
      errors: [e.message || String(err)],
    };
  }

  return {
    agentId,
    action: 'pause',
    success: true,
    wasPaused,
    message: wasPaused
      ? `Agent "${agentId}" was already paused — no change.`
      : `Agent "${agentId}" has been paused. The heartbeat will skip it on the next tick. Use /aweek:manage → resume to unpause.`,
  };
}

// ---------------------------------------------------------------------------
// Delete / archive — permanently remove an agent config file from disk.
// ---------------------------------------------------------------------------

/** Params for {@link deleteAgent}. */
export interface DeleteAgentParams {
  agentId?: string;
  dataDir?: string;
  confirmed?: boolean;
  deleteSubagentMd?: boolean;
  subagentsDir?: string;
}

/** Subagent .md handling metadata in {@link DeleteAgentResult}. */
export interface DeleteSubagentMdResult {
  requested: boolean;
  existed: boolean;
  deleted: boolean;
  path: string;
  error?: string;
}

/** Result of {@link deleteAgent}. */
export interface DeleteAgentResult {
  agentId: string | undefined;
  action: 'delete';
  success: boolean;
  deleted?: boolean;
  snapshot?: {
    id: string;
    name?: string;
    role?: string;
    goalCount: number;
    weeklyPlanCount: number;
  };
  subagentMd?: DeleteSubagentMdResult;
  errors?: string[];
  message?: string;
}

/**
 * Permanently delete an agent's config file.
 */
export async function deleteAgent(params: DeleteAgentParams = {}): Promise<DeleteAgentResult> {
  const {
    agentId,
    dataDir,
    confirmed,
    deleteSubagentMd = false,
    subagentsDir,
  } = params || {};

  if (!agentId) {
    return {
      agentId,
      action: 'delete',
      success: false,
      errors: ['agentId is required'],
    };
  }

  if (confirmed !== true) {
    return {
      agentId,
      action: 'delete',
      success: false,
      errors: [
        'Delete requires explicit confirmation. Pass `confirmed: true` after the user confirms the destructive operation.',
      ],
    };
  }

  const store = createAgentStore(dataDir);

  // Capture a snapshot of the agent's identity before deleting.
  let snapshot;
  try {
    snapshot = await loadAgent({ agentId, agentStore: store });
  } catch (err) {
    const e = err as Error;
    return {
      agentId,
      action: 'delete',
      success: false,
      errors: [e.message || String(err)],
    };
  }

  // Count weekly plans BEFORE deleting the agent JSON.
  const weeklyPlanStore = new WeeklyPlanStore(resolveDataDir(dataDir));
  const weeklyPlanCount = await weeklyPlanStore
    .list(agentId)
    .then((ws) => ws.length)
    .catch(() => 0);

  try {
    await store.delete(agentId);
  } catch (err) {
    const e = err as Error;
    return {
      agentId,
      action: 'delete',
      success: false,
      errors: [e.message || String(err)],
    };
  }

  // Optionally also remove the project-level subagent .md file.
  const resolvedSubagentsDir = subagentsDir || getDefaultSubagentsDir();
  const subagentMdPath = join(resolvedSubagentsDir, `${agentId}.md`);
  const subagentMd: DeleteSubagentMdResult = {
    requested: deleteSubagentMd === true,
    existed: false,
    deleted: false,
    path: subagentMdPath,
  };

  if (deleteSubagentMd === true) {
    let existed = false;
    try {
      await access(subagentMdPath);
      existed = true;
    } catch {
      existed = false;
    }
    subagentMd.existed = existed;

    if (existed) {
      try {
        await rm(subagentMdPath, { force: true });
        subagentMd.deleted = true;
      } catch (err) {
        const e = err as Error;
        subagentMd.deleted = false;
        subagentMd.error = e.message || String(err);
      }
    }
  }

  return {
    agentId,
    action: 'delete',
    success: true,
    deleted: true,
    snapshot: {
      id: snapshot.id,
      name: snapshot.identity?.name,
      role: snapshot.identity?.role,
      goalCount: Array.isArray(snapshot.goals) ? snapshot.goals.length : 0,
      weeklyPlanCount,
    },
    subagentMd,
    message: `Agent "${snapshot.identity?.name || agentId}" (${agentId}) has been deleted.`,
  };
}

// ---------------------------------------------------------------------------
// Validation — re-exported so the skill markdown can pre-validate user input
// ---------------------------------------------------------------------------

/**
 * Validate a user-picked resume action (and optional top-up limit).
 */
export function validateAction(
  action: Parameters<typeof validateResumeActionImpl>[0],
  options?: Parameters<typeof validateResumeActionImpl>[1],
): ValidateResumeActionResult {
  return validateResumeActionImpl(action, options);
}

// ---------------------------------------------------------------------------
// Formatters — re-exported for the skill markdown to render output
// ---------------------------------------------------------------------------

/**
 * Format the paused-agents list for the skill's Step 1 output.
 */
export function formatPausedAgentsList(listResult: ListPausedAgentsResult): string {
  return formatPausedAgentsListImpl(listResult);
}

/**
 * Format a single agent's budget detail view for Step 2 output.
 */
export function formatPausedAgentDetails(details: PausedAgentDetails): string {
  return formatPausedAgentDetailsImpl(details);
}

/**
 * Format the post-action confirmation for Step 4 output.
 */
export function formatActionResult(result: ExecuteResumeResult): string {
  return formatResumeResultImpl(result);
}

/**
 * Format the result of a `pause()` call.
 */
export function formatPauseResult(result: PauseResult | null | undefined): string {
  if (!result) return '';
  if (!result.success) {
    return `Failed to pause agent "${result.agentId}": ${(result.errors || ['unknown error']).join('; ')}`;
  }
  const lines: string[] = ['=== Pause Result ==='];
  lines.push(result.message || '');
  lines.push('');
  lines.push('Use `/aweek:manage` → resume to unpause the agent.');
  return lines.join('\n');
}

/**
 * Format the result of a `deleteAgent()` call.
 */
export function formatDeleteResult(result: DeleteAgentResult | null | undefined): string {
  if (!result) return '';
  if (!result.success) {
    return `Failed to delete agent "${result.agentId}": ${(result.errors || ['unknown error']).join('; ')}`;
  }
  const lines: string[] = ['=== Agent Deleted ==='];
  lines.push(result.message || '');
  if (result.snapshot) {
    lines.push('');
    lines.push(
      `Removed: ${result.snapshot.name || '(unnamed)'} — role: ${result.snapshot.role || '(none)'}`,
    );
    lines.push(
      `Lost: ${result.snapshot.goalCount} goal(s), ${result.snapshot.weeklyPlanCount} weekly plan(s).`,
    );
  }
  // Subagent .md file status.
  if (result.subagentMd) {
    lines.push('');
    if (!result.subagentMd.requested) {
      lines.push(`Subagent file kept: ${result.subagentMd.path}`);
    } else if (result.subagentMd.deleted) {
      lines.push(`Subagent file deleted: ${result.subagentMd.path}`);
    } else if (!result.subagentMd.existed) {
      lines.push(
        `Subagent file not found (nothing to delete): ${result.subagentMd.path}`,
      );
    } else {
      lines.push(
        `Subagent file delete failed: ${result.subagentMd.path} — ${result.subagentMd.error || 'unknown error'}`,
      );
    }
  }
  lines.push('');
  lines.push('This action cannot be undone.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Re-exports — the original names stay available too so callers that already
// know the shared pipeline can opt into them directly.
// ---------------------------------------------------------------------------
export {
  RESUME_ACTIONS,
  listPausedAgentsImpl as listPausedAgentsRaw,
  getPausedAgentDetailsImpl as getPausedAgentDetailsRaw,
  validateResumeActionImpl as validateResumeAction,
  executeResumeImpl as executeResume,
  formatPausedAgentsListImpl as formatPausedAgentsListRaw,
  formatPausedAgentDetailsImpl as formatPausedAgentDetailsRaw,
  formatResumeResultImpl as formatResumeResult,
};
