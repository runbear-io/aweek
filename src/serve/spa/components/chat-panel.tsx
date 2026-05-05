/**
 * `ChatPanel` — composable container for the floating chat surface.
 *
 * This is Sub-AC 2 of the chat-panel feature (AC 9): a standalone,
 * reusable panel shell with explicit `Header` / `Body` / `Footer`
 * regions and a built-in open/close animation. Subsequent sub-ACs
 * mount the thread list, conversation surface, system-preamble banner,
 * composer, etc. inside these regions; the surface itself stays
 * presentational and slot-driven so each piece can land independently.
 *
 * Sub-AC 1 shipped `FloatingChatBubble`, which currently keeps its own
 * inline `ExpandedPanel` for backwards-compatibility with the existing
 * test contract. A follow-up sub-AC will retire that inline panel and
 * compose `ChatPanel` instead — the public surface is intentionally
 * compatible (same `data-state`, `role="dialog"`, `aria-label`, mobile
 * sizing classes) so the swap is mechanical.
 *
 * Animation contract:
 *   - The panel mounts in the `closed` visual state then transitions
 *     to `open` on the next animation frame, giving CSS a chance to
 *     animate `opacity` / `translate` / `scale` from the closed-state
 *     defaults to the open-state values.
 *   - When `open` flips back to `false`, the panel transitions to the
 *     closed state, then unmounts after `animationDuration` ms so the
 *     exit animation has time to play. Set `animationDuration={0}` to
 *     disable the unmount delay (useful for tests or for embedders
 *     that want immediate teardown).
 *   - `data-state="open" | "closed"` reflects the current visual
 *     phase, mirroring the shadcn / Radix convention.
 *   - The transition is a 200 ms ease-out by default — short enough to
 *     feel responsive, long enough to read as a deliberate motion
 *     rather than a flash. Honoured via the inline `transitionDuration`
 *     style so `animationDuration` callers don't have to thread a
 *     custom Tailwind class.
 *
 * Layout contract (for the composable subcomponents):
 *   - `ChatPanelHeader`  — `<header>` slot with shadcn `bg-muted/40`
 *     surface, a bottom border, and the canonical `data-component`
 *     marker. Sized to shrink-0 so the body can scroll independently.
 *   - `ChatPanelBody`    — `<div>` slot with `flex-1 min-h-0
 *     overflow-y-auto` so the body owns scrolling regardless of how
 *     many messages stack up.
 *   - `ChatPanelFooter`  — `<footer>` slot with shadcn `bg-muted/30`
 *     surface and a top border. Hosts the composer in later sub-ACs.
 *     Also `shrink-0` so the body remains the elastic region.
 *
 * Mobile sizing matches the `FloatingChatBubble.ExpandedPanel` rules
 * (per project policy: respect the `< 768 px` breakpoint via the
 * `useIsMobile` hook in the consumer):
 *   - Mobile: `h-[calc(100svh-6rem)] w-[calc(100vw-1.5rem)] max-w-md`
 *     so the panel almost fills the viewport while leaving room for
 *     the header / sidebar trigger above and the safe inset below.
 *   - Desktop: `h-[36rem] w-96 max-h-[calc(100svh-2rem)]` so the panel
 *     docks in the bottom-right without stealing screen real estate.
 *
 * Styling follows project policy: shadcn theme tokens only
 * (`bg-card` / `text-card-foreground` / `border-border` /
 * `bg-muted/*` / `text-muted-foreground`) — no hardcoded colour
 * classes — so the panel re-themes automatically with light/dark.
 *
 * @module serve/spa/components/chat-panel
 */

import * as React from 'react';

import { cn } from '../lib/cn.js';

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Default duration of the open/close transition in milliseconds.
 *
 * Two-hundred ms is long enough to read as deliberate motion (a flash
 * shorter than ~150 ms reads as a snap, not an animation) but short
 * enough not to delay the user when they reach for the panel. The same
 * value is also the unmount delay — the panel stays in the DOM with
 * `data-state="closed"` for this many ms after `open` flips to `false`
 * so the exit animation has time to play before React removes the
 * element.
 *
 * Exported so tests can advance fake timers by exactly the right
 * amount and so callers (e.g. embedders that want a slower / faster
 * panel) can opt into a custom duration via `animationDuration`.
 */
export const CHAT_PANEL_ANIMATION_MS = 200;

// ── ChatPanel root ────────────────────────────────────────────────────

export interface ChatPanelProps
  extends Omit<
    React.HTMLAttributes<HTMLDivElement>,
    'children' | 'role' | 'aria-label'
  > {
  /**
   * When `true` the panel is mounted and animates into the `open`
   * visual state. When `false` the panel transitions to `closed`,
   * then unmounts after `animationDuration` ms. Required.
   */
  open: boolean;
  /**
   * Mobile viewport flag. When `true` the panel grows to nearly fill
   * the viewport and bumps the surface to the safe-inset budget so
   * header / status-bar chrome stays reachable. Defaults to `false`.
   *
   * Resolved by the consumer via `useIsMobile()` (per project policy);
   * the panel itself stays presentational and viewport-agnostic so it
   * can be unit-tested under either branch without faking
   * `matchMedia`.
   */
  isMobile?: boolean;
  /**
   * Accessible name for the dialog. Defaults to `"Chat panel"` so the
   * surface always advertises a sensible label even when the consumer
   * forgets to override; downstream chat-aware sub-ACs replace this
   * with the active agent's display name (e.g. `"writer chat"`).
   */
  ariaLabel?: string;
  /**
   * Composable contents. Typically a `ChatPanelHeader` + `ChatPanelBody`
   * + optional `ChatPanelFooter` triple, but the panel doesn't enforce
   * the structure — embedders can mix in arbitrary slots so e.g. a
   * thread-switcher banner can sit between the header and the body.
   */
  children: React.ReactNode;
  /**
   * Caller-supplied className merged onto the panel surface (NOT the
   * region subcomponents).
   */
  className?: string;
  /**
   * Animation duration in milliseconds. Drives both the CSS transition
   * length and the unmount delay so they stay in lockstep. Defaults to
   * `CHAT_PANEL_ANIMATION_MS` (200 ms). Pass `0` to disable both — the
   * panel mounts and unmounts synchronously, no transition runs.
   */
  animationDuration?: number;
}

/**
 * Floating chat panel surface — the rounded-card container that hosts
 * the conversation, composer, and thread switcher.
 *
 * Owns the open/close lifecycle:
 *   1. When `open` flips from `false` → `true`, the panel mounts in
 *      the visually-closed state (translucent, slightly translated
 *      and scaled down). On the next animation frame `data-state`
 *      flips to `"open"` and CSS animates the surface in.
 *   2. When `open` flips from `true` → `false`, the panel transitions
 *      to the closed state, then unmounts after `animationDuration`
 *      ms so React doesn't yank the element mid-animation.
 *   3. When `open` is `false` and the panel hasn't been mounted yet,
 *      the component returns `null` — there's no hidden DOM node and
 *      no transition runs until the first open.
 *
 * Use the composable subcomponents (`ChatPanelHeader`, `ChatPanelBody`,
 * `ChatPanelFooter`) to fill the regions; the root only contributes
 * the surface chrome (border, shadow, background, rounded corners).
 */
export function ChatPanel({
  open,
  isMobile = false,
  ariaLabel = 'Chat panel',
  children,
  className,
  animationDuration = CHAT_PANEL_ANIMATION_MS,
  ...rest
}: ChatPanelProps): React.ReactElement | null {
  // Two-phase visibility:
  //   - `mounted` controls whether the DOM node exists at all. Stays
  //     true through the close-out animation so React doesn't unmount
  //     mid-transition.
  //   - `visible` drives the visual state. Flips on the next paint
  //     after mount so CSS has a chance to animate from the closed
  //     defaults to the open values.
  const [mounted, setMounted] = React.useState<boolean>(false);
  const [visible, setVisible] = React.useState<boolean>(false);

  React.useEffect(() => {
    if (open) {
      setMounted(true);
      // Skip the appear animation when the duration is zero — go
      // straight to the open state so embedders that disable
      // animation see an instantaneous mount.
      if (animationDuration <= 0) {
        setVisible(true);
        return;
      }
      // `setTimeout(0)` is sufficient to defer past the current commit
      // — by the time the callback fires React has flushed the DOM
      // node with `data-state="closed"`, so flipping to `"open"` here
      // triggers the CSS transition. We avoid `requestAnimationFrame`
      // so vitest fake timers can advance the animation in tests
      // without mocking rAF separately.
      const enter = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(enter);
    }

    // open === false
    setVisible(false);
    if (animationDuration <= 0) {
      setMounted(false);
      return;
    }
    const exit = setTimeout(() => setMounted(false), animationDuration);
    return () => clearTimeout(exit);
  }, [open, animationDuration]);

  if (!mounted) return null;

  const panelSizeClass = isMobile
    ? 'h-[calc(100svh-6rem)] w-[calc(100vw-1.5rem)] max-w-md'
    : 'h-[36rem] w-96 max-h-[calc(100svh-2rem)]';

  return (
    <div
      data-component="chat-panel"
      data-state={visible ? 'open' : 'closed'}
      data-mobile={isMobile ? 'true' : 'false'}
      role="dialog"
      aria-label={ariaLabel}
      // Drive the transition timing via inline style so callers can
      // override `animationDuration` without minting a custom Tailwind
      // class; Tailwind's `duration-*` utilities only cover a fixed
      // set of values.
      style={{ transitionDuration: `${animationDuration}ms` }}
      className={cn(
        // Surface chrome — matches the FloatingChatBubble inline
        // ExpandedPanel so the visual swap is invisible.
        'flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl shadow-foreground/10',
        // Animated properties. We transition opacity + transform so
        // the panel fades and rises into place. `will-change-transform`
        // hints the compositor; safe to leave on for the lifetime of
        // the panel (it lives at most for the open session).
        'transform-gpu transition-[opacity,transform] ease-out will-change-transform',
        visible
          ? 'translate-y-0 scale-100 opacity-100'
          : 'pointer-events-none translate-y-2 scale-95 opacity-0',
        panelSizeClass,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export default ChatPanel;

// ── ChatPanelHeader ───────────────────────────────────────────────────

export interface ChatPanelHeaderProps
  extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

/**
 * Top region of the chat panel. Hosts the panel title, the active
 * thread/agent label, the close affordance, and any header-level
 * actions (e.g. "new thread"). Keeps `shrink-0` so the body region
 * stays the elastic flex-1 child and owns scrolling.
 */
export function ChatPanelHeader({
  className,
  children,
  ...props
}: ChatPanelHeaderProps): React.ReactElement {
  return (
    <header
      data-component="chat-panel-header"
      className={cn(
        'flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2',
        className,
      )}
      {...props}
    >
      {children}
    </header>
  );
}

// ── ChatPanelBody ─────────────────────────────────────────────────────

export interface ChatPanelBodyProps
  extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

/**
 * Middle region of the chat panel. Owns scrolling so the header and
 * footer stay pinned. Subsequent sub-ACs render the conversation list
 * + thread switcher here; this region is intentionally a plain
 * scroll container with no presentational opinions of its own.
 */
export function ChatPanelBody({
  className,
  children,
  ...props
}: ChatPanelBodyProps): React.ReactElement {
  return (
    <div
      data-component="chat-panel-body"
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-y-auto',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

// ── ChatPanelFooter ───────────────────────────────────────────────────

export interface ChatPanelFooterProps
  extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

/**
 * Bottom region of the chat panel. Hosts the composer (textarea + send
 * button) and the budget / status hint line in later sub-ACs. Stays
 * `shrink-0` so the body region remains the elastic child.
 *
 * Optional — embedders that don't need a footer can omit it and the
 * body will fill the remaining space.
 */
export function ChatPanelFooter({
  className,
  children,
  ...props
}: ChatPanelFooterProps): React.ReactElement {
  return (
    <footer
      data-component="chat-panel-footer"
      className={cn(
        'flex shrink-0 items-center gap-2 border-t border-border bg-muted/30 px-4 py-3',
        className,
      )}
      {...props}
    >
      {children}
    </footer>
  );
}
