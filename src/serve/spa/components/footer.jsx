/**
 * `Footer` — shared application footer.
 *
 * Renders a thin attribution strip beneath the main content area. The
 * component is purely presentational and Tailwind-styled (no plain CSS,
 * no inline styles). Callers may override the copy or append extra
 * children slots (version badge, time-zone indicator, etc.).
 *
 * @module serve/spa/components/footer
 */

import React from 'react';

import { cn } from '../lib/cn.js';

/**
 * Shared application footer.
 *
 * @param {{
 *   children?: React.ReactNode,
 *   className?: string,
 * }} [props]
 * @returns {JSX.Element}
 */
export function Footer({ children, className } = {}) {
  const year = new Date().getUTCFullYear();
  return (
    <footer
      data-component="footer"
      className={cn(
        'flex items-center justify-between gap-3 border-t border-slate-800 bg-slate-950/80 px-4 py-3 text-[11px] text-slate-500',
        className,
      )}
    >
      <p>
        aweek · {year} · read-only dashboard served from{' '}
        <code className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-300">
          .aweek/
        </code>
      </p>
      {children ? (
        <div className="flex items-center gap-2 text-slate-400">{children}</div>
      ) : null}
    </footer>
  );
}

export default Footer;
