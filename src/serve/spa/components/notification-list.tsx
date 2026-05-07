/**
 * `NotificationList` — pure, presentational notification feed renderer.
 *
 * This is the canonical reverse-chronological list surface for the
 * notification subsystem (AC 8, Sub-AC 4). It accepts pre-fetched rows
 * from {@link import('../hooks/use-global-notifications').useGlobalNotifications}
 * (or any other loader that produces the same shape) and renders:
 *
 *   - A reverse-chronological list of rows (newest first), defensively
 *     re-sorted at render time so a caller passing an unsorted array
 *     still produces a deterministic UI.
 *   - An empty-state slot when the array is empty.
 *   - An optional `limit` cap (the bell drawer uses `limit=10`; the
 *     full inbox view does not pass `limit` and renders everything).
 *   - Each row in a "list/badge view" by default — title only, with the
 *     body hidden until the user opens it (AC 14). A chevron toggle
 *     reveals/hides the full body text. The toggle stops event
 *     propagation so it never accidentally fires the row-level
 *     `onSelect` (which is the AC 12 mark-as-read action).
 *
 * The component is intentionally read-only relative to the storage
 * layer and contains no data-fetching and no side effects beyond the
 * optional `onSelect` callback. The expand/collapse state is purely
 * client-side (per-row `useState`), so it never round-trips through
 * `NotificationStore`. Storage and delivery stay decoupled (AC 17):
 * this component never imports `NotificationStore` or any storage
 * module — the caller threads in the rows.
 *
 * Reused surfaces:
 *   - `NotificationBell` drawer body (Sub-AC 3 — already shipped; will
 *     eventually delegate its inline `DrawerList` to this component).
 *   - The standalone inbox page (sibling sub-AC) — global feed.
 *   - The per-agent notifications tab (sibling sub-AC) — agent-scoped
 *     feed (`hideAgentLabel` collapses the per-row slug chip when the
 *     parent surface already shows the agent in its header).
 *
 * Styling uses canonical shadcn token utilities only — `bg-muted`,
 * `text-foreground`, `text-muted-foreground`, `border-border`,
 * `bg-destructive` — so the list re-themes for free under the active
 * light / dark palette.
 *
 * @module serve/spa/components/notification-list
 */

import * as React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '../lib/cn.js';
import { formatRelativeTime } from '../lib/notification-format.js';

// ── Row shape ────────────────────────────────────────────────────────

/**
 * Minimum row shape this component renders. Compatible with both the
 * global feed's {@link import('../lib/api-client').NotificationWithAgentRow}
 * (which adds `agent: string`) and the per-agent feed's
 * {@link import('../lib/api-client').NotificationRow} (which only carries
 * `agentId`).
 *
 * Kept loose on purpose: the SPA-facing wire shape can absorb future
 * schema additions (priority, category, action buttons, retention
 * metadata) without forcing a lockstep update at this typedef. The
 * fields the list actively renders are still pinned by name + type.
 */
export interface NotificationListItem {
  /** Stable id used as the React key. */
  id: string;
  /** Free-form title supplied by the agent or system event emitter. */
  title: string;
  /** Optional body — rendered in a 2-line clamp; falls back to "" if absent. */
  body?: string;
  /** ISO timestamp — drives the relative-time chip and the row sort. */
  createdAt: string;
  /** Whether the user has read this notification. Defaults to `false`. */
  read?: boolean;
  /** Agent slug (global feed). */
  agent?: string;
  /** Agent id (per-agent feed). */
  agentId?: string;
  /** `'agent' | 'system'` (loosely typed so future sources pass through). */
  source?: string;
  /** System event id when `source === 'system'`. */
  systemEvent?: string;
  /**
   * Optional severity hint — `'info' | 'warning' | 'error'`. Loosely
   * typed (string) so future severities pass through; the renderer
   * recognises `'warning'` and `'error'` for amber / red variants and
   * falls back to the canonical info styling for everything else
   * (including absent / unknown values).
   */
  severity?: string;
}

// ── Props ────────────────────────────────────────────────────────────

export interface NotificationListProps {
  /** Notifications to render (any order — the component re-sorts newest-first). */
  notifications: ReadonlyArray<NotificationListItem>;
  /** Cap the visible row count after the reverse-chrono sort. */
  limit?: number;
  /** Override the default empty-state copy. */
  emptyMessage?: string;
  /**
   * When `true`, suppresses the per-row agent slug chip — useful when
   * the parent surface already pins the agent (per-agent inbox tab).
   */
  hideAgentLabel?: boolean;
  /**
   * When `true`, every row mounts with its body expanded. Defaults to
   * `false` — AC 14's contract is *title-only in list/badge view, body
   * on expand*. Callers that want a permanently expanded surface (e.g.
   * a single-notification detail page) can flip this on.
   */
  defaultExpanded?: boolean;
  /** Caller-supplied class names merged onto the `<ul>` root. */
  className?: string;
  /**
   * Optional click handler. When provided, each row becomes a `button`
   * (role + tabIndex) and fires the callback with the row data on
   * click / Enter / Space.
   */
  onSelect?: (notification: NotificationListItem) => void;
  /**
   * Reference time injected by tests so `formatRelativeTime` produces a
   * deterministic chip without freezing the system clock. Defaults to
   * the formatter's own `new Date()`.
   */
  now?: Date;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Parse an ISO timestamp to epoch ms. Unparseable / missing → 0 so the
 * row sorts to the end under the newest-first comparator (matches
 * `ActivityTimeline.buildTimeline`'s contract).
 */
function parseTimestampMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Defensive reverse-chronological sort. Stable: rows with equal
 * timestamps preserve input order so the output is deterministic
 * (callers can rely on a snapshot).
 *
 * Exported for the colocated test suite.
 */
export function sortNewestFirst<T extends { createdAt?: string | null }>(
  rows: ReadonlyArray<T>,
): T[] {
  // Decorate-sort-undecorate to keep the comparator pure and stable
  // across V8's TimSort — equal `sortKey` rows fall back to their input
  // index so the output is order-preserving on ties.
  const decorated = rows.map((row, idx) => ({
    row,
    idx,
    sortKey: parseTimestampMs(row?.createdAt ?? null),
  }));
  decorated.sort((a, b) => {
    if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
    return a.idx - b.idx;
  });
  return decorated.map((entry) => entry.row);
}

// ── Public component ─────────────────────────────────────────────────

/**
 * Reusable notification list.
 *
 * @example
 *   const { data } = useGlobalNotifications();
 *   return (
 *     <NotificationList
 *       notifications={data?.notifications ?? []}
 *       limit={10}
 *       onSelect={(n) => navigate(`/notifications/${n.agent}/${n.id}`)}
 *     />
 *   );
 */
export function NotificationList({
  notifications,
  limit,
  emptyMessage,
  hideAgentLabel = false,
  defaultExpanded = false,
  className,
  onSelect,
  now,
}: NotificationListProps): React.ReactElement {
  // Defensive sort: even though the API returns newest-first, callers
  // (and tests) can pass arbitrary order — we re-sort so the visual
  // contract is independent of the loader.
  const sorted = React.useMemo(
    () => sortNewestFirst(notifications),
    [notifications],
  );
  const visible =
    typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
      ? sorted.slice(0, limit)
      : sorted;

  if (visible.length === 0) {
    return (
      <div
        data-component="notification-list-empty"
        className="flex flex-1 items-center justify-center px-6 py-12 text-center text-sm italic text-muted-foreground"
      >
        {emptyMessage ??
          'No notifications yet. Agents will surface updates here as they run.'}
      </div>
    );
  }

  return (
    <ul
      role="list"
      aria-label="Notifications"
      data-component="notification-list"
      data-row-count={visible.length}
      className={cn('flex flex-col divide-y divide-border', className)}
    >
      {visible.map((notification) => (
        <NotificationListRow
          key={rowKey(notification)}
          notification={notification}
          hideAgentLabel={hideAgentLabel}
          defaultExpanded={defaultExpanded}
          onSelect={onSelect}
          now={now}
        />
      ))}
    </ul>
  );
}

export default NotificationList;

// ── Row renderer ─────────────────────────────────────────────────────

interface NotificationListRowProps {
  notification: NotificationListItem;
  hideAgentLabel: boolean;
  defaultExpanded: boolean;
  onSelect?: (notification: NotificationListItem) => void;
  now?: Date;
}

function NotificationListRow({
  notification,
  hideAgentLabel,
  defaultExpanded,
  onSelect,
  now,
}: NotificationListRowProps): React.ReactElement {
  // Per-row expand state. Defaults to the list-level `defaultExpanded`
  // prop so a parent can opt into an "all expanded" surface (e.g. a
  // single-notification detail view) while the standard list/badge view
  // keeps body text hidden until the user opts in (AC 14).
  const [expanded, setExpanded] = React.useState<boolean>(defaultExpanded);

  const hasBody =
    typeof notification.body === 'string' && notification.body.length > 0;
  const isExpanded = hasBody && expanded;
  const bodyId = `notification-body-${notification.id || notification.createdAt || 'row'}`;

  const clickable = typeof onSelect === 'function';
  const handleClick = clickable
    ? () => {
        onSelect!(notification);
      }
    : undefined;
  const handleKeyDown = clickable
    ? (event: React.KeyboardEvent<HTMLLIElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect!(notification);
        }
      }
    : undefined;

  /**
   * Expand-button event handlers — must `stopPropagation` so the click
   * (or Enter/Space keypress) toggles body visibility *without* also
   * firing the row-level `onSelect` (which is the AC 12 mark-as-read
   * action). Otherwise opening the body would also flip read state,
   * which the user did not necessarily intend.
   */
  const toggleExpanded = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    setExpanded((prev) => !prev);
  };
  const handleExpandKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      setExpanded((prev) => !prev);
    }
  };

  const isSystem = notification.source === 'system';
  const agentLabel = notification.agent || notification.agentId || '';
  const showAgentLabel = !hideAgentLabel && agentLabel.length > 0;
  const isUnread = notification.read !== true;
  const severity = notification.severity ?? 'info';
  const isWarning = severity === 'warning';
  const isError = severity === 'error';
  // Severity drives the row's background tint and the unread-dot color.
  // `warning` → amber, `error` → red, anything else → canonical muted.
  // Unread-only tinting layers on top so a read warning still reads as
  // a warning at a glance (while a read info row goes back to plain).
  const severityRowTint = isWarning
    ? 'bg-amber-500/10'
    : isError
      ? 'bg-red-500/10'
      : isUnread
        ? 'bg-muted/40'
        : '';
  const severityDotClass = isWarning
    ? 'bg-amber-400'
    : isError
      ? 'bg-red-500'
      : 'bg-destructive';

  return (
    <li
      data-component="notification-list-row"
      data-notification-id={notification.id}
      data-agent-slug={notification.agent ?? notification.agentId ?? ''}
      data-source={notification.source ?? ''}
      data-system-event={notification.systemEvent ?? ''}
      data-severity={severity}
      data-read={isUnread ? 'false' : 'true'}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-clickable={clickable ? 'true' : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex flex-col gap-1 px-6 py-3 text-sm',
        severityRowTint,
        clickable &&
          'cursor-pointer transition-colors hover:bg-muted/50 focus-within:bg-muted/50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'truncate text-sm',
            isUnread
              ? 'font-semibold text-foreground'
              : 'font-medium text-foreground',
          )}
        >
          {notification.title}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {isUnread ? (
            <span
              data-component="notification-list-row-unread-dot"
              data-severity={severity}
              aria-label="Unread"
              className={cn('inline-block h-2 w-2 rounded-full', severityDotClass)}
            />
          ) : null}
          {hasBody ? (
            <button
              type="button"
              data-component="notification-list-row-expand-toggle"
              data-expanded={isExpanded ? 'true' : 'false'}
              aria-expanded={isExpanded}
              aria-controls={bodyId}
              aria-label={isExpanded ? 'Collapse notification body' : 'Expand notification body'}
              onClick={toggleExpanded}
              onKeyDown={handleExpandKeyDown}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
      </div>

      {/*
        Body is hidden in the default list/badge view (AC 14) and only
        rendered once the row is expanded. When expanded, we drop the
        2-line clamp so the user sees the full text — `whitespace-pre-wrap`
        preserves agent-supplied newlines, `break-words` keeps long
        unbroken tokens (URLs, ids) inside the row.
      */}
      {isExpanded ? (
        <p
          id={bodyId}
          data-component="notification-list-row-body"
          className="whitespace-pre-wrap break-words text-xs text-muted-foreground"
        >
          {notification.body}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">
          {showAgentLabel ? (
            <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-foreground">
              {agentLabel}
            </code>
          ) : null}
          {isSystem ? (
            <span
              className={cn(
                'uppercase tracking-wider',
                showAgentLabel && 'ml-1',
              )}
              data-component="notification-list-row-system-tag"
            >
              system
              {notification.systemEvent ? `: ${notification.systemEvent}` : ''}
            </span>
          ) : null}
        </span>
        <time dateTime={notification.createdAt}>
          {formatRelativeTime(notification.createdAt, now)}
        </time>
      </div>
    </li>
  );
}

/**
 * Build a stable React key. Falls back to a per-render index when both
 * `id` and `agent` are missing — should not normally occur (the schema
 * requires `id`), but the read-only dashboard stays forgiving.
 */
function rowKey(notification: NotificationListItem): string {
  const id = notification.id || '';
  const agent = notification.agent || notification.agentId || '';
  if (id && agent) return `${agent}:${id}`;
  if (id) return id;
  if (agent) return `${agent}:${notification.createdAt || ''}`;
  return notification.createdAt || Math.random().toString(36).slice(2);
}
