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
 * Styling: the Calendar tab's surrounding chrome (counts strip,
 * backlog, empty / loading / error states, stale banner) is composed
 * from shadcn primitives (`Badge`, `Button`, `Card`, `CardHeader`,
 * `CardTitle`, `CardContent`, `ScrollArea`). The inner grid is still
 * owned by `CalendarGrid` which has its own Tailwind-tokenised chrome.
 *
 * @module serve/spa/pages/agent-calendar-page
 */

import React from 'react';

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
import { useAgentCalendar } from '../hooks/use-agent-calendar.js';
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
export function AgentCalendarPage({ slug, week, baseUrl, fetch: fetchImpl }) {
  const { data, error, loading, refresh } = useAgentCalendar(slug, {
    week,
    baseUrl,
    fetch: fetchImpl,
  });

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
        <CalendarHeader calendar={data} loading={loading} onRefresh={refresh} />
        {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
        <Card className="border-dashed" data-state="no-plan">
          <CardContent className="p-6 pt-6 text-sm italic text-slate-400 sm:p-6 sm:pt-6">
            No weekly plan yet for{' '}
            <strong className="not-italic text-slate-200">
              {data.agentId}
            </strong>
            . Run{' '}
            <code className="not-italic text-slate-200">/aweek:plan</code> to
            draft and approve a weekly plan.
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-calendar"
      data-tab-body="calendar"
      data-agent-slug={data.agentId}
      data-week={data.week}
    >
      <CalendarHeader calendar={data} loading={loading} onRefresh={refresh} />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      <CountsStrip counts={data.counts} />
      <CalendarGrid
        tasks={data.tasks}
        weekMonday={data.weekMonday}
        timeZone={data.timeZone}
        agentId={data.agentId}
      />
      <Backlog calendar={data} />
      <Legend />
    </section>
  );
}

export default AgentCalendarPage;

// ── Subcomponents ────────────────────────────────────────────────────

/** @param {{ calendar: AgentCalendar, loading: boolean, onRefresh: () => void }} props */
function CalendarHeader({ calendar, loading, onRefresh }) {
  const workTaskCount = calendar.tasks.filter(
    (t) => !isReviewTask(t),
  ).length;
  const reviewSlotCount = calendar.tasks.length - workTaskCount;
  return (
    <header
      className="flex flex-col gap-2 border-b border-slate-800 pb-3 sm:flex-row sm:items-center sm:justify-between"
      data-calendar-header="true"
    >
      <div>
        <h1 className="text-base font-semibold tracking-tight text-slate-100">
          {calendar.agentId} — Calendar
          {calendar.week ? (
            <span className="ml-2 text-xs font-normal text-slate-400">
              Week{' '}
              <code className="rounded bg-slate-900 px-1.5 py-0.5 text-[11px] text-slate-300">
                {calendar.week}
              </code>
            </span>
          ) : null}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <ApprovalBadge approved={calendar.approved} />
          <span>
            {workTaskCount} task{workTaskCount === 1 ? '' : 's'}
          </span>
          {reviewSlotCount > 0 ? (
            <span>
              · {reviewSlotCount} review{reviewSlotCount === 1 ? '' : 's'}
            </span>
          ) : null}
          <span>
            · TZ{' '}
            <code className="rounded bg-slate-900 px-1 py-0.5 text-[10px] text-slate-300">
              {calendar.timeZone || 'UTC'}
            </code>
          </span>
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRefresh}
        disabled={loading}
        className="self-start sm:self-auto"
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </Button>
    </header>
  );
}

function ApprovalBadge({ approved }) {
  return (
    <Badge
      variant={approved ? 'success' : 'warning'}
      className="tracking-widest"
    >
      {approved ? 'approved' : 'pending'}
    </Badge>
  );
}

/** @param {{ counts: AgentCalendar['counts'] }} props */
function CountsStrip({ counts }) {
  const items = [
    { key: 'pending', label: 'Pending', value: counts.pending, tone: 'text-slate-300' },
    {
      key: 'inProgress',
      label: 'In progress',
      value: counts.inProgress,
      tone: 'text-sky-300',
    },
    {
      key: 'completed',
      label: 'Completed',
      value: counts.completed,
      tone: 'text-emerald-300',
    },
    { key: 'failed', label: 'Failed', value: counts.failed, tone: 'text-red-300' },
    {
      key: 'delegated',
      label: 'Delegated',
      value: counts.delegated,
      tone: 'text-violet-300',
    },
    { key: 'skipped', label: 'Skipped', value: counts.skipped, tone: 'text-slate-500' },
  ];
  return (
    <Card data-calendar-card="counts">
      <CardContent className="p-0 pt-0 sm:p-0 sm:pt-0">
        <dl
          className="grid grid-cols-3 gap-2 px-3 py-2 text-xs sm:grid-cols-6"
          data-calendar-counts="true"
        >
          {items.map((item) => (
            <div
              key={item.key}
              className="flex flex-col"
              data-count-key={item.key}
              data-count-value={item.value}
            >
              <dt className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {item.label}
              </dt>
              <dd className={`text-sm font-semibold tabular-nums ${item.tone}`}>
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** @param {{ calendar: AgentCalendar }} props */
function Backlog({ calendar }) {
  const unscheduled = calendar.tasks.filter((t) => !t.slot);
  if (unscheduled.length === 0) return null;
  const { numbering } = layoutTasks(calendar.tasks);
  return (
    <Card data-calendar-backlog="true" data-calendar-card="backlog">
      <CardHeader className="border-b border-slate-800 bg-slate-900/50 p-0 sm:p-0">
        <CardTitle
          as="h2"
          className="px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400"
        >
          Backlog ({unscheduled.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 pt-0 sm:p-0 sm:pt-0">
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
                  className="flex items-start gap-2 text-xs text-slate-300"
                >
                  <span aria-hidden="true" className="font-mono text-slate-400">
                    {icon}
                  </span>
                  <span className="font-semibold tabular-nums text-slate-500">
                    {numbering.get(task.id)}.
                  </span>
                  <span className="flex-1">{label}</span>
                  {task.runAt ? (
                    <time
                      dateTime={task.runAt}
                      className="text-[10px] tabular-nums text-slate-500"
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

function Legend() {
  const items = [
    ['○', 'pending'],
    ['►', 'in-progress'],
    ['✓', 'completed'],
    ['✗', 'failed'],
    ['⊘', 'skipped'],
    ['→', 'delegated'],
    ['◆', 'review slot'],
  ];
  return (
    <p
      className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500"
      data-calendar-legend="true"
    >
      <span className="font-semibold uppercase tracking-widest text-slate-400">
        Legend
      </span>
      {items.map(([icon, label]) => (
        <span key={label} className="inline-flex items-center gap-1">
          <span className="font-mono text-slate-300" aria-hidden="true">
            {icon}
          </span>
          {label}
        </span>
      ))}
    </p>
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
      <CardContent className="p-8 pt-8 text-center text-sm italic text-slate-400 sm:p-8 sm:pt-8">
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
      className="animate-pulse border-slate-800"
      data-page="agent-calendar"
      data-tab-body="calendar"
      data-loading="true"
    >
      <CardContent className="p-4 pt-4 text-sm text-slate-500 sm:p-6 sm:pt-6">
        Loading calendar…
      </CardContent>
    </Card>
  );
}

function CalendarError({ error, onRetry }) {
  return (
    <Card
      role="alert"
      className="border-red-500/40 bg-red-500/10 text-red-200"
      data-page="agent-calendar"
      data-tab-body="calendar"
      data-error="true"
    >
      <CardHeader className="p-4 pb-1 sm:p-6 sm:pb-2">
        <CardTitle as="h2" className="text-sm text-red-100">
          Failed to load calendar.
        </CardTitle>
        <CardDescription className="text-xs text-red-200/80">
          {error?.message || String(error)}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-2 sm:p-6 sm:pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="border-red-400/50 text-red-200 hover:bg-red-500/20"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }) {
  return (
    <Card
      role="alert"
      className="border-amber-500/40 bg-amber-500/10 text-amber-200"
      data-calendar-stale="true"
    >
      <CardContent className="flex flex-wrap items-center gap-2 p-2.5 pt-2.5 text-xs sm:p-2.5 sm:pt-2.5">
        <span>
          Refresh failed ({error?.message || 'unknown error'}) — showing
          last-known data.
        </span>
        <Button
          variant="link"
          size="sm"
          onClick={onRetry}
          className="h-auto px-0 text-amber-200 underline decoration-dotted hover:decoration-solid"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
