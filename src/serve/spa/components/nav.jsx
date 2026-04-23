/**
 * `Nav` — top-level navigation bar for the aweek SPA.
 *
 * Renders the primary client-route links that the server whitelist
 * (`src/serve/server.js::isWhitelistedClientRoute`) accepts:
 *
 *   / (Dashboard) · /agents · /calendar · /activity · /strategy · /profile
 *
 * Keeping the nav targets in lockstep with the server whitelist ensures
 * every entry point returns 200 + index.html on hard reload. The public
 * {@link NAV_ITEMS} array is exported so the server test suite and any
 * downstream integration can assert parity without duplicating literals.
 *
 * Styling uses only Tailwind utility classes — no plain CSS, no inline
 * styles. The active-link accent ring matches the shadcn tabs primitive
 * under `./ui/tabs.jsx` so the two navigation affordances read as a
 * single visual family.
 *
 * Accessibility:
 *   - `role="navigation"` with an explicit `aria-label` per WAI-ARIA.
 *   - The active link is marked with `aria-current="page"` so screen
 *     readers announce it as the current location.
 *   - Focus-visible rings use the same sky-500/60 tone shared across
 *     shadcn-style primitives in this codebase.
 *
 * The component is router-agnostic. Parent routers (react-router, a
 * plain anchor, a hash-router test harness, etc.) pass in the `pathname`
 * plus an optional `onNavigate(href)` callback. When `onNavigate` is
 * omitted, the `<a>` elements behave as normal links and the browser
 * performs a full navigation — which is fine because the server's SPA
 * catch-all rehydrates the app at the new URL.
 *
 * @module serve/spa/components/nav
 */

import React from 'react';

import { cn } from '../lib/cn.js';

/**
 * @typedef {object} NavItem
 * @property {string} href    Destination pathname (must be server-whitelisted).
 * @property {string} label   Human-readable link text.
 * @property {string} [match] Optional pathname prefix used for active-state
 *                            matching when the link points at a section
 *                            root (e.g. `/agents` should stay active on
 *                            `/agents/:slug`).
 */

/**
 * Canonical nav order — mirrors the server-side client-route whitelist.
 * Exported so the server tests and any URL-builder utilities can iterate
 * without re-declaring literals.
 *
 * @type {ReadonlyArray<NavItem>}
 */
export const NAV_ITEMS = Object.freeze([
  { href: '/', label: 'Dashboard' },
  { href: '/agents', label: 'Agents', match: '/agents' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/activity', label: 'Activity' },
  { href: '/strategy', label: 'Strategy' },
  { href: '/profile', label: 'Profile' },
]);

/**
 * Is `pathname` considered "inside" this nav item's section? Exact match
 * for leaf routes; prefix match for section roots (where `match` is set).
 *
 * @param {NavItem} item
 * @param {string | undefined | null} pathname
 * @returns {boolean}
 */
export function isNavItemActive(item, pathname) {
  if (!item || typeof pathname !== 'string') return false;
  if (item.href === '/' && pathname === '/') return true;
  if (pathname === item.href) return true;
  if (item.match && pathname.startsWith(`${item.match}/`)) return true;
  return false;
}

/**
 * Primary navigation bar.
 *
 * @param {{
 *   pathname?: string,
 *   onNavigate?: (href: string) => void,
 *   className?: string,
 *   items?: ReadonlyArray<NavItem>,
 * }} [props]
 * @returns {JSX.Element}
 */
export function Nav({
  pathname = '/',
  onNavigate,
  className,
  items = NAV_ITEMS,
} = {}) {
  return (
    <nav
      aria-label="Primary"
      data-component="nav"
      className={cn(
        'flex items-center gap-1 border-b border-slate-800 bg-slate-950/60 px-4 py-2 text-sm',
        className,
      )}
    >
      <ul
        role="list"
        className="flex flex-1 items-center gap-1 overflow-x-auto"
      >
        {items.map((item) => {
          const active = isNavItemActive(item, pathname);
          return (
            <li key={item.href}>
              <a
                href={item.href}
                data-nav-item={item.href}
                data-state={active ? 'active' : 'inactive'}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => {
                  if (typeof onNavigate !== 'function') return;
                  // Let the browser handle modified clicks / non-primary
                  // buttons so "open in new tab" still works.
                  if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  onNavigate(item.href);
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                  active
                    ? 'border-sky-500/60 bg-sky-500/10 text-slate-100'
                    : 'border-transparent text-slate-400 hover:border-slate-700 hover:bg-slate-900/60 hover:text-slate-200',
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default Nav;
