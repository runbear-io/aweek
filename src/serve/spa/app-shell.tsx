/**
 * `AppShell` — the routing tree mounted under `<BrowserRouter>` in
 * `main.tsx`.
 *
 * Extracted into its own module (Sub-AC 9.2) so the route-level wrappers
 * — in particular `AgentDetailRoute`, which owns the `?week=YYYY-Www`
 * URL ↔ calendar-page sync — can be exercised under `MemoryRouter` in
 * the SPA test suite without dragging in `main.tsx`'s top-level
 * `createRoot(...).render(...)` side effect.
 *
 * The `?week=` round-trip lives here:
 *
 *   - **Read on mount / refresh / deep-link**: `useSearchParams()` pulls
 *     `?week=` off the URL inside `AgentDetailRoute`, validates the
 *     `YYYY-Www` shape, and threads the result through to
 *     `<AgentDetailPage calendarWeek=…>`. A refresh on
 *     `/agents/<slug>/calendar?week=2026-W17` therefore re-mounts on the
 *     same week — the URL is the only source of truth.
 *   - **Push on navigation**: the calendar's `onWeekChange(week | null)`
 *     callback is wired to a `navigate(<path>?week=…)` call (or a path
 *     without a query when `null`), so prev / next / today clicks update
 *     the URL via react-router. The new URL fires the same
 *     `useSearchParams()` re-read on the next render, closing the loop.
 *
 * @module serve/spa/app-shell
 */

import * as React from 'react';
import {
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';

import {
  AgentsPage as AgentsPageJs,
  AgentDetailPage as AgentDetailPageJs,
  DEFAULT_AGENT_DETAIL_TAB,
  normaliseTab,
  SettingsPage,
} from './pages/index.js';
import { Layout } from './components/layout.jsx';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/**
 * The six tab values rendered inside `<AgentDetailPage>`. Mirrored from
 * the typedef in `pages/agent-detail-page.tsx` — duplicated here so the
 * routing file does not have to consume a typedef from a `.jsx` module
 * during the incremental TS migration.
 */
type AgentTabValue =
  | 'calendar'
  | 'activities'
  | 'reviews'
  | 'artifacts'
  | 'strategy'
  | 'profile';

/**
 * Route-segment params consumed by `<AgentDetailRoute>`. `slug` is required
 * to enter the route, but `useParams()` from react-router v7 still types
 * every segment as `string | undefined`, so consumers must guard accordingly.
 */
type AgentDetailParams = {
  slug: string;
  tab?: string;
  basename?: string;
  taskId?: string;
  reviewWeek?: string;
};

// ---------------------------------------------------------------------------
// Cross-boundary shims for still-`.jsx` SPA modules
// ---------------------------------------------------------------------------

const AgentsPage = AgentsPageJs as React.ComponentType<{
  onSelectAgent?: (slug: string) => void;
}>;

const AgentDetailPage = AgentDetailPageJs as React.ComponentType<{
  slug: string;
  initialTab?: AgentTabValue;
  onTabChange?: (next: AgentTabValue) => void;
  baseUrl?: string;
  fetch?: typeof fetch;
  activitySelection?: string | undefined;
  calendarSelection?: string | undefined;
  onActivityOpen?: (basename: string) => void;
  onActivityClose?: () => void;
  onCalendarOpen?: (taskId: string) => void;
  onCalendarClose?: () => void;
  calendarWeek?: string;
  onCalendarWeekChange?: (week: string | null) => void;
  reviewSelection?: string | undefined;
  onReviewOpen?: (week: string) => void;
  onReviewClose?: () => void;
}>;

// ---------------------------------------------------------------------------
// Route-level wrappers
// ---------------------------------------------------------------------------

export function AgentsRoute(): React.ReactElement {
  const navigate = useNavigate();
  // Every row on the /agents list navigates to /agents/:slug. The
  // `AgentsPage` component is routing-agnostic — it exposes an
  // `onSelectAgent(slug)` callback that this router wrapper wires to
  // `useNavigate`. This keeps the component unit-testable without a
  // `BrowserRouter` while still producing real links in the SPA.
  return <AgentsPage onSelectAgent={(slug) => navigate(`/agents/${slug}`)} />;
}

export function AgentDetailRoute(): React.ReactElement {
  const { slug, tab, basename, taskId, reviewWeek } =
    useParams<AgentDetailParams>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // `useParams()` always widens segment values to `string | undefined`,
  // even when the route pattern requires the segment. Fall back to an
  // empty string so the URL builders below stay total — `AgentDetailPage`
  // itself short-circuits with an empty-state when slug is falsy.
  const safeSlug = slug ?? '';
  const slugSegment = encodeURIComponent(safeSlug);

  // The deep-link routes don't carry a `:tab` segment — coerce the
  // effective tab from whichever drawer-id is present.
  const normalised = normaliseTab(tab) as AgentTabValue | undefined;
  const effectiveTab: AgentTabValue = basename
    ? 'activities'
    : taskId
      ? 'calendar'
      : reviewWeek
        ? 'reviews'
        : (normalised ?? (DEFAULT_AGENT_DETAIL_TAB as AgentTabValue));

  // Calendar week override: `?week=YYYY-Www` lets the user pin a specific
  // ISO week. Absent → server picks the agent's timezone-aware current
  // week. The shape `\d{4}-W\d{2}` is enforced loosely here so a junk URL
  // collapses to the default rather than reaching the data layer.
  //
  // This is the SOURCE OF TRUTH for the calendar's viewed week: the
  // calendar page never owns its own week state, it just consumes what
  // the URL says. A page refresh on `/agents/alice/calendar?week=2026-W17`
  // therefore re-renders the exact same week with no hidden state to
  // hydrate.
  const rawWeek = searchParams.get('week');
  const calendarWeek =
    rawWeek && /^\d{4}-W\d{2}$/.test(rawWeek) ? rawWeek : undefined;

  return (
    <AgentDetailPage
      slug={safeSlug}
      initialTab={effectiveTab}
      activitySelection={basename}
      calendarSelection={taskId}
      reviewSelection={reviewWeek}
      calendarWeek={calendarWeek}
      onTabChange={(next) => navigate(`/agents/${safeSlug}/${next}`)}
      onActivityOpen={(b) =>
        navigate(`/agents/${slugSegment}/activities/${encodeURIComponent(b)}`)
      }
      onActivityClose={() => navigate(`/agents/${slugSegment}/activities`)}
      onCalendarOpen={(t) =>
        navigate(`/agents/${slugSegment}/calendar/${encodeURIComponent(t)}`)
      }
      onCalendarClose={() => navigate(`/agents/${slugSegment}/calendar`)}
      onReviewOpen={(w) =>
        navigate(`/agents/${slugSegment}/reviews/${encodeURIComponent(w)}`)
      }
      onReviewClose={() => navigate(`/agents/${slugSegment}/reviews`)}
      onCalendarWeekChange={(nextWeek) => {
        // Preserve the calendar path (with optional taskId) and only flip
        // the `?week=` query. Passing `null` clears the override and the
        // server falls back to the agent's current week. This is the
        // WRITE side of the `?week=` URL sync — every prev / next / today
        // click in the calendar header lands here and pushes a new URL
        // via react-router so deep-links and refresh restore the viewed
        // week.
        const path = taskId
          ? `/agents/${slugSegment}/calendar/${encodeURIComponent(taskId)}`
          : `/agents/${slugSegment}/calendar`;
        const search = nextWeek ? `?week=${encodeURIComponent(nextWeek)}` : '';
        navigate(`${path}${search}`);
      }}
    />
  );
}

/**
 * `AppShell` — wraps every page in the shared `Layout` so the sidebar,
 * header, and footer built by AC 2/4/5 actually render in the live SPA.
 * Without this wrapper the routes bypass the sidebar entirely and the
 * theme toggle in the sidebar footer is unreachable.
 *
 * Exported so the SPA test suite can mount the entire routing tree under
 * a `MemoryRouter` and assert end-to-end URL behaviour (e.g. the
 * `?week=YYYY-Www` round-trip the Calendar tab depends on).
 */
export function AppShell(): React.ReactElement {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/agents" replace />} />
        <Route path="/agents" element={<AgentsRoute />} />
        <Route path="/agents/:slug" element={<AgentDetailRoute />} />
        <Route
          path="/agents/:slug/activities/:basename"
          element={<AgentDetailRoute />}
        />
        <Route
          path="/agents/:slug/calendar/:taskId"
          element={<AgentDetailRoute />}
        />
        <Route
          path="/agents/:slug/reviews/:reviewWeek"
          element={<AgentDetailRoute />}
        />
        <Route path="/agents/:slug/:tab" element={<AgentDetailRoute />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/calendar" element={<Navigate to="/agents" replace />} />
        <Route path="/activities" element={<Navigate to="/agents" replace />} />
        <Route path="/strategy" element={<Navigate to="/agents" replace />} />
        <Route path="/profile" element={<Navigate to="/agents" replace />} />
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Routes>
    </Layout>
  );
}

export default AppShell;
