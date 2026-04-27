/**
 * Tests for `./notification-list.tsx` — the standalone reverse-chrono
 * notification list component (AC 8, Sub-AC 4).
 *
 * Contract:
 *   1. Rows render in reverse-chronological (newest-first) order even
 *      when the input is unsorted — `sortNewestFirst` is a defensive
 *      sort the component applies before rendering.
 *   2. An empty array surfaces a `data-component="notification-list-empty"`
 *      slot with default copy (overridable via `emptyMessage`).
 *   3. The `limit` prop caps visible rows after the sort (the bell
 *      drawer uses `limit=10`; the inbox view does not pass `limit`).
 *   4. Unread rows render an unread dot + bolder title; read rows do
 *      not render the dot. The unread dot is queryable via a
 *      `data-component` hook so reviewers can pin the contract.
 *   5. The `agent` slug chip appears by default and is suppressed when
 *      `hideAgentLabel` is set (per-agent inbox tab usage).
 *   6. System-source rows render a `system` tag; agent-source rows do
 *      not.
 *   7. `onSelect` makes rows clickable (role + tabIndex + Enter/Space
 *      keyboard handler).
 *   8. Title is always visible; body is hidden by default (AC 14 —
 *      list/badge view shows title only) and shown only when the row
 *      is expanded via the chevron toggle. `defaultExpanded` flips the
 *      initial state for callers that want an "all expanded" surface.
 *      The toggle never fires the row-level `onSelect` — clicking the
 *      chevron toggles body visibility independently from mark-as-read.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js`.
 * Command: `pnpm test:spa`.
 *
 * The import below uses the `.jsx` extension because TypeScript's
 * Bundler resolution maps `.jsx` onto the `.tsx` source file (matches
 * the `activity-timeline.test.tsx` convention in this directory).
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  NotificationList,
  sortNewestFirst,
  type NotificationListItem,
} from './notification-list.jsx';

// ── Fixtures ─────────────────────────────────────────────────────────

const NOW = new Date('2026-04-27T12:00:00.000Z');

/**
 * Build a notification fixture with sensible defaults and an explicit
 * timestamp so test order is unambiguous.
 */
function notif(
  overrides: Partial<NotificationListItem> & { id: string; createdAt: string },
): NotificationListItem {
  return {
    title: 'A notification',
    body: 'Body text.',
    agent: 'writer',
    agentId: 'writer',
    source: 'agent',
    read: false,
    ...overrides,
  };
}

const NEWEST = notif({
  id: 'notif-newest',
  title: 'Newest',
  createdAt: '2026-04-27T11:55:00.000Z',
});
const MIDDLE = notif({
  id: 'notif-middle',
  title: 'Middle',
  createdAt: '2026-04-27T10:00:00.000Z',
  read: true,
});
const OLDEST = notif({
  id: 'notif-oldest',
  title: 'Oldest',
  createdAt: '2026-04-26T08:00:00.000Z',
  source: 'system',
  systemEvent: 'budget-exhausted',
  agent: 'planner',
  agentId: 'planner',
});

afterEach(() => {
  cleanup();
});

// ── sortNewestFirst ──────────────────────────────────────────────────

describe('sortNewestFirst', () => {
  it('sorts notifications by createdAt descending', () => {
    const sorted = sortNewestFirst([OLDEST, NEWEST, MIDDLE]);
    expect(sorted.map((row) => row.id)).toEqual([
      'notif-newest',
      'notif-middle',
      'notif-oldest',
    ]);
  });

  it('preserves input order on equal timestamps (stable sort)', () => {
    const a = notif({ id: 'a', createdAt: '2026-04-27T10:00:00.000Z' });
    const b = notif({ id: 'b', createdAt: '2026-04-27T10:00:00.000Z' });
    const c = notif({ id: 'c', createdAt: '2026-04-27T10:00:00.000Z' });
    const sorted = sortNewestFirst([a, b, c]);
    expect(sorted.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops unparseable timestamps to the end of the list', () => {
    const broken = notif({ id: 'broken', createdAt: 'not-a-date' });
    const sorted = sortNewestFirst([broken, NEWEST]);
    expect(sorted.map((row) => row.id)).toEqual(['notif-newest', 'broken']);
  });

  it('does not mutate the input array', () => {
    const input = [OLDEST, NEWEST, MIDDLE];
    const snapshot = [...input];
    sortNewestFirst(input);
    expect(input).toEqual(snapshot);
  });
});

// ── Empty state ──────────────────────────────────────────────────────

describe('NotificationList — empty state', () => {
  it('renders the empty slot with default copy when notifications=[]', () => {
    const { container } = render(<NotificationList notifications={[]} />);
    const empty = container.querySelector(
      '[data-component="notification-list-empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toMatch(/no notifications yet/i);
    expect(
      container.querySelector('[data-component="notification-list"]'),
    ).toBeNull();
  });

  it('honors a custom emptyMessage prop', () => {
    const { container } = render(
      <NotificationList
        notifications={[]}
        emptyMessage="Nothing here for this agent."
      />,
    );
    const empty = container.querySelector(
      '[data-component="notification-list-empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe('Nothing here for this agent.');
  });
});

// ── Reverse-chronological order ──────────────────────────────────────

describe('NotificationList — reverse-chronological order', () => {
  it('renders rows newest-first regardless of input order', () => {
    const { container } = render(
      <NotificationList
        notifications={[OLDEST, NEWEST, MIDDLE]}
        now={NOW}
      />,
    );
    const list = container.querySelector(
      '[data-component="notification-list"]',
    );
    expect(list).not.toBeNull();
    expect(list).toHaveAttribute('data-row-count', '3');

    const rows = container.querySelectorAll(
      '[data-component="notification-list-row"]',
    );
    expect(rows.length).toBe(3);
    expect(rows[0]).toHaveAttribute('data-notification-id', 'notif-newest');
    expect(rows[1]).toHaveAttribute('data-notification-id', 'notif-middle');
    expect(rows[2]).toHaveAttribute('data-notification-id', 'notif-oldest');
  });

  it('caps visible rows when limit is provided', () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      notif({
        id: `n-${String(i).padStart(2, '0')}`,
        title: `Row ${i}`,
        // Strictly decreasing so input order = render order under the sort.
        createdAt: new Date(NOW.getTime() - i * 60_000).toISOString(),
      }),
    );
    const { container } = render(
      <NotificationList notifications={rows} limit={10} now={NOW} />,
    );
    const visible = container.querySelectorAll(
      '[data-component="notification-list-row"]',
    );
    expect(visible.length).toBe(10);
    expect(visible[0]).toHaveAttribute('data-notification-id', 'n-00');
    expect(visible[9]).toHaveAttribute('data-notification-id', 'n-09');
  });

  it('renders all rows when limit is omitted (full inbox view)', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      notif({
        id: `n-${i}`,
        createdAt: new Date(NOW.getTime() - i * 60_000).toISOString(),
      }),
    );
    const { container } = render(
      <NotificationList notifications={rows} now={NOW} />,
    );
    const visible = container.querySelectorAll(
      '[data-component="notification-list-row"]',
    );
    expect(visible.length).toBe(12);
  });
});

// ── Read / unread row affordances ────────────────────────────────────

describe('NotificationList — read state', () => {
  it('renders an unread dot + data-read=false for unread rows', () => {
    const { container } = render(
      <NotificationList notifications={[NEWEST]} now={NOW} />,
    );
    const row = container.querySelector(
      '[data-component="notification-list-row"]',
    );
    expect(row).toHaveAttribute('data-read', 'false');
    expect(
      row!.querySelector(
        '[data-component="notification-list-row-unread-dot"]',
      ),
    ).not.toBeNull();
  });

  it('omits the unread dot + sets data-read=true for read rows', () => {
    const { container } = render(
      <NotificationList notifications={[MIDDLE]} now={NOW} />,
    );
    const row = container.querySelector(
      '[data-component="notification-list-row"]',
    );
    expect(row).toHaveAttribute('data-read', 'true');
    expect(
      row!.querySelector(
        '[data-component="notification-list-row-unread-dot"]',
      ),
    ).toBeNull();
  });
});

// ── Agent-label & system tag ─────────────────────────────────────────

describe('NotificationList — agent label & system tag', () => {
  it('renders the agent slug chip by default', () => {
    const { container } = render(
      <NotificationList notifications={[NEWEST]} now={NOW} />,
    );
    expect(container.querySelector('code')!.textContent).toBe('writer');
  });

  it('hides the agent slug chip when hideAgentLabel is true', () => {
    const { container } = render(
      <NotificationList
        notifications={[NEWEST]}
        hideAgentLabel
        now={NOW}
      />,
    );
    expect(container.querySelector('code')).toBeNull();
  });

  it('renders the system tag for system-source rows only', () => {
    const { container } = render(
      <NotificationList
        notifications={[NEWEST, OLDEST]}
        now={NOW}
      />,
    );
    const tags = container.querySelectorAll(
      '[data-component="notification-list-row-system-tag"]',
    );
    expect(tags.length).toBe(1);
    expect(tags[0]!.textContent).toMatch(/system/i);
    expect(tags[0]!.textContent).toMatch(/budget-exhausted/);
  });
});

// ── Click handling ───────────────────────────────────────────────────

describe('NotificationList — onSelect', () => {
  it('makes rows clickable and forwards the row to the callback', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <NotificationList
        notifications={[NEWEST, MIDDLE]}
        onSelect={onSelect}
        now={NOW}
      />,
    );
    // Scope to the row elements (which carry role="button" via the
    // <li> wrapper) — the chevron expand toggle is *also* a button, so
    // a bare `getAllByRole('button')` would now over-match. We assert
    // on the row contract here.
    const rows = container.querySelectorAll(
      '[data-component="notification-list-row"][role="button"]',
    );
    expect(rows.length).toBe(2);
    fireEvent.click(rows[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'notif-newest' }),
    );
  });

  it('fires onSelect on Enter and Space keypress', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <NotificationList
        notifications={[NEWEST]}
        onSelect={onSelect}
        now={NOW}
      />,
    );
    const row = container.querySelector(
      '[data-component="notification-list-row"][role="button"]',
    );
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: 'Enter' });
    fireEvent.keyDown(row!, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('does not assign a button role / tabIndex to the row when onSelect is omitted', () => {
    const { container } = render(
      <NotificationList notifications={[NEWEST]} now={NOW} />,
    );
    // The row itself must not be a button when no onSelect is supplied.
    // (The chevron expand toggle is its own <button> and is unaffected.)
    const row = container.querySelector(
      '[data-component="notification-list-row"]',
    );
    expect(row).not.toBeNull();
    expect(row).not.toHaveAttribute('role', 'button');
    expect(row).not.toHaveAttribute('tabIndex');
  });
});

// ── Accessible list semantics ────────────────────────────────────────

describe('NotificationList — accessibility', () => {
  it('exposes a labeled list role', () => {
    render(
      <NotificationList notifications={[NEWEST, MIDDLE]} now={NOW} />,
    );
    const list = screen.getByRole('list', { name: /notifications/i });
    expect(list).not.toBeNull();
  });

  it('renders the createdAt as a <time dateTime=…> element', () => {
    const { container } = render(
      <NotificationList notifications={[NEWEST]} now={NOW} />,
    );
    const time = container.querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('dateTime', NEWEST.createdAt);
  });
});

// ── Title in list view, body on expand (AC 14) ───────────────────────

describe('NotificationList — title in list view, body on expand (AC 14)', () => {
  const BODY_TEXT = 'Long-form body explaining what the agent observed.';
  const ROW = notif({
    id: 'notif-expandable',
    title: 'Status update',
    body: BODY_TEXT,
    createdAt: '2026-04-27T11:55:00.000Z',
  });

  it('renders the title in the default (collapsed) list view', () => {
    const { container } = render(
      <NotificationList notifications={[ROW]} now={NOW} />,
    );
    // Title is always rendered.
    const row = container.querySelector(
      '[data-component="notification-list-row"]',
    );
    expect(row).not.toBeNull();
    expect(row!.textContent).toMatch(/Status update/);
  });

  it('hides the body by default — the list/badge view is title-only', () => {
    const { container } = render(
      <NotificationList notifications={[ROW]} now={NOW} />,
    );
    const row = container.querySelector(
      '[data-component="notification-list-row"]',
    );
    expect(row).toHaveAttribute('data-expanded', 'false');
    expect(
      container.querySelector('[data-component="notification-list-row-body"]'),
    ).toBeNull();
    expect(container.textContent ?? '').not.toContain(BODY_TEXT);
  });

  it('renders an expand toggle (chevron) for rows that have a body', () => {
    const { container } = render(
      <NotificationList notifications={[ROW]} now={NOW} />,
    );
    const toggle = container.querySelector(
      '[data-component="notification-list-row-expand-toggle"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-label', 'Expand notification body');
  });

  it('does not render the expand toggle when the row has no body', () => {
    const bodyless = notif({
      id: 'notif-no-body',
      title: 'Just a title',
      body: '',
      createdAt: '2026-04-27T11:55:00.000Z',
    });
    const { container } = render(
      <NotificationList notifications={[bodyless]} now={NOW} />,
    );
    expect(
      container.querySelector(
        '[data-component="notification-list-row-expand-toggle"]',
      ),
    ).toBeNull();
  });

  it('reveals the body when the expand toggle is clicked', () => {
    const { container } = render(
      <NotificationList notifications={[ROW]} now={NOW} />,
    );
    const toggle = container.querySelector(
      '[data-component="notification-list-row-expand-toggle"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    const row = container.querySelector(
      '[data-component="notification-list-row"]',
    );
    expect(row).toHaveAttribute('data-expanded', 'true');
    const body = container.querySelector(
      '[data-component="notification-list-row-body"]',
    );
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe(BODY_TEXT);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-label', 'Collapse notification body');
  });

  it('collapses the body again on a second toggle click', () => {
    const { container } = render(
      <NotificationList notifications={[ROW]} now={NOW} />,
    );
    const toggle = container.querySelector(
      '[data-component="notification-list-row-expand-toggle"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle); // expand
    fireEvent.click(toggle); // collapse
    expect(
      container.querySelector('[data-component="notification-list-row-body"]'),
    ).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles via Enter and Space keypresses', () => {
    const { container } = render(
      <NotificationList notifications={[ROW]} now={NOW} />,
    );
    const toggle = container.querySelector(
      '[data-component="notification-list-row-expand-toggle"]',
    ) as HTMLButtonElement;
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(
      container.querySelector('[data-component="notification-list-row-body"]'),
    ).not.toBeNull();
    fireEvent.keyDown(toggle, { key: ' ' });
    expect(
      container.querySelector('[data-component="notification-list-row-body"]'),
    ).toBeNull();
  });

  it('does not fire onSelect when the expand toggle is clicked', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <NotificationList
        notifications={[ROW]}
        onSelect={onSelect}
        now={NOW}
      />,
    );
    const toggle = container.querySelector(
      '[data-component="notification-list-row-expand-toggle"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    // Body shows…
    expect(
      container.querySelector('[data-component="notification-list-row-body"]'),
    ).not.toBeNull();
    // …but onSelect (mark-as-read) was NOT triggered — toggling open the
    // body should not also flip read state.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('still fires onSelect when clicking the row body outside the toggle', () => {
    const onSelect = vi.fn();
    render(
      <NotificationList
        notifications={[ROW]}
        onSelect={onSelect}
        now={NOW}
      />,
    );
    const row = screen.getByRole('button', { name: /Status update/i });
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'notif-expandable' }),
    );
  });

  it('mounts rows expanded when defaultExpanded is true', () => {
    const { container } = render(
      <NotificationList
        notifications={[ROW]}
        defaultExpanded
        now={NOW}
      />,
    );
    const row = container.querySelector(
      '[data-component="notification-list-row"]',
    );
    expect(row).toHaveAttribute('data-expanded', 'true');
    const body = container.querySelector(
      '[data-component="notification-list-row-body"]',
    );
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe(BODY_TEXT);
  });

  it('expand state is per-row — toggling one row does not affect siblings', () => {
    const second = notif({
      id: 'notif-sibling',
      title: 'Second',
      body: 'Second body.',
      createdAt: '2026-04-27T11:50:00.000Z',
    });
    const { container } = render(
      <NotificationList notifications={[ROW, second]} now={NOW} />,
    );
    const toggles = container.querySelectorAll(
      '[data-component="notification-list-row-expand-toggle"]',
    );
    expect(toggles.length).toBe(2);
    fireEvent.click(toggles[0]!);
    const rows = container.querySelectorAll(
      '[data-component="notification-list-row"]',
    );
    expect(rows[0]).toHaveAttribute('data-expanded', 'true');
    expect(rows[1]).toHaveAttribute('data-expanded', 'false');
  });

  it('wires aria-controls between the toggle and the body region', () => {
    const { container } = render(
      <NotificationList notifications={[ROW]} now={NOW} />,
    );
    const toggle = container.querySelector(
      '[data-component="notification-list-row-expand-toggle"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    const ariaControls = toggle.getAttribute('aria-controls');
    expect(ariaControls).toBeTruthy();
    const body = container.querySelector(
      '[data-component="notification-list-row-body"]',
    );
    expect(body).not.toBeNull();
    expect(body!.id).toBe(ariaControls);
  });
});
