/**
 * `Layout` — shared application shell.
 *
 * Wraps page content in a `SidebarProvider` + `AppSidebar` +
 * `SidebarInset` stack so every route renders beside the canonical left
 * rail. The inset carries `<Header>` + `<main>` + `<Footer>` slots so
 * top chrome and footer content stay consistent across pages.
 *
 * Composition:
 *
 *   <Layout>
 *     <AgentsPage />
 *   </Layout>
 *
 * The layout is router-agnostic in the sense that it does not own any
 * routing state — it simply assumes a react-router context is present
 * above it so `AppSidebar`'s `<Link>`-based nav works.
 *
 * @module serve/spa/components/layout
 */

import React from 'react';

import { cn } from '../lib/cn.js';
import { AgentDetailSidebar, AppSidebar } from './app-sidebar.jsx';
import { Footer } from './footer.jsx';
import { Header } from './header.jsx';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from './ui/sidebar.jsx';

/**
 * Application shell.
 *
 * @param {{
 *   title?: string,
 *   subtitle?: string,
 *   headerActions?: React.ReactNode,
 *   footer?: React.ReactNode,
 *   className?: string,
 *   children?: React.ReactNode,
 *   defaultSidebarOpen?: boolean,
 * }} [props]
 * @returns {JSX.Element}
 */
export function Layout({
  title,
  subtitle,
  headerActions,
  footer,
  className,
  children,
  defaultSidebarOpen = true,
} = {}) {
  const actions = (
    <>
      <SidebarTrigger className="-ml-1" />
      {headerActions ? (
        <div className="ml-auto flex items-center gap-2">{headerActions}</div>
      ) : null}
    </>
  );
  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppSidebar />
      <AgentDetailSidebar />
      <SidebarInset
        data-component="layout"
        // `h-svh` (small-viewport-height) bounds the inset to the visible
        // viewport so flex-1 children don't push the page past the fold.
        // The previous `min-h-screen` only set a floor — content taller than
        // viewport grew the inset and forced document-level scroll. Tabs
        // that previously relied on document scroll (Activity / Strategy /
        // Profile) now scroll inside the `<main>` container below.
        className={cn('h-svh min-w-0 antialiased', className)}
      >
        <Header title={title} subtitle={subtitle} actions={actions} />
        <div
          data-component="main"
          // `min-h-0` enables the inner flex chain to constrain children;
          // `overflow-auto` lets pages that don't opt into the chain scroll
          // naturally inside main rather than at the document level.
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto p-4 md:gap-6 md:p-6"
        >
          {children}
        </div>
        <Footer>{footer}</Footer>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default Layout;
