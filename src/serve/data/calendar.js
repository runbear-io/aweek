/**
 * Calendar data source for the SPA dashboard.
 *
 * Read-only JSON gatherer for the weekly calendar / task list view.
 * Exclusively sources from existing `src/storage/*` stores — no writes,
 * no new persistence.
 *
 * Data sources (all read-only):
 *   - `AgentStore.load`           → `src/storage/agent-store.js`
 *   - `WeeklyPlanStore.load/loadAll/loadLatestApproved`
 *                                 → `src/storage/weekly-plan-store.js`
 *   - `ActivityLogStore.listWeeks/load`
 *                                 → `src/storage/activity-log-store.js`
 *   - `loadConfig`                → `src/storage/config-store.js`
 *   - Time helpers                → `src/time/zone.js` (pure, stateless)
 *
 * Returned shape:
 *   {
 *     agentId, week, month, approved, timeZone, weekMonday, noPlan,
 *     tasks: [{ id, title, prompt, status, priority, estimatedMinutes,
 *               objectiveId, track, runAt, completedAt, delegatedTo,
 *               slot: { dayKey, dayOffset, hour, minute, iso } | null }],
 *     counts: { total, pending, inProgress, completed, failed,
 *               delegated, skipped, other },
 *     activityByTask: { <taskId>: [{ id, timestamp, status, ... }] }
 *   }
 */

import { join } from 'node:path';
import { AgentStore } from '../../storage/agent-store.js';
import { WeeklyPlanStore } from '../../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../../storage/activity-log-store.js';
import { loadConfig } from '../../storage/config-store.js';
import {
  currentWeekKey,
  isValidTimeZone,
  localDayOffset,
  localParts,
  mondayOfWeek,
} from '../../time/zone.js';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const STATUS_KEYS = [
  'pending',
  'in-progress',
  'completed',
  'failed',
  'delegated',
  'skipped',
];

function countsKey(status) {
  return status === 'in-progress' ? 'inProgress' : status;
}

/**
 * Compute the calendar slot for a task (day/hour in the plan's week).
 * Mirrors `distributeTasks` in `src/skills/weekly-calendar-grid.js` so
 * the dashboard and the CLI `/aweek:calendar` skill agree on placement.
 *
 * @param {{ runAt?: string }} task
 * @param {Date} weekMonday
 * @param {string} timeZone
 * @returns {object | null}
 */
export function computeTaskSlot(task, weekMonday, timeZone) {
  if (!task || typeof task.runAt !== 'string' || task.runAt.length === 0) {
    return null;
  }
  const ms = Date.parse(task.runAt);
  if (Number.isNaN(ms)) return null;

  const useLocalTz =
    typeof timeZone === 'string' && timeZone !== 'UTC' && isValidTimeZone(timeZone);

  let dayOffset;
  let hour;
  let minute;
  if (useLocalTz) {
    dayOffset = localDayOffset(ms, weekMonday, timeZone);
    const parts = localParts(ms, timeZone);
    hour = parts.hour;
    minute = parts.minute;
  } else {
    const weekStartMs = Date.UTC(
      weekMonday.getUTCFullYear(),
      weekMonday.getUTCMonth(),
      weekMonday.getUTCDate(),
    );
    dayOffset = Math.floor((ms - weekStartMs) / 86_400_000);
    const d = new Date(ms);
    hour = d.getUTCHours();
    minute = d.getUTCMinutes();
  }

  if (!Number.isFinite(dayOffset) || dayOffset < 0 || dayOffset > 6) {
    return null;
  }
  return {
    dayKey: DAY_KEYS[dayOffset],
    dayOffset,
    hour,
    minute,
    iso: new Date(ms).toISOString(),
  };
}

function projectTask(task, weekMonday, timeZone) {
  const slot = weekMonday ? computeTaskSlot(task, weekMonday, timeZone) : null;
  return {
    id: task.id,
    title: task.title,
    prompt: typeof task.prompt === 'string' ? task.prompt : null,
    status: task.status,
    priority: task.priority || null,
    estimatedMinutes:
      typeof task.estimatedMinutes === 'number' ? task.estimatedMinutes : null,
    objectiveId: task.objectiveId || null,
    track: task.track || null,
    runAt: typeof task.runAt === 'string' ? task.runAt : null,
    completedAt:
      typeof task.completedAt === 'string' ? task.completedAt : null,
    delegatedTo:
      typeof task.delegatedTo === 'string' ? task.delegatedTo : null,
    slot,
  };
}

function summariseStatuses(tasks) {
  const counts = { total: tasks.length };
  for (const key of STATUS_KEYS) counts[countsKey(key)] = 0;
  counts.other = 0;
  for (const t of tasks) {
    const key = STATUS_KEYS.includes(t.status) ? countsKey(t.status) : 'other';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function resolvePlan(store, agentId, requested, timeZone, now) {
  if (requested) {
    return store.load(agentId, requested).catch(() => null);
  }
  const week = currentWeekKey(timeZone || 'UTC', now);
  const direct = await store.load(agentId, week).catch(() => null);
  if (direct) return direct;
  const approved = await store.loadLatestApproved(agentId).catch(() => null);
  if (approved) return approved;
  const all = await store.loadAll(agentId).catch(() => []);
  return all[all.length - 1] || null;
}

/**
 * Reduce an activity-log entry to the fields the calendar drawer needs.
 * Keeps the JSON payload small and avoids leaking raw stdout blobs.
 *
 * @param {object} entry
 * @returns {object}
 */
function projectActivityEntry(entry) {
  const meta = (entry && entry.metadata) || {};
  const projected = {
    id: entry.id,
    timestamp: entry.timestamp,
    status: entry.status,
    title: entry.title,
  };
  if (typeof entry.duration === 'number') projected.duration = entry.duration;
  const urls = Array.isArray(meta.resources?.urls)
    ? meta.resources.urls.slice(0, 10)
    : [];
  const files = Array.isArray(meta.resources?.filePaths)
    ? meta.resources.filePaths.slice(0, 10)
    : [];
  if (urls.length > 0) projected.urls = urls;
  if (files.length > 0) projected.files = files;
  const tokens = pickTotalTokens(meta.tokenUsage);
  if (tokens !== null) projected.tokens = tokens;
  if (meta.execution && typeof meta.execution.exitCode === 'number') {
    projected.exitCode = meta.execution.exitCode;
  }
  if (meta.execution && meta.execution.timedOut === true) {
    projected.timedOut = true;
  }
  if (
    entry.status === 'failed' &&
    meta.error &&
    typeof meta.error.message === 'string'
  ) {
    projected.errorMessage = meta.error.message.slice(0, 400);
  }
  const tPath = meta.execution && meta.execution.executionLogPath;
  if (typeof tPath === 'string' && tPath.endsWith('.jsonl')) {
    const slash = tPath.lastIndexOf('/');
    const file = slash >= 0 ? tPath.slice(slash + 1) : tPath;
    projected.executionLogBasename = file.slice(0, -'.jsonl'.length);
  }
  return projected;
}

function pickTotalTokens(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  if (typeof tokenUsage.totalTokens === 'number') return tokenUsage.totalTokens;
  if (typeof tokenUsage.total === 'number') return tokenUsage.total;
  const input =
    typeof tokenUsage.inputTokens === 'number' ? tokenUsage.inputTokens : 0;
  const output =
    typeof tokenUsage.outputTokens === 'number' ? tokenUsage.outputTokens : 0;
  const cacheWrite =
    typeof tokenUsage.cacheCreationInputTokens === 'number'
      ? tokenUsage.cacheCreationInputTokens
      : 0;
  const cacheRead =
    typeof tokenUsage.cacheReadInputTokens === 'number'
      ? tokenUsage.cacheReadInputTokens
      : 0;
  const sum = input + output + cacheWrite + cacheRead;
  return sum > 0 ? sum : null;
}

/**
 * Group recent activity-log entries by task id so the calendar view can
 * render per-task history without an extra round-trip.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} opts.slug
 * @param {number} [opts.perTaskLimit=10]
 * @returns {Promise<Record<string, object[]>>}
 */
export async function gatherTaskActivity({
  projectDir,
  slug,
  perTaskLimit = 10,
} = {}) {
  if (!projectDir || !slug) return {};
  const agentsDir = join(projectDir, '.aweek', 'agents');
  const store = new ActivityLogStore(agentsDir);

  let weeks;
  try {
    weeks = await store.listWeeks(slug);
  } catch {
    return {};
  }

  const perWeek = await Promise.all(
    weeks.map((week) => store.load(slug, week).catch(() => [])),
  );
  const entries = perWeek.flat();
  if (entries.length === 0) return {};

  entries.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta;
  });

  const byTask = {};
  for (const entry of entries) {
    if (!entry || !entry.taskId) continue;
    const bucket = byTask[entry.taskId] || (byTask[entry.taskId] = []);
    if (bucket.length >= perTaskLimit) continue;
    bucket.push(projectActivityEntry(entry));
  }
  return byTask;
}

/**
 * Gather a single agent's current-week calendar payload.
 *
 * Returns `{ notFound: true, agentId }` when the slug is unknown on
 * disk so the HTTP layer can map it to 404. When the agent exists but
 * no weekly plan is present, returns `noPlan: true` with an empty task
 * list so the SPA can still render a useful empty state.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} opts.slug
 * @param {string} [opts.week] - Optional ISO week override (YYYY-Www).
 * @param {Date}   [opts.now]  - Injected clock for deterministic tests.
 * @returns {Promise<object>}
 */
export async function gatherAgentCalendar({ projectDir, slug, week, now } = {}) {
  if (!projectDir) throw new Error('gatherAgentCalendar: projectDir is required');
  if (!slug) throw new Error('gatherAgentCalendar: slug is required');
  const dataDir = join(projectDir, '.aweek', 'agents');

  let timeZone = 'UTC';
  try {
    const cfg = await loadConfig(dataDir);
    if (cfg?.timeZone) timeZone = cfg.timeZone;
  } catch {
    /* keep UTC */
  }

  const agentStore = new AgentStore(dataDir);
  try {
    await agentStore.load(slug);
  } catch {
    return { notFound: true, agentId: slug };
  }

  const planStore = new WeeklyPlanStore(dataDir);
  const clock = now instanceof Date ? now : new Date();
  const plan = await resolvePlan(planStore, slug, week, timeZone, clock);

  if (!plan) {
    return {
      agentId: slug,
      week: null,
      month: null,
      approved: false,
      timeZone,
      weekMonday: null,
      noPlan: true,
      tasks: [],
      counts: summariseStatuses([]),
      activityByTask: {},
    };
  }

  let weekMonday = null;
  try {
    weekMonday = mondayOfWeek(
      plan.week,
      timeZone && timeZone !== 'UTC' ? timeZone : 'UTC',
    );
  } catch {
    weekMonday = null;
  }

  const rawTasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const tasks = rawTasks.map((t) => projectTask(t, weekMonday, timeZone));

  // Task-level activity is co-gathered so the calendar drawer does not
  // require a second HTTP round-trip. Errors are absorbed — a malformed
  // log must never knock the calendar offline.
  const activityByTask = await gatherTaskActivity({
    projectDir,
    slug,
  }).catch(() => ({}));

  return {
    agentId: slug,
    week: plan.week,
    month: plan.month || null,
    approved: !!plan.approved,
    timeZone,
    weekMonday: weekMonday ? weekMonday.toISOString() : null,
    noPlan: false,
    tasks,
    counts: summariseStatuses(rawTasks),
    activityByTask,
  };
}
