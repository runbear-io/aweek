import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusIcon,
  truncate,
  padTo,
  formatRateBar,
  formatDurationShort,
  renderDayCell,
  horizontalRule,
  renderCalendarHeader,
  renderWeeklySummary,
  renderWeeklyCalendar,
  renderCompactCalendar,
} from './weekly-calendar-renderer.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeDayComparison(overrides = {}) {
  return {
    date: '2026-04-13',
    day: 'mon',
    planned: { tasks: [], count: 0, statusCounts: {} },
    actual: {
      entries: [],
      count: 0,
      statusCounts: {},
      completedCount: 0,
      failedCount: 0,
      totalDurationMs: 0,
    },
    ...overrides,
  };
}

function makeWeeklyData(overrides = {}) {
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(
    (day, i) => {
      const date = `2026-04-${String(13 + i).padStart(2, '0')}`;
      return makeDayComparison({ date, day });
    }
  );

  return {
    agentId: 'agent-test',
    week: '2026-W16',
    weekMonday: '2026-04-13',
    planExists: true,
    planApproved: true,
    days,
    unscheduledTasks: [],
    summary: {
      planned: {
        total: 0,
        completed: 0,
        failed: 0,
        pending: 0,
        inProgress: 0,
        skipped: 0,
        delegated: 0,
        completionRate: 0,
      },
      actual: {
        totalEntries: 0,
        completed: 0,
        failed: 0,
        totalDurationMs: 0,
      },
    },
    ...overrides,
  };
}

// ─── statusIcon ─────────────────────────────────────────────────────

describe('statusIcon', () => {
  it('returns ✓ for completed', () => {
    assert.equal(statusIcon('completed'), '✓');
  });

  it('returns ✗ for failed', () => {
    assert.equal(statusIcon('failed'), '✗');
  });

  it('returns ○ for pending', () => {
    assert.equal(statusIcon('pending'), '○');
  });

  it('returns ► for in-progress', () => {
    assert.equal(statusIcon('in-progress'), '►');
  });

  it('returns ⊘ for skipped', () => {
    assert.equal(statusIcon('skipped'), '⊘');
  });

  it('returns → for delegated', () => {
    assert.equal(statusIcon('delegated'), '→');
  });

  it('returns ? for unknown status', () => {
    assert.equal(statusIcon('banana'), '?');
  });

  it('returns ? for undefined', () => {
    assert.equal(statusIcon(undefined), '?');
  });
});

// ─── truncate ───────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns string unchanged if within limit', () => {
    assert.equal(truncate('hello', 10), 'hello');
  });

  it('truncates and adds ellipsis when over limit', () => {
    assert.equal(truncate('hello world', 8), 'hello w…');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(truncate(null, 10), '');
    assert.equal(truncate(undefined, 10), '');
  });

  it('returns exact length string unchanged', () => {
    assert.equal(truncate('abcde', 5), 'abcde');
  });
});

// ─── padTo ──────────────────────────────────────────────────────────

describe('padTo', () => {
  it('pads left-aligned by default', () => {
    assert.equal(padTo('hi', 5), 'hi   ');
  });

  it('pads right-aligned', () => {
    assert.equal(padTo('hi', 5, 'right'), '   hi');
  });

  it('pads center-aligned', () => {
    const result = padTo('hi', 6, 'center');
    assert.equal(result, '  hi  ');
  });

  it('truncates if string exceeds width', () => {
    assert.equal(padTo('hello world', 5), 'hello');
  });

  it('returns exact width string unchanged', () => {
    assert.equal(padTo('abc', 3), 'abc');
  });

  it('converts non-string to string', () => {
    assert.equal(padTo(42, 5), '42   ');
  });
});

// ─── formatRateBar ──────────────────────────────────────────────────

describe('formatRateBar', () => {
  it('renders full bar for 100%', () => {
    const result = formatRateBar(100, 10);
    assert.ok(result.includes('██████████'));
    assert.ok(result.includes('100%'));
  });

  it('renders empty bar for 0%', () => {
    const result = formatRateBar(0, 10);
    assert.ok(result.includes('░░░░░░░░░░'));
    assert.ok(result.includes('0%'));
  });

  it('renders half bar for 50%', () => {
    const result = formatRateBar(50, 10);
    assert.ok(result.includes('█████░░░░░'));
    assert.ok(result.includes('50%'));
  });

  it('renders dash for null rate', () => {
    const result = formatRateBar(null, 10);
    assert.ok(result.includes('—'));
  });

  it('renders dash for undefined rate', () => {
    const result = formatRateBar(undefined, 10);
    assert.ok(result.includes('—'));
  });
});

// ─── formatDurationShort ────────────────────────────────────────────

describe('formatDurationShort', () => {
  it('returns 0s for zero', () => {
    assert.equal(formatDurationShort(0), '0s');
  });

  it('returns seconds for sub-minute', () => {
    assert.equal(formatDurationShort(45000), '45s');
  });

  it('returns minutes and seconds', () => {
    assert.equal(formatDurationShort(90000), '1m30s');
  });

  it('returns minutes only when no remainder', () => {
    assert.equal(formatDurationShort(120000), '2m');
  });

  it('returns hours and minutes', () => {
    assert.equal(formatDurationShort(3900000), '1h5m');
  });

  it('returns hours only when no remainder', () => {
    assert.equal(formatDurationShort(7200000), '2h');
  });

  it('returns 0s for null/undefined', () => {
    assert.equal(formatDurationShort(null), '0s');
    assert.equal(formatDurationShort(undefined), '0s');
  });

  it('returns 0s for negative', () => {
    assert.equal(formatDurationShort(-1000), '0s');
  });
});

// ─── renderDayCell ──────────────────────────────────────────────────

describe('renderDayCell', () => {
  it('renders a day with no activity', () => {
    const day = makeDayComparison();
    const lines = renderDayCell(day);
    const text = lines.join('\n');
    assert.ok(text.includes('Mon'));
    assert.ok(text.includes('2026-04-13'));
    assert.ok(text.includes('(no activity)'));
    assert.ok(text.includes('P:0 C:0 F:0'));
  });

  it('renders planned tasks with status icons', () => {
    const day = makeDayComparison({
      planned: {
        tasks: [
          { id: 'task-1', title: 'Write tests', prompt: 'Write tests', status: 'completed' },
          { id: 'task-2', title: 'Fix bug', prompt: 'Fix bug', status: 'failed' },
        ],
        count: 2,
        statusCounts: { completed: 1, failed: 1 },
      },
      actual: {
        entries: [],
        count: 2,
        statusCounts: { completed: 1, failed: 1 },
        completedCount: 1,
        failedCount: 1,
        totalDurationMs: 5000,
      },
    });
    const lines = renderDayCell(day);
    const text = lines.join('\n');
    assert.ok(text.includes('✓ Write tests'));
    assert.ok(text.includes('✗ Fix bug'));
    assert.ok(text.includes('P:2'));
  });

  it('limits displayed tasks with maxTasks option', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `task-${i}`,
      title: `Task ${i}`,
      status: 'completed',
    }));
    const day = makeDayComparison({
      planned: { tasks, count: 5, statusCounts: { completed: 5 } },
      actual: { entries: [], count: 0, statusCounts: {}, completedCount: 0, failedCount: 0, totalDurationMs: 0 },
    });
    const lines = renderDayCell(day, { maxTasks: 2 });
    const text = lines.join('\n');
    assert.ok(text.includes('+3 more'));
  });

  it('shows actual entries when no planned tasks exist', () => {
    const day = makeDayComparison({
      actual: {
        entries: [
          { status: 'completed', title: 'Auto task done', taskId: 'inbox-1' },
        ],
        count: 1,
        statusCounts: { completed: 1 },
        completedCount: 1,
        failedCount: 0,
        totalDurationMs: 3000,
      },
    });
    const lines = renderDayCell(day);
    const text = lines.join('\n');
    assert.ok(text.includes('✓ Auto task done'));
  });

  it('shows duration when available', () => {
    const day = makeDayComparison({
      actual: {
        entries: [],
        count: 1,
        statusCounts: {},
        completedCount: 1,
        failedCount: 0,
        totalDurationMs: 60000,
      },
    });
    const lines = renderDayCell(day);
    const text = lines.join('\n');
    assert.ok(text.includes('⏱ 1m'));
  });

  it('truncates long task descriptions', () => {
    const day = makeDayComparison({
      planned: {
        tasks: [
          { id: 't-1', title: 'A very long description that exceeds the cell width limit', prompt: 'A very long description that exceeds the cell width limit', status: 'pending' },
        ],
        count: 1,
        statusCounts: { pending: 1 },
      },
      actual: { entries: [], count: 0, statusCounts: {}, completedCount: 0, failedCount: 0, totalDurationMs: 0 },
    });
    const lines = renderDayCell(day, { cellWidth: 20 });
    const text = lines.join('\n');
    assert.ok(text.includes('…')); // truncated
  });

  it('respects cellWidth option', () => {
    const day = makeDayComparison();
    const lines = renderDayCell(day, { cellWidth: 40 });
    // Header should be padded to cellWidth
    assert.ok(lines[0].length >= 14); // "Mon 2026-04-13"
  });
});

// ─── horizontalRule ─────────────────────────────────────────────────

describe('horizontalRule', () => {
  it('creates rule of specified width', () => {
    assert.equal(horizontalRule(5), '─────');
  });

  it('uses custom character', () => {
    assert.equal(horizontalRule(3, '='), '===');
  });

  it('returns empty string for width 0', () => {
    assert.equal(horizontalRule(0), '');
  });
});

// ─── renderCalendarHeader ───────────────────────────────────────────

describe('renderCalendarHeader', () => {
  it('renders header with agent and week info', () => {
    const data = makeWeeklyData();
    const lines = renderCalendarHeader(data);
    const text = lines.join('\n');
    assert.ok(text.includes('agent-test'));
    assert.ok(text.includes('2026-W16'));
    assert.ok(text.includes('2026-04-13'));
    assert.ok(text.includes('2026-04-19')); // Sunday
  });

  it('shows plan approved status', () => {
    const data = makeWeeklyData({ planApproved: true });
    const lines = renderCalendarHeader(data);
    const text = lines.join('\n');
    assert.ok(text.includes('Plan approved'));
  });

  it('shows plan pending approval status', () => {
    const data = makeWeeklyData({ planExists: true, planApproved: false });
    const lines = renderCalendarHeader(data);
    const text = lines.join('\n');
    assert.ok(text.includes('Plan pending approval'));
  });

  it('shows no plan status', () => {
    const data = makeWeeklyData({ planExists: false, planApproved: false });
    const lines = renderCalendarHeader(data);
    const text = lines.join('\n');
    assert.ok(text.includes('No plan'));
  });

  it('renders bordered box with ┌ ┐ └ ┘ corners', () => {
    const data = makeWeeklyData();
    const lines = renderCalendarHeader(data);
    assert.ok(lines[0].startsWith('┌'));
    assert.ok(lines[0].endsWith('┐'));
    assert.ok(lines[lines.length - 1].startsWith('└'));
    assert.ok(lines[lines.length - 1].endsWith('┘'));
  });
});

// ─── renderWeeklySummary ────────────────────────────────────────────

describe('renderWeeklySummary', () => {
  it('renders task totals', () => {
    const data = makeWeeklyData({
      summary: {
        planned: { total: 10, completed: 6, failed: 2, pending: 2, inProgress: 0, skipped: 0, delegated: 0, completionRate: 60 },
        actual: { totalEntries: 8, completed: 6, failed: 2, totalDurationMs: 120000 },
      },
    });
    const lines = renderWeeklySummary(data);
    const text = lines.join('\n');
    assert.ok(text.includes('WEEKLY SUMMARY'));
    assert.ok(text.includes('10 total'));
    assert.ok(text.includes('6 completed'));
    assert.ok(text.includes('2 failed'));
    assert.ok(text.includes('2 pending'));
    assert.ok(text.includes('60%'));
  });

  it('shows in-progress, skipped, delegated when present', () => {
    const data = makeWeeklyData({
      summary: {
        planned: { total: 6, completed: 2, failed: 0, pending: 0, inProgress: 2, skipped: 1, delegated: 1, completionRate: 33 },
        actual: { totalEntries: 3, completed: 2, failed: 0, totalDurationMs: 50000 },
      },
    });
    const lines = renderWeeklySummary(data);
    const text = lines.join('\n');
    assert.ok(text.includes('2 in-progress'));
    assert.ok(text.includes('1 skipped'));
    assert.ok(text.includes('1 delegated'));
  });

  it('shows actual execution stats', () => {
    const data = makeWeeklyData({
      summary: {
        planned: { total: 3, completed: 3, failed: 0, pending: 0, inProgress: 0, skipped: 0, delegated: 0, completionRate: 100 },
        actual: { totalEntries: 5, completed: 3, failed: 2, totalDurationMs: 300000 },
      },
    });
    const lines = renderWeeklySummary(data);
    const text = lines.join('\n');
    assert.ok(text.includes('5 entries'));
    assert.ok(text.includes('5m'));
  });

  it('shows unscheduled tasks', () => {
    const data = makeWeeklyData({
      unscheduledTasks: [
        { id: 'task-a', title: 'Pending task', prompt: 'Pending task', status: 'pending' },
        { id: 'task-b', title: 'In progress', prompt: 'In progress', status: 'in-progress' },
      ],
    });
    const lines = renderWeeklySummary(data);
    const text = lines.join('\n');
    assert.ok(text.includes('Unscheduled tasks (2)'));
    assert.ok(text.includes('○ Pending task [pending]'));
    assert.ok(text.includes('► In progress [in-progress]'));
  });

  it('truncates unscheduled tasks beyond 5', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      id: `task-${i}`,
      title: `Task number ${i}`,
      status: 'pending',
    }));
    const data = makeWeeklyData({ unscheduledTasks: tasks });
    const lines = renderWeeklySummary(data);
    const text = lines.join('\n');
    assert.ok(text.includes('+3 more'));
  });

  it('shows N/A rate bar when no tasks planned', () => {
    const data = makeWeeklyData();
    const lines = renderWeeklySummary(data);
    const text = lines.join('\n');
    assert.ok(text.includes('Completion:'));
    assert.ok(text.includes('—'));
  });
});

// ─── renderCompactCalendar ──────────────────────────────────────────

describe('renderCompactCalendar', () => {
  it('renders 7 day rows plus header and separator', () => {
    const data = makeWeeklyData();
    const lines = renderCompactCalendar(data);
    // header + separator + 7 days + separator = 10
    assert.equal(lines.length, 10);
  });

  it('includes day labels and dates', () => {
    const data = makeWeeklyData();
    const lines = renderCompactCalendar(data);
    const text = lines.join('\n');
    assert.ok(text.includes('Mon'));
    assert.ok(text.includes('Sun'));
    assert.ok(text.includes('2026-04-13'));
    assert.ok(text.includes('2026-04-19'));
  });

  it('shows column headers', () => {
    const data = makeWeeklyData();
    const lines = renderCompactCalendar(data);
    assert.ok(lines[0].includes('Day'));
    assert.ok(lines[0].includes('Date'));
    assert.ok(lines[0].includes('Plan'));
    assert.ok(lines[0].includes('Done'));
    assert.ok(lines[0].includes('Fail'));
    assert.ok(lines[0].includes('Rate'));
  });

  it('shows planned counts in compact view', () => {
    const data = makeWeeklyData();
    data.days[0] = makeDayComparison({
      date: '2026-04-13',
      day: 'mon',
      planned: {
        tasks: [{ id: 't', status: 'completed' }],
        count: 1,
        statusCounts: { completed: 1 },
      },
      actual: {
        entries: [],
        count: 2,
        statusCounts: { completed: 2 },
        completedCount: 2,
        failedCount: 0,
        totalDurationMs: 5000,
      },
    });
    const lines = renderCompactCalendar(data);
    const monLine = lines.find((l) => l.includes('Mon'));
    assert.ok(monLine);
    assert.ok(monLine.includes('1')); // planned count
  });
});

// ─── renderWeeklyCalendar (full integration) ────────────────────────

describe('renderWeeklyCalendar', () => {
  it('renders full calendar with header, days, and summary', () => {
    const data = makeWeeklyData({
      summary: {
        planned: { total: 5, completed: 3, failed: 1, pending: 1, inProgress: 0, skipped: 0, delegated: 0, completionRate: 60 },
        actual: { totalEntries: 4, completed: 3, failed: 1, totalDurationMs: 60000 },
      },
    });
    const output = renderWeeklyCalendar(data);
    assert.ok(typeof output === 'string');
    assert.ok(output.includes('agent-test'));
    assert.ok(output.includes('2026-W16'));
    assert.ok(output.includes('WEEKLY SUMMARY'));
    assert.ok(output.includes('Mon'));
    assert.ok(output.includes('Sun'));
  });

  it('renders compact format when compact=true', () => {
    const data = makeWeeklyData();
    const output = renderWeeklyCalendar(data, { compact: true });
    assert.ok(output.includes('Day'));
    assert.ok(output.includes('Date'));
    assert.ok(output.includes('Rate'));
    // Compact shouldn't have bordered day cells
    assert.ok(!output.includes('(no activity)'));
  });

  it('renders detailed day cells in default mode', () => {
    const data = makeWeeklyData();
    const output = renderWeeklyCalendar(data);
    assert.ok(output.includes('(no activity)'));
    // Should have bordered cells
    assert.ok(output.includes('┌'));
    assert.ok(output.includes('└'));
  });

  it('respects maxTasksPerDay option', () => {
    const data = makeWeeklyData();
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `t-${i}`, title: `Task ${i}`, status: 'completed',
    }));
    data.days[0] = makeDayComparison({
      date: '2026-04-13',
      day: 'mon',
      planned: { tasks, count: 5, statusCounts: { completed: 5 } },
      actual: { entries: [], count: 0, statusCounts: {}, completedCount: 0, failedCount: 0, totalDurationMs: 0 },
    });
    const output = renderWeeklyCalendar(data, { maxTasksPerDay: 2 });
    assert.ok(output.includes('+3 more'));
  });

  it('handles completely empty week', () => {
    const data = makeWeeklyData();
    const output = renderWeeklyCalendar(data);
    assert.ok(typeof output === 'string');
    assert.ok(output.length > 0);
    // All days should show no activity
    const noActivityCount = (output.match(/\(no activity\)/g) || []).length;
    assert.equal(noActivityCount, 7);
  });

  it('shows unscheduled tasks in summary', () => {
    const data = makeWeeklyData({
      unscheduledTasks: [
        { id: 'u1', title: 'Backlog item', prompt: 'Backlog item', status: 'pending' },
      ],
    });
    const output = renderWeeklyCalendar(data);
    assert.ok(output.includes('Unscheduled tasks (1)'));
    assert.ok(output.includes('Backlog item'));
  });

  it('renders a rich week with mixed statuses', () => {
    const data = makeWeeklyData({
      summary: {
        planned: { total: 8, completed: 4, failed: 1, pending: 1, inProgress: 1, skipped: 0, delegated: 1, completionRate: 50 },
        actual: { totalEntries: 6, completed: 4, failed: 1, totalDurationMs: 180000 },
      },
    });
    // Monday: 2 completed tasks
    data.days[0] = makeDayComparison({
      date: '2026-04-13',
      day: 'mon',
      planned: {
        tasks: [
          { id: 't-1', title: 'Setup CI', prompt: 'Setup CI', status: 'completed' },
          { id: 't-2', title: 'Write docs', prompt: 'Write docs', status: 'completed' },
        ],
        count: 2,
        statusCounts: { completed: 2 },
      },
      actual: {
        entries: [
          { status: 'completed', title: 'Setup CI' },
          { status: 'completed', title: 'Write docs' },
        ],
        count: 2,
        statusCounts: { completed: 2 },
        completedCount: 2,
        failedCount: 0,
        totalDurationMs: 60000,
      },
    });
    // Tuesday: 1 failed task
    data.days[1] = makeDayComparison({
      date: '2026-04-14',
      day: 'tue',
      planned: {
        tasks: [
          { id: 't-3', title: 'Deploy staging', prompt: 'Deploy staging', status: 'failed' },
        ],
        count: 1,
        statusCounts: { failed: 1 },
      },
      actual: {
        entries: [
          { status: 'failed', title: 'Deploy staging' },
        ],
        count: 1,
        statusCounts: { failed: 1 },
        completedCount: 0,
        failedCount: 1,
        totalDurationMs: 30000,
      },
    });

    const output = renderWeeklyCalendar(data);
    assert.ok(output.includes('✓ Setup CI'));
    assert.ok(output.includes('✓ Write docs'));
    assert.ok(output.includes('✗ Deploy staging'));
    assert.ok(output.includes('50%'));
  });
});
