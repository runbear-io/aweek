/**
 * Component tests for `AgentReviewsPage` URL-driven behavior (issue #12).
 *
 * Covers:
 *   - URL-driven `selectedWeek` selects the matching review.
 *   - Unknown URL `:week` renders the "review not found" state.
 *   - Clicking a different review notifies the parent via `onSelectWeek`.
 *   - "Back to latest review" calls `onSelectWeek(null)`.
 *   - Copy link button emits a permalink to the active review.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { AgentReviewsPage } from './agent-reviews-page.tsx';

// ── Fixtures ─────────────────────────────────────────────────────────

const REVIEWS_FIXTURE = {
  slug: 'alice',
  reviews: [
    {
      week: '2026-W17',
      markdown:
        '# Weekly Review: alice — 2026-W17\n\n**Week:** 2026-W17\n\n---\n\nLooks good.',
      metadata: { agentId: 'alice' } as Record<string, unknown>,
      generatedAt: '2026-04-25T00:00:00.000Z',
    },
    {
      week: 'daily-2026-04-23',
      markdown:
        '# Daily Review: alice — Thursday, 2026-04-23\n\n**Date:** 2026-04-23\n\n---\n\nMid-week.',
      metadata: { agentId: 'alice' } as Record<string, unknown>,
      generatedAt: '2026-04-24T00:00:00.000Z',
    },
  ],
};

// ── Fetch stub ───────────────────────────────────────────────────────

function makeFetchStub(reviews: unknown) {
  const body = JSON.stringify({ reviews });
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(body),
    }),
  ) as unknown as typeof globalThis.fetch;
}

// ── Lifecycle ────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('AgentReviewsPage — URL-driven selection (issue #12)', () => {
  it('renders the URL-selected review when it matches a loaded entry', async () => {
    const fetchImpl = makeFetchStub(REVIEWS_FIXTURE);
    render(
      <AgentReviewsPage
        slug="alice"
        fetch={fetchImpl}
        selectedWeek="daily-2026-04-23"
      />,
    );

    // The right-pane review body card carries the active week as a data attr.
    await waitFor(() => {
      expect(
        document.querySelector('[data-review-body="daily-2026-04-23"]'),
      ).not.toBeNull();
    });

    // Newest is NOT auto-selected when URL drives selection.
    expect(
      document.querySelector('[data-review-body="2026-W17"]'),
    ).toBeNull();
  });

  it('renders the "review not found" state when the URL :week is unknown', async () => {
    const fetchImpl = makeFetchStub(REVIEWS_FIXTURE);
    render(
      <AgentReviewsPage
        slug="alice"
        fetch={fetchImpl}
        selectedWeek="2099-W42"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Review not found/i)).toBeTruthy();
    });

    expect(
      document.querySelector('[data-state="not-found"]'),
    ).not.toBeNull();
    // The not-found card must surface the requested week so the user
    // can verify the URL is what they expected.
    expect(screen.getByText('2099-W42')).toBeTruthy();
  });

  it('calls onSelectWeek when the user clicks a different review in the rail', async () => {
    const fetchImpl = makeFetchStub(REVIEWS_FIXTURE);
    const onSelectWeek = vi.fn();
    render(
      <AgentReviewsPage
        slug="alice"
        fetch={fetchImpl}
        selectedWeek="2026-W17"
        onSelectWeek={onSelectWeek}
      />,
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-review-week="daily-2026-04-23"]'),
      ).not.toBeNull();
    });

    const dailyButton = document.querySelector(
      '[data-review-week="daily-2026-04-23"]',
    ) as HTMLButtonElement | null;
    expect(dailyButton).not.toBeNull();
    fireEvent.click(dailyButton!);

    expect(onSelectWeek).toHaveBeenCalledWith('daily-2026-04-23');
  });

  it('"Back to latest review" calls onSelectWeek(null) from the not-found state', async () => {
    const fetchImpl = makeFetchStub(REVIEWS_FIXTURE);
    const onSelectWeek = vi.fn();
    render(
      <AgentReviewsPage
        slug="alice"
        fetch={fetchImpl}
        selectedWeek="2099-W42"
        onSelectWeek={onSelectWeek}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Back to latest review/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Back to latest review/i));
    expect(onSelectWeek).toHaveBeenCalledWith(null);
  });
});

describe('AgentReviewsPage — Copy permalink button (issue #12)', () => {
  it('renders a Copy link button next to the active review title', async () => {
    const fetchImpl = makeFetchStub(REVIEWS_FIXTURE);
    render(
      <AgentReviewsPage
        slug="alice"
        fetch={fetchImpl}
        selectedWeek="2026-W17"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Copy link')).toBeTruthy();
    });

    const button = document.querySelector(
      '[data-review-copy-link="true"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button!.getAttribute('data-review-week')).toBe('2026-W17');
  });

  it('writes the permalink to navigator.clipboard and flips the label to "Copied"', async () => {
    const fetchImpl = makeFetchStub(REVIEWS_FIXTURE);
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    // Stub `navigator.clipboard` only — do NOT replace the whole
    // `navigator` global, because jsdom's `navigator` is shared with the
    // rest of the SPA suite and some sibling tests read it indirectly.
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    try {
      render(
        <AgentReviewsPage
          slug="alice"
          fetch={fetchImpl}
          selectedWeek="daily-2026-04-23"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Copy link')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Copy link'));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledTimes(1);
      });
      const arg = writeText.mock.calls[0][0] as string;
      expect(arg).toContain('/agents/alice/reviews/daily-2026-04-23');

      await waitFor(() => {
        expect(screen.getByText('Copied')).toBeTruthy();
      });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, 'clipboard', originalDescriptor);
      } else {
        // jsdom's default navigator has no clipboard — remove the stub
        // entirely so the next test sees the original (absent) shape.
        delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      }
    }
  });
});

describe('AgentReviewsPage — local-state mode (no URL selection)', () => {
  it('auto-selects the newest review when no URL selection is provided', async () => {
    const fetchImpl = makeFetchStub(REVIEWS_FIXTURE);
    render(<AgentReviewsPage slug="alice" fetch={fetchImpl} />);

    await waitFor(() => {
      expect(
        document.querySelector('[data-review-body="2026-W17"]'),
      ).not.toBeNull();
    });
  });
});
