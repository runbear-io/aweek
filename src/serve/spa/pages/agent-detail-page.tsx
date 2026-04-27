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
 * TypeScript migration note (AC 102 sub-AC 2):
 *   This module is the second SPA page converted from `.jsx` → `.tsx`.
 *   Sibling page modules in `./agent-*-page.jsx` and shadcn/ui primitives
 *   in `../components/ui/*` remain `.jsx` for this migration phase.
 *   They are imported via `* as <Name>Module` (or aliased through
 *   `React.ComponentType` casts) so the inferred JSDoc types do not
 *   constrain the prop surface this shell needs to thread through. This
 *   is the "cross-boundary import shim" pattern the migration plan calls
 *   out for unconverted JSX modules — once those modules are converted
 *   in a later sub-AC, the casts disappear and the real types take over.
 *
 * @module serve/spa/pages/agent-detail-page
 */

import * as React from 'react';
import { Link } from 'react-router-dom';

import * as BreadcrumbModule from '../components/ui/breadcrumb.jsx';
import * as ButtonModule from '../components/ui/button.jsx';
import * as CardModule from '../components/ui/card.jsx';
import * as TabsModule from '../components/ui/tabs.jsx';
import { cn } from '../lib/cn.js';
import { useAgentProfile } from '../hooks/use-agent-profile.js';

// Sibling pages converted to `.tsx` per AC 103 sub-AC 3. The import
// path keeps the historical `.jsx` extension so the TypeScript Bundler
// resolver maps it through to the on-disk `.tsx` file (Vite + Vitest do
// the same). Switching to `.tsx` here would require enabling
// `allowImportingTsExtensions`, which the migration plan defers.
import { AgentActivityPage as AgentActivityPageJs } from './agent-activity-page.jsx';
import { AgentCalendarPage as AgentCalendarPageJs } from './agent-calendar-page.jsx';
import { AgentPlanPage as AgentPlanPageJs } from './agent-plan-page.jsx';
import { AgentProfilePage as AgentProfilePageJs } from './agent-profile-page.jsx';
import { AgentReviewsPage as AgentReviewsPageJs } from './agent-reviews-page.jsx';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────
//
// The primitives under `../components/ui/*` use `React.forwardRef` with
// destructured params and JSDoc that TypeScript can't fully recover. The
// migration plan explicitly allows `.d.ts`/inline shims for this case;
// we re-alias each used primitive to a permissive `ComponentType` here.
// Once `components/ui/*` is converted in a later sub-AC, these casts
// can be deleted and the real types take over.

type ShadcnVariant = 'default' | 'secondary' | 'destructive' | 'outline';
type ButtonVariant = ShadcnVariant | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};
type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
};
type CardSectionProps = React.HTMLAttributes<HTMLDivElement>;
type CardTitleProps = React.HTMLAttributes<HTMLHeadingElement> & {
  as?: React.ElementType;
};
type CardDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

type BreadcrumbProps = React.HTMLAttributes<HTMLElement>;
type BreadcrumbListProps = React.HTMLAttributes<HTMLOListElement>;
type BreadcrumbItemProps = React.HTMLAttributes<HTMLLIElement>;
type BreadcrumbLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  asChild?: boolean;
};
type BreadcrumbPageProps = React.HTMLAttributes<HTMLSpanElement> & {
  ['data-active-tab']?: string;
};
type BreadcrumbSeparatorProps = React.HTMLAttributes<HTMLLIElement>;

type TabsRootProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children?: React.ReactNode;
};
type TabsContentProps = React.HTMLAttributes<HTMLDivElement> & {
  value: string;
};

const Breadcrumb = BreadcrumbModule.Breadcrumb as React.ComponentType<BreadcrumbProps>;
const BreadcrumbItem = BreadcrumbModule.BreadcrumbItem as React.ComponentType<BreadcrumbItemProps>;
const BreadcrumbLink = BreadcrumbModule.BreadcrumbLink as React.ComponentType<BreadcrumbLinkProps>;
const BreadcrumbList = BreadcrumbModule.BreadcrumbList as React.ComponentType<BreadcrumbListProps>;
const BreadcrumbPage = BreadcrumbModule.BreadcrumbPage as React.ComponentType<BreadcrumbPageProps>;
const BreadcrumbSeparator =
  BreadcrumbModule.BreadcrumbSeparator as React.ComponentType<BreadcrumbSeparatorProps>;
const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;
const Card = CardModule.Card as React.ComponentType<CardProps>;
const CardContent = CardModule.CardContent as React.ComponentType<CardSectionProps>;
const CardDescription = CardModule.CardDescription as React.ComponentType<CardDescriptionProps>;
const CardHeader = CardModule.CardHeader as React.ComponentType<CardSectionProps>;
const CardTitle = CardModule.CardTitle as React.ComponentType<CardTitleProps>;
const Tabs = TabsModule.Tabs as React.ComponentType<TabsRootProps>;
const TabsContent = TabsModule.TabsContent as React.ComponentType<TabsContentProps>;

// ── Cross-boundary shims for still-`.jsx` sibling page modules ──────
//
// The four embedded tab pages (`AgentActivityPage`, `AgentCalendarPage`,
// `AgentPlanPage`, `AgentProfilePage`) remain authored in JSX with
// JSDoc during this incremental migration. Their JSDoc blocks declare a
// closed prop shape that is narrower than what this shell threads
// through (e.g. AgentActivityPage's `selectedBasename` /
// `onOpenBasename` / `onCloseBasename` drawer props are present in the
// implementation but not in the JSDoc). Aliasing each import through
// `React.ComponentType` widens the prop surface to what the shell
// actually passes — the same pattern used in `main.tsx` for this exact
// migration phase.

const AgentActivityPage = AgentActivityPageJs as React.ComponentType<{
  slug: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  selectedBasename?: string | undefined;
  onOpenBasename?: (basename: string) => void;
  onCloseBasename?: () => void;
}>;
const AgentCalendarPage = AgentCalendarPageJs as React.ComponentType<{
  slug: string;
  week?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  selectedTaskId?: string | undefined;
  onOpenTaskId?: (taskId: string) => void;
  onCloseTaskId?: () => void;
}>;
const AgentPlanPage = AgentPlanPageJs as React.ComponentType<{
  slug: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}>;
const AgentProfilePage = AgentProfilePageJs as React.ComponentType<{
  slug: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}>;
const AgentReviewsPage = AgentReviewsPageJs as React.ComponentType<{
  slug: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}>;

// ── Domain types ────────────────────────────────────────────────────
//
// `AgentProfile` is exported as a JSDoc typedef from the still-`.js`
// `api-client.js`. With `allowJs: true` in `tsconfig.spa.json`, TS still
// reads JSDoc typedefs when a `.tsx` consumer aliases them via
// `import('…').Type`. Re-aliasing here keeps the JSDoc as the single
// source of truth.

type AgentProfile = import('../lib/api-client.js').AgentProfile;

/**
 * The four tab values rendered inside `<AgentDetailPage>`. Mirrors the
 * `Calendar / Activity / Strategy / Profile` row defined by AC 2.
 */
export type AgentTabValue = 'calendar' | 'activities' | 'reviews' | 'strategy' | 'profile';

/**
 * Fixed tab order — matches the Calendar/Activity/Strategy/Profile row
 * specified by AC 2. Exported so the parent router (and the component
 * tests) can iterate without copy-pasting literals.
 */
export const AGENT_DETAIL_TABS: ReadonlyArray<{
  value: AgentTabValue;
  label: string;
}> = Object.freeze([
  { value: 'calendar', label: 'Calendar' },
  { value: 'activities', label: 'Activity' },
  { value: 'reviews', label: 'Reviews' },
  { value: 'strategy', label: 'Strategy' },
  { value: 'profile', label: 'Profile' },
] as const);

/** Default tab when `initialTab` is omitted — Calendar per AC 2 row order. */
export const DEFAULT_AGENT_DETAIL_TAB: AgentTabValue = 'calendar';

const VALID_TABS: ReadonlySet<string> = new Set<string>(
  AGENT_DETAIL_TABS.map((t) => t.value),
);

/**
 * Normalise an `initialTab` prop to a safe tab value. Unknown values
 * fall back to the default so a malformed URL can never wedge the page
 * into a non-rendering state.
 */
export function normaliseTab(
  raw: string | undefined | null,
): AgentTabValue {
  if (typeof raw === 'string' && VALID_TABS.has(raw)) {
    return raw as AgentTabValue;
  }
  return DEFAULT_AGENT_DETAIL_TAB;
}

/**
 * Props consumed by `<AgentDetailPage>`. The `slug` and `initialTab`
 * pair are typed as the canonical route params per the migration plan
 * (AC 102 sub-AC 2): the parent router lifts them straight off
 * `useParams<{ slug: string; tab?: string }>()` and threads them through
 * here without any further coercion.
 *
 * Drawer-selection props (`activitySelection` / `calendarSelection` and
 * their open/close callbacks) are wired by the URL-aware
 * `<AgentDetailRoute>` wrapper in `main.tsx`. They are optional so the
 * component remains usable in unit tests and standalone mounts.
 */
export interface AgentDetailPageProps {
  /** Agent slug — selects which agent's data the shell + child tabs load. */
  slug: string;
  /** Initial tab segment (`/agents/:slug/:tab`). Falls back to Calendar. */
  initialTab?: AgentTabValue;
  /** Notifies the parent router when the active tab changes. */
  onTabChange?: (tab: AgentTabValue) => void;
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
  /** Currently-selected activity drawer basename (URL-driven). */
  activitySelection?: string | undefined;
  onActivityOpen?: (basename: string) => void;
  onActivityClose?: () => void;
  /** Currently-selected calendar drawer task id (URL-driven). */
  calendarSelection?: string | undefined;
  onCalendarOpen?: (taskId: string) => void;
  onCalendarClose?: () => void;
}

/**
 * Agent Detail page shell. Renders the identity header + tab nav and
 * routes the active tab to its corresponding hook-driven child page.
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
}: AgentDetailPageProps): React.ReactElement {
  const [activeTab, setActiveTab] = React.useState<AgentTabValue>(() =>
    normaliseTab(initialTab),
  );

  // Re-sync when the parent pushes a new `initialTab` (e.g. router
  // segment change). We intentionally re-key on the literal so an
  // unchanged value does not re-run the effect.
  React.useEffect(() => {
    if (initialTab && VALID_TABS.has(initialTab) && initialTab !== activeTab) {
      setActiveTab(initialTab);
    }
    // activeTab is intentionally excluded — we only want to react to
    // external `initialTab` pushes, not our own state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  const handleTabChange = (next: string): void => {
    const value = next as AgentTabValue;
    setActiveTab(value);
    if (typeof onTabChange === 'function') onTabChange(value);
  };

  const { data, error, loading, refresh } = useAgentProfile(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  if (!slug) {
    return <DetailEmpty message="Select an agent to view details." />;
  }
  if (loading && !data) {
    return <DetailSkeleton slug={slug} />;
  }
  // `useAgentProfile` widens `error` to `Error | null`; the api-client
  // throws an `ApiError` subclass that carries a `.status` field. Read
  // it through a structural cast so the 404 short-circuit doesn't
  // require importing the class here. Cast through `unknown` because
  // `Error` and the `{ status: number }` shape don't overlap in TS's
  // structural view, even though `ApiError` extends `Error` at runtime.
  const errorWithStatus = error as unknown as { status?: unknown } | null;
  const errorStatus =
    errorWithStatus && typeof errorWithStatus.status === 'number'
      ? errorWithStatus.status
      : null;
  if (error && errorStatus === 404) {
    return <DetailEmpty message={`No agent found for slug "${slug}".`} />;
  }
  if (error && !data) {
    return <DetailError error={error} onRetry={refresh} slug={slug} />;
  }

  // The shell may render before the profile fetch completes (data === null
  // can happen when the parent has held on to a previous fetch's data).
  // Synthesize a minimal placeholder so descendants always see a slug.
  const profile: AgentProfile =
    data ?? ({ slug, name: slug } as AgentProfile);
  // Reference `profile` so future enhancements (e.g. surfacing the agent
  // name in the breadcrumb) can read from it without a separate fetch.
  // The current implementation only needs `slug` directly, but the
  // resolved profile is kept in scope as documentation of the contract.
  void profile;

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
      <DetailBreadcrumb slug={slug} tab={activeTab} tabLabel={activeTabLabel} />
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
        <TabsContent value="reviews">
          <AgentReviewsPage slug={slug} baseUrl={baseUrl} fetch={fetchImpl} />
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

interface DetailBreadcrumbProps {
  slug: string;
  tab: AgentTabValue;
  tabLabel: string;
}

/**
 * Breadcrumb trail rendered above the detail header. Surfaces the
 * three-segment path `Agents → :slug → :tab` per AC 3. The root and
 * slug segments are navigable via react-router `<Link>`; the active
 * tab is rendered as `BreadcrumbPage` so assistive tech announces it
 * as the user's current position.
 */
function DetailBreadcrumb({
  slug,
  tab,
  tabLabel,
}: DetailBreadcrumbProps): React.ReactElement {
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

interface DetailEmptyProps {
  message: string;
}

interface DetailSkeletonProps {
  slug: string;
}

interface DetailErrorProps {
  error: Error | { message?: string } | null;
  onRetry: () => void | Promise<void>;
  slug: string;
}

interface StaleBannerProps {
  error: Error | { message?: string } | null;
  onRetry: () => void | Promise<void>;
}

function DetailEmpty({ message }: DetailEmptyProps): React.ReactElement {
  return (
    <Card className="border-dashed" data-page="agent-detail" data-state="empty">
      <CardContent className="p-8 text-center text-sm italic text-muted-foreground">
        {message}
      </CardContent>
    </Card>
  );
}

function DetailSkeleton({ slug }: DetailSkeletonProps): React.ReactElement {
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

function DetailError({
  error,
  onRetry,
  slug,
}: DetailErrorProps): React.ReactElement {
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

function StaleBanner({
  error,
  onRetry,
}: StaleBannerProps): React.ReactElement {
  // Neutral muted chrome for the "stale" callout — the stock shadcn
  // palette does not expose a warning token, so we use the muted surface
  // to signal "advisory, not destructive" (parity with `agents-page.tsx`).
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
