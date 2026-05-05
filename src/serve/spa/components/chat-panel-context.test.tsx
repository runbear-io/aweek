/**
 * Tests for `./chat-panel-context.tsx` — the shared open/close store
 * for the floating chat panel shipped in Sub-AC 4 of AC 9.
 *
 * Contract pinned by these tests:
 *   1. The provider exposes `{ open, setOpen, toggleOpen, openPanel,
 *      closePanel }` to descendants via `useChatPanel()`. `useChatPanel`
 *      throws outside the provider so wiring mistakes are loud.
 *   2. The initial `open` value resolves synchronously from the
 *      `defaultOpen` prop (highest priority), then from the storage
 *      backing, then from the `DEFAULT_CHAT_PANEL_OPEN` constant.
 *   3. `setOpen` / `toggleOpen` / `openPanel` / `closePanel` mutate the
 *      in-memory state AND persist the new value to storage when one
 *      is configured.
 *   4. Storage failures (throwing `setItem`) do not blow up the setter
 *      — the in-memory state still flips.
 *   5. State persists across route navigation: the provider lives
 *      above the router so a `useNavigate()` call doesn't unmount the
 *      provider and reset the state.
 *   6. `useChatPanelOptional` returns `null` outside the provider —
 *      consumers that want to fall back gracefully (e.g. the floating
 *      bubble inside isolated tests) use this variant.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

import {
  CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY,
  CHAT_PANEL_OPEN_STORAGE_KEY,
  ChatPanelProvider,
  DEFAULT_CHAT_PANEL_OPEN,
  getInitialActiveThreadMap,
  getInitialChatPanelOpen,
  useChatPanel,
  useChatPanelOptional,
  validateChatThreadId,
  type ChatPanelOpenStorage,
} from './chat-panel-context.tsx';

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a deterministic in-memory storage backing so tests don't share
 * state with each other or with the real `window.localStorage`.
 */
function memoryStorage(initial: Record<string, string> = {}): ChatPanelOpenStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

// ── Constants & defaults ─────────────────────────────────────────────

describe('chat-panel-context — defaults', () => {
  it('exposes a sensible default open state (closed)', () => {
    expect(DEFAULT_CHAT_PANEL_OPEN).toBe(false);
  });

  it('namespaces its storage key under aweek:', () => {
    expect(CHAT_PANEL_OPEN_STORAGE_KEY.startsWith('aweek:')).toBe(true);
  });
});

// ── getInitialChatPanelOpen ──────────────────────────────────────────

describe('getInitialChatPanelOpen', () => {
  it('returns the default when no storage is configured', () => {
    expect(getInitialChatPanelOpen({ storage: null })).toBe(
      DEFAULT_CHAT_PANEL_OPEN,
    );
  });

  it('returns true when the persisted value is "open"', () => {
    const storage = memoryStorage({ [CHAT_PANEL_OPEN_STORAGE_KEY]: 'open' });
    expect(getInitialChatPanelOpen({ storage })).toBe(true);
  });

  it('returns false when the persisted value is "closed"', () => {
    const storage = memoryStorage({ [CHAT_PANEL_OPEN_STORAGE_KEY]: 'closed' });
    expect(getInitialChatPanelOpen({ storage })).toBe(false);
  });

  it('falls back to the default when the persisted value is unrecognised', () => {
    const storage = memoryStorage({ [CHAT_PANEL_OPEN_STORAGE_KEY]: 'maybe' });
    expect(getInitialChatPanelOpen({ storage })).toBe(DEFAULT_CHAT_PANEL_OPEN);
  });

  it('falls back to the default when getItem throws', () => {
    const storage: ChatPanelOpenStorage = {
      getItem: () => {
        throw new Error('boom');
      },
      setItem: () => {},
    };
    expect(getInitialChatPanelOpen({ storage })).toBe(DEFAULT_CHAT_PANEL_OPEN);
  });
});

// ── Provider + hook contract ─────────────────────────────────────────

describe('ChatPanelProvider — useChatPanel hook', () => {
  it('throws when useChatPanel is called outside a provider', () => {
    // Suppress the React error logger for this assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      renderHook(() => useChatPanel(), {
        // wrapper omitted — no provider
      }),
    ).toThrow(/useChatPanel\(\) must be used inside a <ChatPanelProvider>/);
    spy.mockRestore();
  });

  it('useChatPanelOptional returns null outside a provider', () => {
    const { result } = renderHook(() => useChatPanelOptional());
    expect(result.current).toBeNull();
  });

  it('exposes the full setter shape via useChatPanel', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={null}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    expect(typeof result.current.open).toBe('boolean');
    expect(typeof result.current.setOpen).toBe('function');
    expect(typeof result.current.toggleOpen).toBe('function');
    expect(typeof result.current.openPanel).toBe('function');
    expect(typeof result.current.closePanel).toBe('function');
  });

  it('honours defaultOpen={true} on first render', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider defaultOpen storage={null}>
        {children}
      </ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });
    expect(result.current.open).toBe(true);
  });

  it('hydrates the initial open state from storage when no defaultOpen is supplied', () => {
    const storage = memoryStorage({
      [CHAT_PANEL_OPEN_STORAGE_KEY]: 'open',
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={storage}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });
    expect(result.current.open).toBe(true);
  });

  it('prefers defaultOpen over the persisted storage value', () => {
    const storage = memoryStorage({
      [CHAT_PANEL_OPEN_STORAGE_KEY]: 'open',
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider defaultOpen={false} storage={storage}>
        {children}
      </ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });
    expect(result.current.open).toBe(false);
  });
});

// ── Setters ──────────────────────────────────────────────────────────

describe('ChatPanelProvider — setters', () => {
  it('setOpen(true) flips the state and persists "open" to storage', () => {
    const storage = memoryStorage();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={storage}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    expect(result.current.open).toBe(false);
    act(() => result.current.setOpen(true));
    expect(result.current.open).toBe(true);
    expect(storage.data[CHAT_PANEL_OPEN_STORAGE_KEY]).toBe('open');

    act(() => result.current.setOpen(false));
    expect(result.current.open).toBe(false);
    expect(storage.data[CHAT_PANEL_OPEN_STORAGE_KEY]).toBe('closed');
  });

  it('toggleOpen flips between open and closed', () => {
    const storage = memoryStorage();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={storage}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    expect(result.current.open).toBe(false);
    act(() => result.current.toggleOpen());
    expect(result.current.open).toBe(true);
    expect(storage.data[CHAT_PANEL_OPEN_STORAGE_KEY]).toBe('open');

    act(() => result.current.toggleOpen());
    expect(result.current.open).toBe(false);
    expect(storage.data[CHAT_PANEL_OPEN_STORAGE_KEY]).toBe('closed');
  });

  it('openPanel and closePanel are sugar for setOpen', () => {
    const storage = memoryStorage();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={storage}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    act(() => result.current.openPanel());
    expect(result.current.open).toBe(true);

    act(() => result.current.closePanel());
    expect(result.current.open).toBe(false);
  });

  it('keeps in-memory state in sync even when storage.setItem throws', () => {
    const failingStorage: ChatPanelOpenStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={failingStorage}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    expect(result.current.open).toBe(false);
    act(() => result.current.setOpen(true));
    // Did NOT throw; in-memory value updated regardless of storage
    // failing.
    expect(result.current.open).toBe(true);
  });

  it('survives a missing (null) storage backing without throwing', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={null}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    act(() => result.current.openPanel());
    expect(result.current.open).toBe(true);
  });
});

// ── Sharing across consumers ─────────────────────────────────────────

describe('ChatPanelProvider — multiple consumers share the same state', () => {
  it('two sibling consumers see the same open value and react to setters from either side', () => {
    function ConsumerA(): React.ReactElement {
      const { open, openPanel } = useChatPanel();
      return (
        <div>
          <span data-testid="a-open">{open ? 'open' : 'closed'}</span>
          <button type="button" data-testid="a-trigger" onClick={openPanel}>
            open from a
          </button>
        </div>
      );
    }
    function ConsumerB(): React.ReactElement {
      const { open, closePanel } = useChatPanel();
      return (
        <div>
          <span data-testid="b-open">{open ? 'open' : 'closed'}</span>
          <button type="button" data-testid="b-trigger" onClick={closePanel}>
            close from b
          </button>
        </div>
      );
    }

    render(
      <ChatPanelProvider storage={null}>
        <ConsumerA />
        <ConsumerB />
      </ChatPanelProvider>,
    );

    expect(screen.getByTestId('a-open').textContent).toBe('closed');
    expect(screen.getByTestId('b-open').textContent).toBe('closed');

    act(() => {
      fireEvent.click(screen.getByTestId('a-trigger'));
    });
    expect(screen.getByTestId('a-open').textContent).toBe('open');
    expect(screen.getByTestId('b-open').textContent).toBe('open');

    act(() => {
      fireEvent.click(screen.getByTestId('b-trigger'));
    });
    expect(screen.getByTestId('a-open').textContent).toBe('closed');
    expect(screen.getByTestId('b-open').textContent).toBe('closed');
  });
});

// ── Persistence across route navigation ──────────────────────────────

describe('ChatPanelProvider — persistence across route navigation', () => {
  it('state survives a useNavigate() call when the provider is above the router', () => {
    function OpenStateProbe(): React.ReactElement {
      const { open } = useChatPanel();
      return <span data-testid="probe-open">{open ? 'open' : 'closed'}</span>;
    }

    function OpenButton(): React.ReactElement {
      const { openPanel } = useChatPanel();
      return (
        <button type="button" data-testid="open-btn" onClick={openPanel}>
          open
        </button>
      );
    }

    function NavigateButton(): React.ReactElement {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          data-testid="navigate"
          onClick={() => navigate('/agents/example-slug/calendar')}
        >
          go
        </button>
      );
    }

    render(
      <ChatPanelProvider storage={null}>
        <MemoryRouter initialEntries={['/agents']}>
          <OpenStateProbe />
          <OpenButton />
          <NavigateButton />
        </MemoryRouter>
      </ChatPanelProvider>,
    );

    expect(screen.getByTestId('probe-open').textContent).toBe('closed');
    act(() => {
      fireEvent.click(screen.getByTestId('open-btn'));
    });
    expect(screen.getByTestId('probe-open').textContent).toBe('open');

    act(() => {
      fireEvent.click(screen.getByTestId('navigate'));
    });
    // After the route transition the provider above the router still
    // owns the same state — the open flag did NOT reset back to closed.
    expect(screen.getByTestId('probe-open').textContent).toBe('open');
  });
});

// ── Sub-AC 2 of AC 12: per-agent active-thread persistence ───────────

describe('validateChatThreadId', () => {
  it('accepts canonical chat-<hex> ids', () => {
    expect(validateChatThreadId('chat-abc123')).toBe('chat-abc123');
    expect(validateChatThreadId('chat-deadbeef')).toBe('chat-deadbeef');
  });

  it('rejects malformed values', () => {
    expect(validateChatThreadId('')).toBeNull();
    expect(validateChatThreadId('not-a-thread')).toBeNull();
    expect(validateChatThreadId('chat-')).toBeNull();
    expect(validateChatThreadId('../etc/passwd')).toBeNull();
    expect(validateChatThreadId(42)).toBeNull();
    expect(validateChatThreadId(null)).toBeNull();
    expect(validateChatThreadId(undefined)).toBeNull();
  });
});

describe('getInitialActiveThreadMap', () => {
  it('returns an empty map when no storage is configured', () => {
    expect(getInitialActiveThreadMap({ storage: null })).toEqual({});
  });

  it('parses a persisted JSON map and validates each entry', () => {
    const storage = memoryStorage({
      [CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY]: JSON.stringify({
        writer: 'chat-aaaa',
        reviewer: 'chat-bbbb',
      }),
    });
    expect(getInitialActiveThreadMap({ storage })).toEqual({
      writer: 'chat-aaaa',
      reviewer: 'chat-bbbb',
    });
  });

  it('drops entries that fail validation but keeps the rest', () => {
    const storage = memoryStorage({
      [CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY]: JSON.stringify({
        writer: 'chat-aaaa',
        // Bad slug → dropped.
        'INVALID SLUG!': 'chat-bbbb',
        // Bad thread id → dropped.
        reviewer: '../etc/passwd',
      }),
    });
    expect(getInitialActiveThreadMap({ storage })).toEqual({
      writer: 'chat-aaaa',
    });
  });

  it('falls back to empty map for non-JSON / array / non-object payloads', () => {
    const storage = memoryStorage();
    storage.setItem(CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY, 'not-json');
    expect(getInitialActiveThreadMap({ storage })).toEqual({});

    storage.setItem(
      CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY,
      JSON.stringify(['array', 'not', 'object']),
    );
    expect(getInitialActiveThreadMap({ storage })).toEqual({});

    storage.setItem(
      CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY,
      JSON.stringify(null),
    );
    expect(getInitialActiveThreadMap({ storage })).toEqual({});
  });

  it('falls back to empty map when getItem throws', () => {
    const storage: ChatPanelOpenStorage = {
      getItem: () => {
        throw new Error('boom');
      },
      setItem: () => {},
    };
    expect(getInitialActiveThreadMap({ storage })).toEqual({});
  });
});

describe('ChatPanelProvider — active-thread map setters', () => {
  it('exposes getActiveThreadIdForAgent + setActiveThreadIdForAgent', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={null}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    expect(typeof result.current.getActiveThreadIdForAgent).toBe('function');
    expect(typeof result.current.setActiveThreadIdForAgent).toBe('function');
    // Empty by default — no agent has been pinned yet.
    expect(result.current.getActiveThreadIdForAgent('writer')).toBeNull();
  });

  it('round-trips a pin through the in-memory state', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={null}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    act(() => {
      result.current.setActiveThreadIdForAgent('writer', 'chat-aaaa');
    });
    expect(result.current.getActiveThreadIdForAgent('writer')).toBe(
      'chat-aaaa',
    );
    // Other agents are unaffected.
    expect(result.current.getActiveThreadIdForAgent('reviewer')).toBeNull();
  });

  it('persists pins to the configured storage', () => {
    const storage = memoryStorage();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={storage}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    act(() => {
      result.current.setActiveThreadIdForAgent('writer', 'chat-aaaa');
      result.current.setActiveThreadIdForAgent('reviewer', 'chat-bbbb');
    });
    const persisted = JSON.parse(
      storage.data[CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY] ?? '{}',
    );
    expect(persisted).toEqual({
      writer: 'chat-aaaa',
      reviewer: 'chat-bbbb',
    });
  });

  it('hydrates initial state from persisted storage', () => {
    const storage = memoryStorage({
      [CHAT_PANEL_ACTIVE_THREAD_STORAGE_KEY]: JSON.stringify({
        writer: 'chat-restored',
      }),
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={storage}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    expect(result.current.getActiveThreadIdForAgent('writer')).toBe(
      'chat-restored',
    );
  });

  it('passing null clears one agent\'s pin without affecting others', () => {
    const storage = memoryStorage();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={storage}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    act(() => {
      result.current.setActiveThreadIdForAgent('writer', 'chat-aaaa');
      result.current.setActiveThreadIdForAgent('reviewer', 'chat-bbbb');
    });
    expect(result.current.getActiveThreadIdForAgent('writer')).toBe(
      'chat-aaaa',
    );

    act(() => {
      result.current.setActiveThreadIdForAgent('writer', null);
    });
    expect(result.current.getActiveThreadIdForAgent('writer')).toBeNull();
    // reviewer's pin survives.
    expect(result.current.getActiveThreadIdForAgent('reviewer')).toBe(
      'chat-bbbb',
    );
  });

  it('rejects malformed slugs and thread ids without throwing', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={null}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    // Bad slug — setter is a no-op.
    act(() => {
      result.current.setActiveThreadIdForAgent(
        'INVALID SLUG!',
        'chat-aaaa',
      );
    });
    expect(
      result.current.getActiveThreadIdForAgent('INVALID SLUG!'),
    ).toBeNull();

    // Bad thread id — same agent surface should remain unaffected.
    act(() => {
      result.current.setActiveThreadIdForAgent('writer', 'chat-real');
    });
    expect(result.current.getActiveThreadIdForAgent('writer')).toBe(
      'chat-real',
    );
    act(() => {
      result.current.setActiveThreadIdForAgent('writer', '../etc/passwd');
    });
    // Setter coerces invalid to null → previous pin is cleared.
    expect(result.current.getActiveThreadIdForAgent('writer')).toBeNull();
  });

  it('survives a missing storage backing without throwing', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider storage={null}>{children}</ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });

    act(() => {
      result.current.setActiveThreadIdForAgent('writer', 'chat-aaaa');
    });
    expect(result.current.getActiveThreadIdForAgent('writer')).toBe(
      'chat-aaaa',
    );
  });

  it('honours defaultActiveThreadMap for deterministic test seeding', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatPanelProvider
        storage={null}
        defaultActiveThreadMap={{
          writer: 'chat-default',
          // Invalid entries get dropped on ingest.
          'INVALID SLUG': 'chat-x',
        }}
      >
        {children}
      </ChatPanelProvider>
    );
    const { result } = renderHook(() => useChatPanel(), { wrapper });
    expect(result.current.getActiveThreadIdForAgent('writer')).toBe(
      'chat-default',
    );
    expect(
      result.current.getActiveThreadIdForAgent('INVALID SLUG'),
    ).toBeNull();
  });
});
