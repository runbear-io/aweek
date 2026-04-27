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
 * TypeScript migration note (AC 103 sub-AC 3):
 *   Converted from `.jsx` → `.tsx` as part of the per-tab page
 *   conversion sweep. shadcn/ui primitives in `../components/ui/*`
 *   remain `.jsx` for this migration phase, so each used primitive is
 *   re-aliased through a permissive `React.ComponentType` cast. The
 *   sibling components (`CalendarGrid`, `Markdown`) also remain `.jsx`;
 *   their imports are aliased through permissive casts.
 *
 * @module serve/spa/pages/agent-calendar-page
 */

import * as React from 'react';
import { Link } from 'react-router-dom';

import * as BadgeModule from '../components/ui/badge.jsx';
import * as ButtonModule from '../components/ui/button.jsx';
import * as CardModule from '../components/ui/card.jsx';
import * as ScrollAreaModule from '../components/ui/scroll-area.jsx';
import * as SheetModule from '../components/ui/sheet.jsx';
import * as ExecutionLogViewModule from '../components/execution-log-view.jsx';
import * as CalendarGridModule from '../components/calendar-grid.jsx';
import { cn } from '../lib/cn.js';
import { addIsoWeeks } from '../lib/iso-week.js';
import { useAgentCalendar } from '../hooks/use-agent-calendar.js';
import { useExecutionLog } from '../hooks/use-execution-log.js';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────

type ShadcnVariant = 'default' | 'secondary' | 'destructive' | 'outline';
type ButtonVariant = ShadcnVariant | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: ShadcnVariant;
  asChild?: boolean;
};
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};
type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
};
type CardSectionProps = React.HTMLAttributes<HTMLDivElement>;
type CardTitleProps = React.HTMLAttributes<HTMLHeadingElement> & {
  as?: React.ElementType;
};
type CardDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement>;

type SheetRootProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
};
type SheetContentProps = React.HTMLAttributes<HTMLDivElement> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
};
type SheetHeaderProps = React.HTMLAttributes<HTMLDivElement>;
type SheetTitleProps = React.HTMLAttributes<HTMLHeadingElement>;
type SheetDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

const Badge = BadgeModule.Badge as React.ComponentType<BadgeProps>;
const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;
const Card = CardModule.Card as React.ComponentType<CardProps>;
const CardContent = CardModule.CardContent as React.ComponentType<CardSectionProps>;
const CardDescription =
  CardModule.CardDescription as React.ComponentType<CardDescriptionProps>;
const CardHeader = CardModule.CardHeader as React.ComponentType<CardSectionProps>;
const CardTitle = CardModule.CardTitle as React.ComponentType<CardTitleProps>;
const ScrollArea =
  ScrollAreaModule.ScrollArea as React.ComponentType<ScrollAreaProps>;
const Sheet = SheetModule.Sheet as React.ComponentType<SheetRootProps>;
const SheetContent =
  SheetModule.SheetContent as React.ComponentType<SheetContentProps>;
const SheetDescription =
  SheetModule.SheetDescription as React.ComponentType<SheetDescriptionProps>;
const SheetHeader = SheetModule.SheetHeader as React.ComponentType<SheetHeaderProps>;
const SheetTitle = SheetModule.SheetTitle as React.ComponentType<SheetTitleProps>;

// ── Cross-boundary shims for still-`.jsx` sibling components ────────

type AgentCalendar = import('../lib/api-client.js').AgentCalendar;
type CalendarTask = import('../lib/api-client.js').CalendarTask;
type CalendarCounts = AgentCalendar['counts'];

type CalendarGridProps = {
  tasks: ReadonlyArray<CalendarTask>;
  weekMonday: string | null;
  timeZone: string;
  agentId: string;
  className?: string;
  onSelectTask?: (task: CalendarTask) => void;
};

type LayoutResult = {
  numbering: Map<string, number>;
  [key: string]: unknown;
};

type ReviewDisplayNames = Record<string, string>;
type StatusIcons = Record<string, string>;

const CalendarGrid =
  CalendarGridModule.CalendarGrid as React.ComponentType<CalendarGridProps>;
const DEFAULT_END_HOUR = CalendarGridModule.DEFAULT_END_HOUR as number;
const DEFAULT_START_HOUR = CalendarGridModule.DEFAULT_START_HOUR as number;
const REVIEW_DISPLAY_NAMES =
  CalendarGridModule.REVIEW_DISPLAY_NAMES as ReviewDisplayNames;
const REVIEW_ICON = CalendarGridModule.REVIEW_ICON as string;
const STATUS_ICONS = CalendarGridModule.STATUS_ICONS as StatusIcons;
const isReviewTask = CalendarGridModule.isReviewTask as (
  task: CalendarTask | null | undefined,
) => boolean;
const layoutTasks = CalendarGridModule.layoutTasks as unknown as (
  tasks: ReadonlyArray<CalendarTask>,
  opts?: Record<string, unknown>,
) => LayoutResult;

type MarkdownProps = { source: string };
const Markdown =
  ExecutionLogViewModule.Markdown as React.ComponentType<MarkdownProps>;

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

export interface AgentCalendarPageProps {
  /** Agent slug — selects which agent's calendar the page loads. */
  slug: string;
  /** Optional ISO week key (`"YYYY-Www"`) to view a non-current week. */
  week?: string;
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
  /** Currently-selected calendar drawer task id (URL-driven). */
  selectedTaskId?: string | undefined;
  /** Open the drawer for a task id (URL-driven). */
  onOpenTaskId?: (taskId: string) => void;
  /** Close the drawer (URL-driven). */
  onCloseTaskId?: () => void;
  /**
   * Notify the parent router that the user navigated to a different week.
   * Pass `null` to clear the override and fall back to "current week".
   * URL-driven; the parent updates `?week=` and the hook re-fetches.
   */
  onWeekChange?: (week: string | null) => void;
}

interface CalendarSectionProps {
  calendar: AgentCalendar;
}

interface CalendarHeaderProps {
  calendar: AgentCalendar;
  /** Active ISO week from the URL — `null` when the URL has no `?week=`. */
  activeWeek: string | null;
  /** Notify the parent that the user picked a different week. */
  onWeekChange?: (week: string | null) => void;
}

interface StatusLegendProps {
  tasks: ReadonlyArray<CalendarTask>;
  counts: CalendarCounts | null | undefined;
}

interface ApprovalBadgeProps {
  approved: boolean;
}

interface EmptyProps {
  message: string;
}

interface ErrorBannerProps {
  error: Error | { message?: string } | null;
  onRetry: () => void | Promise<void>;
}

type ActivityEntry = {
  id?: string;
  timestamp?: string;
  title?: string;
  status?: string;
  executionLogBasename?: string;
  [key: string]: unknown;
};

interface TaskDetailSheetProps {
  task: CalendarTask | null;
  agentSlug?: string;
  activity?: ReadonlyArray<ActivityEntry>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  onClose: () => void;
}

interface TaskActivityListProps {
  activity?: ReadonlyArray<ActivityEntry>;
  agentSlug?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ActivityRowProps {
  entry: ActivityEntry;
  agentSlug?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface FinalOutputPreviewProps {
  // The slug is always defined at the call site (we only render this
  // component when `agentSlug && basename`), so we narrow it here so the
  // useExecutionLog call type-checks against its `slug: string` JSDoc.
  slug: string;
  basename: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface TaskFieldProps {
  label: string;
  children: React.ReactNode;
}

interface CountsBag {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
  delegated: number;
}

export function AgentCalendarPage({
  slug,
  week,
  baseUrl,
  fetch: fetchImpl,
  selectedTaskId,
  onOpenTaskId,
  onCloseTaskId,
  onWeekChange,
}: AgentCalendarPageProps): React.ReactElement {
  const { data, error, loading, refresh } = useAgentCalendar(slug, {
    week,
    baseUrl,
    fetch: fetchImpl,
  });
  // Drawer state defaults to local — tests and standalone use cases
  // never hand over URL-driven open/close. When the router-aware
  // parent threads `selectedTaskId` + `onOpenTaskId` / `onCloseTaskId`,
  // the URL becomes the source of truth.
  const [internalTaskId, setInternalTaskId] = React.useState<string | null>(null);
  const effectiveTaskId =
    selectedTaskId !== undefined ? selectedTaskId : internalTaskId;

  if (!slug) {
    return <CalendarEmpty message="Select an agent to view its calendar." />;
  }
  if (loading && !data) return <CalendarSkeleton />;
  // `useAgentCalendar` widens `error` to `Error | null`; ApiError carries a
  // `.status`. Read it through a structural cast so the 404 short-circuit
  // doesn't require importing the class here.
  const errorWithStatus = error as unknown as { status?: unknown } | null;
  const errorStatus =
    errorWithStatus && typeof errorWithStatus.status === 'number'
      ? errorWithStatus.status
      : null;
  if (error && errorStatus === 404) {
    return <CalendarEmpty message={`No agent found for slug "${slug}".`} />;
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
        data-state={data.loadError ? 'load-error' : 'no-plan'}
      >
        <CalendarHeader
          calendar={data}
          activeWeek={week ?? null}
          onWeekChange={onWeekChange}
        />
        {data.loadError ? <PlanLoadErrorBanner message={data.loadError} /> : null}
        {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
        {data.loadError ? null : (
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
        )}
      </section>
    );
  }

  const activityByTask =
    (data.activityByTask as Record<string, ReadonlyArray<ActivityEntry>>) || {};

  return (
    <section
      // `flex-1 min-h-0` plumbs the layout's flex chain into the calendar
      // tab so the inner CalendarGrid fills the viewport vertically and
      // scrolls internally instead of pushing the page past the fold.
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-page="agent-calendar"
      data-tab-body="calendar"
      data-agent-slug={data.agentId}
      data-week={data.week ?? undefined}
    >
      <CalendarHeader
        calendar={data}
        activeWeek={week ?? null}
        onWeekChange={onWeekChange}
      />
      {data.loadError ? <PlanLoadErrorBanner message={data.loadError} /> : null}
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      <StatusLegend tasks={data.tasks} counts={data.counts} />
      <CalendarGrid
        tasks={data.tasks}
        weekMonday={data.weekMonday}
        timeZone={data.timeZone}
        agentId={data.agentId}
        // Take the remaining vertical space inside the calendar tab and own
        // both-axis scrolling. The flex chain runs from `<Layout>` down
        // through the agent-detail section, the Tabs primitive, the active
        // TabsContent, and the agent-calendar section, so this element fills
        // exactly the leftover viewport height (no calc heuristics) and
        // scrolls internally when content overflows.
        className="min-h-0 flex-1 overflow-auto"
        onSelectTask={(t: CalendarTask) => {
          if (!t?.id) return;
          if (typeof onOpenTaskId === 'function') onOpenTaskId(t.id);
          else setInternalTaskId(t.id);
        }}
      />
      <Backlog calendar={data} />
      <TaskDetailSheet
        task={
          effectiveTaskId
            ? data.tasks?.find((t) => t.id === effectiveTaskId) ||
              ({
                id: effectiveTaskId,
                title: '',
                status: 'pending',
              } as CalendarTask)
            : null
        }
        agentSlug={data.agentId}
        activity={
          effectiveTaskId ? activityByTask[effectiveTaskId] || [] : []
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
 */
function TaskDetailSheet({
  task,
  agentSlug,
  activity = [],
  baseUrl,
  fetchImpl,
  onClose,
}: TaskDetailSheetProps): React.ReactElement {
  const open = task != null;
  const review = task ? isReviewTask(task) : false;
  const icon = task
    ? review
      ? REVIEW_ICON
      : STATUS_ICONS[task.status] || '?'
    : '';
  const label = task
    ? review
      ? REVIEW_DISPLAY_NAMES[task.objectiveId ?? ''] || 'Review'
      : task.title
    : '';
  return (
    <Sheet open={open} onOpenChange={(next: boolean) => (next ? null : onClose())}>
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
                  <code className="break-all rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
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
                  <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs text-foreground">
                    {task.prompt}
                  </pre>
                </TaskField>
              ) : null}
              {task.id ? (
                <TaskField label="Task ID">
                  <code className="break-all rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
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
 */
function TaskActivityList({
  activity,
  agentSlug,
  baseUrl,
  fetchImpl,
}: TaskActivityListProps): React.ReactElement | null {
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
function ActivityRow({
  entry,
  agentSlug,
  baseUrl,
  fetchImpl,
}: ActivityRowProps): React.ReactElement {
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
      {linkable && agentSlug && basename ? (
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
      {agentSlug && basename ? (
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
function FinalOutputPreview({
  slug,
  basename,
  baseUrl,
  fetchImpl,
}: FinalOutputPreviewProps): React.ReactElement | null {
  const { loading, error, summary } = useExecutionLog({
    slug,
    basename,
    baseUrl,
    fetch: fetchImpl,
  });
  // `useExecutionLog` initialises `error` to `null` so TS infers it as
  // `null` rather than `Error | null`. Widen via a structural cast so we
  // can read `.message` after the truthy guard.
  const typedError = error as { message?: string } | null;
  if (loading) {
    return (
      <p className="text-[11px] italic text-muted-foreground">
        Loading final output…
      </p>
    );
  }
  if (typedError) {
    return (
      <p className="text-[11px] italic text-destructive/80">
        Failed to load final output ({typedError.message || 'unknown error'}).
      </p>
    );
  }
  const finalResult =
    summary && typeof (summary as { finalResult?: unknown }).finalResult === 'string'
      ? ((summary as { finalResult?: string }).finalResult as string)
      : '';
  if (!finalResult) return null;
  return (
    <div
      className="max-h-[220px] overflow-auto rounded-sm border bg-background/60 px-2 py-1.5"
      data-task-activity-final-output="true"
    >
      <Markdown source={finalResult} />
    </div>
  );
}

function formatActivityDate(iso: string | null | undefined): string {
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

function TaskField({ label, children }: TaskFieldProps): React.ReactElement {
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
 * zone.
 */
function CalendarHeader({
  calendar,
  activeWeek,
  onWeekChange,
}: CalendarHeaderProps): React.ReactElement {
  // Pivot week for prev/next math: prefer the URL's `?week=` (so navigation
  // is stable while the data is loading), then the response's `week`, then
  // — for fresh empty agents — `null` (we hide prev/next in that case).
  const pivot = activeWeek || calendar.week || null;
  const canStep = Boolean(pivot && onWeekChange);
  const prevWeek = canStep && pivot ? addIsoWeeks(pivot, -1) : null;
  const nextWeek = canStep && pivot ? addIsoWeeks(pivot, 1) : null;
  const onCurrent = onWeekChange ? () => onWeekChange(null) : undefined;
  return (
    <header
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-calendar-header="true"
    >
      {onWeekChange ? (
        <div
          className="flex items-center gap-1"
          data-calendar-week-nav="true"
          aria-label="Week navigation"
        >
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            onClick={prevWeek ? () => onWeekChange(prevWeek) : undefined}
            disabled={!prevWeek}
            aria-label={prevWeek ? `Previous week (${prevWeek})` : 'Previous week'}
            data-calendar-prev-week={prevWeek ?? undefined}
          >
            ←
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={onCurrent}
            disabled={activeWeek === null}
            aria-label="Current week"
            data-calendar-current-week="true"
          >
            Current
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            onClick={nextWeek ? () => onWeekChange(nextWeek) : undefined}
            disabled={!nextWeek}
            aria-label={nextWeek ? `Next week (${nextWeek})` : 'Next week'}
            data-calendar-next-week={nextWeek ?? undefined}
          >
            →
          </Button>
        </div>
      ) : null}
      {calendar.week ? (
        <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
          {calendar.week}
        </code>
      ) : activeWeek ? (
        <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
          {activeWeek}
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
 * Map `approved` onto stock shadcn Badge variants only.
 */
function ApprovalBadge({
  approved,
}: ApprovalBadgeProps): React.ReactElement {
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
 */
function StatusLegend({
  tasks,
  counts,
}: StatusLegendProps): React.ReactElement {
  const derived = countsFromTasks(tasks);
  const safe = (counts as Partial<CountsBag> | null | undefined) || derived;
  const reviewCount = tasks.filter((t) => isReviewTask(t)).length;
  const items = [
    {
      key: 'pending',
      label: 'pending',
      icon: '○',
      value: safe.pending ?? derived.pending,
      tone: undefined as string | undefined,
    },
    {
      key: 'inProgress',
      label: 'in-progress',
      icon: '►',
      value: safe.inProgress ?? derived.inProgress,
      tone: undefined as string | undefined,
    },
    {
      key: 'completed',
      label: 'completed',
      icon: '✓',
      value: safe.completed ?? derived.completed,
      tone: undefined as string | undefined,
    },
    {
      key: 'failed',
      label: 'failed',
      icon: '✗',
      value: safe.failed ?? derived.failed,
      tone: 'text-destructive' as string | undefined,
    },
    {
      key: 'skipped',
      label: 'skipped',
      icon: '⊘',
      value: safe.skipped ?? derived.skipped,
      tone: 'text-muted-foreground' as string | undefined,
    },
    {
      key: 'delegated',
      label: 'delegated',
      icon: '→',
      value: safe.delegated ?? derived.delegated,
      tone: undefined as string | undefined,
    },
    {
      key: 'review',
      label: 'review',
      icon: '◆',
      value: reviewCount,
      tone: undefined as string | undefined,
    },
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
 */
function countsFromTasks(tasks: ReadonlyArray<CalendarTask>): CountsBag {
  const out: CountsBag = {
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

function Backlog({
  calendar,
}: CalendarSectionProps): React.ReactElement | null {
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
                ? REVIEW_DISPLAY_NAMES[task.objectiveId ?? ''] || 'Review'
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

function CalendarEmpty({ message }: EmptyProps): React.ReactElement {
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

function CalendarSkeleton(): React.ReactElement {
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

function CalendarError({
  error,
  onRetry,
}: ErrorBannerProps): React.ReactElement {
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
 * Destructive-tone banner shown when the server reports `loadError` on
 * the calendar payload. This means the weekly-plan file is on disk but
 * the validator rejected it (schema drift, parse error, etc.) — distinct
 * from "no plan exists yet". Surfacing this loudly stops users from
 * assuming everything's fine while their plan is silently invisible.
 */
function PlanLoadErrorBanner({
  message,
}: {
  message: string;
}): React.ReactElement {
  return (
    <Card
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive"
      data-calendar-load-error="true"
    >
      <CardHeader className="space-y-1">
        <CardTitle as="h2" className="text-sm text-destructive">
          Weekly plan rejected by validator.
        </CardTitle>
        <CardDescription className="break-words text-xs text-destructive/80">
          {message}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 text-xs text-destructive/80">
        The file exists on disk but its shape doesn't match the
        weekly-plan schema. Edit{' '}
        <code className="rounded bg-destructive/10 px-1 py-0.5 text-[11px] text-destructive">
          .aweek/agents/&lt;slug&gt;/weekly-plans/&lt;week&gt;.json
        </code>{' '}
        to remove non-schema fields or run{' '}
        <code className="rounded bg-destructive/10 px-1 py-0.5 text-[11px] text-destructive">
          /aweek:plan
        </code>{' '}
        to regenerate.
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }: ErrorBannerProps): React.ReactElement {
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
