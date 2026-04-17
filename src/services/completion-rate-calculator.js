/**
 * Completion rate calculator — computes per-day and overall weekly
 * completion percentages from planned vs actual task data.
 *
 * Input: structured weekly data from aggregateWeeklyData() or raw
 * plan + activity log data.
 *
 * Output: per-day completion rates (Mon–Sun) and overall weekly rate
 * with breakdowns by status category.
 */

// ---------------------------------------------------------------------------
// Per-day completion rate
// ---------------------------------------------------------------------------

/**
 * Compute the completion rate for a single day.
 * A day's rate is the ratio of completed activity-log entries to total
 * activity-log entries for that day.  If no entries exist, rate is null
 * (not applicable — distinguishable from 0%).
 *
 * @param {object} dayComparison - From buildDayComparison / aggregateWeeklyData().days[]
 * @returns {object} Day completion info
 */
export function computeDayCompletionRate(dayComparison) {
  const { date, day, planned, actual } = dayComparison;

  const plannedCount = planned?.count ?? 0;
  const actualTotal = actual?.count ?? 0;
  const completedCount = actual?.completedCount ?? 0;
  const failedCount = actual?.failedCount ?? 0;

  // Completion rate: completed / total actual entries for this day
  // null when there's no activity (not-applicable, different from 0%)
  let completionRate = null;
  if (actualTotal > 0) {
    completionRate = Math.round((completedCount / actualTotal) * 100);
  }

  return {
    date,
    day,
    plannedCount,
    actualTotal,
    completedCount,
    failedCount,
    completionRate,
  };
}

// ---------------------------------------------------------------------------
// Weekly completion rates (all days)
// ---------------------------------------------------------------------------

/**
 * Compute per-day completion rates for every day in the week.
 *
 * @param {object[]} days - Array of 7 day comparisons from aggregateWeeklyData().days
 * @returns {object[]} Array of 7 day-rate objects (Mon–Sun)
 */
export function computeDailyRates(days) {
  return days.map(computeDayCompletionRate);
}

// ---------------------------------------------------------------------------
// Overall weekly completion rate
// ---------------------------------------------------------------------------

/**
 * Compute the overall weekly completion percentage from planned tasks.
 * Uses the plan's task statuses as the source of truth:
 *   completionRate = completed / totalPlanned * 100
 *
 * Also computes an "effective" rate that treats delegated tasks as resolved:
 *   effectiveRate = (completed + delegated) / totalPlanned * 100
 *
 * @param {object} summary - The summary object from aggregateWeeklyData()
 * @returns {object} Weekly completion metrics
 */
export function computeWeeklyCompletionRate(summary) {
  const planned = summary?.planned || {};
  const actual = summary?.actual || {};

  const totalPlanned = planned.total || 0;
  const completed = planned.completed || 0;
  const failed = planned.failed || 0;
  const pending = planned.pending || 0;
  const inProgress = planned.inProgress || 0;
  const skipped = planned.skipped || 0;
  const delegated = planned.delegated || 0;

  // Core completion rate: only fully completed tasks count
  const completionRate = totalPlanned > 0
    ? Math.round((completed / totalPlanned) * 100)
    : 0;

  // Effective rate: completed + delegated (resolved one way or another)
  const effectiveRate = totalPlanned > 0
    ? Math.round(((completed + delegated) / totalPlanned) * 100)
    : 0;

  // Failure rate
  const failureRate = totalPlanned > 0
    ? Math.round((failed / totalPlanned) * 100)
    : 0;

  return {
    totalPlanned,
    completed,
    failed,
    pending,
    inProgress,
    skipped,
    delegated,
    completionRate,
    effectiveRate,
    failureRate,
    // Actual execution stats (from activity log)
    actualEntries: actual.totalEntries || 0,
    actualCompleted: actual.completed || 0,
    actualFailed: actual.failed || 0,
    actualDurationMs: actual.totalDurationMs || 0,
  };
}

// ---------------------------------------------------------------------------
// Full completion report
// ---------------------------------------------------------------------------

/**
 * Build a full completion report from aggregated weekly data.
 * Combines per-day rates with overall weekly rates into a single
 * structured object suitable for rendering or further processing.
 *
 * @param {object} weeklyData - Output from aggregateWeeklyData()
 * @returns {object} Complete completion report
 */
export function buildCompletionReport(weeklyData) {
  const {
    agentId,
    week,
    weekMonday,
    planExists,
    planApproved,
    days,
    summary,
  } = weeklyData;

  const dailyRates = computeDailyRates(days);
  const weeklyRate = computeWeeklyCompletionRate(summary);

  // Identify active days (days with any activity)
  const activeDays = dailyRates.filter((d) => d.actualTotal > 0);
  const activeDayCount = activeDays.length;

  // Average daily completion rate (across active days only)
  let averageDailyRate = null;
  if (activeDayCount > 0) {
    const sumRates = activeDays.reduce((s, d) => s + d.completionRate, 0);
    averageDailyRate = Math.round(sumRates / activeDayCount);
  }

  return {
    agentId,
    week,
    weekMonday,
    planExists,
    planApproved,
    daily: dailyRates,
    weekly: weeklyRate,
    activeDayCount,
    averageDailyRate,
  };
}

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

/**
 * Format a completion report as a markdown section.
 *
 * @param {object} report - From buildCompletionReport()
 * @returns {string} Markdown string
 */
export function formatCompletionReport(report) {
  const lines = [];

  lines.push('## Completion Rates');
  lines.push('');

  // Overall weekly
  lines.push('### Weekly Overview');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Planned tasks | ${report.weekly.totalPlanned} |`);
  lines.push(`| Completed | ${report.weekly.completed} |`);
  lines.push(`| Failed | ${report.weekly.failed} |`);
  lines.push(`| Pending | ${report.weekly.pending} |`);
  lines.push(`| In progress | ${report.weekly.inProgress} |`);
  lines.push(`| Skipped | ${report.weekly.skipped} |`);
  lines.push(`| Delegated | ${report.weekly.delegated} |`);
  lines.push(`| **Completion rate** | **${report.weekly.completionRate}%** |`);
  lines.push(`| Effective rate (incl. delegated) | ${report.weekly.effectiveRate}% |`);
  lines.push(`| Failure rate | ${report.weekly.failureRate}% |`);
  lines.push('');

  // Per-day breakdown
  lines.push('### Daily Breakdown');
  lines.push('');
  lines.push(`| Day | Date | Planned | Completed | Failed | Rate |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const d of report.daily) {
    const rate = d.completionRate != null ? `${d.completionRate}%` : '—';
    lines.push(`| ${d.day} | ${d.date} | ${d.plannedCount} | ${d.completedCount} | ${d.failedCount} | ${rate} |`);
  }
  lines.push('');

  // Summary line
  if (report.averageDailyRate != null) {
    lines.push(`**Active days:** ${report.activeDayCount}/7 | **Avg daily rate:** ${report.averageDailyRate}%`);
  } else {
    lines.push('_No activity recorded this week._');
  }
  lines.push('');

  return lines.join('\n');
}
