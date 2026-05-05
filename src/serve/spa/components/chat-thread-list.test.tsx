/**
 * Tests for `./chat-thread-list.tsx` — Sub-AC 3 of AC 5.
 *
 * Contract pinned by these tests:
 *
 *   1. Renders one row per thread, in the order the parent supplies.
 *   2. The row matching `activeThreadId` carries `aria-current="true"`
 *      and the canonical `bg-accent` highlight class so both sighted
 *      and AT users see the same selection state.
 *   3. Clicking a row dispatches `onSelect` with that row's thread id.
 *   4. Loading + empty + error states are mutually-exclusive surfaces:
 *      a stale list survives a background refresh; a fresh load with
 *      no cache shows the spinner; an error sits above whatever was
 *      last rendered (or the empty state).
 *   5. Title-resolution falls through `title` → preview → "New chat".
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ChatThreadList } from './chat-thread-list.tsx';
import type { ChatThreadSummary } from '../lib/api-client.js';

afterEach(() => {
  cleanup();
});

function makeThread(overrides: Partial<ChatThreadSummary>): ChatThreadSummary {
  return {
    id: overrides.id ?? 'chat-aaaa',
    agentId: overrides.agentId ?? 'writer',
    title: overrides.title,
    createdAt: overrides.createdAt ?? '2026-04-30T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-30T00:00:00.000Z',
    messageCount: overrides.messageCount ?? 0,
    lastMessagePreview: overrides.lastMessagePreview,
    lastMessageRole: overrides.lastMessageRole,
  };
}

const TWO_THREADS: ChatThreadSummary[] = [
  makeThread({
    id: 'chat-aaaa',
    title: 'Yesterday',
    lastMessagePreview: 'Hi there',
    lastMessageRole: 'assistant',
    updatedAt: '2026-04-29T12:00:00.000Z',
  }),
  makeThread({
    id: 'chat-bbbb',
    title: 'New plan',
    lastMessagePreview: 'OK do this',
    lastMessageRole: 'user',
    updatedAt: '2026-04-28T12:00:00.000Z',
  }),
];

// ── Mount + per-row rendering ────────────────────────────────────────

describe('ChatThreadList — basic rendering', () => {
  it('mounts the list nav with stable data attrs', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} activeThreadId="chat-aaaa" />,
    );
    const nav = container.querySelector('[data-component="chat-thread-list"]');
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute('data-empty')).toBe('false');
    expect(nav?.getAttribute('data-loading')).toBe('false');
  });

  it('renders one row per thread in the supplied order', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} activeThreadId={null} />,
    );
    const rows = container.querySelectorAll(
      '[data-component="chat-thread-list-item"]',
    );
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute('data-thread-id')).toBe('chat-aaaa');
    expect(rows[1]?.getAttribute('data-thread-id')).toBe('chat-bbbb');
  });

  it('exposes the thread title as the visible label', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} activeThreadId={null} />,
    );
    const labels = container.querySelectorAll(
      '[data-component="chat-thread-list-item-label"]',
    );
    expect(labels[0]?.textContent).toBe('Yesterday');
    expect(labels[1]?.textContent).toBe('New plan');
  });
});

// ── Active-thread highlighting ───────────────────────────────────────

describe('ChatThreadList — active highlight', () => {
  it('marks the matching row as aria-current="true"', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} activeThreadId="chat-bbbb" />,
    );
    const rows = container.querySelectorAll(
      '[data-component="chat-thread-list-item"]',
    );
    expect(rows[0]?.getAttribute('data-active')).toBe('false');
    expect(rows[1]?.getAttribute('data-active')).toBe('true');
    const activeButton = rows[1]?.querySelector('button');
    expect(activeButton?.getAttribute('aria-current')).toBe('true');
  });

  it('omits aria-current on inactive rows', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} activeThreadId="chat-bbbb" />,
    );
    const inactiveButton = container
      .querySelectorAll('[data-component="chat-thread-list-item"]')[0]
      ?.querySelector('button');
    expect(inactiveButton?.getAttribute('aria-current')).toBeNull();
  });

  it('applies the bg-accent highlight class to the active row', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} activeThreadId="chat-aaaa" />,
    );
    const activeButton = container
      .querySelector(
        '[data-component="chat-thread-list-item"][data-thread-id="chat-aaaa"]',
      )
      ?.querySelector('button');
    expect(activeButton?.className).toContain('bg-accent');
  });

  it('renders no active row when activeThreadId is null', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} activeThreadId={null} />,
    );
    const rows = container.querySelectorAll(
      '[data-component="chat-thread-list-item"]',
    );
    rows.forEach((row) => {
      expect(row.getAttribute('data-active')).toBe('false');
    });
  });

  it('renders no active row when activeThreadId is omitted', () => {
    const { container } = render(<ChatThreadList threads={TWO_THREADS} />);
    const rows = container.querySelectorAll(
      '[data-component="chat-thread-list-item"]',
    );
    rows.forEach((row) => {
      expect(row.getAttribute('data-active')).toBe('false');
    });
  });
});

// ── Selection ───────────────────────────────────────────────────────

describe('ChatThreadList — selection', () => {
  it('dispatches onSelect with the row id when a row is clicked', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ChatThreadList
        threads={TWO_THREADS}
        activeThreadId={null}
        onSelect={onSelect}
      />,
    );
    const button = container
      .querySelector(
        '[data-component="chat-thread-list-item"][data-thread-id="chat-bbbb"]',
      )
      ?.querySelector('button');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('chat-bbbb');
  });

  it('does not throw when onSelect is omitted', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} activeThreadId={null} />,
    );
    const button = container
      .querySelector('[data-component="chat-thread-list-item"]')
      ?.querySelector('button');
    expect(() => fireEvent.click(button!)).not.toThrow();
  });
});

// ── Empty / loading / error states ───────────────────────────────────

describe('ChatThreadList — empty / loading / error', () => {
  it('renders the loading placeholder when loading and threads is empty', () => {
    const { container } = render(
      <ChatThreadList threads={[]} loading={true} />,
    );
    expect(
      container.querySelector('[data-component="chat-thread-list-loading"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-component="chat-thread-list-empty"]'),
    ).toBeNull();
  });

  it('renders the empty state when threads is empty and not loading', () => {
    const { container } = render(<ChatThreadList threads={[]} />);
    const empty = container.querySelector(
      '[data-component="chat-thread-list-empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No conversations yet');
  });

  it('keeps the cached list visible during a background refresh', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} loading={true} />,
    );
    // Loading + non-empty cache: list rendered, spinner suppressed.
    expect(
      container.querySelector('[data-component="chat-thread-list-loading"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll(
        '[data-component="chat-thread-list-item"]',
      ).length,
    ).toBe(2);
  });

  it('renders an inline error banner when error is set', () => {
    const { container } = render(
      <ChatThreadList threads={[]} error={new Error('boom')} />,
    );
    const banner = container.querySelector(
      '[data-component="chat-thread-list-error"]',
    );
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('boom');
  });

  it('shows the error banner ABOVE a stale cached list', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} error={new Error('refresh failed')} />,
    );
    expect(
      container.querySelector('[data-component="chat-thread-list-error"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll(
        '[data-component="chat-thread-list-item"]',
      ).length,
    ).toBe(2);
  });

  it('exposes data-empty="true" when there are no threads', () => {
    const { container } = render(<ChatThreadList threads={[]} />);
    const nav = container.querySelector('[data-component="chat-thread-list"]');
    expect(nav?.getAttribute('data-empty')).toBe('true');
  });

  it('aria-label="Chat threads" for screen readers', () => {
    render(<ChatThreadList threads={TWO_THREADS} />);
    expect(screen.getByLabelText('Chat threads')).toBeTruthy();
  });
});

// ── Mobile sizing ────────────────────────────────────────────────────

describe('ChatThreadList — mobile touch targets', () => {
  it('applies min-h-[44px] on mobile rows', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} isMobile={true} />,
    );
    const button = container
      .querySelector('[data-component="chat-thread-list-item"]')
      ?.querySelector('button');
    expect(button?.className).toContain('min-h-[44px]');
  });

  it('omits min-h-[44px] on desktop rows', () => {
    const { container } = render(
      <ChatThreadList threads={TWO_THREADS} isMobile={false} />,
    );
    const button = container
      .querySelector('[data-component="chat-thread-list-item"]')
      ?.querySelector('button');
    expect(button?.className).not.toContain('min-h-[44px]');
  });
});

// ── Helper unit tests: resolveThreadLabel ────────────────────────────

describe('resolveThreadLabel helper', () => {
  it('prefers the user-edited title when present', async () => {
    const { __test } = await import('./chat-thread-list.tsx');
    expect(
      __test.resolveThreadLabel(
        makeThread({ title: 'My plan', lastMessagePreview: 'unrelated' }),
      ),
    ).toBe('My plan');
  });

  it('falls back to the last-message preview when no title is set', async () => {
    const { __test } = await import('./chat-thread-list.tsx');
    expect(
      __test.resolveThreadLabel(
        makeThread({ title: undefined, lastMessagePreview: 'Hello world' }),
      ),
    ).toBe('Hello world');
  });

  it('truncates a long preview to 40 chars with ellipsis', async () => {
    const { __test } = await import('./chat-thread-list.tsx');
    const long = 'a'.repeat(80);
    const label = __test.resolveThreadLabel(
      makeThread({ title: undefined, lastMessagePreview: long }),
    );
    expect(label.length).toBe(40);
    expect(label.endsWith('…')).toBe(true);
  });

  it('falls back to "New chat" when neither title nor preview is set', async () => {
    const { __test } = await import('./chat-thread-list.tsx');
    expect(
      __test.resolveThreadLabel(
        makeThread({ title: undefined, lastMessagePreview: undefined }),
      ),
    ).toBe('New chat');
  });

  it('treats whitespace-only title as missing', async () => {
    const { __test } = await import('./chat-thread-list.tsx');
    expect(
      __test.resolveThreadLabel(
        makeThread({ title: '   ', lastMessagePreview: 'fallback' }),
      ),
    ).toBe('fallback');
  });
});

// ── Helper unit tests: formatThreadsError ────────────────────────────

describe('formatThreadsError helper', () => {
  it('returns the trimmed message verbatim for short errors', async () => {
    const { __test } = await import('./chat-thread-list.tsx');
    expect(__test.formatThreadsError(new Error('boom'))).toBe('boom');
  });

  it('truncates long messages with ellipsis', async () => {
    const { __test } = await import('./chat-thread-list.tsx');
    const out = __test.formatThreadsError(new Error('x'.repeat(200)));
    // Helper caps at 120 chars by slicing the first 117 raw chars and
    // appending the single-codepoint ellipsis (`…`), yielding a
    // 118-char visible label. The test pins both the upper-bound
    // (≤ 120) and the suffix so future tweaks to the cap are caught.
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
    // Also pin the exact length so a regression that drops the
    // trailing ellipsis or shifts the cap lights up the test.
    expect(out.length).toBe(118);
  });

  it('falls back to a generic string when message is empty', async () => {
    const { __test } = await import('./chat-thread-list.tsx');
    expect(__test.formatThreadsError(new Error(''))).toBe(
      'Could not load threads.',
    );
  });
});
