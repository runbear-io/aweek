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
 *     collapsing columns. The column track widens at the Tailwind `md`
 *     breakpoint — `52px + N × minmax(88px, 1fr)` below `md` so a 3-day
 *     mobile strip totals ~316 px and fits a 375 px viewport without
 *     forcing horizontal scroll on the grid wrapper, then expands to
 *     `72px + N × minmax(120px, 1fr)` at `md+` so the desktop layout
 *     stays visually identical to the historical baseline.
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
 * TypeScript migration note (AC 203, Sub-AC 3.3):
 *   Converted from `.jsx` → `.tsx`. The exported component, helpers, and
 *   constant tables are now typed against the `CalendarTask` /
 *   `CalendarTaskSlot` shapes published by `lib/api-client.js`. Grid-cell
 *   rendering primitives (numbering, placement bucket entries) get
 *   dedicated structural types so callers can safely consume them. The
 *   `cn` helper, `api-client`, and any sibling `.js` modules remain
 *   untyped JS for this phase and are imported through their `.js`
 *   extensions per the SPA's `allowJs` policy.
 *
 * @module serve/spa/components/calendar-grid
 */

import * as React from 'react';
import { useLayoutEffect, useMemo, useRef } from 'react';

import { cn } from '../lib/cn.js';
import { useIsMobile } from '../hooks/use-is-mobile.js';

// ── Cross-boundary types ────────────────────────────────────────────

// `lib/api-client.js` is still authored as JSDoc-typed JS. Its module
// exports the structural typedefs we need; pull them across the boundary
// via an `import('...')` type-only reference so this `.tsx` stays free of
// any value-level dependency on the still-`.js` client.
type AgentCalendar = import('../lib/api-client.js').AgentCalendar;
export type CalendarTask = import('../lib/api-client.js').CalendarTask;
export type CalendarTaskSlot = import('../lib/api-client.js').CalendarTaskSlot;

/** Day-of-week key shared with the terminal grid + `CalendarTaskSlot.dayKey`. */
export type DayKey = CalendarTaskSlot['dayKey'];

/**
 * Status string surfaced by `CalendarTask.status`. The wire type widens to
 * `string` (servers can ship anything), so this alias narrows it to the
 * known values we actively style — anything outside the union still
 * type-checks (the underlying field is `string`) but missing entries fall
 * back to the `pending` tone at runtime.
 */
export type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'delegated';

/** Reserved review-slot `objectiveId` values. */
export type ReviewObjectiveId = 'daily-review' | 'weekly-review';

/** A task entry placed in a single (day, hour) bucket of the grid. */
export interface PlacedTaskEntry {
  task: CalendarTask;
}

/** Bucketed-task layout output consumed by `CalendarGrid` and re-exported helpers. */
export interface CalendarLayout {
  /** Map keyed by `${dayKey}:${hour}` → tasks rendered in that cell. */
  placedByDayHour: Map<string, PlacedTaskEntry[]>;
  /** Map keyed by `task.id` → 1-based display number (column-major). */
  numbering: Map<string, number>;
}

/** Options accepted by `layoutTasks` to scope the visible hour window. */
export interface LayoutOptions {
  startHour?: number;
  endHour?: number;
}

// ── Constants ────────────────────────────────────────────────────────

/** Day keys in canonical Mon–Sun order — mirrors `weekly-calendar-grid.js`. */
export const DAY_KEYS: readonly DayKey[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];
/** Day labels aligned with `DAY_KEYS`. */
export const DAY_LABELS: readonly string[] = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
];

/** Default visible hour window — matches the terminal grid (9am–6pm). */
// Full-day window by default. The calendar used to narrow to 9–18 but
// that silently clamped tasks scheduled outside office hours onto the
// edge rows, which read as placement bugs. 0–24 keeps every runAt in
// its real slot. Callers that want a tighter window can still override
// via props.
export const DEFAULT_START_HOUR = 0;
export const DEFAULT_END_HOUR = 24;

/**
 * Reserved `objectiveId` values indicating an advisor-mode review slot.
 * Duplicated from `src/schemas/weekly-plan.schema.js` so the SPA does not
 * reach into a Node-only module. Kept in lockstep with the terminal
 * constants by value.
 */
export const DAILY_REVIEW_OBJECTIVE_ID: ReviewObjectiveId = 'daily-review';
export const WEEKLY_REVIEW_OBJECTIVE_ID: ReviewObjectiveId = 'weekly-review';
export const REVIEW_OBJECTIVE_IDS: ReadonlySet<string> = new Set<string>([
  DAILY_REVIEW_OBJECTIVE_ID,
  WEEKLY_REVIEW_OBJECTIVE_ID,
]);

export const REVIEW_DISPLAY_NAMES: Readonly<Record<ReviewObjectiveId, string>> = {
  [DAILY_REVIEW_OBJECTIVE_ID]: 'Daily Review',
  [WEEKLY_REVIEW_OBJECTIVE_ID]: 'Weekly Review',
};

/** Status icon glyphs — matches terminal baseline. */
export const STATUS_ICONS: Readonly<Record<TaskStatus, string>> = {
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
export const STATUS_TONE: Readonly<Record<TaskStatus, string>> = {
  pending: 'border-border bg-muted/60 text-foreground',
  'in-progress': 'border-sky-400/60 bg-sky-500/10 text-sky-200',
  completed: 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200',
  failed: 'border-red-400/60 bg-red-500/10 text-red-200',
  skipped: 'border-border bg-muted/40 text-muted-foreground',
  delegated: 'border-violet-400/60 bg-violet-500/10 text-violet-200',
};

/** Review-slot tailwind tone — amber to stand apart from work statuses. */
export const REVIEW_TONE = 'border-amber-400/50 bg-amber-500/10 text-amber-200';

// ── Public component ────────────────────────────────────────────────

/**
 * Number of day columns the grid renders. Constrained to a fixed set so
 * the grid never silently drops below 1 or past the calendar week (7).
 *
 * - `1` / `3` are the mobile layouts (AC 4 sub-AC 2): a single-day or
 *   three-day strip that fits a 375px viewport without horizontal
 *   scrolling.
 * - `5` is the desktop weekday default (Mon–Fri).
 * - `7` is the full week, used when tasks land on Sat/Sun or the caller
 *   explicitly opts in via `showWeekend`.
 */
export type DaysToShow = 1 | 3 | 5 | 7;

export interface CalendarGridProps {
  /** Tasks to render in the grid (see `lib/api-client.js#CalendarTask`). */
  tasks: ReadonlyArray<CalendarTask>;
  /** Monday 00:00 of the rendered week as an ISO timestamp, if known. */
  weekMonday?: string | null;
  /** IANA time zone used to format day-date headers (defaults to UTC). */
  timeZone?: string;
  /** Agent slug — included only in the grid's `aria-label`. */
  agentId?: string;
  /** Inclusive lower bound of the visible hour window (default 0). */
  startHour?: number;
  /** Exclusive upper bound of the visible hour window (default 24). */
  endHour?: number;
  /** Force the 7-day mode even when no tasks land on the weekend. */
  showWeekend?: boolean;
  /**
   * Override the auto-computed column count. When provided, the grid
   * renders exactly `daysToShow` consecutive day columns starting from
   * `anchorDayKey` (or the closest valid offset that still fits a full
   * `daysToShow` window inside Mon–Sun). Used by the mobile layout to
   * collapse the 7-day grid into a 1- or 3-day strip below the Tailwind
   * `md` breakpoint. When `undefined`, the grid falls back to the
   * existing 5-day-default-with-auto-weekend-extension behaviour.
   */
  daysToShow?: DaysToShow;
  /**
   * The leftmost day column when `daysToShow` is set. Defaults to `'mon'`
   * so the grid mirrors the desktop layout when no anchor is provided.
   * The grid clamps the anchor backwards if it would push the visible
   * window past Sunday — e.g. anchor `'sun'` with `daysToShow=3` slides
   * back to start at Friday so three full columns still render.
   */
  anchorDayKey?: DayKey;
  /** Caller-supplied class names merged with the default Tailwind recipe. */
  className?: string;
  /**
   * Click handler for an individual task chip. When provided, chips render
   * as `<button>`s; otherwise they render as plain `<div>`s.
   */
  onSelectTask?: (task: CalendarTask) => void;
}

/**
 * Render the 7-day × hour weekly calendar grid.
 */
export function CalendarGrid({
  tasks,
  weekMonday,
  timeZone,
  agentId,
  startHour = DEFAULT_START_HOUR,
  endHour = DEFAULT_END_HOUR,
  showWeekend,
  daysToShow,
  anchorDayKey,
  className,
  onSelectTask,
}: CalendarGridProps): React.ReactElement {
  const safeTasks: ReadonlyArray<CalendarTask> = Array.isArray(tasks) ? tasks : [];
  const { placedByDayHour, numbering } = useMemo<CalendarLayout>(
    () => layoutTasks(safeTasks, { startHour, endHour }),
    [safeTasks, startHour, endHour],
  );

  // Auto-extend to the weekend whenever a slot lands on Sat/Sun so those
  // tasks don't silently disappear. Callers can force it on via
  // `showWeekend`.
  const weekendHasTasks = useMemo<boolean>(() => {
    for (const task of safeTasks) {
      const key = task?.slot?.dayKey;
      if (key === 'sat' || key === 'sun') return true;
    }
    return false;
  }, [safeTasks]);

  // When the caller explicitly sets `daysToShow`, that value wins outright
  // — it's how the mobile layout collapses the 7-day grid into a 1- or
  // 3-day strip. The anchor + clamp keep the visible window inside Mon–Sun
  // even when the requested anchor sits late in the week (e.g. `'sun'`
  // with three columns shifts back to start at Friday so three full
  // columns still fit). When `daysToShow` is `undefined`, fall back to
  // the historical 5-day default with the auto-weekend extension.
  const { dayKeys, dayLabels, dayCount } = useMemo<{
    dayKeys: ReadonlyArray<DayKey>;
    dayLabels: ReadonlyArray<string>;
    dayCount: number;
  }>(() => {
    if (typeof daysToShow === 'number') {
      const requested = Math.max(1, Math.min(7, daysToShow));
      const anchorIdx = anchorDayKey ? DAY_KEYS.indexOf(anchorDayKey) : 0;
      const safeAnchorIdx = anchorIdx < 0 ? 0 : anchorIdx;
      const startIdx = Math.min(safeAnchorIdx, 7 - requested);
      const endIdx = startIdx + requested;
      return {
        dayKeys: DAY_KEYS.slice(startIdx, endIdx),
        dayLabels: DAY_LABELS.slice(startIdx, endIdx),
        dayCount: requested,
      };
    }
    const fallbackCount = showWeekend || weekendHasTasks ? 7 : 5;
    return {
      dayKeys: DAY_KEYS.slice(0, fallbackCount),
      dayLabels: DAY_LABELS.slice(0, fallbackCount),
      dayCount: fallbackCount,
    };
  }, [daysToShow, anchorDayKey, showWeekend, weekendHasTasks]);

  const hours = useMemo<number[]>(() => {
    const out: number[] = [];
    for (let h = startHour; h < endHour; h += 1) out.push(h);
    return out;
  }, [startHour, endHour]);

  const weekMondayMs = weekMonday ? Date.parse(weekMonday) : NaN;

  // Earliest hour anywhere across the week's placed tasks. Used to seed
  // the grid's default scroll position so users land on the busy stretch
  // of their day instead of midnight when the visible window is 0–24.
  const earliestTaskHour = useMemo<number | null>(() => {
    let min: number | null = null;
    for (const task of safeTasks) {
      const h = task?.slot?.hour;
      if (typeof h !== 'number' || Number.isNaN(h)) continue;
      if (h < startHour || h >= endHour) continue;
      if (min === null || h < min) min = h;
    }
    return min;
  }, [safeTasks, startHour, endHour]);

  const sectionRef = useRef<HTMLElement | null>(null);

  // Sub-AC 2.2 — fit the calendar grid inside a 375 px viewport without
  // forcing horizontal scroll on the wrapper. The desktop track
  // (`72px + 5 × minmax(120px, 1fr)` = 672 px) is wider than the mobile
  // viewport's main column (≈ 343 px after the layout's `p-4` gutter), so
  // even after AC 4 sub-AC 2 collapsed the grid to a 3-day strip the
  // mobile total was still `72 + 3 × 120 = 432 px`. Below `md` we use a
  // tighter set of tracks (`52px + N × minmax(88px, 1fr)`) so the 3-day
  // strip totals ~316 px and the `1fr` flexes to fill the actual main
  // column width without spilling. Desktop layouts (`md+`) keep the
  // historical 72/120 tracks unchanged.
  const isMobile = useIsMobile();
  const hourColumnWidth = isMobile ? 52 : 72;
  const dayColumnMinWidth = isMobile ? 88 : 120;

  // Position the scroll one hour above the earliest task on first render
  // (and whenever the earliest hour changes — e.g. switching weeks). Uses
  // useLayoutEffect so the user never sees the grid flash at 00:00 before
  // jumping. The sticky header row would otherwise overlap the target row,
  // so we subtract its height before setting scrollTop.
  useLayoutEffect(() => {
    if (earliestTaskHour == null) return;
    const section = sectionRef.current;
    if (!section) return;
    const targetHour = Math.max(startHour, earliestTaskHour - 1);
    const row = section.querySelector(
      `[role="rowheader"][data-hour="${targetHour}"]`,
    );
    if (!row) return;
    const sectionRect = section.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const headerCorner = section.querySelector('[role="columnheader"]');
    const headerHeight = headerCorner
      ? headerCorner.getBoundingClientRect().height
      : 0;
    const offset =
      rowRect.top - sectionRect.top + section.scrollTop - headerHeight;
    section.scrollTop = Math.max(0, offset);
  }, [earliestTaskHour, startHour]);

  return (
    <section
      ref={sectionRef}
      className={cn(
        // Sub-AC 2.2 — `max-w-full` keeps the wrapper bounded by its
        // parent's width even when the inner grid would otherwise want
        // to grow past it; combined with `overflow-x-auto` this
        // contains horizontal scroll inside the wrapper rather than
        // pushing the whole page sideways at 375 px.
        'max-w-full overflow-x-auto rounded-md border border-border bg-muted/20',
        className,
      )}
      data-calendar-grid="true"
    >
      <div
        className="grid text-xs"
        style={{
          gridTemplateColumns: `${hourColumnWidth}px repeat(${dayCount}, minmax(${dayColumnMinWidth}px, 1fr))`,
        }}
        role="grid"
        aria-label={agentId ? `Weekly calendar for ${agentId}` : 'Weekly calendar'}
      >
        {/* Header row: blank corner + day headings. The corner cell is
            pinned to both axes (top-left), the day cells are pinned to the
            top so they stay visible while scrolling the grid vertically.
            `z-20` on the corner keeps it above the row headers (z-10) and
            day-header cells (z-10) where they meet. */}
        <div
          role="columnheader"
          className="sticky left-0 top-0 z-20 border-b border-r border-border bg-muted/60 px-1 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground md:px-2"
        >
          Hour
        </div>
        {dayKeys.map((dayKey, idx) => {
          // The date label is offset from Monday, not from the start of
          // the visible window — when the mobile layout slices a 1- or
          // 3-day strip starting at, say, Wednesday, the absolute offset
          // from Monday is what `formatDayDate` needs to render the right
          // calendar date.
          const absoluteOffset = DAY_KEYS.indexOf(dayKey);
          return (
            <div
              key={dayKey}
              role="columnheader"
              data-day={dayKey}
              className="sticky top-0 z-10 border-b border-r border-border bg-muted/40 px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-foreground"
            >
              <div>{dayLabels[idx]}</div>
              <div className="text-[10px] font-normal text-muted-foreground">
                {formatDayDate(weekMondayMs, absoluteOffset, timeZone)}
              </div>
            </div>
          );
        })}

        {/* Hour rows */}
        {hours.map((hour) => (
          <React.Fragment key={hour}>
            <div
              role="rowheader"
              data-hour={hour}
              className="sticky left-0 z-10 border-b border-r border-border bg-muted/60 px-1 py-2 text-right text-[10px] tabular-nums text-muted-foreground md:px-2 md:text-[11px]"
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
                  className="min-h-11 border-b border-r border-border p-1 align-top"
                >
                  {entries.length === 0 ? null : (
                    <div className="flex flex-col gap-1">
                      {entries.map((entry) => (
                        <TaskChip
                          key={entry.task.id}
                          task={entry.task}
                          number={numbering.get(entry.task.id)}
                          onSelect={onSelectTask}
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

export interface TaskChipProps {
  task: CalendarTask;
  number: number | undefined;
  onSelect?: (task: CalendarTask) => void;
}

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
 */
export function TaskChip({
  task,
  number,
  onSelect,
}: TaskChipProps): React.ReactElement {
  const review = isReviewTask(task);
  const status = task.status as TaskStatus;
  const icon = review ? REVIEW_ICON : STATUS_ICONS[status] || '?';
  const tone = review ? REVIEW_TONE : STATUS_TONE[status] || STATUS_TONE.pending;
  const reviewKey =
    task.objectiveId && task.objectiveId in REVIEW_DISPLAY_NAMES
      ? (task.objectiveId as ReviewObjectiveId)
      : null;
  const label = review
    ? (reviewKey ? REVIEW_DISPLAY_NAMES[reviewKey] : 'Review')
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

  // Common data attributes shared by both the interactive (button) and
  // the static (div) renderings of the chip.
  const dataAttrs = {
    'data-task-id': task.id,
    'data-task-number': number,
    'data-task-status': task.status,
    'data-task-review': review ? 'true' : undefined,
    'data-task-title': label,
    'data-task-minute': minuteBadge ?? undefined,
    title: titleText,
  } as const;

  // Numbering is preserved on `data-task-number` (used by tests + the
  // layout helpers) but no longer rendered as visible chip prefix —
  // task chips read better at a glance with just the icon + label.
  void number;
  // Sub-AC 2.2: `min-w-0 flex-1` lets the label shrink + grow inside the
  // narrower mobile day-column tracks (88 px min) without pushing past
  // the chip's own bounds. Without it, flex's default `min-width: auto`
  // sizes the label to its content and would force the chip wider than
  // the cell on long titles, manifesting as horizontal overflow inside
  // the calendar grid wrapper at 375 px.
  const innerContent = (
    <div className="flex w-full items-start gap-1.5 md:gap-1">
      <span aria-hidden="true" className="shrink-0 font-mono">
        {icon}
      </span>
      <span className="min-w-0 flex-1 line-clamp-2 break-words">{label}</span>
      {minuteBadge ? (
        <span
          className="ml-auto shrink-0 font-mono tabular-nums text-[10px] opacity-70"
          aria-hidden="true"
        >
          :{minuteBadge}
        </span>
      ) : null}
    </div>
  );

  // Mobile-first sizing: `min-h-[44px]` + larger padding/typography below
  // `md` keeps task chips at the 44×44 px touch target the dashboard's
  // mobile polish goal calls for, while the `md:` overrides revert to the
  // compact desktop density (the original `px-1.5 py-1 text-[11px]` look)
  // so the weekly grid still fits Mon–Fri on a laptop without churn.
  const chipBaseClass =
    'flex min-h-[44px] w-full items-stretch rounded border px-2 py-2 text-left text-xs leading-snug md:min-h-0 md:px-1.5 md:py-1 md:text-[11px]';

  if (onSelect) {
    return (
      <button
        type="button"
        onClick={() => onSelect(task)}
        className={cn(
          chipBaseClass,
          'transition-colors cursor-pointer hover:ring-1 hover:ring-ring focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          tone,
        )}
        {...dataAttrs}
      >
        {innerContent}
      </button>
    );
  }

  return (
    <div className={cn(chipBaseClass, tone)} {...dataAttrs}>
      {innerContent}
    </div>
  );
}

/**
 * Extract the two-digit minute component from a task's slot (preferred,
 * since it is already normalized to the display time zone) or from its
 * `runAt` ISO string as a fallback. Returns `null` when the minute is
 * `00` (no badge needed) or the value is unusable.
 */
export function extractMinuteBadge(
  task: Partial<CalendarTask> | null | undefined,
): string | null {
  if (!task) return null;
  const slotMinute = task.slot ? Number(task.slot.minute) : NaN;
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
 * Whether a task is a reserved review slot (daily-review / weekly-review).
 *
 * Tolerates `null` / `undefined` / partial inputs so test-only fixtures
 * that don't bother filling in every `CalendarTask` field still type-check.
 */
export function isReviewTask(
  task: Pick<CalendarTask, 'objectiveId'> | null | undefined,
): boolean {
  return !!task && REVIEW_OBJECTIVE_IDS.has(task.objectiveId || '');
}

/**
 * Distribute tasks across the (dayKey, hour) grid and assign sequential
 * display numbers in column-major order. Mirrors the terminal
 * `distributeTasks` + numbering pass in `src/skills/weekly-calendar-grid.js`
 * closely enough that a task at the same slot renders with the same number
 * as the CLI view.
 */
export function layoutTasks(
  tasks: ReadonlyArray<CalendarTask> | null | undefined,
  opts: LayoutOptions = {},
): CalendarLayout {
  const { startHour = DEFAULT_START_HOUR, endHour = DEFAULT_END_HOUR } = opts;
  const placedByDayHour = new Map<string, PlacedTaskEntry[]>();
  const allTasks: ReadonlyArray<CalendarTask> = tasks || [];
  const withSlot = allTasks.filter(
    (t): t is CalendarTask & { slot: CalendarTaskSlot } => !!t && !!t.slot,
  );

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
  const numbering = new Map<string, number>();
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
  for (const task of allTasks) {
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
function clampHour(
  h: number | null | undefined,
  startHour: number = DEFAULT_START_HOUR,
  endHour: number = DEFAULT_END_HOUR,
): number {
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
 */
export function formatDayDate(
  weekMondayMs: number,
  dayOffset: number,
  timeZone: string | undefined,
): string {
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

// Keep the parent `AgentCalendar` type referenced by an exported alias so
// downstream callers that imported it from this module's old `.jsx` doc
// comment still have a path to the same shape.
export type { AgentCalendar };
