/**
 * Barrel exports for the aweek SPA pages.
 *
 * Each page is a React component that owns its own data lifecycle via
 * the sibling `../hooks/*` modules. Pages never consume SSR-injected
 * globals (`window.__INITIAL_DATA__`, `window.__aweek`, …) and never
 * accept pre-resolved domain payloads via props — the component's
 * contract is "give me a slug, I'll fetch". This is the Sub-AC 3.3
 * invariant enforced by `./pages.contract.test.js`.
 *
 * Page → hook map:
 *
 *   AgentsPage         → useAgents
 *   AgentDetailPage    → useAgentProfile(slug)  (shell; embeds hook-driven tabs)
 *   AgentProfilePage   → useAgentProfile(slug)
 *   AgentPlanPage      → useAgentPlan(slug)
 *   AgentCalendarPage  → useAgentCalendar(slug, { week })
 *   AgentUsagePage     → useAgentUsage(slug)
 *   AgentActivityPage  → useAgentLogs(slug, { dateRange })
 *
 * @module serve/spa/pages
 */

export { AgentsPage } from './agents-page.jsx';
export {
  AgentDetailPage,
  AGENT_DETAIL_TABS,
  DEFAULT_AGENT_DETAIL_TAB,
  normaliseTab,
} from './agent-detail-page.jsx';
export { AgentProfilePage } from './agent-profile-page.jsx';
export { AgentPlanPage } from './agent-plan-page.jsx';
export { AgentCalendarPage } from './agent-calendar-page.jsx';
export { AgentUsagePage } from './agent-usage-page.jsx';
export { AgentActivityPage } from './agent-activity-page.jsx';
export { AgentExecutionLogPage } from './agent-execution-log-page.jsx';
