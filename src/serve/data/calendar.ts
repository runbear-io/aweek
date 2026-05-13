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
import { RecurringTaskStore } from '../../storage/recurring-task-store.js';
import type { RecurringTask } from '../../storage/recurring-task-store.js';
import { expandForWindow } from '../../services/recurrence-expander.js';
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
  /** Verifier verdict — `false` means the agent did not achieve the
   * stated outcome despite a clean session exit. Absent when the
   * verifier hasn't run yet (pre-`completed`) or skipped. */
  outcomeAchieved: boolean | null;
  /** Verifier-flagged concerns. May be non-empty even when
   * `outcomeAchieved === true` (defensive flagging). */
  warnings: string[];
  slot: TaskSlot | null;
}

function projectTask(
  task: WeeklyTask,
  weekMonday: Date | null,
  timeZone: string,
): ProjectedTask {
  const slot = weekMonday ? computeTaskSlot(task, weekMonday, timeZone) : null;
  const warnings = Array.isArray(task.warnings)
    ? task.warnings.filter(
        (w): w is string => typeof w === 'string' && w.length > 0,
      )
    : [];
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
    outcomeAchieved:
      typeof task.outcomeAchieved === 'boolean' ? task.outcomeAchieved : null,
    warnings,
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

/**
 * `true` for "the file doesn't exist" — that's a perfectly normal state
 * (next week's plan hasn't been generated yet), not a load failure. The
 * gatherer surfaces it as `noPlan: true` with a `null` `loadError` so
 * the SPA renders the soft empty state, not the destructive banner.
 */
function isMissingFileError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT';
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
      // Missing file is a normal state for a not-yet-generated week —
      // surface it as `noPlan` rather than a destructive validator banner.
      if (isMissingFileError(err)) {
        return { plan: null, loadError: null };
      }
      return { plan: null, loadError: describeLoadError(err, requested) };
    }
  }
  const week = currentWeekKey(timeZone || 'UTC', now);
  let directLoadError: string | null = null;
  let direct: WeeklyPlan | null = null;
  try {
    direct = (await store.load(agentId, week)) ?? null;
  } catch (err) {
    if (!isMissingFileError(err)) {
      directLoadError = describeLoadError(err, week);
    }
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
  // Bind the optional-chain results to locals so TS can narrow them inside
  // the Array.isArray branches; otherwise it flags `resources.urls` as
  // possibly-undefined access on every read.
  const rawUrls = resources?.urls;
  const urls = Array.isArray(rawUrls) ? (rawUrls as string[]).slice(0, 10) : [];
  const rawFiles = resources?.filePaths;
  const files = Array.isArray(rawFiles) ? (rawFiles as string[]).slice(0, 10) : [];
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
 * Build a deterministic ISO-week month key (`YYYY-MM`) from the local
 * Monday of the week. Matches the convention used by
 * `recurring-materializer` and `WeeklyPlanStore`: the month that owns
 * the Monday of the ISO week (not the calendar-month majority of the
 * seven days).
 */
function monthFromMonday(weekMonday: Date, timeZone: string): string {
  try {
    const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
    const p = localParts(weekMonday, tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}`;
  } catch {
    const y = weekMonday.getUTCFullYear();
    const m = weekMonday.getUTCMonth() + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
  }
}

/**
 * Project a recurrence-expander {@link Occurrence} into the WeeklyTask
 * shape the calendar UI consumes. Templates carry over verbatim with no
 * override (the materializer handles per-occurrence overrides at tick
 * time; the SPA lazy view shows the canonical recurring task as-is).
 */
function occurrenceToTask(
  record: RecurringTask,
  occurrence: { id: string; runAt: string },
): WeeklyTask {
  const template = record.template;
  const task: WeeklyTask = {
    id: occurrence.id,
    title: template.title,
    prompt: template.prompt,
    status: 'pending',
    runAt: occurrence.runAt,
  };
  if (template.objectiveId !== undefined) task.objectiveId = template.objectiveId;
  if (template.priority !== undefined) task.priority = template.priority;
  if (template.estimatedMinutes !== undefined) {
    task.estimatedMinutes = template.estimatedMinutes;
  }
  if (template.track !== undefined) task.track = template.track;
  return task;
}

/**
 * Lazily expand every per-agent RecurringTask into the WeeklyTask[] that
 * fire inside the given ISO week. Pure read — no on-disk writes. Used
 * by `gatherAgentCalendar` to keep the dashboard's "render every week"
 * promise even when no on-disk weekly-plans/<YYYY-Www>.json file exists.
 *
 * Errors are absorbed: a corrupt recurring-tasks.json must not knock the
 * calendar offline (the agent-list `issues` banner surfaces those).
 */
async function gatherRecurringOccurrences(
  dataDir: string,
  agentId: string,
  weekMonday: Date,
  timeZone: string,
): Promise<WeeklyTask[]> {
  let records: RecurringTask[];
  try {
    const store = new RecurringTaskStore(dataDir);
    records = await store.loadAll(agentId);
  } catch {
    return [];
  }
  if (records.length === 0) return [];

  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const out: WeeklyTask[] = [];
  for (const record of records) {
    let occurrences;
    try {
      occurrences = expandForWindow(record.rule, weekMonday, tz, record.id);
    } catch {
      // Skip a single malformed rule rather than failing the whole grid.
      continue;
    }
    for (const occ of occurrences) {
      out.push(occurrenceToTask(record, occ));
    }
  }
  // Sort by runAt (ascending) so identical inputs always produce the
  // same task ordering. Stable for cross-render hydration.
  out.sort((a, b) => {
    const aRun = a.runAt ?? '';
    const bRun = b.runAt ?? '';
    if (aRun !== bRun) return aRun < bRun ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return out;
}

/**
 * Gather a single agent's current-week calendar payload.
 *
 * Returns `{ notFound: true, agentId }` when the slug is unknown on
 * disk so the HTTP layer can map it to 404.
 *
 * When the agent exists but no on-disk weekly-plan file is present, the
 * gatherer still renders a usable grid: it derives `week`/`weekMonday`
 * from the requested (or current) ISO week and lazily expands any
 * per-agent recurring rules into that window. Per AC8, the response is
 * `noPlan: false, tasks: []` when no plan AND no occurrences exist —
 * the SPA renders the full empty grid (prev/next/today nav, hour rows,
 * day columns) rather than the destructive "no plan yet" banner.
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

  // Resolve the week key + Monday anchor independent of whether a plan
  // file exists. AC8 requires the calendar grid to render for every
  // week the user navigates to, with recurring occurrences visible —
  // even when no `weekly-plans/<YYYY-Www>.json` file exists yet.
  const tzForWeek = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const resolvedWeek = plan?.week
    ?? week
    ?? currentWeekKey(tzForWeek, clock);
  let weekMonday: Date | null = null;
  try {
    weekMonday = mondayOfWeek(resolvedWeek, tzForWeek);
  } catch {
    weekMonday = null;
  }

  // Task-level activity is co-gathered so the calendar drawer does not
  // require a second HTTP round-trip. Errors are absorbed — a malformed
  // log must never knock the calendar offline.
  const activityByTask = await gatherTaskActivity({
    projectDir,
    slug,
  }).catch(() => ({} as Record<string, ProjectedActivityEntry[]>));

  // Lazily expand recurring tasks for the resolved week. Idempotent and
  // pure with respect to the on-disk weekly-plan file (we do NOT write
  // a materialized plan from the read path — that's the heartbeat
  // materializer's job). When a plan file already exists, the file's
  // tasks pass through verbatim and recurring occurrences merge in only
  // for ids that aren't already present (so a materialized occurrence
  // surfaces with its real status, not the lazy `pending` clone).
  const recurringTasks = weekMonday
    ? await gatherRecurringOccurrences(dataDir, slug, weekMonday, timeZone)
    : [];

  if (!plan) {
    // AC8: no on-disk plan AND no recurring occurrences → noPlan:false,
    // tasks:[] so the SPA still renders the full empty grid. When
    // occurrences exist they surface as pending tasks with computed
    // slots, identical to a regular weekly-plan task.
    const tasks = recurringTasks.map((t) => projectTask(t, weekMonday, timeZone));
    return {
      agentId: slug,
      week: resolvedWeek,
      month: weekMonday ? monthFromMonday(weekMonday, timeZone) : null,
      approved: false,
      timeZone,
      weekMonday: weekMonday ? weekMonday.toISOString() : null,
      noPlan: false,
      loadError,
      tasks,
      counts: summariseStatuses(recurringTasks),
      activityByTask,
    };
  }

  const rawTasks: WeeklyTask[] = Array.isArray(plan.tasks) ? plan.tasks : [];
  // Merge recurring occurrences that aren't already present in the plan
  // (the materializer's eager job may have already merged them — in
  // which case the on-disk version wins and the lazy clone is dropped).
  const existingIds = new Set(rawTasks.map((t) => t.id));
  const extraRecurring = recurringTasks.filter((t) => !existingIds.has(t.id));
  const allTasks: WeeklyTask[] = [...rawTasks, ...extraRecurring];
  const tasks = allTasks.map((t) => projectTask(t, weekMonday, timeZone));

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
    counts: summariseStatuses(allTasks),
    activityByTask,
  };
}
