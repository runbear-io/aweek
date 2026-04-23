/**
 * Component tests for `AgentDetailPage` — AC 2, Sub-AC 1.
 *
 * The detail page is a shell: it owns a slug-driven identity header
 * (sourced from `useAgentProfile`) and the tab navigation for
 * Calendar / Activity / Strategy / Profile. Tab bodies each delegate
 * to an existing hook-driven page.
 *
 * These tests verify the *shell* surface — route wiring, header data,
 * tab navigation scaffolding — not the content each tab renders,
 * which is already covered by the per-tab page tests.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js` (scoped to `**\/*.test.jsx`).
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';

import {
  AgentDetailPage,
  AGENT_DETAIL_TABS,
  DEFAULT_AGENT_DETAIL_TAB,
  normaliseTab,
} from './agent-detail-page.jsx';

// ── Fixtures ─────────────────────────────────────────────────────────
// `AgentProfile` shape mirrors `src/serve/data/agents.js` →
// `gatherAgentProfile`.

const ALICE = {
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

const PAUSED_BUDGET = {
  ...ALICE,
  slug: 'bob',
  name: 'Bob',
  paused: true,
  pausedReason: 'budget_exhausted',
  tokensUsed: 110_000,
  remaining: 0,
  overBudget: true,
  utilizationPct: 110,
};

const ORPHAN = {
  ...ALICE,
  slug: 'orphan',
  name: 'orphan',
  missing: true,
  identityPath: null,
  description: '',
};

/**
 * Build a `fetch` stub keyed by URL so the nested hook-driven pages can
 * fulfill their requests without triggering jsdom's real network layer.
 * Any URL not explicitly wired falls back to a matching `profile` 200
 * response — we never assert on those nested calls in Sub-AC 1.
 */
function makeFetchStub(profile, { ok = true, status = 200, statusText = 'OK' } = {}) {
  const calls = [];
  const profileUrl = new RegExp(`/api/agents/${profile.slug}(?:\\?|$|/$)`);
  const fetchImpl = vi.fn((url, init) => {
    calls.push({ url, init });
    const body = ok
      ? JSON.stringify({ agent: profile })
      : JSON.stringify({ error: 'boom' });
    if (profileUrl.test(String(url))) {
      return Promise.resolve({
        ok,
        status,
        statusText,
        text: () => Promise.resolve(body),
      });
    }
    // Nested pages (Activity / Strategy / Profile) each call their own
    // endpoints. Return an empty 200 so the hooks don't blow up; the
    // Sub-AC 1 shell tests don't assert on that content.
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        Promise.resolve(
          JSON.stringify({
            agent: profile,
            plan: {
              slug: profile.slug,
              name: profile.name,
              hasPlan: false,
              markdown: '',
              weeklyPlans: [],
              latestApproved: null,
            },
            calendar: {
              agentId: profile.slug,
              week: null,
              month: null,
              approved: false,
              timeZone: 'UTC',
              weekMonday: null,
              noPlan: true,
              tasks: [],
              counts: {
                total: 0,
                pending: 0,
                inProgress: 0,
                completed: 0,
                failed: 0,
                delegated: 0,
                skipped: 0,
                other: 0,
              },
              activityByTask: {},
            },
            logs: { slug: profile.slug, dateRange: 'all', entries: [], executions: [] },
            usage: { ...profile, weeks: [] },
          }),
        ),
    });
  });
  return { fetch: fetchImpl, calls };
}

function renderDetail(profile, props = {}, stubOpts = {}) {
  const { fetch } = makeFetchStub(profile, stubOpts);
  const utils = render(<AgentDetailPage slug={profile.slug} fetch={fetch} {...props} />);
  return { ...utils, fetch };
}

// ── Test lifecycle ───────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Route wiring ─────────────────────────────────────────────────────

describe('AgentDetailPage — route wiring', () => {
  it('is addressable by slug — renders the matching agent name in the header', async () => {
    renderDetail(ALICE);
    expect(await screen.findByRole('banner')).toHaveTextContent('Alice');
  });

  it('shows a loading skeleton until the first profile fetch resolves', async () => {
    const fetch = vi.fn(() => new Promise(() => {})); // never resolves
    render(<AgentDetailPage slug="alice" fetch={fetch} />);
    const loader = await screen.findByRole('status');
    expect(loader).toHaveAttribute('data-loading', 'true');
    expect(loader).toHaveTextContent(/loading agent/i);
  });

  it('shows an empty state when no slug is supplied', async () => {
    const { container } = render(<AgentDetailPage slug="" />);
    const empty = container.querySelector('[data-page="agent-detail"][data-state="empty"]');
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent(/select an agent/i);
  });

  it('maps a 404 profile fetch to a not-found empty state', async () => {
    const { container } = renderDetail(ALICE, {}, { ok: false, status: 404, statusText: 'Not Found' });
    const empty = await waitFor(() => {
      const el = container.querySelector('[data-page="agent-detail"][data-state="empty"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(empty).toHaveTextContent(/no agent found for slug "alice"/i);
  });

  it('maps a 500 profile fetch to an alert with a Retry button', async () => {
    renderDetail(ALICE, {}, { ok: false, status: 500, statusText: 'Internal Server Error' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-error', 'true');
    expect(within(alert).getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

// ── Identity header ──────────────────────────────────────────────────

describe('AgentDetailPage — identity header', () => {
  it('renders the agent name, slug, and ACTIVE status badge for a healthy agent', async () => {
    renderDetail(ALICE);
    const header = await screen.findByRole('banner');
    expect(header).toHaveTextContent('Alice');
    expect(header).toHaveTextContent('alice');
    expect(within(header).getByText('ACTIVE')).toBeInTheDocument();
  });

  it('renders PAUSED / BUDGET EXHAUSTED tone when paused for budget', async () => {
    renderDetail(PAUSED_BUDGET);
    const header = await screen.findByRole('banner');
    // pausedReason=budget_exhausted → BUDGET EXHAUSTED
    expect(within(header).getByText(/budget exhausted/i)).toBeInTheDocument();
  });

  it('renders the subagent-missing marker and SUBAGENT MISSING status for an orphan', async () => {
    renderDetail(ORPHAN);
    const header = await screen.findByRole('banner');
    expect(within(header).getAllByText(/subagent missing/i).length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces a Back button only when onBack is provided', async () => {
    const onBack = vi.fn();
    const { rerender, fetch } = renderDetail(ALICE, { onBack });
    const back = await screen.findByRole('button', { name: /back to agent list/i });
    back.click();
    expect(onBack).toHaveBeenCalledTimes(1);

    // No onBack → no Back button.
    cleanup();
    render(<AgentDetailPage slug={ALICE.slug} fetch={fetch} />);
    await screen.findByRole('banner');
    expect(
      screen.queryByRole('button', { name: /back to agent list/i }),
    ).toBeNull();
  });

  it('Refresh button triggers a refetch of the profile', async () => {
    const { fetch } = renderDetail(ALICE);
    // The detail shell + the embedded Calendar tab body each render a
    // Refresh button. Scope the lookup to the shell's <header> banner so
    // we test the one that re-fetches the profile (not the calendar).
    const header = await screen.findByRole('banner');
    const initialCalls = fetch.mock.calls.length;
    const refresh = within(header).getByRole('button', { name: /refresh/i });
    await act(async () => {
      refresh.click();
    });
    await waitFor(() => {
      expect(fetch.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });
});

// ── Tab navigation scaffolding ───────────────────────────────────────

describe('AgentDetailPage — tab navigation scaffolding', () => {
  it('renders exactly four tabs in the Calendar/Activity/Strategy/Profile order', async () => {
    renderDetail(ALICE);
    const tablist = await screen.findByRole('tablist');
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs.map((t) => t.textContent.trim())).toEqual([
      'Calendar',
      'Activity',
      'Strategy',
      'Profile',
    ]);
  });

  it('defaults to the Calendar tab when no initialTab is provided', async () => {
    const { container } = renderDetail(ALICE);
    await screen.findByRole('tablist');
    const wrapper = container.querySelector('[data-page="agent-detail"]');
    expect(wrapper).toHaveAttribute('data-active-tab', 'calendar');

    const calendar = await screen.findByRole('tab', { name: 'Calendar' });
    expect(calendar).toHaveAttribute('aria-selected', 'true');

    // Calendar body is rendered by <AgentCalendarPage/> (Sub-AC 2). The
    // Calendar hook's default fetch-stub resolves with an empty calendar
    // payload (noPlan or otherwise) so the panel must be present; we
    // only assert on the stable `data-tab-body="calendar"` marker so we
    // don't couple the shell test to the Calendar page's internal state.
    const calendarBody = container.querySelector('[data-tab-body="calendar"]');
    expect(calendarBody).not.toBeNull();
  });

  it('honours initialTab to deep-link directly to a non-default tab', async () => {
    const { container } = renderDetail(ALICE, { initialTab: 'activity' });
    await screen.findByRole('tablist');
    const wrapper = container.querySelector('[data-page="agent-detail"]');
    expect(wrapper).toHaveAttribute('data-active-tab', 'activity');
  });

  it('normalises an unknown initialTab back to the default (Calendar)', async () => {
    const { container } = renderDetail(ALICE, { initialTab: 'not-a-real-tab' });
    await screen.findByRole('tablist');
    const wrapper = container.querySelector('[data-page="agent-detail"]');
    expect(wrapper).toHaveAttribute('data-active-tab', 'calendar');
  });

  it('clicking a tab switches the active panel and fires onTabChange', async () => {
    const onTabChange = vi.fn();
    const { container } = renderDetail(ALICE, { onTabChange });
    await screen.findByRole('tablist');

    const profileTab = screen.getByRole('tab', { name: 'Profile' });
    await act(async () => {
      profileTab.click();
    });

    await waitFor(() => {
      expect(profileTab).toHaveAttribute('aria-selected', 'true');
    });
    const wrapper = container.querySelector('[data-page="agent-detail"]');
    expect(wrapper).toHaveAttribute('data-active-tab', 'profile');
    expect(onTabChange).toHaveBeenCalledWith('profile');
  });

  it('only the active tabpanel is rendered — inactive panels are unmounted', async () => {
    const { container } = renderDetail(ALICE);
    await screen.findByRole('tablist');

    // Calendar is active by default — its placeholder should be in the DOM…
    expect(container.querySelector('[data-tab-body="calendar"]')).not.toBeNull();
    // …but the other tab panels should not be mounted (avoids firing
    // their nested hook fetches until the user asks for that tab).
    expect(container.querySelector('[data-tab="activity"]')).toBeNull();
    expect(container.querySelector('[data-tab="strategy"]')).toBeNull();
    expect(container.querySelector('[data-tab="profile"]')).toBeNull();
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────

describe('AgentDetailPage — exported helpers', () => {
  it('AGENT_DETAIL_TABS is a frozen 4-tab row in the documented order', () => {
    expect(Object.isFrozen(AGENT_DETAIL_TABS)).toBe(true);
    expect(AGENT_DETAIL_TABS.map((t) => t.value)).toEqual([
      'calendar',
      'activity',
      'strategy',
      'profile',
    ]);
  });

  it('DEFAULT_AGENT_DETAIL_TAB is calendar', () => {
    expect(DEFAULT_AGENT_DETAIL_TAB).toBe('calendar');
  });

  it('normaliseTab returns the input when it is a known tab', () => {
    for (const { value } of AGENT_DETAIL_TABS) {
      expect(normaliseTab(value)).toBe(value);
    }
  });

  it('normaliseTab falls back to the default for unknown / empty / null input', () => {
    expect(normaliseTab(undefined)).toBe(DEFAULT_AGENT_DETAIL_TAB);
    expect(normaliseTab(null)).toBe(DEFAULT_AGENT_DETAIL_TAB);
    expect(normaliseTab('')).toBe(DEFAULT_AGENT_DETAIL_TAB);
    expect(normaliseTab('not-a-tab')).toBe(DEFAULT_AGENT_DETAIL_TAB);
  });
});
