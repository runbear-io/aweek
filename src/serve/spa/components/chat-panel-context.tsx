/**
 * `ChatPanelContext` — shared open/close store for the floating chat
 * panel (AC 9 Sub-AC 4).
 *
 * Why a context instead of letting the `FloatingChatBubble` own its own
 * state:
 *   1. The bubble already lives inside `<Layout>` which mounts once at
 *      the SPA root, so its internal `useState` *technically* survives
 *      route changes via DOM identity. But the open/closed value is not
 *      addressable from anywhere else in the app — features that want to
 *      programmatically open the panel ("Chat with this agent" buttons
 *      on the agents list / detail pages) would have to lift state
 *      themselves.
 *   2. Future sub-ACs need to surface chat state to neighbouring
 *      components (header bell variants, sidebar entries, `?chat=open`
 *      deep-link wiring). A single context is the canonical React
 *      pattern for that.
 *   3. Persisting to `localStorage` from the provider keeps the open
 *      state alive across full page reloads — closing the panel,
 *      refreshing, and re-landing on the same page should not lose the
 *      "I had it closed" preference.
 *
 * The provider mirrors `ThemeProvider`'s shape (storage-backed,
 * synchronous initial-value resolution, optional `defaultOpen` override
 * for tests) so its ergonomics are familiar to anyone who has touched
 * the existing SPA shell. Storage failures are non-fatal — the
 * in-memory state still flips so the UI stays responsive even when
 * `localStorage` is unavailable (private mode, quota, SSR).
 *
 * Consumption:
 *
 *   const { open, setOpen, toggleOpen, openPanel, closePanel } = useChatPanel();
 *
 * For components that should work both with and without a provider
 * (the floating bubble itself, which is rendered by tests in isolation
 * without a provider above it) `useChatPanelOptional()` returns the
 * context value when one is mounted and `null` otherwise — letting the
 * caller fall back to internal state when not wired in.
 *
 * @module serve/spa/components/chat-panel-context
 */

import * as React from 'react';

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Canonical `localStorage` key for the persisted open/closed state.
 * Namespaced under `aweek:` to match the rest of the SPA's keys
 * (`aweek:theme`, `aweek:sidebar:open`).
 */
export const CHAT_PANEL_OPEN_STORAGE_KEY = 'aweek:chat-panel:open';

/**
 * Canonical `localStorage` key for the explicitly-selected agent slug
 * (AC 10). When a user picks an agent from the floating panel's picker,
 * the selection is persisted here so the next time they reopen the
 * panel — even after a full page reload — they land back on the same
 * thread. When no explicit selection has been made, the value is empty
 * and the panel defaults to the URL-derived slug (when on
 * `/agents/:slug/*`) or to the first available agent.
 */
export const CHAT_PANEL_AGENT_STORAGE_KEY = 'aweek:chat-panel:agent';

/**
 * Canonical `localStorage` key for the per-agent active-thread map
 * (Sub-AC 2 of AC 12 — conversation_continuity). The map is a JSON
 * object keyed by agent slug, with conversation ids as values:
 *
 *   { "writer": "chat-aaaa", "reviewer": "chat-bbbb" }
 *
 * Each entry remembers which thread the user was last reading inside
 * that agent's panel. When the panel closes and reopens — or when the
 * browser refreshes — the panel reads this map to seed the active
 * thread for the currently-selected agent so the conversation it
 * hydrates is the one the user expects, not whatever thread happens
 * to sort first by `updatedAt-desc`.
 *
 * Per-agent (rather than a single global thread id) because each
 * agent has its own set of threads — switching agents must NOT
 * accidentally surface another agent's thread id to the network layer.
 */
export const CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY =
  'aweek:chat-panel:active-thread';

/**
 * Stored values written by the provider. Strings rather than `'true'`/
 * `'false'` so a stale boolean string from a previous provider revision
 * is treated as unknown (and falls back to the default) rather than
 * silently re-interpreted.
 */
const STORED_OPEN = 'open';
const STORED_CLOSED = 'closed';

/** Default open state on first load (collapsed bubble). */
export const DEFAULT_CHAT_PANEL_OPEN = false;

/**
 * Validation pattern for agent slugs accepted by the picker. The
 * dashboard's slug convention is the same as `.claude/agents/<slug>.md`
 * filenames — kebab-case with optional digits — so we use a permissive
 * lowercase-alphanumeric-with-hyphens pattern. Rejected slugs fall back
 * to `null` so a corrupted localStorage value can't smuggle a malformed
 * slug into the network layer.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * Validation pattern for chat thread ids. Mirrors the storage layer's
 * id format (`chat-<short-hex>`, see `chat-conversation-store.ts` /
 * `createChatConversation`). Used both when seeding state from
 * `localStorage` and when accepting setter inputs so a corrupted or
 * forged value can't smuggle a path-traversal segment into the
 * `/api/agents/:slug/chat/threads/:threadId` URL.
 */
const THREAD_ID_PATTERN = /^chat-[a-z0-9]+(-[a-z0-9]+)*$/;

// ── Types ─────────────────────────────────────────────────────────────

export interface ChatPanelContextValue {
  /**
   * Whether the floating chat panel is currently expanded. The
   * `FloatingChatBubble` consumer reflects this on its `data-state`
   * attribute and switches between collapsed/expanded markup.
   */
  open: boolean;
  /**
   * Set the open state explicitly. Forwarded to the bubble's
   * `onOpenChange` so user clicks, Escape presses, and programmatic
   * triggers all funnel through the same write path.
   */
  setOpen: (next: boolean) => void;
  /** Flip between open and closed. */
  toggleOpen: () => void;
  /** Convenience setter — sugar for `setOpen(true)`. */
  openPanel: () => void;
  /** Convenience setter — sugar for `setOpen(false)`. */
  closePanel: () => void;
  /**
   * AC 10: explicit agent selection from the floating panel's picker.
   *
   * `null` means the user has not yet picked an agent — consumers
   * should fall back to the URL-derived slug (when on
   * `/agents/:slug/*`) or to a sensible default (the first agent in
   * the roster). Once the user picks an agent the slug is persisted
   * here and survives route transitions and full page reloads.
   *
   * The setter validates the slug shape (`^[a-z0-9][a-z0-9-]{0,127}$`)
   * and silently coerces any other value to `null` so a corrupted
   * `localStorage` payload or a stray external mutation cannot smuggle
   * a malformed slug into the chat-stream URL.
   */
  selectedAgentSlug: string | null;
  /**
   * Set the selected agent slug. Pass `null` to clear the selection
   * and defer back to the URL-derived default. Pass a valid slug
   * (kebab-case, ≤ 128 chars) to pin the panel to that agent until
   * the user picks something else.
   */
  setSelectedAgentSlug: (slug: string | null) => void;
  /**
   * Sub-AC 2 of AC 12 — read the persisted active-thread id for one
   * agent. Returns `null` when the user has never picked a thread for
   * that agent (or when the persisted value fails validation). The
   * floating chat panel uses this on mount to seed the auto-selection
   * with the user's last-read thread instead of always defaulting to
   * the most-recently-updated row.
   *
   * The lookup is per-agent (rather than a single global "active
   * thread") because each agent has its own thread-id namespace —
   * switching agents must NOT accidentally surface another agent's
   * thread id to the network layer.
   */
  getActiveThreadIdForAgent: (slug: string) => string | null;
  /**
   * Sub-AC 2 of AC 12 — pin one agent's active thread. Pass `null` to
   * clear the pin (the next mount auto-selects the most-recently-
   * updated thread again). The setter validates `threadId` against the
   * `chat-<hex>` shape and silently coerces any other value to a
   * remove — a forged or corrupted localStorage payload can't smuggle
   * a path-traversal segment into the chat API URL.
   */
  setActiveThreadIdForAgent: (
    slug: string,
    threadId: string | null,
  ) => void;
}

/**
 * Minimal storage shape consumed by the provider. Mirrors the subset of
 * `Storage` we actually use so tests can pass a plain in-memory object
 * without polyfilling the full `Storage` interface.
 */
export interface ChatPanelOpenStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

// ── Context ───────────────────────────────────────────────────────────

const ChatPanelContext = React.createContext<ChatPanelContextValue | null>(
  null,
);

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the initial open state synchronously. Prefers a previously
 * persisted value in `storage`; falls back to `DEFAULT_CHAT_PANEL_OPEN`
 * when storage is unavailable or the stored value is unrecognised.
 *
 * Exported so tests can pin the resolution path without standing up a
 * full `<ChatPanelProvider>` tree.
 */
export function getInitialChatPanelOpen({
  storage = typeof window === 'undefined' ? null : window.localStorage,
  storageKey = CHAT_PANEL_OPEN_STORAGE_KEY,
}: {
  storage?: ChatPanelOpenStorage | null;
  storageKey?: string;
} = {}): boolean {
  if (!storage) return DEFAULT_CHAT_PANEL_OPEN;
  try {
    const stored = storage.getItem(storageKey);
    if (stored === STORED_OPEN) return true;
    if (stored === STORED_CLOSED) return false;
    return DEFAULT_CHAT_PANEL_OPEN;
  } catch {
    return DEFAULT_CHAT_PANEL_OPEN;
  }
}

function persistOpen(
  storage: ChatPanelOpenStorage | null,
  storageKey: string,
  next: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, next ? STORED_OPEN : STORED_CLOSED);
  } catch {
    // Storage unavailable (private mode / quota). The in-memory state
    // already flipped — persistence is best-effort.
  }
}

/**
 * Validate a slug candidate. Returns the slug verbatim when it matches
 * the kebab-case-with-digits pattern; returns `null` for everything
 * else (empty strings, all-uppercase, leading hyphen, > 128 chars,
 * non-strings, etc.). Exported so consumers can validate slugs they
 * source from URL params, query strings, or external state without
 * duplicating the regex.
 */
export function validateAgentSlug(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  if (!SLUG_PATTERN.test(candidate)) return null;
  return candidate;
}

/**
 * Resolve the initial agent-slug selection synchronously. Mirrors
 * `getInitialChatPanelOpen` — prefers the persisted `localStorage`
 * value, falls back to `null` when storage is unavailable or the
 * stored value fails validation.
 */
export function getInitialSelectedAgentSlug({
  storage = typeof window === 'undefined' ? null : window.localStorage,
  storageKey = CHAT_PANEL_AGENT_STORAGE_KEY,
}: {
  storage?: ChatPanelOpenStorage | null;
  storageKey?: string;
} = {}): string | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(storageKey);
    return validateAgentSlug(stored);
  } catch {
    return null;
  }
}

function persistSelectedAgentSlug(
  storage: ChatPanelOpenStorage | null,
  storageKey: string,
  next: string | null,
): void {
  if (!storage) return;
  try {
    if (next === null) {
      // Re-use `setItem(key, '')` rather than `removeItem` so the
      // persistence shape stays uniform across the two storage keys
      // this provider owns. An empty string fails `validateAgentSlug`
      // on next read and falls back to `null`.
      storage.setItem(storageKey, '');
    } else {
      storage.setItem(storageKey, next);
    }
  } catch {
    // Persistence is best-effort; the in-memory state already flipped.
  }
}

/**
 * Validate a chat thread id. Returns the id verbatim when it matches
 * the `chat-<hex>` shape the storage layer emits; returns `null` for
 * everything else (empty strings, path-traversal segments, non-string
 * values). Exported so the floating chat panel and tests can validate
 * thread ids sourced from external state without duplicating the
 * pattern.
 */
export function validateChatThreadId(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  if (!THREAD_ID_PATTERN.test(candidate)) return null;
  return candidate;
}

/**
 * Active-thread map: `{ agentSlug: threadId }`. Stored as a single
 * JSON blob under {@link CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY} so the
 * provider only owns one storage entry for the entire feature instead
 * of one per agent — a cleaner garbage-collection story when an agent
 * is renamed / archived.
 */
type ActiveThreadMap = Readonly<Record<string, string>>;

const EMPTY_ACTIVE_THREAD_MAP: ActiveThreadMap = Object.freeze({});

/**
 * Resolve the initial active-thread map synchronously. Mirrors
 * `getInitialChatPanelOpen` / `getInitialSelectedAgentSlug` — prefers
 * the persisted `localStorage` value, falls back to an empty map when
 * storage is unavailable, the JSON is malformed, or any individual
 * entry fails validation. Per-entry validation is strict: an invalid
 * key (failing `validateAgentSlug`) or value (failing
 * `validateChatThreadId`) drops only that pair, not the whole map.
 */
export function getInitialActiveThreadMap({
  storage = typeof window === 'undefined' ? null : window.localStorage,
  storageKey = CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY,
}: {
  storage?: ChatPanelOpenStorage | null;
  storageKey?: string;
} = {}): ActiveThreadMap {
  if (!storage) return EMPTY_ACTIVE_THREAD_MAP;
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return EMPTY_ACTIVE_THREAD_MAP;
  }
  if (!raw) return EMPTY_ACTIVE_THREAD_MAP;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_ACTIVE_THREAD_MAP;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return EMPTY_ACTIVE_THREAD_MAP;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const validSlug = validateAgentSlug(key);
    const validThreadId = validateChatThreadId(value);
    if (validSlug && validThreadId) {
      out[validSlug] = validThreadId;
    }
  }
  return Object.freeze(out);
}

function persistActiveThreadMap(
  storage: ChatPanelOpenStorage | null,
  storageKey: string,
  next: ActiveThreadMap,
): void {
  if (!storage) return;
  try {
    if (Object.keys(next).length === 0) {
      // Same convention as the agent-slug key: empty payload rather
      // than removeItem so the persistence shape stays uniform. An
      // empty `{}` parses fine on the next read and resolves to an
      // empty map without re-validating each entry.
      storage.setItem(storageKey, '{}');
    } else {
      storage.setItem(storageKey, JSON.stringify(next));
    }
  } catch {
    // Persistence is best-effort; the in-memory state already flipped.
  }
}

// ── Provider ──────────────────────────────────────────────────────────

export interface ChatPanelProviderProps {
  /**
   * Override the initial open state. When provided, takes precedence
   * over the persisted `localStorage` value. Useful for tests that want
   * a deterministic starting state without poking at storage.
   */
  defaultOpen?: boolean;
  /**
   * Override the initial selected-agent slug (AC 10). When provided,
   * takes precedence over the persisted `localStorage` value. Useful
   * for tests that want a deterministic starting selection without
   * poking at storage. Pass `null` to start with no selection.
   */
  defaultSelectedAgentSlug?: string | null;
  /**
   * Storage backing the open-state persistence. Defaults to
   * `window.localStorage` when running in the browser, `null` otherwise
   * (SSR, node tests). Pass `null` explicitly to disable persistence.
   */
  storage?: ChatPanelOpenStorage | null;
  /**
   * Override the storage key. Mostly useful for tests that want to
   * isolate themselves from production state.
   */
  storageKey?: string;
  /**
   * Override the storage key used for the explicitly-selected agent
   * slug. Defaults to {@link CHAT_PANEL_AGENT_STORAGE_KEY}.
   */
  agentStorageKey?: string;
  /**
   * Override the storage key used for the per-agent active-thread map
   * (Sub-AC 2 of AC 12). Defaults to
   * {@link CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY}.
   */
  activeThreadStorageKey?: string;
  /**
   * Override the initial per-agent active-thread map (Sub-AC 2 of AC
   * 12). When provided, takes precedence over the persisted
   * `localStorage` value. Useful for tests that want a deterministic
   * starting state without poking at storage. Pass an empty object
   * to start with no pinned threads.
   */
  defaultActiveThreadMap?: Readonly<Record<string, string>>;
  children?: React.ReactNode;
}

/**
 * Provider — wire once at the SPA entry point so the floating chat
 * bubble shares one open/closed value with every other component that
 * cares (header buttons, sidebar entries, future deep-link routes).
 *
 * The provider must sit *above* the React Router tree because the
 * bubble lives inside `<Layout>`, which renders inside `<Routes>`. A
 * provider mounted above the router persists naturally across every
 * route transition — there's no router-level remount that could blow
 * the value away.
 */
export function ChatPanelProvider({
  defaultOpen,
  defaultSelectedAgentSlug,
  defaultActiveThreadMap,
  storage = typeof window === 'undefined' ? null : window.localStorage,
  storageKey = CHAT_PANEL_OPEN_STORAGE_KEY,
  agentStorageKey = CHAT_PANEL_AGENT_STORAGE_KEY,
  activeThreadStorageKey = CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY,
  children,
}: ChatPanelProviderProps = {}): React.ReactElement {
  const [open, setOpenState] = React.useState<boolean>(() => {
    if (defaultOpen !== undefined) return defaultOpen;
    return getInitialChatPanelOpen({ storage, storageKey });
  });

  const [selectedAgentSlug, setSelectedAgentSlugState] = React.useState<
    string | null
  >(() => {
    if (defaultSelectedAgentSlug !== undefined) {
      return validateAgentSlug(defaultSelectedAgentSlug);
    }
    return getInitialSelectedAgentSlug({
      storage,
      storageKey: agentStorageKey,
    });
  });

  // Wrap setters in stable callbacks so context consumers don't
  // re-render on every provider render (the value memo below depends
  // on these references).
  const setOpen = React.useCallback(
    (next: boolean) => {
      setOpenState(next);
      persistOpen(storage, storageKey, next);
    },
    [storage, storageKey],
  );

  const toggleOpen = React.useCallback(() => {
    setOpenState((prev) => {
      const next = !prev;
      persistOpen(storage, storageKey, next);
      return next;
    });
  }, [storage, storageKey]);

  const openPanel = React.useCallback(() => setOpen(true), [setOpen]);
  const closePanel = React.useCallback(() => setOpen(false), [setOpen]);

  const setSelectedAgentSlug = React.useCallback(
    (slug: string | null) => {
      const validated = slug === null ? null : validateAgentSlug(slug);
      setSelectedAgentSlugState(validated);
      persistSelectedAgentSlug(storage, agentStorageKey, validated);
    },
    [storage, agentStorageKey],
  );

  // Sub-AC 2 of AC 12: per-agent active-thread map. Stored as a single
  // immutable object so consumers can do equality-based memoisation
  // without snapshotting the keys. The setters validate both the slug
  // and the thread id before mutating, so a forged or corrupted entry
  // can't smuggle a bad value into the chat-stream URL.
  const [activeThreadMap, setActiveThreadMapState] = React.useState<
    ActiveThreadMap
  >(() => {
    if (defaultActiveThreadMap !== undefined) {
      // Re-validate the default so tests can pass a permissive map and
      // still get the same defensive narrowing the storage path applies.
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(defaultActiveThreadMap)) {
        const validSlug = validateAgentSlug(key);
        const validThreadId = validateChatThreadId(value);
        if (validSlug && validThreadId) {
          out[validSlug] = validThreadId;
        }
      }
      return Object.freeze(out);
    }
    return getInitialActiveThreadMap({
      storage,
      storageKey: activeThreadStorageKey,
    });
  });

  // Mirror the latest map into a ref so the (slug, threadId) getter
  // can read the current value without re-rendering its consumer on
  // every map mutation. Without the ref, every consumer that calls
  // `getActiveThreadIdForAgent(slug)` inside a render would re-run
  // whenever ANY agent's pin changed, not just its own.
  const activeThreadMapRef = React.useRef<ActiveThreadMap>(activeThreadMap);
  React.useEffect(() => {
    activeThreadMapRef.current = activeThreadMap;
  }, [activeThreadMap]);

  const getActiveThreadIdForAgent = React.useCallback(
    (slug: string): string | null => {
      const validSlug = validateAgentSlug(slug);
      if (!validSlug) return null;
      const value = activeThreadMapRef.current[validSlug];
      if (typeof value !== 'string') return null;
      // Defensive re-validation — the persistence path validates on
      // ingest, but a setter caller could have routed around the
      // validator (e.g. via a future internal helper). Better to
      // surface `null` than to leak a malformed id.
      return validateChatThreadId(value);
    },
    [],
  );

  const setActiveThreadIdForAgent = React.useCallback(
    (slug: string, threadId: string | null): void => {
      const validSlug = validateAgentSlug(slug);
      if (!validSlug) return;
      setActiveThreadMapState((prev) => {
        const validatedThreadId =
          threadId === null ? null : validateChatThreadId(threadId);
        // Compute the next map with structural-equality short-circuiting
        // so a no-op (re-pinning the same id) doesn't dispatch a
        // re-render to every consumer.
        const currentEntry = prev[validSlug] ?? null;
        if (validatedThreadId === currentEntry) return prev;
        const next: Record<string, string> = { ...prev };
        if (validatedThreadId === null) {
          delete next[validSlug];
        } else {
          next[validSlug] = validatedThreadId;
        }
        const frozen = Object.freeze(next);
        persistActiveThreadMap(storage, activeThreadStorageKey, frozen);
        return frozen;
      });
    },
    [storage, activeThreadStorageKey],
  );

  const value = React.useMemo<ChatPanelContextValue>(
    () => ({
      open,
      setOpen,
      toggleOpen,
      openPanel,
      closePanel,
      selectedAgentSlug,
      setSelectedAgentSlug,
      getActiveThreadIdForAgent,
      setActiveThreadIdForAgent,
    }),
    [
      open,
      setOpen,
      toggleOpen,
      openPanel,
      closePanel,
      selectedAgentSlug,
      setSelectedAgentSlug,
      getActiveThreadIdForAgent,
      setActiveThreadIdForAgent,
    ],
  );

  return (
    <ChatPanelContext.Provider value={value}>
      {children}
    </ChatPanelContext.Provider>
  );
}

export default ChatPanelProvider;

// ── Hooks ─────────────────────────────────────────────────────────────

/**
 * Read the chat-panel open state + setters. Throws when used outside a
 * `<ChatPanelProvider>` so wiring mistakes surface loudly during
 * development rather than producing a silent always-closed panel.
 */
export function useChatPanel(): ChatPanelContextValue {
  const ctx = React.useContext(ChatPanelContext);
  if (!ctx) {
    throw new Error(
      'useChatPanel() must be used inside a <ChatPanelProvider>.',
    );
  }
  return ctx;
}

/**
 * Same as `useChatPanel()` but returns `null` when no provider is
 * mounted instead of throwing. Used by the floating-chat-bubble
 * consumer in `<Layout>` so the layout falls back to the bubble's
 * internal `useState` when rendered in unit-test trees that don't
 * include the provider — preserving the existing test contracts
 * shipped in Sub-ACs 1–3 without forcing every test to wrap in another
 * provider.
 */
export function useChatPanelOptional(): ChatPanelContextValue | null {
  return React.useContext(ChatPanelContext);
}
