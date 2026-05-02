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
import { useLocation } from 'react-router-dom';

import { cn } from '../lib/cn.js';
import {
  AgentDetailSidebar,
  AppSidebar,
  MobileAppSidebar,
} from './app-sidebar.jsx';
import { Footer } from './footer.jsx';
import { Header } from './header.jsx';
import { NotificationBell } from './notification-bell.js';
import { ThemeToggle } from './theme-toggle.js';
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
  // Mobile drawer open state. The hamburger trigger inside `<Header>`
  // flips this true (only rendered below `md`); the `<MobileAppSidebar>`
  // Sheet primitive consumes the same state and reuses the canonical
  // `<AppSidebarBody>` markup. Above the `md` breakpoint the desktop
  // sidebar takes over and this state stays inert (the trigger is
  // `md:hidden` and the drawer Sheet content carries `md:hidden`, so
  // viewport resizes past 768 px also trim the open flag back to false).
  const [mobileDrawerOpen, setMobileDrawerOpen] = React.useState(false);

  // ── Route-transition scroll reset (AC 10) ──────────────────────────
  //
  // The Layout shell (header + main + footer) is mounted once at app
  // startup and persists across every route change inside `<Routes>`.
  // The `<main>` container below carries `overflow-auto` so each page's
  // body scrolls independently of the document — but because that scroll
  // container is the same DOM node across route transitions, its
  // `scrollTop` value persists across navigations. On mobile that reads
  // as a layout shift: scroll halfway down `/agents`, tap into a row,
  // and the new `/agents/:slug` page renders with its content already
  // pushed off-screen.
  //
  // Reset the scroll on every pathname change so each route lands at
  // the top. The window scrollTo() is a defence in depth for any page
  // that opts out of the inner scroll container (none currently do, but
  // future pages might) — both calls are no-ops when scrollTop is
  // already 0, so the cost is negligible and the layout-shift class is
  // closed off uniformly.
  const mainRef = React.useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const pathname = location?.pathname ?? '/';
  React.useEffect(() => {
    const main = mainRef.current;
    if (main && typeof main.scrollTo === 'function') {
      main.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    } else if (main) {
      main.scrollTop = 0;
      main.scrollLeft = 0;
    }
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [pathname]);

  // Bell + caller-supplied trailing slot share the right edge of the
  // header so the bell stays a persistent affordance across routes
  // (per AC 8 sub-AC 3 — "header bell trigger with unread count badge").
  // The bell sits to the *right* of any caller-supplied controls so it
  // anchors to the same spot regardless of how many extras the page pushes.
  //
  // The canonical shadcn `SidebarTrigger` is hidden below `md` because the
  // desktop sidebar itself only renders at `md:block` — toggling its
  // collapse state from a mobile viewport would have no visible effect.
  // The mobile hamburger (rendered by `<Header>` via `onOpenMobileDrawer`)
  // takes over below the breakpoint.
  // Below `md` the sidebar is collapsed into a Sheet drawer (Sub-AC 1),
  // so the canonical sidebar-footer Mode Toggle is one tap away rather
  // than in-flow. Surface a duplicate icon-only `<ThemeToggle>` in the
  // header on mobile (`md:hidden`) so light/dark switching stays a
  // single tap on narrow viewports — and stays hidden on desktop where
  // the sidebar footer toggle remains the canonical surface.
  // Touch-target overrides (Sub-AC 7): the shadcn `Button size="icon"`
  // recipe is `h-10 w-10` (= 40×40 px) — below the 44×44 px mobile
  // a11y minimum. The shadcn primitive itself stays untouched (per
  // project policy: do not hand-edit `components/ui/*.jsx`); instead
  // each header trigger receives a responsive className override that
  // bumps the hit area to `h-11 w-11` (= 44×44 px) below `md` and
  // reverts to the canonical 40×40 px above the breakpoint so the
  // desktop layout stays visually identical to the current baseline.
  const actions = (
    <>
      <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
      <div className="ml-auto flex items-center gap-2">
        {headerActions}
        <ThemeToggle className="h-11 w-11 md:hidden" />
        <NotificationBell className="h-11 w-11 md:h-10 md:w-10" />
      </div>
    </>
  );
  // ── Mobile / desktop sidebar contract ───────────────────────────────
  //
  // Two persistent rails coexist inside `SidebarProvider` on desktop and
  // both must surrender their inline width to `<SidebarInset>` below the
  // `md` (768px) breakpoint so `<main>` reclaims the full viewport on
  // mobile:
  //
  //   1. `<AppSidebar />` — primary nav rail. The underlying shadcn
  //      `<Sidebar collapsible="icon">` primitive already gates its
  //      visible markup behind `hidden md:block`, so on mobile it emits
  //      no inline-flow box. The `<MobileAppSidebar />` Sheet drawer
  //      below renders the same `AppSidebarBody` markup inside a Radix
  //      portal (`md:hidden`) so the nav stays one tap away.
  //
  //   2. `<AgentDetailSidebar />` — secondary per-agent rail visible only
  //      on `/agents/:slug`. It uses `collapsible="none"`, which the
  //      shadcn primitive renders inline (no `md:block` guard) — a 16rem
  //      column would otherwise eat 68% of a 375px viewport. The
  //      `hidden md:contents` wrapper is the layout-level container
  //      override that mirrors point 1: below `md` the wrapper collapses
  //      via `display: none`; at `md+` `display: contents` makes the
  //      wrapper layout-transparent so the rail flows next to the
  //      primary one exactly as before.
  //
  // The inset itself carries `flex-1 min-w-0` which lets it absorb the
  // freed inline space on mobile without any extra width reset.
  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppSidebar />
      <MobileAppSidebar
        open={mobileDrawerOpen}
        onOpenChange={setMobileDrawerOpen}
      />
      <div className="hidden md:contents" data-component="agent-detail-sidebar-slot">
        <AgentDetailSidebar />
      </div>
      <SidebarInset
        data-component="layout"
        data-mobile-drawer-open={mobileDrawerOpen ? 'true' : 'false'}
        // `h-svh` (small-viewport-height) bounds the inset to the visible
        // viewport so flex-1 children don't push the page past the fold.
        // The previous `min-h-screen` only set a floor — content taller than
        // viewport grew the inset and forced document-level scroll. Tabs
        // that previously relied on document scroll (Activity / Strategy /
        // Profile) now scroll inside the `<main>` container below.
        // `min-w-0` lets the inset shrink to fill whatever inline space the
        // sidebars surrender at each breakpoint — full viewport width below
        // `md` (both rails collapsed), `100% - rail widths` above.
        className={cn('h-svh min-w-0 antialiased', className)}
      >
        <Header
          title={title}
          subtitle={subtitle}
          actions={actions}
          onOpenMobileDrawer={() => setMobileDrawerOpen(true)}
        />
        <div
          ref={mainRef}
          data-component="main"
          data-pathname={pathname}
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
