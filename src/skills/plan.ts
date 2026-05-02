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
 * modules.
 *
 * Destructive operation safety:
 *   - `reject` deletes a pending weekly plan. Per project constraints
 *     every destructive skill operation must require explicit user
 *     confirmation before executing. `reject` enforces this by requiring
 *     `confirmed: true`.
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
import type { AdjustGoalsParams, AdjustGoalsResult } from '../services/plan-adjustments.js';

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
  processApproval,
  formatApprovalResult,
  loadPlanForReview,
  approve as approveImpl,
  reject as rejectImpl,
  edit as editImpl,
} from '../services/plan-approval.js';
import type {
  ProcessApprovalParams,
  ProcessApprovalResult,
  LoadPlanForReviewParams,
  LoadPlanForReviewResult,
} from '../services/plan-approval.js';

// ---------------------------------------------------------------------------
// Adjustment entry points
// ---------------------------------------------------------------------------

/** Extra fields {@link adjustPlan} rejects to redirect callers at plan.md. */
export interface AdjustPlanParams extends AdjustGoalsParams {
  goalAdjustments?: unknown[];
  monthlyAdjustments?: unknown[];
}

/**
 * Apply a batch of weekly-task adjustments to an agent.
 *
 * Goals and monthly plans live in `.aweek/agents/<slug>/plan.md` — they are
 * no longer edited through this surface.
 */
export async function adjustPlan(params: AdjustPlanParams = {} as AdjustPlanParams): Promise<AdjustGoalsResult> {
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
    } as AdjustGoalsResult);
  }
  return adjustGoals(params);
}

// ---------------------------------------------------------------------------
// Approval entry points
// ---------------------------------------------------------------------------

/**
 * Approve an agent's pending weekly plan.
 */
export function approve(
  params?: Omit<ProcessApprovalParams, 'decision'>,
): Promise<ProcessApprovalResult> {
  return approveImpl(params);
}

/** Params for {@link reject}. */
export interface RejectParams extends Omit<ProcessApprovalParams, 'decision'> {
  confirmed?: boolean;
  rejectionReason?: string;
}

/**
 * Reject an agent's pending weekly plan.
 *
 * **Destructive** — requires `confirmed: true`.
 */
export function reject(params: RejectParams = {} as RejectParams): Promise<ProcessApprovalResult> {
  if (!params || params.confirmed !== true) {
    return Promise.resolve({
      success: false,
      errors: [
        'Rejection requires explicit confirmation. Pass `confirmed: true` after the user confirms the destructive operation.',
      ],
    } as ProcessApprovalResult);
  }

  // Strip the skill-layer flag before handing off to the service.
  const { confirmed: _confirmed, ...serviceParams } = params;
  void _confirmed;
  return rejectImpl(serviceParams);
}

/**
 * Edit an agent's pending weekly plan (add / remove / update tasks).
 */
export function edit(
  params?: Omit<ProcessApprovalParams, 'decision'>,
): Promise<ProcessApprovalResult> {
  return editImpl(params);
}

/** Result of {@link autoApprovePlan}. */
export interface AutoApprovePlanResult extends ProcessApprovalResult {
  noPendingPlanRemains: boolean;
}

/**
 * Autonomously approve a freshly-generated weekly plan without user interaction.
 *
 * **Do not call this from user-invoked flows.** This is for the autonomous
 * next-week planner chain only.
 */
export async function autoApprovePlan(
  params: Omit<ProcessApprovalParams, 'decision'> = {} as Omit<ProcessApprovalParams, 'decision'>,
): Promise<AutoApprovePlanResult> {
  // Step 1: Approve immediately — no AskUserQuestion, no notification dispatch.
  const approvalResult = await approveImpl(params);
  if (!approvalResult.success) {
    return { ...approvalResult, noPendingPlanRemains: false };
  }

  // Step 2: Verify no pending-approval state remains after the write.
  const weeklyPlanStore = new WeeklyPlanStore(resolveDataDir((params as { dataDir?: string }).dataDir));
  let remainingPlans: Awaited<ReturnType<typeof weeklyPlanStore.loadAll>> = [];
  try {
    remainingPlans = await weeklyPlanStore.loadAll((params as { agentId: string }).agentId);
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
 */
export function reviewPlan(params: LoadPlanForReviewParams): Promise<LoadPlanForReviewResult> {
  return loadPlanForReview(params);
}

// ---------------------------------------------------------------------------
// Formatters — re-exported for the skill markdown
// ---------------------------------------------------------------------------

/**
 * Format the result of an adjustment batch for display.
 */
export function formatAdjustmentResult(results: Parameters<typeof formatAdjustmentSummary>[0]): string {
  return formatAdjustmentSummary(results);
}

// ---------------------------------------------------------------------------
// Layout ambiguity detection
// ---------------------------------------------------------------------------

/** Result of {@link detectLayoutAmbiguity}. */
export interface DetectLayoutAmbiguityResult {
  mode: string;
  confident: boolean;
  ambiguityReason: string | null;
  themeScore: number;
  priorityScore: number;
  modeLabel: string;
}

/**
 * Inspect an agent's `plan.md` and determine whether the day-layout mode
 * can be classified with confidence, or whether the plan contains
 * conflicting or absent structural signals that require the user to
 * explicitly state their scheduling preference via `AskUserQuestion`.
 */
export async function detectLayoutAmbiguity(
  { agentsDir, agentId }: { agentsDir?: string; agentId?: string } = {},
): Promise<DetectLayoutAmbiguityResult> {
  let planBody: string | null = null;
  try {
    if (agentsDir && agentId) {
      planBody = await readPlan(agentsDir, agentId);
    }
  } catch {
    // plan.md is absent or the directory does not exist yet.
  }

  const result = detectDayLayoutWithConfidence(planBody);
  return {
    ...result,
    modeLabel: layoutModeLabel(result.mode),
  };
}

// ---------------------------------------------------------------------------
// Re-exports
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
  processApproval,
  formatApprovalResult,
  loadPlanForReview,
};
