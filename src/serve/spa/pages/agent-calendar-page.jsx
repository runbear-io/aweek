/**
 * `AgentCalendarPage` — per-agent Calendar tab (AC 2, Sub-AC 2).
 *
 * Data contract (Sub-AC 3.3):
 *   Data is sourced _exclusively_ from `useAgentCalendar(slug)`. No
 *   `props.calendar`, no `window.__INITIAL_DATA__`, no SSR HTML
 *   fragment reading. Props exist only for navigation and test injection.
 *
 * Grid extraction (AC 3, Sub-AC 2):
 *   The 7-day × hour grid itself lives in the reusable
 *   `../components/calendar-grid.jsx` component. This page owns the
 *   surrounding page chrome — data fetching, header, counts strip,
 *   Backlog list, and legend — and delegates the visual grid to
 *   `CalendarGrid`. Layout helpers (`layoutTasks`, `isReviewTask`,
 *   status icons / tones, etc.) are re-exported from that module, so
 *   imports that target this page's public surface still resolve.
 *
 * Baseline parity (per `src/skills/weekly-calendar-grid.js` + the
 * terminal `/aweek:calendar` command):
 *   - Title header with agent/week + Approved/Pending badge + timezone
 *   - Work-task count, review-slot count
 *   - 5-day grid (Mon–Fri) × working hours (9–18) with optional weekend
 *   - Tasks placed on their `slot.hour`, spanning rows by estimatedMinutes
 *   - Status icons: ○ pending, ► in-progress, ✓ completed, ✗ failed,
 *     ⊘ skipped, → delegated, ◆ review-slot
 *   - Tasks numbered in column-major order so users can cross-reference
 *     the side task list
 *   - Unscheduled tasks surfaced in a "Backlog" side list so no task is
 *     hidden when `runAt` is absent or falls outside the visible window
 *   - Status counts + legend
 *
 * Styling (Sub-AC 2.2):
 *   The Calendar tab's surrounding chrome (header, counts strip, backlog,
 *   empty / loading / error states, stale banner) is composed from stock
 *   shadcn primitives (`Badge`, `Button`, `Card`, `CardHeader`, `CardTitle`,
 *   `CardContent`, `CardDescription`, `ScrollArea`). Every colour utility
 *   resolves to a shadcn design token declared in `styles/globals.css`
 *   (`--foreground`, `--muted-foreground`, `--muted`, `--destructive`, …)
 *   so the page re-themes correctly in both light and dark modes without
 *   any bespoke palette overrides. No hardcoded colour utilities live
 *   here anymore.
 *
 *   The approval badge maps `approved → variant="default"` and
 *   `pending → variant="outline"` since the stock `Badge` primitive only
 *   exposes `default`, `secondary`, `destructive`, and `outline` variants
 *   (no bespoke `success` / `warning` recipes). The error Card mirrors
 *   the destructive-tinted chrome used by the Overview page error path,
 *   and the stale banner uses the neutral muted surface used by the
 *   Overview page's advisory banner — so every surface in the SPA reads
 *   as part of the same primitive family.
 *
 *   The inner grid is still owned by `CalendarGrid`, which manages its
 *   own Tailwind chrome.
 *
 * @module serve/spa/pages/agent-calendar-page
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.jsx';
import { ScrollArea } from '../components/ui/scroll-area.jsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../components/ui/sheet.jsx';
import { cn } from '../lib/cn.js';
import { useAgentCalendar } from '../hooks/use-agent-calendar.js';
import { useExecutionLog } from '../hooks/use-execution-log.js';
import { Markdown } from '../components/execution-log-view.jsx';
import {
  CalendarGrid,
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  REVIEW_DISPLAY_NAMES,
  REVIEW_ICON,
  STATUS_ICONS,
  isReviewTask,
  layoutTasks,
} from '../components/calendar-grid.jsx';

/**
 * @typedef {import('../lib/api-client.js').AgentCalendar} AgentCalendar
 * @typedef {import('../lib/api-client.js').CalendarTask} CalendarTask
 */

// Re-export the grid layout helpers + geometry constants so existing
// imports (tests, and any future consumer that reaches for the page's
// public surface) keep working after the component extraction.
export {
  CalendarGrid,
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  isReviewTask,
  layoutTasks,
};

/**
 * @param {{
 *   slug: string,
 *   week?: string,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 * @returns {JSX.Element}
 */
export function AgentCalendarPage({
  slug,
  week,
  baseUrl,
  fetch: fetchImpl,
  selectedTaskId,
  onOpenTaskId,
  onCloseTaskId,
}) {
  const { data, error, loading, refresh } = useAgentCalendar(slug, {
    week,
    baseUrl,
    fetch: fetchImpl,
  });
  // Drawer state defaults to local — tests and standalone use cases
  // never hand over URL-driven open/close. When the router-aware
  // parent threads `selectedTaskId` + `onOpenTaskId` / `onCloseTaskId`,
  // the URL becomes the source of truth.
  const [internalTaskId, setInternalTaskId] = useState(null);
  const effectiveTaskId =
    selectedTaskId !== undefined ? selectedTaskId : internalTaskId;

  if (!slug) {
    return <CalendarEmpty message="Select an agent to view its calendar." />;
  }
  if (loading && !data) return <CalendarSkeleton />;
  if (error && error.status === 404) {
    return (
      <CalendarEmpty message={`No agent found for slug "${slug}".`} />
    );
  }
  if (error && !data) return <CalendarError error={error} onRetry={refresh} />;
  if (!data) return <CalendarEmpty message={`No calendar data for "${slug}".`} />;

  if (data.noPlan) {
    return (
      <section
        className="flex flex-col gap-3"
        data-page="agent-calendar"
        data-tab-body="calendar"
        data-agent-slug={data.agentId}
        data-state="no-plan"
      >
        <CalendarHeader calendar={data} />
        {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
        <Card className="border-dashed" data-state="no-plan">
          <CardContent className="p-6 text-sm italic text-muted-foreground">
            No weekly plan yet for{' '}
            <strong className="not-italic text-foreground">
              {data.agentId}
            </strong>
            . Run{' '}
            <code className="not-italic text-foreground">/aweek:plan</code> to
            draft and approve a weekly plan.
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section
      // `flex-1 min-h-0` plumbs the layout's flex chain into the calendar
      // tab so the inner CalendarGrid fills the viewport vertically and
      // scrolls internally instead of pushing the page past the fold.
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-page="agent-calendar"
      data-tab-body="calendar"
      data-agent-slug={data.agentId}
      data-week={data.week}
    >
      <CalendarHeader calendar={data} />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      <StatusLegend tasks={data.tasks} counts={data.counts} />
      <CalendarGrid
        tasks={data.tasks}
        weekMonday={data.weekMonday}
        timeZone={data.timeZone}
        agentId={data.agentId}
        // Take the remaining vertical space inside the calendar tab and own
        // both-axis scrolling. The flex-1 + min-h-0 chain runs from
        // `<Layout>`'s main container down through the agent-detail section,
        // the Tabs primitive, the active TabsContent, and the agent-calendar
        // section, so this element fills exactly the leftover viewport
        // height (no calc heuristics) and scrolls internally when content
        // overflows. The grid's existing sticky header row + sticky hour
        // column anchor to this scroll container.
        className="min-h-0 flex-1 overflow-auto"
        onSelectTask={(t) => {
          if (!t?.id) return;
          if (typeof onOpenTaskId === 'function') onOpenTaskId(t.id);
          else setInternalTaskId(t.id);
        }}
      />
      <Backlog calendar={data} />
      <TaskDetailSheet
        task={
          effectiveTaskId
            ? data.tasks?.find((t) => t.id === effectiveTaskId) || {
                id: effectiveTaskId,
                title: '',
                status: 'pending',
              }
            : null
        }
        agentSlug={data.agentId}
        activity={
          effectiveTaskId ? data.activityByTask?.[effectiveTaskId] || [] : []
        }
        baseUrl={baseUrl}
        fetchImpl={fetchImpl}
        onClose={() => {
          if (typeof onCloseTaskId === 'function') onCloseTaskId();
          else setInternalTaskId(null);
        }}
      />
    </section>
  );
}

/**
 * Right-side shadcn Sheet surfacing the fields of a single calendar task.
 * Opens when a `TaskChip` is clicked and the parent page sets `task` to a
 * non-null value. Closing sets `task` back to `null` via `onClose`.
 *
 * `activity` is the pre-fetched array of activity-log entries bucketed
 * for this task by the calendar endpoint. Each entry may carry an
 * `executionLogBasename` so we can deep-link to the full NDJSON log page.
 *
 * @param {{
 *   task: CalendarTask | null,
 *   agentSlug?: string,
 *   activity?: Array<object>,
 *   onClose: () => void
 * }} props
 */
function TaskDetailSheet({ task, agentSlug, activity = [], baseUrl, fetchImpl, onClose }) {
  const open = task != null;
  const review = task ? isReviewTask(task) : false;
  const icon = task
    ? review
      ? REVIEW_ICON
      : STATUS_ICONS[task.status] || '?'
    : '';
  const label = task
    ? review
      ? REVIEW_DISPLAY_NAMES[task.objectiveId] || 'Review'
      : task.title
    : '';
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        {task ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span aria-hidden="true" className="font-mono">
                  {icon}
                </span>
                <span>{label}</span>
              </SheetTitle>
              {task.objectiveId ? (
                <SheetDescription>
                  Objective{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                    {task.objectiveId}
                  </code>
                </SheetDescription>
              ) : null}
            </SheetHeader>
            <div className="mt-6 grid gap-4 text-sm">
              <TaskField label="Status">
                <Badge variant="outline" className="capitalize">
                  {task.status || 'unknown'}
                </Badge>
              </TaskField>
              {task.runAt ? (
                <TaskField label="Run at">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                    {task.runAt}
                  </code>
                </TaskField>
              ) : null}
              {task.estimatedMinutes ? (
                <TaskField label="Estimate">
                  {task.estimatedMinutes} min
                </TaskField>
              ) : null}
              {task.track ? (
                <TaskField label="Track">{task.track}</TaskField>
              ) : null}
              {task.prompt ? (
                <TaskField label="Prompt">
                  <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs text-foreground">
                    {task.prompt}
                  </pre>
                </TaskField>
              ) : null}
              {task.id ? (
                <TaskField label="Task ID">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                    {task.id}
                  </code>
                </TaskField>
              ) : null}
              <TaskActivityList
                activity={activity}
                agentSlug={agentSlug}
                baseUrl={baseUrl}
                fetchImpl={fetchImpl}
              />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Chronological list of activity-log entries belonging to the selected
 * task. Each entry is rendered as a full-row link to
 * `/agents/:slug/activities/:basename` (the activity drawer route) when
 * a heartbeat recorded an `executionLogBasename`. The execution log's
 * final output is fetched lazily and previewed inline below each row so
 * users can scan results without leaving the calendar drawer.
 *
 * Hidden entirely when the task has no logged activity yet so the sheet
 * doesn't show an empty section.
 *
 * @param {{
 *   activity: Array<object>,
 *   agentSlug?: string,
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 * }} props
 */
function TaskActivityList({ activity, agentSlug, baseUrl, fetchImpl }) {
  if (!activity || activity.length === 0) return null;
  return (
    <TaskField label={`Activity (${activity.length})`}>
      <ul
        role="list"
        className="flex flex-col gap-2"
        data-task-activity-list="true"
      >
        {activity.map((entry, idx) => (
          <ActivityRow
            key={entry.id || entry.timestamp || idx}
            entry={entry}
            agentSlug={agentSlug}
            baseUrl={baseUrl}
            fetchImpl={fetchImpl}
          />
        ))}
      </ul>
    </TaskField>
  );
}

/**
 * One row in `TaskActivityList`. Wraps the metadata in a `<Link>` when
 * the entry has an `executionLogBasename`, so the entire row navigates
 * to the activity drawer route. Renders a `FinalOutputPreview` directly
 * underneath so users see the run's outcome inline.
 */
function ActivityRow({ entry, agentSlug, baseUrl, fetchImpl }) {
  const basename = entry.executionLogBasename;
  const linkable = Boolean(agentSlug && basename);
  const meta = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <time
        dateTime={entry.timestamp || undefined}
        className="tabular-nums text-muted-foreground"
      >
        {formatActivityDate(entry.timestamp)}
      </time>
      <Badge variant="outline" className="capitalize">
        {entry.status || 'event'}
      </Badge>
      {entry.title ? (
        <span className="min-w-0 flex-1 truncate text-foreground">
          {entry.title}
        </span>
      ) : (
        <span className="flex-1" />
      )}
    </div>
  );
  return (
    <li
      className="flex flex-col gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5"
      data-activity-id={entry.id || ''}
    >
      {linkable ? (
        <Link
          to={`/agents/${encodeURIComponent(agentSlug)}/activities/${encodeURIComponent(basename)}`}
          className="block rounded-sm hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
          data-task-activity-link="true"
        >
          {meta}
        </Link>
      ) : (
        meta
      )}
      {linkable ? (
        <FinalOutputPreview
          slug={agentSlug}
          basename={basename}
          baseUrl={baseUrl}
          fetchImpl={fetchImpl}
        />
      ) : null}
    </li>
  );
}

/**
 * Lazy-fetch the execution log for one activity row and render the
 * `finalResult` markdown if any. Stays silent when the log has no final
 * result, while still surfacing load + error states distinctly.
 */
function FinalOutputPreview({ slug, basename, baseUrl, fetchImpl }) {
  const { loading, error, summary } = useExecutionLog({
    slug,
    basename,
    baseUrl,
    fetch: fetchImpl,
  });
  if (loading) {
    return (
      <p className="text-[11px] italic text-muted-foreground">
        Loading final output…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-[11px] italic text-destructive/80">
        Failed to load final output ({error.message || 'unknown error'}).
      </p>
    );
  }
  if (!summary?.finalResult) return null;
  return (
    <div
      className="max-h-[220px] overflow-auto rounded-sm border bg-background/60 px-2 py-1.5"
      data-task-activity-final-output="true"
    >
      <Markdown source={summary.finalResult} />
    </div>
  );
}

function formatActivityDate(iso) {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso);
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function TaskField({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="text-foreground">{children}</div>
    </div>
  );
}

export default AgentCalendarPage;

// ── Subcomponents ────────────────────────────────────────────────────

/**
 * One-line meta strip above the calendar grid. Agent identity lives in the
 * breadcrumb + sidebar, so this row only carries the fields that vary
 * per-week: the ISO week, the plan's approval state, and the render time
 * zone. The per-status counts + legend live in `StatusLegend` directly
 * below so the legend doubles as a "what's in this week" summary.
 *
 * @param {{ calendar: AgentCalendar }} props
 */
function CalendarHeader({ calendar }) {
  return (
    <header
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-calendar-header="true"
    >
      {calendar.week ? (
        <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
          {calendar.week}
        </code>
      ) : null}
      <ApprovalBadge approved={calendar.approved} />
      <span>
        · TZ{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-foreground">
          {calendar.timeZone || 'UTC'}
        </code>
      </span>
    </header>
  );
}

/**
 * Map `approved` onto stock shadcn Badge variants only. The primitive
 * exposes `default`, `secondary`, `destructive`, and `outline` — no
 * bespoke `success` / `warning` recipes — so we use `default` as the
 * filled "confirmed" tone and `outline` as the "awaiting action" tone.
 */
function ApprovalBadge({ approved }) {
  return (
    <Badge
      variant={approved ? 'default' : 'outline'}
      className="tracking-widest"
    >
      {approved ? 'approved' : 'pending'}
    </Badge>
  );
}

/**
 * Inline legend-with-counts row placed above the calendar grid. Merges what
 * used to be the per-status `CountsStrip` (separate Card) and the bottom-of-
 * page `Legend` into a single tight strip — one glyph + label + count per
 * status so users scan "who's done what" without a secondary table.
 *
 * Counts are primarily sourced from `calendar.counts`, with a fallback to
 * counting `tasks` directly so an outdated envelope (no `counts` field) still
 * renders a useful summary. Review-slot count is derived from `tasks`
 * regardless, since the server envelope doesn't surface it as its own bucket.
 *
 * @param {{ tasks: AgentCalendar['tasks'], counts: AgentCalendar['counts'] }} props
 */
function StatusLegend({ tasks, counts }) {
  const derived = countsFromTasks(tasks);
  const safe = counts || derived;
  const reviewCount = tasks.filter((t) => isReviewTask(t)).length;
  const items = [
    { key: 'pending', label: 'pending', icon: '○', value: safe.pending ?? derived.pending },
    {
      key: 'inProgress',
      label: 'in-progress',
      icon: '►',
      value: safe.inProgress ?? derived.inProgress,
    },
    {
      key: 'completed',
      label: 'completed',
      icon: '✓',
      value: safe.completed ?? derived.completed,
    },
    {
      key: 'failed',
      label: 'failed',
      icon: '✗',
      value: safe.failed ?? derived.failed,
      tone: 'text-destructive',
    },
    {
      key: 'skipped',
      label: 'skipped',
      icon: '⊘',
      value: safe.skipped ?? derived.skipped,
      tone: 'text-muted-foreground',
    },
    {
      key: 'delegated',
      label: 'delegated',
      icon: '→',
      value: safe.delegated ?? derived.delegated,
    },
    { key: 'review', label: 'review', icon: '◆', value: reviewCount },
  ];
  return (
    <p
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
      data-calendar-legend="true"
    >
      {items.map((item) => (
        <span
          key={item.key}
          className="inline-flex items-center gap-1"
          data-count-key={item.key}
          data-count-value={item.value}
        >
          <span className="font-mono text-foreground" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
          <span className={cn('tabular-nums', item.tone || 'text-foreground')}>
            {item.value}
          </span>
        </span>
      ))}
    </p>
  );
}

/**
 * Derive per-status task counts from a task array. Used as a fallback when
 * the calendar envelope's `counts` field is missing or stale.
 *
 * @param {AgentCalendar['tasks']} tasks
 */
function countsFromTasks(tasks) {
  const out = {
    pending: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    delegated: 0,
  };
  for (const t of tasks || []) {
    switch (t.status) {
      case 'pending':
        out.pending++;
        break;
      case 'in-progress':
        out.inProgress++;
        break;
      case 'completed':
        out.completed++;
        break;
      case 'failed':
        out.failed++;
        break;
      case 'skipped':
        out.skipped++;
        break;
      case 'delegated':
        out.delegated++;
        break;
      default:
        break;
    }
  }
  return out;
}

/** @param {{ calendar: AgentCalendar }} props */
function Backlog({ calendar }) {
  const unscheduled = calendar.tasks.filter((t) => !t.slot);
  if (unscheduled.length === 0) return null;
  const { numbering } = layoutTasks(calendar.tasks);
  return (
    <Card data-calendar-backlog="true" data-calendar-card="backlog">
      <CardHeader className="border-b bg-muted/50 px-4 py-2 space-y-0">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Backlog ({unscheduled.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-64">
          <ul role="list" className="flex flex-col gap-1 px-3 py-2">
            {unscheduled.map((task) => {
              const review = isReviewTask(task);
              const icon = review
                ? REVIEW_ICON
                : STATUS_ICONS[task.status] || '?';
              const label = review
                ? REVIEW_DISPLAY_NAMES[task.objectiveId] || 'Review'
                : task.title;
              return (
                <li
                  key={task.id}
                  data-task-id={task.id}
                  data-task-number={numbering.get(task.id)}
                  className="flex items-start gap-2 text-xs text-foreground"
                >
                  <span
                    aria-hidden="true"
                    className="font-mono text-muted-foreground"
                  >
                    {icon}
                  </span>
                  <span className="font-semibold tabular-nums text-muted-foreground">
                    {numbering.get(task.id)}.
                  </span>
                  <span className="flex-1">{label}</span>
                  {task.runAt ? (
                    <time
                      dateTime={task.runAt}
                      className="text-[10px] tabular-nums text-muted-foreground"
                    >
                      {task.runAt}
                    </time>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ── Empty / loading / error ──────────────────────────────────────────

function CalendarEmpty({ message }) {
  return (
    <Card
      className="border-dashed"
      data-page="agent-calendar"
      data-tab-body="calendar"
      data-state="empty"
    >
      <CardContent className="p-8 text-center text-sm italic text-muted-foreground">
        {message}
      </CardContent>
    </Card>
  );
}

function CalendarSkeleton() {
  return (
    <Card
      role="status"
      aria-live="polite"
      className="animate-pulse"
      data-page="agent-calendar"
      data-tab-body="calendar"
      data-loading="true"
    >
      <CardContent className="p-6 text-sm text-muted-foreground">
        Loading calendar…
      </CardContent>
    </Card>
  );
}

/**
 * Error Card — mirrors the destructive-tinted chrome used by the
 * Overview page's error path (`AgentsPageError` in `agents-page.jsx`)
 * so every error surface in the SPA reads as part of the same shadcn
 * primitive family.
 */
function CalendarError({ error, onRetry }) {
  return (
    <Card
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive"
      data-page="agent-calendar"
      data-tab-body="calendar"
      data-error="true"
    >
      <CardHeader className="space-y-1">
        <CardTitle as="h2" className="text-sm text-destructive">
          Failed to load calendar.
        </CardTitle>
        <CardDescription className="text-xs text-destructive/80">
          {error?.message || String(error)}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Advisory "stale data" banner. Stock shadcn does not expose a warning
 * token, so we reuse the neutral muted surface pattern from
 * `agents-page.jsx`'s `StaleBanner` — same chrome, same primitives.
 */
function StaleBanner({ error, onRetry }) {
  return (
    <Card
      role="alert"
      className="bg-muted text-muted-foreground"
      data-calendar-stale="true"
    >
      <CardContent className="flex flex-wrap items-center gap-2 p-2.5 text-xs">
        <span>
          Refresh failed ({error?.message || 'unknown error'}) — showing
          last-known data.
        </span>
        <Button
          variant="link"
          size="sm"
          onClick={onRetry}
          className="h-auto p-0 text-xs"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
