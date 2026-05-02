/**
 * `AppSidebar` — application composition of the shadcn sidebar
 * primitive.
 *
 * Renders the single persistent left rail that hosts the top-level
 * navigation for the aweek SPA. Today the rail carries exactly one
 * entry — `/agents` — but the composition keeps the shape generic
 * (iterating over {@link APP_NAV_ITEMS}) so additional top-level routes
 * can be added later without touching the primitive.
 *
 * The inner chrome is assembled from stock shadcn sidebar primitives:
 *
 *   Sidebar
 *   ├── SidebarHeader        (brand lockup)
 *   ├── SidebarContent
 *   │   └── SidebarGroup
 *   │       ├── SidebarGroupLabel
 *   │       └── SidebarGroupContent
 *   │           └── SidebarMenu
 *   │               └── SidebarMenuItem
 *   │                   └── SidebarMenuButton (asChild -> <Link>)
 *   └── SidebarFooter        (canonical shadcn Mode Toggle — <ThemeToggle />)
 *
 * Active-state handling uses `useLocation()` from react-router so the
 * `/agents` entry stays highlighted across nested routes
 * (`/agents/:slug`, `/agents/:slug/:tab`). `SidebarMenuButton` uses
 * `asChild` to delegate rendering to a react-router `<Link>`, which
 * keeps keyboard focus + click-to-navigate behaviour intact without
 * any bespoke wrapper component.
 *
 * @module serve/spa/components/app-sidebar
 */

import * as React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  Calendar,
  FileBox,
  ListChecks,
  Settings,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { useAgents } from '../hooks/use-agents.js';
import * as ThemeToggleModule from './theme-toggle.jsx';
import * as SidebarModule from './ui/sidebar.jsx';
import * as TooltipModule from './ui/tooltip.jsx';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────
//
// The primitives under `./ui/sidebar.jsx` use `React.forwardRef` with
// destructured params and JSDoc — TypeScript can't recover proper prop
// types from those `.jsx` files. The migration plan explicitly allows
// `.d.ts`/inline shims for this case; we re-alias each used primitive
// to a permissive `ComponentType` here. Once `components/ui/*` is
// converted in a later sub-AC, these casts can be deleted and the real
// types take over.

type SidebarRootProps = React.HTMLAttributes<HTMLDivElement> & {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'inset' | 'floating';
  collapsible?: 'icon' | 'none';
};
type SidebarSectionProps = React.HTMLAttributes<HTMLDivElement>;
type SidebarMenuProps = React.HTMLAttributes<HTMLUListElement>;
type SidebarMenuItemProps = React.HTMLAttributes<HTMLLIElement>;
type SidebarMenuButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  isActive?: boolean;
  variant?: 'default' | 'outline';
  size?: 'default' | 'sm' | 'lg';
  /**
   * Tooltip surface — currently passed through to the underlying DOM
   * element as a string attribute. Once `components/ui/sidebar.jsx`
   * gains a real Radix tooltip wrapper, the type here can tighten.
   */
  tooltip?: string;
};

const Sidebar = SidebarModule.Sidebar as React.ComponentType<SidebarRootProps>;
const SidebarContent = SidebarModule.SidebarContent as React.ComponentType<SidebarSectionProps>;
const SidebarFooter = SidebarModule.SidebarFooter as React.ComponentType<SidebarSectionProps>;
const SidebarGroup = SidebarModule.SidebarGroup as React.ComponentType<SidebarSectionProps>;
const SidebarGroupContent = SidebarModule.SidebarGroupContent as React.ComponentType<SidebarSectionProps>;
const SidebarGroupLabel = SidebarModule.SidebarGroupLabel as React.ComponentType<SidebarSectionProps>;
const SidebarHeader = SidebarModule.SidebarHeader as React.ComponentType<SidebarSectionProps>;
const SidebarMenu = SidebarModule.SidebarMenu as React.ComponentType<SidebarMenuProps>;
const SidebarMenuButton = SidebarModule.SidebarMenuButton as React.ComponentType<SidebarMenuButtonProps>;
const SidebarMenuItem = SidebarModule.SidebarMenuItem as React.ComponentType<SidebarMenuItemProps>;
const useSidebar = SidebarModule.useSidebar as () => {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  toggleSidebar: () => void;
};

const ThemeToggle = ThemeToggleModule.ThemeToggle as React.ComponentType<{
  className?: string;
}>;

// ── Tooltip shim ────────────────────────────────────────────────────
//
// `components/ui/tooltip.jsx` is a fresh shadcn-style primitive layered on
// `@radix-ui/react-tooltip`. The TS migration plan lets us alias still-
// `.jsx` shadcn primitives through permissive casts; mirror the pattern
// the sibling sidebar shims already use.

type TooltipProviderProps = {
  children?: React.ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
};
type TooltipRootProps = {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
};
type TooltipTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
};
type TooltipContentProps = React.HTMLAttributes<HTMLDivElement> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
  align?: 'start' | 'center' | 'end';
};

const TooltipProvider = TooltipModule.TooltipProvider as React.ComponentType<TooltipProviderProps>;
const Tooltip = TooltipModule.Tooltip as React.ComponentType<TooltipRootProps>;
const TooltipTrigger = TooltipModule.TooltipTrigger as React.ComponentType<TooltipTriggerProps>;
const TooltipContent = TooltipModule.TooltipContent as React.ComponentType<TooltipContentProps>;

/**
 * Wrap a sidebar menu item so a tooltip surfaces the item's label only
 * when the sidebar is in icon-only collapsed mode. When the sidebar is
 * expanded the label text is already visible inside the button, so the
 * tooltip would be redundant — return the child untouched.
 *
 * Embeds its own {@link TooltipProvider} (with `delayDuration={0}`) so
 * the wrapper works in tests and stand-alone mounts that don't set up
 * the app-root provider in `main.tsx`. Nested providers are well-defined
 * in Radix and the inner one wins, so the app-root provider stays
 * authoritative everywhere it's present — this nesting is purely a
 * "no-context-required" defence.
 */
function NavTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}): React.ReactElement {
  const { state } = useSidebar();
  if (state !== 'collapsed') return children;
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="right" align="center" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Inline aweek logo. Uses `currentColor` for stroke so the glyph picks
 * up the surrounding `text-foreground` token and adapts to light/dark
 * theme without two image variants. Path mirrors `docs/public/logo-light.svg`.
 */
function AweekLogo({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="aweek"
      className={className}
      data-component="aweek-logo"
    >
      <title>aweek</title>
      <path d="M2 4h4v8h4V4h4v8h4V4h4v8h4V4h4" />
    </svg>
  );
}

// ── Domain types ────────────────────────────────────────────────────

/**
 * Overview-row shape returned by the `useAgents` hook. Re-exported via
 * `import('…')` so the still-`.js` JSDoc remains the single source of
 * truth for the API contract while we incrementally migrate consumers.
 */
type AgentListRow = import('../lib/api-client.js').AgentListRow;

interface AgentTab {
  tab:
    | 'calendar'
    | 'activities'
    | 'reviews'
    | 'artifacts'
    | 'strategy'
    | 'profile';
  label: string;
  icon: LucideIcon;
}

const AGENT_TABS: ReadonlyArray<AgentTab> = Object.freeze([
  { tab: 'calendar', label: 'Calendar', icon: Calendar },
  { tab: 'activities', label: 'Activity', icon: Activity },
  { tab: 'reviews', label: 'Reviews', icon: BookOpen },
  { tab: 'artifacts', label: 'Artifacts', icon: FileBox },
  { tab: 'strategy', label: 'Strategy', icon: ListChecks },
  { tab: 'profile', label: 'Profile', icon: User },
]);

/**
 * Derive a short two-letter token for an agent's avatar. Splits on
 * whitespace first (so "Marketer Jamie" → "MJ"), falling back to
 * hyphen/underscore separators so slug-style names like
 * "marketer-jamie" → "MJ" or "content_writer" → "CW" still work.
 * Single-token names collapse to the first two letters of the token.
 */
export function agentInitials(text: string | null | undefined): string {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0) return '??';
  const parts = raw.split(/[\s\-_]+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0] ?? '';
    const second = parts[1] ?? '';
    return ((first[0] ?? '') + (second[0] ?? '')).toUpperCase();
  }
  return (parts[0] ?? '').slice(0, 2).toUpperCase();
}

/**
 * Map an agent overview-row status onto the Tailwind utility string for
 * the sidebar avatar chip. Active agents read as a subtle emerald tint
 * (the same scale the execution-log view already uses for `tool_result`
 * rows); paused and unknown agents fade back to the stock shadcn muted
 * token; exhausted budgets reuse the destructive surface. Keeping the
 * mapping here — rather than inside the JSX — means the visual tone is
 * a single-token decision a designer can tweak without re-hunting it
 * across the render tree.
 */
export function agentAvatarTone(status: string | null | undefined): string {
  if (status === 'active') {
    return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  }
  if (status === 'budget-exhausted') {
    return 'border-destructive/40 bg-destructive/15 text-destructive';
  }
  return 'border-border bg-muted text-muted-foreground';
}

/**
 * Parsed `/agents/:slug/:tab?` route segments. Returned by
 * {@link parseAgentDetailRoute}.
 */
export interface AgentDetailRoute {
  slug: string;
  tab: string;
}

/**
 * Parse an agent-detail pathname into `{ slug, tab }`. Returns `null`
 * when the current path is not under `/agents/:slug/`.
 */
export function parseAgentDetailRoute(
  pathname: string | null | undefined,
): AgentDetailRoute | null {
  if (typeof pathname !== 'string') return null;
  const match = pathname.match(/^\/agents\/([^/]+)(?:\/([^/]+))?(?:\/.*)?$/);
  if (!match) return null;
  const slug = match[1] ?? '';
  const tab = match[2] || 'calendar';
  return { slug, tab };
}

/**
 * Top-level navigation entry rendered inside `AppSidebar`.
 */
export interface AppNavItem {
  /** Destination pathname (must be server-whitelisted). */
  to: string;
  /** Human-readable link text. */
  label: string;
  /** Lucide icon rendered alongside the label. */
  icon: LucideIcon;
  /**
   * Optional pathname prefix for active-state matching when the link
   * points at a section root (e.g. `/agents` should stay active on
   * `/agents/:slug`).
   */
  match?: string;
}

/**
 * Canonical top-level sidebar entries. Today there is exactly one
 * entry — `/agents` — per AC 2. Exported so tests and any URL-builder
 * utilities can iterate without re-declaring literals.
 */
export const APP_NAV_ITEMS: ReadonlyArray<AppNavItem> = Object.freeze([
  { to: '/agents', label: 'Agents', icon: Users, match: '/agents' },
  { to: '/settings', label: 'Settings', icon: Settings },
]);

/**
 * Is `pathname` considered "inside" this nav item's section? Exact
 * match for leaf routes; prefix match for section roots (where `match`
 * is set).
 */
export function isAppNavItemActive(
  item: AppNavItem | null | undefined,
  pathname: string | null | undefined,
): boolean {
  if (!item || typeof pathname !== 'string') return false;
  if (pathname === item.to) return true;
  if (item.match && pathname.startsWith(`${item.match}/`)) return true;
  return false;
}

export interface AppSidebarProps extends Omit<SidebarRootProps, 'children'> {
  items?: ReadonlyArray<AppNavItem>;
}

/**
 * App shell sidebar. Must be rendered inside a `SidebarProvider` and a
 * react-router `<BrowserRouter>` / `<MemoryRouter>`.
 */
export function AppSidebar({
  items = APP_NAV_ITEMS,
  className,
  ...props
}: AppSidebarProps = {}): React.ReactElement {
  const location = useLocation();
  const pathname = location?.pathname ?? '/';
  const detail = parseAgentDetailRoute(pathname);
  const { setOpen } = useSidebar();
  // Pull the agent list into the sidebar so every scheduled agent is
  // one click away from any route, not just from the Overview table.
  // `useAgents` de-duplicates its in-flight request across consumers
  // (the primary sidebar + the Overview page hit it together).
  const { data: agentsData } = useAgents();
  const agentRows: AgentListRow[] = agentsData?.rows ?? [];

  // When an agent is selected, collapse the primary rail to its
  // icon-only strip so the secondary (detail) sidebar becomes the
  // focus. Re-expand when the user goes back to the list.
  const detailNull = detail == null;
  React.useEffect(() => {
    setOpen(detailNull);
  }, [detailNull, setOpen]);

  return (
    <Sidebar
      data-component="app-sidebar"
      aria-label="Primary"
      className={className}
      {...props}
    >
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          {/* Brand lockup. The 14×7 logo fits inside an 8×8 chip when
              collapsed; when expanded it sits to the left of the wordmark.
              `currentColor` stroke means it inherits text-foreground for
              both light and dark themes (no image swap needed). */}
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-accent text-accent-foreground"
          >
            <AweekLogo className="h-3.5 w-7" />
          </span>
          <div className="flex flex-col leading-tight group-data-[collapsible=icon]/sidebar:hidden">
            <span className="text-sm font-semibold text-foreground">
              aweek
            </span>
            <span className="text-[11px] text-muted-foreground">
              Scheduled agents
            </span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const active = isAppNavItemActive(item, pathname);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.to}>
                    <NavTooltip label={item.label}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        data-nav-item={item.to}
                      >
                        <Link to={item.to}>
                          {Icon ? (
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          ) : null}
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </NavTooltip>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {agentRows.length > 0 ? (
          <SidebarGroup data-agents-group="true">
            <SidebarGroupLabel>Agents</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {agentRows.map((row) => {
                  const to = `/agents/${row.slug}`;
                  const active = detail?.slug === row.slug;
                  const initials = agentInitials(row.name || row.slug);
                  const statusTone = agentAvatarTone(row.status);
                  const label = row.name || row.slug;
                  return (
                    <SidebarMenuItem key={row.slug}>
                      <NavTooltip label={label}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          data-nav-item={to}
                          className="h-auto group-data-[collapsible=icon]/sidebar:!size-9 group-data-[collapsible=icon]/sidebar:!p-0"
                        >
                          <Link to={to}>
                            <span
                              aria-hidden="true"
                              data-agent-status={row.status}
                              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[9px] font-semibold tracking-wider tabular-nums ${statusTone}`}
                            >
                              {initials}
                            </span>
                            <span className="truncate">{label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </NavTooltip>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:px-0">
          <span className="text-xs font-medium text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
            Theme
          </span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export default AppSidebar;

/**
 * `AgentDetailSidebar` — secondary sidebar that appears only when the
 * route is inside `/agents/:slug`. Hosts the four per-agent tabs as a
 * nested left rail to the right of the primary `AppSidebar` (which
 * collapses to its icon-only strip while this one is visible).
 *
 * Uses `collapsible="none"` so this rail keeps a fixed width regardless
 * of the shared `SidebarProvider` `open` state — `AppSidebar` is the
 * only sidebar that responds to the collapse toggle.
 *
 * Tests + routing use `data-component="agent-detail-sidebar"`.
 */
export function AgentDetailSidebar(): React.ReactElement | null {
  const location = useLocation();
  const detail = parseAgentDetailRoute(location?.pathname ?? '/');
  if (!detail) return null;

  return (
    <Sidebar
      collapsible="none"
      data-component="agent-detail-sidebar"
      aria-label={`${detail.slug} detail navigation`}
      className="border-l"
    >
      <SidebarHeader>
        <div className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Agent
          </span>
          <span
            className="truncate text-sm font-semibold text-foreground"
            title={detail.slug}
          >
            {detail.slug}
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {AGENT_TABS.map(({ tab, label, icon: Icon }) => {
                const to = `/agents/${detail.slug}/${tab}`;
                const active = detail.tab === tab;
                return (
                  <SidebarMenuItem key={tab}>
                    <NavTooltip label={label}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        data-nav-item={to}
                      >
                        <Link to={to}>
                          <Icon className="h-4 w-4" aria-hidden="true" />
                          <span>{label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </NavTooltip>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
