/**
 * Daily review file writer.
 *
 * Generates reviews/daily-YYYY-MM-DD.md with exactly three H2 sections:
 *
 *   ## Task Status          — task-by-task status for the day
 *   ## Adjustments for Tomorrow — advisor-voice proposed adjustments
 *   ## Notes                — placeholder for freeform notes
 *
 * Populated from the agent's current weekly plan execution state,
 * cross-referenced with activity log entries for the target date.
 *
 * File path: .aweek/agents/<agentId>/reviews/daily-YYYY-MM-DD.md
 * Companion:  .aweek/agents/<agentId>/reviews/daily-YYYY-MM-DD.json
 *
 * Review tasks (objectiveId in REVIEW_OBJECTIVE_IDS) are always excluded —
 * the daily review only surfaces user work items. Use isReviewObjectiveId()
 * for all gating; never hardcode the reserved string values.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isReviewObjectiveId } from '../schemas/weekly-plan.schema.js';
import { formatDuration } from './weekly-review-generator.js';
import { localParts } from '../time/zone.js';
import { enqueueDailyReviewAdjustments } from './daily-review-adjustments.js';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Convert a UTC ISO string to a local YYYY-MM-DD date string in the given tz.
 * Falls back to a plain UTC date slice when tz is absent or UTC.
 *
 * @param {string|null|undefined} isoString - UTC ISO datetime string
 * @param {string} [tz='UTC'] - IANA time zone name
 * @returns {string|null} YYYY-MM-DD local date, or null when input is falsy
 */
export function utcToLocalDate(isoString, tz = 'UTC') {
  if (!isoString) return null;
  if (!tz || tz === 'UTC') return isoString.slice(0, 10);
  const parts = localParts(new Date(isoString), tz);
  return (
    String(parts.year).padStart(4, '0') +
    '-' +
    String(parts.month).padStart(2, '0') +
    '-' +
    String(parts.day).padStart(2, '0')
  );
}

/**
 * Get the weekday name for a YYYY-MM-DD date string.
 * The date is interpreted as UTC midnight so the result is consistent
 * regardless of the host's local zone.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} e.g. "Monday", "Friday"
 */
export function weekdayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return WEEKDAY_NAMES[d.getUTCDay()];
}

/**
 * Get the weekday name for the day after the given date.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} e.g. "Tuesday"
 */
export function tomorrowWeekdayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return WEEKDAY_NAMES[d.getUTCDay()];
}

/**
 * Derive an ISO week string (YYYY-Www) from a YYYY-MM-DD date.
 * Follows ISO 8601: weeks start on Monday; week 1 is the week containing
 * the year's first Thursday.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} e.g. "2026-W16"
 */
export function dateToISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  // Thursday in the same week determines the ISO year
  const thu = new Date(d);
  thu.setUTCDate(d.getUTCDate() + (4 - (d.getUTCDay() || 7)));
  const year = thu.getUTCFullYear();
  // Monday of week 1 in that year
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  // Week number (1-based)
  const weekNum = Math.floor((d.getTime() - week1Mon.getTime()) / 604_800_000) + 1;
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Convert an ISO week string to its Monday date (YYYY-MM-DD).
 *
 * @param {string} isoWeek - YYYY-Www
 * @returns {string} YYYY-MM-DD
 */
export function isoWeekToMondayDate(isoWeek) {
  const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid ISO week: ${isoWeek}`);
  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(week1Mon);
  monday.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

/**
 * Collect work tasks relevant to a specific date from a weekly plan.
 *
 * A task is "relevant" to a date when:
 *   - Its `runAt` field (if present) maps to that calendar date in `tz`, OR
 *   - Its `completedAt` field (if present) maps to that calendar date in `tz`.
 *
 * Review tasks (objectiveId is a reserved review value) are always excluded —
 * the daily review only shows user work items. Use isReviewObjectiveId() for
 * the gate; never hardcode the reserved string values.
 *
 * @param {object|null} weeklyPlan - A weekly plan object from WeeklyPlanStore
 * @param {string} targetDate - Target date in YYYY-MM-DD format
 * @param {string} [tz='UTC'] - IANA time zone for date comparison
 * @returns {object[]} Work tasks relevant to the target date
 */
export function collectDayTasks(weeklyPlan, targetDate, tz = 'UTC') {
  if (!weeklyPlan || !Array.isArray(weeklyPlan.tasks)) return [];

  const seen = new Set();
  const result = [];

  for (const task of weeklyPlan.tasks) {
    // Skip reserved review slots — these are infrastructure, not user work
    if (isReviewObjectiveId(task.objectiveId)) continue;
    if (seen.has(task.id)) continue;

    const runAtDate = task.runAt ? utcToLocalDate(task.runAt, tz) : null;
    const completedAtDate = task.completedAt ? utcToLocalDate(task.completedAt, tz) : null;

    const scheduledToday = runAtDate === targetDate;
    const completedToday = completedAtDate === targetDate;

    if (scheduledToday || completedToday) {
      seen.add(task.id);
      result.push({ ...task, scheduledToday, completedToday });
    }
  }

  return result;
}

/**
 * Collect activity log entries for a specific date.
 * Entries are matched by the date portion of their `timestamp` field.
 *
 * @param {object[]} logEntries - Activity log entries from ActivityLogStore
 * @param {string} targetDate - Target date in YYYY-MM-DD format
 * @param {string} [tz='UTC'] - IANA time zone for date comparison
 * @returns {object[]} Log entries for the target date
 */
export function collectDayLogEntries(logEntries, targetDate, tz = 'UTC') {
  if (!Array.isArray(logEntries)) return [];
  return logEntries.filter((e) => {
    if (!e.timestamp) return false;
    return utcToLocalDate(e.timestamp, tz) === targetDate;
  });
}

// ---------------------------------------------------------------------------
// Section 1: ## Task Status
// ---------------------------------------------------------------------------

const STATUS_ICONS = {
  completed: '✅',
  'in-progress': '🔄',
  failed: '❌',
  skipped: '⏭️',
  delegated: '🤝',
  pending: '⬜',
};

/**
 * Get a status icon for a task status string.
 * @param {string} status
 * @returns {string}
 */
export function taskStatusIcon(status) {
  return STATUS_ICONS[status] || '❓';
}

/**
 * Format a single task as a status line in advisor voice.
 *
 * The task description anchors the line; the status icon communicates
 * outcome at a glance; inline tags carry priority, objective, duration,
 * and completion time so the reader gets full context without opening the
 * weekly plan.
 *
 * @param {object} task - Day task record from collectDayTasks
 * @param {object|null} [logEntry] - Matching activity log entry for richer context
 * @returns {string} Markdown list item
 */
export function formatDayTaskItem(task, logEntry = null) {
  const icon = taskStatusIcon(task.status);
  let line = `- ${icon} **${task.title}**`;

  const tags = [];
  tags.push(`status:${task.status}`);

  if (task.priority && task.priority !== 'medium') {
    tags.push(`priority:${task.priority}`);
  }
  if (task.objectiveId) {
    tags.push(`objective:${task.objectiveId}`);
  }
  if (logEntry?.duration) {
    tags.push(`duration:${formatDuration(logEntry.duration)}`);
  }
  if (task.completedAt) {
    tags.push(`completed:${task.completedAt.slice(11, 16)} UTC`);
  }

  if (tags.length > 0) {
    line += ` _(${tags.join(', ')})_`;
  }

  return line;
}

/**
 * Format the Task Status section of a daily review.
 *
 * Tasks are sorted into status buckets (completed first, then in-progress,
 * then pending, then delegated, failed, skipped) so the reader scans wins
 * before problems.
 *
 * @param {object[]} tasks - Day tasks from collectDayTasks
 * @param {object[]} logEntries - Day log entries from collectDayLogEntries
 * @returns {string} Markdown content for the Task Status section
 */
export function formatTaskStatusSection(tasks, logEntries) {
  const lines = [];
  lines.push('## Task Status');
  lines.push('');

  if (tasks.length === 0) {
    lines.push('_No tasks were scheduled for this day._');
    lines.push('');
    return lines.join('\n');
  }

  // Build taskId→logEntry index for O(n) enrichment
  const logByTaskId = new Map();
  for (const entry of logEntries) {
    if (entry.taskId && !logByTaskId.has(entry.taskId)) {
      logByTaskId.set(entry.taskId, entry);
    }
  }

  // Bucket by status in the order we want to render
  const STATUS_ORDER = ['completed', 'in-progress', 'pending', 'delegated', 'failed', 'skipped'];
  const buckets = new Map(STATUS_ORDER.map((s) => [s, []]));
  for (const task of tasks) {
    const slot = buckets.get(task.status);
    if (slot) {
      slot.push(task);
    } else {
      buckets.get('pending').push(task); // unknown status → treat as pending
    }
  }

  // Summary line
  const completed = buckets.get('completed').length;
  const total = tasks.length;
  lines.push(
    `**${completed}** of **${total}** task${total === 1 ? '' : 's'} completed today.`
  );
  lines.push('');

  // Render each non-empty bucket
  for (const status of STATUS_ORDER) {
    const bucket = buckets.get(status);
    if (!bucket || bucket.length === 0) continue;
    for (const task of bucket) {
      lines.push(formatDayTaskItem(task, logByTaskId.get(task.id) ?? null));
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 2: ## Adjustments for Tomorrow
// ---------------------------------------------------------------------------

/**
 * Build a list of proposed adjustments for tomorrow based on today's outcomes.
 *
 * Each adjustment is a structured object with `type` and `text`. The `type`
 * field supports downstream filtering; `text` is the advisor-voice sentence
 * rendered directly in the review document.
 *
 * Adjustment types:
 *   'carry-over' — pending task not started today; schedule it tomorrow
 *   'continue'   — in-progress task; open tomorrow with this to retain momentum
 *   'retry'      — failed task; diagnose before retrying
 *   'reschedule' — skipped task; decide whether to re-queue or defer
 *   'follow-up'  — delegated task; check on receipt and status
 *
 * @param {object[]} tasks - Day tasks from collectDayTasks
 * @param {object[]} logEntries - Day log entries from collectDayLogEntries
 * @param {string} [tomorrowDayName='tomorrow'] - Name of the next weekday
 * @returns {Array<{ type: string, taskId: string, title: string, text: string }>}
 */
export function buildAdjustmentsForTomorrow(tasks, logEntries, tomorrowDayName = 'tomorrow') {
  const adjustments = [];

  const logByTaskId = new Map();
  for (const entry of logEntries) {
    if (entry.taskId) logByTaskId.set(entry.taskId, entry);
  }

  for (const task of tasks) {
    switch (task.status) {
      case 'completed':
        // No adjustment needed for completed tasks — they're done
        break;

      case 'pending': {
        const isUrgent = task.priority === 'critical' || task.priority === 'high';
        adjustments.push({
          type: 'carry-over',
          taskId: task.id,
          title: task.title,
          text:
            `**${task.title}** was not started today — schedule it as a ` +
            `${isUrgent ? 'top' : 'first available'} priority for ` +
            `${tomorrowDayName}.`,
        });
        break;
      }

      case 'in-progress': {
        const log = logByTaskId.get(task.id);
        const durationNote = log?.duration
          ? ` (${formatDuration(log.duration)} invested so far)`
          : '';
        adjustments.push({
          type: 'continue',
          taskId: task.id,
          title: task.title,
          text:
            `**${task.title}** is still in progress${durationNote}. ` +
            `Open ${tomorrowDayName} with this task to carry its momentum through to completion.`,
        });
        break;
      }

      case 'failed': {
        const log = logByTaskId.get(task.id);
        const errorNote = log?.metadata?.error
          ? ` Error context: "${log.metadata.error}".`
          : '';
        const isUrgent = task.priority === 'critical' || task.priority === 'high';
        adjustments.push({
          type: 'retry',
          taskId: task.id,
          title: task.title,
          text:
            `**${task.title}** failed today.${errorNote} ` +
            `Before retrying on ${tomorrowDayName}, diagnose what went wrong and ` +
            `${isUrgent ? 'escalate immediately if external help is needed.' : 'confirm whether any unblocking steps are required.'}`,
        });
        break;
      }

      case 'skipped':
        adjustments.push({
          type: 'reschedule',
          taskId: task.id,
          title: task.title,
          text:
            `**${task.title}** was skipped today. ` +
            `On ${tomorrowDayName} decide whether to reschedule it or mark it as deferred ` +
            `if priorities have shifted since it was planned.`,
        });
        break;

      case 'delegated':
        adjustments.push({
          type: 'follow-up',
          taskId: task.id,
          title: task.title,
          text:
            `**${task.title}** was delegated today. ` +
            `Follow up on ${tomorrowDayName} to confirm the delegate received, ` +
            `acknowledged, and has a clear path forward.`,
        });
        break;

      default:
        break;
    }
  }

  return adjustments;
}

/**
 * Format the Adjustments for Tomorrow section of a daily review.
 *
 * @param {Array<{ type: string, taskId: string, title: string, text: string }>} adjustments
 * @param {string} [tomorrowDayName='tomorrow'] - Name of the next weekday
 * @returns {string} Markdown content for the Adjustments for Tomorrow section
 */
export function formatAdjustmentsSection(adjustments, tomorrowDayName = 'tomorrow') {
  const lines = [];
  lines.push('## Adjustments for Tomorrow');
  lines.push('');

  if (adjustments.length === 0) {
    lines.push(
      `_All tasks completed — great work! ${tomorrowDayName} starts with a clean slate. ` +
        `Review your plan now to confirm next tasks are lined up and ready to go._`
    );
    lines.push('');
    return lines.join('\n');
  }

  for (const adj of adjustments) {
    lines.push(`- ${adj.text}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 3: ## Notes
// ---------------------------------------------------------------------------

/**
 * Format the Notes section of a daily review.
 *
 * This is always an empty placeholder — the agent populates it during the
 * review session with observations, decisions, or context for the record.
 * Downstream consumers (e.g. the weekly review) can read this section to
 * surface qualitative notes without parsing the other sections.
 *
 * @returns {string} Markdown content for the Notes section
 */
export function formatNotesSection() {
  const lines = [];
  lines.push('## Notes');
  lines.push('');
  lines.push('_Add any observations, decisions, or context worth recording here._');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Document header
// ---------------------------------------------------------------------------

/**
 * Build the document header for a daily review.
 *
 * @param {object} opts
 * @param {string} opts.agentId - Agent identifier
 * @param {string} [opts.agentName] - Human-readable agent name (falls back to agentId)
 * @param {string} opts.date - Review date (YYYY-MM-DD)
 * @param {string} opts.dayName - Weekday name (e.g. "Monday")
 * @param {string} opts.week - ISO week string (e.g. "2026-W16")
 * @param {string} opts.generatedAt - ISO datetime when the review was generated
 * @returns {string} Markdown header block
 */
export function buildDailyReviewHeader({ agentId, agentName, date, dayName, week, generatedAt }) {
  const lines = [];
  lines.push(`# Daily Review: ${agentName || agentId} — ${dayName}, ${date}`);
  lines.push('');
  lines.push(`**Date:** ${date} (${dayName})`);
  lines.push(`**Week:** ${week}`);
  lines.push(`**Agent:** ${agentId}`);
  lines.push(`**Generated:** ${generatedAt}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

/**
 * Assemble all three sections into a final daily review markdown document.
 *
 * The document always has exactly three H2 sections in this order:
 *   1. ## Task Status
 *   2. ## Adjustments for Tomorrow
 *   3. ## Notes
 *
 * @param {object} sections
 * @param {string} sections.header - Document header (H1 + metadata)
 * @param {string} sections.taskStatus - ## Task Status section
 * @param {string} sections.adjustments - ## Adjustments for Tomorrow section
 * @param {string} sections.notes - ## Notes section
 * @returns {string} Complete markdown document
 */
export function assembleDailyReview({ header, taskStatus, adjustments, notes }) {
  const parts = [];
  parts.push(header);
  parts.push(taskStatus);
  parts.push(adjustments);
  parts.push(notes);
  parts.push('---');
  parts.push('');
  parts.push('_This daily review was auto-generated by aweek._');
  parts.push('');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Get the reviews directory for an agent.
 * Co-located with weekly reviews so all review artifacts live together
 * under .aweek/agents/<agentId>/reviews/.
 *
 * @param {string} baseDir - Root data directory (e.g. .aweek/agents)
 * @param {string} agentId
 * @returns {string}
 */
export function dailyReviewDir(baseDir, agentId) {
  return join(baseDir, agentId, 'reviews');
}

/**
 * Get file paths for a daily review.
 *
 * @param {string} baseDir
 * @param {string} agentId
 * @param {string} date - Review date (YYYY-MM-DD)
 * @returns {{ markdownPath: string, metadataPath: string }}
 */
export function dailyReviewPaths(baseDir, agentId, date) {
  const dir = dailyReviewDir(baseDir, agentId);
  return {
    markdownPath: join(dir, `daily-${date}.md`),
    metadataPath: join(dir, `daily-${date}.json`),
  };
}

/**
 * Persist a daily review document and its metadata to disk.
 * Creates the reviews directory if it does not exist.
 * Idempotent: re-generating overwrites without duplication.
 *
 * @param {string} baseDir - Root data directory
 * @param {string} agentId
 * @param {string} date - Review date (YYYY-MM-DD)
 * @param {string} markdownContent - Full markdown document
 * @param {object} metadata - Structured review metadata
 * @returns {Promise<{ markdownPath: string, metadataPath: string }>}
 */
export async function persistDailyReview(baseDir, agentId, date, markdownContent, metadata) {
  const dir = dailyReviewDir(baseDir, agentId);
  await mkdir(dir, { recursive: true });

  const paths = dailyReviewPaths(baseDir, agentId, date);
  await Promise.all([
    writeFile(paths.markdownPath, markdownContent, 'utf-8'),
    writeFile(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8'),
  ]);

  return paths;
}

/**
 * Load a previously persisted daily review.
 *
 * @param {string} baseDir
 * @param {string} agentId
 * @param {string} date - Review date (YYYY-MM-DD)
 * @returns {Promise<{ markdown: string, metadata: object } | null>}
 */
export async function loadDailyReview(baseDir, agentId, date) {
  const paths = dailyReviewPaths(baseDir, agentId, date);
  try {
    const [markdown, metaRaw] = await Promise.all([
      readFile(paths.markdownPath, 'utf-8'),
      readFile(paths.metadataPath, 'utf-8'),
    ]);
    return { markdown, metadata: JSON.parse(metaRaw) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * List all daily review dates for an agent, sorted chronologically.
 *
 * @param {string} baseDir
 * @param {string} agentId
 * @returns {Promise<string[]>} Array of YYYY-MM-DD date strings
 */
export async function listDailyReviews(baseDir, agentId) {
  const dir = dailyReviewDir(baseDir, agentId);
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.startsWith('daily-') && f.endsWith('.md'))
      .map((f) => f.slice('daily-'.length, -'.md'.length))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Metadata builder
// ---------------------------------------------------------------------------

/**
 * Build structured metadata for a daily review (persisted as JSON alongside markdown).
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.date - Review date (YYYY-MM-DD)
 * @param {string} opts.week - ISO week string
 * @param {string} opts.generatedAt - ISO datetime
 * @param {object[]} opts.tasks - Day tasks collected by collectDayTasks
 * @param {object[]} opts.adjustments - Adjustment records from buildAdjustmentsForTomorrow
 * @returns {object} Structured review metadata
 */
export function buildDailyReviewMetadata({ agentId, date, week, generatedAt, tasks, adjustments }) {
  const byStatus = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }

  return {
    agentId,
    date,
    week,
    generatedAt,
    summary: {
      totalTasks: tasks.length,
      completedTasks: byStatus.completed || 0,
      pendingTasks: byStatus.pending || 0,
      inProgressTasks: byStatus['in-progress'] || 0,
      failedTasks: byStatus.failed || 0,
      skippedTasks: byStatus.skipped || 0,
      delegatedTasks: byStatus.delegated || 0,
      adjustmentCount: adjustments.length,
    },
    tasks: tasks.map((t) => ({
      taskId: t.id,
      title: t.title,
      status: t.status,
      objectiveId: t.objectiveId || null,
      priority: t.priority || 'medium',
    })),
    adjustments: adjustments.map((a) => ({
      type: a.type,
      taskId: a.taskId,
      title: a.title,
    })),
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate a complete daily review for an agent on a given date.
 *
 * Orchestration steps:
 * 1. Load agent identity for the document header
 * 2. Load the weekly plan for the week containing the target date
 * 3. Load activity log entries for the week
 * 4. Collect tasks and log entries relevant to the target date
 * 5. Build adjustment proposals in advisor voice
 * 6. Format the three H2 sections (Task Status, Adjustments, Notes)
 * 7. Assemble the full markdown document
 * 8. Build structured JSON metadata
 * 9. Optionally persist both to disk
 * 10. Return document, metadata, and file paths
 *
 * @param {object} deps - Injected store dependencies
 * @param {object} deps.agentStore - AgentStore instance
 * @param {object} deps.weeklyPlanStore - WeeklyPlanStore instance
 * @param {object} deps.activityLogStore - ActivityLogStore instance
 * @param {string} agentId - Agent to generate the review for
 * @param {string} date - Review date (YYYY-MM-DD)
 * @param {object} [opts]
 * @param {string} [opts.week] - ISO week string (auto-derived from date if omitted)
 * @param {string} [opts.tz='UTC'] - IANA time zone for date bucketing
 * @param {string} [opts.generatedAt] - Override generation timestamp
 * @param {string} [opts.baseDir] - Override base directory
 * @param {boolean} [opts.persist=true] - Whether to persist to disk
 * @returns {Promise<{
 *   markdown: string,
 *   metadata: object,
 *   paths: { markdownPath: string, metadataPath: string } | null
 * }>}
 */
export async function generateDailyReview(deps, agentId, date, opts = {}) {
  const { agentStore, weeklyPlanStore, activityLogStore } = deps;
  const tz = opts.tz || 'UTC';
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const persist = opts.persist !== false;
  const baseDir = opts.baseDir || agentStore.baseDir;

  const dayName = weekdayName(date);
  const week = opts.week || dateToISOWeek(date);
  const nextDay = tomorrowWeekdayName(date);

  // 1. Load agent identity for the header
  let agentName = agentId;
  try {
    const agentConfig = await agentStore.load(agentId);
    agentName = agentConfig?.identity?.name || agentConfig?.name || agentId;
  } catch {
    // Agent config may not be loadable — use agentId as fallback
  }

  // 2. Load the active weekly plan for the week containing this date
  let weeklyPlan = null;
  try {
    weeklyPlan = await weeklyPlanStore.load(agentId, week);
  } catch {
    // Plan may not exist yet — generate an empty review
  }

  // 3. Load activity log entries for the week
  // The log is keyed by the week's Monday date
  const weekMonday = isoWeekToMondayDate(week);
  let logEntries = [];
  try {
    logEntries = await activityLogStore.load(agentId, weekMonday);
  } catch {
    // Log may not exist — gracefully default to empty
  }

  // 4. Collect tasks and log entries for the target date
  const dayTasks = collectDayTasks(weeklyPlan, date, tz);
  const dayLogs = collectDayLogEntries(logEntries, date, tz);

  // 5. Build adjustment proposals
  const adjustments = buildAdjustmentsForTomorrow(dayTasks, dayLogs, nextDay);

  // 6. Build the document header
  const header = buildDailyReviewHeader({
    agentId,
    agentName,
    date,
    dayName,
    week,
    generatedAt,
  });

  // 7. Format the three sections
  const taskStatusMd = formatTaskStatusSection(dayTasks, dayLogs);
  const adjustmentsMd = formatAdjustmentsSection(adjustments, nextDay);
  const notesMd = formatNotesSection();

  // 8. Assemble the final document
  const markdown = assembleDailyReview({
    header,
    taskStatus: taskStatusMd,
    adjustments: adjustmentsMd,
    notes: notesMd,
  });

  // 9. Build structured metadata
  const metadata = buildDailyReviewMetadata({
    agentId,
    date,
    week,
    generatedAt,
    tasks: dayTasks,
    adjustments,
  });

  // 10. Persist to disk (unless caller opts out)
  let paths = null;
  if (persist) {
    paths = await persistDailyReview(baseDir, agentId, date, markdown, metadata);
  }

  // 11. Enqueue the proposed adjustments for approval through /aweek:plan.
  //     This runs only when the review was persisted — skip-persist mode (used
  //     by tests and dry-run callers) never writes a pending batch either.
  //     Failures are captured and returned rather than thrown so a storage
  //     error never prevents the caller from seeing the generated review.
  let enqueuedAdjustments = null;
  if (persist && adjustments.length > 0) {
    try {
      enqueuedAdjustments = await enqueueDailyReviewAdjustments({
        baseDir,
        agentId,
        date,
        week,
        adjustmentRecords: adjustments,
        weeklyPlan,
      });
    } catch (err) {
      // Non-fatal: return error context so callers can surface it, but never
      // let a batch-write failure suppress the successfully generated review.
      enqueuedAdjustments = {
        enqueued: false,
        skippedCount: adjustments.length,
        errors: [err.message || String(err)],
      };
    }
  }

  return { markdown, metadata, paths, enqueuedAdjustments };
}
