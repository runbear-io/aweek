/**
 * `NotificationBell` — header bell trigger with unread-count badge that
 * opens a side drawer (shadcn `Sheet`) listing recent notifications.
 *
 * Wires the dashboard's persistent inbox affordance into the application
 * top bar. The bell is rendered inside the shared `Header` (via
 * `Layout`'s `actions` slot) so it appears on every page without the
 * caller threading it through.
 *
 * Behaviour:
 *   - Badge surfaces `data?.unreadCount` from {@link useGlobalNotifications}.
 *     Hidden when the count is `0`; capped at `99+` for layout stability.
 *   - Clicking the bell opens a right-anchored shadcn `Sheet` rendering
 *     a newest-first scrollable list of the global feed (max 10 rows
 *     for the drawer surface — the full feed lives at `/notifications`
 *     once Sub-AC 1/4 lands).
 *   - The drawer is purely a viewer in v1: read-only, no reply/approve/
 *     reject controls (per the AC 8 contract). Mark-read is a sibling
 *     sub-AC; this trigger only renders the trigger + drawer shell.
 *
 * Architectural decoupling note (AC 17):
 *   This component is a *read-only* client of `useGlobalNotifications`.
 *   It never reaches into `NotificationStore` or any storage module —
 *   storage and delivery stay decoupled, so future external push
 *   channels (Slack, email, OS push) plug in below the storage layer
 *   without touching this component.
 *
 * Styling uses canonical shadcn token utilities only — `bg-background`,
 * `text-foreground`, `text-muted-foreground`, `border-border`,
 * `bg-destructive`, `text-destructive-foreground` — so the control
 * re-themes for free under the active light/dark palette.
 *
 * @module serve/spa/components/notification-bell
 */

import * as React from 'react';
import { Bell } from 'lucide-react';

import * as ButtonModule from './ui/button.jsx';
import * as SheetModule from './ui/sheet.jsx';
import { cn } from '../lib/cn.js';
import { markNotificationRead } from '../lib/api-client.js';
import {
  useGlobalNotifications,
  type GlobalNotificationRow,
  type UseGlobalNotificationsOptions,
} from '../hooks/use-global-notifications.js';
import { NotificationList } from './notification-list.js';
import { formatRelativeTime as formatRelativeTimeShared } from '../lib/notification-format.js';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────
//
// `components/ui/button.jsx` and `components/ui/sheet.jsx` use
// `React.forwardRef` with destructured params — TypeScript can't recover
// proper prop types from those `.jsx` files. The migration plan
// explicitly allows inline shims for this case; we re-alias each used
// primitive to a permissive `ComponentType` here. Once `components/ui/*`
// is converted in a later sub-AC, these casts can be deleted and the
// real types take over.

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

type SheetRootProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
};
type SheetContentProps = React.HTMLAttributes<HTMLDivElement> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
};
type SheetHeaderProps = React.HTMLAttributes<HTMLDivElement>;
type SheetTitleProps = React.HTMLAttributes<HTMLHeadingElement>;
type SheetDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;
const Sheet = SheetModule.Sheet as React.ComponentType<SheetRootProps>;
const SheetContent =
  SheetModule.SheetContent as React.ComponentType<SheetContentProps>;
const SheetHeader =
  SheetModule.SheetHeader as React.ComponentType<SheetHeaderProps>;
const SheetTitle = SheetModule.SheetTitle as React.ComponentType<SheetTitleProps>;
const SheetDescription =
  SheetModule.SheetDescription as React.ComponentType<SheetDescriptionProps>;

// ── Constants ────────────────────────────────────────────────────────

/**
 * Drawer-surface row cap. The persistent inbox view (Sub-AC 1/4) shows
 * the full list with filtering; the drawer is a quick-glance affordance.
 * 10 rows fits the right-anchored sheet without forcing a tall scroll.
 */
const DRAWER_ROW_LIMIT = 10;

/**
 * Format the unread count for the badge. Anything above 99 collapses to
 * `99+` so the badge stays inside its small chip footprint.
 */
export function formatUnreadCount(count: number | null | undefined): string {
  const n = typeof count === 'number' && Number.isFinite(count) ? count : 0;
  if (n <= 0) return '0';
  if (n > 99) return '99+';
  return String(n);
}

// ── Public component ─────────────────────────────────────────────────

export interface NotificationBellProps {
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
  /** Caller-supplied class names merged onto the trigger button. */
  className?: string;
}

/**
 * Header bell trigger.
 *
 * The trigger is a stock shadcn `ghost` icon button with an absolutely
 * positioned destructive badge in the top-right corner. The badge is
 * `aria-hidden` because the unread count is also embedded in the
 * trigger's `aria-label` so screen readers announce it without reading
 * the visual chip text.
 */
export function NotificationBell({
  baseUrl,
  fetch: fetchImpl,
  className,
}: NotificationBellProps = {}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const opts: UseGlobalNotificationsOptions = {};
  if (baseUrl !== undefined) opts.baseUrl = baseUrl;
  if (fetchImpl !== undefined) opts.fetch = fetchImpl;
  const { data, error, loading, refresh } = useGlobalNotifications(opts);

  const unread = data?.unreadCount ?? 0;
  const rows: ReadonlyArray<GlobalNotificationRow> = data?.notifications ?? [];
  const visibleRows = rows.slice(0, DRAWER_ROW_LIMIT);
  const totalCount = rows.length;

  const ariaLabel =
    unread > 0
      ? `Notifications — ${unread} unread`
      : 'Notifications';

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/*
        We intentionally don't wrap the trigger in `SheetTrigger asChild`
        here because controlling `open` via React state is sufficient and
        keeps the trigger a plain shadcn `Button` (so its `data-component`,
        `data-size`, and `data-variant` attributes stay queryable in tests
        without an extra Slot indirection).
      */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-component="notification-bell"
        data-unread-count={String(unread)}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen(true)}
        className={cn('relative', className)}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unread > 0 ? (
          <span
            data-component="notification-bell-badge"
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-background bg-destructive px-1 text-[10px] font-semibold leading-none tabular-nums text-destructive-foreground"
          >
            {formatUnreadCount(unread)}
          </span>
        ) : null}
        <span className="sr-only">{ariaLabel}</span>
      </Button>
      <SheetContent
        side="right"
        data-component="notification-bell-drawer"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border px-6 py-4 text-left">
          <SheetTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4" aria-hidden="true" />
            <span>Notifications</span>
            {unread > 0 ? (
              <span
                data-component="notification-bell-drawer-unread"
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-semibold tabular-nums text-destructive-foreground"
              >
                {formatUnreadCount(unread)}
              </span>
            ) : null}
          </SheetTitle>
          <SheetDescription>
            {unread > 0
              ? `${unread} unread · ${totalCount} total`
              : totalCount > 0
                ? `${totalCount} notification${totalCount === 1 ? '' : 's'}`
                : 'No notifications yet.'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {error && rows.length === 0 ? (
            <DrawerError error={error} onRetry={refresh} />
          ) : loading && rows.length === 0 ? (
            <DrawerSkeleton />
          ) : rows.length === 0 ? (
            <DrawerEmpty />
          ) : (
            <NotificationList
              notifications={visibleRows}
              onSelect={(row) => {
                if (row.read === true) return;
                const opts: Parameters<typeof markNotificationRead>[2] = {};
                if (baseUrl !== undefined) opts.baseUrl = baseUrl;
                if (fetchImpl !== undefined) opts.fetch = fetchImpl;
                const agent = row.agent ?? row.agentId ?? '';
                if (!agent) return;
                markNotificationRead(agent, row.id, opts)
                  .then(() => {
                    void refresh();
                  })
                  .catch(() => {
                    // Swallow — next refresh tick reconciles, the row stays
                    // unread so the user can retry.
                  });
              }}
            />
          )}
        </div>
        {error && rows.length > 0 ? (
          <DrawerStaleBanner error={error} onRetry={refresh} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export default NotificationBell;

// ── Drawer subcomponents ─────────────────────────────────────────────

function DrawerEmpty(): React.ReactElement {
  return (
    <div
      data-component="notification-bell-empty"
      className="flex flex-1 items-center justify-center px-6 py-12 text-center text-sm italic text-muted-foreground"
    >
      No notifications yet. Agents will surface updates here as they
      run.
    </div>
  );
}

function DrawerSkeleton(): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      data-component="notification-bell-loading"
      className="flex flex-1 items-center justify-center px-6 py-12 text-sm italic text-muted-foreground"
    >
      Loading notifications…
    </div>
  );
}

interface DrawerErrorProps {
  error: Error | { message?: string } | null;
  onRetry: () => void | Promise<void>;
}

function DrawerError({ error, onRetry }: DrawerErrorProps): React.ReactElement {
  const message =
    (error && typeof error === 'object' && 'message' in error
      ? (error as { message?: string }).message
      : null) || String(error);
  return (
    <div
      role="alert"
      data-component="notification-bell-error"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-destructive"
    >
      <span>Failed to load notifications.</span>
      <span className="text-xs text-destructive/80">{message}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void onRetry();
        }}
      >
        Retry
      </Button>
    </div>
  );
}

function DrawerStaleBanner({
  error,
  onRetry,
}: DrawerErrorProps): React.ReactElement {
  const message =
    (error && typeof error === 'object' && 'message' in error
      ? (error as { message?: string }).message
      : null) || 'unknown error';
  return (
    <div
      role="alert"
      data-component="notification-bell-stale"
      className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-6 py-2 text-[11px] text-muted-foreground"
    >
      <span>Refresh failed ({message}) — showing last-known data.</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-[11px]"
        onClick={() => {
          void onRetry();
        }}
      >
        Retry
      </Button>
    </div>
  );
}

// ── Time helpers ─────────────────────────────────────────────────────

/**
 * Re-export of the canonical formatter in `lib/notification-format` so
 * the bell's existing test suite (`notification-bell.test.tsx`) can keep
 * pinning the rounding contract without reaching into `lib/`. There is
 * exactly one implementation now — the shared one — and the inline
 * duplicate that used to live here was deleted.
 */
export const formatRelativeTime = formatRelativeTimeShared;
