/**
 * React data hooks for the aweek SPA dashboard.
 *
 * Each hook wraps a read-only api-client fetcher in a `useApiResource`
 * state machine that tracks `{ data, error, loading, refresh }` and
 * cancels in-flight requests on unmount or when inputs change.
 *
 * Importable as either named imports from the barrel…
 *
 *   import { useAgents, useAgentProfile } from './hooks';
 *
 * …or directly from the per-hook module:
 *
 *   import { useAgents } from './hooks/use-agents.js';
 *
 * Resource → hook map:
 *
 *   GET /api/agents              → useAgents
 *   GET /api/agents/:slug        → useAgentProfile(slug)
 *   GET /api/agents/:slug/plan     → useAgentPlan(slug)
 *   GET /api/agents/:slug/calendar → useAgentCalendar(slug, { week })
 *   GET /api/agents/:slug/usage    → useAgentUsage(slug)
 *   GET /api/agents/:slug/logs     → useAgentLogs(slug, { dateRange })
 *
 * The base hook `useApiResource` and the underlying React-free
 * `createResourceController` are also re-exported so advanced
 * components / tests can compose the building blocks directly.
 *
 * TypeScript migration note (AC 305 sub-AC 4.5):
 *   The barrel itself is now `.ts`. Re-exports use the `.js` specifier
 *   suffix so Bundler resolution (Vite + tsc) can pick up either the
 *   converted `.ts` source or the raw `.js` source for `resource-controller`
 *   transparently. The state-machine in `resource-controller.js` stays
 *   raw `.js` because its `node:test` suite imports it by on-disk path.
 *
 * @module serve/spa/hooks
 */

export {
  useApiResource,
  type UseApiResourceResult,
  type ApiResourceLoader,
} from './use-api-resource.js';
export { createResourceController } from './resource-controller.js';

export { useAgents, type AgentsListData, type AgentsListIssue, type UseAgentsOptions } from './use-agents.js';
export {
  useAgentProfile,
  type UseAgentProfileOptions,
} from './use-agent-profile.js';
export {
  useAgentPlan,
  type UseAgentPlanOptions,
} from './use-agent-plan.js';
export {
  useAgentCalendar,
  type UseAgentCalendarOptions,
} from './use-agent-calendar.js';
export {
  useAgentUsage,
  type UseAgentUsageOptions,
} from './use-agent-usage.js';
export {
  useAgentLogs,
  type UseAgentLogsOptions,
  type AgentLogsTyped,
  type ActivityLogEntry,
  type ExecutionRecord,
} from './use-agent-logs.js';
export {
  useAgentReviews,
  type UseAgentReviewsOptions,
  type AgentReviews,
} from './use-agent-reviews.js';
export {
  useGlobalNotifications,
  type UseGlobalNotificationsOptions,
  type GlobalNotificationsData,
  type GlobalNotificationRow,
} from './use-global-notifications.js';
export {
  useAgentArtifacts,
  groupArtifactsByWeek,
  resolveArtifactWeekKey,
  ARTIFACT_UNKNOWN_WEEK,
  type UseAgentArtifactsOptions,
  type UseAgentArtifactsResult,
  type AgentArtifacts,
  type ArtifactRecord,
  type ArtifactSummary,
  type ArtifactWeekGroup,
} from './use-agent-artifacts.js';
