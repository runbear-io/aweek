import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { AppShell } from './app-shell.tsx';
import { ChatPanelProvider } from './components/chat-panel-context.js';
import { ThemeProvider as ThemeProviderJs } from './components/theme-provider.jsx';
import { TooltipProvider as TooltipProviderJs } from './components/ui/tooltip.jsx';
import './styles/globals.css';

// ---------------------------------------------------------------------------
// Cross-boundary shims for still-`.jsx` SPA modules
// ---------------------------------------------------------------------------

const ThemeProvider = ThemeProviderJs as React.ComponentType<{
  children?: React.ReactNode;
}>;

// `TooltipProvider` configures Radix's hover-tooltip delay behavior. The
// SPA wants tooltips on collapsed-sidebar nav items to fire instantly,
// so we wrap the entire route tree at delayDuration=0 / skipDelayDuration=0.
const TooltipProvider = TooltipProviderJs as React.ComponentType<{
  children?: React.ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
}>;

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
      {/*
        ── Floating chat panel state (AC 9 Sub-AC 4) ──────────────────
        `<ChatPanelProvider>` sits above `<BrowserRouter>` so the
        open/closed state of the floating chat panel survives every
        route transition (the router never unmounts the provider) and
        is addressable from any component in the SPA — header bell
        variants, agent-list "chat" buttons, future deep-link routes —
        without each surface having to lift its own state. Persistence
        across full page reloads is handled by the provider's
        localStorage backing (`aweek:chat-panel:open`).
      */}
      <ChatPanelProvider>
        <TooltipProvider delayDuration={0} skipDelayDuration={0}>
          <BrowserRouter>
            <AppShell />
          </BrowserRouter>
        </TooltipProvider>
      </ChatPanelProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
