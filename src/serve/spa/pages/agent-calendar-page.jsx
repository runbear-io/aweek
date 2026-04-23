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
import { cn } from '../lib/cn.js';
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
      className="flex flex-col gap-2 border-b pb-3 sm:flex-row sm:items-center sm:justify-between"
      data-calendar-header="true"
    >
      <div>
        <h1 className="text-base font-semibold tracking-tight text-foreground">
          {calendar.agentId} — Calendar
          {calendar.week ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Week{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                {calendar.week}
              </code>
            </span>
          ) : null}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
            <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-foreground">
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

/** @param {{ counts: AgentCalendar['counts'] }} props */
function CountsStrip({ counts }) {
  // Tone map keyed on tokens only — no hardcoded per-status hues. The
  // only semantic callouts stock shadcn exposes are `foreground` (default),
  // `muted-foreground` (de-emphasised), and `destructive` (failure).
  const items = [
    { key: 'pending', label: 'Pending', value: counts.pending },
    { key: 'inProgress', label: 'In progress', value: counts.inProgress },
    { key: 'completed', label: 'Completed', value: counts.completed },
    {
      key: 'failed',
      label: 'Failed',
      value: counts.failed,
      tone: 'text-destructive',
    },
    { key: 'delegated', label: 'Delegated', value: counts.delegated },
    {
      key: 'skipped',
      label: 'Skipped',
      value: counts.skipped,
      tone: 'text-muted-foreground',
    },
  ];
  return (
    <Card data-calendar-card="counts">
      <CardContent className="p-3">
        <dl
          className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6"
          data-calendar-counts="true"
        >
          {items.map((item) => (
            <div
              key={item.key}
              className="flex flex-col"
              data-count-key={item.key}
              data-count-value={item.value}
            >
              <dt className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                {item.label}
              </dt>
              <dd
                className={cn(
                  'text-sm font-semibold tabular-nums',
                  item.tone || 'text-foreground',
                )}
              >
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
      className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground"
      data-calendar-legend="true"
    >
      <span className="font-semibold uppercase tracking-widest">Legend</span>
      {items.map(([icon, label]) => (
        <span key={label} className="inline-flex items-center gap-1">
          <span className="font-mono text-foreground" aria-hidden="true">
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
