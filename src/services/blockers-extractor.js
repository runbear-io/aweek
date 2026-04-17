/**
 * Blockers extraction logic for weekly reviews.
 * Identifies failed and blocked tasks from weekly plans and activity logs,
 * then formats them into a structured Blockers section.
 *
 * A "blocker" is any task that:
 *   - Has status 'failed' in the weekly plan
 *   - Has status 'failed' in the activity log
 *   - Has status 'in-progress' past its expected completion (stuck)
 *   - Has status 'skipped' with metadata indicating a blocker reason
 *
 * Data sources:
 *   - WeeklyPlanStore: tasks with status='failed'/'skipped' and their metadata
 *   - ActivityLogStore: entries with status='failed' for error context
 */

import { formatDuration } from './weekly-review-generator.js';

// ---------------------------------------------------------------------------
// Blocker categories
// ---------------------------------------------------------------------------

/** Categories for classifying blockers */
export const BLOCKER_CATEGORIES = ['failed', 'stuck', 'skipped', 'dependency'];

/**
 * Classify a blocker into a category based on its source data.
 * @param {object} item - A plan task or activity log entry
 * @returns {string} One of BLOCKER_CATEGORIES
 */
export function classifyBlocker(item) {
  if (item.status === 'failed') return 'failed';
  if (item.status === 'skipped') return 'skipped';
  if (item.status === 'in-progress') return 'stuck';
  if (item.delegatedTo || item.metadata?.delegatedTo) return 'dependency';
  return 'failed'; // default
}

// ---------------------------------------------------------------------------
// Extract blockers from weekly plan
// ---------------------------------------------------------------------------

/**
 * Extract blocked/failed tasks from a weekly plan.
 * @param {object} weeklyPlan - A weekly plan object from WeeklyPlanStore
 * @returns {object[]} Blocker records with plan metadata attached
 */
export function extractBlockersFromPlan(weeklyPlan) {
  if (!weeklyPlan || !Array.isArray(weeklyPlan.tasks)) return [];

  const blockerStatuses = new Set(['failed', 'skipped', 'in-progress']);

  return weeklyPlan.tasks
    .filter((t) => blockerStatuses.has(t.status))
    .map((t) => ({
      taskId: t.id,
      description: t.description,
      objectiveId: t.objectiveId,
      priority: t.priority || 'medium',
      status: t.status,
      category: classifyBlocker(t),
      delegatedTo: t.delegatedTo || null,
      estimatedMinutes: t.estimatedMinutes || null,
      source: 'weekly-plan',
    }));
}

// ---------------------------------------------------------------------------
// Extract blockers from activity log
// ---------------------------------------------------------------------------

/**
 * Extract failed activity log entries for a given week.
 * Failed log entries carry richer error context in metadata.
 * @param {object[]} logEntries - Activity log entries from ActivityLogStore
 * @returns {object[]} Failed log entries with normalized shape
 */
export function extractBlockersFromActivityLog(logEntries) {
  if (!Array.isArray(logEntries)) return [];

  return logEntries
    .filter((e) => e.status === 'failed')
    .map((e) => ({
      logId: e.id,
      taskId: e.taskId || null,
      description: e.description,
      timestamp: e.timestamp,
      durationMs: e.duration || null,
      metadata: e.metadata || null,
      errorMessage: e.metadata?.error || e.metadata?.errorMessage || null,
      category: 'failed',
      source: 'activity-log',
    }));
}

// ---------------------------------------------------------------------------
// Merge plan blockers with activity log failures
// ---------------------------------------------------------------------------

/**
 * Merge plan blockers with activity log failures to produce enriched blocker records.
 * Activity log entries add error context and duration to plan tasks.
 * Log entries without a matching plan task are included as standalone blockers.
 *
 * @param {object[]} planBlockers - From extractBlockersFromPlan
 * @param {object[]} logBlockers - From extractBlockersFromActivityLog
 * @returns {object[]} Merged and deduplicated blocker records
 */
export function mergeBlockers(planBlockers, logBlockers) {
  const merged = [];
  const usedLogIds = new Set();

  // Enrich plan blockers with matching log entries
  for (const blocker of planBlockers) {
    const matchingLog = logBlockers.find(
      (e) => e.taskId === blocker.taskId && !usedLogIds.has(e.logId)
    );
    if (matchingLog) {
      usedLogIds.add(matchingLog.logId);
      merged.push({
        taskId: blocker.taskId,
        description: blocker.description,
        objectiveId: blocker.objectiveId,
        priority: blocker.priority,
        status: blocker.status,
        category: blocker.category,
        delegatedTo: blocker.delegatedTo,
        estimatedMinutes: blocker.estimatedMinutes,
        timestamp: matchingLog.timestamp,
        durationMs: matchingLog.durationMs,
        errorMessage: matchingLog.errorMessage,
        metadata: matchingLog.metadata,
        source: 'merged',
      });
    } else {
      merged.push({ ...blocker, source: 'weekly-plan' });
    }
  }

  // Add standalone log failures (no matching plan task)
  for (const entry of logBlockers) {
    if (!usedLogIds.has(entry.logId)) {
      merged.push({
        taskId: entry.taskId,
        description: entry.description,
        objectiveId: null,
        priority: null,
        status: 'failed',
        category: entry.category,
        delegatedTo: null,
        estimatedMinutes: null,
        timestamp: entry.timestamp,
        durationMs: entry.durationMs,
        errorMessage: entry.errorMessage,
        metadata: entry.metadata,
        source: 'activity-log',
      });
    }
  }

  // Sort: failed first, then stuck, then skipped; within each category by priority
  const categoryOrder = { failed: 0, stuck: 1, dependency: 2, skipped: 3 };
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

  merged.sort((a, b) => {
    const catDiff =
      (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9);
    if (catDiff !== 0) return catDiff;
    return (
      (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2)
    );
  });

  return merged;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Get a human-readable label for a blocker category.
 * @param {string} category
 * @returns {string}
 */
export function categoryLabel(category) {
  const labels = {
    failed: '❌ Failed',
    stuck: '⏳ Stuck',
    skipped: '⏭️ Skipped',
    dependency: '🔗 Dependency',
  };
  return labels[category] || category;
}

/**
 * Format a single blocker as a markdown list item.
 * @param {object} blocker - Merged blocker record
 * @param {object} [opts]
 * @param {boolean} [opts.includeError=true] - Show error message if available
 * @param {boolean} [opts.includeObjective=true] - Show objective reference
 * @returns {string} Markdown list item (may be multi-line for errors)
 */
export function formatBlockerItem(blocker, opts = {}) {
  const { includeError = true, includeObjective = true } = opts;

  let line = `- [ ] **${blocker.description}**`;

  const tags = [];
  tags.push(`status:${blocker.status}`);

  if (blocker.priority && blocker.priority !== 'medium') {
    tags.push(`priority:${blocker.priority}`);
  }
  if (includeObjective && blocker.objectiveId) {
    tags.push(`objective:${blocker.objectiveId}`);
  }
  if (blocker.durationMs) {
    tags.push(`ran:${formatDuration(blocker.durationMs)}`);
  }
  if (blocker.delegatedTo) {
    tags.push(`delegated-to:${blocker.delegatedTo}`);
  }
  if (blocker.timestamp) {
    tags.push(`at:${blocker.timestamp.slice(0, 10)}`);
  }

  if (tags.length > 0) {
    line += ` _(${tags.join(', ')})_`;
  }

  // Add error message as indented sub-item
  if (includeError && blocker.errorMessage) {
    line += `\n  - Error: ${blocker.errorMessage}`;
  }

  return line;
}

// ---------------------------------------------------------------------------
// Section formatting
// ---------------------------------------------------------------------------

/**
 * Format the Blockers section of a weekly review document.
 * Groups blockers by category for readability.
 *
 * @param {object[]} blockers - Merged blocker records
 * @param {object} [opts]
 * @param {boolean} [opts.groupByCategory=true] - Group blockers under category headers
 * @param {boolean} [opts.includeSummary=true] - Include a summary line at the top
 * @param {boolean} [opts.includeError=true] - Show error messages
 * @param {boolean} [opts.includeObjective=true] - Show objective references
 * @returns {string} Markdown content for the Blockers section
 */
export function formatBlockersSection(blockers, opts = {}) {
  const {
    groupByCategory = true,
    includeSummary = true,
    includeError = true,
    includeObjective = true,
  } = opts;

  const lines = [];
  lines.push('## Blockers');
  lines.push('');

  if (blockers.length === 0) {
    lines.push('_No blockers this week._ 🎉');
    lines.push('');
    return lines.join('\n');
  }

  if (includeSummary) {
    const failedCount = blockers.filter((b) => b.category === 'failed').length;
    const stuckCount = blockers.filter((b) => b.category === 'stuck').length;
    const skippedCount = blockers.filter((b) => b.category === 'skipped').length;
    const depCount = blockers.filter((b) => b.category === 'dependency').length;

    const parts = [];
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    if (stuckCount > 0) parts.push(`${stuckCount} stuck`);
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
    if (depCount > 0) parts.push(`${depCount} dependency`);

    lines.push(
      `**${blockers.length}** blocker${blockers.length === 1 ? '' : 's'}: ${parts.join(', ')}`
    );
    lines.push('');
  }

  if (groupByCategory) {
    const groups = new Map();

    for (const blocker of blockers) {
      if (!groups.has(blocker.category)) {
        groups.set(blocker.category, []);
      }
      groups.get(blocker.category).push(blocker);
    }

    // Render in category order
    const orderedCategories = ['failed', 'stuck', 'dependency', 'skipped'];
    for (const cat of orderedCategories) {
      const items = groups.get(cat);
      if (!items || items.length === 0) continue;

      lines.push(`### ${categoryLabel(cat)}`);
      lines.push('');
      for (const blocker of items) {
        lines.push(
          formatBlockerItem(blocker, {
            includeError,
            includeObjective,
          })
        );
      }
      lines.push('');
    }
  } else {
    // Flat list
    for (const blocker of blockers) {
      lines.push(formatBlockerItem(blocker, { includeError, includeObjective }));
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate the blockers portion of a weekly review.
 * Orchestrates data collection from stores and formatting.
 *
 * @param {object} deps - Injected store dependencies
 * @param {object} deps.weeklyPlanStore - WeeklyPlanStore instance
 * @param {object} deps.activityLogStore - ActivityLogStore instance
 * @param {string} agentId - Agent to generate blockers for
 * @param {string} week - ISO week string (YYYY-Www)
 * @param {string} weekMonday - Monday date string for activity log lookup (YYYY-MM-DD)
 * @param {object} [opts] - Formatting options
 * @returns {Promise<{ blockers: object[], markdown: string }>}
 */
export async function generateBlockersReview(
  { weeklyPlanStore, activityLogStore },
  agentId,
  week,
  weekMonday,
  opts = {}
) {
  // Load data from both sources
  let planBlockers = [];
  let logBlockers = [];

  // Weekly plan: may not exist yet
  try {
    const plan = await weeklyPlanStore.load(agentId, week);
    planBlockers = extractBlockersFromPlan(plan);
  } catch {
    // Plan may not exist — that's OK
  }

  // Activity log: may be empty
  const logEntries = await activityLogStore.load(agentId, weekMonday);
  logBlockers = extractBlockersFromActivityLog(logEntries);

  // Merge and format
  const blockers = mergeBlockers(planBlockers, logBlockers);
  const markdown = formatBlockersSection(blockers, opts);

  return { blockers, markdown };
}
