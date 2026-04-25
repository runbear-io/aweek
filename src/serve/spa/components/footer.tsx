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

import * as React from 'react';

import { cn } from '../lib/cn.js';

export interface FooterProps {
  /** Optional trailing slot rendered to the right of the attribution copy. */
  children?: React.ReactNode;
  /** Caller-supplied class names merged with the default Tailwind recipe. */
  className?: string;
}

/**
 * Shared application footer.
 */
export function Footer({ children, className }: FooterProps = {}): React.ReactElement {
  const year = new Date().getUTCFullYear();
  return (
    <footer
      data-component="footer"
      className={cn(
        'flex items-center justify-between gap-3 border-t border-border bg-background/80 px-4 py-3 text-[11px] text-muted-foreground',
        className,
      )}
    >
      <p>
        aweek · {year} · read-only dashboard served from{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
          .aweek/
        </code>
      </p>
      {children ? (
        <div className="flex items-center gap-2 text-muted-foreground">{children}</div>
      ) : null}
    </footer>
  );
}

export default Footer;
