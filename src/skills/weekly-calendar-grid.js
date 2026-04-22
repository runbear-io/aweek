/**
 * Weekly calendar grid renderer — displays tasks in a day-column × hour-row grid.
 *
 * Tasks are distributed across working hours sequentially per day.
 * Each task occupies rows based on its estimatedMinutes (default: 60).
 * Activity log entries with timestamps are placed at their actual hour.
 */

import { join } from 'node:path';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';
import { getAgentChoices } from '../storage/agent-helpers.js';
import { loadConfig } from '../storage/config-store.js';
import {
  isValidTimeZone,
  localDayOffset,
  localHour,
  localParts,
  mondayOfWeek,
} from '../time/zone.js';
import {
  isReviewObjectiveId,
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_ICONS = {
  completed: '✓',
  failed: '✗',
  pending: '○',
  'in-progress': '►',
  skipped: '⊘',
  delegated: '→',
};

/** Icon used in the grid for advisor-mode review slots. */
export const REVIEW_SLOT_ICON = '◆';

/**
 * Human-readable display names for reserved review objectiveIds.
 * Used by the grid renderer to label review rows distinctly from work tasks.
 */
export const REVIEW_DISPLAY_NAMES = {
  [DAILY_REVIEW_OBJECTIVE_ID]: 'Daily Review',
  [WEEKLY_REVIEW_OBJECTIVE_ID]: 'Weekly Review',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the Monday instant for an ISO week string like "2026-W16".
 * When `tz` is supplied, returns the UTC `Date` that corresponds to
 * Monday 00:00 *local time* in that zone. Default behavior (no `tz`)
 * stays UTC-only so existing callers and tests are unchanged.
 *
 * @param {string} isoWeek
 * @param {string} [tz]
 * @returns {Date}
 */
export function mondayFromISOWeek(isoWeek, tz) {
  if (typeof tz === 'string' && tz.length > 0 && tz !== 'UTC') {
    return mondayOfWeek(isoWeek, tz);
  }
  const [yearStr, weekStr] = isoWeek.split('-W');
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

/**
 * Derive a per-day cell width that fits within a terminal width.
 *
 * The grid's total printed width is `hourWidth + (cellWidth + 1) * daysCount + 1`
 * (with `hourWidth === 7`). Solving for `cellWidth` and flooring gives the
 * widest cell that still fits. Clamped to `minCellWidth` so very narrow
 * terminals still produce a usable grid (truncated, but not broken).
 *
 * @param {number} terminalWidth - Available columns in the terminal.
 * @param {number} daysCount - Number of day columns (5 or 7).
 * @param {object} [opts]
 * @param {number} [opts.minCellWidth=12]
 * @param {number} [opts.maxCellWidth=32]
 * @returns {number}
 */
export const DEFAULT_TERMINAL_WIDTH = 120;

export function computeCellWidth(terminalWidth, daysCount, opts = {}) {
  const { minCellWidth = 12, maxCellWidth = 32 } = opts;
  const hourWidth = 7;
  const width =
    Number.isFinite(terminalWidth) && terminalWidth > 0
      ? terminalWidth
      : DEFAULT_TERMINAL_WIDTH;
  const available = width - hourWidth - 2; // minus "│" borders on each side
  const cell = Math.floor(available / daysCount) - 1;
  return Math.min(maxCellWidth, Math.max(minCellWidth, cell));
}

/**
 * Truncate a string, appending '…' if truncated.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function trunc(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

/**
 * Pad string to exact width.
 * @param {string} s
 * @param {number} w
 * @returns {string}
 */
function pad(s, w) {
  const str = String(s);
  return str.length >= w ? str.slice(0, w) : str + ' '.repeat(w - str.length);
}

// ---------------------------------------------------------------------------
// Task distribution
// ---------------------------------------------------------------------------

/**
 * Distribute tasks across days and hours.
 *
 * Each (day, hour) cell holds an ORDERED LIST of entries, not a single
 * entry — multiple tasks with the same floor-hour (e.g. a 13:00 task and a
 * 13:30 task) both land in the same 13:00 bucket rather than one being
 * dropped on collision. The renderer decides how to summarize crowded
 * buckets; the distributor never hides a task.
 *
 * Placement runs in two passes:
 *   1. Tasks with a `runAt` ISO timestamp are appended to their bucket,
 *      stacking on collision.
 *   2. Remaining tasks (no `runAt`, or `runAt` outside the visible window)
 *      are placed via `pack` or `spread`, treating any non-empty bucket as
 *      occupied so they settle into truly free slots.
 *
 * @param {Array} tasks - Weekly plan tasks
 * @param {object} opts
 * @param {number} opts.startHour - First working hour (default: 9)
 * @param {number} opts.endHour - Last working hour exclusive (default: 18)
 * @param {number} opts.daysCount - Number of days to schedule across (default: 5 for weekdays)
 * @param {string} opts.spread - Distribution mode: 'pack' (fill each day) or 'spread' (round-robin across days)
 * @param {Date} [opts.weekMonday] - Monday (UTC) of the plan's week. Required to place runAt-tagged tasks; if omitted, tasks with runAt fall through to the default placement.
 * @returns {Map<string, Map<number, Array<{task: object, isStart: boolean, spanHours: number, offset: number, sortKey?: number}>>>}
 */
export function distributeTasks(tasks, opts = {}) {
  const {
    startHour = 9,
    endHour = 18,
    daysCount = 5,
    spread = 'pack',
    weekMonday,
    tz,
  } = opts;

  const useLocalTz = typeof tz === 'string' && tz !== 'UTC' && isValidTimeZone(tz);

  // dayKey → Map(hour → Array<Entry>)
  const grid = new Map();
  for (let d = 0; d < 7; d++) {
    grid.set(DAY_KEYS[d], new Map());
  }

  const append = (dayKey, hour, entry) => {
    const dayGrid = grid.get(dayKey);
    let bucket = dayGrid.get(hour);
    if (!bucket) {
      bucket = [];
      dayGrid.set(hour, bucket);
    }
    bucket.push(entry);
  };

  // ---- Pass 1: runAt-anchored placement ----------------------------------
  const runAtPlaced = new Set();
  if (weekMonday instanceof Date && !Number.isNaN(weekMonday.getTime())) {
    const weekStartMs = Date.UTC(
      weekMonday.getUTCFullYear(),
      weekMonday.getUTCMonth(),
      weekMonday.getUTCDate(),
    );
    for (const task of tasks) {
      if (task.runAt == null) continue;
      const ts = Date.parse(task.runAt);
      if (Number.isNaN(ts)) continue;

      // Day / hour derivation runs in `tz` when supplied so half-hour local
      // tasks (e.g. 13:30 LA) anchor to the same local 13:00 bucket as a
      // 13:00 LA task does. Default path stays UTC for back-compat with
      // callers that don't plumb a time zone through yet.
      let dayOffset;
      let hour;
      if (useLocalTz) {
        dayOffset = localDayOffset(ts, weekMonday, tz);
        hour = localHour(ts, tz);
      } else {
        const msInDay = 24 * 60 * 60 * 1000;
        dayOffset = Math.floor((ts - weekStartMs) / msInDay);
        hour = new Date(ts).getUTCHours();
      }
      if (dayOffset < 0 || dayOffset >= daysCount) continue;
      if (hour < startHour || hour >= endHour) continue;

      const minutes = task.estimatedMinutes || 60;
      const spanHours = Math.max(1, Math.ceil(minutes / 60));
      const dayKey = DAY_KEYS[dayOffset];

      for (let h = 0; h < spanHours && hour + h < endHour; h++) {
        append(dayKey, hour + h, {
          task,
          isStart: h === 0,
          spanHours,
          offset: h,
          sortKey: ts,
        });
      }
      runAtPlaced.add(task.id);
    }
  }

  // Within a bucket, earlier runAt comes first so numbering is deterministic.
  for (const dayGrid of grid.values()) {
    for (const bucket of dayGrid.values()) {
      bucket.sort((a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0));
    }
  }

  const remaining = tasks.filter((t) => !runAtPlaced.has(t.id));

  // A bucket is "free" for unscheduled placement only if it's completely
  // empty — preserves the pre-refactor reserve semantics.
  const firstFreeHourFrom = (dayGrid, fromHour, spanHours) => {
    for (let h = fromHour; h + spanHours <= endHour; h++) {
      let clear = true;
      for (let k = 0; k < spanHours; k++) {
        const bucket = dayGrid.get(h + k);
        if (bucket && bucket.length > 0) {
          clear = false;
          break;
        }
      }
      if (clear) return h;
    }
    return -1;
  };

  if (spread === 'spread') {
    // Round-robin: one task per day, then wrap
    const nextHour = new Array(daysCount).fill(startHour);

    for (let i = 0; i < remaining.length; i++) {
      const task = remaining[i];
      const dayIdx = i % daysCount;
      const minutes = task.estimatedMinutes || 60;
      const spanHours = Math.max(1, Math.ceil(minutes / 60));

      const dayKey = DAY_KEYS[dayIdx];
      const dayGrid = grid.get(dayKey);
      const slot = firstFreeHourFrom(dayGrid, nextHour[dayIdx], spanHours);
      if (slot === -1) continue;

      for (let h = 0; h < spanHours; h++) {
        append(dayKey, slot + h, {
          task,
          isStart: h === 0,
          spanHours,
          offset: h,
        });
      }
      nextHour[dayIdx] = slot + spanHours;
    }

    return grid;
  }

  // Default 'pack' mode: fill each day sequentially, skipping reserved cells.
  let currentDay = 0;
  let currentHour = startHour;

  for (const task of remaining) {
    if (currentDay >= daysCount) break;

    const minutes = task.estimatedMinutes || 60;
    const spanHours = Math.max(1, Math.ceil(minutes / 60));

    let slot = -1;
    while (currentDay < daysCount) {
      const dayGrid = grid.get(DAY_KEYS[currentDay]);
      slot = firstFreeHourFrom(dayGrid, currentHour, spanHours);
      if (slot !== -1) break;
      currentDay++;
      currentHour = startHour;
    }
    if (currentDay >= daysCount || slot === -1) break;

    const dayKey = DAY_KEYS[currentDay];

    for (let h = 0; h < spanHours; h++) {
      append(dayKey, slot + h, {
        task,
        isStart: h === 0,
        spanHours,
        offset: h,
      });
    }

    currentHour = slot + spanHours;
    if (currentHour >= endHour) {
      currentDay++;
      currentHour = startHour;
    }
  }

  return grid;
}

// ---------------------------------------------------------------------------
// Grid renderer
// ---------------------------------------------------------------------------

/**
 * Render the weekly calendar grid as a text table.
 *
 * @param {object} params
 * @param {object} params.agent - Agent config
 * @param {object} params.plan - Weekly plan
 * @param {object} [params.opts]
 * @param {number} [params.opts.startHour=9]
 * @param {number} [params.opts.endHour=18]
 * @param {number} [params.opts.cellWidth] - Explicit cell width. Overrides the terminalWidth-derived default.
 * @param {number} [params.opts.terminalWidth] - Terminal columns the grid should fit. Defaults to DEFAULT_TERMINAL_WIDTH (120) when omitted.
 * @param {boolean} [params.opts.showWeekend=false]
 * @returns {string} Rendered grid
 */
export const TASK_CONTENT_MAX = 40;

export function renderGrid({ agent, plan, opts = {} }) {
  const {
    startHour = 9,
    endHour = 18,
    cellWidth: cellWidthOpt,
    terminalWidth,
    showWeekend = false,
    spread = 'pack',
    tz,
  } = opts;

  const useLocalTz = typeof tz === 'string' && tz !== 'UTC' && isValidTimeZone(tz);

  const daysCount = showWeekend ? 7 : 5;
  // Fit the grid to a terminal (120 cols by default). An explicit cellWidth
  // takes precedence; otherwise derive cellWidth from the terminal width so
  // every column is the same.
  const resolvedTerminalWidth =
    Number.isFinite(terminalWidth) && terminalWidth > 0
      ? terminalWidth
      : DEFAULT_TERMINAL_WIDTH;
  const cellWidth =
    Number.isFinite(cellWidthOpt) && cellWidthOpt > 0
      ? cellWidthOpt
      : computeCellWidth(resolvedTerminalWidth, daysCount);
  const dayLabels = DAY_LABELS.slice(0, daysCount);
  const dayKeys = DAY_KEYS.slice(0, daysCount);

  // Compute date labels. When tz is supplied, the labels come from the
  // local-zone projection of Monday 00:00 + N days; otherwise we render
  // the UTC date (old behavior).
  const monday = mondayFromISOWeek(plan.week, tz);
  const dateLabels = dayKeys.map((_, i) => {
    if (useLocalTz) {
      const parts = localParts(monday.getTime() + i * 86400000, tz);
      return `${parts.month}/${parts.day}`;
    }
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  });

  // Distribute tasks and build task index (number → task mapping)
  const grid = distributeTasks(plan.tasks || [], {
    startHour,
    endHour,
    daysCount,
    tz,
    spread,
    weekMonday: monday,
  });
  const taskIndex = []; // 1-based: taskIndex[0] = task #1

  // Assign numbers in column-major order: walk each day top-to-bottom, then
  // move to the next day. Within each hour bucket, entries are already sorted
  // by runAt so the earliest-scheduled task gets the lowest number.
  // Review slots (daily-review / weekly-review objectiveIds) receive numbers
  // identical to regular work tasks so users can select them and apply status
  // transitions the same way.
  const taskNumMap = new Map(); // task.id → number
  for (const dayKey of dayKeys) {
    for (let h = startHour; h < endHour; h++) {
      const bucket = grid.get(dayKey)?.get(h);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (
          entry.isStart &&
          !taskNumMap.has(entry.task.id)
        ) {
          const num = taskIndex.length + 1;
          taskNumMap.set(entry.task.id, num);
          taskIndex.push(entry.task);
        }
      }
    }
  }
  // Add any ungridded tasks (overflow), including review slots.
  for (const task of (plan.tasks || [])) {
    if (!taskNumMap.has(task.id)) {
      const num = taskIndex.length + 1;
      taskNumMap.set(task.id, num);
      taskIndex.push(task);
    }
  }

  const lines = [];
  const hourWidth = 7; // "HH:00 "
  const totalWidth = hourWidth + (cellWidth + 1) * daysCount + 1;

  // Title
  const title = `${agent.identity?.name || agent.id} — Week ${plan.week}`;
  const status = plan.approved ? 'Approved' : 'Pending';
  lines.push(`┌${'─'.repeat(totalWidth - 2)}┐`);
  lines.push(`│ ${pad(title, totalWidth - 4)} │`);
  // Surface the effective time zone in the header so the user can tell at
  // a glance which zone the day/hour axes correspond to.
  const displayTz = useLocalTz ? tz : 'UTC';
  // Separate work task count from advisor-mode review slot count so the
  // header gives an accurate picture of scheduled work vs. pacing structure.
  const allPlanTasks = plan.tasks || [];
  const workTaskCount = allPlanTasks.filter((t) => !isReviewObjectiveId(t.objectiveId)).length;
  const reviewSlotCount = allPlanTasks.length - workTaskCount;
  const reviewSuffix = reviewSlotCount > 0 ? ` | Reviews: ${reviewSlotCount}` : '';
  lines.push(
    `│ ${pad(`Status: ${status} | Tasks: ${workTaskCount}${reviewSuffix} | TZ: ${displayTz}`, totalWidth - 4)} │`,
  );
  lines.push(`├${'─'.repeat(hourWidth)}${'┬' + '─'.repeat(cellWidth)}`.repeat(1).slice(0, 0) +
    `├${'─'.repeat(hourWidth)}${dayKeys.map(() => `┬${'─'.repeat(cellWidth)}`).join('')}┤`);

  // Day header row
  const headerCells = dayKeys.map((_, i) =>
    pad(`${dayLabels[i]} ${dateLabels[i]}`, cellWidth)
  );
  lines.push(`│ ${pad('Hour', hourWidth - 2)} │${headerCells.map(c => `${c}│`).join('')}`);
  lines.push(`├${'─'.repeat(hourWidth)}${dayKeys.map(() => `┼${'─'.repeat(cellWidth)}`).join('')}┤`);

  // Each task is rendered as a small block of wrapped lines inside its
  // cell. Every task gets at most TASK_CONTENT_MAX visible chars total
  // (prefix + description); anything beyond collapses with `…`. The capped
  // text is then chunked across lines of `cellWidth` columns so narrow
  // cells simply take more lines. Hour row height = the tallest cell in
  // that row; shorter cells pad with blanks.
  //
  // Advisor-mode review slots (daily-review / weekly-review objectiveIds) are
  // rendered with the distinct `◆` icon and their selection number, identical
  // to regular work tasks, so users can select them and apply status transitions.
  const wrapTaskBlock = (entry) => {
    const { task } = entry;
    const num = taskNumMap.get(task.id);

    if (isReviewObjectiveId(task.objectiveId)) {
      const displayName = REVIEW_DISPLAY_NAMES[task.objectiveId] ?? 'Review';
      const prefix = num != null ? `${REVIEW_SLOT_ICON} ${num}. ` : `${REVIEW_SLOT_ICON} `;
      const capped = trunc(`${prefix}${displayName}`, TASK_CONTENT_MAX);
      const chunks = [];
      for (let i = 0; i < capped.length; i += cellWidth) {
        chunks.push(pad(capped.slice(i, i + cellWidth), cellWidth));
      }
      if (chunks.length === 0) chunks.push(pad('', cellWidth));
      return chunks;
    }

    const icon = STATUS_ICONS[task.status] || '?';
    const prefix = `${icon} ${num}. `;
    const capped = trunc(`${prefix}${task.title}`, TASK_CONTENT_MAX);
    const chunks = [];
    for (let i = 0; i < capped.length; i += cellWidth) {
      chunks.push(pad(capped.slice(i, i + cellWidth), cellWidth));
    }
    if (chunks.length === 0) chunks.push(pad('', cellWidth));
    return chunks;
  };

  for (let h = startHour; h < endHour; h++) {
    const hourLabel = pad(`${String(h).padStart(2, '0')}:00`, hourWidth - 1);

    // For each day cell, flatten every task's wrapped block into a stack
    // of lines. Empty cells still reserve one blank line so the hour
    // label row never collapses to zero height.
    const cells = dayKeys.map((dayKey) => {
      const bucket = grid.get(dayKey)?.get(h);
      if (!bucket || bucket.length === 0) return [pad('', cellWidth)];
      return bucket.flatMap(wrapTaskBlock);
    });

    const linesPerCell = Math.max(...cells.map((c) => c.length), 1);
    for (const c of cells) {
      while (c.length < linesPerCell) c.push(pad('', cellWidth));
    }

    for (let ln = 0; ln < linesPerCell; ln++) {
      const hourCol = ln === 0 ? hourLabel : pad('', hourWidth - 1);
      const row = cells.map((c) => c[ln]);
      lines.push(`│${hourCol} │${row.map((c) => `${c}│`).join('')}`);
    }
  }

  // Bottom border
  lines.push(`└${'─'.repeat(hourWidth)}${dayKeys.map(() => `┴${'─'.repeat(cellWidth)}`).join('')}┘`);

  // Legend
  lines.push('');
  lines.push(`Legend: ○ pending  ► in-progress  ✓ completed  ✗ failed  ⊘ skipped  → delegated  ◆ review slot`);
  lines.push(`Select a task number (1-${taskIndex.length}) to see details.`);

  return { text: lines.join('\n'), taskIndex };
}

// ---------------------------------------------------------------------------
// Load and render
// ---------------------------------------------------------------------------

/**
 * Load agent data and render the weekly calendar grid.
 *
 * @param {object} params
 * @param {string} params.agentId - Agent ID
 * @param {string} [params.week] - ISO week (default: latest approved plan)
 * @param {string} [params.dataDir] - Data directory
 * @param {object} [params.opts] - Render options
 * @returns {Promise<{success: boolean, output?: string, errors?: string[]}>}
 */
export async function loadAndRenderGrid(params) {
  const { agentId, week, opts = {} } = params;
  const dataDir = params.dataDir || join(process.cwd(), '.aweek', 'agents');

  try {
    const agentStore = new AgentStore(dataDir);
    const weeklyPlanStore = new WeeklyPlanStore(dataDir);

    const agent = await agentStore.load(agentId);

    let plan;
    if (week) {
      plan = await weeklyPlanStore.load(agentId, week);
    } else {
      plan = await weeklyPlanStore.loadLatestApproved(agentId);
      if (!plan) {
        // Fall back to the most recent plan regardless of approval state.
        const plans = await weeklyPlanStore.loadAll(agentId).catch(() => []);
        plan = plans[plans.length - 1];
      }
    }

    if (!plan) {
      return { success: false, errors: ['No weekly plan found for this agent'] };
    }

    // Auto-resolve the user's time zone from `.aweek/config.json` unless
    // the caller already provided one in opts. Keeping the default
    // loader here (rather than pushing it into renderGrid) means unit
    // tests of renderGrid stay filesystem-free.
    const resolvedOpts = { ...opts };
    if (resolvedOpts.tz == null) {
      try {
        const config = await loadConfig(dataDir);
        if (config?.timeZone) resolvedOpts.tz = config.timeZone;
      } catch {
        // Config read failures are non-fatal — fall back to UTC rendering.
      }
    }

    const { text, taskIndex } = renderGrid({ agent, plan, opts: resolvedOpts });
    return { success: true, output: text, taskIndex };
  } catch (err) {
    return { success: false, errors: [err.message] };
  }
}

/**
 * List all agents with their latest plan week.
 *
 * Thin wrapper around the shared {@link getAgentChoices} helper — kept so the
 * existing `/aweek:weekly-calendar` skill markdown import stays stable while
 * the consolidated `/aweek:calendar` skill (which imports `getAgentChoices`
 * directly) rolls in. The returned shape is intentionally narrower than the
 * helper's so downstream calendar code only sees fields it cares about.
 *
 * @param {string} [dataDir]
 * @returns {Promise<Array<{id: string, name: string, latestWeek: string|null, taskCount: number, approved: boolean}>>}
 */
export async function listAgentsForCalendar(dataDir) {
  const choices = await getAgentChoices({ dataDir });
  return choices.map(({ id, name, latestWeek, taskCount, approved }) => ({
    id,
    name,
    latestWeek,
    taskCount,
    approved,
  }));
}
