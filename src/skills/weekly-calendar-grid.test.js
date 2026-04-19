/**
 * Tests for weekly-calendar-grid — focused on runAt-aware task placement.
 *
 * Covers:
 *   - Tasks without runAt keep their pack/spread placement (regression guard).
 *   - Tasks with runAt land at the exact day/hour derived from the timestamp.
 *   - Runaway placements (runAt outside the visible window, collision with
 *     another runAt, malformed value) fall back gracefully without breaking
 *     the grid.
 *
 * We exercise `distributeTasks` directly rather than `renderGrid` — the
 * text rendering is a separate concern and the placement map is the
 * contract the heartbeat selector / UI both read.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { distributeTasks, mondayFromISOWeek } from './weekly-calendar-grid.js';

// Monday of ISO 2026-W17 is 2026-04-20 (UTC)
const WEEK_MONDAY = mondayFromISOWeek('2026-W17');

function task(id, overrides = {}) {
  return {
    id: `task-${id}`,
    description: overrides.description || `Task ${id}`,
    objectiveId: 'obj-xyz',
    priority: overrides.priority || 'medium',
    status: overrides.status || 'pending',
    ...overrides,
  };
}

describe('distributeTasks — no runAt (regression)', () => {
  it('packs tasks sequentially in Monday starting at startHour', () => {
    const grid = distributeTasks(
      [task('a'), task('b'), task('c')],
      { startHour: 9, endHour: 18, daysCount: 5, weekMonday: WEEK_MONDAY },
    );

    const mon = grid.get('mon');
    assert.equal(mon.get(9).task.id, 'task-a');
    assert.equal(mon.get(10).task.id, 'task-b');
    assert.equal(mon.get(11).task.id, 'task-c');
  });

  it("round-robins across days in 'spread' mode", () => {
    const grid = distributeTasks(
      [task('a'), task('b'), task('c')],
      {
        startHour: 9,
        endHour: 18,
        daysCount: 5,
        spread: 'spread',
        weekMonday: WEEK_MONDAY,
      },
    );
    assert.equal(grid.get('mon').get(9).task.id, 'task-a');
    assert.equal(grid.get('tue').get(9).task.id, 'task-b');
    assert.equal(grid.get('wed').get(9).task.id, 'task-c');
  });
});

describe('distributeTasks — runAt placement', () => {
  it('places a runAt task at the matching day + hour', () => {
    // Monday 2026-04-20 @ 10:00 UTC → mon row, hour 10
    const t = task('a', { runAt: '2026-04-20T10:00:00Z' });
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });

    assert.equal(grid.get('mon').get(10)?.task.id, 'task-a');
    // Does not claim adjacent hours (spanHours defaults to 1)
    assert.equal(grid.get('mon').get(9), undefined);
    assert.equal(grid.get('mon').get(11), undefined);
  });

  it('places 10 runAt tasks one hour apart across the working day', () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task(`${i + 1}`, {
        description: `Publish X.com post ${i + 1}/10`,
        runAt: `2026-04-20T${String(9 + i).padStart(2, '0')}:00:00Z`,
      }),
    );

    const grid = distributeTasks(tasks, {
      startHour: 9,
      endHour: 19,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });

    const mon = grid.get('mon');
    for (let i = 0; i < 10; i++) {
      assert.equal(
        mon.get(9 + i)?.task.id,
        `task-${i + 1}`,
        `expected hour ${9 + i} to hold task-${i + 1}`,
      );
    }
    // Tuesday and beyond should be empty.
    assert.equal(grid.get('tue').size, 0);
  });

  it('places a runAt task on Wednesday when the timestamp points there', () => {
    const t = task('a', { runAt: '2026-04-22T14:00:00Z' }); // Wed 14:00
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });

    assert.equal(grid.get('wed').get(14)?.task.id, 'task-a');
    // Mon and Tue untouched.
    assert.equal(grid.get('mon').size, 0);
    assert.equal(grid.get('tue').size, 0);
  });

  it('reserves the runAt slot even when unscheduled tasks also need Monday', () => {
    const scheduled = task('at-11', { runAt: '2026-04-20T11:00:00Z' });
    const unscheduled = [task('a'), task('b'), task('c')];

    const grid = distributeTasks([scheduled, ...unscheduled], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });

    const mon = grid.get('mon');
    // scheduled task stays put
    assert.equal(mon.get(11).task.id, 'task-at-11');
    // unscheduled tasks pack around it — 9, 10, then skip 11, resume 12
    assert.equal(mon.get(9).task.id, 'task-a');
    assert.equal(mon.get(10).task.id, 'task-b');
    assert.equal(mon.get(12).task.id, 'task-c');
  });

  it('falls through to pack/spread when runAt is outside the visible window', () => {
    // The calendar only shows 09:00–18:00. A 06:00 runAt can't be honored
    // in the grid, so the task still gets placed via pack (it's still on
    // the plan and the user needs to see it somewhere). The heartbeat
    // selector is what enforces `runAt > now` at execution time.
    const tooEarly = task('early', { runAt: '2026-04-20T06:00:00Z' });
    const tooLate = task('late', { runAt: '2026-04-20T22:00:00Z' });

    const grid = distributeTasks([tooEarly, tooLate], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });

    assert.equal(grid.get('mon').get(9).task.id, 'task-early');
    assert.equal(grid.get('mon').get(10).task.id, 'task-late');
  });

  it('falls through to pack/spread when runAt is outside the plan week', () => {
    const nextWeek = task('later', { runAt: '2026-04-28T10:00:00Z' });
    const grid = distributeTasks([nextWeek], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });
    // Same rationale: the calendar is a UI; the selector enforces timing.
    assert.equal(grid.get('mon').get(9).task.id, 'task-later');
  });

  it('ignores a malformed runAt (task falls through to pack/spread)', () => {
    const t = task('broken', { runAt: 'not-a-date' });
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });
    // Placed in the usual Monday/startHour slot because no runAt was honored.
    assert.equal(grid.get('mon').get(9)?.task.id, 'task-broken');
  });

  it('when two runAt tasks collide, first-declared wins', () => {
    const first = task('first', { runAt: '2026-04-20T10:00:00Z' });
    const second = task('second', { runAt: '2026-04-20T10:00:00Z' });

    const grid = distributeTasks([first, second], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });

    // `first` owns the 10:00 slot; `second` falls through to pack/spread.
    assert.equal(grid.get('mon').get(10).task.id, 'task-first');
    // `second` lands in the next available slot (09:00).
    assert.equal(grid.get('mon').get(9).task.id, 'task-second');
  });

  it('falls through to pack/spread when weekMonday is not provided', () => {
    // Without weekMonday, the grid has no way to anchor the runAt — tasks
    // should still render, just without honoring their declared slot.
    const t = task('a', { runAt: '2026-04-20T15:00:00Z' });
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
    });
    assert.equal(grid.get('mon').get(9).task.id, 'task-a');
  });
});
