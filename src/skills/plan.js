/**
 * Plan skill logic — consolidated entry point for the `/aweek:plan` skill.
 *
 * The `/aweek:plan` skill (see `skills/aweek-plan.md`) is the consolidated
 * replacement for the old `/aweek:adjust-goal` and `/aweek:approve-plan`
 * skills. It covers two related workflows that both operate on an agent's
 * goals / monthly objectives / weekly tasks:
 *
 *   1. **Adjustments** — add / update / remove goals, monthly objectives,
 *      and weekly tasks at any time. Backed by
 *      `src/services/plan-adjustments.js`.
 *
 *   2. **Weekly plan approval** — review a newly generated weekly plan and
 *      approve / reject / edit it. The first approval activates the
 *      heartbeat system. Backed by `src/services/plan-approval.js`.
 *
 * This module exists to give the `/aweek:plan` skill markdown a single
 * import surface so it can pick the right operation based on the user's
 * interactive selection without reaching into two different service
 * modules. Every function here either re-exports the canonical
 * implementation verbatim or wraps it in a thin dispatch helper — the
 * real logic still lives in `src/services/plan-*.js` so there is exactly
 * one source of truth.
 *
 * Why a separate `plan.js` instead of importing the services directly?
 *   - It keeps the skill markdown import line short and stable.
 *   - The adapter is the obvious place to add skill-level concerns such
 *     as destructive-operation confirmation (see `reject`).
 *   - It matches the established aweek pattern used by
 *     `src/skills/hire.js` (thin adapter over the shared pipeline).
 *
 * Destructive operation safety:
 *   - `reject` deletes a pending weekly plan. Per project constraints
 *     every destructive skill operation must require explicit user
 *     confirmation before executing. `reject` enforces this by requiring
 *     `confirmed: true` — callers (the skill markdown) must collect an
 *     interactive confirmation from the user before passing it through.
 *     The underlying `plan-approval.reject` has no such guard, so the
 *     enforcement has to live at this adapter layer.
 */

import {
  // Adjustment pipeline (goals / monthly objectives / weekly tasks)
  adjustGoals,
  formatAdjustmentSummary,
  validateGoalAdjustment,
  validateMonthlyAdjustment,
  validateWeeklyAdjustment,
  applyGoalAdjustment,
  applyMonthlyAdjustment,
  applyWeeklyAdjustment,
} from '../services/plan-adjustments.js';

import {
  detectDayLayoutWithConfidence,
  layoutModeLabel,
} from '../services/day-layout-detector.js';

import {
  checkInterviewTriggers,
  generateSkipAssumptions,
  formatAssumptionsBlock,
  generateAssumptionForTrigger,
} from './plan-interview-triggers.js';

import { readPlan } from '../storage/plan-markdown-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { resolveDataDir } from '../storage/agent-helpers.js';

import {
  // Approval pipeline (approve / reject / edit of a pending weekly plan)
  APPROVAL_DECISIONS,
  findPendingPlan,
  formatPlanForReview,
  validateDecision,
  validateEdits,
  applyEdits,
  buildHeartbeatCommand,
  activateHeartbeat,
  processApproval,
  formatApprovalResult,
  loadPlanForReview,
  approve as approveImpl,
  reject as rejectImpl,
  edit as editImpl,
} from '../services/plan-approval.js';

// ---------------------------------------------------------------------------
// Adjustment entry points
//
// These are re-exported verbatim — the `/aweek:plan` skill calls them when
// the user selects the "adjust goals / monthly / weekly" branch.
// ---------------------------------------------------------------------------

/**
 * Apply a batch of weekly-task adjustments to an agent.
 *
 * Goals and monthly plans live in `.aweek/agents/<slug>/plan.md` — they are
 * no longer edited through this surface. Passing `goalAdjustments` or
 * `monthlyAdjustments` returns an error pointing the caller at the
 * markdown workflow instead of silently succeeding (or silently
 * dropping the user's edit).
 *
 * See {@link adjustGoals} in `src/services/plan-adjustments.js` for the
 * underlying weekly logic.
 *
 * @param {Parameters<typeof adjustGoals>[0]} params
 * @returns {ReturnType<typeof adjustGoals>}
 */
export function adjustPlan(params = {}) {
  const legacyGoals = Array.isArray(params.goalAdjustments) && params.goalAdjustments.length > 0;
  const legacyMonthly = Array.isArray(params.monthlyAdjustments) && params.monthlyAdjustments.length > 0;
  if (legacyGoals || legacyMonthly) {
    return Promise.resolve({
      success: false,
      errors: [
        'adjustPlan no longer accepts goalAdjustments / monthlyAdjustments. ' +
          'Long-term goals and monthly plans live in .aweek/agents/<slug>/plan.md now — ' +
          'edit the markdown through /aweek:plan Branch A (or `aweek exec plan-markdown write`).',
      ],
    });
  }
  return adjustGoals(params);
}

// ---------------------------------------------------------------------------
// Approval entry points
//
// The `approve`, `reject`, and `edit` wrappers are the preferred surface
// for the consolidated `/aweek:plan` skill — each call is decision-specific
// so the skill code reads naturally instead of threading a stringly-typed
// `decision` field through a single omnibus function.
// ---------------------------------------------------------------------------

/**
 * Approve an agent's pending weekly plan.
 *
 * Thin pass-through to {@link approveImpl}. Marks the plan as approved and
 * installs the heartbeat crontab entry on success. The first approval for
 * an agent activates the heartbeat system — the skill layer surfaces this
 * prominently via {@link formatApprovalResult}.
 *
 * Heartbeat installation itself is a system-modifying (crontab) operation,
 * but it is an intrinsic part of approval and is treated as non-fatal at
 * the service layer (approval succeeds even if crontab install fails).
 * Interactive confirmation of the approval itself happens in the skill
 * markdown — the user sees the formatted plan via {@link reviewPlan} and
 * explicitly picks "approve" before we land here.
 *
 * @param {Parameters<typeof approveImpl>[0]} params
 * @returns {ReturnType<typeof approveImpl>}
 */
export function approve(params) {
  return approveImpl(params);
}

/**
 * Reject an agent's pending weekly plan.
 *
 * **Destructive** — deletes the pending plan from the WeeklyPlanStore.
 * Per project constraints, destructive operations require explicit user
 * confirmation. This wrapper enforces that guard: the caller (the skill
 * markdown) must pass `confirmed: true` after collecting an interactive
 * confirmation from the user. Without it, the underlying service is
 * never invoked and the plan stays intact.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent whose plan to reject
 * @param {boolean} params.confirmed - Must be `true`. The skill markdown
 *   is responsible for gathering an explicit user confirmation before
 *   setting this flag.
 * @param {string} [params.rejectionReason] - Optional human-readable reason
 * @param {string} [params.dataDir] - Override data directory path
 * @returns {Promise<ReturnType<typeof rejectImpl>>}
 */
export function reject(params = {}) {
  if (!params || params.confirmed !== true) {
    return Promise.resolve({
      success: false,
      errors: [
        'Rejection requires explicit confirmation. Pass `confirmed: true` after the user confirms the destructive operation.',
      ],
    });
  }

  // Strip the skill-layer flag before handing off to the service — it has
  // no `confirmed` field and should stay that way to keep its surface
  // minimal.
  const { confirmed, ...serviceParams } = params;
  return rejectImpl(serviceParams);
}

/**
 * Edit an agent's pending weekly plan (add / remove / update tasks).
 *
 * Thin pass-through to {@link editImpl}. By default leaves the plan
 * pending so the user can review again; pass `autoApproveAfterEdit: true`
 * to approve and activate the heartbeat in one call (the skill only does
 * this after an explicit user selection).
 *
 * @param {Parameters<typeof editImpl>[0]} params
 * @returns {ReturnType<typeof editImpl>}
 */
export function edit(params) {
  return editImpl(params);
}

/**
 * Autonomously approve a freshly-generated weekly plan without user interaction.
 *
 * This is the **exclusive entry point** for the autonomous next-week planner
 * chain (weekly-review → next-week planner). Unlike the user-invoked `approve`
 * wrapper, this path:
 *
 *   1. Sets `approved: true` immediately — no `AskUserQuestion` is issued and no
 *      notification is dispatched to the user.
 *   2. Activates the heartbeat crontab entry (idempotent, non-fatal on failure),
 *      just as the interactive approval path does.
 *   3. Verifies no pending-approval state remains after the write by reloading
 *      the agent's weekly plans via `WeeklyPlanStore` and confirming that
 *      `findPendingPlan` returns null.
 *
 * The `noPendingPlanRemains` flag in the returned object is the formal
 * post-write verification contract. Callers should assert `noPendingPlanRemains
 * === true`; a `false` value means the persistence step did not complete
 * correctly even though `success` was `true`.
 *
 * **Do not call this from user-invoked flows.** The interactive `/aweek:plan`
 * skill must go through the `approve` wrapper (Branch C) so the human-in-the-
 * loop gate is preserved. `autoApprovePlan` is for the autonomous chain only.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent whose pending plan to auto-approve
 * @param {string} [params.dataDir] - Override data directory path
 * @param {string} [params.heartbeatSchedule='0 * * * *'] - Cron schedule
 * @param {string} [params.heartbeatCommand] - Override heartbeat command
 * @param {string} [params.projectDir] - Project root for heartbeat command
 * @param {Function} [params.installFn] - Override crontab install (for testing)
 * @returns {Promise<{
 *   success: boolean,
 *   plan?: object,
 *   isFirstApproval?: boolean,
 *   heartbeatActivated?: boolean,
 *   noPendingPlanRemains: boolean,
 *   errors?: string[],
 * }>}
 */
export async function autoApprovePlan(params = {}) {
  // Step 1: Approve immediately — no AskUserQuestion, no notification dispatch.
  // approveImpl is the same service called by the user-invoked `approve` wrapper;
  // the distinction is that no upstream AskUserQuestion interaction precedes this
  // call in the autonomous chain.
  const approvalResult = await approveImpl(params);
  if (!approvalResult.success) {
    return { ...approvalResult, noPendingPlanRemains: false };
  }

  // Step 2: Verify no pending-approval state remains after the write.
  // Reload the full plan list directly from WeeklyPlanStore and check with
  // findPendingPlan. A null result confirms the approved plan is no longer
  // in the pending set — meaning the write persisted correctly.
  const weeklyPlanStore = new WeeklyPlanStore(resolveDataDir(params.dataDir));
  let remainingPlans;
  try {
    remainingPlans = await weeklyPlanStore.loadAll(params.agentId);
  } catch {
    remainingPlans = [];
  }
  const noPendingPlanRemains = findPendingPlan(remainingPlans) === null;

  return {
    ...approvalResult,
    noPendingPlanRemains,
  };
}

// ---------------------------------------------------------------------------
// Plan review (helper for the interactive skill flow)
// ---------------------------------------------------------------------------

/**
 * Load an agent's pending weekly plan and return a human-readable summary
 * so the skill can show it to the user before asking for a decision.
 *
 * This is the first call the `/aweek:plan` skill makes in the approval
 * branch — the returned `formatted` string is printed verbatim, then the
 * user is prompted to pick approve / reject / edit.
 *
 * @param {Parameters<typeof loadPlanForReview>[0]} params
 * @returns {ReturnType<typeof loadPlanForReview>}
 */
export function reviewPlan(params) {
  return loadPlanForReview(params);
}

// ---------------------------------------------------------------------------
// Formatters — re-exported for the skill markdown
// ---------------------------------------------------------------------------

/**
 * Format the result of an adjustment batch for display.
 * Alias of {@link formatAdjustmentSummary}.
 *
 * @param {Parameters<typeof formatAdjustmentSummary>[0]} results
 * @returns {string}
 */
export function formatAdjustmentResult(results) {
  return formatAdjustmentSummary(results);
}

// ---------------------------------------------------------------------------
// Layout ambiguity detection
//
// Used by the `/aweek:plan` skill to decide whether to ask the user for an
// explicit layout preference before generating or distributing a weekly plan.
// ---------------------------------------------------------------------------

/**
 * Inspect an agent's `plan.md` and determine whether the day-layout mode
 * can be classified with confidence, or whether the plan contains
 * conflicting or absent structural signals that require the user to
 * explicitly state their scheduling preference via `AskUserQuestion`.
 *
 * When `confident` is `false`, the `/aweek:plan` skill should present the
 * user with the three layout choices (Theme Days / Priority Waterfall /
 * Mixed) before proceeding with weekly-plan generation or task distribution.
 *
 * Return shape:
 * ```
 * {
 *   mode:            'theme-days' | 'priority-waterfall' | 'mixed',
 *   confident:       boolean,
 *   ambiguityReason: 'conflicting-signals' | 'absent-signals' | null,
 *   themeScore:      number,
 *   priorityScore:   number,
 *   modeLabel:       string,  // human-readable label for the detected mode
 * }
 * ```
 *
 * Errors are never thrown for a missing `plan.md` — absent content is treated
 * as `ambiguityReason: 'absent-signals'` so the interview gate fires
 * correctly for brand-new agents.
 *
 * @param {object} params
 * @param {string} params.agentsDir - `.aweek/agents` root directory
 * @param {string} params.agentId   - Agent slug / identifier
 * @returns {Promise<{
 *   mode: string,
 *   confident: boolean,
 *   ambiguityReason: string | null,
 *   themeScore: number,
 *   priorityScore: number,
 *   modeLabel: string,
 * }>}
 */
export async function detectLayoutAmbiguity({ agentsDir, agentId } = {}) {
  let planBody = null;
  try {
    planBody = await readPlan(agentsDir, agentId);
  } catch {
    // plan.md is absent or the directory does not exist yet.
    // detectDayLayoutWithConfidence handles null gracefully by returning
    // { mode: 'mixed', confident: false, ambiguityReason: 'absent-signals' }.
  }

  const result = detectDayLayoutWithConfidence(planBody);
  return {
    ...result,
    modeLabel: layoutModeLabel(result.mode),
  };
}

// ---------------------------------------------------------------------------
// Re-exports
//
// The `/aweek:plan` skill markdown imports everything it needs from this
// one module. The underlying implementations still live in the shared
// services — this file is intentionally a thin composition layer.
// ---------------------------------------------------------------------------
export {
  // Interview trigger detection
  checkInterviewTriggers,
  // Skip-questions escape hatch
  generateSkipAssumptions,
  formatAssumptionsBlock,
  generateAssumptionForTrigger,
  // Adjustment pipeline
  adjustGoals,
  formatAdjustmentSummary,
  validateGoalAdjustment,
  validateMonthlyAdjustment,
  validateWeeklyAdjustment,
  applyGoalAdjustment,
  applyMonthlyAdjustment,
  applyWeeklyAdjustment,
  // Approval pipeline
  APPROVAL_DECISIONS,
  findPendingPlan,
  formatPlanForReview,
  validateDecision,
  validateEdits,
  applyEdits,
  buildHeartbeatCommand,
  activateHeartbeat,
  processApproval,
  formatApprovalResult,
  loadPlanForReview,
};
