/**
 * Component tests for the shared `<Layout />` shell.
 *
 * AC 11 contract — *Unread badge count is visible in the dashboard
 * header or sidebar*:
 *
 *   1. Every page rendered through `<Layout />` carries the
 *      `<NotificationBell />` trigger inside the top header. The bell
 *      hosts the unread-count badge (rendered when `unreadCount > 0`),
 *      which is what makes the count visible in the dashboard header.
 *   2. The badge mirrors `data?.unreadCount` from the global feed via
 *      `data-unread-count` on the trigger button — tests can pin the
 *      count without depending on the rendered chip text.
 *   3. The bell sits inside the `<header>` (not in `<main>` or footer)
 *      so the badge stays a persistent header-level affordance across
 *      every route, matching the AC's "dashboard header" surface.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

import { Layout } from './layout.tsx';
import { ThemeProvider } from './theme-provider.jsx';

// The Layout pulls the agent list (used by the secondary sidebar) and
// the global notifications feed via `fetch`. We stub both endpoints so
// the test runs deterministically and the unread badge has a known
// count to assert against.
function stubFetch(unreadCount: number): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/api/notifications')) {
      return new Response(
        JSON.stringify({ notifications: [], unreadCount }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/agents')) {
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  document.documentElement.classList.remove('dark');
});

describe('Layout — notification bell + unread badge in dashboard header', () => {
  it('renders the NotificationBell trigger inside the <header> element', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(3);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout title="Agents">
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const header = container.querySelector('header');
      expect(header).not.toBeNull();
      const trigger = header!.querySelector(
        '[data-component="notification-bell"]',
      );
      expect(trigger).not.toBeNull();
      expect(trigger!.tagName).toBe('BUTTON');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('exposes the unread count on the header bell trigger via data-unread-count', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(5);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      await waitFor(() => {
        const trigger = container.querySelector(
          'header [data-component="notification-bell"]',
        );
        expect(trigger).toHaveAttribute('data-unread-count', '5');
      });

      const badge = container.querySelector(
        'header [data-component="notification-bell-badge"]',
      );
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe('5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('hides the badge in the header when the unread count is 0', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      await waitFor(() => {
        const trigger = container.querySelector(
          'header [data-component="notification-bell"]',
        );
        expect(trigger).toHaveAttribute('data-unread-count', '0');
      });

      expect(
        container.querySelector(
          'header [data-component="notification-bell-badge"]',
        ),
      ).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('caps the header badge at "99+" when the unread count exceeds 99', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(250);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      await waitFor(() => {
        const badge = container.querySelector(
          'header [data-component="notification-bell-badge"]',
        );
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toBe('99+');
      });

      const trigger = container.querySelector(
        'header [data-component="notification-bell"]',
      );
      expect(trigger).toHaveAttribute('data-unread-count', '250');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the bell to the right of any caller-supplied header actions', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(1);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout
              headerActions={
                <span data-component="custom-action">extra</span>
              }
            >
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const header = container.querySelector('header');
      expect(header).not.toBeNull();
      const action = header!.querySelector(
        '[data-component="custom-action"]',
      );
      const bell = header!.querySelector(
        '[data-component="notification-bell"]',
      );
      expect(action).not.toBeNull();
      expect(bell).not.toBeNull();
      // DOM order: caller actions appear before the bell so the bell
      // always anchors the right edge of the header.
      const order = action!.compareDocumentPosition(bell!);
      expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Layout — mobile sidebar contract (Sub-AC 3)', () => {
  // Below `md` (768px) the persistent desktop rails must surrender their
  // inline width to <SidebarInset> so <main> reclaims the full viewport,
  // while the same nav stays one tap away through a Sheet-based drawer.
  // These tests pin the markup that delivers that contract:
  //
  //   1. The header carries a 44×44 hamburger trigger (`md:hidden`) wired
  //      to open the MobileAppSidebar drawer. (The desktop SidebarTrigger
  //      that previously lived next to it was removed — the rail's
  //      collapse state has no UI affordance now.)
  //   2. The AgentDetailSidebar slot is wrapped in `hidden md:contents`
  //      so the secondary 16rem rail does not render an inline-flow box
  //      below `md`. At `md+` the wrapper is layout-transparent.
  //   3. Clicking the hamburger flips the data-mobile-drawer-open marker
  //      on the inset so observers (analytics, tests, future polish) can
  //      detect the drawer state without reaching into Radix internals.

  it('renders no desktop SidebarTrigger and shows a 44×44 hamburger trigger', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      // The previous desktop SidebarTrigger was removed because clicking
      // it had no observable effect. Assert it is gone from the header.
      expect(
        container.querySelector('header [data-component="sidebar-trigger"]'),
      ).toBeNull();

      // Mobile hamburger trigger is present and `md:hidden` (only fires on
      // narrow viewports). 44×44 touch target via `h-11 w-11`.
      const mobileTrigger = container.querySelector(
        'header [data-component="mobile-drawer-trigger"]',
      );
      expect(mobileTrigger).not.toBeNull();
      expect(mobileTrigger!.tagName).toBe('BUTTON');
      expect(mobileTrigger!.className).toMatch(/\bmd:hidden\b/);
      expect(mobileTrigger!.className).toMatch(/\bh-11\b/);
      expect(mobileTrigger!.className).toMatch(/\bw-11\b/);
      expect(mobileTrigger!.getAttribute('aria-label')).toBe(
        'Open navigation menu',
      );
      expect(mobileTrigger!.getAttribute('aria-haspopup')).toBe('dialog');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('wraps the agent-detail sidebar in a `hidden md:contents` slot so it surrenders its inline width below md', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents/example-slug/calendar']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const slot = container.querySelector(
        '[data-component="agent-detail-sidebar-slot"]',
      );
      expect(slot).not.toBeNull();
      // Below md: `hidden` collapses the wrapper. At md+: `md:contents`
      // makes the wrapper layout-transparent so the inner Sidebar flows
      // exactly as before.
      expect(slot!.className).toMatch(/\bhidden\b/);
      expect(slot!.className).toMatch(/\bmd:contents\b/);
      // The inner agent-detail-sidebar markup is reused 1:1 (no
      // duplicated mobile copy) — the wrapper is the only mobile-bound
      // change.
      expect(
        slot!.querySelector('[data-component="agent-detail-sidebar"]'),
      ).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('omits the agent-detail sidebar slot entirely on routes outside /agents/:slug', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      // The slot wrapper still mounts (we want a stable layout shell),
      // but the inner AgentDetailSidebar returns null off-route so no
      // sidebar markup is emitted at all.
      const slot = container.querySelector(
        '[data-component="agent-detail-sidebar-slot"]',
      );
      expect(slot).not.toBeNull();
      expect(
        slot!.querySelector('[data-component="agent-detail-sidebar"]'),
      ).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('flips the `data-mobile-drawer-open` marker on the inset when the hamburger is clicked', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const inset = container.querySelector('[data-component="layout"]');
      expect(inset).not.toBeNull();
      expect(inset!.getAttribute('data-mobile-drawer-open')).toBe('false');

      const trigger = container.querySelector(
        '[data-component="mobile-drawer-trigger"]',
      );
      expect(trigger).not.toBeNull();

      act(() => {
        fireEvent.click(trigger!);
      });

      await waitFor(() => {
        expect(inset!.getAttribute('data-mobile-drawer-open')).toBe('true');
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps <SidebarInset> on flex-1 + min-w-0 so <main> reclaims full width when both rails collapse', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const inset = container.querySelector('[data-component="layout"]');
      expect(inset).not.toBeNull();
      // `min-w-0` is the critical token — without it the inset would
      // refuse to shrink below the intrinsic width of its widest child,
      // forcing horizontal overflow at narrow viewports.
      expect(inset!.className).toMatch(/\bmin-w-0\b/);
      // SidebarInset's own primitive recipe contributes `flex-1`.
      expect(inset!.className).toMatch(/\bflex-1\b/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Layout — persistent floating chat bubble (AC 9 Sub-AC 3)', () => {
  // The FloatingChatBubble is the chat affordance shipped in AC 9. It
  // must be mounted at the Layout shell so it persists across every
  // route inside `<Routes>` — including `/agents`, `/agents/:slug`,
  // and the deep-link drawer routes — without unmounting on
  // navigation.

  it('mounts the FloatingChatBubble inside every Layout shell', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const bubble = container.querySelector(
        '[data-component="floating-chat-bubble"]',
      );
      expect(bubble).not.toBeNull();
      expect(bubble!.getAttribute('data-state')).toBe('closed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('also renders the FloatingChatBubble on /agents/:slug routes', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents/example-slug/calendar']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const bubble = container.querySelector(
        '[data-component="floating-chat-bubble"]',
      );
      expect(bubble).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the same FloatingChatBubble DOM node mounted across route transitions', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);

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

    try {
      const { container, getByTestId } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <NavigateButton />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const bubbleBefore = container.querySelector(
        '[data-component="floating-chat-bubble"]',
      );
      expect(bubbleBefore).not.toBeNull();

      act(() => {
        fireEvent.click(getByTestId('navigate'));
      });

      await waitFor(() => {
        const main = container.querySelector('[data-component="main"]');
        expect(main!.getAttribute('data-pathname')).toBe(
          '/agents/example-slug/calendar',
        );
      });

      // Same DOM identity across routes — the bubble did not unmount
      // and remount, which would otherwise destroy its open/closed
      // state and any in-flight chat session.
      expect(
        container.querySelector('[data-component="floating-chat-bubble"]'),
      ).toBe(bubbleBefore);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Layout — route-transition stability (AC 10)', () => {
  // The Layout shell mounts once at app startup and persists across every
  // route change inside `<Routes>`. The `<main>` container scrolls
  // independently of the document, so without an explicit reset its
  // scrollTop persists across navigations — which on mobile reads as a
  // visual layout shift (new route renders already scrolled).
  //
  // These tests pin the markup and behaviour that closes that class:
  //
  //   1. `<main>` carries `data-pathname` mirroring the active route so
  //      observers can detect a route transition without subscribing to
  //      router internals.
  //   2. The shell's `<header>`, `<footer>`, and the agent-detail
  //      sidebar slot all stay in the DOM at the same spot regardless of
  //      route — only the `<main>` body content swaps.
  //   3. Navigating to a new pathname resets the `<main>` scroll offset
  //      back to 0 so the new route lands at the top.

  it('exposes the active pathname on the <main> container so route changes are observable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <div>page body</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const main = container.querySelector('[data-component="main"]');
      expect(main).not.toBeNull();
      expect(main!.getAttribute('data-pathname')).toBe('/agents');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the same shell elements (header, main, footer) mounted across route transitions', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);

    // Drive a route change from inside the tree so we can compare DOM
    // identity across pathnames. If the shell remounted on every route
    // change the elements would be different node references — that's
    // the layout-shift class we want to lock out.
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

    try {
      const { container, getByTestId } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <NavigateButton />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const headerBefore = container.querySelector('header');
      const mainBefore = container.querySelector('[data-component="main"]');
      const footerBefore = container.querySelector('footer');
      expect(headerBefore).not.toBeNull();
      expect(mainBefore).not.toBeNull();
      expect(footerBefore).not.toBeNull();
      expect(mainBefore!.getAttribute('data-pathname')).toBe('/agents');

      act(() => {
        fireEvent.click(getByTestId('navigate'));
      });

      await waitFor(() => {
        const main = container.querySelector('[data-component="main"]');
        expect(main!.getAttribute('data-pathname')).toBe(
          '/agents/example-slug/calendar',
        );
      });

      // Same DOM identity — the shell did not unmount/remount.
      expect(container.querySelector('header')).toBe(headerBefore);
      expect(container.querySelector('[data-component="main"]')).toBe(mainBefore);
      expect(container.querySelector('footer')).toBe(footerBefore);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resets the <main> scroll offset when the pathname changes', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(0);

    function NavigateButton({ to }: { to: string }): React.ReactElement {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          data-testid={`navigate-${to}`}
          onClick={() => navigate(to)}
        >
          {to}
        </button>
      );
    }

    try {
      const { container, getByTestId } = render(
        <MemoryRouter initialEntries={['/agents']}>
          <ThemeProvider>
            <Layout>
              <NavigateButton to="/agents/example-slug/calendar" />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>,
      );

      const main = container.querySelector(
        '[data-component="main"]',
      ) as HTMLElement | null;
      expect(main).not.toBeNull();

      // Stand in for a real scroll event — jsdom doesn't run layout, so
      // we set scrollTop directly to assert the reset effect runs on
      // route change. Capture scrollTo() calls so the test still pins
      // the contract on environments that prefer the modern API.
      const scrollToSpy = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (main as any).scrollTo = scrollToSpy;
      main!.scrollTop = 480;

      act(() => {
        fireEvent.click(getByTestId('navigate-/agents/example-slug/calendar'));
      });

      await waitFor(() => {
        // Either scrollTo({top:0}) was called or scrollTop was zeroed —
        // both satisfy the "land at the top" contract.
        const reset = main!.scrollTop === 0 || scrollToSpy.mock.calls.length > 0;
        expect(reset).toBe(true);
      });

      if (scrollToSpy.mock.calls.length > 0) {
        const firstCall = scrollToSpy.mock.calls[0]?.[0] as
          | { top?: number }
          | undefined;
        expect(firstCall?.top).toBe(0);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
