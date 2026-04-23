import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import {
  AgentsPage,
  AgentDetailPage,
  DEFAULT_AGENT_DETAIL_TAB,
  normaliseTab,
} from './pages/index.js';
import './styles/globals.css';

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

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/agents" replace />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:slug" element={<AgentDetailRoute />} />
        <Route path="/agents/:slug/:tab" element={<AgentDetailRoute />} />
        <Route path="/calendar" element={<Navigate to="/agents" replace />} />
        <Route path="/activity" element={<Navigate to="/agents" replace />} />
        <Route path="/strategy" element={<Navigate to="/agents" replace />} />
        <Route path="/profile" element={<Navigate to="/agents" replace />} />
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
