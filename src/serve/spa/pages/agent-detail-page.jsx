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

import { Badge } from '../components/ui/badge.jsx';
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
  TabsList,
  TabsTrigger,
} from '../components/ui/tabs.jsx';
import { cn } from '../lib/cn.js';
import { useAgentProfile } from '../hooks/use-agent-profile.js';

import { AgentActivityPage } from './agent-activity-page.jsx';
import { AgentCalendarPage } from './agent-calendar-page.jsx';
import { AgentPlanPage } from './agent-plan-page.jsx';
import { AgentProfilePage } from './agent-profile-page.jsx';

/**
 * @typedef {import('../lib/api-client.js').AgentProfile} AgentProfile
 * @typedef {'calendar' | 'activity' | 'strategy' | 'profile'} AgentTabValue
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
  { value: 'activity', label: 'Activity' },
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
 *   onBack?: () => void,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 * @returns {JSX.Element}
 */
export function AgentDetailPage({
  slug,
  initialTab,
  onTabChange,
  onBack,
  baseUrl,
  fetch: fetchImpl,
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

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-detail"
      data-agent-slug={slug}
      data-active-tab={activeTab}
    >
      <DetailHeader
        profile={profile}
        loading={loading}
        onRefresh={refresh}
        onBack={onBack}
      />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList aria-label={`${profile.name || slug} tabs`}>
          {AGENT_DETAIL_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="calendar">
          <AgentCalendarPage
            slug={slug}
            baseUrl={baseUrl}
            fetch={fetchImpl}
          />
        </TabsContent>
        <TabsContent value="activity">
          <AgentActivityPage
            slug={slug}
            baseUrl={baseUrl}
            fetch={fetchImpl}
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

// ── Header ───────────────────────────────────────────────────────────

/**
 * Top identity + status strip rendered above the tab row. Kept thin —
 * each embedded child page carries its own refresh button for its
 * specific resource; this one refreshes the profile so the header
 * status badge stays in sync.
 *
 * @param {{
 *   profile: AgentProfile,
 *   loading: boolean,
 *   onRefresh: () => void,
 *   onBack?: () => void,
 * }} props
 */
function DetailHeader({ profile, loading, onRefresh, onBack }) {
  const tone = resolveStatusTone(profile);
  const label = resolveStatusLabel(profile);
  return (
    <header
      className="flex flex-col gap-2 border-b border-slate-800 pb-3"
      data-agent-detail-header="true"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {typeof onBack === 'function' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onBack}
              aria-label="Back to agent list"
            >
              ← Agents
            </Button>
          ) : null}
          <div className="flex flex-col">
            <h1 className="text-base font-semibold tracking-tight text-slate-100">
              {profile.name || profile.slug}
              {profile.missing ? (
                <Badge variant="destructive" className="ml-2">
                  subagent missing
                </Badge>
              ) : null}
            </h1>
            <p className="text-xs text-slate-400">
              <code className="rounded bg-slate-900 px-1.5 py-0.5 text-[11px] text-slate-300">
                {profile.slug}
              </code>
              {profile.description ? (
                <span className="ml-2 truncate">· {profile.description}</span>
              ) : null}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge label={label} tone={tone} />
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>
    </header>
  );
}

function StatusBadge({ label, tone }) {
  // Derive a shadcn Badge variant from the legacy tone class string so the
  // active / paused / over-budget / missing palettes stay consistent.
  const variant = tone?.includes('emerald')
    ? 'success'
    : tone?.includes('amber')
      ? 'warning'
      : 'destructive';
  return (
    <Badge
      data-agent-status={label}
      variant={variant}
      className={cn('tracking-widest', tone)}
    >
      {label}
    </Badge>
  );
}

/**
 * Derive the status tone ring/colour from an `AgentProfile`. Mirrors
 * the Overview page's `StatusBadge` tones so the two surfaces agree on
 * how a given status reads visually.
 */
function resolveStatusTone(profile) {
  if (profile?.missing) return 'text-red-400 border-red-400/40 bg-red-500/10';
  if (profile?.paused) return 'text-amber-300 border-amber-300/40';
  if (profile?.overBudget) return 'text-red-400 border-red-400/40 bg-red-500/10';
  return 'text-emerald-400 border-emerald-400/40';
}

/**
 * Derive the status label from an `AgentProfile`. Matches the
 * terminal's uppercase convention (ACTIVE / PAUSED / BUDGET EXHAUSTED
 * / SUBAGENT MISSING).
 */
function resolveStatusLabel(profile) {
  if (profile?.missing) return 'SUBAGENT MISSING';
  if (profile?.pausedReason === 'budget_exhausted' || profile?.overBudget) {
    return 'BUDGET EXHAUSTED';
  }
  if (profile?.paused) return 'PAUSED';
  return 'ACTIVE';
}

// ── Empty / loading / error ──────────────────────────────────────────

function DetailEmpty({ message }) {
  return (
    <Card
      className="border-dashed"
      data-page="agent-detail"
      data-state="empty"
    >
      <CardContent className="p-8 text-center text-sm italic text-slate-400">
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
      className="animate-pulse text-sm text-slate-500"
      data-page="agent-detail"
      data-loading="true"
      data-agent-slug={slug}
    >
      Loading agent…
    </div>
  );
}

function DetailError({ error, onRetry, slug }) {
  return (
    <Card
      role="alert"
      className="border-red-500/40 bg-red-500/10 text-red-200"
      data-page="agent-detail"
      data-error="true"
      data-agent-slug={slug}
    >
      <CardHeader className="space-y-1">
        <CardTitle as="h2" className="text-sm text-red-200">
          Failed to load agent.
        </CardTitle>
        <CardDescription className="text-xs text-red-200/80">
          {error?.message || String(error)}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="border-red-400/50 text-red-200 hover:bg-red-500/20"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }) {
  return (
    <Card
      role="alert"
      className="border-amber-500/40 bg-amber-500/10 text-amber-200"
    >
      <CardContent className="flex items-center gap-2 p-2.5 text-xs">
        <span>
          Refresh failed ({error?.message || 'unknown error'}) — showing last-known
          data.
        </span>
        <Button
          variant="link"
          size="sm"
          onClick={onRetry}
          className="h-auto p-0 text-xs text-amber-200 underline decoration-dotted hover:decoration-solid"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
