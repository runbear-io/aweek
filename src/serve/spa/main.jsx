import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import {
  AgentsPage,
  AgentDetailPage,
  DEFAULT_AGENT_DETAIL_TAB,
  normaliseTab,
} from './pages/index.js';
import { Layout } from './components/layout.jsx';
import { ThemeProvider } from './components/theme-provider.jsx';
import './styles/globals.css';

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
  const { slug, tab, basename } = useParams();
  const navigate = useNavigate();
  // The /agents/:slug/activities/:basename route only supplies `slug`
  // and `basename` via params; there is no `tab` segment to match. Coerce
  // the effective tab to 'activities' in that case so AgentDetailPage
  // can thread `activitySelection` + open/close handlers to the
  // activity tab.
  const effectiveTab = basename
    ? 'activities'
    : normaliseTab(tab) ?? DEFAULT_AGENT_DETAIL_TAB;
  const slugSegment = encodeURIComponent(slug);
  return (
    <AgentDetailPage
      slug={slug}
      initialTab={effectiveTab}
      activitySelection={basename}
      onTabChange={(next) => navigate(`/agents/${slug}/${next}`)}
      onActivityOpen={(b) =>
        navigate(`/agents/${slugSegment}/activities/${encodeURIComponent(b)}`)
      }
      onActivityClose={() => navigate(`/agents/${slugSegment}/activities`)}
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

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
