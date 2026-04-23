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
 * @module serve/spa/hooks
 */

export { useApiResource } from './use-api-resource.js';
export { createResourceController } from './resource-controller.js';

export { useAgents } from './use-agents.js';
export { useAgentProfile } from './use-agent-profile.js';
export { useAgentPlan } from './use-agent-plan.js';
export { useAgentCalendar } from './use-agent-calendar.js';
export { useAgentUsage } from './use-agent-usage.js';
export { useAgentLogs } from './use-agent-logs.js';
