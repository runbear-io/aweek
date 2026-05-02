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
  currentWeekKey,
  isValidTimeZone,
  localDayOffset,
  localHour,
  localParts,
  mondayOfWeek,
} from '../time/zone.js';
import {
  dateToISOWeek,
  isoWeekToMondayDate,
} from '../services/daily-review-writer.js';
import {
  isReviewObjectiveId,
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
} from '../schemas/weekly-plan.schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const STATUS_ICONS: Record<string, string> = {
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
export const REVIEW_DISPLAY_NAMES: Record<string, string> = {
  [DAILY_REVIEW_OBJECTIVE_ID]: 'Daily Review',
  [WEEKLY_REVIEW_OBJECTIVE_ID]: 'Weekly Review',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the Monday instant for an ISO week string like "2026-W16".
 */
export function mondayFromISOWeek(isoWeek: string, tz?: string): Date {
  if (typeof tz === 'string' && tz.length > 0 && tz !== 'UTC') {
    return mondayOfWeek(isoWeek, tz);
  }
  const [yearStr, weekStr] = isoWeek.split('-W');
  const year = parseInt(yearStr ?? '', 10);
  const week = parseInt(weekStr ?? '', 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

/**
 * Derive a per-day cell width that fits within a terminal width.
 */
export const DEFAULT_TERMINAL_WIDTH = 120;

export function computeCellWidth(
  terminalWidth: number | undefined,
  daysCount: number,
  opts: { minCellWidth?: number; maxCellWidth?: number } = {},
): number {
  const { minCellWidth = 12, maxCellWidth = 32 } = opts;
  const hourWidth = 7;
  const width =
    Number.isFinite(terminalWidth) && (terminalWidth as number) > 0
      ? (terminalWidth as number)
      : DEFAULT_TERMINAL_WIDTH;
  const available = width - hourWidth - 2; // minus "│" borders on each side
  const cell = Math.floor(available / daysCount) - 1;
  return Math.min(maxCellWidth, Math.max(minCellWidth, cell));
}

/**
 * Truncate a string, appending '…' if truncated.
 */
function trunc(str: string | undefined | null, max: number): string {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

/**
 * Pad string to exact width.
 */
function pad(s: any, w: number): string {
  const str = String(s);
  return str.length >= w ? str.slice(0, w) : str + ' '.repeat(w - str.length);
}

// ---------------------------------------------------------------------------
// Task distribution
// ---------------------------------------------------------------------------

export interface DistributeTasksOpts {
  startHour?: number;
  endHour?: number;
  daysCount?: number;
  spread?: 'pack' | 'spread';
  weekMonday?: Date;
  tz?: string;
}

/**
 * Distribute tasks across days and hours.
 */
export function distributeTasks(
  tasks: any[],
  opts: DistributeTasksOpts = {},
): Map<string, Map<number, any[]>> {
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
  const grid = new Map<string, Map<number, any[]>>();
  for (let d = 0; d < 7; d++) {
    grid.set(DAY_KEYS[d] as string, new Map<number, any[]>());
  }

  const append = (dayKey: string, hour: number, entry: any) => {
    const dayGrid = grid.get(dayKey)!;
    let bucket = dayGrid.get(hour);
    if (!bucket) {
      bucket = [];
      dayGrid.set(hour, bucket);
    }
    bucket.push(entry);
  };

  // ---- Pass 1: runAt-anchored placement ----------------------------------
  const runAtPlaced = new Set<any>();
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

      let dayOffset: number;
      let hour: number;
      if (useLocalTz) {
        dayOffset = localDayOffset(ts, weekMonday, tz as string);
        hour = localHour(ts, tz as string);
      } else {
        const msInDay = 24 * 60 * 60 * 1000;
        dayOffset = Math.floor((ts - weekStartMs) / msInDay);
        hour = new Date(ts).getUTCHours();
      }
      if (dayOffset < 0 || dayOffset >= daysCount) continue;
      if (hour < startHour || hour >= endHour) continue;

      const minutes = task.estimatedMinutes || 60;
      const spanHours = Math.max(1, Math.ceil(minutes / 60));
      const dayKey = DAY_KEYS[dayOffset] as string;

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
      bucket.sort((a: any, b: any) => (a.sortKey ?? 0) - (b.sortKey ?? 0));
    }
  }

  const remaining = tasks.filter((t: any) => !runAtPlaced.has(t.id));

  // A bucket is "free" for unscheduled placement only if it's completely
  // empty — preserves the pre-refactor reserve semantics.
  const firstFreeHourFrom = (dayGrid: Map<number, any[]>, fromHour: number, spanHours: number): number => {
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

      const dayKey = DAY_KEYS[dayIdx] as string;
      const dayGrid = grid.get(dayKey)!;
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
      const dayGrid = grid.get(DAY_KEYS[currentDay] as string)!;
      slot = firstFreeHourFrom(dayGrid, currentHour, spanHours);
      if (slot !== -1) break;
      currentDay++;
      currentHour = startHour;
    }
    if (currentDay >= daysCount || slot === -1) break;

    const dayKey = DAY_KEYS[currentDay] as string;

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

export const TASK_CONTENT_MAX = 40;

export interface RenderGridOpts {
  startHour?: number;
  endHour?: number;
  cellWidth?: number;
  terminalWidth?: number;
  showWeekend?: boolean;
  spread?: 'pack' | 'spread';
  tz?: string;
}

/**
 * Render the weekly calendar grid as a text table.
 */
export function renderGrid({ agent, plan, opts = {} }: { agent: any; plan: any; opts?: RenderGridOpts }): { text: string; taskIndex: any[] } {
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
  const resolvedTerminalWidth =
    Number.isFinite(terminalWidth) && (terminalWidth as number) > 0
      ? (terminalWidth as number)
      : DEFAULT_TERMINAL_WIDTH;
  const cellWidth =
    Number.isFinite(cellWidthOpt) && (cellWidthOpt as number) > 0
      ? (cellWidthOpt as number)
      : computeCellWidth(resolvedTerminalWidth, daysCount);
  const dayLabels = DAY_LABELS.slice(0, daysCount);
  const dayKeys = DAY_KEYS.slice(0, daysCount);

  // Compute date labels.
  const monday = mondayFromISOWeek(plan.week, tz);
  const dateLabels = dayKeys.map((_: any, i: number) => {
    if (useLocalTz) {
      const parts = localParts(monday.getTime() + i * 86400000, tz as string);
      return `${parts.month}/${parts.day}`;
    }
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  });

  const grid = distributeTasks(plan.tasks || [], {
    startHour,
    endHour,
    daysCount,
    tz,
    spread,
    weekMonday: monday,
  });
  const taskIndex: any[] = [];

  const taskNumMap = new Map<string, number>();
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

  const lines: string[] = [];
  const hourWidth = 7; // "HH:00 "
  const totalWidth = hourWidth + (cellWidth + 1) * daysCount + 1;

  // Title
  const title = `${agent.identity?.name || agent.id} — Week ${plan.week}`;
  const status = plan.approved ? 'Approved' : 'Pending';
  lines.push(`┌${'─'.repeat(totalWidth - 2)}┐`);
  lines.push(`│ ${pad(title, totalWidth - 4)} │`);
  const displayTz = useLocalTz ? tz : 'UTC';
  const allPlanTasks = plan.tasks || [];
  const workTaskCount = allPlanTasks.filter((t: any) => !isReviewObjectiveId(t.objectiveId)).length;
  const reviewSlotCount = allPlanTasks.length - workTaskCount;
  const reviewSuffix = reviewSlotCount > 0 ? ` | Reviews: ${reviewSlotCount}` : '';
  lines.push(
    `│ ${pad(`Status: ${status} | Tasks: ${workTaskCount}${reviewSuffix} | TZ: ${displayTz}`, totalWidth - 4)} │`,
  );
  lines.push(`├${'─'.repeat(hourWidth)}${'┬' + '─'.repeat(cellWidth)}`.repeat(1).slice(0, 0) +
    `├${'─'.repeat(hourWidth)}${dayKeys.map(() => `┬${'─'.repeat(cellWidth)}`).join('')}┤`);

  // Day header row
  const headerCells = dayKeys.map((_: any, i: number) =>
    pad(`${dayLabels[i]} ${dateLabels[i]}`, cellWidth)
  );
  lines.push(`│ ${pad('Hour', hourWidth - 2)} │${headerCells.map((c: string) => `${c}│`).join('')}`);
  lines.push(`├${'─'.repeat(hourWidth)}${dayKeys.map(() => `┼${'─'.repeat(cellWidth)}`).join('')}┤`);

  const wrapTaskBlock = (entry: any): string[] => {
    const { task } = entry;
    const num = taskNumMap.get(task.id);

    if (isReviewObjectiveId(task.objectiveId)) {
      const displayName = REVIEW_DISPLAY_NAMES[task.objectiveId] ?? 'Review';
      const prefix = num != null ? `${REVIEW_SLOT_ICON} ${num}. ` : `${REVIEW_SLOT_ICON} `;
      const capped = trunc(`${prefix}${displayName}`, TASK_CONTENT_MAX);
      const chunks: string[] = [];
      for (let i = 0; i < capped.length; i += cellWidth) {
        chunks.push(pad(capped.slice(i, i + cellWidth), cellWidth));
      }
      if (chunks.length === 0) chunks.push(pad('', cellWidth));
      return chunks;
    }

    const icon = STATUS_ICONS[task.status] || '?';
    const prefix = `${icon} ${num}. `;
    const capped = trunc(`${prefix}${task.title}`, TASK_CONTENT_MAX);
    const chunks: string[] = [];
    for (let i = 0; i < capped.length; i += cellWidth) {
      chunks.push(pad(capped.slice(i, i + cellWidth), cellWidth));
    }
    if (chunks.length === 0) chunks.push(pad('', cellWidth));
    return chunks;
  };

  for (let h = startHour; h < endHour; h++) {
    const hourLabel = pad(`${String(h).padStart(2, '0')}:00`, hourWidth - 1);

    const cells = dayKeys.map((dayKey: string) => {
      const bucket = grid.get(dayKey)?.get(h);
      if (!bucket || bucket.length === 0) return [pad('', cellWidth)];
      return bucket.flatMap(wrapTaskBlock);
    });

    const linesPerCell = Math.max(...cells.map((c: string[]) => c.length), 1);
    for (const c of cells) {
      while (c.length < linesPerCell) c.push(pad('', cellWidth));
    }

    for (let ln = 0; ln < linesPerCell; ln++) {
      const hourCol = ln === 0 ? hourLabel : pad('', hourWidth - 1);
      const row = cells.map((c: string[]) => c[ln]);
      lines.push(`│${hourCol} │${row.map((c: any) => `${c}│`).join('')}`);
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
// Markdown-table renderer (responsive)
// ---------------------------------------------------------------------------

export const MD_TASK_CONTENT_MAX = 40;

export const MD_DEFAULT_MAX_TASKS_PER_CELL = 3;

export interface RenderMarkdownGridOpts extends RenderGridOpts {
  maxTasksPerCell?: number;
}

/**
 * Render the weekly calendar as a GitHub-flavored markdown table.
 */
export function renderMarkdownGrid({ agent, plan, opts = {} }: { agent: any; plan: any; opts?: RenderMarkdownGridOpts }): { text: string; taskIndex: any[] } {
  const {
    startHour = 9,
    endHour = 18,
    showWeekend = false,
    spread = 'pack',
    tz,
    maxTasksPerCell = MD_DEFAULT_MAX_TASKS_PER_CELL,
  } = opts;

  const useLocalTz = typeof tz === 'string' && tz !== 'UTC' && isValidTimeZone(tz);
  const daysCount = showWeekend ? 7 : 5;
  const dayLabels = DAY_LABELS.slice(0, daysCount);
  const dayKeys = DAY_KEYS.slice(0, daysCount);

  const monday = mondayFromISOWeek(plan.week, tz);
  const dateLabels = dayKeys.map((_: any, i: number) => {
    if (useLocalTz) {
      const parts = localParts(monday.getTime() + i * 86400000, tz as string);
      return `${parts.month}/${parts.day}`;
    }
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  });

  const grid = distributeTasks(plan.tasks || [], {
    startHour,
    endHour,
    daysCount,
    tz,
    spread,
    weekMonday: monday,
  });

  // Shared column-major numbering so numbers agree with `renderGrid`.
  const taskIndex: any[] = [];
  const taskNumMap = new Map<string, number>();
  for (const dayKey of dayKeys) {
    for (let h = startHour; h < endHour; h++) {
      const bucket = grid.get(dayKey)?.get(h);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.isStart && !taskNumMap.has(entry.task.id)) {
          const num = taskIndex.length + 1;
          taskNumMap.set(entry.task.id, num);
          taskIndex.push(entry.task);
        }
      }
    }
  }
  for (const task of plan.tasks || []) {
    if (!taskNumMap.has(task.id)) {
      const num = taskIndex.length + 1;
      taskNumMap.set(task.id, num);
      taskIndex.push(task);
    }
  }

  const formatTask = (entry: any): string | null => {
    const { task, isStart } = entry;
    if (!isStart) return null;
    const num = taskNumMap.get(task.id);
    if (isReviewObjectiveId(task.objectiveId)) {
      const displayName = REVIEW_DISPLAY_NAMES[task.objectiveId] ?? 'Review';
      const prefix = num != null ? `${REVIEW_SLOT_ICON} ${num}. ` : `${REVIEW_SLOT_ICON} `;
      return escapePipe(trunc(`${prefix}${displayName}`, MD_TASK_CONTENT_MAX));
    }
    const icon = STATUS_ICONS[task.status] || '?';
    const prefix = `${icon} ${num}. `;
    return escapePipe(trunc(`${prefix}${task.title}`, MD_TASK_CONTENT_MAX));
  };

  const headerCells = ['Hour', ...dayKeys.map((_: any, i: number) => `${dayLabels[i]} ${dateLabels[i]}`)];
  const lines: string[] = [];

  // Meta paragraph above the table
  const title = `${agent.identity?.name || agent.id} — Week ${plan.week}`;
  const status = plan.approved ? 'Approved' : 'Pending';
  const displayTz = useLocalTz ? tz : 'UTC';
  const allPlanTasks = plan.tasks || [];
  const workTaskCount = allPlanTasks.filter((t: any) => !isReviewObjectiveId(t.objectiveId)).length;
  const reviewSlotCount = allPlanTasks.length - workTaskCount;
  const reviewSuffix = reviewSlotCount > 0 ? ` | Reviews: ${reviewSlotCount}` : '';
  lines.push(`**${title}**`);
  lines.push(`Status: ${status} | Tasks: ${workTaskCount}${reviewSuffix} | TZ: ${displayTz}`);
  lines.push('');

  // Table header + separator
  lines.push(`| ${headerCells.join(' | ')} |`);
  lines.push(`| ${headerCells.map(() => '---').join(' | ')} |`);

  for (let h = startHour; h < endHour; h++) {
    const hourLabel = `${String(h).padStart(2, '0')}:00`;
    const row: string[] = [hourLabel];
    for (const dayKey of dayKeys) {
      const bucket = grid.get(dayKey)?.get(h);
      if (!bucket || bucket.length === 0) {
        row.push(' ');
        continue;
      }
      const entries = bucket.map(formatTask).filter(Boolean) as string[];
      if (entries.length === 0) {
        row.push(' ');
        continue;
      }
      const cap = Math.max(1, maxTasksPerCell);
      const visible = entries.slice(0, cap);
      const hidden = entries.length - visible.length;
      if (hidden > 0) visible.push(`+${hidden} more`);
      row.push(visible.join('<br>'));
    }
    lines.push(`| ${row.join(' | ')} |`);
  }

  lines.push('');
  lines.push(
    'Legend: ○ pending  ► in-progress  ✓ completed  ✗ failed  ⊘ skipped  → delegated  ◆ review slot',
  );
  lines.push(`Select a task number (1-${taskIndex.length}) to see details.`);

  return { text: lines.join('\n'), taskIndex };
}

/**
 * Escape literal `|` characters so they don't terminate a markdown table cell.
 */
function escapePipe(s: string): string {
  return String(s).replace(/\|/g, '\\|');
}

// ---------------------------------------------------------------------------
// Week-input resolver
// ---------------------------------------------------------------------------

/**
 * Shift an ISO week key by a number of weeks (positive or negative).
 */
function shiftWeekKey(weekKey: string, weeks: number): string {
  const monday = isoWeekToMondayDate(weekKey);
  const d = new Date(monday + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return dateToISOWeek(d.toISOString().slice(0, 10));
}

/**
 * Normalize a user-supplied week reference into the canonical YYYY-Www key.
 */
export function resolveWeekKey(input: any, tz: string = 'UTC'): string | null {
  if (input == null) return null;
  const str = String(input).trim();
  if (str === '') return null;

  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const lower = str.toLowerCase();

  if (lower === 'current' || lower === 'this' || lower === 'now') {
    return currentWeekKey(zone);
  }
  if (lower === 'next') {
    return shiftWeekKey(currentWeekKey(zone), 1);
  }
  if (lower === 'prev' || lower === 'previous' || lower === 'last') {
    return shiftWeekKey(currentWeekKey(zone), -1);
  }

  // Full ISO week key: YYYY-Www
  let m = /^(\d{4})-W(\d{1,2})$/i.exec(str);
  if (m) {
    const week = parseInt(m[2] ?? '', 10);
    if (week < 1 || week > 53) {
      throw new Error(`Invalid week number ${week} (must be 1-53)`);
    }
    return `${m[1]}-W${String(week).padStart(2, '0')}`;
  }

  // ISO date YYYY-MM-DD
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) {
    return dateToISOWeek(str);
  }

  // Bare week number
  m = /^W?(\d{1,2})$/i.exec(str);
  if (m) {
    const week = parseInt(m[1] ?? '', 10);
    if (week < 1 || week > 53) {
      throw new Error(`Invalid week number ${week} (must be 1-53)`);
    }
    const year = currentWeekKey(zone).split('-W')[0];
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  throw new Error(
    `Unrecognized week input ${JSON.stringify(input)}. ` +
      'Use YYYY-Www (e.g. 2026-W17), a date (YYYY-MM-DD), a week number ' +
      '(17 or W17), or one of: current, next, prev.',
  );
}

// ---------------------------------------------------------------------------
// Load and render
// ---------------------------------------------------------------------------

export interface LoadAndRenderGridParams {
  agentId: string;
  week?: any;
  dataDir?: string;
  opts?: RenderGridOpts & { format?: 'box' | 'markdown' };
  projectDir?: string;
}

/**
 * Load agent data and render the weekly calendar grid.
 */
export async function loadAndRenderGrid(params: LoadAndRenderGridParams): Promise<{ success: boolean; output?: string; errors?: string[]; taskIndex?: any[] }> {
  const { agentId, week, opts = {} } = params;
  const dataDir = params.dataDir || join(process.cwd(), '.aweek', 'agents');

  try {
    const agentStore = new AgentStore(dataDir);
    const weeklyPlanStore = new WeeklyPlanStore(dataDir);

    const agent = await agentStore.load(agentId);

    const resolvedOpts: any = { ...opts };
    if (resolvedOpts.tz == null) {
      try {
        const config = await loadConfig(dataDir);
        if (config?.timeZone) resolvedOpts.tz = config.timeZone;
      } catch {
        // Config read failures are non-fatal — fall back to UTC rendering.
      }
    }

    let resolvedWeek: string | null;
    try {
      resolvedWeek = resolveWeekKey(week, resolvedOpts.tz);
    } catch (err: any) {
      return { success: false, errors: [err.message] };
    }

    let plan: any;
    if (resolvedWeek) {
      try {
        plan = await weeklyPlanStore.load(agentId, resolvedWeek);
      } catch {
        const available = await weeklyPlanStore.list(agentId).catch(() => []);
        const hint = available.length
          ? ` Available weeks: ${available.join(', ')}.`
          : '';
        return {
          success: false,
          errors: [`No weekly plan found for week ${resolvedWeek}.${hint}`],
        };
      }
    } else {
      plan = await weeklyPlanStore.loadLatestApproved(agentId);
      if (!plan) {
        const plans = await weeklyPlanStore.loadAll(agentId).catch(() => []);
        plan = plans[plans.length - 1];
      }
    }

    if (!plan) {
      return { success: false, errors: ['No weekly plan found for this agent'] };
    }

    const render = resolvedOpts.format === 'markdown' ? renderMarkdownGrid : renderGrid;
    const { text, taskIndex } = render({ agent, plan, opts: resolvedOpts });
    return { success: true, output: text, taskIndex };
  } catch (err: any) {
    return { success: false, errors: [err.message] };
  }
}

/**
 * List all agents with their latest plan week.
 */
export async function listAgentsForCalendar(dataDir?: string): Promise<Array<{ id: string; name: string; latestWeek: string | null; taskCount: number; approved: boolean }>> {
  const choices = await getAgentChoices({ dataDir });
  return choices.map(({ id, name, latestWeek, taskCount, approved }: any) => ({
    id,
    name,
    latestWeek,
    taskCount,
    approved,
  }));
}
