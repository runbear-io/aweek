/**
 * Plan skill logic — consolidated entry point for the `/aweek:plan` skill.
 *
 * The `/aweek:plan` skill (see `skills/plan/SKILL.md`) covers two related
 * workflows that both operate on an agent's goals / monthly objectives /
 * weekly tasks:
 *
 *   1. **Adjustments** — add / update / remove goals, monthly objectives,
 *      and weekly tasks at any time. Backed by
 *      `src/services/plan-adjustments.ts`.
 *
 *   2. **Plan markdown editing** — read / write the agent's free-form
 *      `plan.md` body via the plan-markdown store.
 *
 * Plans no longer carry a human-in-the-loop approval gate — every weekly
 * plan is implicitly active the moment it lands on disk. The pending /
 * approve / reject / edit branch that used to live here has been removed
 * along with `src/services/plan-approval.ts`.
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
};
