/**
 * `Layout` — shared application shell.
 *
 * Wraps page content in the canonical `<Header>` + `<Nav>` + `<main>` +
 * `<Footer>` stack so every route inherits identical chrome. Consumers
 * pass the current `pathname` (+ optional `onNavigate`) so the nav's
 * active-link highlighting stays in sync with the URL.
 *
 * Styling is Tailwind-only (no plain CSS, no inline styles). The shell
 * fills the viewport via `min-h-screen` and places the footer at the
 * bottom of the scroll region using flex.
 *
 * Composition:
 *
 *   <Layout pathname={pathname} onNavigate={push}>
 *     <AgentsPage />
 *   </Layout>
 *
 * The shell is intentionally un-opinionated about routing: parent code
 * owns the URL and simply hands the active pathname in. This keeps the
 * layout usable under any router (react-router, a plain browser
 * navigation, a test harness, etc.).
 *
 * @module serve/spa/components/layout
 */

import React from 'react';

import { cn } from '../lib/cn.js';
import { Footer } from './footer.jsx';
import { Header } from './header.jsx';
import { Nav } from './nav.jsx';

/**
 * Application shell.
 *
 * @param {{
 *   pathname?: string,
 *   onNavigate?: (href: string) => void,
 *   title?: string,
 *   subtitle?: string,
 *   headerActions?: React.ReactNode,
 *   footer?: React.ReactNode,
 *   className?: string,
 *   children?: React.ReactNode,
 * }} [props]
 * @returns {JSX.Element}
 */
export function Layout({
  pathname = '/',
  onNavigate,
  title,
  subtitle,
  headerActions,
  footer,
  className,
  children,
} = {}) {
  return (
    <div
      data-component="layout"
      className={cn(
        'flex min-h-screen flex-col bg-slate-950 text-slate-100 antialiased',
        className,
      )}
    >
      <Header title={title} subtitle={subtitle} actions={headerActions} />
      <Nav pathname={pathname} onNavigate={onNavigate} />
      <main
        data-component="main"
        className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8"
      >
        {children}
      </main>
      <Footer>{footer}</Footer>
    </div>
  );
}

export default Layout;
