/**
 * Calendar section — data gathering for the `aweek serve` dashboard's
 * "Weekly calendar" card.
 *
 * This module is the sub-AC 1 counterpart of `agents-section.js`: it reads
 * live data from `.aweek/` on every call (no caching) and returns a JSON
 * payload describing one agent's current-week task list with status and
 * time-slot placement. The HTTP layer (`server.js`) wires a
 * `GET /api/agents/:slug/calendar` route that returns this payload as
 * `application/json`; later sub-ACs will render it into the dashboard's
 * calendar card.
 *
 * Contract — returned shape
 * -------------------------
 *   {
 *     agentId: "<slug>",
 *     week: "YYYY-Www" | null,      // null when no plan could be found
 *     month: "YYYY-MM" | null,
 *     approved: boolean,
 *     timeZone: "America/Los_Angeles" | "UTC",
 *     weekMonday: "<iso utc>" | null,
 *     noPlan: boolean,              // true when the agent has no matching plan
 *     tasks: [Task, ...],
 *     counts: { total, pending, inProgress, completed, failed, delegated, skipped },
 *   }
 *
 *   Task = {
 *     id, description, status, priority, estimatedMinutes,
 *     objectiveId, track, runAt, completedAt, delegatedTo,
 *     slot: { dayKey, dayOffset, hour, minute, iso } | null
 *   }
 *
 * The `slot` field is populated only when the task carries a `runAt` and
 * that `runAt` falls inside the plan's week. Unscheduled tasks (no `runAt`
 * or `runAt` outside the week) carry `slot: null` so the dashboard can
 * render them in an "unscheduled" bucket without the client needing to
 * re-derive day/hour itself.
 *
 * Errors are reported as a predicate result rather than thrown: a missing
 * agent, a malformed plan, or a missing week returns a payload with
 * `noPlan: true` and an empty task list so the dashboard still renders.
 * Genuine error cases (unknown agent slug) are surfaced via
 * `gatherCalendar` returning `{ notFound: true }` so the HTTP layer can
 * map them to a 404.
 */

import { join } from 'node:path';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { loadConfig } from '../storage/config-store.js';
import { listAllAgents } from '../storage/agent-helpers.js';
import { readSubagentIdentity } from '../subagents/subagent-file.js';
import {
  currentWeekKey,
  isValidTimeZone,
  localDayOffset,
  localHour,
  localParts,
  mondayOfWeek,
} from '../time/zone.js';

/** Day-of-week keys used by the calendar grid — Monday-origin, ISO-style. */
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** All known task statuses — used to shape the counts summary. */
const STATUS_KEYS = [
  'pending',
  'in-progress',
  'completed',
  'failed',
  'delegated',
  'skipped',
];

/**
 * Camel-case the counts-summary field name for a given status so the JSON
 * payload plays nicely with JavaScript destructuring on the client. Keeps
 * the raw storage enum (`in-progress`) stable while exposing a clean
 * `inProgress` property on the wire.
 *
 * @param {string} status
 * @returns {string}
 */
function countsKey(status) {
  if (status === 'in-progress') return 'inProgress';
  return status;
}

/**
 * Compute the calendar slot for a task, if its `runAt` pins it to a
 * specific day/hour inside the plan's week. Returns `null` when the task
 * has no `runAt`, the `runAt` is unparseable, or falls outside the
 * visible week window.
 *
 * The result mirrors the day-column coordinates the CLI grid renderer
 * already produces (see `distributeTasks` in `weekly-calendar-grid.js`)
 * so the dashboard and the `/aweek:calendar` skill agree on where a
 * task lands.
 *
 * @param {{ runAt?: string }} task
 * @param {Date} weekMonday - UTC Date for Monday 00:00 *local* of the week
 * @param {string} timeZone - IANA zone name; `'UTC'` disables projection
 * @returns {{
 *   dayKey: 'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun',
 *   dayOffset: 0|1|2|3|4|5|6,
 *   hour: number,
 *   minute: number,
 *   iso: string,
 * } | null}
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
    // Fall back to UTC day arithmetic so callers without a configured
    // zone still get a stable placement.
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

/**
 * Project a weekly-plan task onto the wire shape the dashboard consumes.
 * Normalises optional fields to `null` so the client never has to guard
 * against `undefined`, and attaches the computed `slot`.
 *
 * @param {object} task - raw task from the weekly-plan store
 * @param {Date|null} weekMonday
 * @param {string} timeZone
 * @returns {object}
 */
function projectTask(task, weekMonday, timeZone) {
  const slot = weekMonday ? computeTaskSlot(task, weekMonday, timeZone) : null;
  return {
    id: task.id,
    description: task.description,
    status: task.status,
    priority: task.priority || null,
    estimatedMinutes:
      typeof task.estimatedMinutes === 'number' ? task.estimatedMinutes : null,
    objectiveId: task.objectiveId || null,
    track: task.track || null,
    runAt: typeof task.runAt === 'string' ? task.runAt : null,
    completedAt: typeof task.completedAt === 'string' ? task.completedAt : null,
    delegatedTo: typeof task.delegatedTo === 'string' ? task.delegatedTo : null,
    slot,
  };
}

/**
 * Build the zero-filled counts summary, then increment per task status.
 * Unknown statuses land in `other` so a drifting schema doesn't silently
 * drop information.
 *
 * @param {Array<{ status: string }>} tasks
 * @returns {Record<string, number>}
 */
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

/**
 * Resolve which week the dashboard should show for the given agent.
 *
 * Precedence:
 *   1. Explicit `week` argument (e.g. `?week=2026-W17` query string).
 *   2. The agent's *current* ISO-week key in the configured time zone.
 *   3. If no plan exists for that week, fall back to the most recently
 *      approved plan so an agent with stale data still renders.
 *   4. If no approved plan exists either, fall back to the newest plan on
 *      disk regardless of approval state — useful for operators who
 *      haven't yet run `/aweek:plan` on a freshly generated plan.
 *
 * Returning `null` signals "no plan to show"; the caller emits
 * `noPlan: true` with an empty task list.
 *
 * @param {WeeklyPlanStore} store
 * @param {string} agentId
 * @param {string | undefined} requested
 * @param {string} timeZone
 * @param {Date} now
 * @returns {Promise<object | null>}
 */
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
 * Read one agent's calendar payload.
 *
 * This is the single entry point the HTTP layer calls. It absorbs
 * filesystem errors so the dashboard never 500s on a malformed fixture —
 * at worst an agent renders with `noPlan: true`. The one exception is a
 * genuinely unknown agent slug: we return `{ notFound: true }` so the
 * HTTP layer can map it to a 404.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Project root (contains `.aweek/`).
 * @param {string} opts.agentId - Agent slug to render.
 * @param {string} [opts.week] - Optional explicit ISO week key override.
 * @param {Date} [opts.now] - Injected clock for deterministic tests.
 * @returns {Promise<
 *   { notFound: true, agentId: string } |
 *   {
 *     agentId: string,
 *     week: string | null,
 *     month: string | null,
 *     approved: boolean,
 *     timeZone: string,
 *     weekMonday: string | null,
 *     noPlan: boolean,
 *     tasks: Array<object>,
 *     counts: Record<string, number>,
 *   }
 * >}
 */
export async function gatherCalendar({ projectDir, agentId, week, now } = {}) {
  if (!projectDir) throw new Error('gatherCalendar: projectDir is required');
  if (!agentId) throw new Error('gatherCalendar: agentId is required');

  const dataDir = join(projectDir, '.aweek', 'agents');

  // Config load is best-effort: a malformed config.json should not prevent
  // the dashboard from rendering in UTC.
  let timeZone = 'UTC';
  try {
    const cfg = await loadConfig(dataDir);
    if (cfg?.timeZone) timeZone = cfg.timeZone;
  } catch {
    // keep UTC default
  }

  // Confirm the agent exists — an unknown slug must propagate as a 404.
  const agentStore = new AgentStore(dataDir);
  try {
    await agentStore.load(agentId);
  } catch {
    return { notFound: true, agentId };
  }

  const planStore = new WeeklyPlanStore(dataDir);
  const clock = now instanceof Date ? now : new Date();
  const plan = await resolvePlan(planStore, agentId, week, timeZone, clock);

  if (!plan) {
    return {
      agentId,
      week: null,
      month: null,
      approved: false,
      timeZone,
      weekMonday: null,
      noPlan: true,
      tasks: [],
      counts: summariseStatuses([]),
    };
  }

  // The Monday anchor is what every `slot` computation is relative to. We
  // always derive it from the plan's own week (not from `now`) so a plan
  // for a different week still places its tasks onto Mon/Tue/... correctly.
  let weekMonday = null;
  try {
    weekMonday = mondayOfWeek(plan.week, timeZone && timeZone !== 'UTC' ? timeZone : 'UTC');
  } catch {
    weekMonday = null;
  }

  const rawTasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const tasks = rawTasks.map((t) => projectTask(t, weekMonday, timeZone));

  return {
    agentId,
    week: plan.week,
    month: plan.month || null,
    approved: !!plan.approved,
    timeZone,
    weekMonday: weekMonday ? weekMonday.toISOString() : null,
    noPlan: false,
    tasks,
    counts: summariseStatuses(rawTasks),
  };
}

// ---------------------------------------------------------------------------
// Dashboard rendering (sub-AC 2)
//
// The HTTP layer calls `gatherCalendarView` to compose a picker-ready view
// (all agents + the selected agent's calendar payload) and
// `renderCalendarSection` to emit the card body HTML. The two halves are
// split so the gather side can be unit-tested without a DOM and the render
// side without the filesystem — matching the pattern already used by
// `plan-section.js` / `budget-section.js`.
// ---------------------------------------------------------------------------

/** Day columns displayed in the calendar grid, Monday-origin. */
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Status indicator glyphs — mirror the CLI weekly-calendar-grid legend so
 * operators who use both the terminal and the dashboard see the same
 * symbols. The HTML dashboard renders them as small inline spans next to
 * each task entry.
 */
const STATUS_ICONS = {
  pending: '\u25CB', // ○
  'in-progress': '\u25B6', // ▶
  completed: '\u2713', // ✓
  failed: '\u2717', // ✗
  skipped: '\u2298', // ⊘
  delegated: '\u2192', // →
};

/**
 * Gather everything the calendar card needs for a single request: the full
 * list of hired agents (for the picker) plus the resolved selection's
 * calendar payload. Falls back to the alphabetically-first agent when
 * `selectedSlug` does not match — same degradation policy as
 * `gatherPlans` in `plan-section.js` so the picker and plan cards stay
 * in sync on the same query string.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} [opts.selectedSlug]
 * @param {string} [opts.week]
 * @param {Date} [opts.now]
 * @returns {Promise<{
 *   agents: Array<{ slug: string, name: string }>,
 *   selected: {
 *     slug: string,
 *     name: string,
 *     calendar:
 *       | { notFound: true, agentId: string }
 *       | {
 *           agentId: string,
 *           week: string | null,
 *           month: string | null,
 *           approved: boolean,
 *           timeZone: string,
 *           weekMonday: string | null,
 *           noPlan: boolean,
 *           tasks: Array<object>,
 *           counts: Record<string, number>,
 *         },
 *   } | null,
 * }>}
 */
export async function gatherCalendarView({ projectDir, selectedSlug, week, now } = {}) {
  if (!projectDir) throw new Error('gatherCalendarView: projectDir is required');
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir: agentsDir });
  if (configs.length === 0) return { agents: [], selected: null };

  // Friendly display names come from the subagent .md. Missing .md falls
  // back to the slug — same rule the agents + plan cards use so the three
  // cards show the same label for the same agent.
  const agents = await Promise.all(
    configs.map(async (config) => {
      const identity = await readSubagentIdentity(config.id, projectDir).catch(
        () => ({ missing: true, name: '' }),
      );
      const name = identity?.missing ? config.id : identity?.name || config.id;
      return { slug: config.id, name };
    }),
  );
  agents.sort((a, b) => a.name.localeCompare(b.name));

  const selection =
    (selectedSlug && agents.find((a) => a.slug === selectedSlug)) || agents[0];

  const calendar = await gatherCalendar({
    projectDir,
    agentId: selection.slug,
    week,
    now,
  });

  return {
    agents,
    selected: {
      slug: selection.slug,
      name: selection.name,
      calendar,
    },
  };
}

/**
 * Render the calendar card body. The top strip is an agent picker (same
 * shape as the plan card) so the two cards share `?agent=<slug>` state.
 * Below the picker we render a week header, a task-status summary, and a
 * 7-column calendar grid with compact task cards. Tasks without a `runAt`
 * fall into an "Unscheduled" list under the grid so nothing is silently
 * dropped from the view.
 *
 * Every dynamic string is HTML-escaped before interpolation so a
 * malicious task description / agent name cannot inject markup.
 *
 * @param {ReturnType<typeof gatherCalendarView> extends Promise<infer R> ? R : never} view
 * @returns {string}
 */
export function renderCalendarSection(view) {
  const agents = view?.agents || [];
  const selected = view?.selected || null;

  if (agents.length === 0) {
    return `<div class="calendar-empty">No agents yet. Run <code>/aweek:hire</code> to create one.</div>`;
  }

  const picker = renderCalendarPicker(agents, selected);

  if (!selected) {
    return `${picker}<div class="calendar-empty">Select an agent to view its calendar.</div>`;
  }

  const cal = selected.calendar;

  // An unknown slug should never reach here (gatherCalendarView resolves
  // a real agent for the picker before calling gatherCalendar), but guard
  // anyway so a filesystem race does not render a broken card.
  if (cal && cal.notFound) {
    return [
      picker,
      `<div class="calendar-empty">Agent <code>${escapeHtml(selected.slug)}</code> not found on disk.</div>`,
    ].join('');
  }

  if (cal && cal.noPlan) {
    return [
      picker,
      `<div class="calendar-empty">No weekly plan yet for <strong>${escapeHtml(selected.name)}</strong>. Run <code>/aweek:plan</code> to draft this week's tasks.</div>`,
    ].join('');
  }

  return [
    picker,
    renderCalendarHeader(selected, cal),
    renderCalendarCounts(cal.counts),
    renderCalendarGrid(cal),
    renderCalendarUnscheduled(cal.tasks),
  ].join('');
}

/**
 * Render the horizontally-scrolling agent picker at the top of the card.
 * Each pill links to `?agent=<slug>`, letting the user pivot between
 * agents without any client JS. The selected pill renders as a span (not
 * a link) so screen readers do not announce a no-op link.
 *
 * @param {Array<{ slug: string, name: string }>} agents
 * @param {{ slug: string } | null} selected
 * @returns {string}
 */
function renderCalendarPicker(agents, selected) {
  const items = agents
    .map((agent) => {
      const isSelected = selected && selected.slug === agent.slug;
      const cls = isSelected ? 'calendar-pill selected' : 'calendar-pill';
      if (isSelected) {
        return `<span class="${cls}" aria-current="page" data-agent-slug="${escapeAttr(agent.slug)}">${escapeHtml(agent.name)}</span>`;
      }
      const href = `?agent=${encodeURIComponent(agent.slug)}`;
      return `<a class="${cls}" href="${escapeAttr(href)}" data-agent-slug="${escapeAttr(agent.slug)}">${escapeHtml(agent.name)}</a>`;
    })
    .join('');
  return `<nav class="calendar-picker" aria-label="Select agent">${items}</nav>`;
}

/**
 * Render the one-line header above the grid: week key, month, approval
 * state, and the effective time zone. Mirrors the title-bar data from the
 * CLI grid so CLI + dashboard users see the same metadata.
 *
 * @param {{ slug: string, name: string }} selected
 * @param {{ week: string | null, month: string | null, approved: boolean, timeZone: string }} cal
 * @returns {string}
 */
function renderCalendarHeader(selected, cal) {
  const week = cal.week ? escapeHtml(cal.week) : '—';
  const month = cal.month ? ` · ${escapeHtml(cal.month)}` : '';
  const approval = cal.approved
    ? `<span class="calendar-badge approved">APPROVED</span>`
    : `<span class="calendar-badge pending">PENDING</span>`;
  const tz = cal.timeZone ? escapeHtml(cal.timeZone) : 'UTC';
  return [
    `<div class="calendar-header">`,
    `<div class="calendar-header-main">`,
    `<span class="calendar-week">${week}</span>`,
    `<span class="calendar-month">${month}</span>`,
    `</div>`,
    `<div class="calendar-header-meta">`,
    approval,
    `<span class="calendar-tz" title="Display time zone">${tz}</span>`,
    `</div>`,
    `</div>`,
  ].join('');
}

/**
 * Render the status-counts strip: total tasks + counts per status. Gives
 * the operator a glanceable "how's this week going" at the top of the
 * card without scanning the grid.
 *
 * @param {Record<string, number>} counts
 * @returns {string}
 */
function renderCalendarCounts(counts) {
  if (!counts || counts.total === 0) {
    return `<div class="calendar-counts muted">No tasks planned.</div>`;
  }
  const chip = (label, n, cls) =>
    n > 0
      ? `<span class="calendar-chip ${cls}"><span class="calendar-chip-n">${n}</span>${escapeHtml(label)}</span>`
      : '';
  return [
    `<div class="calendar-counts">`,
    `<span class="calendar-chip total"><span class="calendar-chip-n">${counts.total}</span>total</span>`,
    chip('pending', counts.pending || 0, 'status-pending'),
    // Keep the label text plain — the chip uses `white-space: nowrap` via
    // CSS so "in progress" stays on one line without a hard-coded nbsp.
    chip('in progress', counts.inProgress || 0, 'status-in-progress'),
    chip('completed', counts.completed || 0, 'status-completed'),
    chip('failed', counts.failed || 0, 'status-failed'),
    chip('delegated', counts.delegated || 0, 'status-delegated'),
    chip('skipped', counts.skipped || 0, 'status-skipped'),
    `</div>`,
  ].join('');
}

/**
 * Compute the hour window to display. Starts from the earliest scheduled
 * task's hour (bounded by 7) and ends at the latest + 1 (bounded by 18)
 * so a lightly-scheduled week does not render a huge empty grid, while a
 * task at 20:00 still lands in a visible row.
 *
 * @param {Array<{ slot?: { hour: number } | null }>} tasks
 * @returns {{ startHour: number, endHour: number }}
 */
function computeHourWindow(tasks) {
  let min = 9;
  let max = 18;
  let sawScheduled = false;
  for (const t of tasks) {
    if (!t.slot) continue;
    sawScheduled = true;
    if (t.slot.hour < min) min = t.slot.hour;
    if (t.slot.hour + 1 > max) max = t.slot.hour + 1;
  }
  if (!sawScheduled) {
    // No runAt-anchored tasks — show a compact morning window so the grid
    // still has structure rather than collapsing to zero rows.
    return { startHour: 9, endHour: 12 };
  }
  // Clamp to a reasonable operator day so outlier off-hour tasks do not
  // stretch the grid to 24 rows.
  return { startHour: Math.max(0, Math.min(min, 9)), endHour: Math.min(24, Math.max(max, 12)) };
}

/**
 * Build day-column × hour-row buckets of scheduled tasks. Each cell is a
 * (possibly empty) array of tasks — stacking preserves collision data
 * rather than silently dropping one of two tasks that share a bucket.
 *
 * @param {Array<object>} tasks
 * @returns {Map<string, Map<number, Array<object>>>}
 */
function bucketTasks(tasks) {
  const buckets = new Map();
  for (let i = 0; i < 7; i++) buckets.set(i, new Map());
  for (const task of tasks) {
    if (!task.slot) continue;
    const { dayOffset, hour } = task.slot;
    if (dayOffset < 0 || dayOffset > 6) continue;
    const day = buckets.get(dayOffset);
    let bucket = day.get(hour);
    if (!bucket) {
      bucket = [];
      day.set(hour, bucket);
    }
    bucket.push(task);
  }
  // Earlier minute first within a bucket so a 13:00 task renders above a
  // 13:30 task.
  for (const day of buckets.values()) {
    for (const bucket of day.values()) {
      bucket.sort((a, b) => (a.slot?.minute ?? 0) - (b.slot?.minute ?? 0));
    }
  }
  return buckets;
}

/**
 * Assign a stable 1-based display number to every task. We number in
 * chronological order (slot-anchored tasks first by ISO timestamp, then
 * unscheduled tasks by their position in the original array) so the
 * numbering matches what a reader's eye naturally traces across the grid.
 *
 * @param {Array<object>} tasks
 * @returns {Map<string, number>}
 */
function assignTaskNumbers(tasks) {
  const numbered = new Map();
  const scheduled = tasks
    .filter((t) => t.slot && typeof t.slot.iso === 'string')
    .sort((a, b) => a.slot.iso.localeCompare(b.slot.iso));
  const unscheduled = tasks.filter((t) => !t.slot);
  let n = 1;
  for (const t of scheduled) numbered.set(t.id, n++);
  for (const t of unscheduled) numbered.set(t.id, n++);
  return numbered;
}

/**
 * Render the 7-column day grid. Produces a CSS-Grid-based layout so each
 * cell naturally sizes to its content and the hour column self-aligns
 * across rows without any JS.
 *
 * @param {{ tasks: Array<object>, weekMonday: string | null, timeZone: string }} cal
 * @returns {string}
 */
function renderCalendarGrid(cal) {
  const tasks = Array.isArray(cal.tasks) ? cal.tasks : [];
  const { startHour, endHour } = computeHourWindow(tasks);
  const buckets = bucketTasks(tasks);
  const numbers = assignTaskNumbers(tasks);

  // Header row: corner + 7 day headers. When weekMonday is known, surface
  // the per-column date so operators can tell at a glance whether the
  // grid is showing the current week or a historical snapshot.
  const dateLabels = computeDayDateLabels(cal.weekMonday, cal.timeZone);
  const head = [`<div class="calendar-cell calendar-corner"></div>`];
  for (let d = 0; d < 7; d++) {
    const dateLabel = dateLabels[d] ? `<span class="calendar-daydate">${escapeHtml(dateLabels[d])}</span>` : '';
    head.push(
      `<div class="calendar-cell calendar-dayhead">${escapeHtml(DAY_LABELS[d])}${dateLabel}</div>`,
    );
  }

  // Body rows: one row per hour in the window.
  const rows = [];
  for (let h = startHour; h < endHour; h++) {
    rows.push(`<div class="calendar-cell calendar-hourhead">${formatHourLabel(h)}</div>`);
    for (let d = 0; d < 7; d++) {
      const bucket = buckets.get(d)?.get(h) || [];
      const cards = bucket
        .map((task) => renderTaskCard(task, numbers.get(task.id)))
        .join('');
      rows.push(`<div class="calendar-cell calendar-daycell">${cards}</div>`);
    }
  }

  return `<div class="calendar-grid" role="grid">${head.join('')}${rows.join('')}</div>`;
}

/**
 * Render the "Unscheduled" section — tasks with no `runAt` pin. Keeps
 * them visible and selectable even though they don't fit on the grid.
 *
 * @param {Array<object>} tasks
 * @returns {string}
 */
function renderCalendarUnscheduled(tasks) {
  const unscheduled = (tasks || []).filter((t) => !t.slot);
  if (unscheduled.length === 0) return '';
  const numbers = assignTaskNumbers(tasks || []);
  const items = unscheduled.map((task) => renderTaskCard(task, numbers.get(task.id))).join('');
  return [
    `<div class="calendar-unscheduled">`,
    `<h3 class="calendar-unscheduled-head">Unscheduled</h3>`,
    `<div class="calendar-unscheduled-list">${items}</div>`,
    `</div>`,
  ].join('');
}

/**
 * Render a single task card used inside a grid cell or in the unscheduled
 * list. Shows the task's number, status glyph, runAt (when present), and
 * description. Status drives both the glyph and a CSS class so the shell
 * stylesheet can recolor the card without extra markup.
 *
 * @param {object} task
 * @param {number | undefined} num
 * @returns {string}
 */
function renderTaskCard(task, num) {
  const status = String(task.status || 'pending');
  const icon = STATUS_ICONS[status] || '?';
  const statusCls = `calendar-task status-${status}`;
  const priorityCls = task.priority ? ` priority-${escapeAttr(task.priority)}` : '';
  const timeLabel = task.slot
    ? formatClockLabel(task.slot.hour, task.slot.minute)
    : '';
  const timePart = timeLabel
    ? `<span class="calendar-task-time">${escapeHtml(timeLabel)}</span>`
    : '';
  const numPart =
    typeof num === 'number'
      ? `<span class="calendar-task-num">#${num}</span>`
      : '';
  const statusLabel = escapeHtml(status);
  return [
    `<div class="${statusCls}${priorityCls}" data-task-id="${escapeAttr(task.id || '')}" data-task-status="${escapeAttr(status)}" title="${escapeAttr(task.description || '')}">`,
    `<div class="calendar-task-head">`,
    `<span class="calendar-task-status" aria-label="status: ${statusLabel}">${icon}</span>`,
    numPart,
    timePart,
    `</div>`,
    `<div class="calendar-task-desc">${escapeHtml(task.description || '')}</div>`,
    `</div>`,
  ].join('');
}

/**
 * Derive per-column date labels (e.g. "4/20") from the plan's Monday
 * anchor and the project's time zone. Falls back to empty strings when
 * the Monday is unknown so the header still renders.
 *
 * @param {string | null} weekMondayIso
 * @param {string} timeZone
 * @returns {string[]}
 */
function computeDayDateLabels(weekMondayIso, timeZone) {
  if (!weekMondayIso) return new Array(7).fill('');
  const ms = Date.parse(weekMondayIso);
  if (Number.isNaN(ms)) return new Array(7).fill('');
  const out = [];
  const useLocalTz =
    typeof timeZone === 'string' && timeZone !== 'UTC' && isValidTimeZone(timeZone);
  for (let i = 0; i < 7; i++) {
    const instant = ms + i * 86_400_000;
    if (useLocalTz) {
      try {
        const parts = localParts(instant, timeZone);
        out.push(`${parts.month}/${parts.day}`);
        continue;
      } catch {
        // fall through to UTC
      }
    }
    const d = new Date(instant);
    out.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}`);
  }
  return out;
}

/**
 * Format a 24-hour row header into the compact form used by the reference
 * dashboard ("9a", "12p", "3p"). Keeps the hour column narrow so the day
 * cells get the bulk of the available width.
 *
 * @param {number} h
 * @returns {string}
 */
function formatHourLabel(h) {
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  if (h < 12) return `${h}a`;
  return `${h - 12}p`;
}

/**
 * Format a task's local clock label (e.g. "9:00a", "1:30p"). Surfaced on
 * each task card so tasks that share an hour bucket can still be
 * distinguished by minute.
 *
 * @param {number} hour
 * @param {number} minute
 * @returns {string}
 */
function formatClockLabel(hour, minute) {
  const suffix = hour < 12 ? 'a' : 'p';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = String(minute || 0).padStart(2, '0');
  return `${h12}:${mm}${suffix}`;
}

/**
 * CSS fragment for the calendar section. Uses the shell's CSS tokens
 * (`--bg`, `--panel`, `--border`, status colors) so changing the theme
 * in `renderDashboardShell` recolors the calendar automatically.
 *
 * @returns {string}
 */
export function calendarSectionStyles() {
  return `
  .calendar-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .calendar-pill {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--muted);
    font-size: 12px;
    text-decoration: none;
    letter-spacing: 0.01em;
    transition: color 120ms ease, border-color 120ms ease;
  }
  .calendar-pill:hover {
    color: var(--text);
    border-color: var(--muted);
  }
  .calendar-pill.selected {
    color: var(--text);
    border-color: var(--accent);
    background: rgba(138, 180, 255, 0.1);
    font-weight: 600;
  }
  .calendar-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 10px;
  }
  .calendar-header-main {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }
  .calendar-week {
    font-weight: 600;
    font-size: 13.5px;
    letter-spacing: -0.005em;
  }
  .calendar-month {
    color: var(--muted);
    font-size: 12px;
  }
  .calendar-header-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .calendar-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid currentColor;
  }
  .calendar-badge.approved { color: var(--status-completed); }
  .calendar-badge.pending { color: var(--status-pending); }
  .calendar-tz {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    color: var(--muted);
  }
  .calendar-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
    font-size: 11.5px;
  }
  .calendar-counts.muted {
    color: var(--muted);
    font-style: italic;
  }
  .calendar-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .calendar-chip.total { color: var(--text); }
  .calendar-chip.status-pending { color: var(--status-pending); }
  .calendar-chip.status-in-progress { color: var(--status-in-progress); }
  .calendar-chip.status-completed { color: var(--status-completed); }
  .calendar-chip.status-failed { color: var(--status-failed); }
  .calendar-chip.status-delegated { color: var(--accent); }
  .calendar-chip.status-skipped { color: var(--muted); }
  .calendar-chip-n { font-weight: 700; color: var(--text); }
  .calendar-grid {
    display: grid;
    grid-template-columns: 44px repeat(7, minmax(0, 1fr));
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .calendar-cell {
    padding: 4px 5px;
    border-right: 1px solid rgba(38, 42, 54, 0.5);
    border-bottom: 1px dashed rgba(38, 42, 54, 0.5);
    min-height: 32px;
    font-size: 11.5px;
  }
  .calendar-cell:nth-child(8n) { border-right: none; }
  .calendar-corner {
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
  }
  .calendar-dayhead {
    background: var(--panel-2);
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border);
    padding: 6px 4px;
  }
  .calendar-daydate {
    display: block;
    margin-top: 2px;
    color: var(--muted);
    font-size: 10.5px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
  }
  .calendar-hourhead {
    text-align: right;
    padding: 5px 7px 5px 4px;
    color: var(--muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    border-right: 1px solid var(--border);
  }
  .calendar-daycell {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .calendar-task {
    display: block;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 4px;
    padding: 3px 5px 4px 6px;
    font-size: 11px;
    line-height: 1.3;
    color: var(--text);
  }
  .calendar-task.priority-critical { border-left-color: var(--critical); }
  .calendar-task.priority-high { border-left-color: var(--high); }
  .calendar-task.priority-medium { border-left-color: var(--medium); }
  .calendar-task.priority-low { border-left-color: var(--low); }
  .calendar-task.status-completed { opacity: 0.75; }
  .calendar-task.status-failed { border-left-color: var(--status-failed); }
  .calendar-task-head {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }
  .calendar-task-status {
    font-size: 11px;
    font-weight: 600;
  }
  .calendar-task.status-pending .calendar-task-status { color: var(--status-pending); }
  .calendar-task.status-in-progress .calendar-task-status { color: var(--status-in-progress); }
  .calendar-task.status-completed .calendar-task-status { color: var(--status-completed); }
  .calendar-task.status-failed .calendar-task-status { color: var(--status-failed); }
  .calendar-task.status-delegated .calendar-task-status { color: var(--accent); }
  .calendar-task.status-skipped .calendar-task-status { color: var(--muted); }
  .calendar-task-num {
    font-weight: 600;
  }
  .calendar-task-time {
    margin-left: auto;
  }
  .calendar-task-desc {
    display: block;
    margin-top: 2px;
    color: var(--text);
    word-break: break-word;
  }
  .calendar-unscheduled {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .calendar-unscheduled-head {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .calendar-unscheduled-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
  }
  .calendar-empty {
    color: var(--muted);
    font-style: italic;
  }
  .calendar-empty strong { color: var(--text); font-style: normal; }
  `;
}

// ---------------------------------------------------------------------------
// HTML escaping — local copies so this module can be tested in isolation
// without pulling server.js in (matches the pattern used by the other
// sections).
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
