/**
 * Component tests for the extracted `CalendarGrid` (AC 3, Sub-AC 2).
 *
 * `CalendarGrid` is the reusable 7-day × hour weekly grid surface. It's
 * a pure presentational component — it takes a task list + week metadata
 * and renders the grid. Data fetching, page chrome (header, counts,
 * backlog, legend) all live in `AgentCalendarPage` and are verified
 * separately in `pages/agent-calendar-page.test.jsx`.
 *
 * These tests cover the grid-specific surface only:
 *   - Structural geometry (rows per hour, columns per day)
 *   - Task placement at `slot.{dayKey,hour}`
 *   - Column-major task numbering
 *   - Collision stacking (multiple tasks in one cell, sorted by runAt)
 *   - Review slot rendering (◆ glyph + display name)
 *   - Auto weekend extension when any slot lands on Sat/Sun
 *   - `showWeekend` prop forces 7-day mode even when tasks don't
 *   - Unscheduled tasks ignored (page Backlog handles them)
 *   - Custom `startHour` / `endHour` prop respected
 *   - `layoutTasks` pure helper invariants
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import {
  CalendarGrid,
  DAY_KEYS,
  DAY_LABELS,
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  REVIEW_ICON,
  STATUS_ICONS,
  extractMinuteBadge,
  isReviewTask,
  layoutTasks,
} from './calendar-grid.tsx';
import type { CalendarTask, CalendarTaskSlot } from './calendar-grid.tsx';

// ── Fixtures ─────────────────────────────────────────────────────────

type TaskFixture = Partial<Omit<CalendarTask, 'slot'>> & {
  slot?: Partial<CalendarTaskSlot> | null;
};

const WEEK_MONDAY = '2026-04-20T00:00:00.000Z';

function makeTask(partial: TaskFixture): CalendarTask {
  return {
    id: 'task-id',
    title: 'Task',
    prompt: null,
    status: 'pending',
    priority: null,
    estimatedMinutes: null,
    objectiveId: 'obj-1',
    track: null,
    runAt: null,
    completedAt: null,
    delegatedTo: null,
    outcomeAchieved: null,
    warnings: [],
    slot: null,
    ...partial,
  } as CalendarTask;
}

function makeScheduledTask(partial: TaskFixture): CalendarTask {
  const { slot, ...rest } = partial;
  const base = makeTask(rest);
  const { dayKey = 'mon', dayOffset = 0, hour = 9, minute = 0 } = slot || {};
  const iso = base.runAt || '2026-04-20T09:00:00.000Z';
  return {
    ...base,
    runAt: base.runAt || iso,
    slot: { dayKey, dayOffset, hour, minute, iso },
  } as CalendarTask;
}

const SCHEDULED_TASKS = [
  makeScheduledTask({
    id: 'task-mon-9',
    title: 'Monday kickoff',
    status: 'completed',
    runAt: '2026-04-20T09:00:00.000Z',
    slot: { dayKey: 'mon', dayOffset: 0, hour: 9, minute: 0 },
  }),
  makeScheduledTask({
    id: 'task-tue-17',
    title: '',
    objectiveId: 'daily-review',
    status: 'pending',
    runAt: '2026-04-21T17:00:00.000Z',
    slot: { dayKey: 'tue', dayOffset: 1, hour: 17, minute: 0 },
  }),
  makeScheduledTask({
    id: 'task-wed-14',
    title: 'Wednesday planning',
    status: 'pending',
    runAt: '2026-04-22T14:00:00.000Z',
    slot: { dayKey: 'wed', dayOffset: 2, hour: 14, minute: 0 },
  }),
];

// ── Lifecycle ────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
});

// ── Structure ────────────────────────────────────────────────────────

describe('CalendarGrid — structural geometry', () => {
  it('renders the grid wrapper with the data-calendar-grid hook', () => {
    const { container } = render(
      <CalendarGrid tasks={[]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const grid = container.querySelector('[data-calendar-grid="true"]');
    expect(grid).not.toBeNull();
    // The grid wrapper exposes role=grid for a11y.
    expect(container.querySelector('[role="grid"]')).not.toBeNull();
  });

  it('renders 5 weekday columns by default', () => {
    const { container } = render(
      <CalendarGrid tasks={[]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(headers.length).toBe(5);
    const seen = Array.from(headers).map((h) => h.getAttribute('data-day'));
    expect(seen).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
  });

  it('renders one row per working hour', () => {
    const { container } = render(
      <CalendarGrid tasks={[]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    // Each day has one gridcell per hour; Monday column alone gives the count.
    const monCells = container.querySelectorAll(
      '[role="gridcell"][data-day="mon"]',
    );
    expect(monCells.length).toBe(DEFAULT_END_HOUR - DEFAULT_START_HOUR);
  });

  it('renders day labels from DAY_LABELS', () => {
    const { container } = render(
      <CalendarGrid tasks={[]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    // Each header contains the day label + date (e.g., "Mon4/20") — assert
    // that every canonical weekday label appears in the rendered content.
    const texts = Array.from(headers).map((h) => h.textContent || '');
    for (const label of DAY_LABELS.slice(0, 5)) {
      expect(texts.some((t) => t.includes(label))).toBe(true);
    }
  });

  it('applies aria-label scoped to the agentId', () => {
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        agentId="alice"
      />,
    );
    const grid = container.querySelector('[role="grid"]');
    expect(grid).toHaveAttribute('aria-label', 'Weekly calendar for alice');
  });

  it('honours custom startHour / endHour window', () => {
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        startHour={10}
        endHour={13}
      />,
    );
    const monCells = container.querySelectorAll(
      '[role="gridcell"][data-day="mon"]',
    );
    expect(monCells.length).toBe(3);
    const hours = Array.from(monCells).map((c) => c.getAttribute('data-hour'));
    expect(hours).toEqual(['10', '11', '12']);
  });
});

// ── Task placement ───────────────────────────────────────────────────

describe('CalendarGrid — task placement', () => {
  it('places tasks at their slot day/hour', () => {
    const { container } = render(
      <CalendarGrid
        tasks={SCHEDULED_TASKS}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
      />,
    );
    const mon9 = container.querySelector(
      '[role="gridcell"][data-day="mon"][data-hour="9"]',
    );
    expect(mon9!.querySelector('[data-task-id="task-mon-9"]')).not.toBeNull();

    const wed14 = container.querySelector(
      '[role="gridcell"][data-day="wed"][data-hour="14"]',
    );
    expect(wed14!.querySelector('[data-task-id="task-wed-14"]')).not.toBeNull();
  });

  it('numbers tasks in column-major order', () => {
    const { container } = render(
      <CalendarGrid
        tasks={SCHEDULED_TASKS}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
      />,
    );
    const byId = (id: string) => container.querySelector(`[data-task-id="${id}"]`);
    expect(byId('task-mon-9')).toHaveAttribute('data-task-number', '1');
    expect(byId('task-tue-17')).toHaveAttribute('data-task-number', '2');
    expect(byId('task-wed-14')).toHaveAttribute('data-task-number', '3');
  });

  it('stacks collisions in a single cell, sorted by runAt ascending', () => {
    const early = makeScheduledTask({
      id: 'task-early',
      title: '9:00',
      runAt: '2026-04-20T09:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 9, minute: 0 },
    });
    const late = makeScheduledTask({
      id: 'task-late',
      title: '9:30',
      runAt: '2026-04-20T09:30:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 9, minute: 30 },
    });
    // Pass "late" first so the sort-by-runAt is exercised.
    const { container } = render(
      <CalendarGrid
        tasks={[late, early]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
      />,
    );
    const mon9 = container.querySelector(
      '[role="gridcell"][data-day="mon"][data-hour="9"]',
    );
    const chips = mon9!.querySelectorAll('[data-task-id]');
    expect(Array.from(chips).map((c) => c.getAttribute('data-task-id'))).toEqual([
      'task-early',
      'task-late',
    ]);
  });

  it('renders status icons matching the terminal baseline', () => {
    const tasks = Object.keys(STATUS_ICONS).map((status, i) =>
      makeScheduledTask({
        id: `task-${status}`,
        status,
        runAt: `2026-04-20T0${9 + i}:00:00.000Z`,
        slot: { dayKey: 'mon', dayOffset: 0, hour: 9 + i, minute: 0 },
      }),
    );
    const { container } = render(
      <CalendarGrid tasks={tasks} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    for (const [status, icon] of Object.entries(STATUS_ICONS)) {
      const chip = container.querySelector(`[data-task-id="task-${status}"]`);
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain(icon);
      expect(chip).toHaveAttribute('data-task-status', status);
    }
  });

  it('renders review slots with ◆ and the review display name', () => {
    const { container } = render(
      <CalendarGrid
        tasks={SCHEDULED_TASKS}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
      />,
    );
    const review = container.querySelector('[data-task-id="task-tue-17"]');
    expect(review).toHaveAttribute('data-task-review', 'true');
    expect(review!.textContent).toContain(REVIEW_ICON);
    expect(review!.textContent).toMatch(/daily review/i);
  });

  it('ignores tasks without a slot (backlog lives outside the grid)', () => {
    const unscheduled = makeTask({
      id: 'task-backlog',
      title: 'Backlog item',
      slot: null,
    });
    const { container } = render(
      <CalendarGrid
        tasks={[...SCHEDULED_TASKS, unscheduled]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
      />,
    );
    expect(
      container.querySelector('[data-task-id="task-backlog"]'),
    ).toBeNull();
  });
});

// ── Weekend handling ─────────────────────────────────────────────────

describe('CalendarGrid — weekend handling', () => {
  it('auto-extends to 7 columns when a task lands on Saturday', () => {
    const saturdayTask = makeScheduledTask({
      id: 'task-sat-10',
      title: 'Saturday study',
      runAt: '2026-04-25T10:00:00.000Z',
      slot: { dayKey: 'sat', dayOffset: 5, hour: 10, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid
        tasks={[saturdayTask]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
      />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(headers.length).toBe(7);
    expect(
      container.querySelector('[data-task-id="task-sat-10"]'),
    ).not.toBeNull();
  });

  it('honours explicit showWeekend even when all tasks are weekdays', () => {
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        showWeekend
      />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(headers.length).toBe(7);
  });
});

// ── Mobile (daysToShow / anchorDayKey) ───────────────────────────────

describe('CalendarGrid — daysToShow + anchorDayKey (AC 4 sub-AC 2)', () => {
  it('renders exactly 1 day column when daysToShow=1', () => {
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={1}
      />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(headers.length).toBe(1);
    expect(headers[0].getAttribute('data-day')).toBe('mon');
  });

  it('renders 3 day columns when daysToShow=3 starting from anchorDayKey', () => {
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={3}
        anchorDayKey="wed"
      />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(Array.from(headers).map((h) => h.getAttribute('data-day'))).toEqual([
      'wed',
      'thu',
      'fri',
    ]);
  });

  it('clamps the anchor backwards so the visible window stays inside Mon–Sun', () => {
    // anchor=sun with daysToShow=3 would push past the week — clamp back
    // so we still render three full columns ending on Sunday.
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={3}
        anchorDayKey="sun"
      />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(Array.from(headers).map((h) => h.getAttribute('data-day'))).toEqual([
      'fri',
      'sat',
      'sun',
    ]);
  });

  it('overrides the auto-weekend extension when daysToShow is explicit', () => {
    // A Saturday task would normally extend the desktop grid to 7
    // columns. Mobile mode keeps daysToShow honoured — Sat falls outside
    // the visible window for daysToShow=3 + anchor=mon, but the chip is
    // still in the DOM via the column-major layout (just not in any
    // visible cell). The grid must NOT silently jump back to 7 columns.
    const saturdayTask = makeScheduledTask({
      id: 'task-sat-10',
      title: 'Saturday study',
      runAt: '2026-04-25T10:00:00.000Z',
      slot: { dayKey: 'sat', dayOffset: 5, hour: 10, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid
        tasks={[saturdayTask]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={3}
        anchorDayKey="mon"
      />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(headers.length).toBe(3);
    expect(Array.from(headers).map((h) => h.getAttribute('data-day'))).toEqual([
      'mon',
      'tue',
      'wed',
    ]);
  });

  it('renders the absolute date for sliced day columns (not the local index)', () => {
    // Anchor on Wed; the date label under "Wed" must be Monday + 2 days
    // (4/22 for the WEEK_MONDAY fixture), not Monday + 0.
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={3}
        anchorDayKey="wed"
      />,
    );
    const wedHeader = container.querySelector(
      '[role="columnheader"][data-day="wed"]',
    );
    // Mon=4/20, Tue=4/21, Wed=4/22 — assert the slice still labels the
    // calendar date correctly even though Wed is now at slice index 0.
    expect(wedHeader!.textContent).toMatch(/4\/22/);
  });

  it('numbering stays column-major across the full week even when sliced', () => {
    // Two tasks: one on Mon (outside the visible 3-day strip starting
    // Wed), one on Wed (inside). Numbering walks Mon–Sun, so the Mon
    // task is #1 and the Wed task is #2 — even when only the Wed task
    // is visible.
    const tasks = [
      makeScheduledTask({
        id: 'task-mon',
        runAt: '2026-04-20T09:00:00.000Z',
        slot: { dayKey: 'mon', dayOffset: 0, hour: 9, minute: 0 },
      }),
      makeScheduledTask({
        id: 'task-wed',
        runAt: '2026-04-22T09:00:00.000Z',
        slot: { dayKey: 'wed', dayOffset: 2, hour: 9, minute: 0 },
      }),
    ];
    const { container } = render(
      <CalendarGrid
        tasks={tasks}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={3}
        anchorDayKey="wed"
      />,
    );
    const wed = container.querySelector('[data-task-id="task-wed"]');
    expect(wed).not.toBeNull();
    // Wed task gets #2 because Mon is column-major before it, even
    // though Mon isn't in the visible window.
    expect(wed).toHaveAttribute('data-task-number', '2');
    // Mon task is laid out into a (mon, hour) cell, but that cell isn't
    // rendered — so its chip should be absent from the DOM.
    expect(container.querySelector('[data-task-id="task-mon"]')).toBeNull();
  });

  it('renders 5 columns when daysToShow=5 (mobile-friendly weekday strip)', () => {
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={5}
      />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(headers.length).toBe(5);
  });

  it('renders 7 columns when daysToShow=7 (full week explicit)', () => {
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={7}
      />,
    );
    const headers = container.querySelectorAll(
      '[role="columnheader"][data-day]',
    );
    expect(headers.length).toBe(7);
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────

describe('CalendarGrid — pure helpers', () => {
  it('layoutTasks returns empty structures for empty input', () => {
    const { placedByDayHour, numbering } = layoutTasks([]);
    expect(placedByDayHour.size).toBe(0);
    expect(numbering.size).toBe(0);
  });

  it('layoutTasks buckets + numbers tasks column-major', () => {
    const { placedByDayHour, numbering } = layoutTasks(SCHEDULED_TASKS);
    expect(placedByDayHour.get('mon:9')![0].task.id).toBe('task-mon-9');
    expect(placedByDayHour.get('tue:17')![0].task.id).toBe('task-tue-17');
    expect(placedByDayHour.get('wed:14')![0].task.id).toBe('task-wed-14');
    expect(numbering.get('task-mon-9')).toBe(1);
    expect(numbering.get('task-tue-17')).toBe(2);
    expect(numbering.get('task-wed-14')).toBe(3);
  });

  it('layoutTasks assigns trailing numbers to unscheduled tasks', () => {
    const backlog = makeTask({ id: 'task-backlog', slot: null });
    const { numbering } = layoutTasks([...SCHEDULED_TASKS, backlog]);
    // Scheduled tasks occupy 1–3; backlog gets 4.
    expect(numbering.get('task-backlog')).toBe(4);
  });

  it('layoutTasks respects a custom hour window', () => {
    // A task at hour 22 would fall outside the default 9–18 window and
    // clamp to the last visible hour; when the caller passes a wider
    // window, it lands on the real hour.
    const lateTask = makeScheduledTask({
      id: 'task-late-night',
      runAt: '2026-04-20T22:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 22, minute: 0 },
    });
    const { placedByDayHour } = layoutTasks([lateTask], {
      startHour: 8,
      endHour: 23,
    });
    expect(placedByDayHour.get('mon:22')![0].task.id).toBe('task-late-night');
  });

  it('isReviewTask recognises the reserved objectiveIds', () => {
    expect(isReviewTask({ objectiveId: 'daily-review' })).toBe(true);
    expect(isReviewTask({ objectiveId: 'weekly-review' })).toBe(true);
    expect(isReviewTask({ objectiveId: 'obj-1' })).toBe(false);
    expect(isReviewTask(null)).toBe(false);
  });

  it('DAY_KEYS stays in canonical Mon–Sun order', () => {
    expect(DAY_KEYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });
});

// ── Sub-AC 3 parity: task cell rendering ─────────────────────────────
//
// These tests pin down the three pillars of task cell rendering called
// out by Sub-AC 3 of AC 3: (1) task title, (2) status indicator, and
// (3) time slot placement — each asserted against the exact format that
// the terminal `renderGrid` / `wrapTaskBlock` in
// `src/skills/weekly-calendar-grid.js` produces.
describe('CalendarGrid — task cell rendering parity (Sub-AC 3)', () => {
  it('renders the task title verbatim and exposes it via data-task-title', () => {
    const task = makeScheduledTask({
      id: 'task-title',
      title: 'Draft quarterly OKRs',
      status: 'pending',
      runAt: '2026-04-20T11:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 11, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="task-title"]');
    expect(chip).not.toBeNull();
    // The visible label must include the terminal baseline title string.
    expect(chip!.textContent).toContain('Draft quarterly OKRs');
    // The title is also mirrored into a stable data attribute so other
    // components (tooltips, drawers) can pick it up without string parsing.
    expect(chip).toHaveAttribute('data-task-title', 'Draft quarterly OKRs');
  });

  it('status indicator icon/tone/data-attr align with the task status', () => {
    const task = makeScheduledTask({
      id: 'task-inprog',
      title: 'Ship release candidate',
      status: 'in-progress',
      runAt: '2026-04-20T10:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 10, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="task-inprog"]');
    expect(chip).not.toBeNull();
    // Status indicator — matches the CLI legend glyph.
    expect(chip!.textContent).toContain(STATUS_ICONS['in-progress']);
    // Status attribute — matches the data-driven status value.
    expect(chip).toHaveAttribute('data-task-status', 'in-progress');
    // Review flag stays off for work tasks.
    expect(chip!.getAttribute('data-task-review')).toBeNull();
  });

  it('places the chip at the cell that matches slot.{dayKey, hour}', () => {
    const task = makeScheduledTask({
      id: 'task-slot',
      title: 'Deep work block',
      runAt: '2026-04-22T15:00:00.000Z',
      slot: { dayKey: 'wed', dayOffset: 2, hour: 15, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    // Chip must NOT appear in any other cell.
    const wrong = container.querySelector(
      '[role="gridcell"][data-day="mon"][data-hour="9"] [data-task-id="task-slot"]',
    );
    expect(wrong).toBeNull();
    // Chip must appear in the exact wed/15 cell.
    const cell = container.querySelector(
      '[role="gridcell"][data-day="wed"][data-hour="15"]',
    );
    expect(cell!.querySelector('[data-task-id="task-slot"]')).not.toBeNull();
  });

  it('renders a :MM minute badge when runAt has non-zero minutes', () => {
    const half = makeScheduledTask({
      id: 'task-half',
      title: 'Sync with ops',
      runAt: '2026-04-20T13:30:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 13, minute: 30 },
    });
    const { container } = render(
      <CalendarGrid tasks={[half]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="task-half"]');
    expect(chip).toHaveAttribute('data-task-minute', '30');
    expect(chip!.textContent).toContain(':30');
  });

  it('omits the minute badge when the task lands on the hour', () => {
    const onHour = makeScheduledTask({
      id: 'task-on-hour',
      title: 'Top of the hour',
      runAt: '2026-04-20T14:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 14, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[onHour]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="task-on-hour"]');
    expect(chip!.getAttribute('data-task-minute')).toBeNull();
  });

  it('numbers intra-hour collisions in runAt order and surfaces both minutes', () => {
    const first = makeScheduledTask({
      id: 'collide-a',
      title: 'Earlier slot',
      runAt: '2026-04-20T09:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 9, minute: 0 },
    });
    const second = makeScheduledTask({
      id: 'collide-b',
      title: 'Half-past slot',
      runAt: '2026-04-20T09:30:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 9, minute: 30 },
    });
    const { container } = render(
      <CalendarGrid
        tasks={[second, first]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
      />,
    );
    const chips = container.querySelectorAll(
      '[role="gridcell"][data-day="mon"][data-hour="9"] [data-task-id]',
    );
    const ids = Array.from(chips).map((c) => c.getAttribute('data-task-id'));
    expect(ids).toEqual(['collide-a', 'collide-b']);
    // Column-major numbering: 9:00 task gets #1, 9:30 task gets #2.
    expect(chips[0]).toHaveAttribute('data-task-number', '1');
    expect(chips[1]).toHaveAttribute('data-task-number', '2');
    // The 9:30 task shows its minute badge; 9:00 does not.
    expect(chips[0].getAttribute('data-task-minute')).toBeNull();
    expect(chips[1]).toHaveAttribute('data-task-minute', '30');
  });

  it('renders review-slot cells with ◆, display name, and no status colouring', () => {
    const daily = makeScheduledTask({
      id: 'review-daily',
      title: '',
      status: 'pending',
      objectiveId: 'daily-review',
      runAt: '2026-04-20T17:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 17, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[daily]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="review-daily"]');
    expect(chip).toHaveAttribute('data-task-review', 'true');
    expect(chip).toHaveAttribute('data-task-title', 'Daily Review');
    expect(chip!.textContent).toContain(REVIEW_ICON);
    expect(chip!.textContent).toContain('Daily Review');
  });

  it('exposes a tooltip that mirrors the terminal prefix format `icon num. title`', () => {
    const task = makeScheduledTask({
      id: 'task-tooltip',
      title: 'Review infra proposal',
      status: 'pending',
      estimatedMinutes: 90,
      runAt: '2026-04-20T10:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 10, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="task-tooltip"]');
    const tooltip = chip!.getAttribute('title') || '';
    // Terminal parity: tooltip first line matches `${icon} ${num}. ${title}`
    expect(tooltip.split('\n')[0]).toBe(
      `${STATUS_ICONS.pending} 1. Review infra proposal`,
    );
    // estimatedMinutes surfaces in the tooltip to mirror the terminal's
    // `Math.ceil(minutes / 60)` row span without hijacking the cell.
    expect(tooltip).toContain('90 min');
  });

  it('extractMinuteBadge handles slot.minute, runAt fallback, and zero-minute tasks', () => {
    // Slot minute takes precedence.
    expect(
      extractMinuteBadge({ slot: { minute: 45 } as CalendarTaskSlot, runAt: null }),
    ).toBe('45');
    // Falls back to runAt when slot is absent.
    expect(
      extractMinuteBadge({ slot: null, runAt: '2026-04-20T09:15:00.000Z' }),
    ).toBe('15');
    // Returns null for on-the-hour tasks.
    expect(
      extractMinuteBadge({ slot: { minute: 0 } as CalendarTaskSlot, runAt: '2026-04-20T09:00:00.000Z' }),
    ).toBeNull();
    // Tolerates missing/garbage input.
    expect(extractMinuteBadge(null)).toBeNull();
    expect(extractMinuteBadge({})).toBeNull();
    expect(extractMinuteBadge({ runAt: 'not-a-date' })).toBeNull();
  });
});

describe('CalendarGrid — verifier-flagged completed tasks', () => {
  // The verifier (post-execution outcome check) writes two fields onto
  // a `completed` task: `outcomeAchieved: bool | undefined` (the verdict
  // — undefined when the verifier didn't run / skipped) and
  // `warnings: string[]`. The chip renders three distinct visuals:
  //
  //   1. Clean success: `status: 'completed'`, `outcomeAchieved: true`
  //      (or null) AND empty warnings → emerald chip + ✓ glyph.
  //   2. Warned: `outcomeAchieved !== false` (true OR null) AND
  //      `warnings.length > 0` → amber tone + ⚠ inline glyph.
  //   3. Not achieved: `outcomeAchieved === false` → rose tone + ✗
  //      glyph (the failed-status icon, reused so the icon vocabulary
  //      stays small). Suppresses the amber ⚠ even when warnings are
  //      also present, since the rose chip already conveys the stronger
  //      signal and the warnings strings still surface in the tooltip.

  it('clean completed task uses emerald tone + ✓ glyph and no verifier data attrs', () => {
    const task = makeScheduledTask({
      id: 'verif-clean',
      title: 'Clean completed',
      status: 'completed',
      outcomeAchieved: true,
      warnings: [],
      runAt: '2026-04-20T11:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 11, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="verif-clean"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain(STATUS_ICONS.completed);
    expect(chip!.textContent).not.toContain('⚠');
    expect(chip!.className).toMatch(/\bemerald\b/);
    expect(chip!.getAttribute('data-task-warnings')).toBeNull();
    expect(chip!.getAttribute('data-task-outcome-achieved')).toBeNull();
  });

  it('completed-with-warnings uses amber tone + ⚠ glyph alongside ✓', () => {
    const task = makeScheduledTask({
      id: 'verif-warn',
      title: 'Warned but achieved',
      status: 'completed',
      outcomeAchieved: true,
      warnings: ['Captured output only shows agent claiming task complete'],
      runAt: '2026-04-20T12:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 12, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="verif-warn"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain(STATUS_ICONS.completed);
    expect(chip!.textContent).toContain('⚠');
    expect(chip!.className).toMatch(/\bamber\b/);
    expect(chip).toHaveAttribute('data-task-warnings', 'true');
    expect(chip!.getAttribute('data-task-outcome-achieved')).toBeNull();
    expect(chip!.getAttribute('title')).toContain('Concerns:');
  });

  it('outcomeAchieved=false swaps to rose tone + ✗ glyph and surfaces "outcome NOT achieved" in tooltip', () => {
    const task = makeScheduledTask({
      id: 'verif-fail',
      title: 'Outcome not achieved',
      status: 'completed',
      outcomeAchieved: false,
      warnings: [],
      runAt: '2026-04-20T13:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 13, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="verif-fail"]');
    expect(chip).not.toBeNull();
    // Status data attribute stays `completed` — only the verdict field flips.
    expect(chip).toHaveAttribute('data-task-status', 'completed');
    expect(chip).toHaveAttribute('data-task-outcome-achieved', 'false');
    // Visual swap: ✗ icon (reused from STATUS_ICONS.failed) + rose tone.
    expect(chip!.textContent).toContain(STATUS_ICONS.failed);
    expect(chip!.textContent).not.toContain(STATUS_ICONS.completed);
    expect(chip!.className).toMatch(/\brose\b/);
    expect(chip!.className).not.toMatch(/\bemerald\b/);
    // Tooltip includes the verifier verdict line.
    expect(chip!.getAttribute('title')).toContain('Verifier: outcome NOT achieved');
  });

  it('outcomeAchieved=false suppresses the amber ⚠ inline glyph even when warnings are present', () => {
    const task = makeScheduledTask({
      id: 'verif-fail-with-warn',
      title: 'Not achieved + concerns',
      status: 'completed',
      outcomeAchieved: false,
      warnings: ['No publish action observed in stdout'],
      runAt: '2026-04-20T14:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 14, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector(
      '[data-task-id="verif-fail-with-warn"]',
    );
    expect(chip).not.toBeNull();
    // Rose tone wins — amber ⚠ glyph is suppressed because ✗ already
    // conveys the stronger signal.
    expect(chip!.className).toMatch(/\brose\b/);
    expect(chip!.textContent).not.toContain('⚠');
    // Warnings still surface via tooltip (and the data-task-warnings attr
    // stays true so downstream consumers can pick them up).
    expect(chip).toHaveAttribute('data-task-warnings', 'true');
    expect(chip).toHaveAttribute('data-task-outcome-achieved', 'false');
    expect(chip!.getAttribute('title')).toContain('Verifier: outcome NOT achieved');
    expect(chip!.getAttribute('title')).toContain('Concerns:');
    expect(chip!.getAttribute('title')).toContain(
      'No publish action observed in stdout',
    );
  });

  it('verifier verdict on a non-completed task is ignored (only fires on completed)', () => {
    // outcomeAchieved=false on a `pending` task should NOT swap the tone —
    // the verifier only runs post-execution, so any field set on a
    // non-completed task is stale or invalid input and the chip should
    // render its base status tone unchanged.
    const task = makeScheduledTask({
      id: 'verif-stale',
      title: 'Pending with stale verdict',
      status: 'pending',
      outcomeAchieved: false,
      warnings: ['stale concern'],
      runAt: '2026-04-20T15:00:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 15, minute: 0 },
    });
    const { container } = render(
      <CalendarGrid tasks={[task]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const chip = container.querySelector('[data-task-id="verif-stale"]');
    expect(chip).not.toBeNull();
    expect(chip!.className).not.toMatch(/\brose\b/);
    expect(chip!.className).not.toMatch(/\bamber\b/);
    expect(chip!.getAttribute('data-task-outcome-achieved')).toBeNull();
    expect(chip!.getAttribute('data-task-warnings')).toBeNull();
  });
});

// ── Sub-AC 2.2: mobile-fit grid track widths ─────────────────────────
//
// At 375 px the layout's `<main>` carries `p-4` (16 px each side), so the
// calendar grid lives inside an ~343 px column. The historical
// `72px + N × minmax(120px, 1fr)` track total was 432 px for the
// 3-day mobile strip and forced horizontal scroll inside the grid
// wrapper. Mobile mode now uses tighter tracks (`52px + N × minmax(88px, 1fr)`)
// so the same 3-day strip totals ~316 px and fits without overflow,
// while desktop (≥ md) keeps the historical 72/120 layout untouched.

/**
 * Install a `matchMedia` stub on `window` whose `matches` resolves true
 * iff the queried media string contains a `(max-width: …)` clause that
 * the supplied `viewportWidth` satisfies. Mirrors the helper used in
 * `pages/agent-calendar-page.test.tsx`.
 */
function installMatchMediaStub(viewportWidth: number): () => void {
  const original = window.matchMedia;
  const stub = (query: string) => {
    const maxMatch = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches = maxMatch ? viewportWidth <= Number(maxMatch[1]) : false;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const mql = {
      query,
      matches,
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
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  };
}

describe('CalendarGrid — mobile-fit track widths (Sub-AC 2.2)', () => {
  let restoreMatchMedia: (() => void) | null = null;
  afterEach(() => {
    restoreMatchMedia?.();
    restoreMatchMedia = null;
  });

  it('uses 52px hour column + 88px day-min on mobile (375px viewport)', () => {
    restoreMatchMedia = installMatchMediaStub(375);
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={3}
      />,
    );
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    expect(grid).not.toBeNull();
    // The inline gridTemplateColumns is the source of truth for fit.
    // 3-day strip mobile total: 52 + 3 × 88 = 316 px (fits in ~343 px).
    const tracks = grid.style.gridTemplateColumns;
    expect(tracks).toBe('52px repeat(3, minmax(88px, 1fr))');
  });

  it('keeps the historical 72px/120px tracks on desktop viewports', () => {
    restoreMatchMedia = installMatchMediaStub(1280);
    const { container } = render(
      <CalendarGrid tasks={[]} weekMonday={WEEK_MONDAY} timeZone="UTC" />,
    );
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    expect(grid).not.toBeNull();
    // Default desktop layout: 5 weekday columns with the historical
    // 72px hour column + 120px day-min that the desktop baseline relies
    // on for legibility.
    expect(grid.style.gridTemplateColumns).toBe(
      '72px repeat(5, minmax(120px, 1fr))',
    );
  });

  it('caps the wrapper width to its parent so horizontal scroll stays contained', () => {
    restoreMatchMedia = installMatchMediaStub(375);
    const { container } = render(
      <CalendarGrid
        tasks={[]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={3}
      />,
    );
    const wrapper = container.querySelector(
      '[data-calendar-grid="true"]',
    ) as HTMLElement;
    expect(wrapper).not.toBeNull();
    // `max-w-full` + `overflow-x-auto` keep horizontal scroll inside the
    // wrapper rather than letting the grid push the page sideways.
    expect(wrapper.className).toMatch(/\bmax-w-full\b/);
    expect(wrapper.className).toMatch(/\boverflow-x-auto\b/);
  });
});

describe('CalendarGrid — task chip fits inside narrow cells (Sub-AC 2.2)', () => {
  let restoreMatchMedia: (() => void) | null = null;
  beforeEach(() => {
    restoreMatchMedia = installMatchMediaStub(375);
  });
  afterEach(() => {
    restoreMatchMedia?.();
    restoreMatchMedia = null;
  });

  it('label flexes to fill remaining chip width and shrinks below content', () => {
    const longTitle = makeScheduledTask({
      id: 'task-long',
      title: 'A really long task title that would otherwise blow out the chip',
      runAt: '2026-04-20T09:30:00.000Z',
      slot: { dayKey: 'mon', dayOffset: 0, hour: 9, minute: 30 },
    });
    const { container } = render(
      <CalendarGrid
        tasks={[longTitle]}
        weekMonday={WEEK_MONDAY}
        timeZone="UTC"
        daysToShow={3}
      />,
    );
    const chip = container.querySelector('[data-task-id="task-long"]');
    expect(chip).not.toBeNull();
    // The label span carries `min-w-0 flex-1` so flex's default
    // `min-width: auto` doesn't force the chip wider than the cell.
    const labelSpan = chip!.querySelector('span.line-clamp-2');
    expect(labelSpan).not.toBeNull();
    expect(labelSpan!.className).toMatch(/\bmin-w-0\b/);
    expect(labelSpan!.className).toMatch(/\bflex-1\b/);
    // The icon span stays `shrink-0` so it never disappears, and the
    // minute badge keeps its existing `shrink-0` recipe (asserted via
    // the data-task-minute attribute below).
    const iconSpan = chip!.querySelector('span.font-mono.shrink-0');
    expect(iconSpan).not.toBeNull();
    expect(chip).toHaveAttribute('data-task-minute', '30');
  });
});
