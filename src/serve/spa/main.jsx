import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import {
  AgentsPage,
  AgentDetailPage,
  AgentExecutionLogPage,
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
  const { slug, tab } = useParams();
  const navigate = useNavigate();
  const initialTab = normaliseTab(tab) ?? DEFAULT_AGENT_DETAIL_TAB;
  return (
    <AgentDetailPage
      slug={slug}
      initialTab={initialTab}
      onTabChange={(next) => navigate(`/agents/${slug}/${next}`)}
    />
  );
}

function AgentExecutionLogRoute() {
  const { slug, basename } = useParams();
  return <AgentExecutionLogPage slug={slug} basename={basename} />;
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
          path="/agents/:slug/activity/:basename"
          element={<AgentExecutionLogRoute />}
        />
        <Route path="/agents/:slug/:tab" element={<AgentDetailRoute />} />
        <Route path="/calendar" element={<Navigate to="/agents" replace />} />
        <Route path="/activity" element={<Navigate to="/agents" replace />} />
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
