/**
 * `useIsMobile` — viewport-detection hook for the SPA's mobile layout.
 *
 * Returns `true` when the current viewport width is strictly below the
 * Tailwind `md` breakpoint (768px). Components consume this to swap
 * between the desktop layout (sidebar pinned, full header, calendar grid)
 * and the mobile layout (Sheet-based sidebar drawer, compact header,
 * horizontally scrollable tabs, reflowed content).
 *
 * Why a single boolean instead of a richer breakpoint object:
 *   The mobile-polish work (AC 4) toggles every page on a single
 *   breakpoint — below `md` is mobile, at-or-above is desktop. Exposing
 *   one boolean keeps the call sites unambiguous and the hook trivial to
 *   memoize.
 *
 * Usage:
 *
 *   import { useIsMobile } from '../hooks';
 *
 *   function CalendarPage() {
 *     const isMobile = useIsMobile();
 *     return isMobile ? <CalendarMobile /> : <CalendarGrid />;
 *   }
 *
 * Why a custom hook instead of inline `window.matchMedia` per component:
 *   - Single source of truth for the breakpoint value (`MOBILE_BREAKPOINT`)
 *     so the threshold matches the Tailwind `md:` utility everywhere.
 *   - SSR-safe: returns `false` (desktop) when `window` is undefined so
 *     the bundle doesn't crash if it's ever pre-rendered.
 *   - Subscribes to `matchMedia` change events so resizes update state
 *     without polling. Listener uses `addEventListener('change', …)` —
 *     the legacy `addListener` form is not needed since we target modern
 *     browsers (Vite 6 / React 19).
 *   - Computes the initial value from `window.matchMedia(...).matches`
 *     so the very first render is correct (no post-mount flash from a
 *     desktop default to mobile, which would cause layout shift on
 *     phone-sized viewports).
 *
 * @module serve/spa/hooks/use-is-mobile
 */

import { useEffect, useState } from 'react';

/**
 * Mobile breakpoint in CSS pixels. Mirrors Tailwind's default `md`
 * breakpoint (768px) — anything strictly below this value is considered
 * mobile. Exported for tests and for components that need to render
 * conditional copy referencing the threshold.
 */
export const MOBILE_BREAKPOINT = 768;

/**
 * Resolve the current `isMobile` value synchronously. Returns `false` in
 * environments without `window` / `matchMedia` (e.g. SSR, tests with no
 * jsdom) so the desktop layout is the safe default.
 */
function getIsMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches;
}

/**
 * React hook returning `true` when the viewport is below the Tailwind
 * `md` breakpoint (768px).
 *
 * Re-renders the consumer whenever the viewport crosses the breakpoint.
 * On environments without `window.matchMedia` (SSR / non-jsdom test
 * environments) it returns `false` and never subscribes.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => getIsMobile());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

    // Sync once on mount in case the initial state was computed under a
    // different viewport (e.g. dev-tools device-toolbar toggled between
    // render and effect attach).
    setIsMobile(mql.matches);

    const handleChange = (event: MediaQueryListEvent): void => {
      setIsMobile(event.matches);
    };

    mql.addEventListener('change', handleChange);
    return () => {
      mql.removeEventListener('change', handleChange);
    };
  }, []);

  return isMobile;
}
