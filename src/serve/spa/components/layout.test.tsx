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
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
