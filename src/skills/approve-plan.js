/**
 * Approve-plan skill logic — thin adapter over the shared plan-approval service.
 *
 * The reusable approval/rejection/edit logic now lives in
 * `src/services/plan-approval.js`. This module exists to preserve the
 * existing `/aweek:approve-plan` skill entry point and its public API while
 * the consolidated `/aweek:plan` skill is being introduced (which imports
 * `approve`, `reject`, and `edit` directly from the shared service).
 *
 * Keeping this file as a re-export shim means:
 *   - The existing test suite (`approve-plan.test.js` and
 *     `approve-plan-heartbeat.integration.test.js`) keeps passing unchanged.
 *   - `src/index.js` continues to re-export the same identifiers from the
 *     same path.
 *   - The new `/aweek:plan` skill has a single source of truth to import
 *     from (`../services/plan-approval.js`) without going through this
 *     legacy shim.
 */
export {
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
  // Decision-specific convenience wrappers — the preferred entry points for
  // the consolidated `/aweek:plan` skill. Re-exported here so legacy callers
  // (or anything importing from this path) can opt into the new API without
  // reaching into `../services/plan-approval.js` directly.
  approve,
  reject,
  edit,
} from '../services/plan-approval.js';
