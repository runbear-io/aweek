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

import * as React from 'react';
import { Menu } from 'lucide-react';

import { cn } from '../lib/cn.js';
import { Button } from './ui/button.jsx';

// ── Cross-boundary shim for the still-`.jsx` shadcn Button primitive ──
//
// `./ui/button.jsx` is a canonical shadcn primitive (forwardRef + JSDoc).
// Mirror the same permissive cast pattern used elsewhere in the layout
// shell so the mobile hamburger trigger keeps strict-mode type safety
// without forcing a hand-edit of the shadcn file.

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  asChild?: boolean;
};
const ButtonShim = Button as React.ComponentType<ButtonProps>;

export interface HeaderProps {
  /** Page title rendered next to the leading actions. Optional — many pages render their own headings. */
  title?: string;
  /** Optional secondary text shown beneath the title. */
  subtitle?: string;
  /** Leading slot — typically the `<SidebarTrigger />` plus any caller-supplied controls. */
  actions?: React.ReactNode;
  /** Caller-supplied class names merged with the default Tailwind recipe. */
  className?: string;
  /**
   * Mobile-only handler invoked when the hamburger trigger is clicked.
   * When provided, a 44×44 hamburger button renders at the very start of
   * the header actions row and is hidden at the `md` breakpoint
   * (≥ 768px) — the desktop sidebar takes over above that breakpoint, so
   * the mobile drawer trigger only matters on narrow viewports.
   *
   * Wiring is intentionally split: the trigger lives here in the header
   * (so it sits inside the top chrome touch zone), but the drawer state
   * + Sheet primitive live in `Layout` (so the Sheet anchors at the app
   * shell root, not inside the header).
   */
  onOpenMobileDrawer?: () => void;
}

/**
 * Shared application header.
 *
 * `title` / `subtitle` are optional — most pages render their own
 * heading inside a Card and leave the shell bar minimal, matching the
 * dashboard-01 template from shadcn/ui.
 */
export function Header({
  title,
  subtitle,
  actions,
  className,
  onOpenMobileDrawer,
}: HeaderProps = {}): React.ReactElement {
  const showMobileTrigger = typeof onOpenMobileDrawer === 'function';
  return (
    <header
      data-component="header"
      // Sub-AC 2.1: `min-w-0` on the header itself lets the inset's
      // `min-w-0` cascade actually take effect, so the header chrome
      // can't force the inset wider than the 375px viewport. The
      // existing `flex` layout still owns horizontal distribution; the
      // guard only kicks in when a flex child (e.g. a long page title)
      // declares an intrinsic width past the viewport.
      className={cn(
        'flex h-14 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-4',
        className,
      )}
    >
      {showMobileTrigger ? (
        <ButtonShim
          type="button"
          variant="ghost"
          size="icon"
          onClick={onOpenMobileDrawer}
          aria-label="Open navigation menu"
          aria-haspopup="dialog"
          data-component="mobile-drawer-trigger"
          // 44×44 touch target (Tailwind h-11/w-11 = 2.75rem = 44px) per
          // mobile a11y minimum. `md:hidden` keeps the desktop layout
          // unchanged — the canonical shadcn `SidebarTrigger` continues to
          // own the >= 768px sidebar collapse behaviour. `shrink-0` keeps
          // the hamburger at its full 44×44 hit area even when the right-
          // hand actions row is wide enough to compete for inline space.
          className="-ml-2 h-11 w-11 shrink-0 md:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">Open navigation menu</span>
        </ButtonShim>
      ) : null}
      {actions ? (
        // Sub-AC 2.1: `min-w-0 flex-1` lets the actions row claim the
        // remaining inline space and shrink the optional title slot
        // first if total content runs past the 375px viewport. Without
        // `min-w-0` a flex row's intrinsic width is the sum of its
        // children, which would push the header past its parent.
        <div className="flex min-w-0 flex-1 items-center gap-2 text-foreground">
          {actions}
        </div>
      ) : null}
      {title ? (
        // `shrink` (default in flex) + `min-w-0` lets the title shrink
        // below its content width on narrow viewports so the truncate
        // utility actually engages.
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
