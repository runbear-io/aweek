/**
 * `AgentDetailPage` — per-agent detail shell (AC 2, Sub-AC 1).
 *
 * The detail page is the landing surface for a single agent. It owns
 * the top-level identity header and the tab navigation scaffolding for
 * the four per-agent tabs defined by AC 2:
 *
 *   Calendar | Activity | Strategy | Profile
 *
 * Tab bodies are wired to the existing hook-driven pages:
 *   - Calendar  → <AgentCalendarPage slug=… />   (hook: useAgentCalendar)
 *   - Activity  → <AgentActivityPage slug=… />   (hook: useAgentLogs)
 *   - Strategy  → <AgentPlanPage slug=… />       (hook: useAgentPlan)
 *   - Profile   → <AgentProfilePage slug=… />    (hook: useAgentProfile)
 *
 * Data contract (Sub-AC 3.3):
 *   The shell's identity header is sourced _exclusively_ from
 *   `useAgentProfile(slug)`. No `props.profile`, no
 *   `window.__INITIAL_DATA__`, no SSR HTML reading. Props exist only
 *   for orchestration / test injection. Embedded child pages each own
 *   their own hook — the shell does not thread domain data into them.
 *
 * Routing:
 *   The component is slug-addressable via the `slug` prop. Parent
 *   routers should map `/agents/:slug` and `/agents/:slug/:tab` to this
 *   component, threading the tab segment through `initialTab`. Tab
 *   changes are surfaced via `onTabChange(tab)` so the parent can push
 *   the URL without this component taking a router dependency.
 *
 * Baseline parity:
 *   The identity header mirrors the terminal `src/skills/status.js`
 *   per-agent block: agent name, slug, status tone (active / paused /
 *   budget-exhausted / subagent-missing), and a missing-subagent marker
 *   when `.claude/agents/<slug>.md` is absent. The tab row mirrors the
 *   terminal dashboard tabs (Calendar / Activity / Strategy / Profile).
 *
 * @module serve/spa/pages/agent-detail-page
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../components/ui/breadcrumb.jsx';
import { Button } from '../components/ui/button.jsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.jsx';
import {
  Tabs,
  TabsContent,
} from '../components/ui/tabs.jsx';
import { cn } from '../lib/cn.js';
import { useAgentProfile } from '../hooks/use-agent-profile.js';

import { AgentActivityPage } from './agent-activity-page.jsx';
import { AgentCalendarPage } from './agent-calendar-page.jsx';
import { AgentPlanPage } from './agent-plan-page.jsx';
import { AgentProfilePage } from './agent-profile-page.jsx';

/**
 * @typedef {import('../lib/api-client.js').AgentProfile} AgentProfile
 * @typedef {'calendar' | 'activities' | 'strategy' | 'profile'} AgentTabValue
 */

/**
 * Fixed tab order — matches the Calendar/Activity/Strategy/Profile row
 * specified by AC 2. Exported so the parent router (and the component
 * tests) can iterate without copy-pasting literals.
 *
 * @type {ReadonlyArray<{ value: AgentTabValue, label: string }>}
 */
export const AGENT_DETAIL_TABS = Object.freeze([
  { value: 'calendar', label: 'Calendar' },
  { value: 'activities', label: 'Activity' },
  { value: 'strategy', label: 'Strategy' },
  { value: 'profile', label: 'Profile' },
]);

/** Default tab when `initialTab` is omitted — Calendar per AC 2 row order. */
export const DEFAULT_AGENT_DETAIL_TAB = 'calendar';

const VALID_TABS = new Set(AGENT_DETAIL_TABS.map((t) => t.value));

/**
 * Normalise an `initialTab` prop to a safe tab value. Unknown values
 * fall back to the default so a malformed URL can never wedge the page
 * into a non-rendering state.
 *
 * @param {string | undefined | null} raw
 * @returns {AgentTabValue}
 */
export function normaliseTab(raw) {
  return VALID_TABS.has(raw) ? /** @type {AgentTabValue} */ (raw) : DEFAULT_AGENT_DETAIL_TAB;
}

/**
 * Agent Detail page shell. Renders the identity header + tab nav and
 * routes the active tab to its corresponding hook-driven child page.
 *
 * @param {{
 *   slug: string,
 *   initialTab?: AgentTabValue,
 *   onTabChange?: (tab: AgentTabValue) => void,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 * @returns {JSX.Element}
 */
export function AgentDetailPage({
  slug,
  initialTab,
  onTabChange,
  baseUrl,
  fetch: fetchImpl,
  activitySelection,
  onActivityOpen,
  onActivityClose,
  calendarSelection,
  onCalendarOpen,
  onCalendarClose,
}) {
  const [activeTab, setActiveTab] = useState(() => normaliseTab(initialTab));

  // Re-sync when the parent pushes a new `initialTab` (e.g. router
  // segment change). We intentionally re-key on the literal so an
  // unchanged value does not re-run the effect.
  useEffect(() => {
    if (initialTab && VALID_TABS.has(initialTab) && initialTab !== activeTab) {
      setActiveTab(initialTab);
    }
    // activeTab is intentionally excluded — we only want to react to
    // external `initialTab` pushes, not our own state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  const handleTabChange = (next) => {
    setActiveTab(next);
    if (typeof onTabChange === 'function') onTabChange(next);
  };

  const { data, error, loading, refresh } = useAgentProfile(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  if (!slug) {
    return (
      <DetailEmpty message="Select an agent to view details." />
    );
  }
  if (loading && !data) {
    return <DetailSkeleton slug={slug} />;
  }
  if (error && error.status === 404) {
    return <DetailEmpty message={`No agent found for slug "${slug}".`} />;
  }
  if (error && !data) {
    return <DetailError error={error} onRetry={refresh} slug={slug} />;
  }

  const profile = /** @type {AgentProfile} */ (data || { slug, name: slug });
  const activeTabLabel =
    AGENT_DETAIL_TABS.find((t) => t.value === activeTab)?.label ?? activeTab;

  // The Calendar tab uses an internal flex-1 chain so its grid fills
  // viewport height and owns its own scroll; every other tab flows
  // naturally and keeps document-level scroll behaviour. We pick the
  // matching className for the active TabsContent so we never have to
  // force a flex layout on tabs that don't want one.
  const isCalendar = activeTab === 'calendar';
  return (
    <section
      // `flex-1 min-h-0` lets the calendar tab plumb a flex chain down to
      // its internal CalendarGrid. Non-calendar tabs are unaffected — their
      // children flow at content height inside this section.
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-page="agent-detail"
      data-agent-slug={slug}
      data-active-tab={activeTab}
    >
      <DetailBreadcrumb
        slug={slug}
        tab={activeTab}
        tabLabel={activeTabLabel}
      />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}

      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className={cn('flex flex-col gap-4', isCalendar && 'min-h-0 flex-1')}
      >
        <TabsContent
          value="calendar"
          className={cn('mt-2', isCalendar && 'flex min-h-0 flex-1 flex-col')}
        >
          <AgentCalendarPage
            slug={slug}
            baseUrl={baseUrl}
            fetch={fetchImpl}
            selectedTaskId={calendarSelection}
            onOpenTaskId={onCalendarOpen}
            onCloseTaskId={onCalendarClose}
          />
        </TabsContent>
        <TabsContent value="activities">
          <AgentActivityPage
            slug={slug}
            baseUrl={baseUrl}
            fetch={fetchImpl}
            selectedBasename={activitySelection}
            onOpenBasename={onActivityOpen}
            onCloseBasename={onActivityClose}
          />
        </TabsContent>
        <TabsContent value="strategy">
          <AgentPlanPage slug={slug} baseUrl={baseUrl} fetch={fetchImpl} />
        </TabsContent>
        <TabsContent value="profile">
          <AgentProfilePage slug={slug} baseUrl={baseUrl} fetch={fetchImpl} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

export default AgentDetailPage;

// ── Breadcrumb ───────────────────────────────────────────────────────

/**
 * Breadcrumb trail rendered above the detail header. Surfaces the
 * three-segment path `Agents → :slug → :tab` per AC 3. The root and
 * slug segments are navigable via react-router `<Link>`; the active
 * tab is rendered as `BreadcrumbPage` so assistive tech announces it
 * as the user's current position.
 *
 * @param {{ slug: string, tab: AgentTabValue, tabLabel: string }} props
 */
function DetailBreadcrumb({ slug, tab, tabLabel }) {
  return (
    <Breadcrumb data-agent-detail-breadcrumb="true">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/agents">Agents</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to={`/agents/${slug}`}>{slug}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage data-active-tab={tab}>{tabLabel}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

// ── Empty / loading / error ──────────────────────────────────────────

function DetailEmpty({ message }) {
  return (
    <Card
      className="border-dashed"
      data-page="agent-detail"
      data-state="empty"
    >
      <CardContent className="p-8 text-center text-sm italic text-muted-foreground">
        {message}
      </CardContent>
    </Card>
  );
}

function DetailSkeleton({ slug }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-pulse text-sm text-muted-foreground"
      data-page="agent-detail"
      data-loading="true"
      data-agent-slug={slug}
    >
      Loading agent…
    </div>
  );
}

function DetailError({ error, onRetry, slug }) {
  // Destructive-token Card communicates failure in the same chrome family
  // as the healthy detail surface (rather than a bespoke div). Mirrors the
  // Overview page's `AgentsPageError` so both alerts re-theme cleanly via
  // the `--destructive` token in light + dark modes.
  return (
    <Card
      role="alert"
      data-page="agent-detail"
      data-error="true"
      data-agent-slug={slug}
      className="border-destructive/40 bg-destructive/10 text-destructive"
    >
      <CardHeader className="space-y-1">
        <CardTitle as="h2" className="text-sm text-destructive">
          Failed to load agent.
        </CardTitle>
        <CardDescription className="text-xs text-destructive/80">
          {error?.message || String(error)}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }) {
  // Neutral muted chrome for the "stale" callout — the stock shadcn
  // palette does not expose a warning token, so we use the muted surface
  // to signal "advisory, not destructive" (parity with `agents-page.jsx`).
  return (
    <Card role="alert" className="bg-muted text-muted-foreground">
      <CardContent className="flex items-center gap-2 p-2.5 text-xs">
        <span>
          Refresh failed ({error?.message || 'unknown error'}) — showing last-known
          data.
        </span>
        <Button
          variant="link"
          size="sm"
          onClick={onRetry}
          className="h-auto p-0 text-xs"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
