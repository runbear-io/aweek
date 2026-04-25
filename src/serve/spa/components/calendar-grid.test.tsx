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
import { afterEach, describe, expect, it } from 'vitest';
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
