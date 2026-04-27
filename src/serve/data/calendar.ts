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
import type { WeeklyPlan, WeeklyTask } from '../../storage/weekly-plan-store.js';
import { ActivityLogStore } from '../../storage/activity-log-store.js';
import type { ActivityLogEntry } from '../../storage/activity-log-store.js';
import { loadConfig } from '../../storage/config-store.js';
import {
  currentWeekKey,
  isValidTimeZone,
  localDayOffset,
  localParts,
  mondayOfWeek,
} from '../../time/zone.js';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const STATUS_KEYS = [
  'pending',
  'in-progress',
  'completed',
  'failed',
  'delegated',
  'skipped',
] as const;

type StatusKey = (typeof STATUS_KEYS)[number];

/** Calendar slot (day/hour) computed for a single task. */
export interface TaskSlot {
  dayKey: (typeof DAY_KEYS)[number];
  dayOffset: number;
  hour: number;
  minute: number;
  iso: string;
}

function countsKey(status: string): string {
  return status === 'in-progress' ? 'inProgress' : status;
}

/**
 * Compute the calendar slot for a task (day/hour in the plan's week).
 * Mirrors `distributeTasks` in `src/skills/weekly-calendar-grid.js` so
 * the dashboard and the CLI `/aweek:calendar` skill agree on placement.
 */
export function computeTaskSlot(
  task: { runAt?: string } | null | undefined,
  weekMonday: Date,
  timeZone: string,
): TaskSlot | null {
  if (!task || typeof task.runAt !== 'string' || task.runAt.length === 0) {
    return null;
  }
  const ms = Date.parse(task.runAt);
  if (Number.isNaN(ms)) return null;

  const useLocalTz =
    typeof timeZone === 'string' && timeZone !== 'UTC' && isValidTimeZone(timeZone);

  let dayOffset: number;
  let hour: number;
  let minute: number;
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
    dayKey: DAY_KEYS[dayOffset]!,
    dayOffset,
    hour,
    minute,
    iso: new Date(ms).toISOString(),
  };
}

/** Projected task shape returned to the SPA. */
export interface ProjectedTask {
  id: string;
  title: string;
  prompt: string | null;
  status: string;
  priority: string | null;
  estimatedMinutes: number | null;
  objectiveId: string | null;
  track: string | null;
  runAt: string | null;
  completedAt: string | null;
  delegatedTo: string | null;
  slot: TaskSlot | null;
}

function projectTask(
  task: WeeklyTask,
  weekMonday: Date | null,
  timeZone: string,
): ProjectedTask {
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

/** Per-status counts surfaced under `counts` in the calendar payload. */
export interface CalendarCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  delegated: number;
  skipped: number;
  other: number;
  [key: string]: number;
}

function summariseStatuses(tasks: WeeklyTask[]): CalendarCounts {
  const counts: CalendarCounts = {
    total: tasks.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    delegated: 0,
    skipped: 0,
    other: 0,
  };
  for (const t of tasks) {
    const key = (STATUS_KEYS as readonly string[]).includes(t.status)
      ? countsKey(t.status)
      : 'other';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Resolution outcome — either a usable plan, or a `loadError` capturing
 * the on-disk failure (schema validation, parse error) so the dashboard
 * can surface it instead of silently degrading to "no plan".
 *
 * Fallback-strategy errors (the `loadLatestApproved` / `loadAll` probes
 * we run when no week was explicitly requested) stay swallowed — those
 * are best-effort. We only surface the failure for the *targeted* load
 * (the requested week, or the timezone-aware current week), because
 * that's the one a user expects to see.
 */
interface PlanResolution {
  plan: WeeklyPlan | null;
  loadError: string | null;
}

function describeLoadError(err: unknown, week: string): string {
  const base = err instanceof Error && err.message ? err.message : String(err);
  return `Weekly plan for ${week} failed to load: ${base}`;
}

async function resolvePlan(
  store: WeeklyPlanStore,
  agentId: string,
  requested: string | undefined,
  timeZone: string | undefined,
  now: Date,
): Promise<PlanResolution> {
  if (requested) {
    try {
      const plan = await store.load(agentId, requested);
      return { plan: plan ?? null, loadError: null };
    } catch (err) {
      return { plan: null, loadError: describeLoadError(err, requested) };
    }
  }
  const week = currentWeekKey(timeZone || 'UTC', now);
  let directLoadError: string | null = null;
  let direct: WeeklyPlan | null = null;
  try {
    direct = (await store.load(agentId, week)) ?? null;
  } catch (err) {
    directLoadError = describeLoadError(err, week);
  }
  if (direct) return { plan: direct, loadError: null };
  const approved = await store.loadLatestApproved(agentId).catch(() => null);
  if (approved) return { plan: approved, loadError: directLoadError };
  const all = await store.loadAll(agentId).catch(() => [] as WeeklyPlan[]);
  return {
    plan: all[all.length - 1] || null,
    loadError: directLoadError,
  };
}

/**
 * Reduce an activity-log entry to the fields the calendar drawer needs.
 * Keeps the JSON payload small and avoids leaking raw stdout blobs.
 */
interface ProjectedActivityEntry {
  id: string;
  timestamp: string;
  status: string;
  title: string;
  duration?: number;
  urls?: string[];
  files?: string[];
  tokens?: number;
  exitCode?: number;
  timedOut?: true;
  errorMessage?: string;
  executionLogBasename?: string;
}

function projectActivityEntry(entry: ActivityLogEntry): ProjectedActivityEntry {
  const meta = (entry && entry.metadata) || {};
  const projected: ProjectedActivityEntry = {
    id: entry.id,
    timestamp: entry.timestamp,
    status: entry.status,
    title: entry.title,
  };
  if (typeof entry.duration === 'number') projected.duration = entry.duration;
  const resources = (meta as { resources?: unknown }).resources as
    | { urls?: unknown; filePaths?: unknown }
    | undefined;
  const urls = Array.isArray(resources?.urls)
    ? (resources.urls as string[]).slice(0, 10)
    : [];
  const files = Array.isArray(resources?.filePaths)
    ? (resources.filePaths as string[]).slice(0, 10)
    : [];
  if (urls.length > 0) projected.urls = urls;
  if (files.length > 0) projected.files = files;
  const tokens = pickTotalTokens((meta as { tokenUsage?: unknown }).tokenUsage);
  if (tokens !== null) projected.tokens = tokens;
  const execution = (meta as { execution?: unknown }).execution as
    | { exitCode?: unknown; timedOut?: unknown; executionLogPath?: unknown }
    | undefined;
  if (execution && typeof execution.exitCode === 'number') {
    projected.exitCode = execution.exitCode;
  }
  if (execution && execution.timedOut === true) {
    projected.timedOut = true;
  }
  const error = (meta as { error?: unknown }).error as
    | { message?: unknown }
    | undefined;
  if (
    entry.status === 'failed' &&
    error &&
    typeof error.message === 'string'
  ) {
    projected.errorMessage = error.message.slice(0, 400);
  }
  const tPath = execution && execution.executionLogPath;
  if (typeof tPath === 'string' && tPath.endsWith('.jsonl')) {
    const slash = tPath.lastIndexOf('/');
    const file = slash >= 0 ? tPath.slice(slash + 1) : tPath;
    projected.executionLogBasename = file.slice(0, -'.jsonl'.length);
  }
  return projected;
}

function pickTotalTokens(tokenUsage: unknown): number | null {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const tu = tokenUsage as Record<string, unknown>;
  if (typeof tu.totalTokens === 'number') return tu.totalTokens;
  if (typeof tu.total === 'number') return tu.total;
  const input = typeof tu.inputTokens === 'number' ? tu.inputTokens : 0;
  const output = typeof tu.outputTokens === 'number' ? tu.outputTokens : 0;
  const cacheWrite =
    typeof tu.cacheCreationInputTokens === 'number'
      ? tu.cacheCreationInputTokens
      : 0;
  const cacheRead =
    typeof tu.cacheReadInputTokens === 'number'
      ? tu.cacheReadInputTokens
      : 0;
  const sum = input + output + cacheWrite + cacheRead;
  return sum > 0 ? sum : null;
}

/** Options accepted by {@link gatherTaskActivity}. */
export interface GatherTaskActivityOptions {
  projectDir?: string;
  slug?: string;
  perTaskLimit?: number;
}

/**
 * Group recent activity-log entries by task id so the calendar view can
 * render per-task history without an extra round-trip.
 */
export async function gatherTaskActivity({
  projectDir,
  slug,
  perTaskLimit = 10,
}: GatherTaskActivityOptions = {}): Promise<Record<string, ProjectedActivityEntry[]>> {
  if (!projectDir || !slug) return {};
  const agentsDir = join(projectDir, '.aweek', 'agents');
  const store = new ActivityLogStore(agentsDir);

  let weeks: string[];
  try {
    weeks = await store.listWeeks(slug);
  } catch {
    return {};
  }

  const perWeek = await Promise.all(
    weeks.map((week) => store.load(slug, week).catch(() => [] as ActivityLogEntry[])),
  );
  const entries = perWeek.flat();
  if (entries.length === 0) return {};

  entries.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta;
  });

  const byTask: Record<string, ProjectedActivityEntry[]> = {};
  for (const entry of entries) {
    if (!entry || !entry.taskId) continue;
    const bucket = byTask[entry.taskId] || (byTask[entry.taskId] = []);
    if (bucket.length >= perTaskLimit) continue;
    bucket.push(projectActivityEntry(entry));
  }
  return byTask;
}

/** Options accepted by {@link gatherAgentCalendar}. */
export interface GatherAgentCalendarOptions {
  projectDir?: string;
  slug?: string;
  /** Optional ISO week override (YYYY-Www). */
  week?: string;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

/** Calendar payload returned to the SPA. */
export interface AgentCalendarPayload {
  agentId: string;
  week: string | null;
  month: string | null;
  approved: boolean;
  timeZone: string;
  weekMonday: string | null;
  noPlan: boolean;
  /**
   * Set when the targeted weekly-plan file failed to load (schema
   * validation, JSON parse, …). The dashboard surfaces this as a
   * destructive banner so users can tell the difference between
   * "no plan exists" and "plan exists but the validator rejected it".
   */
  loadError: string | null;
  tasks: ProjectedTask[];
  counts: CalendarCounts;
  activityByTask: Record<string, ProjectedActivityEntry[]>;
}

/** "Not found" sentinel returned when the slug is unknown. */
export interface AgentCalendarNotFound {
  notFound: true;
  agentId: string;
}

/**
 * Gather a single agent's current-week calendar payload.
 *
 * Returns `{ notFound: true, agentId }` when the slug is unknown on
 * disk so the HTTP layer can map it to 404. When the agent exists but
 * no weekly plan is present, returns `noPlan: true` with an empty task
 * list so the SPA can still render a useful empty state.
 */
export async function gatherAgentCalendar(
  { projectDir, slug, week, now }: GatherAgentCalendarOptions = {},
): Promise<AgentCalendarPayload | AgentCalendarNotFound> {
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
  const { plan, loadError } = await resolvePlan(
    planStore,
    slug,
    week,
    timeZone,
    clock,
  );

  if (!plan) {
    return {
      agentId: slug,
      week: null,
      month: null,
      approved: false,
      timeZone,
      weekMonday: null,
      noPlan: true,
      loadError,
      tasks: [],
      counts: summariseStatuses([]),
      activityByTask: {},
    };
  }

  let weekMonday: Date | null = null;
  try {
    weekMonday = mondayOfWeek(
      plan.week,
      timeZone && timeZone !== 'UTC' ? timeZone : 'UTC',
    );
  } catch {
    weekMonday = null;
  }

  const rawTasks: WeeklyTask[] = Array.isArray(plan.tasks) ? plan.tasks : [];
  const tasks = rawTasks.map((t) => projectTask(t, weekMonday, timeZone));

  // Task-level activity is co-gathered so the calendar drawer does not
  // require a second HTTP round-trip. Errors are absorbed — a malformed
  // log must never knock the calendar offline.
  const activityByTask = await gatherTaskActivity({
    projectDir,
    slug,
  }).catch(() => ({} as Record<string, ProjectedActivityEntry[]>));

  return {
    agentId: slug,
    week: plan.week,
    month: plan.month || null,
    approved: !!plan.approved,
    timeZone,
    weekMonday: weekMonday ? weekMonday.toISOString() : null,
    noPlan: false,
    loadError,
    tasks,
    counts: summariseStatuses(rawTasks),
    activityByTask,
  };
}
