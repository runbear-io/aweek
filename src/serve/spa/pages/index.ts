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

// SPA pages converted to TypeScript per AC 101 (agents), AC 102 (detail
// shell), and AC 103 (per-tab pages: calendar, activity, strategy, profile).
// `agent-usage-page` stays `.jsx` for now — it isn't reachable from the
// current router and is slated for removal once the Profile tab fully
// supersedes it. Vite + Vitest both resolve the .tsx extension natively.
export { AgentsPage } from './agents-page.tsx';
export {
  AgentDetailPage,
  AGENT_DETAIL_TABS,
  DEFAULT_AGENT_DETAIL_TAB,
  normaliseTab,
} from './agent-detail-page.tsx';
export { AgentProfilePage } from './agent-profile-page.tsx';
export { AgentPlanPage } from './agent-plan-page.tsx';
export { AgentCalendarPage } from './agent-calendar-page.tsx';
export { AgentUsagePage } from './agent-usage-page.jsx';
export { AgentActivityPage } from './agent-activity-page.tsx';
export { AgentReviewsPage } from './agent-reviews-page.tsx';
export { AgentArtifactsPage } from './agent-artifacts-page.tsx';
export { SettingsPage } from './settings-page.tsx';
