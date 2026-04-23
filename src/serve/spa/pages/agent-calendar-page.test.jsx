/**
 * Component tests for `AgentCalendarPage` — AC 2, Sub-AC 2.
 *
 * These tests verify the Calendar tab:
 *   - Loading / 404 / error / no-plan empty states
 *   - Grid layout header + counts strip
 *   - Task chip placement from `slot` day/hour
 *   - Column-major task numbering (parity with the terminal grid)
 *   - Review-slot rendering (◆ icon + display name)
 *   - Backlog list for tasks without a slot
 *   - Refresh button re-triggers the calendar fetch
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

import { AgentCalendarPage, layoutTasks } from './agent-calendar-page.jsx';

// ── Fixtures ─────────────────────────────────────────────────────────

const WEEK = '2026-W17';
const WEEK_MONDAY = '2026-04-20T00:00:00.000Z';

/** One scheduled, one completed, one review slot, one backlog task. */
const FULL_CALENDAR = {
  agentId: 'alice',
  week: WEEK,
  month: '2026-04',
  approved: true,
  timeZone: 'UTC',
  weekMonday: WEEK_MONDAY,
  noPlan: false,
  tasks: [
    {
      id: 'task-a',
      title: 'Wednesday planning',
      prompt: 'Plan the week',
      status: 'pending',
      priority: null,
      estimatedMinutes: 60,
      objectiveId: 'obj-1',
      track: null,
      runAt: '2026-04-22T14:00:00.000Z',
      completedAt: null,
      delegatedTo: null,
      slot: {
        dayKey: 'wed',
        dayOffset: 2,
        hour: 14,
        minute: 0,
        iso: '2026-04-22T14:00:00.000Z',
      },
    },
    {
      id: 'task-b',
      title: 'Monday kickoff',
      prompt: 'Kick off',
      status: 'completed',
      priority: null,
      estimatedMinutes: null,
      objectiveId: 'obj-1',
      track: null,
      runAt: '2026-04-20T09:00:00.000Z',
      completedAt: '2026-04-20T09:45:00.000Z',
      delegatedTo: null,
      slot: {
        dayKey: 'mon',
        dayOffset: 0,
        hour: 9,
        minute: 0,
        iso: '2026-04-20T09:00:00.000Z',
      },
    },
    {
      id: 'task-review-d',
      title: '',
      prompt: 'Reflect',
      status: 'pending',
      priority: null,
      estimatedMinutes: 30,
      objectiveId: 'daily-review',
      track: null,
      runAt: '2026-04-21T17:00:00.000Z',
      completedAt: null,
      delegatedTo: null,
      slot: {
        dayKey: 'tue',
        dayOffset: 1,
        hour: 17,
        minute: 0,
        iso: '2026-04-21T17:00:00.000Z',
      },
    },
    {
      id: 'task-c',
      title: 'Backlog task (no runAt)',
      prompt: 'Later',
      status: 'pending',
      priority: null,
      estimatedMinutes: null,
      objectiveId: 'obj-1',
      track: null,
      runAt: null,
      completedAt: null,
      delegatedTo: null,
      slot: null,
    },
  ],
  counts: {
    total: 4,
    pending: 3,
    inProgress: 0,
    completed: 1,
    failed: 0,
    delegated: 0,
    skipped: 0,
    other: 0,
  },
  activityByTask: {},
};

/** Agent exists, but no weekly plan yet — `noPlan: true` branch. */
const NO_PLAN_CALENDAR = {
  agentId: 'alice',
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
};

// ── Fetch stub helpers ───────────────────────────────────────────────

/**
 * Build a `fetch` stub returning `{ calendar }` envelopes matching the
 * server contract consumed by `fetchAgentCalendar`.
 */
function makeFetchStub(
  calendar,
  { ok = true, status = 200, statusText = 'OK' } = {},
) {
  const body = ok
    ? JSON.stringify({ calendar })
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

function renderCalendar(calendar, stubOpts = {}, props = {}) {
  const { fetch, calls } = makeFetchStub(calendar, stubOpts);
  const utils = render(
    <AgentCalendarPage slug={calendar?.agentId || 'alice'} fetch={fetch} {...props} />,
  );
  return { ...utils, fetch, calls };
}

// ── Lifecycle ────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Loading / empty / error states ───────────────────────────────────

describe('AgentCalendarPage — loading / empty / error states', () => {
  it('renders a skeleton while the first fetch is in flight', async () => {
    const fetch = vi.fn(() => new Promise(() => {})); // never resolves
    render(<AgentCalendarPage slug="alice" fetch={fetch} />);
    const loader = await screen.findByRole('status');
    expect(loader).toHaveAttribute('data-loading', 'true');
    expect(loader).toHaveTextContent(/loading calendar/i);
  });

  it('renders an empty state when no slug is supplied', () => {
    const { container } = render(<AgentCalendarPage slug="" />);
    const empty = container.querySelector(
      '[data-page="agent-calendar"][data-state="empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent(/select an agent/i);
  });

  it('renders a 404 empty state when the slug is unknown', async () => {
    const { container } = renderCalendar(FULL_CALENDAR, {
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    const empty = await waitFor(() => {
      const el = container.querySelector(
        '[data-page="agent-calendar"][data-state="empty"]',
      );
      expect(el).not.toBeNull();
      return el;
    });
    expect(empty).toHaveTextContent(/no agent found for slug "alice"/i);
  });

  it('renders an error alert with Retry for 500s', async () => {
    renderCalendar(FULL_CALENDAR, {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-error', 'true');
    expect(within(alert).getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders a no-plan empty state when calendar.noPlan === true', async () => {
    const { container } = renderCalendar(NO_PLAN_CALENDAR);
    await screen.findByText(/no weekly plan yet/i);
    const wrapper = container.querySelector('[data-page="agent-calendar"]');
    expect(wrapper).toHaveAttribute('data-state', 'no-plan');
    // Header still renders so the user can see the agent name.
    expect(wrapper).toHaveTextContent('alice');
    expect(wrapper).toHaveTextContent(/pending/i);
  });
});

// ── Header / counts / grid ───────────────────────────────────────────

describe('AgentCalendarPage — header + counts + grid rendering', () => {
  it('renders the agent/week header with the approved badge and TZ', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    const header = await waitFor(() => {
      const el = container.querySelector('[data-calendar-header="true"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(header).toHaveTextContent(/alice/);
    expect(header).toHaveTextContent(WEEK);
    expect(header).toHaveTextContent(/approved/i);
    expect(header).toHaveTextContent(/UTC/);
    // 3 work tasks + 1 review slot → expected copy
    expect(header).toHaveTextContent(/3 tasks/);
    expect(header).toHaveTextContent(/1 review/);
  });

  it('renders a pending badge for unapproved plans', async () => {
    const pending = { ...FULL_CALENDAR, approved: false };
    const { container } = renderCalendar(pending);
    const header = await waitFor(() => {
      const el = container.querySelector('[data-calendar-header="true"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(header).toHaveTextContent(/pending/i);
    expect(header).not.toHaveTextContent(/approved/i);
  });

  it('renders the counts strip with per-status totals', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    const counts = await waitFor(() => {
      const el = container.querySelector('[data-calendar-counts="true"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(
      counts.querySelector('[data-count-key="pending"]'),
    ).toHaveAttribute('data-count-value', '3');
    expect(
      counts.querySelector('[data-count-key="completed"]'),
    ).toHaveAttribute('data-count-value', '1');
    expect(
      counts.querySelector('[data-count-key="failed"]'),
    ).toHaveAttribute('data-count-value', '0');
  });

  it('places scheduled tasks at their slot day/hour', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    await waitFor(() => {
      expect(container.querySelector('[data-calendar-grid="true"]')).not.toBeNull();
    });
    // Monday 9am → task-b (completed)
    const mon9 = container.querySelector(
      '[role="gridcell"][data-day="mon"][data-hour="9"]',
    );
    expect(mon9).not.toBeNull();
    expect(
      mon9.querySelector('[data-task-id="task-b"]'),
    ).not.toBeNull();
    // Wednesday 2pm → task-a (pending)
    const wed14 = container.querySelector(
      '[role="gridcell"][data-day="wed"][data-hour="14"]',
    );
    expect(wed14).not.toBeNull();
    expect(
      wed14.querySelector('[data-task-id="task-a"]'),
    ).not.toBeNull();
    // Tuesday 5pm → review slot
    const tue17 = container.querySelector(
      '[role="gridcell"][data-day="tue"][data-hour="17"]',
    );
    expect(tue17).not.toBeNull();
    expect(
      tue17.querySelector('[data-task-id="task-review-d"]'),
    ).toHaveAttribute('data-task-review', 'true');
  });

  it('numbers tasks in column-major order (Mon first, then Tue, then Wed)', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    await waitFor(() => {
      expect(container.querySelector('[data-calendar-grid="true"]')).not.toBeNull();
    });
    // Mon 9am (task-b) should be #1, Tue 5pm (task-review-d) #2,
    // Wed 2pm (task-a) #3, backlog (task-c) trailing #4.
    const byId = (id) =>
      container.querySelector(`[data-task-id="${id}"]`);
    expect(byId('task-b')).toHaveAttribute('data-task-number', '1');
    expect(byId('task-review-d')).toHaveAttribute('data-task-number', '2');
    expect(byId('task-a')).toHaveAttribute('data-task-number', '3');
    // Backlog number lives on the <li>, not the chip.
    const backlogEntry = container.querySelector(
      '[data-calendar-backlog="true"] [data-task-id="task-c"]',
    );
    expect(backlogEntry).toHaveAttribute('data-task-number', '4');
  });

  it('renders review slots with the ◆ glyph and display name', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    const review = await waitFor(() => {
      const el = container.querySelector('[data-task-id="task-review-d"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(review).toHaveAttribute('data-task-review', 'true');
    expect(review).toHaveTextContent('◆');
    expect(review).toHaveTextContent(/daily review/i);
  });

  it('lists unscheduled tasks in the Backlog section', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    const backlog = await waitFor(() => {
      const el = container.querySelector('[data-calendar-backlog="true"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(backlog).toHaveTextContent(/backlog \(1\)/i);
    expect(backlog).toHaveTextContent('Backlog task (no runAt)');
  });

  it('omits the Backlog section when every task has a slot', async () => {
    const allScheduled = {
      ...FULL_CALENDAR,
      tasks: FULL_CALENDAR.tasks.filter((t) => t.slot),
      counts: { ...FULL_CALENDAR.counts, total: 3, pending: 2 },
    };
    const { container } = renderCalendar(allScheduled);
    await waitFor(() => {
      expect(container.querySelector('[data-calendar-grid="true"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-calendar-backlog="true"]')).toBeNull();
  });
});

// ── Refresh wiring ───────────────────────────────────────────────────

describe('AgentCalendarPage — refresh wiring', () => {
  it('clicking Refresh re-invokes the calendar fetch', async () => {
    const { fetch, container } = renderCalendar(FULL_CALENDAR);
    await waitFor(() => {
      expect(container.querySelector('[data-calendar-header="true"]')).not.toBeNull();
    });
    const initialCalls = fetch.mock.calls.length;
    const header = container.querySelector('[data-calendar-header="true"]');
    const refresh = within(header).getByRole('button', { name: /refresh/i });
    await act(async () => {
      refresh.click();
    });
    await waitFor(() => {
      expect(fetch.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('passes ?week=YYYY-Www through to the endpoint when supplied', async () => {
    const { calls } = renderCalendar(FULL_CALENDAR, {}, { week: '2026-W17' });
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0);
    });
    const requested = calls[0].url;
    expect(requested).toMatch(/\/api\/agents\/alice\/calendar\?week=2026-W17/);
  });
});

// ── layoutTasks pure helper ──────────────────────────────────────────

describe('layoutTasks (pure helper)', () => {
  it('returns empty structures for an empty task list', () => {
    const { placedByDayHour, numbering } = layoutTasks([]);
    expect(placedByDayHour.size).toBe(0);
    expect(numbering.size).toBe(0);
  });

  it('buckets tasks by `${dayKey}:${hour}` and numbers column-major', () => {
    const { placedByDayHour, numbering } = layoutTasks(FULL_CALENDAR.tasks);
    expect(placedByDayHour.get('mon:9')).toHaveLength(1);
    expect(placedByDayHour.get('mon:9')[0].task.id).toBe('task-b');
    expect(placedByDayHour.get('tue:17')[0].task.id).toBe('task-review-d');
    expect(placedByDayHour.get('wed:14')[0].task.id).toBe('task-a');
    // Column-major numbering order: mon-9 → tue-17 → wed-14 → backlog.
    expect(numbering.get('task-b')).toBe(1);
    expect(numbering.get('task-review-d')).toBe(2);
    expect(numbering.get('task-a')).toBe(3);
    expect(numbering.get('task-c')).toBe(4);
  });

  it('breaks hour-bucket collisions by runAt ascending', () => {
    const t0900 = {
      id: 'task-0900',
      title: '9am',
      prompt: '',
      status: 'pending',
      priority: null,
      estimatedMinutes: null,
      objectiveId: null,
      track: null,
      runAt: '2026-04-20T09:00:00.000Z',
      completedAt: null,
      delegatedTo: null,
      slot: { dayKey: 'mon', dayOffset: 0, hour: 9, minute: 0, iso: '2026-04-20T09:00:00.000Z' },
    };
    const t0930 = {
      ...t0900,
      id: 'task-0930',
      runAt: '2026-04-20T09:30:00.000Z',
      slot: { ...t0900.slot, minute: 30, iso: '2026-04-20T09:30:00.000Z' },
    };
    const { placedByDayHour } = layoutTasks([t0930, t0900]);
    const bucket = placedByDayHour.get('mon:9');
    expect(bucket.map((e) => e.task.id)).toEqual(['task-0900', 'task-0930']);
  });
});
