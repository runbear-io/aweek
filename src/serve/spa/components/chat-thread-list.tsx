/**
 * `ChatThreadList` — thread sidebar for the floating chat panel.
 *
 * Sub-AC 3 of AC 5: render every persisted conversation for the
 * currently-selected agent as a vertical list with a stable
 * "selected" highlight on the active thread. The list is the third
 * region inside the floating panel (picker bar → thread list → active
 * thread surface) and is the surface the user touches to switch
 * between conversations without leaving the panel.
 *
 * Responsibilities:
 *   1. Render the threads provided by the parent (sourced via
 *      `useAgentThreads(slug)` upstream — keeping the data hook out of
 *      this component lets unit tests pass a fixture roster directly).
 *   2. Visually mark the active thread (`activeThreadId === thread.id`)
 *      via a `bg-accent` surface + `aria-current="true"` so both
 *      sighted users and assistive tech see the same selection state.
 *   3. Surface keyboard + click selection through `onSelect` so the
 *      panel parent can update the route / chat-stream slug on switch.
 *   4. Render a stable empty / loading / error state so the sidebar
 *      doesn't collapse out from under the user when the agent has no
 *      threads yet.
 *
 * Append-only contract: this component does NOT mutate threads. The
 * v1 panel offers no rename / delete affordance from this surface —
 * those land in follow-up sub-ACs that wire mutation buttons inline
 * on each row. Until then the list stays read-only and the only way
 * to remove a thread is via the (still-to-land) thread-detail menu.
 *
 * Mobile-aware: each row inflates to a 44 px touch target on mobile
 * (per the project's a11y policy enforced at `< 768 px`) so the list
 * remains comfortably tappable without crowding the panel chrome.
 *
 * Styling follows project policy: shadcn theme tokens only
 * (`bg-card`, `bg-accent`, `text-muted-foreground`, `border-border`,
 * …) — no hardcoded colour classes. The active-row highlight uses the
 * canonical shadcn `bg-accent text-accent-foreground` pair so it
 * picks up the user's theme cleanly.
 *
 * @module serve/spa/components/chat-thread-list
 */

import * as React from 'react';
import { Loader2, MessageSquare } from 'lucide-react';

import { cn } from '../lib/cn.js';
import type { ChatThreadSummary } from '../lib/api-client.js';

// ── Public types ─────────────────────────────────────────────────────

export interface ChatThreadListProps {
  /**
   * Sorted (newest-first) thread summaries for the active agent. The
   * parent fetches these via `useAgentThreads(slug).data?.threads` and
   * forwards them verbatim — this component does not re-sort or
   * filter.
   */
  threads: ReadonlyArray<ChatThreadSummary>;
  /**
   * Currently-selected thread id. The matching row gets the active
   * highlight + `aria-current="true"`. Pass `null` when no thread is
   * selected (e.g. fresh open with no persisted selection); the list
   * still renders but no row is highlighted.
   */
  activeThreadId?: string | null;
  /**
   * Click / keyboard-activation handler. Fires with the thread's id
   * when a row is selected. The parent typically routes the change
   * through a `setSelectedThreadId` setter that drives both the local
   * highlight and the active `<ChatThread>` mount below.
   */
  onSelect?: (threadId: string) => void;
  /**
   * `true` while the threads are loading. The component renders a
   * stable spinner row instead of a flashing "no threads" empty
   * state. When `threads` is non-empty, the loading state is
   * suppressed in favour of the cached list (background refreshes
   * shouldn't blank the sidebar).
   */
  loading?: boolean;
  /**
   * Optional error to surface when the fetch failed. Renders an
   * inline destructive banner above the empty state. The parent can
   * still pass a stale `threads` array — the banner sits above
   * whatever was last successfully loaded.
   */
  error?: Error | null;
  /**
   * className merged onto the wrapping `<nav>` element.
   */
  className?: string;
  /**
   * Mobile viewport flag. Bumps each row to a 44 px touch target so
   * the list remains tappable on phones. Defaults to `false`. The
   * panel parent resolves this via `useIsMobile()` and threads it
   * down so this component stays presentational.
   */
  isMobile?: boolean;
}

// ── Public component ────────────────────────────────────────────────

/**
 * Vertical thread list surface. See module header for the contract.
 */
export function ChatThreadList({
  threads,
  activeThreadId = null,
  onSelect,
  loading = false,
  error = null,
  className,
  isMobile = false,
}: ChatThreadListProps): React.ReactElement {
  // Resolve the visible state. Loading + non-empty cache: render the
  // cached list (background refresh shouldn't blank the sidebar).
  // Loading + empty cache: render the spinner row. Error wins over
  // empty state when both are present.
  const showLoadingPlaceholder = loading && threads.length === 0;
  const showEmptyState = !showLoadingPlaceholder && threads.length === 0;

  return (
    <nav
      data-component="chat-thread-list"
      data-loading={loading ? 'true' : 'false'}
      data-empty={threads.length === 0 ? 'true' : 'false'}
      aria-label="Chat threads"
      className={cn(
        // Border separator between the picker row above + the active
        // thread surface below; `shrink-0` keeps it from stealing
        // height from the elastic body region.
        'flex shrink-0 flex-col border-b border-border bg-muted/10',
        className,
      )}
    >
      {error ? (
        <p
          data-component="chat-thread-list-error"
          role="alert"
          className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          {formatThreadsError(error)}
        </p>
      ) : null}

      {showLoadingPlaceholder ? (
        <div
          data-component="chat-thread-list-loading"
          className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          <span>Loading threads…</span>
        </div>
      ) : null}

      {showEmptyState ? (
        <div
          data-component="chat-thread-list-empty"
          className="px-4 py-3 text-xs italic text-muted-foreground"
        >
          No conversations yet.
        </div>
      ) : null}

      {threads.length > 0 ? (
        <ul
          data-component="chat-thread-list-items"
          className="flex max-h-32 flex-col overflow-y-auto"
        >
          {threads.map((thread) => (
            <ChatThreadListRow
              key={thread.id}
              thread={thread}
              isActive={thread.id === activeThreadId}
              onSelect={onSelect}
              isMobile={isMobile}
            />
          ))}
        </ul>
      ) : null}
    </nav>
  );
}

export default ChatThreadList;

// ── Subcomponents ────────────────────────────────────────────────────

interface ChatThreadListRowProps {
  thread: ChatThreadSummary;
  isActive: boolean;
  onSelect?: (threadId: string) => void;
  isMobile: boolean;
}

/**
 * A single selectable row in the thread list.
 *
 * Renders as a real `<button>` so keyboard navigation, focus rings,
 * and screen-reader semantics come for free. The active row carries
 * `aria-current="true"` so assistive tech can announce the selection
 * without relying on the visual highlight.
 */
function ChatThreadListRow({
  thread,
  isActive,
  onSelect,
  isMobile,
}: ChatThreadListRowProps): React.ReactElement {
  const handleClick = React.useCallback(() => {
    onSelect?.(thread.id);
  }, [onSelect, thread.id]);

  const label = resolveThreadLabel(thread);
  const preview = thread.lastMessagePreview?.trim() ?? '';

  return (
    <li
      data-component="chat-thread-list-item"
      data-thread-id={thread.id}
      data-active={isActive ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={handleClick}
        // `aria-current` is the canonical way to expose selection
        // inside a list of equivalent navigation items. Pairs with
        // the visual highlight so sighted users and AT users see the
        // same state.
        aria-current={isActive ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-0.5 border-b border-border/50 px-4 py-2 text-left text-xs',
          'transition-colors duration-100',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0',
          // 44 px floor on mobile per the project's touch-target policy.
          isMobile ? 'min-h-[44px]' : '',
          isActive
            ? 'bg-accent text-accent-foreground'
            : 'bg-transparent text-foreground hover:bg-muted/50',
        )}
      >
        <span className="flex items-center gap-2">
          <MessageSquare
            className={cn(
              'h-3 w-3 shrink-0',
              isActive ? 'text-accent-foreground' : 'text-muted-foreground',
            )}
            aria-hidden="true"
          />
          <span
            data-component="chat-thread-list-item-label"
            className="truncate font-medium"
          >
            {label}
          </span>
        </span>
        {preview ? (
          <span
            data-component="chat-thread-list-item-preview"
            className={cn(
              'pl-5 truncate',
              isActive
                ? 'text-accent-foreground/80'
                : 'text-muted-foreground',
            )}
          >
            {preview}
          </span>
        ) : null}
      </button>
    </li>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a friendly label for a thread row. Prefers the user-edited
 * `title`, falls back to the truncated last-message preview, then to a
 * short "New chat" stub when the thread is brand new (no messages
 * yet). The thread id is intentionally never surfaced — it's a
 * filename, not a label.
 */
function resolveThreadLabel(thread: ChatThreadSummary): string {
  const title = thread.title?.trim();
  if (title) return title;
  const preview = thread.lastMessagePreview?.trim();
  if (preview) {
    // Cap the fallback label so a verbose preview doesn't break the
    // truncate styling on narrow panel widths.
    return preview.length > 40 ? `${preview.slice(0, 39)}…` : preview;
  }
  return 'New chat';
}

/**
 * Render a thread-list error into a short user-facing string. The
 * api-client already produces concise messages on the underlying
 * `ApiError`; we surface them verbatim and trim the runaway path.
 */
function formatThreadsError(err: Error): string {
  const message = (err?.message ?? '').trim();
  if (!message) return 'Could not load threads.';
  if (message.length > 120) return `${message.slice(0, 117)}…`;
  return message;
}

// ── Test-facing internals ────────────────────────────────────────────

export const __test = {
  resolveThreadLabel,
  formatThreadsError,
} as const;
