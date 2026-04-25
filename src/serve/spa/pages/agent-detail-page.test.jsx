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
import { MemoryRouter } from 'react-router-dom';

import {
  AgentDetailPage,
  AGENT_DETAIL_TABS,
  DEFAULT_AGENT_DETAIL_TAB,
  normaliseTab,
} from './agent-detail-page.jsx';

/**
 * Render `AgentDetailPage` inside a `MemoryRouter` so the internal
 * breadcrumb `<Link>` elements (`Agents → :slug → :tab` per AC 3) can
 * resolve a routing context. Test helpers default to
 * `initialEntries={['/agents/<slug>']}` so `useLocation()` matches the
 * component's real-world mount point.
 */
function renderWithRouter(ui, { initialEntries = ['/agents/alice'] } = {}) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>,
  );
}

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
  const utils = renderWithRouter(
    <AgentDetailPage slug={profile.slug} fetch={fetch} {...props} />,
    { initialEntries: [`/agents/${profile.slug}`] },
  );
  return { ...utils, fetch };
}

// ── Test lifecycle ───────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Route wiring ─────────────────────────────────────────────────────

describe('AgentDetailPage — route wiring', () => {
  it('is addressable by slug — renders the matching slug in the breadcrumb', async () => {
    const { container } = renderDetail(ALICE);
    const crumb = await waitFor(() => {
      const el = container.querySelector('[data-agent-detail-breadcrumb]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(crumb).toHaveTextContent(ALICE.slug);
  });

  it('shows a loading skeleton until the first profile fetch resolves', async () => {
    const fetch = vi.fn(() => new Promise(() => {})); // never resolves
    renderWithRouter(<AgentDetailPage slug="alice" fetch={fetch} />);
    const loader = await screen.findByRole('status');
    expect(loader).toHaveAttribute('data-loading', 'true');
    expect(loader).toHaveTextContent(/loading agent/i);
  });

  it('shows an empty state when no slug is supplied', async () => {
    const { container } = renderWithRouter(<AgentDetailPage slug="" />, {
      initialEntries: ['/agents'],
    });
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

// ── Tab navigation scaffolding ───────────────────────────────────────

describe('AgentDetailPage — tab navigation scaffolding', () => {
  // The inline TabsList was removed when per-agent tabs moved into the
  // secondary AppSidebar. Tab switching is now URL-driven — `initialTab`
  // selects the Radix Tabs value and the matching `<TabsContent>`
  // renders the corresponding page. These tests verify the contract
  // without asserting on a tablist element that no longer lives inside
  // the detail page.

  it('defaults to the Calendar tab when no initialTab is provided', async () => {
    const { container } = renderDetail(ALICE);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-detail"]'),
      ).not.toBeNull();
    });
    const wrapper = container.querySelector('[data-page="agent-detail"]');
    expect(wrapper).toHaveAttribute('data-active-tab', 'calendar');
    expect(
      container.querySelector('[data-tab-body="calendar"]'),
    ).not.toBeNull();
  });

  it('honours initialTab to deep-link directly to a non-default tab', async () => {
    const { container } = renderDetail(ALICE, { initialTab: 'activities' });
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-detail"]'),
      ).not.toBeNull();
    });
    const wrapper = container.querySelector('[data-page="agent-detail"]');
    expect(wrapper).toHaveAttribute('data-active-tab', 'activities');
  });

  it('normalises an unknown initialTab back to the default (Calendar)', async () => {
    const { container } = renderDetail(ALICE, { initialTab: 'not-a-real-tab' });
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-detail"]'),
      ).not.toBeNull();
    });
    const wrapper = container.querySelector('[data-page="agent-detail"]');
    expect(wrapper).toHaveAttribute('data-active-tab', 'calendar');
  });

  it('only the active tab panel is rendered — inactive panels are unmounted', async () => {
    const { container } = renderDetail(ALICE);
    await waitFor(() => {
      expect(
        container.querySelector('[data-tab-body="calendar"]'),
      ).not.toBeNull();
    });
    expect(container.querySelector('[data-tab="activities"]')).toBeNull();
    expect(container.querySelector('[data-tab="strategy"]')).toBeNull();
    expect(container.querySelector('[data-tab="profile"]')).toBeNull();
  });
});

// ── Breadcrumb navigation (AC 3) ─────────────────────────────────────

describe('AgentDetailPage — breadcrumb trail', () => {
  it('renders a three-segment trail: Agents → :slug → active tab label', async () => {
    renderDetail(ALICE);
    const nav = await screen.findByRole('navigation', { name: /breadcrumb/i });
    const list = within(nav).getByRole('list');
    // Separators carry role="presentation" per the shadcn contract, so
    // only the 3 BreadcrumbItem crumbs surface as listitems.
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    const links = within(nav).getAllByRole('link');
    const labels = links.map((a) => a.textContent.trim());
    expect(labels).toContain('Agents');
    expect(labels).toContain('alice');
    // The current tab segment uses role="link" + aria-current="page" per
    // the shadcn BreadcrumbPage contract; it is not a real anchor but
    // testing-library surfaces it via the accessible `link` role too.
    const current = within(nav).getByText('Calendar');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('points the Agents crumb at /agents and the slug crumb at /agents/:slug', async () => {
    renderDetail(ALICE);
    const nav = await screen.findByRole('navigation', { name: /breadcrumb/i });
    const agents = within(nav).getByRole('link', { name: 'Agents' });
    const slug = within(nav).getByRole('link', { name: 'alice' });
    expect(agents).toHaveAttribute('href', '/agents');
    expect(slug).toHaveAttribute('href', '/agents/alice');
  });

  it('updates the current-tab crumb when the active tab changes', async () => {
    renderDetail(ALICE, { initialTab: 'profile' });
    const nav = await screen.findByRole('navigation', { name: /breadcrumb/i });
    expect(within(nav).getByText('Profile')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('sits above the tab content in the document order', async () => {
    const { container } = renderDetail(ALICE);
    const crumb = await waitFor(() => {
      const el = container.querySelector('[data-agent-detail-breadcrumb]');
      expect(el).not.toBeNull();
      return el;
    });
    const calendar = await waitFor(() => {
      const el = container.querySelector('[data-page="agent-calendar"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(
      crumb.compareDocumentPosition(calendar) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────

describe('AgentDetailPage — exported helpers', () => {
  it('AGENT_DETAIL_TABS is a frozen 4-tab row in the documented order', () => {
    expect(Object.isFrozen(AGENT_DETAIL_TABS)).toBe(true);
    expect(AGENT_DETAIL_TABS.map((t) => t.value)).toEqual([
      'calendar',
      'activities',
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
