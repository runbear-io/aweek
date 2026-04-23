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

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Activity,
  Calendar,
  ListChecks,
  User,
  Users,
} from 'lucide-react';

import { ThemeToggle } from './theme-toggle.jsx';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from './ui/sidebar.jsx';

const AGENT_TABS = Object.freeze([
  { tab: 'calendar', label: 'Calendar', icon: Calendar },
  { tab: 'activity', label: 'Activity', icon: Activity },
  { tab: 'strategy', label: 'Strategy', icon: ListChecks },
  { tab: 'profile', label: 'Profile', icon: User },
]);

/**
 * Parse an agent-detail pathname into `{ slug, tab }`. Returns `null`
 * when the current path is not under `/agents/:slug/`.
 *
 * @param {string} pathname
 * @returns {{ slug: string, tab: string } | null}
 */
export function parseAgentDetailRoute(pathname) {
  if (typeof pathname !== 'string') return null;
  const match = pathname.match(/^\/agents\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  return { slug: match[1], tab: match[2] || 'calendar' };
}

/**
 * @typedef {object} AppNavItem
 * @property {string} to        Destination pathname (must be server-whitelisted).
 * @property {string} label     Human-readable link text.
 * @property {React.ComponentType<{ className?: string, 'aria-hidden'?: boolean }>} icon
 *                              Lucide icon rendered alongside the label.
 * @property {string} [match]   Optional pathname prefix for active-state
 *                              matching when the link points at a section
 *                              root (e.g. `/agents` should stay active on
 *                              `/agents/:slug`).
 */

/**
 * Canonical top-level sidebar entries. Today there is exactly one
 * entry — `/agents` — per AC 2. Exported so tests and any URL-builder
 * utilities can iterate without re-declaring literals.
 *
 * @type {ReadonlyArray<AppNavItem>}
 */
export const APP_NAV_ITEMS = Object.freeze([
  { to: '/agents', label: 'Agents', icon: Users, match: '/agents' },
]);

/**
 * Is `pathname` considered "inside" this nav item's section? Exact
 * match for leaf routes; prefix match for section roots (where `match`
 * is set).
 *
 * @param {AppNavItem} item
 * @param {string | undefined | null} pathname
 * @returns {boolean}
 */
export function isAppNavItemActive(item, pathname) {
  if (!item || typeof pathname !== 'string') return false;
  if (pathname === item.to) return true;
  if (item.match && pathname.startsWith(`${item.match}/`)) return true;
  return false;
}

/**
 * App shell sidebar. Must be rendered inside a `SidebarProvider` and a
 * react-router `<BrowserRouter>` / `<MemoryRouter>`.
 *
 * @param {{
 *   items?: ReadonlyArray<AppNavItem>,
 *   className?: string,
 * } & React.ComponentProps<typeof Sidebar>} [props]
 */
export function AppSidebar({ items = APP_NAV_ITEMS, className, ...props } = {}) {
  const location = useLocation();
  const pathname = location?.pathname ?? '/';
  const detail = parseAgentDetailRoute(pathname);

  return (
    <Sidebar
      data-component="app-sidebar"
      aria-label="Primary"
      className={className}
      {...props}
    >
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-accent text-sm font-bold text-accent-foreground"
          >
            a
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
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {detail ? (
          <SidebarGroup data-agent-detail-group={detail.slug}>
            <SidebarGroupLabel className="truncate" title={detail.slug}>
              {detail.slug}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {AGENT_TABS.map(({ tab, label, icon: Icon }) => {
                  const to = `/agents/${detail.slug}/${tab}`;
                  const active = detail.tab === tab;
                  return (
                    <SidebarMenuItem key={tab}>
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
