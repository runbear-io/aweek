/**
 * Weekly calendar grid renderer — displays tasks in a day-column × hour-row grid.
 *
 * Tasks are distributed across working hours sequentially per day.
 * Each task occupies rows based on its estimatedMinutes (default: 60).
 * Activity log entries with timestamps are placed at their actual hour.
 */

import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { AgentStore } from '../storage/agent-store.js';
import { WeeklyPlanStore } from '../storage/weekly-plan-store.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the Monday date for an ISO week string like "2026-W16".
 * @param {string} isoWeek
 * @returns {Date}
 */
export function mondayFromISOWeek(isoWeek) {
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
 * Tasks are placed sequentially within each day's working hours.
 * If a day fills up, remaining tasks spill to the next day.
 *
 * @param {Array} tasks - Weekly plan tasks
 * @param {object} opts
 * @param {number} opts.startHour - First working hour (default: 9)
 * @param {number} opts.endHour - Last working hour exclusive (default: 18)
 * @param {number} opts.daysCount - Number of days to schedule across (default: 5 for weekdays)
 * @param {string} opts.spread - Distribution mode: 'pack' (fill each day) or 'spread' (round-robin across days)
 * @returns {Map<string, Map<number, object>>} dayKey -> hour -> task assignment
 */
export function distributeTasks(tasks, opts = {}) {
  const { startHour = 9, endHour = 18, daysCount = 5, spread = 'pack' } = opts;

  // grid[dayIndex][hour] = { task, isStart, spanHours }
  const grid = new Map();
  for (let d = 0; d < 7; d++) {
    grid.set(DAY_KEYS[d], new Map());
  }

  if (spread === 'spread') {
    // Round-robin: one task per day, then wrap
    const nextHour = new Array(daysCount).fill(startHour);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const dayIdx = i % daysCount;
      const minutes = task.estimatedMinutes || 60;
      const spanHours = Math.max(1, Math.ceil(minutes / 60));

      if (nextHour[dayIdx] + spanHours > endHour) continue; // skip if day full

      const dayKey = DAY_KEYS[dayIdx];
      const dayGrid = grid.get(dayKey);

      for (let h = 0; h < spanHours; h++) {
        dayGrid.set(nextHour[dayIdx] + h, {
          task,
          isStart: h === 0,
          spanHours,
          offset: h,
        });
      }

      nextHour[dayIdx] += spanHours;
    }

    return grid;
  }

  // Default 'pack' mode: fill each day sequentially
  let currentDay = 0;
  let currentHour = startHour;

  for (const task of tasks) {
    if (currentDay >= daysCount) break;

    const minutes = task.estimatedMinutes || 60;
    const spanHours = Math.max(1, Math.ceil(minutes / 60));

    // Check if task fits in current day
    if (currentHour + spanHours > endHour) {
      currentDay++;
      currentHour = startHour;
      if (currentDay >= daysCount) break;
    }

    const dayKey = DAY_KEYS[currentDay];
    const dayGrid = grid.get(dayKey);

    for (let h = 0; h < spanHours; h++) {
      dayGrid.set(currentHour + h, {
        task,
        isStart: h === 0,
        spanHours,
        offset: h,
      });
    }

    currentHour += spanHours;

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
 * @param {number} [params.opts.cellWidth=20]
 * @param {boolean} [params.opts.showWeekend=false]
 * @returns {string} Rendered grid
 */
export function renderGrid({ agent, plan, opts = {} }) {
  const {
    startHour = 9,
    endHour = 18,
    cellWidth = 20,
    showWeekend = false,
    spread = 'pack',
  } = opts;

  const daysCount = showWeekend ? 7 : 5;
  const dayLabels = DAY_LABELS.slice(0, daysCount);
  const dayKeys = DAY_KEYS.slice(0, daysCount);

  // Compute date labels
  const monday = mondayFromISOWeek(plan.week);
  const dateLabels = dayKeys.map((_, i) => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  });

  // Distribute tasks and build task index (number → task mapping)
  const grid = distributeTasks(plan.tasks || [], { startHour, endHour, daysCount, spread });
  const taskIndex = []; // 1-based: taskIndex[0] = task #1

  // Assign numbers to tasks in grid order (top-to-bottom, left-to-right)
  const taskNumMap = new Map(); // task.id → number
  for (let h = startHour; h < endHour; h++) {
    for (const dayKey of dayKeys) {
      const entry = grid.get(dayKey)?.get(h);
      if (entry?.isStart && !taskNumMap.has(entry.task.id)) {
        const num = taskIndex.length + 1;
        taskNumMap.set(entry.task.id, num);
        taskIndex.push(entry.task);
      }
    }
  }
  // Add ungridded tasks (overflow)
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
  lines.push(`│ ${pad(`Status: ${status} | Tasks: ${(plan.tasks || []).length}`, totalWidth - 4)} │`);
  lines.push(`├${'─'.repeat(hourWidth)}${'┬' + '─'.repeat(cellWidth)}`.repeat(1).slice(0, 0) +
    `├${'─'.repeat(hourWidth)}${dayKeys.map(() => `┬${'─'.repeat(cellWidth)}`).join('')}┤`);

  // Day header row
  const headerCells = dayKeys.map((_, i) =>
    pad(`${dayLabels[i]} ${dateLabels[i]}`, cellWidth)
  );
  lines.push(`│ ${pad('Hour', hourWidth - 2)} │${headerCells.map(c => `${c}│`).join('')}`);
  lines.push(`├${'─'.repeat(hourWidth)}${dayKeys.map(() => `┼${'─'.repeat(cellWidth)}`).join('')}┤`);

  // Hour rows (3 lines per hour for task description wrapping)
  const linesPerCell = 3;
  for (let h = startHour; h < endHour; h++) {
    const hourLabel = pad(`${String(h).padStart(2, '0')}:00`, hourWidth - 1);
    const cellLines = dayKeys.map(() => Array.from({ length: linesPerCell }, () => pad('', cellWidth)));

    for (let di = 0; di < dayKeys.length; di++) {
      const entry = grid.get(dayKeys[di])?.get(h);
      if (!entry) continue;

      const { task, isStart } = entry;
      const icon = STATUS_ICONS[task.status] || '?';

      if (isStart) {
        const num = taskNumMap.get(task.id);
        const prefix = `${icon} ${num}.`;
        const contPrefix = '│ ';
        const maxLine1 = cellWidth - prefix.length;
        const contWidth = cellWidth - contPrefix.length;
        const desc = task.description;

        // Word-wrap with hyphens across 3 lines
        let remaining = desc;

        // Line 1: icon + number + description start
        if (remaining.length <= maxLine1) {
          cellLines[di][0] = pad(`${prefix}${remaining}`, cellWidth);
          remaining = '';
        } else {
          cellLines[di][0] = pad(`${prefix}${remaining.slice(0, maxLine1 - 1)}-`, cellWidth);
          remaining = remaining.slice(maxLine1 - 1);
        }

        // Lines 2-3: continuation with │ prefix
        for (let ln = 1; ln < linesPerCell; ln++) {
          if (!remaining) break;
          const isLast = ln === linesPerCell - 1;
          if (remaining.length <= contWidth || isLast) {
            cellLines[di][ln] = pad(`${contPrefix}${trunc(remaining, contWidth)}`, cellWidth);
            remaining = '';
          } else {
            cellLines[di][ln] = pad(`${contPrefix}${remaining.slice(0, contWidth - 1)}-`, cellWidth);
            remaining = remaining.slice(contWidth - 1);
          }
        }
      } else {
        // Continuation row for multi-hour tasks — pipe on all lines
        for (let ln = 0; ln < linesPerCell; ln++) {
          cellLines[di][ln] = pad(`│`, cellWidth);
        }
      }
    }

    // Emit all lines for this hour
    for (let ln = 0; ln < linesPerCell; ln++) {
      const hourCol = ln === 0 ? hourLabel : pad('', hourWidth - 1);
      const row = cellLines.map(c => c[ln]);
      lines.push(`│${hourCol} │${row.map(c => `${c}│`).join('')}`);
    }
  }

  // Bottom border
  lines.push(`└${'─'.repeat(hourWidth)}${dayKeys.map(() => `┴${'─'.repeat(cellWidth)}`).join('')}┘`);

  // Legend
  lines.push('');
  lines.push(`Legend: ○ pending  ► in-progress  ✓ completed  ✗ failed  ⊘ skipped  → delegated`);
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
        // Try any plan
        const plans = agent.weeklyPlans || [];
        plan = plans[plans.length - 1];
      }
    }

    if (!plan) {
      return { success: false, errors: ['No weekly plan found for this agent'] };
    }

    const { text, taskIndex } = renderGrid({ agent, plan, opts });
    return { success: true, output: text, taskIndex };
  } catch (err) {
    return { success: false, errors: [err.message] };
  }
}

/**
 * List all agents with their latest plan week.
 *
 * @param {string} [dataDir]
 * @returns {Promise<Array<{id: string, name: string, latestWeek: string|null}>>}
 */
export async function listAgentsForCalendar(dataDir) {
  const dir = dataDir || join(process.cwd(), '.aweek', 'agents');
  try {
    const files = await readdir(dir);
    const agents = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const data = JSON.parse(await readFile(join(dir, f), 'utf-8'));
      const plans = data.weeklyPlans || [];
      const latest = plans[plans.length - 1];
      agents.push({
        id: data.id,
        name: data.identity?.name || data.id,
        latestWeek: latest?.week || null,
        taskCount: latest?.tasks?.length || 0,
        approved: latest?.approved || false,
      });
    }
    return agents;
  } catch {
    return [];
  }
}
