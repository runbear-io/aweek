/**
 * `AgentActivityPage` — per-agent activity / execution log tab.
 *
 * Data contract (Sub-AC 3.3):
 *   Data is sourced _exclusively_ from `useAgentLogs(slug, { dateRange })`.
 *   No `props.logs`, no `window.__INITIAL_DATA__`, no SSR HTML reading.
 *   The date-range state is _local_ UI state (via `useState`) threaded
 *   into the hook so the fetch re-runs automatically when the operator
 *   flips the filter.
 *
 * Baseline parity (per `src/storage/activity-log-store.js` +
 * `src/storage/execution-store.js`, surfaced by `src/serve/data/logs.js`):
 *   - Date-range filter pill (all / this-week / last-7-days)
 *   - Activity entries (user-facing event log)
 *   - Execution entries (heartbeat audit trail)
 *   - Newest-first ordering (server-sorted; we respect it)
 *   - Empty / loading / error states
 *
 * Visualization (AC 4, Sub-AC 3):
 *   The primary surface is a unified chronological `ActivityTimeline`
 *   that interleaves activity-log events with execution records so
 *   operators can answer "what did this agent do?" in one scrollable
 *   stream. The per-source sections remain available below for focused
 *   drill-downs (e.g. "show me just the heartbeats this week").
 *
 * Styling contract (AC 60201):
 *   Every color / background / border resolves to a shadcn theme token
 *   (`bg-card`, `bg-muted`, `text-foreground`, `text-muted-foreground`,
 *   `border-border`, `bg-destructive/10`, …). No hardcoded palette
 *   utilities remain, so the page re-themes for free when `.dark` is
 *   toggled on `<html>`.
 *
 * TypeScript migration note (AC 103 sub-AC 3):
 *   Converted from `.jsx` → `.tsx` as part of the per-tab page
 *   conversion sweep. shadcn/ui primitives in `../components/ui/*`
 *   remain `.jsx` for this migration phase, so each used primitive is
 *   re-aliased through a permissive `React.ComponentType` cast. The
 *   sibling components (`ActivityTimeline`, `ExecutionLogView`) also
 *   remain `.jsx`; the imports are aliased through permissive casts so
 *   the prop surface this page actually threads through type-checks
 *   even when the JSDoc on the source is narrower.
 *
 * @module serve/spa/pages/agent-activity-page
 */

import * as React from 'react';

import * as ActivityTimelineModule from '../components/activity-timeline.jsx';
import * as ExecutionLogViewModule from '../components/execution-log-view.jsx';
import * as BadgeModule from '../components/ui/badge.jsx';
import * as ButtonModule from '../components/ui/button.jsx';
import * as CardModule from '../components/ui/card.jsx';
import * as SheetModule from '../components/ui/sheet.jsx';
import { useAgentLogs } from '../hooks/use-agent-logs.js';
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
const Sheet = SheetModule.Sheet as React.ComponentType<SheetRootProps>;
const SheetContent =
  SheetModule.SheetContent as React.ComponentType<SheetContentProps>;
const SheetDescription =
  SheetModule.SheetDescription as React.ComponentType<SheetDescriptionProps>;
const SheetHeader = SheetModule.SheetHeader as React.ComponentType<SheetHeaderProps>;
const SheetTitle = SheetModule.SheetTitle as React.ComponentType<SheetTitleProps>;

// ── Cross-boundary shims for still-`.jsx` sibling components ────────

type TimelineEntry = {
  id?: string;
  taskId?: string;
  timestamp?: string;
  status?: string;
  title?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

type ActivityTimelineProps = {
  entries: ReadonlyArray<TimelineEntry>;
  title?: string;
  emptyMessage?: string;
  agentSlug?: string;
  onSelectEntry?: (entry: TimelineEntry) => void;
};

type ExecutionLogSummary = {
  finalResult?: string | null;
  [key: string]: unknown;
};

type ExecutionLogViewProps = {
  summary: ExecutionLogSummary;
  variant?: 'page' | 'drawer';
};

const ActivityTimeline =
  ActivityTimelineModule.ActivityTimeline as React.ComponentType<ActivityTimelineProps>;
const executionLogBasename =
  ActivityTimelineModule.executionLogBasename as (
    entry: TimelineEntry | null | undefined,
  ) => string | null;
const ExecutionLogView =
  ExecutionLogViewModule.ExecutionLogView as React.ComponentType<ExecutionLogViewProps>;

// ── Domain types ────────────────────────────────────────────────────

type AgentLogs = import('../lib/api-client.js').AgentLogs;
type DateRangePreset = import('../lib/api-client.js').DateRangePreset;

type DateRangeOption = { value: DateRangePreset; label: string };

const DATE_RANGE_OPTIONS: ReadonlyArray<DateRangeOption> = [
  { value: 'all', label: 'All' },
  { value: 'this-week', label: 'This week' },
  { value: 'last-7-days', label: 'Last 7 days' },
];

/**
 * Map an execution row's free-form status string to a canonical shadcn
 * `Badge` variant (`default` · `secondary` · `destructive` · `outline`).
 * Keeps the tonal distinction between completed / failed / skipped /
 * other while staying inside the stock shadcn palette — no bespoke
 * variants, no hardcoded tailwind colors.
 */
function executionBadgeVariant(status: string): ShadcnVariant {
  if (status === 'completed' || status === 'success') return 'default';
  if (status === 'failed' || status === 'failure') return 'destructive';
  if (status === 'skipped') return 'secondary';
  return 'outline';
}

export interface AgentActivityPageProps {
  /** Agent slug — selects which agent's activity feed the page loads. */
  slug: string;
  /** Initial date-range filter; defaults to `'all'`. */
  initialDateRange?: DateRangePreset;
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
  /** Currently-selected execution-log basename (URL-driven). */
  selectedBasename?: string | undefined;
  /** Open the drawer for a basename (URL-driven). */
  onOpenBasename?: (basename: string) => void;
  /** Close the drawer (URL-driven). */
  onCloseBasename?: () => void;
}

interface ActivityHeaderProps {
  logs: AgentLogs;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  dateRange: DateRangePreset;
  onRange: (next: DateRangePreset) => void;
}

interface DateRangeFilterProps {
  value: DateRangePreset;
  onChange: (next: DateRangePreset) => void;
}

interface EntryListProps {
  entries: ReadonlyArray<TimelineEntry>;
}

interface ExecutionListProps {
  executions: ReadonlyArray<TimelineEntry>;
}

interface EntryRowProps {
  entry: TimelineEntry;
}

interface ExecutionRowProps {
  row: TimelineEntry & {
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
    endedAt?: string;
    windowStart?: string;
    windowEnd?: string;
    duration?: number;
    totalTokens?: number;
    tokensUsed?: number;
    costUsd?: number;
    error?: string;
  };
}

interface SkeletonProps {
  dateRange: DateRangePreset;
  onRange: (next: DateRangePreset) => void;
}

interface EmptyProps {
  message: string;
}

interface ErrorBannerProps {
  error: Error | { message?: string } | null;
  onRetry: () => void | Promise<void>;
}

interface ActivityErrorProps extends ErrorBannerProps {
  dateRange: DateRangePreset;
  onRange: (next: DateRangePreset) => void;
}

interface TaskDetailSheetProps {
  slug: string;
  entry: TimelineEntry | null;
  onClose: () => void;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function AgentActivityPage({
  slug,
  initialDateRange = 'all',
  baseUrl,
  fetch: fetchImpl,
  selectedBasename,
  onOpenBasename,
  onCloseBasename,
}: AgentActivityPageProps): React.ReactElement {
  // Local UI state — not injected from server. The hook re-runs when
  // `dateRange` changes (via its `deps` array).
  const [dateRange, setDateRange] = React.useState<DateRangePreset>(initialDateRange);
  // Drawer state defaults to local — tests and standalone use cases
  // never hand over URL-driven open/close. When the router-aware
  // parent threads `selectedBasename` + `onOpenBasename` /
  // `onCloseBasename`, the URL becomes the source of truth.
  const [internalBasename, setInternalBasename] = React.useState<string | null>(
    null,
  );
  const effectiveBasename =
    selectedBasename !== undefined ? selectedBasename : internalBasename;

  const { data, error, loading, refresh } = useAgentLogs(slug, {
    dateRange,
    baseUrl,
    fetch: fetchImpl,
  });

  const selectedEntry = React.useMemo<TimelineEntry | null>(() => {
    if (!effectiveBasename) return null;
    const entries: ReadonlyArray<TimelineEntry> =
      (data?.entries as ReadonlyArray<TimelineEntry>) || [];
    return (
      entries.find((e) => executionLogBasename(e) === effectiveBasename) ||
      // The entry might be filtered out of the date range — fall back
      // to a synthetic placeholder so the drawer still renders the log
      // for deep-linked URLs.
      ({ id: effectiveBasename, taskId: '', metadata: {} } as TimelineEntry)
    );
  }, [effectiveBasename, data]);

  function openEntry(entry: TimelineEntry): void {
    const basename = executionLogBasename(entry);
    if (!basename) return;
    if (typeof onOpenBasename === 'function') onOpenBasename(basename);
    else setInternalBasename(basename);
  }
  function closeEntry(): void {
    if (typeof onCloseBasename === 'function') onCloseBasename();
    else setInternalBasename(null);
  }

  if (!slug) return <ActivityEmpty message="Select an agent to view activity." />;
  if (loading && !data)
    return <ActivitySkeleton dateRange={dateRange} onRange={setDateRange} />;

  // `useAgentLogs` widens `error` to `Error | null`; ApiError carries a
  // `.status`. Read it through a structural cast so the 404 short-circuit
  // doesn't require importing the class here.
  const errorWithStatus = error as unknown as { status?: unknown } | null;
  const errorStatus =
    errorWithStatus && typeof errorWithStatus.status === 'number'
      ? errorWithStatus.status
      : null;
  if (error && errorStatus === 404)
    return <ActivityEmpty message={`No agent found for slug "${slug}".`} />;
  if (error && !data)
    return (
      <ActivityError
        error={error}
        onRetry={refresh}
        dateRange={dateRange}
        onRange={setDateRange}
      />
    );
  if (!data) return <ActivityEmpty message={`No activity for "${slug}".`} />;

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-activity"
      data-agent-slug={data.slug}
      data-date-range={data.dateRange}
    >
      <ActivityHeader
        logs={data}
        loading={loading}
        onRefresh={refresh}
        dateRange={dateRange}
        onRange={setDateRange}
      />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      <ActivityTimeline
        entries={data.entries as ReadonlyArray<TimelineEntry>}
        title="Chronological timeline"
        emptyMessage={`No activity in this range for "${data.slug}".`}
        agentSlug={data.slug}
        onSelectEntry={openEntry}
      />
      <TaskDetailSheet
        slug={data.slug}
        entry={selectedEntry}
        onClose={closeEntry}
        baseUrl={baseUrl}
        fetchImpl={fetchImpl}
      />
      <details
        className="group rounded-lg border bg-card text-card-foreground"
        data-page="agent-activity-breakdown"
      >
        <summary className="cursor-pointer select-none border-b bg-muted/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          By source
        </summary>
        <div className="flex flex-col gap-4 p-3">
          <ActivityEntries entries={data.entries as ReadonlyArray<TimelineEntry>} />
          <ExecutionEntries
            executions={data.executions as ReadonlyArray<TimelineEntry>}
          />
        </div>
      </details>
    </section>
  );
}

export default AgentActivityPage;

// ── Header + filter ─────────────────────────────────────────────────

function ActivityHeader({
  logs,
  loading,
  onRefresh,
  dateRange,
  onRange,
}: ActivityHeaderProps): React.ReactElement {
  const totalRows =
    (logs.entries?.length || 0) + (logs.executions?.length || 0);
  return (
    <header className="flex flex-col gap-3 border-b pb-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold leading-none tracking-tight text-foreground">
            Activity
          </h1>
          <p className="text-xs text-muted-foreground">
            <code>{logs.slug}</code> · {totalRows} row{totalRows === 1 ? '' : 's'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      <DateRangeFilter value={dateRange} onChange={onRange} />
    </header>
  );
}

function DateRangeFilter({
  value,
  onChange,
}: DateRangeFilterProps): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label="Date range"
      className="flex flex-wrap gap-1.5"
    >
      {DATE_RANGE_OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <Button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-range-value={opt.value}
            onClick={() => onChange(opt.value)}
            variant={selected ? 'default' : 'outline'}
            size="sm"
            className="rounded-full"
          >
            {opt.label}
          </Button>
        );
      })}
    </div>
  );
}

// ── Entry lists ─────────────────────────────────────────────────────

function ActivityEntries({ entries }: EntryListProps): React.ReactElement {
  return (
    <Card as="section">
      <CardHeader className="space-y-0 border-b bg-muted/50 p-0">
        <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Activity log
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {entries && entries.length > 0 ? (
          <ul role="list" className="divide-y">
            {entries.map((entry, idx) => (
              <EntryRow
                key={(entry.id as string) || (entry.timestamp as string) || idx}
                entry={entry}
              />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-6 text-center text-xs italic text-muted-foreground">
            No activity entries in this range.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExecutionEntries({
  executions,
}: ExecutionListProps): React.ReactElement {
  return (
    <Card as="section">
      <CardHeader className="space-y-0 border-b bg-muted/50 p-0">
        <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Execution history
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {executions && executions.length > 0 ? (
          <ul role="list" className="divide-y">
            {executions.map((row, idx) => (
              <ExecutionRow
                key={
                  (row.id as string) ||
                  ((row as ExecutionRowProps['row']).startedAt as string) ||
                  idx
                }
                row={row as ExecutionRowProps['row']}
              />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-6 text-center text-xs italic text-muted-foreground">
            No executions in this range.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EntryRow({ entry }: EntryRowProps): React.ReactElement {
  // Field names mirror `src/storage/activity-log-store.js` → `createLogEntry`:
  //   { id, timestamp, agentId, status, title, taskId?, duration?, metadata? }
  const at =
    (entry.timestamp as string | undefined) ||
    ((entry['at'] as string | undefined) ?? undefined) ||
    ((entry['createdAt'] as string | undefined) ?? undefined);
  const status =
    (entry.status as string | undefined) ||
    ((entry['kind'] as string | undefined) ?? undefined) ||
    ((entry['type'] as string | undefined) ?? undefined) ||
    'event';
  const title =
    (entry.title as string | undefined) ||
    (entry.message as string | undefined) ||
    ((entry['summary'] as string | undefined) ?? undefined) ||
    ((entry['text'] as string | undefined) ?? undefined) ||
    '';
  const durationRaw = entry['duration'];
  const durationMs =
    typeof durationRaw === 'number' && Number.isFinite(durationRaw)
      ? durationRaw
      : null;
  const taskId = (entry.taskId as string | undefined) || null;
  return (
    <li className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <time dateTime={at} className="tabular-nums">
          {formatDate(at)}
        </time>
        <Badge variant="secondary">{status}</Badge>
        {taskId ? (
          <span className="text-[11px] text-muted-foreground">
            Task <code>{taskId}</code>
          </span>
        ) : null}
        {durationMs != null ? (
          <span className="text-[11px] text-muted-foreground">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </div>
      {title ? (
        <div className="text-sm text-foreground">{String(title)}</div>
      ) : null}
    </li>
  );
}

function ExecutionRow({ row }: ExecutionRowProps): React.ReactElement {
  // Field names mirror `src/storage/execution-store.js` → `createExecutionRecord`.
  const status =
    row.status || (row.exitCode === 0 ? 'completed' : 'failed');
  const timestamp =
    row.timestamp ||
    row.startedAt ||
    ((row['at'] as string | undefined) ?? undefined);
  const windowStart = row.windowStart || null;
  const windowEnd = row.windowEnd || row.finishedAt || row.endedAt || null;
  const durationMs =
    typeof row.duration === 'number' && Number.isFinite(row.duration)
      ? row.duration
      : null;
  const metadata = (row.metadata as Record<string, unknown> | undefined) || {};
  const tokens =
    row.totalTokens ??
    row.tokensUsed ??
    (metadata['totalTokens'] as number | undefined) ??
    (metadata['tokensUsed'] as number | undefined);
  const cost = row.costUsd ?? (metadata['costUsd'] as number | undefined);
  const errorMessage =
    row.error || (metadata['error'] as string | undefined);
  const variant = executionBadgeVariant(status);
  return (
    <li className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <time dateTime={timestamp} className="tabular-nums">
          {formatDate(timestamp)}
        </time>
        <Badge variant={variant} className="tracking-widest">
          {String(status)}
        </Badge>
        {windowStart && windowEnd && windowStart !== windowEnd ? (
          <span className="text-[11px] text-muted-foreground">
            window {formatDate(windowStart)} → {formatDate(windowEnd)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground">
        {row.taskId ? (
          <span>
            Task <code className="text-[11px]">{row.taskId}</code>
          </span>
        ) : null}
        {durationMs != null ? <span>{formatDuration(durationMs)}</span> : null}
        {tokens != null ? <span>{formatTokens(tokens)} tokens</span> : null}
        {cost != null ? <span>${(Number(cost) || 0).toFixed(4)}</span> : null}
      </div>
      {errorMessage ? (
        <div className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {String(errorMessage)}
        </div>
      ) : null}
    </li>
  );
}

// ── Empty / loading / error ─────────────────────────────────────────

function ActivitySkeleton({
  dateRange,
  onRange,
}: SkeletonProps): React.ReactElement {
  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-activity"
      data-loading="true"
    >
      <header className="flex flex-col gap-3 border-b pb-3">
        <div className="text-base font-semibold leading-none tracking-tight text-foreground">
          Activity
        </div>
        <DateRangeFilter value={dateRange} onChange={onRange} />
      </header>
      <div
        role="status"
        aria-live="polite"
        className="animate-pulse text-sm text-muted-foreground"
      >
        Loading activity…
      </div>
    </section>
  );
}

function ActivityEmpty({ message }: EmptyProps): React.ReactElement {
  return (
    <Card
      as="div"
      className="border-dashed bg-transparent shadow-none"
      data-page="agent-activity"
      data-state="empty"
    >
      <CardHeader className="items-center p-8 text-center">
        <CardDescription className="text-sm italic">{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function ActivityError({
  error,
  onRetry,
  dateRange,
  onRange,
}: ActivityErrorProps): React.ReactElement {
  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-activity"
      data-error="true"
    >
      <header className="flex flex-col gap-3 border-b pb-3">
        <div className="text-base font-semibold leading-none tracking-tight text-foreground">
          Activity
        </div>
        <DateRangeFilter value={dateRange} onChange={onRange} />
      </header>
      <Card
        role="alert"
        as="div"
        className="border-destructive/40 bg-destructive/10 text-destructive"
      >
        <CardHeader className="space-y-1 p-4">
          <CardTitle className="text-sm font-semibold leading-none">
            Failed to load activity.
          </CardTitle>
          <CardDescription className="text-xs text-destructive/80">
            {error?.message || String(error)}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="border-destructive/40 text-destructive hover:bg-destructive/20 hover:text-destructive"
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

function StaleBanner({ error, onRetry }: ErrorBannerProps): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground"
    >
      <span>
        Refresh failed ({error?.message || 'unknown error'}) — showing
        last-known data.
      </span>
      <Button
        type="button"
        onClick={onRetry}
        variant="link"
        size="sm"
        className="h-auto px-0 py-0 text-xs"
      >
        Retry
      </Button>
    </div>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso);
  return new Date(ms).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatTokens(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}

/**
 * Format a wall-clock duration in milliseconds as a compact human string
 * (e.g. "1.2m", "45s"). Mirrors the terminal formatter used by
 * `src/skills/status.js` / summary tables so activity rows read the same.
 */
function formatDuration(ms: number | null | undefined): string {
  const v = Number(ms) || 0;
  if (v <= 0) return '0s';
  if (v < 1000) return `${v}ms`;
  const sec = v / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(min < 10 ? 1 : 0)}m`;
  const hr = min / 60;
  return `${hr.toFixed(hr < 10 ? 1 : 0)}h`;
}

/**
 * Right-side shadcn Sheet surfacing the execution-log summary for the
 * activity entry the user just clicked. Opens when `entry` is non-null
 * and fetches the log on mount via `useExecutionLog`. Closing sets
 * `entry` back to null through the parent-owned `onClose`.
 */
function TaskDetailSheet({
  slug,
  entry,
  onClose,
  baseUrl,
  fetchImpl,
}: TaskDetailSheetProps): React.ReactElement {
  const basename = entry ? executionLogBasename(entry) : null;
  const { loading, error, summary } = useExecutionLog({
    slug,
    basename: basename || '',
    enabled: Boolean(entry && basename),
    baseUrl,
    fetch: fetchImpl,
  });
  // `useExecutionLog` initialises `error` to `null` so TS infers it as
  // `null`. Widen via a structural cast so we can read `.message` after
  // the truthy guard.
  const typedError = error as { message?: string } | null;
  const open = entry != null;
  const status = entry?.status || 'event';
  const title = entry?.title || entry?.message || 'Task';
  const taskId = entry?.taskId || null;
  return (
    <Sheet open={open} onOpenChange={(next: boolean) => (next ? null : onClose())}>
      <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-4xl">
        {entry ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2">
                <Badge variant={executionBadgeVariant(status)}>
                  {String(status).toUpperCase()}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                {taskId ? (
                  <Badge variant="outline">
                    task <code className="ml-1 text-[11px]">{taskId}</code>
                  </Badge>
                ) : null}
                {basename ? (
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                    {basename}
                  </code>
                ) : null}
              </SheetDescription>
            </SheetHeader>

            {!basename ? (
              <Card className="border-dashed">
                <CardContent className="py-6 text-sm italic text-muted-foreground">
                  This activity entry has no execution log attached.
                </CardContent>
              </Card>
            ) : typedError ? (
              <Card>
                <CardContent className="py-6 text-sm text-destructive">
                  {typedError.message || 'Failed to load execution log.'}
                </CardContent>
              </Card>
            ) : loading ? (
              <Card>
                <CardContent className="py-6 text-sm italic text-muted-foreground">
                  Loading execution log…
                </CardContent>
              </Card>
            ) : !summary ? (
              <Card className="border-dashed">
                <CardContent className="py-6 text-sm italic text-muted-foreground">
                  No log lines found for this execution. The{' '}
                  <code className="not-italic text-foreground">.jsonl</code>{' '}
                  file may have been pruned or never written.
                </CardContent>
              </Card>
            ) : (
              <ExecutionLogView summary={summary as ExecutionLogSummary} variant="drawer" />
            )}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
