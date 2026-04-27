/**
 * Read-only data layer for the aweek SPA dashboard.
 *
 * This barrel is the single entry point that the Vite-built SPA server
 * uses to produce JSON endpoint payloads. Every gatherer below sources
 * exclusively from existing `src/storage/*` stores (plus the
 * `readSubagentIdentity` primitive for `.claude/agents/<slug>.md` and
 * the pure time helpers in `src/time/zone.js`) — the data layer
 * introduces NO new persistence.
 *
 * Acceptance criterion #9 guarantees:
 *   - No writes from this module tree.
 *   - No caching or mirror state on disk.
 *   - All reads flow through the existing store classes / functions so
 *     the SPA, CLI skills, and heartbeat stay on a single view of data.
 *
 * The companion test (`src/serve/data/data.test.js`) asserts the above
 * invariants by grepping the module tree for any filesystem write API.
 *
 * Gatherer map (SPA view → exported function):
 *   /api/agents                    → gatherAgentsList
 *   /api/agents/:slug/profile      → gatherAgentProfile
 *   /api/agents/:slug/plan         → gatherAgentPlan
 *   /api/agents/:slug/calendar     → gatherAgentCalendar
 *   /api/agents/:slug/activity     → gatherAgentActivity
 *   /api/agents/:slug/usage        → gatherAgentUsage
 *   /api/agents/:slug/tasks/activity → gatherTaskActivity (used internally)
 *   /api/agents/:slug/logs         → gatherAgentLogs
 *   /api/budget                    → gatherBudgetList
 *   /api/executions/:slug/:basename (NDJSON stream) → streamExecutionLogLines
 */

export {
  deriveAgentStatus,
  gatherAgentProfile,
  gatherAgentsList,
} from './agents.js';

export { deriveBudget, gatherAgentUsage, gatherBudgetList } from './budget.js';

export { gatherAgentPlan } from './plan.js';

export {
  computeTaskSlot,
  gatherAgentCalendar,
  gatherTaskActivity,
} from './calendar.js';

export {
  DATE_RANGE_PRESETS,
  DEFAULT_DATE_RANGE,
  computeDateRangeBounds,
  gatherAgentActivity,
  resolveDateRange,
} from './activity.js';

export {
  isSafePathSegment,
  parseExecutionBasename,
  streamExecutionLogLines,
} from './execution-log.js';

export { gatherAgentLogs } from './logs.js';

export { gatherAgentReviews } from './reviews.js';

export { gatherAllNotifications } from './notifications.js';

export { gatherAgentNotifications } from './agent-notifications.js';
