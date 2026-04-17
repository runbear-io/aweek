/**
 * Adjust-goal skill logic — thin adapter over the shared plan-adjustment service.
 *
 * The reusable goal/monthly/weekly adjustment logic lives in
 * `src/services/plan-adjustments.js`. This module exists to preserve the
 * existing `/aweek:adjust-goal` skill entry point and its public API while
 * the consolidated `/aweek:plan` skill is being introduced (which also
 * imports from the shared service).
 *
 * Keeping this file as a re-export shim means:
 *   - The existing test suite (`adjust-goal.test.js`) keeps passing unchanged.
 *   - `src/index.js` continues to re-export the same identifiers.
 *   - The new `/aweek:plan` skill has a single source of truth to import
 *     from (`../services/plan-adjustments.js`) without going through this
 *     legacy shim.
 */
export {
  validateGoalAdjustment,
  validateMonthlyAdjustment,
  validateWeeklyAdjustment,
  applyGoalAdjustment,
  applyMonthlyAdjustment,
  applyWeeklyAdjustment,
  adjustGoals,
  formatAdjustmentSummary,
} from '../services/plan-adjustments.js';
