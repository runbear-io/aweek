/**
 * Weekly calendar renderer — formats aggregated weekly data into a visual
 * text-based calendar display showing planned tasks, actual tasks, and
 * completion rates per day.
 *
 * Input: aggregated weekly data from aggregateWeeklyData() and/or
 *        completion report from buildCompletionReport().
 *
 * Output: text-based calendar string suitable for terminal or markdown display.
 */

import { computeDayCompletionRate } from './completion-rate-calculator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_LABELS = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const STATUS_ICONS = {
  completed: '✓',
  failed: '✗',
  pending: '○',
  'in-progress': '►',
  skipped: '⊘',
  delegated: '→',
  started: '►',
  unknown: '?',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a status icon character for a given status string.
 * @param {string} status
 * @returns {string}
 */
export function statusIcon(status) {
  return STATUS_ICONS[status] || STATUS_ICONS.unknown;
}

/**
 * Truncate a string to a maximum length, appending '…' if truncated.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Pad or truncate a string to exactly `width` characters.
 * @param {string} str
 * @param {number} width
 * @param {'left'|'right'|'center'} [align='left']
 * @returns {string}
 */
export function padTo(str, width, align = 'left') {
  const s = String(str);
  if (s.length >= width) return s.slice(0, width);
  const padding = width - s.length;
  if (align === 'right') return ' '.repeat(padding) + s;
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return ' '.repeat(left) + s + ' '.repeat(padding - left);
  }
  return s + ' '.repeat(padding);
}

/**
 * Format a completion rate as a visual bar with percentage.
 * @param {number|null} rate - 0–100 or null
 * @param {number} [barWidth=10] - Width of the progress bar in characters
 * @returns {string}
 */
export function formatRateBar(rate, barWidth = 10) {
  if (rate === null || rate === undefined) return padTo('—', barWidth + 5);
  const filled = Math.round((rate / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const pct = `${rate}%`.padStart(4);
  return `${bar} ${pct}`;
}

/**
 * Format a duration in milliseconds to a human-readable short form.
 * @param {number} ms
 * @returns {string}
 */
export function formatDurationShort(ms) {
  if (!ms || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h${remainMin}m` : `${hours}h`;
}

// ---------------------------------------------------------------------------
// Day cell renderer
// ---------------------------------------------------------------------------

/**
 * Render a single day cell for the calendar.
 * @param {object} dayComparison - Day data from aggregateWeeklyData().days[]
 * @param {object} [opts]
 * @param {number} [opts.cellWidth=30] - Width of cell content area
 * @param {number} [opts.maxTasks=3] - Max tasks to show per day
 * @returns {string[]} Array of lines for this day cell
 */
export function renderDayCell(dayComparison, opts = {}) {
  const { cellWidth = 30, maxTasks = 3 } = opts;
  const { date, day, planned, actual } = dayComparison;
  const rate = computeDayCompletionRate(dayComparison);

  const lines = [];

  // Header: Day label + date
  const header = `${DAY_LABELS[day] || day} ${date}`;
  lines.push(padTo(header, cellWidth));

  // Completion bar
  lines.push(formatRateBar(rate.completionRate, Math.min(cellWidth - 6, 10)));

  // Stats line: planned/completed/failed counts
  const statsLine = `P:${planned.count} C:${rate.completedCount} F:${rate.failedCount}`;
  lines.push(padTo(statsLine, cellWidth));

  // Duration if available
  if (actual.totalDurationMs > 0) {
    lines.push(padTo(`⏱ ${formatDurationShort(actual.totalDurationMs)}`, cellWidth));
  }

  // Task list (planned tasks completed on this day)
  const tasks = planned.tasks || [];
  const shown = tasks.slice(0, maxTasks);
  for (const task of shown) {
    const icon = statusIcon(task.status);
    const desc = truncate(task.title || task.id || 'task', cellWidth - 4);
    lines.push(`  ${icon} ${desc}`);
  }
  if (tasks.length > maxTasks) {
    lines.push(`  … +${tasks.length - maxTasks} more`);
  }

  // Actual entries not tied to planned tasks
  const actualEntries = actual.entries || [];
  if (actualEntries.length > 0 && tasks.length === 0) {
    const shownEntries = actualEntries.slice(0, maxTasks);
    for (const entry of shownEntries) {
      const icon = statusIcon(entry.status);
      const desc = truncate(entry.title || entry.taskId || 'activity', cellWidth - 4);
      lines.push(`  ${icon} ${desc}`);
    }
    if (actualEntries.length > maxTasks) {
      lines.push(`  … +${actualEntries.length - maxTasks} more`);
    }
  }

  // Empty day indicator
  if (tasks.length === 0 && actualEntries.length === 0) {
    lines.push(padTo('  (no activity)', cellWidth));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Horizontal rule
// ---------------------------------------------------------------------------

/**
 * Build a horizontal separator line.
 * @param {number} width
 * @param {string} [char='─']
 * @returns {string}
 */
export function horizontalRule(width, char = '─') {
  return char.repeat(width);
}

// ---------------------------------------------------------------------------
// Calendar header
// ---------------------------------------------------------------------------

/**
 * Render the calendar header with agent info and week range.
 * @param {object} weeklyData - From aggregateWeeklyData()
 * @returns {string[]} Header lines
 */
export function renderCalendarHeader(weeklyData) {
  const { agentId, week, weekMonday, planExists, planApproved } = weeklyData;
  const lines = [];

  const endDate = new Date(weekMonday + 'T00:00:00Z');
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  const sundayDate = endDate.toISOString().slice(0, 10);

  lines.push(`┌${'─'.repeat(62)}┐`);
  lines.push(`│ ${padTo(`📅 Weekly Calendar: ${agentId}`, 61)}│`);
  lines.push(`│ ${padTo(`Week ${week} (${weekMonday} → ${sundayDate})`, 61)}│`);

  const statusParts = [];
  if (!planExists) statusParts.push('No plan');
  else if (!planApproved) statusParts.push('Plan pending approval');
  else statusParts.push('Plan approved');

  lines.push(`│ ${padTo(`Status: ${statusParts.join(' | ')}`, 61)}│`);
  lines.push(`└${'─'.repeat(62)}┘`);

  return lines;
}

// ---------------------------------------------------------------------------
// Summary footer
// ---------------------------------------------------------------------------

/**
 * Render the weekly summary footer with overall stats.
 * @param {object} weeklyData - From aggregateWeeklyData()
 * @returns {string[]} Footer lines
 */
export function renderWeeklySummary(weeklyData) {
  const { summary, unscheduledTasks } = weeklyData;
  const { planned, actual } = summary;
  const lines = [];

  lines.push('');
  lines.push(`${'═'.repeat(64)}`);
  lines.push(' WEEKLY SUMMARY');
  lines.push(`${'─'.repeat(64)}`);

  // Planned task breakdown
  const rateStr = planned.total > 0 ? `${planned.completionRate}%` : 'N/A';
  lines.push(` Tasks: ${planned.total} total | ${planned.completed} completed | ${planned.failed} failed | ${planned.pending} pending`);
  if (planned.inProgress > 0 || planned.skipped > 0 || planned.delegated > 0) {
    const extras = [];
    if (planned.inProgress > 0) extras.push(`${planned.inProgress} in-progress`);
    if (planned.skipped > 0) extras.push(`${planned.skipped} skipped`);
    if (planned.delegated > 0) extras.push(`${planned.delegated} delegated`);
    lines.push(`        ${extras.join(' | ')}`);
  }

  // Completion rate bar
  const barWidth = 20;
  const completionBar = formatRateBar(planned.total > 0 ? planned.completionRate : null, barWidth);
  lines.push(` Completion: ${completionBar}`);

  // Actual execution stats
  if (actual.totalEntries > 0) {
    lines.push(` Activity:  ${actual.totalEntries} entries | ${actual.completed} completed | ${actual.failed} failed`);
    lines.push(` Duration:  ${formatDurationShort(actual.totalDurationMs)}`);
  }

  // Unscheduled tasks
  if (unscheduledTasks && unscheduledTasks.length > 0) {
    lines.push('');
    lines.push(` Unscheduled tasks (${unscheduledTasks.length}):`);
    for (const task of unscheduledTasks.slice(0, 5)) {
      const icon = statusIcon(task.status);
      const desc = truncate(task.title || task.id, 50);
      lines.push(`   ${icon} ${desc} [${task.status}]`);
    }
    if (unscheduledTasks.length > 5) {
      lines.push(`   … +${unscheduledTasks.length - 5} more`);
    }
  }

  lines.push(`${'═'.repeat(64)}`);

  return lines;
}

// ---------------------------------------------------------------------------
// Full calendar render
// ---------------------------------------------------------------------------

/**
 * Render a full weekly calendar from aggregated data.
 * Shows a visual text-based calendar with each day displaying planned tasks,
 * actual tasks, and completion rates.
 *
 * @param {object} weeklyData - From aggregateWeeklyData()
 * @param {object} [opts]
 * @param {number} [opts.cellWidth=30] - Width of each day cell
 * @param {number} [opts.maxTasksPerDay=3] - Max tasks shown per day
 * @param {boolean} [opts.compact=false] - Use compact single-line-per-day format
 * @returns {string} Rendered calendar text
 */
export function renderWeeklyCalendar(weeklyData, opts = {}) {
  const { cellWidth = 30, maxTasksPerDay = 3, compact = false } = opts;
  const allLines = [];

  // Header
  allLines.push(...renderCalendarHeader(weeklyData));
  allLines.push('');

  if (compact) {
    // Compact view: one line per day
    allLines.push(...renderCompactCalendar(weeklyData));
  } else {
    // Full view: multi-line day cells
    for (const day of weeklyData.days) {
      const cellLines = renderDayCell(day, { cellWidth, maxTasks: maxTasksPerDay });
      allLines.push(`┌${'─'.repeat(cellWidth + 2)}┐`);
      for (const line of cellLines) {
        allLines.push(`│ ${padTo(line, cellWidth)} │`);
      }
      allLines.push(`└${'─'.repeat(cellWidth + 2)}┘`);
    }
  }

  // Weekly summary footer
  allLines.push(...renderWeeklySummary(weeklyData));

  return allLines.join('\n');
}

// ---------------------------------------------------------------------------
// Compact calendar format
// ---------------------------------------------------------------------------

/**
 * Render a compact one-line-per-day calendar view.
 * @param {object} weeklyData - From aggregateWeeklyData()
 * @returns {string[]} Lines
 */
export function renderCompactCalendar(weeklyData) {
  const lines = [];

  // Header row
  lines.push(
    `${padTo('Day', 5)}${padTo('Date', 12)}${padTo('Plan', 6)}${padTo('Done', 6)}${padTo('Fail', 6)}${padTo('Rate', 16)}${padTo('Duration', 10)}`
  );
  lines.push(horizontalRule(61));

  for (const day of weeklyData.days) {
    const rate = computeDayCompletionRate(day);
    const rateBar = formatRateBar(rate.completionRate, 8);
    const dur = formatDurationShort(day.actual.totalDurationMs);
    const line = `${padTo(DAY_LABELS[day.day] || day.day, 5)}${padTo(day.date, 12)}${padTo(String(day.planned.count), 6)}${padTo(String(rate.completedCount), 6)}${padTo(String(rate.failedCount), 6)}${padTo(rateBar, 16)}${padTo(dur, 10)}`;
    lines.push(line);
  }

  lines.push(horizontalRule(61));

  return lines;
}
