/**
 * Next week plan section generator for weekly reviews.
 * Pulls from agent weekly plans (carry-over tasks) and pending inbox items
 * to produce a structured "Next Week" section in the review document.
 *
 * Data sources:
 *   - WeeklyPlanStore: next week's plan tasks (if already generated)
 *   - WeeklyPlanStore: current week's incomplete tasks (carry-over candidates)
 *   - InboxStore: pending inbox messages awaiting processing
 *
 * The section helps agents and users see what's coming up, including:
 *   - Tasks already planned for next week
 *   - Carry-over tasks from this week (pending/in-progress/failed)
 *   - Pending delegated tasks from other agents
 */

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

/** Priority weight mapping for sorting (higher = more urgent) */
const PRIORITY_WEIGHTS = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Sort items by priority (critical first, low last).
 * Stable sort: items with equal priority keep their original order.
 * @param {object[]} items - Items with a `priority` field
 * @returns {object[]} Sorted copy
 */
function sortByPriority(items) {
  return [...items].sort(
    (a, b) => (PRIORITY_WEIGHTS[b.priority] || 0) - (PRIORITY_WEIGHTS[a.priority] || 0)
  );
}

// ---------------------------------------------------------------------------
// Collect next-week planned tasks
// ---------------------------------------------------------------------------

/**
 * Collect tasks from a next-week weekly plan (if it exists).
 * @param {object|null} nextWeekPlan - The next week's plan object, or null
 * @returns {object[]} Planned task records
 */
export function collectNextWeekPlannedTasks(nextWeekPlan) {
  if (!nextWeekPlan || !Array.isArray(nextWeekPlan.tasks)) return [];
  return nextWeekPlan.tasks.map((t) => ({
    taskId: t.id,
    description: t.description,
    objectiveId: t.objectiveId,
    priority: t.priority || 'medium',
    status: t.status,
    estimatedMinutes: t.estimatedMinutes || null,
    source: 'next-week-plan',
  }));
}

// ---------------------------------------------------------------------------
// Collect carry-over tasks from current week
// ---------------------------------------------------------------------------

/** Statuses that indicate a task should carry over to next week */
const CARRYOVER_STATUSES = new Set(['pending', 'in-progress', 'failed']);

/**
 * Collect incomplete tasks from the current week that should carry over.
 * Carry-over candidates: pending, in-progress, or failed tasks.
 * Completed, skipped, and delegated tasks are excluded.
 *
 * @param {object|null} currentWeekPlan - The current week's plan object, or null
 * @returns {object[]} Carry-over task records
 */
export function collectCarryOverTasks(currentWeekPlan) {
  if (!currentWeekPlan || !Array.isArray(currentWeekPlan.tasks)) return [];
  return currentWeekPlan.tasks
    .filter((t) => CARRYOVER_STATUSES.has(t.status))
    .map((t) => ({
      taskId: t.id,
      description: t.description,
      objectiveId: t.objectiveId,
      priority: t.priority || 'medium',
      status: t.status,
      estimatedMinutes: t.estimatedMinutes || null,
      source: 'carry-over',
    }));
}

// ---------------------------------------------------------------------------
// Collect pending inbox items
// ---------------------------------------------------------------------------

/**
 * Convert pending inbox messages into next-week task items.
 * Pending inbox messages represent delegated work from other agents
 * that hasn't been processed yet.
 *
 * @param {object[]} pendingMessages - Pending inbox messages from InboxStore
 * @returns {object[]} Inbox task records
 */
export function collectPendingInboxItems(pendingMessages) {
  if (!Array.isArray(pendingMessages)) return [];
  return pendingMessages.map((msg) => ({
    messageId: msg.id,
    from: msg.from,
    description: msg.taskDescription,
    context: msg.context || null,
    priority: msg.priority || 'medium',
    type: msg.type,
    sourceTaskId: msg.sourceTaskId || null,
    createdAt: msg.createdAt,
    source: 'inbox',
  }));
}

// ---------------------------------------------------------------------------
// Merge all next-week items
// ---------------------------------------------------------------------------

/**
 * Merge planned tasks, carry-over tasks, and inbox items into a unified list.
 * Deduplicates carry-over tasks that already appear in the next-week plan
 * (matched by description similarity).
 *
 * @param {object[]} plannedTasks - From collectNextWeekPlannedTasks
 * @param {object[]} carryOverTasks - From collectCarryOverTasks
 * @param {object[]} inboxItems - From collectPendingInboxItems
 * @returns {object[]} Merged, deduplicated, and priority-sorted items
 */
export function mergeNextWeekItems(plannedTasks, carryOverTasks, inboxItems) {
  const merged = [];

  // Add all planned tasks first
  for (const task of plannedTasks) {
    merged.push(task);
  }

  // Add carry-over tasks that aren't already in the plan
  const plannedDescriptions = new Set(plannedTasks.map((t) => t.description));
  for (const task of carryOverTasks) {
    if (!plannedDescriptions.has(task.description)) {
      merged.push(task);
    }
  }

  // Add all inbox items (these are always unique — different data source)
  for (const item of inboxItems) {
    merged.push(item);
  }

  // Sort by priority (critical first)
  return sortByPriority(merged);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a source label for display.
 * @param {string} source
 * @returns {string}
 */
export function sourceLabel(source) {
  const labels = {
    'next-week-plan': '📋 Planned',
    'carry-over': '🔄 Carry-over',
    inbox: '📨 Delegated',
  };
  return labels[source] || source;
}

/**
 * Format a single next-week item as a markdown list item.
 * @param {object} item - A merged next-week item
 * @param {object} [opts]
 * @param {boolean} [opts.includeSource=true] - Show source label
 * @param {boolean} [opts.includeObjective=true] - Show objective reference
 * @param {boolean} [opts.includeFrom=true] - Show sender for inbox items
 * @returns {string} Markdown list item
 */
export function formatNextWeekItem(item, opts = {}) {
  const { includeSource = true, includeObjective = true, includeFrom = true } = opts;

  let line = `- [ ] ${item.description}`;

  const tags = [];
  if (item.priority && item.priority !== 'medium') {
    tags.push(`priority:${item.priority}`);
  }
  if (includeSource) {
    tags.push(sourceLabel(item.source));
  }
  if (includeObjective && item.objectiveId) {
    tags.push(`objective:${item.objectiveId}`);
  }
  if (includeFrom && item.from) {
    tags.push(`from:${item.from}`);
  }
  if (item.status && item.source === 'carry-over') {
    tags.push(`was:${item.status}`);
  }
  if (item.estimatedMinutes) {
    tags.push(`est:${item.estimatedMinutes}m`);
  }

  if (tags.length > 0) {
    line += ` _(${tags.join(', ')})_`;
  }

  return line;
}

// ---------------------------------------------------------------------------
// Section formatting
// ---------------------------------------------------------------------------

/**
 * Format the Next Week section of a weekly review document.
 * Groups items by source for readability.
 *
 * @param {object[]} items - Merged next-week items
 * @param {object} [opts]
 * @param {boolean} [opts.groupBySource=true] - Group items under source headers
 * @param {boolean} [opts.includeSummary=true] - Include a summary line at the top
 * @param {boolean} [opts.includeSource=true] - Show source tags on items
 * @param {boolean} [opts.includeObjective=true]
 * @param {boolean} [opts.includeFrom=true]
 * @returns {string} Markdown content for the Next Week section
 */
export function formatNextWeekSection(items, opts = {}) {
  const {
    groupBySource = true,
    includeSummary = true,
    includeSource = true,
    includeObjective = true,
    includeFrom = true,
  } = opts;

  const lines = [];
  lines.push('## Next Week');
  lines.push('');

  if (items.length === 0) {
    lines.push('_No tasks planned for next week yet._');
    lines.push('');
    return lines.join('\n');
  }

  if (includeSummary) {
    const planned = items.filter((i) => i.source === 'next-week-plan').length;
    const carryOver = items.filter((i) => i.source === 'carry-over').length;
    const inbox = items.filter((i) => i.source === 'inbox').length;

    const parts = [];
    if (planned > 0) parts.push(`${planned} planned`);
    if (carryOver > 0) parts.push(`${carryOver} carry-over`);
    if (inbox > 0) parts.push(`${inbox} from inbox`);

    lines.push(
      `**${items.length}** item${items.length === 1 ? '' : 's'} for next week: ${parts.join(', ')}`
    );
    lines.push('');
  }

  if (groupBySource) {
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.source)) {
        groups.set(item.source, []);
      }
      groups.get(item.source).push(item);
    }

    // Render in source order: planned first, carry-over, then inbox
    const orderedSources = ['next-week-plan', 'carry-over', 'inbox'];
    const sourceHeaders = {
      'next-week-plan': '### 📋 Planned Tasks',
      'carry-over': '### 🔄 Carry-over from This Week',
      inbox: '### 📨 Pending Inbox (Delegated)',
    };

    for (const source of orderedSources) {
      const groupItems = groups.get(source);
      if (!groupItems || groupItems.length === 0) continue;

      lines.push(sourceHeaders[source] || `### ${source}`);
      lines.push('');
      for (const item of groupItems) {
        lines.push(
          formatNextWeekItem(item, {
            includeSource: false, // already in header
            includeObjective,
            includeFrom,
          })
        );
      }
      lines.push('');
    }
  } else {
    // Flat list
    for (const item of items) {
      lines.push(formatNextWeekItem(item, { includeSource, includeObjective, includeFrom }));
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate the next-week plan section of a weekly review.
 * Orchestrates data collection from stores and formatting.
 *
 * @param {object} deps - Injected store dependencies
 * @param {object} deps.weeklyPlanStore - WeeklyPlanStore instance
 * @param {object} deps.inboxStore - InboxStore instance
 * @param {string} agentId - Agent to generate next-week plan for
 * @param {string} currentWeek - Current ISO week string (YYYY-Www)
 * @param {string} nextWeek - Next ISO week string (YYYY-Www)
 * @param {object} [opts] - Formatting options
 * @returns {Promise<{ items: object[], markdown: string, counts: { planned: number, carryOver: number, inbox: number } }>}
 */
export async function generateNextWeekPlanSection(
  { weeklyPlanStore, inboxStore },
  agentId,
  currentWeek,
  nextWeek,
  opts = {}
) {
  // Load data from all sources (in parallel)
  const [currentPlanResult, nextPlanResult, pendingMessages] = await Promise.all([
    weeklyPlanStore.load(agentId, currentWeek).catch(() => null),
    weeklyPlanStore.load(agentId, nextWeek).catch(() => null),
    inboxStore.pending(agentId).catch(() => []),
  ]);

  // Collect from each source
  const plannedTasks = collectNextWeekPlannedTasks(nextPlanResult);
  const carryOverTasks = collectCarryOverTasks(currentPlanResult);
  const inboxItems = collectPendingInboxItems(pendingMessages);

  // Merge and format
  const items = mergeNextWeekItems(plannedTasks, carryOverTasks, inboxItems);
  const markdown = formatNextWeekSection(items, opts);

  return {
    items,
    markdown,
    counts: {
      planned: plannedTasks.length,
      carryOver: carryOverTasks.filter(
        (t) => !new Set(plannedTasks.map((p) => p.description)).has(t.description)
      ).length,
      inbox: inboxItems.length,
    },
  };
}
