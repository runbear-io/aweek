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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import {
  AgentCalendarPage,
  deriveReviewStem,
  layoutTasks,
} from './agent-calendar-page.tsx';
import type { CalendarDayKey, CalendarTask } from '../lib/api-client.ts';

// The LayoutResult index signature types placedByDayHour as unknown;
// cast to the concrete Map type for test assertions.
type PlacedEntry = { task: CalendarTask };
type PlacedMap = Map<string, PlacedEntry[]>;

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
  calendar: unknown,
  { ok = true, status = 200, statusText = 'OK' } = {},
) {
  const body = ok
    ? JSON.stringify({ calendar })
    : JSON.stringify({ error: 'boom' });
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl = vi.fn((url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve({
      ok,
      status,
      statusText,
      text: () => Promise.resolve(body),
    });
  });
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

function renderCalendar(calendar: { agentId?: string } | null | undefined, stubOpts = {}, props = {}) {
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
    const fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof globalThis.fetch; // never resolves
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
  it('renders a tight week/approval/TZ meta strip (agent identity lives in the breadcrumb, not here)', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    const header = await waitFor(() => {
      const el = container.querySelector('[data-calendar-header="true"]');
      expect(el).not.toBeNull();
      return el;
    });
    // The agent's name/slug appears in the shell's breadcrumb; the calendar
    // meta strip is intentionally slug-free so the chrome above the grid
    // stays one line.
    expect(header).not.toHaveTextContent(/alice/);
    expect(header).toHaveTextContent(WEEK);
    expect(header).toHaveTextContent(/approved/i);
    expect(header).toHaveTextContent(/UTC/);
    // Per-status counts live in the separate StatusLegend row below —
    // header should not repeat that info.
    expect(header).not.toHaveTextContent(/tasks/i);
    expect(header).not.toHaveTextContent(/review/i);
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

  it('renders the status legend with per-status counts alongside each glyph', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    const legend = await waitFor(() => {
      const el = container.querySelector('[data-calendar-legend="true"]');
      expect(el).not.toBeNull();
      return el;
    });
    // Each glyph + label pair carries its task count as a `data-count-value`
    // attribute so the chip is independently selectable in tests.
    expect(legend!.querySelector('[data-count-key="pending"]')).toHaveAttribute(
      'data-count-value',
      '3',
    );
    expect(
      legend!.querySelector('[data-count-key="completed"]'),
    ).toHaveAttribute('data-count-value', '1');
    expect(legend!.querySelector('[data-count-key="failed"]')).toHaveAttribute(
      'data-count-value',
      '0',
    );
    // Review-slot count is derived from tasks (not the counts envelope).
    expect(legend!.querySelector('[data-count-key="review"]')).toHaveAttribute(
      'data-count-value',
      '1',
    );
    // All seven status glyphs show up in the legend.
    expect(legend).toHaveTextContent('○');
    expect(legend).toHaveTextContent('►');
    expect(legend).toHaveTextContent('✓');
    expect(legend).toHaveTextContent('✗');
    expect(legend).toHaveTextContent('⊘');
    expect(legend).toHaveTextContent('→');
    expect(legend).toHaveTextContent('◆');
  });

  it('positions the status legend above the calendar grid', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    await waitFor(() => {
      expect(container.querySelector('[data-calendar-grid="true"]')).not.toBeNull();
    });
    const legend = container.querySelector('[data-calendar-legend="true"]');
    const grid = container.querySelector('[data-calendar-grid="true"]');
    expect(legend).not.toBeNull();
    expect(grid).not.toBeNull();
    expect(
      legend!.compareDocumentPosition(grid!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
      mon9!.querySelector('[data-task-id="task-b"]'),
    ).not.toBeNull();
    // Wednesday 2pm → task-a (pending)
    const wed14 = container.querySelector(
      '[role="gridcell"][data-day="wed"][data-hour="14"]',
    );
    expect(wed14).not.toBeNull();
    expect(
      wed14!.querySelector('[data-task-id="task-a"]'),
    ).not.toBeNull();
    // Tuesday 5pm → review slot
    const tue17 = container.querySelector(
      '[role="gridcell"][data-day="tue"][data-hour="17"]',
    );
    expect(tue17).not.toBeNull();
    expect(
      tue17!.querySelector('[data-task-id="task-review-d"]'),
    ).toHaveAttribute('data-task-review', 'true');
  });

  it('numbers tasks in column-major order (Mon first, then Tue, then Wed)', async () => {
    const { container } = renderCalendar(FULL_CALENDAR);
    await waitFor(() => {
      expect(container.querySelector('[data-calendar-grid="true"]')).not.toBeNull();
    });
    // Mon 9am (task-b) should be #1, Tue 5pm (task-review-d) #2,
    // Wed 2pm (task-a) #3, backlog (task-c) trailing #4.
    const byId = (id: string) =>
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

// ── Endpoint wiring ──────────────────────────────────────────────────

describe('AgentCalendarPage — endpoint wiring', () => {
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
    const { placedByDayHour, numbering } = layoutTasks([]) as unknown as { placedByDayHour: PlacedMap; numbering: Map<string, number> };
    expect(placedByDayHour.size).toBe(0);
    expect(numbering.size).toBe(0);
  });

  it('buckets tasks by `${dayKey}:${hour}` and numbers column-major', () => {
    const { placedByDayHour, numbering } = layoutTasks(FULL_CALENDAR.tasks as readonly CalendarTask[]) as unknown as { placedByDayHour: PlacedMap; numbering: Map<string, number> };
    expect(placedByDayHour.get('mon:9')).toHaveLength(1);
    expect(placedByDayHour.get('mon:9')![0].task.id).toBe('task-b');
    expect(placedByDayHour.get('tue:17')![0].task.id).toBe('task-review-d');
    expect(placedByDayHour.get('wed:14')![0].task.id).toBe('task-a');
    // Column-major numbering order: mon-9 → tue-17 → wed-14 → backlog.
    expect(numbering.get('task-b')).toBe(1);
    expect(numbering.get('task-review-d')).toBe(2);
    expect(numbering.get('task-a')).toBe(3);
    expect(numbering.get('task-c')).toBe(4);
  });

  it('breaks hour-bucket collisions by runAt ascending', () => {
    const t0900: CalendarTask = {
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
      slot: { dayKey: 'mon' as CalendarDayKey, dayOffset: 0, hour: 9, minute: 0, iso: '2026-04-20T09:00:00.000Z' },
    };
    const t0930: CalendarTask = {
      ...t0900,
      id: 'task-0930',
      runAt: '2026-04-20T09:30:00.000Z',
      slot: { ...t0900.slot!, minute: 30, iso: '2026-04-20T09:30:00.000Z' },
    };
    const { placedByDayHour } = layoutTasks([t0930, t0900]) as unknown as { placedByDayHour: PlacedMap };
    const bucket = placedByDayHour.get('mon:9')!;
    expect(bucket.map((e) => e.task.id)).toEqual(['task-0900', 'task-0930']);
  });
});

describe('deriveReviewStem (calendar review-task → review file stem)', () => {
  function reviewTask(partial: Partial<CalendarTask>): CalendarTask {
    return {
      id: 'task-review',
      title: '',
      prompt: '',
      status: 'pending',
      priority: null,
      estimatedMinutes: null,
      objectiveId: 'daily-review',
      track: null,
      runAt: null,
      completedAt: null,
      delegatedTo: null,
      slot: null,
      ...partial,
    } as CalendarTask;
  }

  it('returns `weekly-<isoWeek>` for a weekly-review task (matches heartbeat-written file)', () => {
    const task = reviewTask({ objectiveId: 'weekly-review' });
    // executeWeeklyReviewTask writes to `reviews/weekly-${week}.md`, so the
    // SPA permalink stem must include the `weekly-` prefix to round-trip.
    expect(deriveReviewStem(task, '2026-W17', 'UTC')).toBe('weekly-2026-W17');
  });

  it('returns null for a weekly-review task when calendarWeek is missing', () => {
    const task = reviewTask({ objectiveId: 'weekly-review' });
    expect(deriveReviewStem(task, null, 'UTC')).toBeNull();
  });

  it('returns null for a weekly-review task when calendarWeek is malformed', () => {
    const task = reviewTask({ objectiveId: 'weekly-review' });
    expect(deriveReviewStem(task, 'not-a-week', 'UTC')).toBeNull();
  });

  it('formats the daily-review stem from runAt in the configured time zone', () => {
    // 04-22 17:00 UTC is still 2026-04-22 in America/Los_Angeles (UTC-7).
    const task = reviewTask({
      objectiveId: 'daily-review',
      runAt: '2026-04-22T17:00:00.000Z',
    });
    expect(deriveReviewStem(task, '2026-W17', 'America/Los_Angeles')).toBe(
      'daily-2026-04-22',
    );
  });

  it('respects the time zone when the wall date crosses midnight UTC', () => {
    // 04-22 02:30 UTC is still 2026-04-21 in America/Los_Angeles (UTC-7).
    const task = reviewTask({
      objectiveId: 'daily-review',
      runAt: '2026-04-22T02:30:00.000Z',
    });
    expect(deriveReviewStem(task, '2026-W17', 'America/Los_Angeles')).toBe(
      'daily-2026-04-21',
    );
  });

  it('falls back to UTC when timeZone is missing', () => {
    const task = reviewTask({
      objectiveId: 'daily-review',
      runAt: '2026-04-22T02:30:00.000Z',
    });
    expect(deriveReviewStem(task, '2026-W17', undefined)).toBe(
      'daily-2026-04-22',
    );
  });

  it('returns null for a daily-review task without runAt', () => {
    const task = reviewTask({ objectiveId: 'daily-review', runAt: null });
    expect(deriveReviewStem(task, '2026-W17', 'UTC')).toBeNull();
  });

  it('returns null for a non-review task', () => {
    const task = reviewTask({ objectiveId: 'obj-1', runAt: '2026-04-22T17:00:00.000Z' });
    expect(deriveReviewStem(task, '2026-W17', 'UTC')).toBeNull();
  });

  it('returns null for null/undefined task input', () => {
    expect(deriveReviewStem(null, '2026-W17', 'UTC')).toBeNull();
    expect(deriveReviewStem(undefined, '2026-W17', 'UTC')).toBeNull();
  });
});

// ── AC 4 sub-AC 3: mobile day-navigation controls ───────────────────

/**
 * Install a `matchMedia` stub on `window` whose `matches` resolves true
 * iff the queried media string contains a `(max-width: …)` clause that
 * the supplied `viewportWidth` satisfies. Only the subset of features
 * `useIsMobile` exercises (`addEventListener('change', …)`,
 * `removeEventListener('change', …)`, `.matches`) is faked.
 */
function installMatchMediaStub(viewportWidth: number): () => void {
  const original = window.matchMedia;
  const mqls: Array<{
    query: string;
    matches: boolean;
    listeners: Set<(e: { matches: boolean }) => void>;
  }> = [];
  const stub = (query: string) => {
    const maxMatch = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches = maxMatch ? viewportWidth <= Number(maxMatch[1]) : false;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const mql = {
      query,
      matches,
      listeners,
      media: query,
      onchange: null,
      addEventListener: (
        _type: string,
        cb: (e: { matches: boolean }) => void,
      ) => listeners.add(cb),
      removeEventListener: (
        _type: string,
        cb: (e: { matches: boolean }) => void,
      ) => listeners.delete(cb),
      addListener: (cb: (e: { matches: boolean }) => void) => listeners.add(cb),
      removeListener: (cb: (e: { matches: boolean }) => void) =>
        listeners.delete(cb),
      dispatchEvent: () => false,
    };
    mqls.push(mql);
    return mql as unknown as MediaQueryList;
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: stub,
  });
  return () => {
    if (original) {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    } else {
      // jsdom doesn't ship matchMedia by default; remove the stub so the
      // SSR-safe branch in `useIsMobile` resumes its `false` default.
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  };
}

describe('AgentCalendarPage — mobile day-navigation (AC 4 sub-AC 3)', () => {
  let restoreMatchMedia: (() => void) | null = null;

  beforeEach(() => {
    restoreMatchMedia = installMatchMediaStub(375);
  });

  afterEach(() => {
    restoreMatchMedia?.();
    restoreMatchMedia = null;
  });

  /** Locate the mobile day-nav row, waiting until the calendar mounts. */
  async function findDayNav(container: HTMLElement): Promise<HTMLElement> {
    return await waitFor(() => {
      const el = container.querySelector(
        '[data-calendar-mobile-day-nav="true"]',
      ) as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
  }

  it('renders the mobile day-nav row with prev/next buttons + a date label', async () => {
    const { container } = renderCalendar(FULL_CALENDAR, {}, { week: '2025-W01' });
    const nav = await findDayNav(container);
    const prev = nav.querySelector(
      '[data-calendar-mobile-prev-day]',
    ) as HTMLButtonElement | null;
    const next = nav.querySelector(
      '[data-calendar-mobile-next-day]',
    ) as HTMLButtonElement | null;
    const label = nav.querySelector(
      '[data-calendar-mobile-day-label="true"]',
    ) as HTMLElement | null;
    expect(prev).not.toBeNull();
    expect(next).not.toBeNull();
    expect(label).not.toBeNull();
    // Default mobile anchor on a non-current week is Monday, so the label
    // covers Mon → Wed of the rendered week.
    expect(label!.textContent).toMatch(/Apr 20/);
    expect(label!.textContent).toMatch(/Apr 22/);
  });

  it('renders prev/next buttons with a 44×44 px touch-target floor', async () => {
    const { container } = renderCalendar(FULL_CALENDAR, {}, { week: '2025-W01' });
    const nav = await findDayNav(container);
    const buttons = nav.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    for (const btn of Array.from(buttons)) {
      // Tailwind h-11 / w-11 = 44px exactly. Asserting on the class list
      // is the deterministic check; jsdom doesn't run the layout engine
      // so measured `getBoundingClientRect()` would return zeros.
      expect(btn.className).toMatch(/\bh-11\b/);
      expect(btn.className).toMatch(/\bw-11\b/);
      expect(btn.className).toMatch(/\bmin-h-11\b/);
      expect(btn.className).toMatch(/\bmin-w-11\b/);
    }
  });

  it('disables Previous when the strip is anchored at Monday', async () => {
    const { container } = renderCalendar(FULL_CALENDAR, {}, { week: '2025-W01' });
    const nav = await findDayNav(container);
    const [prev, next] = Array.from(nav.querySelectorAll('button')) as HTMLButtonElement[];
    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();
    // The anchor data-attribute mirrors the visible leftmost day so tests
    // can assert position deterministically.
    const label = nav.querySelector('[data-calendar-mobile-day-label="true"]');
    expect(label).toHaveAttribute('data-anchor-day-key', 'mon');
  });

  it('advances the anchor day by one when Next is tapped and updates the label', async () => {
    const { container } = renderCalendar(FULL_CALENDAR, {}, { week: '2025-W01' });
    const nav = await findDayNav(container);
    const [, next] = Array.from(nav.querySelectorAll('button')) as HTMLButtonElement[];
    fireEvent.click(next);
    await waitFor(() => {
      const label = container.querySelector(
        '[data-calendar-mobile-day-label="true"]',
      );
      expect(label).toHaveAttribute('data-anchor-day-key', 'tue');
      // Tue → Thu of the same week.
      expect(label!.textContent).toMatch(/Apr 21/);
      expect(label!.textContent).toMatch(/Apr 23/);
    });
  });

  it('clamps the next-day step at Friday (last valid 3-day anchor)', async () => {
    const { container } = renderCalendar(FULL_CALENDAR, {}, { week: '2025-W01' });
    const nav = await findDayNav(container);
    const [, next] = Array.from(nav.querySelectorAll('button')) as HTMLButtonElement[];
    // Step Mon → Tue → Wed → Thu → Fri. Five clicks; the fifth is a no-op
    // because Fri is already the latest anchor that keeps a 3-day window
    // inside Mon–Sun.
    for (let i = 0; i < 5; i += 1) fireEvent.click(next);
    await waitFor(() => {
      const label = container.querySelector(
        '[data-calendar-mobile-day-label="true"]',
      );
      expect(label).toHaveAttribute('data-anchor-day-key', 'fri');
    });
    expect(next).toBeDisabled();
  });

  it('flows the user-chosen anchor day through to <CalendarGrid>', async () => {
    const { container } = renderCalendar(FULL_CALENDAR, {}, { week: '2025-W01' });
    const nav = await findDayNav(container);
    const [, next] = Array.from(nav.querySelectorAll('button')) as HTMLButtonElement[];
    fireEvent.click(next); // tue
    fireEvent.click(next); // wed
    await waitFor(() => {
      const wedHeader = container.querySelector(
        '[role="columnheader"][data-day="wed"]',
      );
      expect(wedHeader).not.toBeNull();
      // Mon and Tue should NOT be in the visible 3-day strip anymore.
      expect(
        container.querySelector('[role="columnheader"][data-day="mon"]'),
      ).toBeNull();
      expect(
        container.querySelector('[role="columnheader"][data-day="tue"]'),
      ).toBeNull();
    });
  });

  it('does not render the day-nav on desktop viewports', async () => {
    // Replace the mobile stub with a desktop one for this test.
    restoreMatchMedia?.();
    restoreMatchMedia = installMatchMediaStub(1280);
    const { container } = renderCalendar(FULL_CALENDAR, {}, { week: '2025-W01' });
    await waitFor(() => {
      expect(container.querySelector('[data-calendar-grid="true"]')).not.toBeNull();
    });
    expect(
      container.querySelector('[data-calendar-mobile-day-nav="true"]'),
    ).toBeNull();
  });

  it('does not render the day-nav in the no-plan empty state', async () => {
    const { container } = renderCalendar(NO_PLAN_CALENDAR);
    await screen.findByText(/no weekly plan yet/i);
    expect(
      container.querySelector('[data-calendar-mobile-day-nav="true"]'),
    ).toBeNull();
  });
});
