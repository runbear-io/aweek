/**
 * Integration tests for `AppShell` — focused on Sub-AC 9.2.
 *
 * Goal: prove the calendar's current-week state is synced to the URL via
 * the `?week=YYYY-Www` query parameter through react-router. The shell
 * is mounted inside a `MemoryRouter` so we can deep-link an `initialEntries`
 * URL (proving the read-on-mount path), click prev / next / today (proving
 * the push-on-navigation path), and assert both the calendar fetch URL
 * AND the live `useLocation()` snapshot move with the user's gestures.
 *
 * Runner : Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js`.
 * Command: `pnpm test:spa`.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { AppShell } from './app-shell.tsx';
import { ChatPanelProvider } from './components/chat-panel-context.js';
import { ThemeProvider } from './components/theme-provider.jsx';
import { TooltipProvider } from './components/ui/tooltip.jsx';

/**
 * Wrap the routing tree in the same provider stack `main.tsx` mounts in
 * production so context-dependent components (Layout's ThemeToggle,
 * Radix Tooltip, the floating chat panel state) all resolve. Without
 * these, `Layout` throws "useTheme() must be used inside a
 * <ThemeProvider>" before any test assertion can run.
 */
function renderShell(initialEntry: string) {
  return render(
    <ThemeProvider>
      <ChatPanelProvider>
        <TooltipProvider delayDuration={0} skipDelayDuration={0}>
          <MemoryRouter initialEntries={[initialEntry]}>
            <AppShell />
            <LocationProbe />
          </MemoryRouter>
        </TooltipProvider>
      </ChatPanelProvider>
    </ThemeProvider>,
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────

const WEEK_17 = '2026-W17';
const WEEK_16 = '2026-W16';
const WEEK_18 = '2026-W18';

const PROFILE = {
  slug: 'alice',
  name: 'Alice',
  description: 'lead dev',
  missing: false,
  identityPath: '.claude/agents/alice.md',
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-20T00:00:00Z',
  paused: false,
  pausedReason: null,
  periodStart: '2026-04-20T00:00:00Z',
  tokenLimit: 100_000,
  tokensUsed: 25_000,
  remaining: 75_000,
  overBudget: false,
  utilizationPct: 25,
  weekMonday: '2026-04-20',
};

function makeCalendar(week: string) {
  return {
    agentId: 'alice',
    week,
    month: '2026-04',
    approved: true,
    timeZone: 'UTC',
    weekMonday: '2026-04-20T00:00:00.000Z',
    noPlan: false,
    tasks: [],
    counts: {
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      delegated: 0,
    },
    activityByTask: {},
  };
}

/**
 * Build a per-request fetch stub keyed by URL substring. Returns the
 * recorded `calls` array so tests can assert which week the calendar
 * endpoint was hit with.
 */
function makeFetchStub() {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url });

    // The calendar request — pick the requested week off the query
    // string and reflect it in the body so the test can assert which
    // week the UI rendered. `fetchAgentCalendar` requires a
    // `{ calendar: … }` envelope (see api-client.ts).
    if (url.includes('/api/agents/alice/calendar')) {
      const match = /[?&]week=([^&]+)/.exec(url);
      const week = match ? decodeURIComponent(match[1]) : WEEK_17;
      return new Response(
        JSON.stringify({ calendar: makeCalendar(week) }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    // The profile request — fulfils the detail-page shell so it renders
    // its tab body.
    if (
      /\/api\/agents\/alice(?:\?|$|\/$)/.test(url) ||
      url.endsWith('/api/agents/alice')
    ) {
      return new Response(JSON.stringify({ agent: PROFILE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // The agents-list request — used by AgentsPage; harmless 200 so the
    // top-level Layout (sidebar etc.) settles.
    if (url.includes('/api/agents')) {
      return new Response(JSON.stringify({ rows: [], issues: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Everything else (notifications, logs, plan, reviews, etc.) — a
    // benign 200 with an empty payload keeps the dependent hooks quiet
    // without leaking jsdom network errors.
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/**
 * Helper component that probes `useLocation()` and writes the current
 * search string into a `data-search` attribute so tests can assert on the
 * URL without reaching for `window.location` (which `MemoryRouter` does
 * not touch).
 */
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return (
    <div
      data-location-probe="true"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  );
}

// ── Setup / teardown ─────────────────────────────────────────────────

let originalFetch: typeof fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  if (originalFetch) globalThis.fetch = originalFetch;
});

// ── Tests ────────────────────────────────────────────────────────────

describe('AppShell — ?week=YYYY-Www URL sync (Sub-AC 9.2)', () => {
  it('reads ?week= off the URL on mount and threads it into the calendar fetch', async () => {
    const { fetchImpl, calls } = makeFetchStub();
    globalThis.fetch = fetchImpl;

    renderShell(`/agents/alice/calendar?week=${WEEK_17}`);

    // The calendar hook should fetch with `?week=2026-W17` — proving the
    // URL was the source of truth on mount (== refresh / deep-link).
    await waitFor(() => {
      const hit = calls.find((c) =>
        /\/api\/agents\/alice\/calendar\?week=2026-W17/.test(c.url),
      );
      expect(hit, `calendar fetch with ?week=${WEEK_17} was never issued`).toBeTruthy();
    });
  });

  it('coerces a malformed ?week= value to the default (omits week from the fetch)', async () => {
    const { fetchImpl, calls } = makeFetchStub();
    globalThis.fetch = fetchImpl;

    renderShell('/agents/alice/calendar?week=not-a-week');

    await waitFor(() => {
      const hit = calls.find((c) =>
        /\/api\/agents\/alice\/calendar(?:$|\?)/.test(c.url),
      );
      expect(hit).toBeTruthy();
    });
    const cal = calls.find((c) =>
      /\/api\/agents\/alice\/calendar/.test(c.url),
    )!;
    // Malformed value MUST NOT be forwarded — the URL guard collapses
    // it to `undefined` so the server falls back to the current week.
    expect(cal.url).not.toMatch(/[?&]week=not-a-week/);
  });

  it('pushes a new ?week= onto the URL via react-router when the user clicks Next', async () => {
    const { fetchImpl, calls } = makeFetchStub();
    globalThis.fetch = fetchImpl;

    const { container } = renderShell(
      `/agents/alice/calendar?week=${WEEK_17}`,
    );

    // Wait for the calendar header (and therefore its prev/next nav) to
    // render before we click.
    const next = await waitFor(() => {
      const el = container.querySelector(
        `[data-calendar-next-week="${WEEK_18}"]`,
      ) as HTMLButtonElement | null;
      expect(el, 'next-week button should render').not.toBeNull();
      return el!;
    });

    act(() => {
      fireEvent.click(next);
    });

    // (a) URL pushed — react-router's location now carries ?week=2026-W18.
    await waitFor(() => {
      const probe = container.querySelector('[data-location-probe="true"]');
      expect(probe?.getAttribute('data-search')).toBe(`?week=${WEEK_18}`);
      expect(probe?.getAttribute('data-pathname')).toBe(
        '/agents/alice/calendar',
      );
    });

    // (b) Side effect: calendar re-fetched with the new week.
    await waitFor(() => {
      const hit = calls.find((c) =>
        new RegExp(`/api/agents/alice/calendar\\?week=${WEEK_18}`).test(c.url),
      );
      expect(hit, `calendar fetch with ?week=${WEEK_18} was never issued`).toBeTruthy();
    });
  });

  it('pushes the prior ?week= onto the URL via react-router when the user clicks Previous', async () => {
    const { fetchImpl } = makeFetchStub();
    globalThis.fetch = fetchImpl;

    const { container } = renderShell(
      `/agents/alice/calendar?week=${WEEK_17}`,
    );

    const prev = await waitFor(() => {
      const el = container.querySelector(
        `[data-calendar-prev-week="${WEEK_16}"]`,
      ) as HTMLButtonElement | null;
      expect(el).not.toBeNull();
      return el!;
    });

    act(() => {
      fireEvent.click(prev);
    });

    await waitFor(() => {
      const probe = container.querySelector('[data-location-probe="true"]');
      expect(probe?.getAttribute('data-search')).toBe(`?week=${WEEK_16}`);
    });
  });

  it('clears ?week= from the URL when the user clicks the current-week (today) button', async () => {
    const { fetchImpl } = makeFetchStub();
    globalThis.fetch = fetchImpl;

    const { container } = renderShell(
      `/agents/alice/calendar?week=${WEEK_17}`,
    );

    const today = await waitFor(() => {
      const el = container.querySelector(
        '[data-calendar-current-week="true"]',
      ) as HTMLButtonElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    // The today button is enabled iff `?week=` is currently overriding
    // the default week — proving we read the URL.
    expect(today).not.toBeDisabled();

    act(() => {
      fireEvent.click(today);
    });

    // Push lands a clean path with NO ?week= query.
    await waitFor(() => {
      const probe = container.querySelector('[data-location-probe="true"]');
      expect(probe?.getAttribute('data-search')).toBe('');
      expect(probe?.getAttribute('data-pathname')).toBe(
        '/agents/alice/calendar',
      );
    });
  });

  it('preserves the calendar :taskId path segment when pushing a new ?week=', async () => {
    const { fetchImpl } = makeFetchStub();
    globalThis.fetch = fetchImpl;

    const { container } = renderShell(
      `/agents/alice/calendar/task-xyz?week=${WEEK_17}`,
    );

    const next = await waitFor(() => {
      const el = container.querySelector(
        `[data-calendar-next-week="${WEEK_18}"]`,
      ) as HTMLButtonElement | null;
      expect(el).not.toBeNull();
      return el!;
    });

    act(() => {
      fireEvent.click(next);
    });

    await waitFor(() => {
      const probe = container.querySelector('[data-location-probe="true"]');
      // The drawer task id stays in the URL path, ONLY ?week= is rotated.
      expect(probe?.getAttribute('data-pathname')).toBe(
        '/agents/alice/calendar/task-xyz',
      );
      expect(probe?.getAttribute('data-search')).toBe(`?week=${WEEK_18}`);
    });
  });

  it('survives a deep-link refresh: mounting at a ?week= URL renders that week without any prior interaction', async () => {
    const { fetchImpl, calls } = makeFetchStub();
    globalThis.fetch = fetchImpl;

    const DEEP_WEEK = '2027-W05';
    renderShell(`/agents/alice/calendar?week=${DEEP_WEEK}`);

    // Fresh mount — no clicks, no prior state. The very first calendar
    // fetch MUST carry the deep-linked week.
    await waitFor(() => {
      const hit = calls.find((c) =>
        new RegExp(
          `/api/agents/alice/calendar\\?week=${DEEP_WEEK}`,
        ).test(c.url),
      );
      expect(hit).toBeTruthy();
    });
  });
});
