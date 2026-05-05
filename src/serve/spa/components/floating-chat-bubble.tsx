/**
 * `FloatingChatBubble` — persistent chat affordance anchored to the
 * bottom-right of the dashboard viewport.
 *
 * This is Sub-AC 1 of the chat-panel feature (AC 9): the collapsed
 * bubble + the expand/collapse toggle behaviour. Subsequent sub-ACs add
 * the threaded conversation surface, tool-invocation rendering, system
 * preamble, etc. — those land inside the expanded panel slot exposed
 * here via the `children` prop.
 *
 * Behaviour:
 *   - Two states: `collapsed` (a circular icon button) and `expanded`
 *     (a chat-panel shell with a header bar and a body slot).
 *   - Clicking the bubble expands the panel; clicking the panel's
 *     close button (or pressing `Escape` while focus is inside the
 *     panel) collapses back to the bubble.
 *   - The component is *uncontrolled* by default — internal `useState`
 *     drives the open/close — but consumers can lift state by passing
 *     `open` + `onOpenChange` (Radix-style controlled pattern). The
 *     `defaultOpen` prop seeds the initial uncontrolled value so an
 *     SSR / replay flow can restore "panel was open" without flicker.
 *   - Mobile-aware (per project policy — `useIsMobile`): below the
 *     `md` (768 px) breakpoint the panel widens to fill the viewport
 *     minus a comfortable inset, the touch targets bump to the 44×44 px
 *     a11y minimum, and the bubble shifts inward so it doesn't collide
 *     with the screen edge on phones.
 *
 * Styling follows project policy: shadcn `bg-primary` /
 * `text-primary-foreground` / `bg-card` / `border-border` /
 * `text-muted-foreground` tokens only — no hardcoded color classes —
 * so the floating chrome retheme automatically with light/dark.
 *
 * Layering note:
 *   The fixed wrapper uses `z-40` so the bubble sits above page content
 *   but below the shadcn Dialog/Sheet portals (`z-50`). This keeps any
 *   modal flow (notification drawer, agent edit sheet) on top of the
 *   chat panel — those flows take precedence and the chat persists in
 *   the background until they close.
 *
 * @module serve/spa/components/floating-chat-bubble
 */

import * as React from 'react';
import { MessageCircle, X } from 'lucide-react';

import * as ButtonModule from './ui/button.jsx';
import { cn } from '../lib/cn.js';
import { useIsMobile } from '../hooks/use-is-mobile.js';

// ── Cross-boundary shim for the still-`.jsx` shadcn Button primitive ──
//
// `components/ui/button.jsx` is the canonical shadcn primitive shipped
// as `.jsx` (per project policy: do not hand-edit those files). The TS
// compiler can't recover its prop types from the JSDoc + forwardRef
// destructure, so we re-alias it to a permissive `ComponentType` here.
// Once the `components/ui/*` migration lands these casts can be deleted.

type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost'
  | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};

const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;

// ── Public component ─────────────────────────────────────────────────

export interface FloatingChatBubbleProps {
  /**
   * Controlled open state. When provided the component becomes
   * controlled and `onOpenChange` is invoked on every toggle. When
   * omitted, the bubble manages its own state via `defaultOpen`.
   */
  open?: boolean;
  /**
   * Initial open state for the uncontrolled flow. Ignored when `open`
   * is provided. Defaults to `false` (collapsed bubble).
   */
  defaultOpen?: boolean;
  /**
   * Notified whenever the open state changes. Required when running in
   * controlled mode; optional in uncontrolled mode where it acts as a
   * change listener.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Slot rendered inside the expanded panel body. Subsequent sub-ACs
   * (thread list, conversation surface, composer, system-preamble
   * banner) plug in here; this sub-AC ships an empty-state placeholder
   * when no children are supplied so the toggle is independently
   * verifiable.
   */
  children?: React.ReactNode;
  /**
   * Title rendered in the panel header bar. Defaults to `"Chat"`.
   * Once thread-aware sub-ACs land this slot will surface the active
   * agent's display name.
   */
  title?: string;
  /**
   * Aria-label for the collapsed bubble trigger. Defaults to
   * `"Open chat"` for the closed state. The expanded close button
   * always uses `"Close chat"` for consistency with shadcn Dialog.
   */
  triggerLabel?: string;
  /**
   * Caller-supplied className merged onto the fixed-position wrapper
   * (NOT the bubble or panel themselves). Useful for tweaking the
   * z-index or anchor offset in embedding contexts.
   */
  className?: string;
}

/**
 * Floating chat bubble + expandable panel shell.
 *
 * Renders one of two surfaces:
 *   1. **Collapsed** — a circular `Button` with a chat icon, anchored
 *      to the bottom-right corner of the viewport.
 *   2. **Expanded** — a card-like panel (header + body + footer slot)
 *      anchored to the same corner, sized for desktop (`w-96`) or
 *      filling most of the viewport on mobile.
 *
 * The component owns the toggle wiring only. The thread list,
 * messages, composer, and SSE wiring all land in subsequent sub-ACs
 * via the `children` slot.
 */
export function FloatingChatBubble({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  children,
  title = 'Chat',
  triggerLabel = 'Open chat',
  className,
}: FloatingChatBubbleProps = {}): React.ReactElement {
  const [uncontrolledOpen, setUncontrolledOpen] =
    React.useState<boolean>(defaultOpen);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? (controlledOpen as boolean) : uncontrolledOpen;

  const setOpen = React.useCallback(
    (next: boolean): void => {
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const isMobile = useIsMobile();

  // Close on Escape when the panel is open and focus is anywhere in
  // the panel subtree (matches shadcn Dialog ergonomics). We attach
  // the listener at the document level so the panel collapses even if
  // focus has briefly left the container — this is a chat panel, not
  // a modal trap, and the keyboard shortcut should be forgiving.
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, setOpen]);

  return (
    <div
      data-component="floating-chat-bubble"
      data-state={open ? 'open' : 'closed'}
      data-mobile={isMobile ? 'true' : 'false'}
      // `pointer-events-none` on the wrapper + `pointer-events-auto`
      // on each interactive surface lets the bubble/panel float over
      // page content without blocking clicks on the dashboard around
      // their bounding boxes (the wrapper itself is `inset-0`-style
      // bottom/right anchored, but the bubble can be far smaller than
      // its hit-test rect would suggest).
      className={cn(
        'pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2',
        isMobile && 'bottom-3 right-3',
        className,
      )}
    >
      {open ? (
        <ExpandedPanel
          title={title}
          isMobile={isMobile}
          onClose={() => setOpen(false)}
        >
          {children}
        </ExpandedPanel>
      ) : (
        <CollapsedBubble
          isMobile={isMobile}
          ariaLabel={triggerLabel}
          onClick={() => setOpen(true)}
        />
      )}
    </div>
  );
}

export default FloatingChatBubble;

// ── Subcomponents ────────────────────────────────────────────────────

interface CollapsedBubbleProps {
  isMobile: boolean;
  ariaLabel: string;
  onClick: () => void;
}

function CollapsedBubble({
  isMobile,
  ariaLabel,
  onClick,
}: CollapsedBubbleProps): React.ReactElement {
  // The shadcn `size="icon"` recipe is `h-10 w-10` (40 × 40 px). Mobile
  // a11y wants ≥ 44 × 44 px, so override on the narrow breakpoint.
  // Desktop keeps the canonical 40 px; both surfaces remain perfectly
  // circular via `rounded-full`.
  const sizeClass = isMobile
    ? 'h-14 w-14 [&_svg]:size-6'
    : 'h-12 w-12 [&_svg]:size-5';

  return (
    <Button
      type="button"
      variant="default"
      size="icon"
      data-component="floating-chat-bubble-trigger"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        // `pointer-events-auto` reverses the wrapper's `none` so the
        // bubble itself is clickable.
        'pointer-events-auto rounded-full shadow-lg shadow-primary/30',
        sizeClass,
      )}
    >
      <MessageCircle aria-hidden="true" />
      <span className="sr-only">{ariaLabel}</span>
    </Button>
  );
}

interface ExpandedPanelProps {
  title: string;
  isMobile: boolean;
  onClose: () => void;
  children?: React.ReactNode;
}

function ExpandedPanel({
  title,
  isMobile,
  onClose,
  children,
}: ExpandedPanelProps): React.ReactElement {
  // Panel sizing:
  //   - Desktop: a fixed `w-96 h-[36rem]` card so the panel docks in
  //     the bottom-right without stealing screen real estate from the
  //     dashboard pages behind it.
  //   - Mobile: a near-full-viewport surface (`w-[calc(100vw-1.5rem)]`
  //     × `h-[calc(100svh-6rem)]`) that respects the safe inset and
  //     leaves the header / sidebar trigger reachable above it.
  const panelSizeClass = isMobile
    ? 'h-[calc(100svh-6rem)] w-[calc(100vw-1.5rem)] max-w-md'
    : 'h-[36rem] w-96 max-h-[calc(100svh-2rem)]';

  return (
    <div
      data-component="floating-chat-bubble-panel"
      role="dialog"
      aria-label={`${title} panel`}
      // `pointer-events-auto` reverses the wrapper's `none` for the
      // panel surface so its controls are interactive.
      className={cn(
        'pointer-events-auto flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl shadow-foreground/10',
        panelSizeClass,
      )}
    >
      <header
        data-component="floating-chat-bubble-panel-header"
        className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircle
            className="h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="truncate text-sm font-semibold leading-none">
            {title}
          </h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-component="floating-chat-bubble-close"
          aria-label="Close chat"
          title="Close chat"
          onClick={onClose}
          className={cn(
            // Bump the close target to 44×44 px on mobile per the
            // project's touch-target policy; keep desktop at the
            // canonical shadcn icon-button size (40×40 px) so the
            // visual rhythm matches the header bell.
            isMobile ? 'h-11 w-11' : 'h-8 w-8 [&_svg]:size-4',
          )}
        >
          <X aria-hidden="true" />
          <span className="sr-only">Close chat</span>
        </Button>
      </header>
      <div
        data-component="floating-chat-bubble-panel-body"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {children ?? <PanelPlaceholder />}
      </div>
    </div>
  );
}

/**
 * Empty-state body shown when no `children` slot has been wired in yet.
 *
 * Sub-AC 1 ships the toggle behaviour only; subsequent sub-ACs replace
 * this placeholder with the thread list and conversation surface.
 * Keeping a self-contained empty state here means the bubble can be
 * mounted into the layout immediately for visual integration testing
 * without a half-built chat surface bleeding into the rest of the SPA.
 */
function PanelPlaceholder(): React.ReactElement {
  return (
    <div
      data-component="floating-chat-bubble-panel-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground"
    >
      <MessageCircle className="h-8 w-8 opacity-60" aria-hidden="true" />
      <p>Chat surface coming soon.</p>
      <p className="text-xs italic">
        Conversation, threads, and tool invocations land in upcoming
        sub-ACs.
      </p>
    </div>
  );
}
