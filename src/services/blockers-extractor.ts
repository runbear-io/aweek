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
// Shared types
// ---------------------------------------------------------------------------

export type BlockerCategory = 'failed' | 'stuck' | 'skipped' | 'dependency';

/** Loose shape for a plan task or activity-log entry passed to classifyBlocker. */
export interface ClassifiableItem {
  status?: string;
  delegatedTo?: string | null;
  metadata?: { delegatedTo?: string | null; [key: string]: unknown } | null;
}

/** Plan task shape consumed by extractBlockersFromPlan. */
export interface PlanTask {
  id: string;
  title?: string;
  prompt?: string;
  objectiveId?: string | null;
  priority?: string | null;
  status?: string;
  delegatedTo?: string | null;
  estimatedMinutes?: number | null;
  metadata?: { delegatedTo?: string | null; [key: string]: unknown } | null;
}

/** Loose shape for a weekly plan loaded from WeeklyPlanStore. */
export interface BlockersWeeklyPlan {
  tasks?: PlanTask[];
  [key: string]: unknown;
}

/** Activity log entry shape consumed by extractBlockersFromActivityLog. */
export interface ActivityLogEntry {
  id: string;
  status?: string;
  taskId?: string | null;
  title?: string;
  description?: string;
  timestamp?: string;
  duration?: number | null;
  metadata?: { error?: string; errorMessage?: string; [key: string]: unknown } | null;
}

export interface PlanBlocker {
  taskId: string;
  description: string | undefined;
  objectiveId: string | null | undefined;
  priority: string;
  status: string | undefined;
  category: BlockerCategory;
  delegatedTo: string | null;
  estimatedMinutes: number | null;
  source: 'weekly-plan';
}

export interface LogBlocker {
  logId: string;
  taskId: string | null;
  description: string | undefined;
  timestamp: string | undefined;
  durationMs: number | null;
  metadata: ActivityLogEntry['metadata'];
  errorMessage: string | null;
  category: BlockerCategory;
  source: 'activity-log';
}

export interface MergedBlocker {
  taskId: string | null | undefined;
  description: string | undefined;
  objectiveId: string | null | undefined;
  priority: string | null;
  status: string | undefined;
  category: BlockerCategory;
  delegatedTo: string | null;
  estimatedMinutes: number | null;
  timestamp?: string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  metadata?: ActivityLogEntry['metadata'];
  source: 'merged' | 'weekly-plan' | 'activity-log';
}

export interface FormatBlockerItemOpts {
  includeError?: boolean;
  includeObjective?: boolean;
}

export interface FormatBlockersSectionOpts extends FormatBlockerItemOpts {
  groupByCategory?: boolean;
  includeSummary?: boolean;
}

export interface BlockersDeps {
  weeklyPlanStore: {
    load: (agentId: string, week: string) => Promise<BlockersWeeklyPlan>;
  };
  activityLogStore: {
    load: (agentId: string, weekMonday: string) => Promise<ActivityLogEntry[]>;
  };
}

// ---------------------------------------------------------------------------
// Blocker categories
// ---------------------------------------------------------------------------

/** Categories for classifying blockers */
export const BLOCKER_CATEGORIES: readonly BlockerCategory[] = ['failed', 'stuck', 'skipped', 'dependency'];

/**
 * Classify a blocker into a category based on its source data.
 * @param {object} item - A plan task or activity log entry
 * @returns {string} One of BLOCKER_CATEGORIES
 */
export function classifyBlocker(item: ClassifiableItem): BlockerCategory {
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
export function extractBlockersFromPlan(weeklyPlan: BlockersWeeklyPlan | null | undefined): PlanBlocker[] {
  if (!weeklyPlan || !Array.isArray(weeklyPlan.tasks)) return [];

  const blockerStatuses = new Set(['failed', 'skipped', 'in-progress']);

  return weeklyPlan.tasks
    .filter((t: PlanTask) => blockerStatuses.has(t.status ?? ''))
    .map((t: PlanTask): PlanBlocker => ({
      taskId: t.id,
      // Blocker lists render in review markdown — show the compact title
      // rather than the long prompt the heartbeat fed to Claude.
      description: t.title,
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
export function extractBlockersFromActivityLog(logEntries: ActivityLogEntry[] | null | undefined): LogBlocker[] {
  if (!Array.isArray(logEntries)) return [];

  return logEntries
    .filter((e: ActivityLogEntry) => e.status === 'failed')
    .map((e: ActivityLogEntry): LogBlocker => ({
      logId: e.id,
      taskId: e.taskId || null,
      // Activity-log entries store `title` — re-key as `description` on the
      // internal blocker record so downstream formatters (which share a
      // shape with plan-sourced blockers) keep working.
      description: e.title,
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
export function mergeBlockers(planBlockers: PlanBlocker[], logBlockers: LogBlocker[]): MergedBlocker[] {
  const merged: MergedBlocker[] = [];
  const usedLogIds = new Set<string>();

  // Enrich plan blockers with matching log entries
  for (const blocker of planBlockers) {
    const matchingLog = logBlockers.find(
      (e: LogBlocker) => e.taskId === blocker.taskId && !usedLogIds.has(e.logId)
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
  const categoryOrder: Record<string, number> = { failed: 0, stuck: 1, dependency: 2, skipped: 3 };
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

  merged.sort((a: MergedBlocker, b: MergedBlocker) => {
    const catDiff =
      (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9);
    if (catDiff !== 0) return catDiff;
    return (
      (priorityOrder[a.priority ?? ''] ?? 2) - (priorityOrder[b.priority ?? ''] ?? 2)
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
export function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
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
export function formatBlockerItem(blocker: Partial<MergedBlocker>, opts: FormatBlockerItemOpts = {}): string {
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
export function formatBlockersSection(
  blockers: Array<Partial<MergedBlocker>>,
  opts: FormatBlockersSectionOpts = {},
): string {
  const {
    groupByCategory = true,
    includeSummary = true,
    includeError = true,
    includeObjective = true,
  } = opts;

  const lines: string[] = [];
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

    const parts: string[] = [];
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
    const groups = new Map<string, Array<Partial<MergedBlocker>>>();

    for (const blocker of blockers) {
      const key = blocker.category ?? 'failed';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(blocker);
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
  { weeklyPlanStore, activityLogStore }: BlockersDeps,
  agentId: string,
  week: string,
  weekMonday: string,
  opts: FormatBlockersSectionOpts = {},
): Promise<{ blockers: MergedBlocker[]; markdown: string }> {
  // Load data from both sources
  let planBlockers: PlanBlocker[] = [];
  let logBlockers: LogBlocker[] = [];

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
