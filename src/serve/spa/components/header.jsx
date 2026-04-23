/**
 * `Header` — shared application top bar.
 *
 * Mirrors the canonical shadcn dashboard starter header: a thin strip
 * holding the `SidebarTrigger` (threaded in by `Layout` via `actions`)
 * and, optionally, a page title + subtitle. The brand lockup lives in
 * the sidebar header, not here — the default shadcn starter avoids
 * duplicating brand between the rail and the inset chrome.
 *
 * Styling is Tailwind-only (no plain CSS, no inline styles) and uses
 * only shadcn token utilities (`border-border`, `bg-background`,
 * `text-foreground`, `text-muted-foreground`), so the bar rethemes
 * automatically under both light and dark palettes defined in
 * `styles/globals.css`.
 *
 * @module serve/spa/components/header
 */

import React from 'react';

import { cn } from '../lib/cn.js';

/**
 * Shared application header.
 *
 * `title` / `subtitle` are optional — most pages render their own
 * heading inside a Card and leave the shell bar minimal, matching the
 * dashboard-01 template from shadcn/ui.
 *
 * @param {{
 *   title?: string,
 *   subtitle?: string,
 *   actions?: React.ReactNode,
 *   className?: string,
 * }} [props]
 * @returns {JSX.Element}
 */
export function Header({ title, subtitle, actions, className } = {}) {
  return (
    <header
      data-component="header"
      className={cn(
        'flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4',
        className,
      )}
    >
      {actions ? (
        <div className="flex items-center gap-2 text-foreground">{actions}</div>
      ) : null}
      {title ? (
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">
            {title}
          </span>
          {subtitle ? (
            <span className="truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

export default Header;
