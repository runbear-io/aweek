/**
 * `CalendarGrid` — reusable 7-day × hour weekly calendar grid component.
 *
 * This is the visual baseline for the Calendar tab on the per-agent detail
 * page. It renders the same structure as the terminal grid produced by
 * `src/skills/weekly-calendar-grid.js` (see `renderGrid`), but with
 * Tailwind CSS + shadcn-style tokens instead of ASCII box drawing.
 *
 * Terminal-baseline parity goals:
 *   - Day columns ordered Mon → Sun (5 weekday columns by default, extended
 *     to 7 when any task slot lands on Sat/Sun — mirrors the CLI's
 *     `showWeekend` auto-extension).
 *   - Hour rows run from 09:00 to 18:00 (inclusive-exclusive), matching
 *     `DEFAULT_START_HOUR` / `DEFAULT_END_HOUR` used by
 *     `weekly-calendar-grid.js`.
 *   - Tasks placed at their `slot.hour`. Colliding hour buckets stack
 *     vertically in the cell, sorted ascending by `runAt` so their
 *     numbering is deterministic (matches the terminal ordering).
 *   - Tasks are numbered column-major (walk each day top-to-bottom, then
 *     the next day) so they cross-reference cleanly with the side task
 *     list and the CLI grid.
 *   - Status icons (`○`, `►`, `✓`, `✗`, `⊘`, `→`) and the `◆` review glyph
 *     match the terminal legend.
 *
 * Visual + interaction goals:
 *   - Fully responsive: the grid is wrapped in an overflow-x-auto scroll
 *     container so narrow viewports keep the whole week accessible without
 *     collapsing columns. A `min-w-[640px]` guarantees the day columns stay
 *     legible when scrolled.
 *   - Sticky hour column + sticky header row so scrolling a long grid keeps
 *     the axes visible (shadcn table pattern, reused here for the grid).
 *   - Tailwind-tone-per-status chips with consistent border + background
 *     treatments; contrast tuned for the dark dashboard palette used
 *     elsewhere in `src/serve/spa/**`.
 *   - ARIA roles (`grid`, `columnheader`, `rowheader`, `gridcell`) so
 *     screen-readers navigate the week like a spreadsheet.
 *   - Stable data-attributes (`data-calendar-grid`, `data-day`, `data-hour`,
 *     `data-task-id`, `data-task-number`, `data-task-status`,
 *     `data-task-review`) so tests (and future integrations) can locate
 *     cells + chips deterministically.
 *
 * Data contract:
 *   Consumes a subset of the `AgentCalendar` payload described in
 *   `src/serve/spa/lib/api-client.js`. Only `tasks`, `weekMonday`,
 *   `timeZone`, and `agentId` are read — the rest of the payload (counts,
 *   approval state, etc.) is rendered by surrounding components on the
 *   page so this component stays focused on the grid surface.
 *
 * @module serve/spa/components/calendar-grid
 */

import React, { useMemo } from 'react';

import { cn } from '../lib/cn.js';

/**
 * @typedef {import('../lib/api-client.js').AgentCalendar} AgentCalendar
 * @typedef {import('../lib/api-client.js').CalendarTask} CalendarTask
 */

// ── Constants ────────────────────────────────────────────────────────

/** Day keys in canonical Mon–Sun order — mirrors `weekly-calendar-grid.js`. */
export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
/** Day labels aligned with `DAY_KEYS`. */
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Default visible hour window — matches the terminal grid (9am–6pm). */
export const DEFAULT_START_HOUR = 9;
export const DEFAULT_END_HOUR = 18;

/**
 * Reserved `objectiveId` values indicating an advisor-mode review slot.
 * Duplicated from `src/schemas/weekly-plan.schema.js` so the SPA does not
 * reach into a Node-only module. Kept in lockstep with the terminal
 * constants by value.
 */
export const DAILY_REVIEW_OBJECTIVE_ID = 'daily-review';
export const WEEKLY_REVIEW_OBJECTIVE_ID = 'weekly-review';
export const REVIEW_OBJECTIVE_IDS = new Set([
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
]);

export const REVIEW_DISPLAY_NAMES = {
  [DAILY_REVIEW_OBJECTIVE_ID]: 'Daily Review',
  [WEEKLY_REVIEW_OBJECTIVE_ID]: 'Weekly Review',
};

/** Status icon glyphs — matches terminal baseline. */
export const STATUS_ICONS = {
  pending: '○',
  'in-progress': '►',
  completed: '✓',
  failed: '✗',
  skipped: '⊘',
  delegated: '→',
};

/** Review-slot icon — matches terminal baseline. */
export const REVIEW_ICON = '◆';

/** Status → tailwind utility string for chip borders / backgrounds. */
export const STATUS_TONE = {
  pending: 'border-slate-600 bg-slate-900/60 text-slate-200',
  'in-progress': 'border-sky-400/60 bg-sky-500/10 text-sky-200',
  completed: 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200',
  failed: 'border-red-400/60 bg-red-500/10 text-red-200',
  skipped: 'border-slate-700 bg-slate-900/40 text-slate-500',
  delegated: 'border-violet-400/60 bg-violet-500/10 text-violet-200',
};

/** Review-slot tailwind tone — amber to stand apart from work statuses. */
export const REVIEW_TONE = 'border-amber-400/50 bg-amber-500/10 text-amber-200';

// ── Public component ────────────────────────────────────────────────

/**
 * Render the 7-day × hour weekly calendar grid.
 *
 * @param {{
 *   tasks: CalendarTask[],
 *   weekMonday?: string | null,
 *   timeZone?: string,
 *   agentId?: string,
 *   startHour?: number,
 *   endHour?: number,
 *   showWeekend?: boolean,
 *   className?: string,
 * }} props
 * @returns {JSX.Element}
 */
export function CalendarGrid({
  tasks,
  weekMonday,
  timeZone,
  agentId,
  startHour = DEFAULT_START_HOUR,
  endHour = DEFAULT_END_HOUR,
  showWeekend,
  className,
}) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const { placedByDayHour, numbering } = useMemo(
    () => layoutTasks(safeTasks, { startHour, endHour }),
    [safeTasks, startHour, endHour],
  );

  // Auto-extend to the weekend whenever a slot lands on Sat/Sun so those
  // tasks don't silently disappear. Callers can force it on via
  // `showWeekend`.
  const weekendHasTasks = useMemo(() => {
    for (const task of safeTasks) {
      const key = task?.slot?.dayKey;
      if (key === 'sat' || key === 'sun') return true;
    }
    return false;
  }, [safeTasks]);

  const dayCount = showWeekend || weekendHasTasks ? 7 : 5;
  const dayKeys = DAY_KEYS.slice(0, dayCount);
  const dayLabels = DAY_LABELS.slice(0, dayCount);

  const hours = useMemo(() => {
    const out = [];
    for (let h = startHour; h < endHour; h += 1) out.push(h);
    return out;
  }, [startHour, endHour]);

  const weekMondayMs = weekMonday ? Date.parse(weekMonday) : NaN;

  return (
    <section
      className={cn(
        'overflow-x-auto rounded-md border border-slate-800 bg-slate-900/20',
        className,
      )}
      data-calendar-grid="true"
    >
      <div
        className="grid min-w-[640px] text-xs"
        style={{
          gridTemplateColumns: `72px repeat(${dayCount}, minmax(120px, 1fr))`,
        }}
        role="grid"
        aria-label={
          agentId
            ? `Weekly calendar for ${agentId}`
            : 'Weekly calendar'
        }
      >
        {/* Header row: blank corner + day headings */}
        <div
          role="columnheader"
          className="sticky left-0 z-10 border-b border-r border-slate-800 bg-slate-900/60 px-2 py-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500"
        >
          Hour
        </div>
        {dayKeys.map((dayKey, idx) => (
          <div
            key={dayKey}
            role="columnheader"
            data-day={dayKey}
            className="border-b border-r border-slate-800 bg-slate-900/40 px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-300"
          >
            <div>{dayLabels[idx]}</div>
            <div className="text-[10px] font-normal text-slate-500">
              {formatDayDate(weekMondayMs, idx, timeZone)}
            </div>
          </div>
        ))}

        {/* Hour rows */}
        {hours.map((hour) => (
          <React.Fragment key={hour}>
            <div
              role="rowheader"
              className="sticky left-0 z-10 border-b border-r border-slate-800 bg-slate-900/60 px-2 py-2 text-right text-[11px] tabular-nums text-slate-400"
            >
              {String(hour).padStart(2, '0')}:00
            </div>
            {dayKeys.map((dayKey) => {
              const entries = placedByDayHour.get(`${dayKey}:${hour}`) || [];
              return (
                <div
                  key={`${dayKey}-${hour}`}
                  role="gridcell"
                  data-day={dayKey}
                  data-hour={hour}
                  className="min-h-[44px] border-b border-r border-slate-800 p-1 align-top"
                >
                  {entries.length === 0 ? null : (
                    <div className="flex flex-col gap-1">
                      {entries.map((entry) => (
                        <TaskChip
                          key={entry.task.id}
                          task={entry.task}
                          number={numbering.get(entry.task.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

export default CalendarGrid;

// ── Subcomponents ────────────────────────────────────────────────────

/**
 * Chip representing a single task inside a grid cell.
 *
 * Baseline parity notes (matches the terminal `wrapTaskBlock` in
 * `src/skills/weekly-calendar-grid.js`):
 *   - Prefix format `{icon} {num}. {title}` is preserved via dedicated
 *     spans rather than a single truncated string — CSS clamping stands in
 *     for the terminal's `TASK_CONTENT_MAX = 40` char cap.
 *   - Status icon uses the exact glyph the CLI legend prints (`○ ► ✓ ✗ ⊘ →`).
 *   - Review slots swap the icon for `◆` and the label for the reserved
 *     display name (Daily/Weekly Review), same as the terminal grid.
 *   - When a task has a sub-hour `runAt` minute (e.g. 13:30) the chip
 *     surfaces `:MM` as a small tabular-nums label. The terminal grid
 *     distinguishes intra-hour collisions through column-major numbering
 *     on the sorted bucket; the SPA carries over that ordering via the
 *     same column-major numbering AND shows the minute badge so two
 *     stacked chips in a bucket are visually separable.
 *   - `estimatedMinutes` is surfaced in the tooltip to mirror the terminal
 *     row-span behaviour without visually stealing the cell.
 *
 * @param {{ task: CalendarTask, number: number | undefined }} props
 * @returns {JSX.Element}
 */
export function TaskChip({ task, number }) {
  const review = isReviewTask(task);
  const icon = review ? REVIEW_ICON : STATUS_ICONS[task.status] || '?';
  const tone = review
    ? REVIEW_TONE
    : STATUS_TONE[task.status] || STATUS_TONE.pending;
  const label = review
    ? REVIEW_DISPLAY_NAMES[task.objectiveId] || 'Review'
    : task.title;
  const minuteBadge = extractMinuteBadge(task);
  const titleText = [
    `${icon} ${number ? `${number}. ` : ''}${label}`,
    task.runAt ? `runAt: ${task.runAt}` : null,
    task.estimatedMinutes ? `${task.estimatedMinutes} min` : null,
    task.track ? `track: ${task.track}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      className={cn(
        'rounded border px-1.5 py-1 text-[11px] leading-snug',
        tone,
      )}
      data-task-id={task.id}
      data-task-number={number}
      data-task-status={task.status}
      data-task-review={review ? 'true' : undefined}
      data-task-title={label}
      data-task-minute={minuteBadge ?? undefined}
      title={titleText}
    >
      <div className="flex items-start gap-1">
        <span aria-hidden="true" className="font-mono">
          {icon}
        </span>
        {number != null ? (
          <span className="font-semibold tabular-nums">{number}.</span>
        ) : null}
        <span className="line-clamp-2 break-words">{label}</span>
        {minuteBadge ? (
          <span
            className="ml-auto shrink-0 font-mono tabular-nums text-[10px] opacity-70"
            aria-hidden="true"
          >
            :{minuteBadge}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Extract the two-digit minute component from a task's slot (preferred,
 * since it is already normalized to the display time zone) or from its
 * `runAt` ISO string as a fallback. Returns `null` when the minute is
 * `00` (no badge needed) or the value is unusable.
 *
 * @param {CalendarTask} task
 * @returns {string | null}
 */
export function extractMinuteBadge(task) {
  if (!task) return null;
  const slotMinute = task.slot && Number(task.slot.minute);
  if (Number.isFinite(slotMinute) && slotMinute > 0) {
    return String(slotMinute).padStart(2, '0');
  }
  if (typeof task.runAt === 'string' && task.runAt.length > 0) {
    const ts = Date.parse(task.runAt);
    if (!Number.isNaN(ts)) {
      const m = new Date(ts).getUTCMinutes();
      if (m > 0) return String(m).padStart(2, '0');
    }
  }
  return null;
}

// ── Layout helpers ───────────────────────────────────────────────────

/**
 * @param {CalendarTask} task
 * @returns {boolean}
 */
export function isReviewTask(task) {
  return !!task && REVIEW_OBJECTIVE_IDS.has(task.objectiveId || '');
}

/**
 * Distribute tasks across the (dayKey, hour) grid and assign sequential
 * display numbers in column-major order. Mirrors the terminal
 * `distributeTasks` + numbering pass in `src/skills/weekly-calendar-grid.js`
 * closely enough that a task at the same slot renders with the same number
 * as the CLI view.
 *
 * @param {CalendarTask[]} tasks
 * @param {{ startHour?: number, endHour?: number }} [opts]
 * @returns {{
 *   placedByDayHour: Map<string, Array<{ task: CalendarTask }>>,
 *   numbering: Map<string, number>,
 * }}
 */
export function layoutTasks(tasks, opts = {}) {
  const { startHour = DEFAULT_START_HOUR, endHour = DEFAULT_END_HOUR } = opts;
  const placedByDayHour = new Map();
  const withSlot = (tasks || []).filter((t) => t && t.slot);

  // Bucket every scheduled task at its slot hour. Sort collisions by
  // runAt so determinism matches the terminal grid.
  for (const task of withSlot) {
    const slot = task.slot;
    const hour = clampHour(slot.hour, startHour, endHour);
    const key = `${slot.dayKey}:${hour}`;
    const bucket = placedByDayHour.get(key) || [];
    bucket.push({ task });
    placedByDayHour.set(key, bucket);
  }
  for (const bucket of placedByDayHour.values()) {
    bucket.sort((a, b) => {
      const ta = a.task.runAt ? Date.parse(a.task.runAt) : 0;
      const tb = b.task.runAt ? Date.parse(b.task.runAt) : 0;
      return ta - tb;
    });
  }

  // Column-major numbering over the visible grid (Mon–Sun × all hours).
  const numbering = new Map();
  let counter = 0;
  for (const dayKey of DAY_KEYS) {
    for (let h = startHour; h < endHour; h += 1) {
      const bucket = placedByDayHour.get(`${dayKey}:${h}`);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (!numbering.has(entry.task.id)) {
          counter += 1;
          numbering.set(entry.task.id, counter);
        }
      }
    }
  }
  // Anything still unnumbered (unscheduled or out-of-window) gets trailing
  // numbers so the Backlog list stays addressable.
  for (const task of tasks || []) {
    if (!task) continue;
    if (!numbering.has(task.id)) {
      counter += 1;
      numbering.set(task.id, counter);
    }
  }

  return { placedByDayHour, numbering };
}

/**
 * Clamp an hour integer into the visible grid window, falling back to the
 * start-hour when the value is unusable. Mirrors the terminal distributor's
 * "skip tasks outside the visible window" behaviour, but keeps the task
 * visible by snapping to the nearest edge instead of dropping it — the
 * SPA can afford that since the Backlog list already covers overflow.
 */
function clampHour(h, startHour = DEFAULT_START_HOUR, endHour = DEFAULT_END_HOUR) {
  const n = Number(h);
  if (!Number.isFinite(n)) return startHour;
  if (n < startHour) return startHour;
  if (n >= endHour) return endHour - 1;
  return Math.floor(n);
}

/**
 * Format `Monday 00:00 + N days` as `MM/DD` in the calendar's timezone,
 * with a safe fallback to the UTC calendar date when the timezone isn't
 * a valid IANA name (matches the terminal grid's behaviour for malformed
 * zones).
 *
 * @param {number} weekMondayMs
 * @param {number} dayOffset
 * @param {string | undefined} timeZone
 * @returns {string}
 */
export function formatDayDate(weekMondayMs, dayOffset, timeZone) {
  if (!Number.isFinite(weekMondayMs)) return '';
  const ms = weekMondayMs + dayOffset * 86_400_000;
  const date = new Date(ms);
  try {
    if (timeZone && timeZone !== 'UTC') {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'numeric',
        day: 'numeric',
      });
      return fmt.format(date);
    }
  } catch {
    /* fall through to UTC */
  }
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}
