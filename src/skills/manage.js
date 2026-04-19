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
 * source of truth for how a paused agent is resumed. The `/aweek:manage`
 * skill markdown imports everything it needs from this one module.
 *
 * ## Why an adapter instead of importing resume-agent.js directly?
 *
 *   - Keeps the skill markdown's import line short and stable as more
 *     lifecycle operations land under `/aweek:manage`.
 *   - Gives us a single, obvious place to enforce skill-level concerns such
 *     as destructive-operation confirmation gates (see `topUp`, `deleteAgent`).
 *   - Matches the established aweek pattern used by `src/skills/hire.js`
 *     (thin adapter over the shared pipeline).
 *
 * ## Destructive operation safety
 *
 * Per project constraints, every destructive skill operation must require
 * explicit user confirmation *before* execution. The following `/aweek:manage`
 * operations qualify:
 *
 *   - `topUp` resets an agent's weekly usage counter to zero and, if a new
 *     limit is supplied, overwrites the budget limit. Both side effects are
 *     irreversible without manual data edits, so this adapter requires the
 *     caller to pass `confirmed: true`. The skill markdown is responsible
 *     for collecting the interactive confirmation from the user.
 *
 *   - `deleteAgent` permanently removes the agent JSON file from
 *     `.aweek/agents/<id>.json`. There is no undo — the only way to
 *     recover is from the user's own backups. This adapter requires
 *     `confirmed: true` exactly like `topUp`.
 *
 *   - `resume`, `pause`, and `editIdentity` are not destructive — they only
 *     flip a flag or overwrite editable text fields that the user can change
 *     back at any time — so they have no confirmation gate.
 *
 *   - The underlying `executeResume` from `./resume-agent.js` has no such
 *     guard, so the enforcement has to live at this adapter layer.
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
import {
  createAgentStore,
  loadAgent,
  resolveDataDir,
} from '../storage/agent-helpers.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';

/**
 * Default project-level subagents directory.
 *
 * Computed on every call so tests that `process.chdir()` to a tmpdir resolve
 * against the current cwd rather than a value frozen at module load. The
 * user-level `~/.claude/agents/` path is deliberately NEVER used — aweek
 * only writes to / reads from / deletes project-level subagent files per
 * the refactor constraints.
 *
 * @returns {string}
 */
function getDefaultSubagentsDir() {
  return join(process.cwd(), '.claude', 'agents');
}

// ---------------------------------------------------------------------------
// Discovery — list paused agents and show budget details
//
// These are re-exported verbatim. The `/aweek:manage` skill calls them in
// the "resume a paused agent" branch to present the list and let the user
// pick which agent to act on.
// ---------------------------------------------------------------------------

/**
 * List every paused agent with a compact budget snapshot.
 * See {@link listPausedAgentsImpl} in `./resume-agent.js`.
 *
 * @param {Parameters<typeof listPausedAgentsImpl>[0]} params
 * @returns {ReturnType<typeof listPausedAgentsImpl>}
 */
export function listPausedAgents(params) {
  return listPausedAgentsImpl(params);
}

/**
 * Load detailed budget / alert info for a single paused agent.
 * See {@link getPausedAgentDetailsImpl} in `./resume-agent.js`.
 *
 * @param {string} agentId
 * @param {Parameters<typeof getPausedAgentDetailsImpl>[1]} opts
 * @returns {ReturnType<typeof getPausedAgentDetailsImpl>}
 */
export function getPausedAgentDetails(agentId, opts) {
  return getPausedAgentDetailsImpl(agentId, opts);
}

// ---------------------------------------------------------------------------
// Action entry points
//
// The `resume` and `topUp` wrappers are the preferred surface for the
// consolidated `/aweek:manage` skill — each call is decision-specific so
// the skill code reads naturally instead of threading a stringly-typed
// `action` field through a single omnibus function.
// ---------------------------------------------------------------------------

/**
 * Resume a paused agent by clearing the `budget.paused` flag.
 *
 * Non-destructive — if the agent is still over budget it will re-pause on
 * the next enforcement check. Safe to call repeatedly (idempotent).
 *
 * Delegates to {@link executeResumeImpl} with `action = 'resume'`.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent to resume
 * @param {string} params.dataDir - Base data directory (e.g., ./.aweek/agents)
 * @param {string} [params.timestamp] - Explicit timestamp (for deterministic tests)
 * @returns {Promise<ReturnType<typeof executeResumeImpl>>}
 */
export function resume({ agentId, dataDir, timestamp } = {}) {
  return executeResumeImpl(agentId, 'resume', { dataDir, timestamp });
}

/**
 * Top-up a paused agent: reset weekly usage to zero and optionally set a
 * new weekly token budget limit. Also clears the pause flag.
 *
 * **Destructive** — the previous usage counter and (optionally) the old
 * budget limit are overwritten and cannot be recovered from the agent
 * config alone. Per project constraints, destructive operations require
 * explicit user confirmation. This wrapper enforces that guard: the caller
 * (the skill markdown) must pass `confirmed: true` after collecting an
 * interactive confirmation from the user. Without it, the underlying
 * service is never invoked and the agent is left untouched.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent to top up
 * @param {string} params.dataDir - Base data directory
 * @param {boolean} params.confirmed - Must be `true`. The skill markdown
 *   is responsible for gathering an explicit user confirmation before
 *   setting this flag.
 * @param {number} [params.newLimit] - Optional new weekly token limit
 * @param {string} [params.timestamp] - Explicit timestamp (tests)
 * @returns {Promise<ReturnType<typeof executeResumeImpl>>}
 */
export function topUp(params = {}) {
  if (!params || params.confirmed !== true) {
    return Promise.resolve({
      agentId: params?.agentId,
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

/**
 * Generic action dispatcher kept for parity with the old
 * `/aweek:resume-agent` skill's single-call shape. Prefer {@link resume}
 * / {@link topUp} in new skill code — they produce clearer call sites and
 * enforce the destructive-confirmation guard for top-up.
 *
 * For `'resume'` this is a pass-through to {@link executeResumeImpl}.
 * For `'top-up'` this still requires `confirmed: true` per the same guard
 * enforced in {@link topUp}.
 *
 * @param {string} agentId
 * @param {('resume'|'top-up')} action
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {boolean} [opts.confirmed] - Required when `action === 'top-up'`.
 * @param {number} [opts.newLimit] - Top-up only.
 * @param {string} [opts.timestamp]
 * @returns {Promise<ReturnType<typeof executeResumeImpl>>}
 */
export function executeAction(agentId, action, opts = {}) {
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
  const { confirmed, ...serviceOpts } = opts;
  return executeResumeImpl(agentId, action, serviceOpts);
}

// ---------------------------------------------------------------------------
// Pause — the inverse of resume. Sets `budget.paused = true` so the heartbeat
// skips the agent on the next tick. Non-destructive and idempotent: pausing
// an already-paused agent is a safe no-op. This is the skill-level "stop"
// button for an agent that should stay alive but should not run work until
// the user unpauses it.
// ---------------------------------------------------------------------------

/**
 * Pause (stop) an agent by setting the `budget.paused` flag.
 *
 * Non-destructive — the agent config file is unchanged except for the single
 * boolean flag and the `updatedAt` timestamp. Safe to call on an already
 * paused agent (idempotent — returns `wasPaused: true`).
 *
 * @param {object} params
 * @param {string} params.agentId - Agent to pause
 * @param {string} [params.dataDir] - Base data directory (defaults to `.aweek/agents`)
 * @returns {Promise<{
 *   agentId: string,
 *   action: 'pause',
 *   success: boolean,
 *   wasPaused: boolean,
 *   message: string,
 *   errors?: string[],
 * }>}
 */
export async function pause({ agentId, dataDir } = {}) {
  if (!agentId) {
    return {
      agentId,
      action: 'pause',
      success: false,
      errors: ['agentId is required'],
    };
  }

  const store = createAgentStore(dataDir);
  let wasPaused;
  try {
    const current = await store.load(agentId);
    wasPaused = current.budget?.paused === true;
    await store.update(agentId, (cfg) => {
      cfg.budget.paused = true;
      return cfg;
    });
  } catch (err) {
    return {
      agentId,
      action: 'pause',
      success: false,
      errors: [err.message || String(err)],
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

// editIdentity has been removed — identity data (name, role, systemPrompt)
// now lives in `.claude/agents/<slug>.md`, not the aweek JSON. To change
// identity, edit that file directly.


// ---------------------------------------------------------------------------
// Delete / archive — permanently remove an agent config file from disk.
//
// **Destructive** — there is no undo. Per project constraints, this adapter
// refuses to run without `confirmed: true`. The skill markdown is
// responsible for showing the user exactly what will be lost (name, role,
// goal / task counts, latest week) and gathering a second explicit
// confirmation.
// ---------------------------------------------------------------------------

/**
 * Permanently delete an agent's config file.
 *
 * **Destructive.** Pass `confirmed: true` only after collecting an
 * interactive confirmation from the user. Without the flag the adapter
 * returns `success: false` and leaves the file untouched.
 *
 * By default the matching Claude Code subagent file at
 * `.claude/agents/<agentId>.md` is **kept** — aweek only owns the JSON
 * scheduling state, while the subagent `.md` file is the identity source of
 * truth and may be shared with other tooling. Pass `deleteSubagentMd: true`
 * to also remove the project-level subagent file. The user-level
 * `~/.claude/agents/` path is NEVER touched.
 *
 * Missing `.md` files are reported (`subagentMd.existed: false`) rather than
 * treated as an error — deleting an aweek agent whose `.md` was already
 * removed is a legitimate cleanup path.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent to delete. Equals the subagent slug.
 * @param {string} [params.dataDir]
 * @param {boolean} params.confirmed - Must be `true`.
 * @param {boolean} [params.deleteSubagentMd=false] - Also delete
 *   `<subagentsDir>/<agentId>.md`. Default `false` (keep the `.md`).
 * @param {string} [params.subagentsDir] - Override the project-level
 *   subagents directory. Defaults to `<cwd>/.claude/agents`. Only used when
 *   `deleteSubagentMd` is `true`.
 * @returns {Promise<{
 *   agentId: string,
 *   action: 'delete',
 *   success: boolean,
 *   deleted?: boolean,
 *   snapshot?: object,
 *   subagentMd?: {
 *     requested: boolean,
 *     existed: boolean,
 *     deleted: boolean,
 *     path: string,
 *     error?: string,
 *   },
 *   errors?: string[],
 *   message?: string,
 * }>}
 */
export async function deleteAgent(params = {}) {
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

  // Capture a snapshot of the agent's identity before deleting so the
  // formatter can tell the user which agent was removed.
  let snapshot = null;
  try {
    snapshot = await loadAgent({ agentId, agentStore: store });
  } catch (err) {
    return {
      agentId,
      action: 'delete',
      success: false,
      errors: [err.message || String(err)],
    };
  }

  // Count weekly plans BEFORE deleting the agent JSON. Plans live in
  // `<baseDir>/<agentId>/weekly-plans/` per-week files; we only delete
  // the top-level JSON here so the per-week files might still exist,
  // but computing this first keeps the snapshot stable even if a future
  // change ever removes that subdirectory as part of the delete path.
  const weeklyPlanStore = new WeeklyPlanStore(resolveDataDir(dataDir));
  const weeklyPlanCount = await weeklyPlanStore
    .list(agentId)
    .then((ws) => ws.length)
    .catch(() => 0);

  try {
    await store.delete(agentId);
  } catch (err) {
    return {
      agentId,
      action: 'delete',
      success: false,
      errors: [err.message || String(err)],
    };
  }

  // Optionally also remove the project-level subagent .md file. This is
  // opt-in (defaults to keep) because the .md is the identity source of
  // truth and may be owned or edited outside of aweek.
  const resolvedSubagentsDir = subagentsDir || getDefaultSubagentsDir();
  const subagentMdPath = join(resolvedSubagentsDir, `${agentId}.md`);
  const subagentMd = {
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
        subagentMd.deleted = false;
        subagentMd.error = err.message || String(err);
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
 * See {@link validateResumeActionImpl} in `./resume-agent.js`.
 *
 * @param {Parameters<typeof validateResumeActionImpl>[0]} action
 * @param {Parameters<typeof validateResumeActionImpl>[1]} [options]
 * @returns {ReturnType<typeof validateResumeActionImpl>}
 */
export function validateAction(action, options) {
  return validateResumeActionImpl(action, options);
}

// ---------------------------------------------------------------------------
// Formatters — re-exported for the skill markdown to render output
// ---------------------------------------------------------------------------

/**
 * Format the paused-agents list for the skill's Step 1 output.
 * Alias of {@link formatPausedAgentsListImpl}.
 *
 * @param {Parameters<typeof formatPausedAgentsListImpl>[0]} listResult
 * @returns {string}
 */
export function formatPausedAgentsList(listResult) {
  return formatPausedAgentsListImpl(listResult);
}

/**
 * Format a single agent's budget detail view for Step 2 output.
 * Alias of {@link formatPausedAgentDetailsImpl}.
 *
 * @param {Parameters<typeof formatPausedAgentDetailsImpl>[0]} details
 * @returns {string}
 */
export function formatPausedAgentDetails(details) {
  return formatPausedAgentDetailsImpl(details);
}

/**
 * Format the post-action confirmation for Step 4 output.
 * Alias of {@link formatResumeResultImpl}.
 *
 * @param {Parameters<typeof formatResumeResultImpl>[0]} result
 * @returns {string}
 */
export function formatActionResult(result) {
  return formatResumeResultImpl(result);
}

/**
 * Format the result of a `pause()` call.
 *
 * @param {object} result
 * @returns {string}
 */
export function formatPauseResult(result) {
  if (!result) return '';
  if (!result.success) {
    return `Failed to pause agent "${result.agentId}": ${(result.errors || ['unknown error']).join('; ')}`;
  }
  const lines = ['=== Pause Result ==='];
  lines.push(result.message);
  lines.push('');
  lines.push('Use `/aweek:manage` → resume to unpause the agent.');
  return lines.join('\n');
}
/**
 * Format the result of a `deleteAgent()` call.
 *
 * @param {object} result
 * @returns {string}
 */
export function formatDeleteResult(result) {
  if (!result) return '';
  if (!result.success) {
    return `Failed to delete agent "${result.agentId}": ${(result.errors || ['unknown error']).join('; ')}`;
  }
  const lines = ['=== Agent Deleted ==='];
  lines.push(result.message);
  if (result.snapshot) {
    lines.push('');
    lines.push(
      `Removed: ${result.snapshot.name || '(unnamed)'} — role: ${result.snapshot.role || '(none)'}`,
    );
    lines.push(
      `Lost: ${result.snapshot.goalCount} goal(s), ${result.snapshot.weeklyPlanCount} weekly plan(s).`,
    );
  }
  // Subagent .md file status — explicit so the user can see whether the
  // identity file was kept (default) or also removed.
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

/** Truncate a string with ellipsis for side-by-side diff rendering. */
function truncate(value, max) {
  const str = String(value ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
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
