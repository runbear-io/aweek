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
      // The review markdown is user-facing, so surface the short title
      // rather than the long prompt that was sent to Claude.
      description: t.title,
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
      // Activity-log entries store `title` — keep the internal review
      // record keyed on `description` since downstream formatters have
      // historically consumed that field name.
      description: e.title,
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

// ---------------------------------------------------------------------------
// Four-section weekly review content generator (CollectedWeekData → markdown)
// ---------------------------------------------------------------------------
// The functions below accept a CollectedWeekData snapshot
// (from weekly-review-collector.js) and render each of the four required
// review sections. They are deliberately pure (no I/O) so they are testable
// without stores and composable in any order.
//
// Note: formatCost is re-defined locally below rather than imported from
// weekly-review-metrics.js to avoid a circular dependency — that module
// imports formatDuration from this file.

/**
 * Map a task status to a compact checkbox-style marker.
 * @param {string} status
 * @returns {string}
 */
function statusMarker(status) {
  const MARKERS = {
    completed: '[x]',
    failed: '[!]',
    skipped: '[-]',
    delegated: '[→]',
    'in-progress': '[~]',
    pending: '[ ]',
  };
  return MARKERS[status] ?? '[ ]';
}

/**
 * Format USD cost with appropriate precision.
 * Defined locally (not imported from weekly-review-metrics) to avoid a
 * circular dependency — metrics imports formatDuration from this module.
 * @param {number} usd
 * @returns {string}
 */
function formatCostLocal(usd) {
  if (!usd || usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Format a number with locale-aware thousands separators.
 * @param {number} n
 * @returns {string}
 */
function formatN(n) {
  return (n || 0).toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Section 1: Task-by-task completion status
// ---------------------------------------------------------------------------

/**
 * Format the Task Completion Status section — one row per work task, with
 * its final status for the week.
 *
 * Input is `plan.workTasks` from a CollectedWeekData snapshot (review tasks
 * are already filtered out by the collector via isReviewObjectiveId).
 *
 * @param {object[]} workTasks - Non-review tasks from plan.workTasks
 * @returns {string} Markdown for the section
 */
export function formatTaskStatusSection(workTasks) {
  const lines = [];
  lines.push('## Task Completion Status');
  lines.push('');

  if (!Array.isArray(workTasks) || workTasks.length === 0) {
    lines.push('_No work tasks were scheduled for this week._');
    lines.push('');
    return lines.join('\n');
  }

  const completedCount = workTasks.filter((t) => t.status === 'completed').length;
  const total = workTasks.length;
  const completionRate = Math.round((completedCount / total) * 100);
  lines.push(
    `**${completedCount}/${total}** tasks completed (${completionRate}%)`
  );
  lines.push('');

  for (const task of workTasks) {
    const marker = statusMarker(task.status);
    const tags = [];
    if (task.priority && task.priority !== 'medium') {
      tags.push(`priority:${task.priority}`);
    }
    if (task.objectiveId) {
      tags.push(`→ ${task.objectiveId}`);
    }
    if (task.completedAt) {
      tags.push(`done:${task.completedAt.slice(0, 10)}`);
    }
    const suffix = tags.length > 0 ? ` _(${tags.join(', ')})_` : '';
    lines.push(`- ${marker} ${task.title}${suffix}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 2: Carry-over list
// ---------------------------------------------------------------------------

/**
 * Format the Carry-Over Tasks section — incomplete work tasks (pending,
 * in-progress, or failed) that should roll into next week's plan.
 *
 * Skipped and delegated tasks are intentionally excluded: skipped tasks were
 * deliberately dropped, and delegated tasks are now another agent's
 * responsibility.
 *
 * @param {object[]} workTasks - Non-review tasks from plan.workTasks
 * @returns {string} Markdown for the section
 */
export function formatCarryOverSection(workTasks) {
  const lines = [];
  lines.push('## Carry-Over Tasks');
  lines.push('');

  if (!Array.isArray(workTasks) || workTasks.length === 0) {
    lines.push('_No tasks were scheduled this week._');
    lines.push('');
    return lines.join('\n');
  }

  const CARRY_OVER_STATUSES = new Set(['pending', 'in-progress', 'failed']);
  const carryOver = workTasks.filter((t) => CARRY_OVER_STATUSES.has(t.status));

  if (carryOver.length === 0) {
    lines.push(
      '_Nothing to carry over — all tasks were completed, skipped, or delegated. Great work!_'
    );
    lines.push('');
    return lines.join('\n');
  }

  lines.push(
    `**${carryOver.length}** task${carryOver.length === 1 ? '' : 's'} to carry forward:`
  );
  lines.push('');

  for (const task of carryOver) {
    // Append a status note for non-pending states to give context
    const statusNote =
      task.status === 'in-progress'
        ? ' _(was in progress)_'
        : task.status === 'failed'
        ? ' _(failed — needs retry or closer look)_'
        : '';

    const tags = [];
    if (task.priority && task.priority !== 'medium') {
      tags.push(`priority:${task.priority}`);
    }
    if (task.objectiveId) {
      tags.push(task.objectiveId);
    }
    const tagSuffix = tags.length > 0 ? ` _(${tags.join(', ')})_` : '';
    lines.push(`- [ ] ${task.title}${tagSuffix}${statusNote}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 3: What-worked narrative
// ---------------------------------------------------------------------------

/**
 * Format the What Worked section — a concise narrative paragraph summarising
 * what went well this week.
 *
 * The narrative is derived from structured data (completed task counts,
 * activity log totals, priority level of completed tasks, objective coverage)
 * so it reads contextually even in fully autonomous mode.
 *
 * @param {object} collectedData - CollectedWeekData snapshot
 * @param {object} collectedData.plan
 * @param {object} collectedData.activityLog
 * @returns {string} Markdown for the section
 */
export function formatWhatWorkedSection(collectedData) {
  // Use optional chaining so null/undefined collectedData returns an empty section
  // rather than throwing during destructuring.
  const plan = collectedData?.plan;
  const activityLog = collectedData?.activityLog;
  const workTasks = plan?.workTasks || [];
  const completedTasks = workTasks.filter((t) => t.status === 'completed');
  const total = workTasks.length;
  const totalDuration = activityLog?.totalDurationMs || 0;

  const lines = [];
  lines.push('## What Worked');
  lines.push('');

  if (completedTasks.length === 0 && totalDuration === 0) {
    lines.push('_No significant activity was recorded this week._');
    lines.push('');
    return lines.join('\n');
  }

  // Opening sentence — ties completion rate to session time.
  // The count is written as plain "N of M planned tasks" (bold wraps the
  // rate percentage only) so substring assertions in tests are straightforward.
  if (completedTasks.length > 0 && total > 0) {
    const rate = Math.round((completedTasks.length / total) * 100);
    const timePart =
      totalDuration > 0
        ? `, with ${formatDuration(totalDuration)} of active session time logged`
        : '';
    lines.push(
      `This week closed out ${completedTasks.length} of ${total} planned ` +
        `task${total === 1 ? '' : 's'} (**${rate}% completion rate**)${timePart}.`
    );
  } else if (totalDuration > 0) {
    lines.push(
      `No planned tasks were completed this week, but **${formatDuration(totalDuration)}** ` +
        `of active session time was logged.`
    );
  }

  // Highlight critical / high priority completions
  const criticalDone = completedTasks.filter((t) => t.priority === 'critical');
  const highDone = completedTasks.filter((t) => t.priority === 'high');

  if (criticalDone.length > 0) {
    lines.push('');
    lines.push(
      `**Critical work shipped:** ${criticalDone.map((t) => t.title).join('; ')}.`
    );
  }
  if (highDone.length > 0) {
    lines.push('');
    lines.push(
      `**High-priority wins:** ${highDone.map((t) => t.title).join('; ')}.`
    );
  }

  // Objective-level breakdown when more than one objective contributed
  const byObj = new Map();
  for (const t of completedTasks) {
    const key = t.objectiveId || '_other';
    if (!byObj.has(key)) byObj.set(key, []);
    byObj.get(key).push(t);
  }

  if (byObj.size > 1) {
    lines.push('');
    lines.push('**Progress by objective:**');
    lines.push('');
    for (const [obj, tasks] of byObj) {
      const label = obj === '_other' ? 'Other' : obj;
      lines.push(
        `- **${label}** — ${tasks.length} task${tasks.length === 1 ? '' : 's'} done`
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 4: Budget summary
// ---------------------------------------------------------------------------

/**
 * Format the Budget Summary section — token usage and utilization against the
 * configured weekly token limit.
 *
 * @param {object} budget - Budget sub-object from CollectedWeekData
 * @param {number} budget.weeklyTokenLimit - Configured limit (0 = no limit)
 * @param {number} budget.inputTokens
 * @param {number} budget.outputTokens
 * @param {number} budget.totalTokens
 * @param {number} budget.costUsd
 * @param {number} budget.sessionCount
 * @param {number|null} budget.remainingTokens
 * @param {number|null} budget.utilizationPct
 * @param {boolean} budget.paused
 * @returns {string} Markdown for the section
 */
export function formatBudgetSummarySection(budget) {
  const lines = [];
  lines.push('## Budget Summary');
  lines.push('');

  if (!budget || budget.totalTokens === 0) {
    lines.push('_No token usage was recorded this week._');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Sessions | ${budget.sessionCount || 0} |`);
  lines.push(`| Input tokens | ${formatN(budget.inputTokens)} |`);
  lines.push(`| Output tokens | ${formatN(budget.outputTokens)} |`);
  lines.push(`| Total tokens | ${formatN(budget.totalTokens)} |`);
  lines.push(`| Estimated cost | ${formatCostLocal(budget.costUsd)} |`);

  if (budget.weeklyTokenLimit > 0) {
    lines.push(`| Weekly token limit | ${formatN(budget.weeklyTokenLimit)} |`);
    if (budget.remainingTokens !== null) {
      lines.push(`| Remaining tokens | ${formatN(budget.remainingTokens)} |`);
    }
    if (budget.utilizationPct !== null) {
      const indicator =
        budget.utilizationPct >= 90
          ? ' ⚠️'
          : budget.utilizationPct >= 75
            ? ' 🔶'
            : '';
      lines.push(`| Budget utilization | ${budget.utilizationPct}%${indicator} |`);
    }
  }

  if (budget.paused) {
    lines.push('');
    lines.push(
      '> ⚠️ **This agent is currently paused** — the weekly token budget was exhausted. ' +
        'Run `/aweek:manage` → Top up to reset usage and resume execution.'
    );
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main content generator
// ---------------------------------------------------------------------------

/**
 * Generate a complete weekly review markdown document from a CollectedWeekData
 * snapshot.
 *
 * Produces all four required sections in order:
 *   1. Task Completion Status — task-by-task status rows
 *   2. Carry-Over Tasks       — incomplete tasks to roll forward
 *   3. What Worked            — narrative summary of wins
 *   4. Budget Summary         — token usage and budget utilization
 *
 * This function is pure (no I/O). It is the canonical entry point for
 * downstream consumers that have already called collectWeeklyReviewData().
 *
 * @param {object} collectedData - CollectedWeekData snapshot from weekly-review-collector.js
 * @param {object} [opts] - Reserved for future per-section formatting options
 * @returns {{ markdown: string, sections: { taskStatus: string, carryOver: string, whatWorked: string, budgetSummary: string } }}
 */
export function generateWeeklyReviewContent(collectedData, opts = {}) {
  void opts; // reserved for future use

  const workTasks = collectedData?.plan?.workTasks || [];
  const budget = collectedData?.budget || {};

  const taskStatusSection = formatTaskStatusSection(workTasks);
  const carryOverSection = formatCarryOverSection(workTasks);
  const whatWorkedSection = formatWhatWorkedSection(collectedData);
  const budgetSection = formatBudgetSummarySection(budget);

  const markdown = [
    taskStatusSection,
    carryOverSection,
    whatWorkedSection,
    budgetSection,
  ].join('\n');

  return {
    markdown,
    sections: {
      taskStatus: taskStatusSection,
      carryOver: carryOverSection,
      whatWorked: whatWorkedSection,
      budgetSummary: budgetSection,
    },
  };
}
