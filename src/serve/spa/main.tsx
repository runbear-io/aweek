import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
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
} from './pages/index.js';
import { Layout } from './components/layout.jsx';
import { ThemeProvider as ThemeProviderJs } from './components/theme-provider.jsx';
import './styles/globals.css';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/**
 * The four tab values rendered inside `<AgentDetailPage>`. Mirrored from
 * the JSDoc typedef in `pages/agent-detail-page.jsx` — duplicated here so
 * the routing file does not have to consume a typedef from a `.jsx` module
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
};

// ---------------------------------------------------------------------------
// Cross-boundary shims for still-`.jsx` SPA modules
//
// `pages/`, `components/layout.jsx`, and `components/theme-provider.jsx`
// remain authored in JSX with JSDoc during this incremental migration.
// Some of those JSDoc blocks declare a closed prop shape that is narrower
// than what the routing layer here actually passes (e.g. AgentDetailPage's
// drawer-selection callbacks). Aliasing the imports through permissive
// `React.ComponentType` casts keeps this file fully type-safe without
// dragging JSDoc edits into modules that are out of scope for Sub-AC 1.
// As each component is converted to `.tsx` in later sub-ACs, the cast
// can be removed and the real types take over.
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
}>;

const ThemeProvider = ThemeProviderJs as React.ComponentType<{
  children?: React.ReactNode;
}>;

// ---------------------------------------------------------------------------
// Route-level wrappers
// ---------------------------------------------------------------------------

function AgentsRoute() {
  const navigate = useNavigate();
  // Every row on the /agents list navigates to /agents/:slug. The
  // `AgentsPage` component is routing-agnostic — it exposes an
  // `onSelectAgent(slug)` callback that this router wrapper wires to
  // `useNavigate`. This keeps the component unit-testable without a
  // `BrowserRouter` while still producing real links in the SPA.
  return <AgentsPage onSelectAgent={(slug) => navigate(`/agents/${slug}`)} />;
}

function AgentDetailRoute() {
  const { slug, tab, basename, taskId } = useParams<AgentDetailParams>();
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
      : (normalised ?? (DEFAULT_AGENT_DETAIL_TAB as AgentTabValue));

  // Calendar week override: `?week=YYYY-Www` lets the user pin a specific
  // ISO week. Absent → server picks the agent's timezone-aware current
  // week. The shape `\d{4}-W\d{2}` is enforced loosely here so a junk URL
  // collapses to the default rather than reaching the data layer.
  const rawWeek = searchParams.get('week');
  const calendarWeek =
    rawWeek && /^\d{4}-W\d{2}$/.test(rawWeek) ? rawWeek : undefined;

  return (
    <AgentDetailPage
      slug={safeSlug}
      initialTab={effectiveTab}
      activitySelection={basename}
      calendarSelection={taskId}
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
      onCalendarWeekChange={(nextWeek) => {
        // Preserve the calendar path (with optional taskId) and only flip
        // the `?week=` query. Passing `null` clears the override and the
        // server falls back to the agent's current week.
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
 */
function AppShell() {
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
        <Route path="/agents/:slug/:tab" element={<AgentDetailRoute />} />
        <Route path="/calendar" element={<Navigate to="/agents" replace />} />
        <Route path="/activities" element={<Navigate to="/agents" replace />} />
        <Route path="/strategy" element={<Navigate to="/agents" replace />} />
        <Route path="/profile" element={<Navigate to="/agents" replace />} />
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Routes>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error(
    'aweek SPA: #root element not found in index.html — cannot mount React tree.',
  );
}

createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
