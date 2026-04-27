/**
 * Tests for `./notification-bell.tsx` — the header bell trigger that
 * surfaces unread count and opens a side drawer with the global feed.
 *
 * AC 8 sub-AC 3 contract:
 *   1. The bell renders as an icon `Button` with a `data-component`
 *      hook so tests/CSS can pin it.
 *   2. `data-unread-count` mirrors the `unreadCount` from the global
 *      feed; the destructive badge is hidden when the count is `0`
 *      and capped at `99+` for layout stability.
 *   3. Clicking the bell opens the right-anchored shadcn `Sheet`
 *      drawer; the drawer renders the newest-first list of rows.
 *   4. Aria-label embeds the unread count so screen readers announce
 *      it without reading the visual chip text.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import {
  NotificationBell,
  formatRelativeTime,
  formatUnreadCount,
} from './notification-bell.tsx';

// ── Fetch stub helpers ───────────────────────────────────────────────

interface QueueResponse {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}

function makeFetch(queue: QueueResponse | QueueResponse[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const items = Array.isArray(queue) ? [...queue] : [queue];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (items.length === 0) {
      return Promise.reject(
        new Error(`fetch stub queue exhausted (url=${url})`),
      );
    }
    const desc = items.shift()!;
    const {
      ok = true,
      status = 200,
      statusText = 'OK',
      body = '',
    } = desc;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve({
      ok,
      status,
      statusText,
      text: () => Promise.resolve(text),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

afterEach(() => {
  cleanup();
});

// ── formatUnreadCount ────────────────────────────────────────────────

describe('formatUnreadCount', () => {
  it('renders the literal count when ≤ 99', () => {
    expect(formatUnreadCount(0)).toBe('0');
    expect(formatUnreadCount(1)).toBe('1');
    expect(formatUnreadCount(42)).toBe('42');
    expect(formatUnreadCount(99)).toBe('99');
  });

  it('caps at "99+" for counts > 99', () => {
    expect(formatUnreadCount(100)).toBe('99+');
    expect(formatUnreadCount(9999)).toBe('99+');
  });

  it('coerces non-finite / non-number / null to "0"', () => {
    expect(formatUnreadCount(null)).toBe('0');
    expect(formatUnreadCount(undefined)).toBe('0');
    expect(formatUnreadCount(Number.NaN)).toBe('0');
    expect(formatUnreadCount(-3)).toBe('0');
  });
});

// ── formatRelativeTime ───────────────────────────────────────────────

describe('formatRelativeTime', () => {
  const now = new Date('2026-04-27T12:00:00.000Z');

  it('returns "just now" for sub-45-second deltas', () => {
    const ts = new Date(now.getTime() - 10_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('just now');
  });

  it('floors seconds to minutes after 45s', () => {
    const ts = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('5m');
  });

  it('rolls into hours past 60m', () => {
    const ts = new Date(now.getTime() - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('3h');
  });

  it('rolls into days past 24h', () => {
    const ts = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('2d');
  });

  it('rolls into weeks past 7d', () => {
    const ts = new Date(now.getTime() - 14 * 86_400_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('2w');
  });

  it('returns "" for empty/missing input', () => {
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime('')).toBe('');
  });

  it('returns the raw value for unparseable input', () => {
    expect(formatRelativeTime('not a date', now)).toBe('not a date');
  });
});

// ── Trigger rendering + badge ────────────────────────────────────────

describe('NotificationBell — trigger', () => {
  it('renders as a shadcn ghost icon button', async () => {
    const { fetch } = makeFetch({
      body: { notifications: [], unreadCount: 0 },
    });
    const { container } = render(<NotificationBell fetch={fetch} />);

    const trigger = container.querySelector(
      '[data-component="notification-bell"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger!.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('data-variant', 'ghost');
    expect(trigger).toHaveAttribute('data-size', 'icon');

    // Wait for the loader settle so subsequent assertions about
    // the unread count read the resolved state.
    await waitFor(() =>
      expect(trigger).toHaveAttribute('data-unread-count', '0'),
    );
  });

  it('hides the badge when unreadCount is 0', async () => {
    const { fetch } = makeFetch({
      body: { notifications: [], unreadCount: 0 },
    });
    const { container } = render(<NotificationBell fetch={fetch} />);
    await waitFor(() => {
      const trigger = container.querySelector(
        '[data-component="notification-bell"]',
      );
      expect(trigger).toHaveAttribute('data-unread-count', '0');
    });
    expect(
      container.querySelector('[data-component="notification-bell-badge"]'),
    ).toBeNull();
  });

  it('shows the badge with the literal count when unread > 0', async () => {
    const { fetch } = makeFetch({
      body: {
        notifications: [
          {
            id: 'notif-aaaa1111',
            agent: 'writer',
            agentId: 'writer',
            source: 'agent',
            title: 'hello',
            body: 'hi',
            createdAt: '2026-04-27T11:50:00.000Z',
            read: false,
          },
        ],
        unreadCount: 7,
      },
    });
    const { container } = render(<NotificationBell fetch={fetch} />);

    await waitFor(() => {
      const trigger = container.querySelector(
        '[data-component="notification-bell"]',
      );
      expect(trigger).toHaveAttribute('data-unread-count', '7');
    });

    const badge = container.querySelector(
      '[data-component="notification-bell-badge"]',
    );
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('7');
  });

  it('caps the badge at "99+" when the count exceeds 99', async () => {
    const { fetch } = makeFetch({
      body: {
        notifications: [],
        unreadCount: 250,
      },
    });
    const { container } = render(<NotificationBell fetch={fetch} />);

    await waitFor(() => {
      const badge = container.querySelector(
        '[data-component="notification-bell-badge"]',
      );
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe('99+');
    });
  });

  it('embeds the unread count in the aria-label so SR users hear it', async () => {
    const { fetch } = makeFetch({
      body: { notifications: [], unreadCount: 3 },
    });
    const { container } = render(<NotificationBell fetch={fetch} />);
    await waitFor(() => {
      const trigger = container.querySelector(
        '[data-component="notification-bell"]',
      );
      expect(trigger).toHaveAttribute('aria-label', 'Notifications — 3 unread');
    });
  });
});

// ── Drawer open/close + content ──────────────────────────────────────

describe('NotificationBell — drawer', () => {
  it('does not render the drawer body until the bell is clicked', async () => {
    const { fetch } = makeFetch({
      body: { notifications: [], unreadCount: 0 },
    });
    render(<NotificationBell fetch={fetch} />);
    await waitFor(() => {
      // Loader settled; trigger is on screen.
      expect(
        document.querySelector('[data-component="notification-bell"]'),
      ).not.toBeNull();
    });
    // Drawer (which is portal-rendered into document.body) has not
    // appeared yet because the user hasn't clicked the bell.
    expect(
      document.querySelector('[data-component="notification-bell-drawer"]'),
    ).toBeNull();
  });

  it('opens the drawer on click and renders the newest-first feed', async () => {
    const payload = {
      notifications: [
        {
          id: 'notif-aaaa1111',
          agent: 'writer',
          agentId: 'writer',
          source: 'agent',
          title: 'First update',
          body: 'Body of the first update.',
          createdAt: '2026-04-27T11:55:00.000Z',
          read: false,
        },
        {
          id: 'notif-bbbb2222',
          agent: 'planner',
          agentId: 'planner',
          source: 'system',
          systemEvent: 'budget-exhausted',
          title: 'Budget exhausted',
          body: 'Pausing the agent.',
          createdAt: '2026-04-27T10:00:00.000Z',
          read: true,
        },
      ],
      unreadCount: 1,
    };
    const { fetch } = makeFetch({ body: payload });
    render(<NotificationBell fetch={fetch} />);

    const trigger = await screen.findByRole('button', {
      name: /Notifications/,
    });
    fireEvent.click(trigger);

    // The drawer is portal-rendered into `document.body`; querying the
    // global document is the canonical pattern other shadcn Sheet
    // consumers in this repo follow.
    await waitFor(() => {
      expect(
        document.querySelector('[data-component="notification-bell-drawer"]'),
      ).not.toBeNull();
    });

    const rows = document.querySelectorAll(
      '[data-component="notification-bell-row"]',
    );
    expect(rows.length).toBe(2);
    expect(rows[0]).toHaveAttribute('data-notification-id', 'notif-aaaa1111');
    expect(rows[0]).toHaveAttribute('data-read', 'false');
    expect(rows[1]).toHaveAttribute('data-notification-id', 'notif-bbbb2222');
    expect(rows[1]).toHaveAttribute('data-read', 'true');
  });

  it('renders an empty-state when there are no notifications', async () => {
    const { fetch } = makeFetch({
      body: { notifications: [], unreadCount: 0 },
    });
    render(<NotificationBell fetch={fetch} />);
    const trigger = await screen.findByRole('button', {
      name: /Notifications/,
    });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(
        document.querySelector('[data-component="notification-bell-empty"]'),
      ).not.toBeNull();
    });
  });

  it('caps the drawer body at 10 rows even when the feed is longer', async () => {
    const notifications = Array.from({ length: 15 }, (_, i) => ({
      id: `notif-${String(i).padStart(8, '0')}`,
      agent: 'writer',
      agentId: 'writer',
      source: 'agent',
      title: `Row ${i}`,
      body: `body ${i}`,
      createdAt: '2026-04-27T11:00:00.000Z',
      read: i % 2 === 0,
    }));
    const { fetch } = makeFetch({
      body: { notifications, unreadCount: 7 },
    });
    render(<NotificationBell fetch={fetch} />);

    const trigger = await screen.findByRole('button', {
      name: /Notifications/,
    });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(
        document.querySelector('[data-component="notification-bell-drawer"]'),
      ).not.toBeNull();
    });

    const rows = document.querySelectorAll(
      '[data-component="notification-bell-row"]',
    );
    expect(rows.length).toBe(10);
  });

  it('surfaces a destructive error block when the load fails with no prior data', async () => {
    const { fetch } = makeFetch({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: { error: 'boom' },
    });
    render(<NotificationBell fetch={fetch} />);

    // Click immediately — the loader will resolve with an error, the
    // bell still renders (badge hidden), and the drawer surfaces the
    // destructive error block.
    const trigger = await screen.findByRole('button', {
      name: /Notifications/,
    });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(
        document.querySelector('[data-component="notification-bell-error"]'),
      ).not.toBeNull();
    });
  });
});
