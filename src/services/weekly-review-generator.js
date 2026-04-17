/**
 * Weekly review document generator.
 * Collects completed tasks from agent history (weekly plans + activity logs)
 * and formats a structured markdown review document.
 *
 * The review document is the source of truth for what an agent accomplished
 * in a given week, traceable back to monthly objectives and goals.
 *
 * Data sources:
 *   - WeeklyPlanStore: tasks with status='completed' and their metadata
 *   - ActivityLogStore: activity entries with status='completed' for richer context
 *   - UsageStore: token consumption for the week (optional enrichment)
 */

/**
 * Collect completed tasks from a weekly plan.
 * @param {object} weeklyPlan - A weekly plan object from WeeklyPlanStore
 * @returns {object[]} Completed tasks with plan metadata attached
 */
export function collectCompletedTasksFromPlan(weeklyPlan) {
  if (!weeklyPlan || !Array.isArray(weeklyPlan.tasks)) return [];
  return weeklyPlan.tasks
    .filter((t) => t.status === 'completed')
    .map((t) => ({
      taskId: t.id,
      description: t.description,
      objectiveId: t.objectiveId,
      priority: t.priority || 'medium',
      completedAt: t.completedAt || null,
      estimatedMinutes: t.estimatedMinutes || null,
      source: 'weekly-plan',
    }));
}

/**
 * Collect completed activity log entries for a given week.
 * Merges richer data (duration, metadata) from the activity log onto task references.
 * @param {object[]} logEntries - Activity log entries from ActivityLogStore
 * @returns {object[]} Completed log entries with normalized shape
 */
export function collectCompletedFromActivityLog(logEntries) {
  if (!Array.isArray(logEntries)) return [];
  return logEntries
    .filter((e) => e.status === 'completed')
    .map((e) => ({
      logId: e.id,
      taskId: e.taskId || null,
      description: e.description,
      completedAt: e.timestamp,
      durationMs: e.duration || null,
      metadata: e.metadata || null,
      source: 'activity-log',
    }));
}

/**
 * Merge plan tasks with activity log entries to produce enriched completed-task records.
 * Activity log entries add duration and metadata to plan tasks.
 * Log entries without a matching plan task are included as standalone completions.
 *
 * @param {object[]} planTasks - From collectCompletedTasksFromPlan
 * @param {object[]} logEntries - From collectCompletedFromActivityLog
 * @returns {object[]} Merged and deduplicated completed task records
 */
export function mergeCompletedTasks(planTasks, logEntries) {
  const merged = [];
  const usedLogIds = new Set();

  // Enrich plan tasks with matching log entries
  for (const task of planTasks) {
    const matchingLog = logEntries.find(
      (e) => e.taskId === task.taskId && !usedLogIds.has(e.logId)
    );
    if (matchingLog) {
      usedLogIds.add(matchingLog.logId);
      merged.push({
        taskId: task.taskId,
        description: task.description,
        objectiveId: task.objectiveId,
        priority: task.priority,
        completedAt: matchingLog.completedAt || task.completedAt,
        estimatedMinutes: task.estimatedMinutes,
        durationMs: matchingLog.durationMs,
        metadata: matchingLog.metadata,
        source: 'merged',
      });
    } else {
      merged.push({ ...task, source: 'weekly-plan' });
    }
  }

  // Add standalone log entries (no matching plan task)
  for (const entry of logEntries) {
    if (!usedLogIds.has(entry.logId)) {
      merged.push({
        taskId: entry.taskId,
        description: entry.description,
        objectiveId: null,
        priority: null,
        completedAt: entry.completedAt,
        estimatedMinutes: null,
        durationMs: entry.durationMs,
        metadata: entry.metadata,
        source: 'activity-log',
      });
    }
  }

  // Sort by completedAt ascending (earliest first)
  merged.sort((a, b) => {
    if (!a.completedAt && !b.completedAt) return 0;
    if (!a.completedAt) return 1;
    if (!b.completedAt) return -1;
    return a.completedAt.localeCompare(b.completedAt);
  });

  return merged;
}

/**
 * Format duration in milliseconds to human-readable string.
 * @param {number|null} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms == null || ms <= 0) return '';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Format a single completed task as a markdown list item.
 * @param {object} task - Merged completed task record
 * @param {object} [opts]
 * @param {boolean} [opts.includeDuration=true] - Show duration if available
 * @param {boolean} [opts.includeObjective=true] - Show objective reference
 * @returns {string} Markdown list item
 */
export function formatCompletedTaskItem(task, opts = {}) {
  const { includeDuration = true, includeObjective = true } = opts;
  let line = `- [x] ${task.description}`;

  const tags = [];
  if (task.priority && task.priority !== 'medium') {
    tags.push(`priority:${task.priority}`);
  }
  if (includeDuration && task.durationMs) {
    tags.push(`duration:${formatDuration(task.durationMs)}`);
  }
  if (includeObjective && task.objectiveId) {
    tags.push(`objective:${task.objectiveId}`);
  }
  if (task.completedAt) {
    // Show date only (not full ISO timestamp)
    tags.push(`completed:${task.completedAt.slice(0, 10)}`);
  }

  if (tags.length > 0) {
    line += ` _(${tags.join(', ')})_`;
  }

  return line;
}

/**
 * Format the Completed Tasks section of a weekly review document.
 * Groups tasks by objective for readability when objectives are available.
 *
 * @param {object[]} completedTasks - Merged completed task records
 * @param {object} [opts]
 * @param {boolean} [opts.groupByObjective=true] - Group tasks under objective headers
 * @param {boolean} [opts.includeSummary=true] - Include a summary line at the top
 * @param {boolean} [opts.includeDuration=true]
 * @returns {string} Markdown content for the Completed Tasks section
 */
export function formatCompletedTasksSection(completedTasks, opts = {}) {
  const {
    groupByObjective = true,
    includeSummary = true,
    includeDuration = true,
  } = opts;

  const lines = [];
  lines.push('## Completed Tasks');
  lines.push('');

  if (completedTasks.length === 0) {
    lines.push('_No tasks were completed this week._');
    lines.push('');
    return lines.join('\n');
  }

  if (includeSummary) {
    const totalDuration = completedTasks.reduce(
      (sum, t) => sum + (t.durationMs || 0),
      0
    );
    let summary = `**${completedTasks.length}** task${completedTasks.length === 1 ? '' : 's'} completed`;
    if (totalDuration > 0) {
      summary += ` (total time: ${formatDuration(totalDuration)})`;
    }
    lines.push(summary);
    lines.push('');
  }

  if (groupByObjective) {
    // Group by objectiveId
    const groups = new Map();
    const ungrouped = [];

    for (const task of completedTasks) {
      if (task.objectiveId) {
        if (!groups.has(task.objectiveId)) {
          groups.set(task.objectiveId, []);
        }
        groups.get(task.objectiveId).push(task);
      } else {
        ungrouped.push(task);
      }
    }

    // Render grouped tasks
    for (const [objectiveId, tasks] of groups) {
      lines.push(`### Objective: ${objectiveId}`);
      lines.push('');
      for (const task of tasks) {
        lines.push(
          formatCompletedTaskItem(task, {
            includeDuration,
            includeObjective: false, // already in header
          })
        );
      }
      lines.push('');
    }

    // Render ungrouped tasks
    if (ungrouped.length > 0) {
      lines.push('### Other Completed Work');
      lines.push('');
      for (const task of ungrouped) {
        lines.push(
          formatCompletedTaskItem(task, { includeDuration, includeObjective: false })
        );
      }
      lines.push('');
    }
  } else {
    // Flat list
    for (const task of completedTasks) {
      lines.push(formatCompletedTaskItem(task, { includeDuration }));
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate the completed tasks portion of a weekly review.
 * Orchestrates data collection from stores and formatting.
 *
 * @param {object} deps - Injected store dependencies
 * @param {object} deps.weeklyPlanStore - WeeklyPlanStore instance
 * @param {object} deps.activityLogStore - ActivityLogStore instance
 * @param {string} agentId - Agent to generate review for
 * @param {string} week - ISO week string (YYYY-Www)
 * @param {string} weekMonday - Monday date string for activity log lookup (YYYY-MM-DD)
 * @param {object} [opts] - Formatting options
 * @returns {Promise<{ completedTasks: object[], markdown: string }>}
 */
export async function generateCompletedTasksReview(
  { weeklyPlanStore, activityLogStore },
  agentId,
  week,
  weekMonday,
  opts = {}
) {
  // Load data from both sources
  let planTasks = [];
  let logCompletions = [];

  // Weekly plan: may not exist yet
  try {
    const plan = await weeklyPlanStore.load(agentId, week);
    planTasks = collectCompletedTasksFromPlan(plan);
  } catch {
    // Plan may not exist — that's OK
  }

  // Activity log: may be empty
  const logEntries = await activityLogStore.load(agentId, weekMonday);
  logCompletions = collectCompletedFromActivityLog(logEntries);

  // Merge and format
  const completedTasks = mergeCompletedTasks(planTasks, logCompletions);
  const markdown = formatCompletedTasksSection(completedTasks, opts);

  return { completedTasks, markdown };
}
