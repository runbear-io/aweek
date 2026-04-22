/**
 * Tests for weekly-calendar-grid — focused on runAt-aware placement.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCellWidth,
  distributeTasks,
  mondayFromISOWeek,
  renderGrid,
  REVIEW_SLOT_ICON,
  REVIEW_DISPLAY_NAMES,
} from './weekly-calendar-grid.js';
import {
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';

// Monday of ISO 2026-W17 is 2026-04-20 (UTC)
const WEEK_MONDAY = mondayFromISOWeek('2026-W17');

function task(id, overrides = {}) {
  const { description, title, prompt, ...rest } = overrides;
  const label = title || prompt || description || `Task ${id}`;
  return {
    id: `task-${id}`,
    title: title || label,
    prompt: prompt || label,
    objectiveId: 'obj-xyz',
    priority: rest.priority || 'medium',
    status: rest.status || 'pending',
    ...rest,
  };
}

describe('distributeTasks — no runAt (regression guard)', () => {
  it('packs tasks sequentially in Monday starting at startHour', () => {
    const grid = distributeTasks(
      [task('a'), task('b'), task('c')],
      { startHour: 9, endHour: 18, daysCount: 5, weekMonday: WEEK_MONDAY },
    );
    const mon = grid.get('mon');
    assert.equal(mon.get(9)[0].task.id, 'task-a');
    assert.equal(mon.get(10)[0].task.id, 'task-b');
    assert.equal(mon.get(11)[0].task.id, 'task-c');
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
    assert.equal(grid.get('mon').get(9)[0].task.id, 'task-a');
    assert.equal(grid.get('tue').get(9)[0].task.id, 'task-b');
    assert.equal(grid.get('wed').get(9)[0].task.id, 'task-c');
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
    assert.equal(grid.get('mon').get(10)?.[0].task.id, 'task-a');
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
      assert.equal(mon.get(9 + i)?.[0].task.id, `task-${i + 1}`);
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
    assert.equal(grid.get('wed').get(14)?.[0].task.id, 'task-a');
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
    assert.equal(mon.get(11)[0].task.id, 'task-at-11');
    assert.equal(mon.get(9)[0].task.id, 'task-a');
    assert.equal(mon.get(10)[0].task.id, 'task-b');
    assert.equal(mon.get(12)[0].task.id, 'task-c');
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
    assert.equal(grid.get('mon').get(9)[0].task.id, 'task-early');
    assert.equal(grid.get('mon').get(10)[0].task.id, 'task-late');
  });

  it('stacks colliding runAt tasks in the same bucket instead of dropping the later one', () => {
    const first = task('first', { runAt: '2026-04-20T10:00:00Z' });
    const second = task('second', { runAt: '2026-04-20T10:30:00Z' });
    const grid = distributeTasks([first, second], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: WEEK_MONDAY,
    });
    const bucket = grid.get('mon').get(10);
    assert.equal(bucket.length, 2, 'both tasks should be in bucket 10');
    assert.equal(bucket[0].task.id, 'task-first');
    assert.equal(bucket[1].task.id, 'task-second');
    assert.equal(grid.get('mon').get(9), undefined);
  });

  it('falls through when weekMonday is omitted', () => {
    const t = task('a', { runAt: '2026-04-20T15:00:00Z' });
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
    });
    assert.equal(grid.get('mon').get(9)[0].task.id, 'task-a');
  });
});

describe('computeCellWidth', () => {
  it('fits the grid within the terminal width for 5-day weeks', () => {
    const daysCount = 5;
    const termWidth = 120;
    const cellWidth = computeCellWidth(termWidth, daysCount);
    const hourWidth = 7;
    const totalWidth = hourWidth + (cellWidth + 1) * daysCount + 1;
    assert.ok(totalWidth <= termWidth, `totalWidth ${totalWidth} > termWidth ${termWidth}`);
  });

  it('fits the grid within the terminal width for 7-day weeks', () => {
    const daysCount = 7;
    const termWidth = 140;
    const cellWidth = computeCellWidth(termWidth, daysCount);
    const hourWidth = 7;
    const totalWidth = hourWidth + (cellWidth + 1) * daysCount + 1;
    assert.ok(totalWidth <= termWidth, `totalWidth ${totalWidth} > termWidth ${termWidth}`);
  });

  it('clamps to minCellWidth on very narrow terminals', () => {
    assert.equal(computeCellWidth(40, 5), 12);
  });

  it('clamps to maxCellWidth on very wide terminals', () => {
    assert.equal(computeCellWidth(500, 5), 32);
  });

  it('falls back to a sensible default when terminalWidth is not a number', () => {
    const cell = computeCellWidth(undefined, 5);
    assert.ok(cell >= 12 && cell <= 32);
  });
});

describe('renderGrid — terminal-width autofit', () => {
  const baseAgent = { id: 'a1', identity: { name: 'Agent One' } };
  const basePlan = {
    week: '2026-W17',
    approved: true,
    tasks: [
      { id: 't1', title: 'Task one', prompt: 'Task one', status: 'pending' },
    ],
  };

  it('keeps every rendered line within terminalWidth when cellWidth is not set', () => {
    const termWidth = 100;
    const { text } = renderGrid({
      agent: baseAgent,
      plan: basePlan,
      opts: { terminalWidth: termWidth },
    });
    for (const line of text.split('\n')) {
      assert.ok(
        line.length <= termWidth,
        `line length ${line.length} > ${termWidth}: ${JSON.stringify(line)}`,
      );
    }
  });

  it('honors an explicit cellWidth over terminalWidth', () => {
    const { text } = renderGrid({
      agent: baseAgent,
      plan: basePlan,
      opts: { terminalWidth: 200, cellWidth: 15 },
    });
    // With cellWidth=15, daysCount=5, hourWidth=7, totalWidth = 7 + 16*5 + 1 = 88
    const headerBorder = text.split('\n').find((l) => l.startsWith('┌'));
    assert.equal(headerBorder.length, 88);
  });
});

describe('renderGrid — column-major numbering', () => {
  it('numbers Monday 9..N first, then continues on Tuesday', () => {
    // Mon 9 + Mon 10 in pack mode, then tue 9 via runAt
    const tasks = [
      { id: 'mon-09', title: 'Mon morning', prompt: 'Mon morning', status: 'pending' },
      { id: 'mon-10', title: 'Mon late-morning', prompt: 'Mon late-morning', status: 'pending' },
      {
        id: 'tue-09',
        title: 'Tue morning', prompt: 'Tue morning',
        status: 'pending',
        runAt: '2026-04-21T09:00:00Z',
      },
    ];
    const { taskIndex } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: { week: '2026-W17', approved: true, tasks },
      opts: { cellWidth: 30 },
    });
    assert.equal(taskIndex[0].id, 'mon-09');
    assert.equal(taskIndex[1].id, 'mon-10');
    assert.equal(taskIndex[2].id, 'tue-09');
  });
});

describe('renderGrid — variable-height hourly summary', () => {
  it('caps long descriptions at the content max and ends with an ellipsis', () => {
    const longDesc = 'Research keyword variations and outline the next blog post with examples';
    const { text } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: {
        week: '2026-W17',
        approved: true,
        tasks: [{ id: 't1', title: longDesc, prompt: longDesc, status: 'pending' }],
      },
      opts: { cellWidth: 20 },
    });
    // The truncated task should end in `…` somewhere in the output.
    assert.ok(text.includes('…'), 'expected an ellipsis marker for the truncated task');
    // Legacy word-wrap markers must stay gone.
    assert.ok(!text.includes('│ Res'), 'should not word-wrap with │ prefix');
    assert.ok(!/○ 1\.[^\s]+-$/m.test(text), 'should not break words with a hyphen');
  });

  it('repeats the summary on each hour a multi-hour task occupies', () => {
    const { text } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: {
        week: '2026-W17',
        approved: true,
        tasks: [
          {
            id: 't1',
            title: 'Deep work block', prompt: 'Deep work block',
            status: 'pending',
            estimatedMinutes: 180,
          },
        ],
      },
      opts: { cellWidth: 24 },
    });
    // Only the first line of each hour starts with `│HH:00` — the second
    // and third lines start with a blank hour column.
    const startLines = text.split('\n').filter((l) => /^│\d{2}:00/.test(l));
    assert.ok(startLines[0].includes('○ 1. Deep work block'), startLines[0]);
    assert.ok(startLines[1].includes('○ 1. Deep work block'), startLines[1]);
    assert.ok(startLines[2].includes('○ 1. Deep work block'), startLines[2]);
    assert.ok(!startLines[3].includes('○ 1.'), startLines[3]);
  });

  it('emits exactly one line per empty hour', () => {
    const { text } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: {
        week: '2026-W17',
        approved: true,
        tasks: [],
      },
      opts: { cellWidth: 20, startHour: 9, endHour: 12 },
    });
    const hourSection = text.split('\n');
    const start = hourSection.findIndex((l) => /Hour/.test(l));
    const bottom = hourSection.findIndex((l) => l.startsWith('└'));
    // Hours 9,10,11 → 3 hours × 1 line each = 3 rows.
    const hourRows = bottom - (start + 2);
    assert.equal(hourRows, 3);
  });
});

describe('distributeTasks — DST-week placement stays correct in local tz', () => {
  it('places Sunday task on day 6 of 2026-W10 in LA (DST spring-forward week)', () => {
    const mon = mondayFromISOWeek('2026-W10', 'America/Los_Angeles');
    // Sunday 2026-03-08 16:00 PDT (post-jump) = 23:00 UTC.
    const tasks = [
      {
        id: 't1',
        title: 'Post-DST Sunday', prompt: 'Post-DST Sunday',
        status: 'pending',
        runAt: '2026-03-08T23:00:00Z',
      },
    ];
    const grid = distributeTasks(tasks, {
      startHour: 9,
      endHour: 18,
      daysCount: 7,
      weekMonday: mon,
      tz: 'America/Los_Angeles',
    });
    // Sun 16:00 PDT → column 6 ("sun"), hour 16.
    assert.equal(grid.get('sun').get(16)?.[0]?.task.id, 't1');
  });
});

describe('distributeTasks / renderGrid — time-zone-aware placement', () => {
  it('places a 17:00-UTC task on Monday 10:00 when tz=America/Los_Angeles', () => {
    // 2026-04-20 17:00Z = 10:00 PDT Monday.
    const tasks = [
      {
        id: 't1',
        title: 'LA 10am', prompt: 'LA 10am',
        status: 'pending',
        runAt: '2026-04-20T17:00:00Z',
      },
    ];
    const monday = mondayFromISOWeek('2026-W17', 'America/Los_Angeles');
    const grid = distributeTasks(tasks, {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: monday,
      tz: 'America/Los_Angeles',
    });
    assert.equal(grid.get('mon').get(10)?.[0]?.task.id, 't1');
    // Not at the UTC hour (17).
    assert.equal(grid.get('mon').get(17), undefined);
  });

  it('surfaces the effective time zone in the header status line', () => {
    const { text: laText } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: { week: '2026-W17', approved: true, tasks: [] },
      opts: { tz: 'America/Los_Angeles' },
    });
    assert.match(laText, /TZ: America\/Los_Angeles/);

    const { text: utcText } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: { week: '2026-W17', approved: true, tasks: [] },
    });
    assert.match(utcText, /TZ: UTC/);
  });

  it("renders date labels using the zone's Monday when tz is supplied", () => {
    // 2026-W17 Monday in LA is 2026-04-20. Render Mon label "4/20".
    const { text } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: { week: '2026-W17', approved: true, tasks: [] },
      opts: { tz: 'America/Los_Angeles', cellWidth: 14 },
    });
    const header = text.split('\n').find((l) => l.includes('Hour'));
    assert.ok(header.includes('Mon 4/20'), header);
  });
});

describe('renderGrid — stacked buckets (HH:00 + HH:30)', () => {
  it('shows tasks at :00 and :30 of the same hour in the same cell', () => {
    const { text } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: {
        week: '2026-W17',
        approved: true,
        tasks: [
          { id: 't-00', title: 'Reply A', prompt: 'Reply A', status: 'pending', runAt: '2026-04-20T13:00:00Z' },
          { id: 't-30', title: 'Reply B', prompt: 'Reply B', status: 'pending', runAt: '2026-04-20T13:30:00Z' },
        ],
      },
      opts: { cellWidth: 20 },
    });
    // Both should appear in the grid output.
    assert.ok(text.includes('Reply A'), 'missing Reply A in output');
    assert.ok(text.includes('Reply B'), 'missing Reply B in output');
  });

  it('renders every task on its own line when many share the same hour', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      title: `Reply ${i}`,
      prompt: `Reply ${i}`,
      status: 'pending',
      runAt: `2026-04-20T13:${String(i * 10).padStart(2, '0')}:00Z`,
    }));
    const { text } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: { week: '2026-W17', approved: true, tasks },
      opts: { cellWidth: 20 },
    });
    // All five tasks must be visible — no overflow collapse.
    for (let i = 0; i < 5; i++) {
      assert.ok(text.includes(`Reply ${i}`), `missing Reply ${i} in output`);
    }
    // No legacy overflow marker remains.
    assert.ok(!/…\+\d+ more/.test(text), 'should not emit "…+N more" marker');
    // Numbered list under the grid still counts every task.
    const selectLine = text.split('\n').find((l) => l.startsWith('Select a task'));
    assert.match(selectLine, /1-5/);
  });

  it('caps a task at the TASK_CONTENT_MAX (40) visible chars and wraps across cell lines', () => {
    const veryLong = 'A'.repeat(200);
    const { text } = renderGrid({
      agent: { id: 'a', identity: { name: 'A' } },
      plan: {
        week: '2026-W17',
        approved: true,
        tasks: [{ id: 't1', title: veryLong, prompt: veryLong, status: 'pending' }],
      },
      opts: { cellWidth: 10, terminalWidth: 120 },
    });
    // Recover the Mon (first day) cell contents from each 09:xx line.
    const hourLines = text
      .split('\n')
      .filter((l) => l.startsWith('│09:00') || l.startsWith('│       '))
      .slice(0, 4);
    const monCells = hourLines.map((l) => l.split('│')[2] ?? '');
    const joined = monCells.map((c) => c.trimEnd()).join('');
    assert.ok(joined.length <= 40, `expected ≤40 visible chars, got ${joined.length}: ${JSON.stringify(joined)}`);
    assert.ok(joined.endsWith('…'), joined);
    assert.ok(joined.startsWith('○ 1. '), joined);
  });
});

describe('renderGrid — advisor-mode review slot rendering', () => {
  const agent = { id: 'a', identity: { name: 'Advisor' } };

  // 2026-W17 Monday = 2026-04-20 (UTC). Friday = 2026-04-24.
  const dailyReviewTask = {
    id: 'task-daily-mon',
    title: 'End-of-day reflection', prompt: 'End-of-day reflection',
    objectiveId: DAILY_REVIEW_OBJECTIVE_ID,
    status: 'pending',
    runAt: '2026-04-20T17:00:00Z', // Mon 17:00 UTC
  };
  const weeklyReviewTask = {
    id: 'task-weekly-fri',
    title: 'End-of-week review', prompt: 'End-of-week review',
    objectiveId: WEEKLY_REVIEW_OBJECTIVE_ID,
    status: 'pending',
    runAt: '2026-04-24T18:00:00Z', // Fri 18:00 UTC — outside 9-18 window, falls through to pack
  };
  const workTask = {
    id: 'task-work-1',
    title: 'Write quarterly report', prompt: 'Write quarterly report',
    objectiveId: 'obj-abc',
    status: 'pending',
    runAt: '2026-04-20T09:00:00Z', // Mon 09:00
  };

  it('renders daily-review slot with ◆ icon and a selection number, selectable like a work task', () => {
    // workTask → Mon 09:00 (num 1), dailyReviewTask → Mon 17:00 (num 2).
    const { text, taskIndex } = renderGrid({
      agent,
      plan: { week: '2026-W17', approved: true, tasks: [dailyReviewTask, workTask] },
      opts: { cellWidth: 20, startHour: 9, endHour: 18 },
    });

    // The ◆ icon must appear in the grid output.
    assert.ok(text.includes(REVIEW_SLOT_ICON), 'expected ◆ icon in grid output');
    // The daily-review task MUST appear in the numbered taskIndex — identical to a work task.
    assert.ok(
      taskIndex.some((t) => t.id === dailyReviewTask.id),
      'daily-review task should appear in numbered taskIndex',
    );
    // Work task should also be numbered.
    assert.ok(
      taskIndex.some((t) => t.id === workTask.id),
      'work task should appear in numbered taskIndex',
    );
    // Both tasks have numbers: workTask is #1 (Mon 9:00), dailyReview is #2 (Mon 17:00).
    assert.equal(taskIndex.length, 2, 'taskIndex should contain both work task and review slot');
    // The daily review entry shows its selection number (◆ 2.) in the grid.
    const reviewNum = taskIndex.findIndex((t) => t.id === dailyReviewTask.id) + 1;
    assert.ok(
      text.includes(`${REVIEW_SLOT_ICON} ${reviewNum}.`),
      `expected ${REVIEW_SLOT_ICON} ${reviewNum}. in grid output`,
    );
    // The display name still appears alongside the number.
    assert.ok(
      text.includes(REVIEW_DISPLAY_NAMES[DAILY_REVIEW_OBJECTIVE_ID]),
      'expected Daily Review display name in grid output',
    );
  });

  it('renders weekly-review slot with ◆ icon and a selection number, included in taskIndex', () => {
    // weeklyReviewTask runAt Fri 18:00 UTC — outside 9-18 window, pack places it at Mon 9:00 → num 1.
    const { text, taskIndex } = renderGrid({
      agent,
      plan: { week: '2026-W17', approved: true, tasks: [weeklyReviewTask] },
      opts: { cellWidth: 20, startHour: 9, endHour: 18 },
    });

    assert.ok(text.includes(REVIEW_SLOT_ICON), 'expected ◆ icon in grid output');
    // Review slot MUST appear in taskIndex with a number.
    assert.equal(taskIndex.length, 1, 'taskIndex should have exactly one entry (the weekly review task)');
    assert.equal(taskIndex[0].id, weeklyReviewTask.id, 'taskIndex[0] should be the weekly review task');
    // The weekly review entry shows its selection number (◆ 1.) in the grid.
    assert.ok(text.includes(`${REVIEW_SLOT_ICON} 1.`), 'expected ◆ 1. in grid output');
    // The display name still appears alongside the number.
    assert.ok(
      text.includes(REVIEW_DISPLAY_NAMES[WEEKLY_REVIEW_OBJECTIVE_ID]),
      'expected Weekly Review display name in grid output',
    );
  });

  it('shows Tasks and Reviews counts separately in the status line', () => {
    const { text } = renderGrid({
      agent,
      plan: {
        week: '2026-W17',
        approved: true,
        tasks: [workTask, dailyReviewTask, weeklyReviewTask],
      },
      opts: { cellWidth: 20 },
    });

    // 1 work task, 2 review slots.
    assert.match(text, /Tasks: 1/, 'expected "Tasks: 1" in status line');
    assert.match(text, /Reviews: 2/, 'expected "Reviews: 2" in status line');
  });

  it('omits the Reviews counter from the status line when there are no review slots', () => {
    const { text } = renderGrid({
      agent,
      plan: { week: '2026-W17', approved: true, tasks: [workTask] },
      opts: { cellWidth: 20 },
    });

    assert.match(text, /Tasks: 1/, 'expected "Tasks: 1" in status line');
    assert.ok(!text.includes('Reviews:'), 'should not include "Reviews:" when no review tasks');
  });

  it('includes ◆ review slot in the legend', () => {
    const { text } = renderGrid({
      agent,
      plan: { week: '2026-W17', approved: true, tasks: [] },
      opts: { cellWidth: 20 },
    });

    assert.ok(text.includes('◆ review slot'), 'expected "◆ review slot" in legend');
  });

  it('places daily-review in the correct day column via runAt', () => {
    // Mon 17:00 UTC → day 0 (mon), hour 17 — outside the 9-18 window so pack picks it up.
    // Use startHour:9, endHour:18, so hour 17 IS inside the window (9 <= 17 < 18).
    const t = {
      id: 'task-dr',
      title: 'Daily reflection', prompt: 'Daily reflection',
      objectiveId: DAILY_REVIEW_OBJECTIVE_ID,
      status: 'pending',
      runAt: '2026-04-20T17:00:00Z', // Mon 17:00 UTC
    };
    const grid = distributeTasks([t], {
      startHour: 9,
      endHour: 18,
      daysCount: 5,
      weekMonday: mondayFromISOWeek('2026-W17'),
    });
    // Must land in mon column at hour 17.
    const bucket = grid.get('mon').get(17);
    assert.ok(bucket && bucket.length > 0, 'expected entry in mon@17');
    assert.equal(bucket[0].task.id, 'task-dr');
  });

  it('REVIEW_DISPLAY_NAMES covers both reserved objectiveIds', () => {
    assert.equal(REVIEW_DISPLAY_NAMES[DAILY_REVIEW_OBJECTIVE_ID], 'Daily Review');
    assert.equal(REVIEW_DISPLAY_NAMES[WEEKLY_REVIEW_OBJECTIVE_ID], 'Weekly Review');
  });
});
