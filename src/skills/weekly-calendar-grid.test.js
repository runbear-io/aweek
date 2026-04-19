/**
 * Tests for weekly-calendar-grid — focused on runAt-aware placement.
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

describe('distributeTasks — no runAt (regression guard)', () => {
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
  it('places a runAt task at the derived day + hour', () => {
    const t = task('a', { runAt: '2026-04-20T10:00:00Z' });
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });
    assert.equal(grid.get('mon').get(10)?.task.id, 'task-a');
    assert.equal(grid.get('mon').get(9), undefined);
    assert.equal(grid.get('mon').get(11), undefined);
  });

  it('places one task per hour across a working day when runAt is hourly-spaced', () => {
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
      assert.equal(mon.get(9 + i)?.task.id, `task-${i + 1}`);
    }
    assert.equal(grid.get('tue').size, 0);
  });

  it('places a Wednesday runAt on the wed column', () => {
    const t = task('a', { runAt: '2026-04-22T14:00:00Z' });
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });
    assert.equal(grid.get('wed').get(14)?.task.id, 'task-a');
    assert.equal(grid.get('mon').size, 0);
  });

  it('reserves the runAt cell so unscheduled tasks pack around it', () => {
    const scheduled = task('at-11', { runAt: '2026-04-20T11:00:00Z' });
    const unscheduled = [task('a'), task('b'), task('c')];
    const grid = distributeTasks([scheduled, ...unscheduled], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });
    const mon = grid.get('mon');
    assert.equal(mon.get(11).task.id, 'task-at-11');
    assert.equal(mon.get(9).task.id, 'task-a');
    assert.equal(mon.get(10).task.id, 'task-b');
    assert.equal(mon.get(12).task.id, 'task-c');
  });

  it('falls through to pack when runAt is outside the visible window', () => {
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

  it('first-declared runAt wins on collision', () => {
    const first = task('first', { runAt: '2026-04-20T10:00:00Z' });
    const second = task('second', { runAt: '2026-04-20T10:00:00Z' });
    const grid = distributeTasks([first, second], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });
    assert.equal(grid.get('mon').get(10).task.id, 'task-first');
    assert.equal(grid.get('mon').get(9).task.id, 'task-second');
  });

  it('falls through when weekMonday is omitted', () => {
    const t = task('a', { runAt: '2026-04-20T15:00:00Z' });
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
    });
    assert.equal(grid.get('mon').get(9).task.id, 'task-a');
  });
});
