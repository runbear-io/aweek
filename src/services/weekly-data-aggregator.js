/**
 * Weekly data aggregator — collects planned vs actual tasks for a given week.
 * Returns a structured day-by-day comparison with completion counts.
 *
 * Data sources:
 *   - WeeklyPlanStore: planned tasks with statuses and metadata
 *   - ActivityLogStore: actual activity entries with timestamps and durations
 *
 * Output: structured object with daily breakdown (Mon–Sun), per-day planned/actual
 * task lists, and aggregate completion counts for the entire week.
 */

/**
 * Get the Monday date string for a given ISO week (YYYY-Www).
 * @param {string} isoWeek - e.g. "2026-W16"
 * @returns {string} Monday date string (YYYY-MM-DD)
 */
export function mondayFromISOWeek(isoWeek) {
  const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid ISO week format: ${isoWeek}`);

  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);

  // ISO 8601: Week 1 contains the year's first Thursday.
  // Jan 4 is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  // Monday of week 1
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  // Target Monday
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return target.toISOString().slice(0, 10);
}

/**
 * Get the day-of-week name from a date string.
 * @param {string} dateStr - ISO date or datetime string
 * @returns {string} Day name: 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'
 */
export function dayOfWeek(dateStr) {
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const d = new Date(dateStr);
  return DAYS[d.getUTCDay()];
}

/**
 * Generate all 7 date strings (YYYY-MM-DD) for a week starting on Monday.
 * @param {string} mondayDate - Monday date string (YYYY-MM-DD)
 * @returns {Array<{date: string, day: string}>} 7-element array Mon–Sun
 */
export function weekDates(mondayDate) {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const monday = new Date(mondayDate + 'T00:00:00Z');
  return DAYS.map((day, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), day };
  });
}

/**
 * Bucket activity log entries by day of week based on their timestamps.
 * @param {object[]} logEntries - Activity log entries
 * @param {string} mondayDate - Monday date for this week
 * @returns {Map<string, object[]>} Map from day name to entries for that day
 */
export function bucketLogEntriesByDay(logEntries, mondayDate) {
  const days = weekDates(mondayDate);
  const dateToDay = new Map(days.map((d) => [d.date, d.day]));
  const buckets = new Map();
  for (const { day } of days) {
    buckets.set(day, []);
  }

  for (const entry of logEntries) {
    const entryDate = entry.timestamp.slice(0, 10);
    const day = dateToDay.get(entryDate);
    if (day) {
      buckets.get(day).push(entry);
    }
    // Entries outside the week range are silently ignored
  }

  return buckets;
}

/**
 * Bucket planned tasks by their completedAt day (if completed) or leave unassigned.
 * Tasks without a completedAt stay in the "unscheduled" bucket.
 * @param {object[]} tasks - Weekly plan tasks
 * @param {string} mondayDate - Monday date for this week
 * @returns {{ byDay: Map<string, object[]>, unscheduled: object[] }}
 */
export function bucketTasksByDay(tasks, mondayDate) {
  const days = weekDates(mondayDate);
  const dateToDay = new Map(days.map((d) => [d.date, d.day]));
  const byDay = new Map();
  for (const { day } of days) {
    byDay.set(day, []);
  }
  const unscheduled = [];

  for (const task of tasks) {
    if (task.completedAt) {
      const taskDate = task.completedAt.slice(0, 10);
      const day = dateToDay.get(taskDate);
      if (day) {
        byDay.get(day).push(task);
      } else {
        unscheduled.push(task);
      }
    } else {
      unscheduled.push(task);
    }
  }

  return { byDay, unscheduled };
}

/**
 * Count tasks by status from an array of tasks.
 * @param {object[]} tasks
 * @returns {object} Counts keyed by status
 */
export function countByStatus(tasks) {
  const counts = {};
  for (const t of tasks) {
    const s = t.status || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

/**
 * Count activity log entries by status.
 * @param {object[]} entries
 * @returns {object} Counts keyed by status
 */
export function countLogByStatus(entries) {
  const counts = {};
  for (const e of entries) {
    const s = e.status || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

/**
 * Build a single day's comparison structure.
 * @param {string} date - YYYY-MM-DD
 * @param {string} day - Day name (mon, tue, etc.)
 * @param {object[]} plannedTasks - Tasks from the weekly plan completed on this day
 * @param {object[]} actualEntries - Activity log entries for this day
 * @returns {object} Day comparison object
 */
export function buildDayComparison(date, day, plannedTasks, actualEntries) {
  return {
    date,
    day,
    planned: {
      tasks: plannedTasks,
      count: plannedTasks.length,
      statusCounts: countByStatus(plannedTasks),
    },
    actual: {
      entries: actualEntries,
      count: actualEntries.length,
      statusCounts: countLogByStatus(actualEntries),
      completedCount: actualEntries.filter((e) => e.status === 'completed').length,
      failedCount: actualEntries.filter((e) => e.status === 'failed').length,
      totalDurationMs: actualEntries.reduce((sum, e) => sum + (e.duration || 0), 0),
    },
  };
}

/**
 * Aggregate planned vs actual tasks for a given week from agent data.
 * Returns structured day-by-day comparison with completion counts.
 *
 * @param {object} deps - Injected dependencies
 * @param {object} deps.weeklyPlanStore - WeeklyPlanStore instance
 * @param {object} deps.activityLogStore - ActivityLogStore instance
 * @param {string} agentId - Agent to aggregate data for
 * @param {string} week - ISO week string (YYYY-Www)
 * @param {object} [opts]
 * @param {string} [opts.weekMonday] - Override Monday date (auto-derived from week if omitted)
 * @returns {Promise<object>} Structured weekly comparison
 */
export async function aggregateWeeklyData(
  { weeklyPlanStore, activityLogStore },
  agentId,
  week,
  opts = {}
) {
  const mondayDate = opts.weekMonday || mondayFromISOWeek(week);

  // Load planned tasks from weekly plan (may not exist)
  let allTasks = [];
  let planExists = false;
  let planApproved = false;
  try {
    const plan = await weeklyPlanStore.load(agentId, week);
    allTasks = plan.tasks || [];
    planExists = true;
    planApproved = !!plan.approved;
  } catch {
    // Plan does not exist — that's OK, we'll have empty planned data
  }

  // Load activity log entries for the week
  const logEntries = await activityLogStore.load(agentId, mondayDate);

  // Bucket by day
  const taskBuckets = bucketTasksByDay(allTasks, mondayDate);
  const logBuckets = bucketLogEntriesByDay(logEntries, mondayDate);
  const dates = weekDates(mondayDate);

  // Build day-by-day comparison
  const days = dates.map(({ date, day }) =>
    buildDayComparison(
      date,
      day,
      taskBuckets.byDay.get(day) || [],
      logBuckets.get(day) || []
    )
  );

  // Aggregate totals
  const totalPlanned = allTasks.length;
  const completedTasks = allTasks.filter((t) => t.status === 'completed');
  const failedTasks = allTasks.filter((t) => t.status === 'failed');
  const pendingTasks = allTasks.filter((t) => t.status === 'pending');
  const inProgressTasks = allTasks.filter((t) => t.status === 'in-progress');
  const skippedTasks = allTasks.filter((t) => t.status === 'skipped');
  const delegatedTasks = allTasks.filter((t) => t.status === 'delegated');

  const totalLogEntries = logEntries.length;
  const completedLogEntries = logEntries.filter((e) => e.status === 'completed');
  const failedLogEntries = logEntries.filter((e) => e.status === 'failed');
  const totalDurationMs = logEntries.reduce((sum, e) => sum + (e.duration || 0), 0);

  return {
    agentId,
    week,
    weekMonday: mondayDate,
    planExists,
    planApproved,
    days,
    unscheduledTasks: taskBuckets.unscheduled,
    summary: {
      planned: {
        total: totalPlanned,
        completed: completedTasks.length,
        failed: failedTasks.length,
        pending: pendingTasks.length,
        inProgress: inProgressTasks.length,
        skipped: skippedTasks.length,
        delegated: delegatedTasks.length,
        completionRate: totalPlanned > 0
          ? Math.round((completedTasks.length / totalPlanned) * 100)
          : 0,
      },
      actual: {
        totalEntries: totalLogEntries,
        completed: completedLogEntries.length,
        failed: failedLogEntries.length,
        totalDurationMs,
      },
    },
  };
}
