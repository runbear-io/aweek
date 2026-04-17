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
 * Apply a batch of goal / monthly / weekly adjustments to an agent.
 * See {@link adjustGoals} in `src/services/plan-adjustments.js`.
 *
 * @param {Parameters<typeof adjustGoals>[0]} params
 * @returns {ReturnType<typeof adjustGoals>}
 */
export function adjustPlan(params) {
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
 * **Destructive** — removes the plan from the agent's `weeklyPlans` array.
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
// Re-exports
//
// The `/aweek:plan` skill markdown imports everything it needs from this
// one module. The underlying implementations still live in the shared
// services — this file is intentionally a thin composition layer.
// ---------------------------------------------------------------------------
export {
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
