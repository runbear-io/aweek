/**
 * `FloatingChatPanel` — composite contents for the floating chat
 * bubble's expanded panel (AC 10).
 *
 * Combines three independently-shipped primitives into a single mounted
 * tree:
 *
 *   1. `useChatAgentSelection` (Sub-AC of AC 10) resolves the slug the
 *      panel should currently target — explicit user selection from the
 *      `ChatPanelContext`, falling back to the URL when the user is on
 *      `/agents/:slug/*`, and to the first agent in the roster otherwise.
 *   2. `ChatAgentPicker` (Sub-AC of AC 10) renders the dropdown that
 *      lets the user switch which agent the panel chats with.
 *   3. `ChatThread` (Sub-AC 3 of AC 1) is the streaming chat surface
 *      itself — it owns the SSE transport, message list, composer, and
 *      stop button.
 *
 * The component is mounted inside the `FloatingChatBubble`'s `children`
 * slot. The bubble itself owns the panel chrome (header bar with the
 * agent name + close button); this component fills the body region
 * with a thin "Agent:" picker bar followed by the streaming thread.
 *
 * Resilience:
 *   - When the agent roster is still loading we render a placeholder
 *     row instead of the thread so the layout doesn't shift.
 *   - When the roster fails to load we surface the error inline (the
 *     picker swaps to its error state) and render an empty-state in
 *     the thread region so the user can retry by reopening the panel.
 *   - When no slug is resolvable (no explicit selection, no
 *     `/agents/:slug/*` route, AND the roster is genuinely empty) we
 *     show a "no agents yet" empty-state.
 *
 * The component re-keys its `<ChatThread>` on every effective slug
 * change so the thread state (in-flight message, composer text)
 * resets when the user switches agents — chat history per agent is
 * scoped to its slug, not shared across the floating panel.
 *
 * @module serve/spa/components/floating-chat-panel
 */

import * as React from 'react';
import { Plus } from 'lucide-react';

import { ChatAgentPicker } from './chat-agent-picker.tsx';
import { ChatThread } from './chat-thread.tsx';
import { ChatThreadList } from './chat-thread-list.tsx';
import { useChatPanelOptional } from './chat-panel-context.tsx';
import {
  useChatAgentSelection,
  type UseChatAgentSelectionResult,
} from '../hooks/use-chat-agent-selection.js';
import { useAgents } from '../hooks/use-agents.js';
import { useAgentThreads } from '../hooks/use-agent-threads.js';
import {
  createAgentThread,
  fetchAgentThread,
  type AgentListRow,
  type ChatMessageWire,
  type ChatThreadDocument,
  type ChatToolResultBlockWire,
  type ChatThreadSummary,
} from '../lib/api-client.js';
import type { ChatUIMessage } from '../hooks/use-chat-stream.js';
import { cn } from '../lib/cn.js';

/**
 * AC 13 default polling cadence for the agent roster while the
 * currently-selected agent is in a budget-locked state. Five seconds is
 * the sweet spot:
 *   - Fast enough that "I just ran `aweek manage resume`" feels
 *     responsive (composer re-enables before the user reaches for the
 *     reload key).
 *   - Slow enough that the SPA isn't hammering `/api/agents` while a
 *     paused agent sits in the panel for minutes.
 * Polling stops automatically the moment the roster reports the agent
 * back as `active`, so the steady-state cost in the happy path is
 * exactly zero requests per minute.
 */
export const BUDGET_REFRESH_INTERVAL_MS = 5000;

// ── Public types ─────────────────────────────────────────────────────

export interface FloatingChatPanelProps {
  /**
   * Test seam — overrides the agent selection hook return value. When
   * omitted, the component calls `useChatAgentSelection` itself
   * (production wiring). When provided, the test passes a stubbed
   * selection so it can pin the picker behaviour without standing up
   * a full router + provider tree.
   */
  selectionOverride?: UseChatAgentSelectionResult;
  /**
   * Test seam — overrides the agent list. When omitted, the component
   * calls `useAgents()`. When provided, tests can hand in a fixture
   * roster directly without stubbing `fetch`. When provided, AC 13
   * background polling is also disabled — tests pass a static fixture
   * and shouldn't be subject to wall-clock-driven refresh attempts.
   */
  agentsOverride?: {
    rows: ReadonlyArray<AgentListRow>;
    loading?: boolean;
    error?: Error | null;
  };
  /**
   * Test seam — overrides the props forwarded to `<ChatThread>`. The
   * default values come straight from the hook (`slug` only); tests
   * pass a custom `fetch`, `baseUrl`, etc. so the streaming path can
   * be exercised without a real server.
   */
  threadPropsOverride?: Partial<React.ComponentProps<typeof ChatThread>>;
  /**
   * AC 13 test / production tuning seam — override the background
   * polling cadence used to detect external `aweek manage resume` /
   * `top-up` flips. Defaults to {@link BUDGET_REFRESH_INTERVAL_MS}.
   * Pass `0` (or any non-positive value) to disable polling entirely
   * (tests do this so `setInterval` doesn't leak across runs).
   */
  budgetRefreshIntervalMs?: number;
  /**
   * Sub-AC 3 of AC 5 test seam — overrides the thread-list data hook
   * return value. When omitted, the component calls
   * `useAgentThreads(effectiveSlug)` itself (production wiring); when
   * provided, tests can hand in a fixture roster of thread summaries
   * without standing up `fetch`.
   */
  threadListOverride?: {
    threads: ReadonlyArray<ChatThreadSummary>;
    loading?: boolean;
    error?: Error | null;
  };
  /**
   * Sub-AC 3 of AC 5 — control which thread is currently highlighted
   * as the "active" row in the thread list. The `FloatingChatPanel`
   * itself is the single source of truth for thread selection in v1
   * (no router param yet); the panel forwards picks to
   * `onActiveThreadChange` so callers can persist the selection or
   * thread it through additional state.
   *
   * When omitted, the component manages its own selection internally
   * via `useState`. Pass an explicit `activeThreadId` (with or without
   * `onActiveThreadChange`) to lift state into the parent (e.g. the
   * future deep-link sub-AC).
   */
  activeThreadId?: string | null;
  /**
   * Sub-AC 3 of AC 5 — notified when the user picks a different
   * thread from the list. Receives the new thread id (or `null` if
   * the selection is cleared, e.g. by deleting the active thread in a
   * future sub-AC). Required when `activeThreadId` is provided
   * (controlled mode); optional otherwise (the internal `useState`
   * still updates).
   */
  onActiveThreadChange?: (threadId: string | null) => void;
  /**
   * Sub-AC 4 of AC 5 test seam — overrides the API call used to
   * fetch a single thread's full message history when the user picks
   * a thread row. Defaults to {@link fetchAgentThread}; tests pass a
   * stub so the hydration path can be exercised without standing up
   * `fetch`.
   */
  fetchThread?: (slug: string, threadId: string) => Promise<ChatThreadDocument>;
  /**
   * Sub-AC 4 of AC 5 test seam — overrides the API call used to
   * create a new (empty) thread when the user clicks the "New
   * thread" button. Defaults to {@link createAgentThread}; tests pass
   * a stub that returns a deterministic id so the post-create state
   * can be asserted without a real server.
   */
  createThread?: (
    slug: string,
    opts?: { title?: string },
  ) => Promise<ChatThreadDocument>;
  /**
   * Sub-AC 4 of AC 5 test seam — overrides the threads-list refresh
   * triggered after a successful create so the new row appears
   * immediately in the sidebar. Defaults to a no-op when `threadListOverride`
   * is supplied (tests typically rerender with an explicit roster);
   * production wiring uses {@link useAgentThreads}'s `refresh`
   * function via the live hook.
   */
  refreshThreadList?: () => Promise<unknown> | unknown;
  /**
   * When true, the panel auto-creates a default thread the first time
   * it lands on an agent with zero existing threads, so the user's
   * first message has a `threadId` to attach to and gets persisted to
   * disk. Without this, a fresh agent renders an empty composer with
   * no `threadId`, the chat POST goes out without one, the server's
   * persistence gate skips the write, and refreshing the page loses
   * the conversation. Defaults to `false` to keep the existing test
   * fixtures (which mount the panel with empty thread lists to assert
   * the empty state) unchanged; production wiring in `layout.tsx` opts
   * in.
   */
  autoCreateOnEmpty?: boolean;
  /** Class names merged onto the wrapping `<div>`. */
  className?: string;
}

// ── Public component ─────────────────────────────────────────────────

/**
 * Top-level contents rendered inside the floating chat bubble's body
 * slot. See the module header for the full contract.
 */
export function FloatingChatPanel({
  selectionOverride,
  agentsOverride,
  threadPropsOverride,
  budgetRefreshIntervalMs = BUDGET_REFRESH_INTERVAL_MS,
  threadListOverride,
  activeThreadId: controlledActiveThreadId,
  onActiveThreadChange,
  fetchThread: fetchThreadOverride,
  createThread: createThreadOverride,
  refreshThreadList: refreshThreadListOverride,
  autoCreateOnEmpty = false,
  className,
}: FloatingChatPanelProps = {}): React.ReactElement {
  // Sub-AC 2 of AC 12: per-agent active-thread persistence. We read
  // the context optionally so the panel still functions in test trees
  // / isolation harnesses that mount it without `<ChatPanelProvider>`
  // (the existing tests only wrap with the provider when they care
  // about the open / agent-slug state). When no provider is mounted
  // the persistence is a no-op — the in-memory state below still works
  // and the previous "auto-select first thread" behaviour applies.
  const chatPanel = useChatPanelOptional();

  // AC 13: poll cadence handed to `useAgents` so it auto-refreshes
  // the roster while the selected agent is in a budget-locked state.
  // Stored in `useState` (not a ref) so a status flip computed *below*
  // can flow back into `useAgents` on the next render via the
  // dependency-driven `useEffect` in the hook itself. The state value
  // is the single source of truth for "polling on or off, and how
  // fast" — see the `useEffect` below for the assignment path.
  const [pollCadence, setPollCadence] = React.useState<number>(0);

  // Live agent roster — either via the production hook or the test
  // override. We deliberately call BOTH hooks (`useAgents` always
  // runs, even when the override is present) so React sees a stable
  // hook order; the override simply takes precedence in the rendered
  // output.
  const live = useAgents({ pollIntervalMs: pollCadence });
  const agents = agentsOverride
    ? agentsOverride
    : {
        rows: live.data?.rows ?? [],
        loading: live.loading,
        error: live.error,
      };

  // First-roster-row fallback: when nothing else is resolvable, point
  // the picker at the first agent so a "fresh open with no URL slug"
  // experience still lands on a runnable thread instead of empty.
  const fallbackSlug = agents.rows[0]?.slug ?? null;

  const liveSelection = useChatAgentSelection({ fallbackSlug });
  const selection = selectionOverride ?? liveSelection;

  const { effectiveSlug, routeAgentSlug, source, setSelectedAgentSlug } =
    selection;

  // AC 13: derive the desired poll cadence from this render's snapshot
  // and push it back into the `pollCadence` state. We poll only when:
  //   1. Tests have NOT supplied a static `agentsOverride` fixture
  //      (the override path doesn't even read from `useAgents.data`,
  //      so a refresh would be wasted work — and worse, would leak a
  //      live `setInterval` past the test's lifetime).
  //   2. The currently-effective agent is in a budget-locked state
  //      (`paused` / `budget-exhausted`). Polling an active agent's
  //      status burns requests for no UX gain.
  //   3. The caller hasn't explicitly disabled polling by passing
  //      `budgetRefreshIntervalMs={0}`.
  // The setter's functional form (`prev => ...`) avoids dispatching
  // when the value hasn't changed — React bails out on identical
  // primitives so the steady state costs zero re-renders.
  const isLocked = effectiveSlug
    ? resolveAgentBudgetExhausted(agents.rows, effectiveSlug)
    : false;
  const desiredCadence =
    !agentsOverride && isLocked && budgetRefreshIntervalMs > 0
      ? budgetRefreshIntervalMs
      : 0;
  React.useEffect(() => {
    setPollCadence((prev) => (prev === desiredCadence ? prev : desiredCadence));
  }, [desiredCadence]);

  // Sub-AC 3 of AC 5: thread list. We always call `useAgentThreads`
  // (even when the test override is present) so React sees a stable
  // hook order; the override simply takes precedence in the rendered
  // output. The hook short-circuits when the slug is null/undefined
  // and reports an empty list with `loading: false`.
  const liveThreads = useAgentThreads(effectiveSlug ?? null);
  const threadList = threadListOverride
    ? threadListOverride
    : {
        threads: liveThreads.data?.threads ?? [],
        loading: liveThreads.loading,
        error: liveThreads.error,
      };

  // Sub-AC 3 of AC 5: active-thread selection. When the parent
  // controls the value (`controlledActiveThreadId !== undefined`) we
  // bypass the internal state and forward picks via
  // `onActiveThreadChange`. Otherwise we manage the selection
  // ourselves and pre-pick the first (most recently updated) thread
  // whenever the agent switches — the parent can still observe the
  // pick via the optional `onActiveThreadChange` listener.
  const isThreadControlled = controlledActiveThreadId !== undefined;
  const [internalActiveThreadId, setInternalActiveThreadId] = React.useState<
    string | null
  >(null);

  const activeThreadId = isThreadControlled
    ? (controlledActiveThreadId as string | null)
    : internalActiveThreadId;

  // Auto-select the active thread for the current agent. Sub-AC 2 of
  // AC 12 layered an extra priority step onto Sub-AC 3's first-thread
  // fallback so the panel hydrates the user's last-read thread when
  // the panel re-mounts (close + reopen, page refresh):
  //
  //   1. Keep the current pick when it still exists in the list.
  //   2. Otherwise, restore the per-agent active-thread id persisted
  //      via the chat-panel context (when the agent has one AND it
  //      still exists in the freshly-loaded list).
  //   3. Otherwise, fall back to the first thread (most-recently-
  //      updated by default) so a brand-new agent / cleared pin still
  //      lands on a runnable thread.
  //   4. When the list is empty, clear the selection so a stale id
  //      from a previous agent doesn't render an orphaned active row.
  //
  // Only runs in uncontrolled mode; controlled-mode parents own the
  // pick lifecycle (and are responsible for their own persistence).
  React.useEffect(() => {
    if (isThreadControlled) return;
    const list = threadList.threads;
    if (list.length === 0) {
      setInternalActiveThreadId((prev) => (prev === null ? prev : null));
      return;
    }
    if (
      internalActiveThreadId &&
      list.some((t) => t.id === internalActiveThreadId)
    ) {
      return; // current pick is still in the list — keep it.
    }
    // Sub-AC 2 of AC 12: prefer the persisted thread id for this
    // agent (when present AND still extant in the list) before
    // falling back to the head of the list. This is the path that
    // makes "close panel → reopen panel" land on the user's last
    // thread even though FloatingChatPanel itself unmounted.
    const persistedId =
      effectiveSlug && chatPanel
        ? chatPanel.getActiveThreadIdForAgent(effectiveSlug)
        : null;
    if (persistedId && list.some((t) => t.id === persistedId)) {
      setInternalActiveThreadId(persistedId);
      return;
    }
    setInternalActiveThreadId(list[0]?.id ?? null);
  }, [
    isThreadControlled,
    threadList.threads,
    internalActiveThreadId,
    effectiveSlug,
    chatPanel,
  ]);

  const handleSelectThread = React.useCallback(
    (threadId: string) => {
      if (!isThreadControlled) {
        setInternalActiveThreadId(threadId);
      }
      // Sub-AC 2 of AC 12: persist the user's pick per agent so the
      // next mount of FloatingChatPanel (panel close→reopen, full page
      // reload) restores this exact thread instead of falling back to
      // the most-recently-updated row.
      if (effectiveSlug && chatPanel) {
        chatPanel.setActiveThreadIdForAgent(effectiveSlug, threadId);
      }
      onActiveThreadChange?.(threadId);
    },
    [isThreadControlled, onActiveThreadChange, effectiveSlug, chatPanel],
  );

  // Sub-AC 4 of AC 5: thread-history hydration. When the user picks a
  // thread (or the panel auto-selects the first thread on agent-switch),
  // we fetch the full conversation document and feed its messages into
  // `<ChatThread>` via `initialMessages`. The state holds the resolved
  // messages keyed by `${slug}:${threadId}` so a re-pick of the same
  // thread doesn't trigger a redundant refetch (and so an agent-switch
  // followed by a switch-back replays from cache instead of the wire).
  //
  // The cache also doubles as the loading-state signal: while we're
  // mid-fetch the entry is `undefined`; once resolved it flips to a
  // (possibly empty) `ChatUIMessage[]`. The thread mounts with a
  // skeleton-style placeholder during the loading window so the user
  // sees a stable surface instead of the empty-state copy briefly
  // flashing.
  const [threadHistory, setThreadHistory] = React.useState<
    Record<string, ChatUIMessage[] | 'loading' | 'error'>
  >({});
  // The new-thread create flow is gated on a single in-flight token —
  // back-to-back clicks on the button shouldn't issue parallel POSTs.
  const [creatingThread, setCreatingThread] = React.useState<boolean>(false);
  // Surface a brief inline error string when the create POST fails so
  // the user sees what went wrong without having to crack open devtools.
  const [createThreadError, setCreateThreadError] = React.useState<
    string | null
  >(null);

  const fetchThreadFn = fetchThreadOverride ?? fetchAgentThread;
  const createThreadFn =
    createThreadOverride ??
    ((slug: string, opts?: { title?: string }) =>
      createAgentThread(slug, opts ?? {}));
  const refreshThreadListFn =
    refreshThreadListOverride ?? liveThreads.refresh;

  const historyKey =
    effectiveSlug && activeThreadId ? `${effectiveSlug}:${activeThreadId}` : null;

  // Stash the latest history map into a ref so the fetch effect can
  // read the cache without subscribing to it via the dependency array.
  // Listing `threadHistory` in the deps would force the effect to re-run
  // (and its cleanup to fire, marking the in-flight fetch cancelled)
  // every time we transition `loading → resolved`, which would silently
  // discard the very fetch result we're waiting on.
  const threadHistoryRef = React.useRef(threadHistory);
  React.useEffect(() => {
    threadHistoryRef.current = threadHistory;
  }, [threadHistory]);

  // Drive the fetch whenever the (slug, threadId) pair changes.
  React.useEffect(() => {
    if (!historyKey) return;
    if (!effectiveSlug || !activeThreadId) return;
    // Skip if we already have a resolved (or in-flight) entry — the
    // last-write-wins setter above keeps cache hits cheap.
    const existing = threadHistoryRef.current[historyKey];
    if (existing !== undefined) return;

    let cancelled = false;
    setThreadHistory((prev) => ({ ...prev, [historyKey]: 'loading' }));
    void fetchThreadFn(effectiveSlug, activeThreadId)
      .then((doc) => {
        if (cancelled) return;
        const ui = mapPersistedMessagesToUi(doc.messages);
        setThreadHistory((prev) => ({ ...prev, [historyKey]: ui }));
      })
      .catch(() => {
        if (cancelled) return;
        // On fetch failure we surface the empty state — the user can
        // pick another thread or hit "New thread" to start fresh.
        setThreadHistory((prev) => ({ ...prev, [historyKey]: 'error' }));
      });
    return () => {
      cancelled = true;
    };
  }, [historyKey, effectiveSlug, activeThreadId, fetchThreadFn]);

  const cachedHistory = historyKey ? threadHistory[historyKey] : undefined;
  const initialMessagesForThread =
    Array.isArray(cachedHistory) ? cachedHistory : undefined;
  // Treat the pre-fetch window (`undefined`) the same as `'loading'` so
  // we don't mount `<ChatThread>` before the persisted history resolves.
  // Otherwise the hook's `useState(() => initialMessages.slice())`
  // initializer fires with `[]`, and the array that lands a tick later
  // is ignored (initializers don't re-run on prop change), leaving the
  // panel stuck on the empty state until the user switches threads and
  // back to force a remount.
  const isHistoryUnresolved =
    historyKey !== null &&
    (cachedHistory === undefined || cachedHistory === 'loading');

  const handleNewThread = React.useCallback(async () => {
    if (!effectiveSlug || creatingThread) return;
    setCreatingThread(true);
    setCreateThreadError(null);
    try {
      const created = await createThreadFn(effectiveSlug);
      // Pre-seed the per-thread history cache with the empty array
      // returned by the server so the chat surface mounts immediately
      // with no spinner — a brand-new thread has no messages to
      // hydrate, so skipping the fetch is both correct and snappier.
      setThreadHistory((prev) => ({
        ...prev,
        [`${effectiveSlug}:${created.id}`]: [],
      }));
      // Refresh the sidebar list FIRST so the new row exists in the
      // threads list before we update the active-thread state.
      // Otherwise the auto-select effect (which keys on
      // `threadList.threads`) runs against the stale list, can't find
      // the new id, and falls back to `list[0]` — overwriting the
      // intended pin and leaving the user on the previous thread.
      try {
        await refreshThreadListFn();
      } catch {
        // Ignore refresh failures — we still pin the new thread below
        // and the user can manually reopen the panel to retry.
      }
      // Make the new thread the active row + notify the parent.
      if (!isThreadControlled) {
        setInternalActiveThreadId(created.id);
      }
      // Sub-AC 2 of AC 12: persist the new thread as the agent's
      // active-thread pin so a subsequent panel close→reopen lands
      // back on the freshly-created (likely empty) thread instead of
      // jumping to whatever older thread was previously most-recent.
      if (chatPanel) {
        chatPanel.setActiveThreadIdForAgent(effectiveSlug, created.id);
      }
      onActiveThreadChange?.(created.id);
    } catch (err) {
      const message =
        err && (err as Error).message
          ? (err as Error).message
          : 'Failed to create thread';
      setCreateThreadError(message);
    } finally {
      setCreatingThread(false);
    }
  }, [
    effectiveSlug,
    creatingThread,
    createThreadFn,
    isThreadControlled,
    onActiveThreadChange,
    refreshThreadListFn,
    chatPanel,
  ]);

  // Auto-create a default thread when an agent with zero threads is
  // selected so the user's first message has a `threadId` to persist
  // against. Gated on the explicit `autoCreateOnEmpty` opt-in so test
  // fixtures that assert the empty state aren't surprised by a network
  // call against the real `createAgentThread`. Production wiring in
  // `layout.tsx` opts in.
  const autoCreatedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!autoCreateOnEmpty) return;
    if (isThreadControlled) return;
    if (!effectiveSlug) return;
    if (threadList.loading) return;
    if (threadList.threads.length > 0) return;
    if (creatingThread) return;
    if (createThreadError) return;
    if (autoCreatedFor.current === effectiveSlug) return;
    autoCreatedFor.current = effectiveSlug;
    void handleNewThread();
  }, [
    autoCreateOnEmpty,
    isThreadControlled,
    effectiveSlug,
    threadList.loading,
    threadList.threads.length,
    creatingThread,
    createThreadError,
    handleNewThread,
  ]);

  return (
    <div
      data-component="floating-chat-panel"
      data-source={source}
      data-effective-slug={effectiveSlug ?? ''}
      data-route-slug={routeAgentSlug ?? ''}
      className={cn('flex h-full min-h-0 flex-col', className)}
    >
      <div
        data-component="floating-chat-panel-picker-row"
        className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-4 py-2"
      >
        <label
          htmlFor="floating-chat-agent-picker"
          className="shrink-0 text-xs font-medium text-muted-foreground"
        >
          Agent
        </label>
        <ChatAgentPicker
          id="floating-chat-agent-picker"
          ariaLabel="Choose chat agent"
          value={effectiveSlug}
          onChange={(slug) => setSelectedAgentSlug(slug)}
          agents={agents.rows}
          routeSlug={routeAgentSlug}
          loading={!!agents.loading && agents.rows.length === 0}
          error={agents.error ? formatRosterError(agents.error) : null}
          className="flex-1"
        />
      </div>

      {effectiveSlug ? (
        <div
          data-component="floating-chat-panel-thread-toolbar"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/10 px-4 py-1.5"
        >
          <span className="text-xs font-medium text-muted-foreground">
            Conversations
          </span>
          <button
            type="button"
            data-component="floating-chat-panel-new-thread"
            onClick={() => void handleNewThread()}
            disabled={creatingThread}
            aria-label="New thread"
            title="Start a new conversation"
            className={cn(
              'inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground',
              'transition-colors duration-100',
              'hover:bg-muted',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            <span>New</span>
          </button>
        </div>
      ) : null}

      {effectiveSlug && createThreadError ? (
        <p
          data-component="floating-chat-panel-new-thread-error"
          role="alert"
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
        >
          {createThreadError}
        </p>
      ) : null}

      {effectiveSlug ? (
        <ChatThreadList
          threads={threadList.threads}
          activeThreadId={activeThreadId}
          onSelect={handleSelectThread}
          loading={!!threadList.loading}
          error={threadList.error ?? null}
        />
      ) : null}

      {effectiveSlug ? (
        isHistoryUnresolved ? (
          <FloatingChatPanelHistoryLoading />
        ) : (
          <ChatThread
            // Re-keying on slug + threadId resets the thread's local
            // state when the user switches agents OR threads — composer
            // text, in-flight stream, and parts cache are scoped to the
            // exact (agent, thread) pair that produced them. Without
            // the threadId in the key the composer would carry user
            // input across thread switches, which is surprising.
            key={`${effectiveSlug}:${activeThreadId ?? 'no-thread'}`}
            slug={effectiveSlug}
            {...(activeThreadId ? { threadId: activeThreadId } : {})}
            // Mirror the live conversation back into our `threadHistory`
            // cache so a switch-out / switch-back round-trip re-hydrates
            // ChatThread with the latest messages instead of the empty
            // snapshot we seeded the cache with at thread-create time.
            // Without this, switching tabs and returning loses the
            // in-memory turns; only a hard reload re-fetches from disk.
            {...(historyKey
              ? {
                  onMessagesChange: (msgs) =>
                    setThreadHistory((prev) => ({
                      ...prev,
                      [historyKey]: msgs,
                    })),
                }
              : {})}
            // After each successful turn, refresh the threads sidebar
            // so the row's `lastMessagePreview` / title fallback picks
            // up the new message (without this the row keeps reading
            // "New chat" until the user manually refreshes).
            onTurnComplete={() => {
              void refreshThreadListFn();
            }}
            title={resolveAgentTitle(agents.rows, effectiveSlug)}
            // Sub-AC 4 of AC 5: when the user picks a saved thread,
            // hydrate the chat surface with its persisted message
            // history so the conversation re-appears across navigation
            // and browser sessions. The hook owns the streaming write
            // path; `initialMessages` only seeds the initial state.
            {...(initialMessagesForThread !== undefined
              ? { initialMessages: initialMessagesForThread }
              : {})}
            // Sub-AC 4 of AC 7: surface the agent roster's
            // budget-exhausted / paused status so the composer is locked
            // and the canonical banner renders the moment the panel
            // opens — even before the user attempts a send. The hook's
            // own `budget-exhausted` SSE-frame handling layers on top
            // for the rare case where the verdict flips mid-session.
            budgetExhausted={resolveAgentBudgetExhausted(
              agents.rows,
              effectiveSlug,
            )}
            {...(threadPropsOverride ?? {})}
          />
        )
      ) : (
        <FloatingChatPanelEmptyState
          loading={!!agents.loading}
          error={agents.error ?? null}
        />
      )}
    </div>
  );
}

export default FloatingChatPanel;

// ── Empty / placeholder state ────────────────────────────────────────

interface FloatingChatPanelEmptyStateProps {
  loading: boolean;
  error: Error | null;
}

function FloatingChatPanelEmptyState({
  loading,
  error,
}: FloatingChatPanelEmptyStateProps): React.ReactElement {
  return (
    <div
      data-component="floating-chat-panel-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground"
    >
      {loading ? (
        <p>Loading agents…</p>
      ) : error ? (
        <p data-component="floating-chat-panel-empty-error">
          Could not load agents — try reopening the panel.
        </p>
      ) : (
        <>
          <p>No agents yet.</p>
          <p className="text-xs italic">
            Run <code>aweek hire</code> to add your first agent.
          </p>
        </>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a friendly title for the chat-thread header. Prefers the
 * agent's `name` field, falling back to the slug when the name is
 * missing (e.g. an agent JSON loaded from a partial roster).
 */
function resolveAgentTitle(
  rows: ReadonlyArray<AgentListRow>,
  slug: string,
): string | undefined {
  const match = rows.find((a) => a.slug === slug);
  if (!match) return slug;
  if (match.name?.trim()) return match.name;
  return slug;
}

/**
 * Sub-AC 4 of AC 7: derive the budget-exhausted signal for the chat
 * thread from the agent roster.
 *
 * The dashboard's `AgentStatus` enum has three values
 * (`active` / `paused` / `budget-exhausted`). The latter two both
 * indicate the chat composer should be locked: a paused agent cannot
 * accept any new turns regardless of remaining tokens (mirrors the
 * heartbeat semantics) and a `budget-exhausted` agent has used up its
 * weekly pool. We collapse both to `true` so the chat thread renders
 * the canonical banner without having to know the difference.
 *
 * Returns `false` (not `null`) for active / unknown agents so the
 * thread can keep its existing "no banner" path; the consumer treats
 * any truthy value as the lock signal and the boolean form keeps the
 * default copy ("Weekly budget exhausted — resume via aweek manage")
 * — the server-side `budget-exhausted` SSE frame surfaces the
 * structured detail when the verdict arrives mid-session.
 */
function resolveAgentBudgetExhausted(
  rows: ReadonlyArray<AgentListRow>,
  slug: string,
): boolean {
  const match = rows.find((a) => a.slug === slug);
  if (!match) return false;
  return match.status === 'budget-exhausted' || match.status === 'paused';
}

/**
 * Convert an `Error` into a short user-facing message for the picker's
 * error state. We surface the message verbatim when present (the API
 * layer already produces concise error envelopes) and fall back to a
 * generic string only when the message is empty.
 */
function formatRosterError(err: Error): string {
  const message = (err?.message ?? '').trim();
  if (!message) return 'Could not load agents.';
  // Cap the length so a verbose stack trace doesn't blow out the
  // picker bar.
  if (message.length > 120) return `${message.slice(0, 117)}…`;
  return message;
}

// ── Helpers (Sub-AC 4 of AC 5) ──────────────────────────────────────

/**
 * Convert a persisted thread's wire messages into the {@link ChatUIMessage}
 * shape `<ChatThread>` expects via `initialMessages`. The persisted shape
 * carries `id`, `role`, `content`, `createdAt`, optional `tools`, and
 * optional `metadata`; the UI shape is a strict subset (`id`, `role`,
 * `content`, optional `parts`).
 *
 * Tool blocks are mapped onto a `parts` array so the renderer can
 * surface saved tool invocations inline next to the assistant prose,
 * matching what was on screen during the original turn. Text content
 * is preserved verbatim and also appended as a trailing text part so
 * the renderer can interleave prose / tool calls correctly.
 *
 * Pure / immutable — exported via `__test` for unit tests that need to
 * round-trip a thread document without standing up the panel.
 */
function mapPersistedMessagesToUi(
  messages: ReadonlyArray<ChatMessageWire>,
): ChatUIMessage[] {
  return messages.map((m) => {
    const ui: ChatUIMessage = {
      id: m.id,
      role: m.role,
      content: m.content,
    };
    // Build parts only for assistant turns that carry tools — user
    // turns and plain assistant prose render correctly through the
    // `content` fallback path.
    //
    // Persistence stores the canonical Anthropic SDK shape: a flat
    // `tools` array containing both `tool_use` and `tool_result` blocks
    // correlated by `toolUseId`. The UI renderer wants one
    // `tool-invocation` part per logical call, with `state`, `result`,
    // and `errorMessage` derived from the matching result block. So
    // index results first, then walk uses in persisted order to emit
    // one part per use (preserving order); orphan use → `pending`,
    // result without a use is dropped.
    if (m.role === 'assistant' && Array.isArray(m.tools) && m.tools.length > 0) {
      const resultsById = new Map<string, ChatToolResultBlockWire>();
      for (const tool of m.tools) {
        if (tool.type === 'tool_result') {
          resultsById.set(tool.toolUseId, tool);
        }
      }
      const parts: ChatUIMessage['parts'] = [];
      for (const tool of m.tools) {
        if (tool.type !== 'tool_use') continue;
        const matchingResult = resultsById.get(tool.toolUseId);
        const state: 'pending' | 'success' | 'error' = matchingResult
          ? matchingResult.isError
            ? 'error'
            : 'success'
          : 'pending';
        const part: NonNullable<ChatUIMessage['parts']>[number] = {
          type: 'tool-invocation',
          toolUseId: tool.toolUseId,
          toolName: tool.name,
          args: tool.input ?? {},
          state,
        };
        if (matchingResult) {
          part.result = matchingResult.content;
          if (matchingResult.isError && typeof matchingResult.content === 'string') {
            part.errorMessage = matchingResult.content;
          }
        }
        parts.push(part);
      }
      // Trail with the assistant's natural-language text so the bubble
      // reads in the same order it streamed originally.
      if (m.content.length > 0) {
        parts.push({ type: 'text', text: m.content });
      }
      // Only attach parts when the message actually contributed any —
      // an assistant turn with only orphan `tool_result` blocks (no
      // `tool_use`) and empty content falls back to the legacy content
      // path so we don't render an empty bubble.
      if (parts.length > 0) {
        ui.parts = parts;
      }
    }
    return ui;
  });
}

/**
 * Skeleton placeholder rendered in place of `<ChatThread>` while the
 * persisted history for the active thread is in flight. Sized to fill
 * the elastic body region so the panel layout doesn't shift between
 * "loading history" and "thread mounted with messages".
 */
function FloatingChatPanelHistoryLoading(): React.ReactElement {
  return (
    <div
      data-component="floating-chat-panel-history-loading"
      role="status"
      aria-live="polite"
      className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center text-sm text-muted-foreground"
    >
      <p>Loading conversation…</p>
    </div>
  );
}

// ── Test-facing internals ────────────────────────────────────────────
// Exported for unit tests only — not part of the SPA's public API.

export const __test = {
  resolveAgentTitle,
  formatRosterError,
  resolveAgentBudgetExhausted,
  mapPersistedMessagesToUi,
} as const;
