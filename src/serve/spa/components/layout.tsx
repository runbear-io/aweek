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

import * as React from 'react';

import { cn } from '../lib/cn.js';
import { AgentDetailSidebar, AppSidebar } from './app-sidebar.jsx';
import { Footer } from './footer.jsx';
import { Header } from './header.jsx';
import * as SidebarModule from './ui/sidebar.jsx';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────
//
// `./ui/sidebar.jsx` ships shadcn primitives via `React.forwardRef` with
// destructured params and JSDoc. TypeScript can't recover proper prop
// types from those `.jsx` files, so each used primitive is re-aliased
// to a permissive `ComponentType` here. Once `components/ui/*` is
// converted in a later sub-AC, these casts can be deleted.

type SidebarProviderProps = React.HTMLAttributes<HTMLDivElement> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  style?: React.CSSProperties;
};
type SidebarInsetProps = React.HTMLAttributes<HTMLElement>;
type SidebarTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

const SidebarProvider = SidebarModule.SidebarProvider as React.ComponentType<SidebarProviderProps>;
const SidebarInset = SidebarModule.SidebarInset as React.ComponentType<SidebarInsetProps>;
const SidebarTrigger = SidebarModule.SidebarTrigger as React.ComponentType<SidebarTriggerProps>;

export interface LayoutProps {
  /** Optional title rendered inside the top `<Header>`. */
  title?: string;
  /** Optional subtitle paired with `title`. */
  subtitle?: string;
  /** Trailing slot inside the header (rendered to the right of `SidebarTrigger`). */
  headerActions?: React.ReactNode;
  /** Trailing slot inside the footer (rendered after the attribution copy). */
  footer?: React.ReactNode;
  /** Caller-supplied class names merged onto the `SidebarInset`. */
  className?: string;
  /** Page contents rendered between header and footer. */
  children?: React.ReactNode;
  /** Whether the primary sidebar is expanded on first render. */
  defaultSidebarOpen?: boolean;
}

/**
 * Application shell.
 */
export function Layout({
  title,
  subtitle,
  headerActions,
  footer,
  className,
  children,
  defaultSidebarOpen = true,
}: LayoutProps = {}): React.ReactElement {
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
