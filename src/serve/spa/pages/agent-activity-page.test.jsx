/**
 * Component tests for `AgentActivityPage` — AC 2, Sub-AC 3.
 *
 * Baseline parity with the terminal view surfaced by
 * `src/storage/activity-log-store.js` + `src/storage/execution-store.js`:
 *   - Date-range filter pill group (all / this-week / last-7-days)
 *   - Activity entries list (user-facing event log rows)
 *   - Execution history list (heartbeat audit trail rows)
 *   - Newest-first order preserved from server response
 *   - Loading / 404 / error / empty states
 *   - Refresh button re-triggers fetch
 *   - Flipping the filter pill re-fetches with the new dateRange query
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Config : `vitest.config.js`.
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { AgentActivityPage } from './agent-activity-page.jsx';

// ── Fixtures ─────────────────────────────────────────────────────────

/** Matches the server-side `gatherAgentLogs` return shape. */
const FULL_LOGS = {
  slug: 'alice',
  dateRange: 'all',
  entries: [
    {
      id: 'log-aaa',
      agentId: 'alice',
      timestamp: '2026-04-22T14:30:00.000Z',
      status: 'completed',
      title: 'Wednesday planning',
      duration: 123456,
    },
    {
      id: 'log-bbb',
      agentId: 'alice',
      timestamp: '2026-04-21T11:00:00.000Z',
      status: 'started',
      title: 'Kickoff review',
    },
  ],
  executions: [
    {
      id: 'exec-xxx',
      idempotencyKey: 'idem-xxx',
      agentId: 'alice',
      timestamp: '2026-04-22T14:00:00.000Z',
      windowStart: '2026-04-22T14:00:00.000Z',
      windowEnd: '2026-04-22T15:00:00.000Z',
      status: 'completed',
      taskId: 'task-a',
      duration: 45000,
    },
    {
      id: 'exec-yyy',
      idempotencyKey: 'idem-yyy',
      agentId: 'alice',
      timestamp: '2026-04-21T09:00:00.000Z',
      windowStart: '2026-04-21T09:00:00.000Z',
      windowEnd: '2026-04-21T10:00:00.000Z',
      status: 'failed',
    },
  ],
};

const EMPTY_LOGS = {
  slug: 'alice',
  dateRange: 'this-week',
  entries: [],
  executions: [],
};

// ── Fetch stub helpers ───────────────────────────────────────────────

/**
 * Build a `fetch` stub returning `{ logs }` envelopes matching the
 * server contract consumed by `fetchAgentLogs`.
 */
function makeFetchStub(
  logs,
  { ok = true, status = 200, statusText = 'OK' } = {},
) {
  const body = ok
    ? JSON.stringify({ logs })
    : JSON.stringify({ error: 'boom' });
  const calls = [];
  const fetchImpl = vi.fn((url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve({
      ok,
      status,
      statusText,
      text: () => Promise.resolve(body),
    });
  });
  return { fetch: fetchImpl, calls };
}

function renderActivity(logs, stubOpts = {}, props = {}) {
  const { fetch, calls } = makeFetchStub(logs, stubOpts);
  const utils = render(
    <AgentActivityPage
      slug={logs?.slug || 'alice'}
      fetch={fetch}
      {...props}
    />,
  );
  return { ...utils, fetch, calls };
}

// ── Lifecycle ────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Loading / empty / error states ───────────────────────────────────

describe('AgentActivityPage — loading / empty / error states', () => {
  it('renders a skeleton while the first fetch is in flight', async () => {
    const fetch = vi.fn(() => new Promise(() => {})); // never resolves
    const { container } = render(
      <AgentActivityPage slug="alice" fetch={fetch} />,
    );
    const loader = await screen.findByRole('status');
    expect(loader).toHaveTextContent(/loading activity/i);
    // The surrounding skeleton still renders the filter pill group so
    // users can choose a range without waiting for the initial fetch.
    const wrapper = container.querySelector(
      '[data-page="agent-activity"][data-loading="true"]',
    );
    expect(wrapper).not.toBeNull();
    expect(
      wrapper.querySelector('[role="radiogroup"]'),
    ).not.toBeNull();
  });

  it('renders an empty state when no slug is supplied', () => {
    const { container } = render(<AgentActivityPage slug="" />);
    const empty = container.querySelector(
      '[data-page="agent-activity"][data-state="empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent(/select an agent/i);
  });

  it('renders a 404 empty state when the slug is unknown', async () => {
    const { container } = renderActivity(FULL_LOGS, {
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    const empty = await waitFor(() => {
      const el = container.querySelector(
        '[data-page="agent-activity"][data-state="empty"]',
      );
      expect(el).not.toBeNull();
      return el;
    });
    expect(empty).toHaveTextContent(/no agent found for slug "alice"/i);
  });

  it('renders an error alert with Retry for 500s', async () => {
    renderActivity(FULL_LOGS, {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it('renders a zero-row state when the server returns empty lists', async () => {
    const { container } = renderActivity(EMPTY_LOGS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-activity"]'),
      ).not.toBeNull();
    });
    expect(container).toHaveTextContent(/no activity entries in this range/i);
    expect(container).toHaveTextContent(/no executions in this range/i);
    // Header should report 0 rows.
    expect(container).toHaveTextContent(/0 rows/i);
  });
});

// ── Entry + execution row rendering ──────────────────────────────────

describe('AgentActivityPage — baseline parity with activity + execution stores', () => {
  it('renders every activity entry from the payload', async () => {
    const { container } = renderActivity(FULL_LOGS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-activity"]'),
      ).not.toBeNull();
    });
    expect(container).toHaveTextContent(/Wednesday planning/);
    expect(container).toHaveTextContent(/Kickoff review/);
    // Each entry surfaces its status as a badge (kind/type/event label).
    expect(container).toHaveTextContent(/completed/i);
    expect(container).toHaveTextContent(/started/i);
  });

  it('renders every execution record with its status tone', async () => {
    const { container } = renderActivity(FULL_LOGS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-activity"]'),
      ).not.toBeNull();
    });
    // Execution section heading and rows visible.
    expect(container).toHaveTextContent(/execution history/i);
    // taskId is surfaced on the audit row (taskId: "task-a").
    expect(container).toHaveTextContent(/task-a/);
    // Both status strings present (completed + failed).
    expect(container).toHaveTextContent(/completed/i);
    expect(container).toHaveTextContent(/failed/i);
  });

  it('preserves server-supplied newest-first ordering', async () => {
    // Server sorts newest-first. We don't re-sort — just assert the DOM
    // order matches the payload order so the parity is visible.
    //
    // Page surfaces (AC 4, Sub-AC 3): three lists total —
    //   1. Unified chronological timeline (primary visualization)
    //   2. "By source" drill-down · Activity log
    //   3. "By source" drill-down · Execution history
    const { container } = renderActivity(FULL_LOGS);
    await waitFor(() => {
      const entries = container.querySelectorAll('[role="list"] > li');
      expect(entries.length).toBeGreaterThan(0);
    });
    const entryLists = container.querySelectorAll('[role="list"]');
    expect(entryLists.length).toBe(3);

    // The timeline (first list) shows activity entries only —
    // heartbeat execution rows were dropped from the primary feed (too
    // verbose); they remain in the "By source" breakdown below. Order
    // is newest-first, so the 14:30 entry precedes the 09:00 one.
    const timelineItems = entryLists[0].querySelectorAll('li');
    expect(timelineItems[0]).toHaveTextContent('Wednesday planning');
    expect(timelineItems[1]).toHaveTextContent('Kickoff review');

    // Per-source drill-down retains the two-section contract.
    const activityItems = entryLists[1].querySelectorAll('li');
    expect(activityItems[0]).toHaveTextContent('Wednesday planning');
    expect(activityItems[1]).toHaveTextContent('Kickoff review');
    const executionItems = entryLists[2].querySelectorAll('li');
    // exec-xxx was at 14:00, exec-yyy was at 09:00 — xxx first.
    expect(executionItems[0]).toHaveTextContent(/task-a/);
  });

  it('surfaces the slug + row total in the header', async () => {
    const { container } = renderActivity(FULL_LOGS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-activity"]'),
      ).not.toBeNull();
    });
    // 2 entries + 2 executions = 4 rows.
    expect(container).toHaveTextContent(/alice/);
    expect(container).toHaveTextContent(/4 rows/i);
  });

  it('mounts the chronological ActivityTimeline as the primary visualization', async () => {
    // AC 4, Sub-AC 3: the page must surface a single unified timeline
    // interleaving ActivityLogStore events with ExecutionStore records.
    const { container } = renderActivity(FULL_LOGS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-component="activity-timeline"]'),
      ).not.toBeNull();
    });
    const timeline = container.querySelector(
      '[data-component="activity-timeline"]',
    );
    // Activity-only timeline (heartbeat rows dropped): 2 entry rows.
    expect(timeline.getAttribute('data-row-count')).toBe('2');
    expect(
      timeline.querySelectorAll('[data-timeline-source="activity"]').length,
    ).toBe(2);
    expect(
      timeline.querySelectorAll('[data-timeline-source="execution"]').length,
    ).toBe(0);
  });
});

// ── Date-range filter ────────────────────────────────────────────────

describe('AgentActivityPage — date-range filter wiring', () => {
  it('renders the three preset pills', async () => {
    renderActivity(FULL_LOGS);
    const group = await screen.findByRole('radiogroup', {
      name: /date range/i,
    });
    const options = within(group).getAllByRole('radio');
    expect(options.map((o) => o.dataset.rangeValue)).toEqual([
      'all',
      'this-week',
      'last-7-days',
    ]);
  });

  it('marks the default (all) pill selected initially', async () => {
    renderActivity(FULL_LOGS);
    const group = await screen.findByRole('radiogroup', {
      name: /date range/i,
    });
    const allPill = within(group).getByRole('radio', { name: /^all$/i });
    expect(allPill).toHaveAttribute('aria-checked', 'true');
  });

  it('honours initialDateRange when supplied', async () => {
    renderActivity(FULL_LOGS, {}, { initialDateRange: 'this-week' });
    const group = await screen.findByRole('radiogroup', {
      name: /date range/i,
    });
    const thisWeek = within(group).getByRole('radio', {
      name: /this week/i,
    });
    expect(thisWeek).toHaveAttribute('aria-checked', 'true');
  });

  it('re-fetches with the new dateRange query when the pill flips', async () => {
    const { calls, container } = renderActivity(FULL_LOGS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-activity"]'),
      ).not.toBeNull();
    });
    const initialCalls = calls.length;
    const group = container.querySelector('[role="radiogroup"]');
    const last7 = within(group).getByRole('radio', { name: /last 7 days/i });
    await act(async () => {
      last7.click();
    });
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(initialCalls);
    });
    const newest = calls[calls.length - 1].url;
    expect(newest).toMatch(/\/api\/agents\/alice\/logs\?dateRange=last-7-days/);
  });
});

// ── Refresh wiring ───────────────────────────────────────────────────

describe('AgentActivityPage — refresh wiring', () => {
  it('clicking Refresh re-invokes the logs fetch', async () => {
    const { fetch, container } = renderActivity(FULL_LOGS);
    await waitFor(() => {
      expect(
        container.querySelector('[data-page="agent-activity"]'),
      ).not.toBeNull();
    });
    const initialCalls = fetch.mock.calls.length;
    const refresh = within(container).getByRole('button', {
      name: /refresh/i,
    });
    await act(async () => {
      refresh.click();
    });
    await waitFor(() => {
      expect(fetch.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });
});
