/**
 * `Header` — shared application header.
 *
 * Renders the app brand (the "aweek" wordmark + a short tagline) and a
 * right-side slot for contextual actions (refresh button, time-zone
 * indicator, etc.). The header is paired with {@link Nav} inside the
 * {@link Layout} shell so every page inherits the same top chrome.
 *
 * Styling is Tailwind-only — no plain CSS, no inline `style=` props.
 * The palette matches the dark dashboard tokens already in use across
 * the SPA (slate-800 borders, slate-900/950 backgrounds, slate-100/200
 * foreground text) so the header blends with the {@link Nav} bar.
 *
 * @module serve/spa/components/header
 */

import React from 'react';

import { cn } from '../lib/cn.js';

/**
 * Shared application header.
 *
 * @param {{
 *   title?: string,
 *   subtitle?: string,
 *   actions?: React.ReactNode,
 *   className?: string,
 * }} [props]
 * @returns {JSX.Element}
 */
export function Header({
  title = 'aweek',
  subtitle = 'Scheduled Claude Code agents',
  actions,
  className,
} = {}) {
  return (
    <header
      data-component="header"
      className={cn(
        'flex items-center justify-between gap-4 border-b border-slate-800 bg-slate-950/80 px-4 py-3',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-sky-400/40 bg-sky-500/10 text-sm font-bold text-sky-200"
        >
          a
        </span>
        <div className="flex flex-col">
          <h1 className="text-sm font-semibold tracking-tight text-slate-100">
            {title}
          </h1>
          {subtitle ? (
            <p className="text-[11px] text-slate-400">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex items-center gap-2 text-xs text-slate-300">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export default Header;
