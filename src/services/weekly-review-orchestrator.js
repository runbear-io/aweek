/**
 * Weekly review orchestrator — assembles all review sections into a final
 * markdown document and persists it to disk.
 *
 * This is the top-level entry point for generating a complete weekly review.
 * It coordinates the individual section generators (completed tasks, metrics,
 * blockers, completion rates, calendar, next week plan) and combines their
 * output into a single structured markdown document.
 *
 * The final document is persisted as:
 *   .aweek/agents/<agentId>/reviews/<week>.md
 *
 * A companion JSON metadata file is also saved:
 *   .aweek/agents/<agentId>/reviews/<week>.json
 *
 * Data sources (all injected):
 *   - WeeklyPlanStore, ActivityLogStore, UsageStore, InboxStore, AgentStore, ArtifactStore
 *
 * Section generators (from sibling modules):
 *   - generateCompletedTasksReview  → Completed Tasks section
 *   - aggregateWeeklyMetrics        → Metrics section
 *   - generateBlockersReview        → Blockers section
 *   - buildCompletionReport + fmt   → Completion Rates section
 *   - aggregateWeeklyData + render  → Calendar section
 *   - generateNextWeekPlanSection   → Next Week section
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateCompletedTasksReview } from './weekly-review-generator.js';
import { aggregateWeeklyMetrics } from './weekly-review-metrics.js';
import { generateBlockersReview } from './blockers-extractor.js';
import {
  buildCompletionReport,
  formatCompletionReport,
} from './completion-rate-calculator.js';
import { aggregateWeeklyData } from './weekly-data-aggregator.js';
import { renderWeeklyCalendar } from './weekly-calendar-renderer.js';
import { generateNextWeekPlanSection } from './next-week-plan-generator.js';

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

/**
 * Compute the next ISO week string from a given week.
 * e.g., "2026-W16" → "2026-W17", "2026-W52" → "2027-W01"
 * @param {string} week - ISO week string (YYYY-Www)
 * @returns {string} Next week string
 */
export function nextISOWeek(week) {
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid ISO week format: ${week}`);
  const year = parseInt(match[1], 10);
  const wk = parseInt(match[2], 10);

  // ISO 8601: a year has 52 or 53 weeks
  const maxWeeks = isoWeeksInYear(year);
  if (wk < maxWeeks) {
    return `${year}-W${String(wk + 1).padStart(2, '0')}`;
  }
  return `${year + 1}-W01`;
}

/**
 * Calculate how many ISO weeks are in a given year.
 * A year has 53 weeks if Jan 1 is Thursday, or Dec 31 is Thursday.
 * @param {number} year
 * @returns {number} 52 or 53
 */
export function isoWeeksInYear(year) {
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dec31 = new Date(Date.UTC(year, 11, 31));
  return jan1.getUTCDay() === 4 || dec31.getUTCDay() === 4 ? 53 : 52;
}

/**
 * Get the Monday date string for a given ISO week.
 * @param {string} isoWeek - e.g. "2026-W16"
 * @returns {string} Monday date string (YYYY-MM-DD)
 */
export function mondayFromISOWeek(isoWeek) {
  const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid ISO week format: ${isoWeek}`);

  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return target.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Review document header
// ---------------------------------------------------------------------------

/**
 * Build the document header for a weekly review.
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.agentName - Human-readable agent name
 * @param {string} opts.week - ISO week string
 * @param {string} opts.weekMonday - Monday date string
 * @param {string} opts.generatedAt - ISO datetime when the review was generated
 * @returns {string} Markdown header
 */
export function buildReviewHeader({ agentId, agentName, week, weekMonday, generatedAt }) {
  const sundayDate = new Date(weekMonday + 'T00:00:00Z');
  sundayDate.setUTCDate(sundayDate.getUTCDate() + 6);
  const sunday = sundayDate.toISOString().slice(0, 10);

  const lines = [];
  lines.push(`# Weekly Review: ${agentName || agentId}`);
  lines.push('');
  lines.push(`**Week:** ${week} (${weekMonday} — ${sunday})`);
  lines.push(`**Agent:** ${agentId}`);
  lines.push(`**Generated:** ${generatedAt}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Assemble full document
// ---------------------------------------------------------------------------

/**
 * Assemble all sections into a final weekly review markdown document.
 *
 * @param {object} sections - Individual section results
 * @param {string} sections.header - Document header markdown
 * @param {string} sections.completedTasks - Completed tasks section markdown
 * @param {string} sections.metrics - Metrics section markdown
 * @param {string} sections.blockers - Blockers section markdown
 * @param {string} sections.completionRates - Completion rates section markdown
 * @param {string} sections.calendar - Calendar section (text-based)
 * @param {string} sections.nextWeek - Next week plan section markdown
 * @returns {string} Complete markdown document
 */
export function assembleReviewDocument(sections) {
  const parts = [];

  // Header is always first
  parts.push(sections.header);

  // Table of Contents
  parts.push('## Table of Contents');
  parts.push('');
  parts.push('1. [Completed Tasks](#completed-tasks)');
  parts.push('2. [Metrics](#metrics)');
  parts.push('3. [Blockers](#blockers)');
  parts.push('4. [Completion Rates](#completion-rates)');
  parts.push('5. [Weekly Calendar](#weekly-calendar)');
  parts.push('6. [Next Week](#next-week)');
  parts.push('');
  parts.push('---');
  parts.push('');

  // Main sections in order
  parts.push(sections.completedTasks);
  parts.push(sections.metrics);
  parts.push(sections.blockers);
  parts.push(sections.completionRates);

  // Calendar is wrapped in a code block for fixed-width rendering
  parts.push('## Weekly Calendar');
  parts.push('');
  parts.push('```');
  parts.push(sections.calendar);
  parts.push('```');
  parts.push('');

  parts.push(sections.nextWeek);

  // Footer
  parts.push('---');
  parts.push('');
  parts.push('_This review was auto-generated by aweek._');
  parts.push('');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Review metadata
// ---------------------------------------------------------------------------

/**
 * Build structured metadata for a review (persisted as JSON alongside the markdown).
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.week
 * @param {string} opts.weekMonday
 * @param {string} opts.generatedAt
 * @param {object} opts.completedTasksData - Structured completed tasks data
 * @param {object} opts.metricsData - Structured metrics data
 * @param {object} opts.blockersData - Structured blockers data
 * @param {object} opts.completionData - Structured completion report data
 * @param {object} opts.nextWeekData - Structured next-week items data
 * @returns {object} Review metadata
 */
export function buildReviewMetadata({
  agentId,
  week,
  weekMonday,
  generatedAt,
  completedTasksData,
  metricsData,
  blockersData,
  completionData,
  nextWeekData,
}) {
  return {
    agentId,
    week,
    weekMonday,
    generatedAt,
    summary: {
      completedTaskCount: completedTasksData?.completedTasks?.length || 0,
      blockerCount: blockersData?.blockers?.length || 0,
      completionRate: completionData?.weekly?.completionRate ?? null,
      effectiveRate: completionData?.weekly?.effectiveRate ?? null,
      totalTokens: metricsData?.metrics?.tokens?.totalTokens || 0,
      costUsd: metricsData?.metrics?.tokens?.costUsd || 0,
      nextWeekItemCount: nextWeekData?.items?.length || 0,
    },
    sections: {
      completedTasks: completedTasksData?.completedTasks || [],
      blockers: blockersData?.blockers || [],
      metrics: metricsData?.metrics || null,
      completion: completionData || null,
      nextWeek: {
        items: nextWeekData?.items || [],
        counts: nextWeekData?.counts || { planned: 0, carryOver: 0, inbox: 0 },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Get the reviews directory for an agent.
 * @param {string} baseDir - Root data directory (e.g., ./.aweek/agents)
 * @param {string} agentId
 * @returns {string}
 */
export function reviewsDir(baseDir, agentId) {
  return join(baseDir, agentId, 'reviews');
}

/**
 * Get the file paths for a review.
 * @param {string} baseDir
 * @param {string} agentId
 * @param {string} week
 * @returns {{ markdownPath: string, metadataPath: string }}
 */
export function reviewPaths(baseDir, agentId, week) {
  const dir = reviewsDir(baseDir, agentId);
  return {
    markdownPath: join(dir, `${week}.md`),
    metadataPath: join(dir, `${week}.json`),
  };
}

/**
 * Persist a weekly review document and its metadata to disk.
 *
 * @param {string} baseDir - Root data directory (e.g., ./.aweek/agents)
 * @param {string} agentId
 * @param {string} week - ISO week string
 * @param {string} markdownContent - Full markdown document
 * @param {object} metadata - Structured review metadata
 * @returns {Promise<{ markdownPath: string, metadataPath: string }>}
 */
export async function persistReview(baseDir, agentId, week, markdownContent, metadata) {
  const dir = reviewsDir(baseDir, agentId);
  await mkdir(dir, { recursive: true });

  const paths = reviewPaths(baseDir, agentId, week);

  await Promise.all([
    writeFile(paths.markdownPath, markdownContent, 'utf-8'),
    writeFile(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8'),
  ]);

  return paths;
}

/**
 * Load a previously persisted review.
 * @param {string} baseDir
 * @param {string} agentId
 * @param {string} week
 * @returns {Promise<{ markdown: string, metadata: object } | null>}
 */
export async function loadReview(baseDir, agentId, week) {
  const paths = reviewPaths(baseDir, agentId, week);
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
 * List all persisted review weeks for an agent.
 * @param {string} baseDir
 * @param {string} agentId
 * @returns {Promise<string[]>} Array of week strings sorted chronologically
 */
export async function listReviews(baseDir, agentId) {
  const dir = reviewsDir(baseDir, agentId);
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace('.md', ''))
      .filter((w) => /^\d{4}-W\d{2}$/.test(w))
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate a complete weekly review for an agent.
 *
 * This is the primary entry point. It:
 * 1. Loads agent identity for the header
 * 2. Runs all section generators in parallel
 * 3. Assembles the final markdown document
 * 4. Persists both markdown and JSON metadata to disk
 * 5. Returns the document and metadata
 *
 * @param {object} deps - Injected store dependencies
 * @param {object} deps.agentStore - AgentStore instance
 * @param {object} deps.weeklyPlanStore - WeeklyPlanStore instance
 * @param {object} deps.activityLogStore - ActivityLogStore instance
 * @param {object} deps.usageStore - UsageStore instance
 * @param {object} deps.inboxStore - InboxStore instance
 * @param {object} [deps.artifactStore] - ArtifactStore instance (optional)
 * @param {string} agentId - Agent to generate the review for
 * @param {string} week - ISO week string (YYYY-Www)
 * @param {object} [opts]
 * @param {string} [opts.weekMonday] - Override Monday date (auto-derived from week if omitted)
 * @param {string} [opts.generatedAt] - Override generation timestamp
 * @param {string} [opts.baseDir] - Override base directory for persistence
 * @param {boolean} [opts.persist=true] - Whether to persist the review to disk
 * @param {boolean} [opts.compactCalendar=false] - Use compact calendar format
 * @returns {Promise<{
 *   markdown: string,
 *   metadata: object,
 *   paths: { markdownPath: string, metadataPath: string } | null
 * }>}
 */
export async function generateWeeklyReview(deps, agentId, week, opts = {}) {
  const {
    agentStore,
    weeklyPlanStore,
    activityLogStore,
    usageStore,
    inboxStore,
  } = deps;

  const weekMonday = opts.weekMonday || mondayFromISOWeek(week);
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const persist = opts.persist !== false;
  const baseDir = opts.baseDir || agentStore.baseDir;
  const nWeek = nextISOWeek(week);

  // 1. Load agent identity for the header
  let agentName = agentId;
  try {
    const agentConfig = await agentStore.load(agentId);
    agentName = agentConfig?.identity?.name || agentConfig?.name || agentId;
  } catch {
    // Agent config may not be loadable — use agentId as fallback
  }

  // 2. Run all section generators in parallel
  const [
    completedTasksResult,
    metricsResult,
    blockersResult,
    weeklyDataResult,
    nextWeekResult,
  ] = await Promise.all([
    generateCompletedTasksReview(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      weekMonday
    ),
    aggregateWeeklyMetrics(
      { activityLogStore, usageStore, inboxStore, weeklyPlanStore, agentStore },
      agentId,
      weekMonday,
      { week }
    ),
    generateBlockersReview(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      weekMonday
    ),
    aggregateWeeklyData(
      { weeklyPlanStore, activityLogStore },
      agentId,
      week,
      { weekMonday }
    ),
    generateNextWeekPlanSection(
      { weeklyPlanStore, inboxStore },
      agentId,
      week,
      nWeek
    ),
  ]);

  // 3. Build completion report from aggregated data
  const completionReport = buildCompletionReport(weeklyDataResult);
  const completionMarkdown = formatCompletionReport(completionReport);

  // 4. Render calendar
  const calendarText = renderWeeklyCalendar(weeklyDataResult, {
    compact: opts.compactCalendar || false,
  });

  // 5. Build document header
  const header = buildReviewHeader({
    agentId,
    agentName,
    week,
    weekMonday,
    generatedAt,
  });

  // 6. Assemble the final document
  const markdown = assembleReviewDocument({
    header,
    completedTasks: completedTasksResult.markdown,
    metrics: metricsResult.markdown,
    blockers: blockersResult.markdown,
    completionRates: completionMarkdown,
    calendar: calendarText,
    nextWeek: nextWeekResult.markdown,
  });

  // 7. Build structured metadata
  const metadata = buildReviewMetadata({
    agentId,
    week,
    weekMonday,
    generatedAt,
    completedTasksData: completedTasksResult,
    metricsData: metricsResult,
    blockersData: blockersResult,
    completionData: completionReport,
    nextWeekData: nextWeekResult,
  });

  // 8. Persist to disk
  let paths = null;
  if (persist) {
    paths = await persistReview(baseDir, agentId, week, markdown, metadata);
  }

  return { markdown, metadata, paths };
}
