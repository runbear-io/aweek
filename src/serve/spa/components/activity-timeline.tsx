/**
 * `ActivityTimeline` — unified chronological visualization merging
 * `ActivityLogStore` entries and `ExecutionStore` records into a single
 * time-sorted stream (Sub-AC 3 of AC 4).
 *
 * Baseline parity:
 *   - Activity-log entries are sourced from `src/storage/activity-log-store.js`
 *     (per-task user-facing rows: started / completed / failed / skipped /
 *     delegated).
 *   - Execution entries are sourced from `src/storage/execution-store.js`
 *     (heartbeat audit rows: one per tick with idempotency key + time window).
 *
 * Rendering contract:
 *   - Both sources are interleaved by `timestamp` (newest-first, matching
 *     the server-supplied ordering and the SSR Activity tab's convention).
 *   - Each timeline item is tagged with its originating source via a
 *     visible badge + a per-source rail dot color so operators can scan
 *     "did the heartbeat fire at 14:00?" alongside "did the planning task
 *     complete?" in one pass.
 *   - Pure presentational component — accepts pre-fetched arrays and has
 *     no hook / fetch dependency. The page-level component threads data
 *     in from `useAgentLogs`.
 *
 * This component is reusable: it can be mounted directly into the Agent
 * Activity tab (primary use), or into other surfaces that need a merged
 * "what did this agent do recently" view without duplicating the merge
 * logic.
 *
 * TypeScript migration note (AC 204, Sub-AC 3.4):
 *   Converted from `.jsx` → `.tsx`. The previously JSDoc-only
 *   `TimelineItem` shape, plus the activity-log entry / execution-record
 *   props, are now declared as TypeScript interfaces. The
 *   `ActivityLogEntry` / `ExecutionRecord` shapes are intentionally
 *   permissive (`Record<string, unknown>` index signature + a few typed
 *   fields the component actually reads) so the component can keep
 *   absorbing the loose JSON the server emits without forcing a strict
 *   schema on every callsite — the server-side stores are still raw `.js`
 *   in this migration phase. Sibling helper imports stay `.js` and are
 *   referenced through their `.js` extensions per the SPA's `allowJs`
 *   policy.
 *
 * @module serve/spa/components/activity-timeline
 */

import * as React from 'react';

// ── Cross-boundary types ────────────────────────────────────────────

/**
 * Permissive activity-log entry shape (matches `createLogEntry` in
 * `src/storage/activity-log-store.js` and the rows surfaced by
 * `src/serve/data/logs.js`). Only fields the component actively reads
 * are typed; the index signature lets the component pass extra
 * server-emitted fields through to consumers (e.g. `executionLogBasename`)
 * without per-call casts.
 */
export interface ActivityLogEntry {
  id?: string;
  timestamp?: string | null;
  at?: string | null;
  createdAt?: string | null;
  agentId?: string;
  status?: string;
  kind?: string;
  type?: string;
  title?: string;
  message?: string;
  summary?: string;
  text?: string;
  taskId?: string | null;
  duration?: number;
  metadata?: {
    execution?: {
      executionLogPath?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Permissive execution-record shape (matches `createExecutionRecord` in
 * `src/storage/execution-store.js`). As with `ActivityLogEntry`, only the
 * fields the component reads are typed — the rest pass through.
 */
export interface ExecutionRecord {
  id?: string;
  idempotencyKey?: string;
  agentId?: string;
  timestamp?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  endedAt?: string | null;
  at?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  status?: string;
  exitCode?: number;
  taskId?: string | null;
  duration?: number;
  totalTokens?: number;
  tokensUsed?: number;
  costUsd?: number;
  error?: string;
  metadata?: {
    totalTokens?: number;
    tokensUsed?: number;
    costUsd?: number;
    error?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Which underlying store a timeline row originated from. */
export type TimelineSource = 'activity' | 'execution';

/** A single merged row produced by `buildTimeline`. */
export interface TimelineItem {
  /** Stable React key (source + id / idx). */
  key: string;
  /** Which store the row came from. */
  source: TimelineSource;
  /** Numeric timestamp used for sorting (epoch ms; 0 when unparseable). */
  sortKey: number;
  /** ISO-8601 timestamp (null if absent). */
  timestamp: string | null;
  /** The unmodified underlying row. */
  raw: ActivityLogEntry | ExecutionRecord;
}

// ── Merge helpers (exported for tests) ───────────────────────────────

/**
 * Merge activity entries + execution records into a single, newest-first
 * timeline. Rows missing a `timestamp` are still preserved but sort to the
 * end (they should not normally occur — the schemas require it — but the
 * read-only dashboard stays forgiving).
 *
 * Stable: equal timestamps retain input order (activity, then execution)
 * so the output is deterministic under a test snapshot.
 */
export function buildTimeline(
  entries: ReadonlyArray<ActivityLogEntry> = [],
  executions: ReadonlyArray<ExecutionRecord> = [],
): TimelineItem[] {
  const merged: TimelineItem[] = [];

  entries.forEach((entry, idx) => {
    const timestamp =
      entry?.timestamp || entry?.at || entry?.createdAt || null;
    merged.push({
      key: `activity:${entry?.id || timestamp || idx}`,
      source: 'activity',
      sortKey: parseTimestampMs(timestamp),
      timestamp,
      raw: entry,
    });
  });

  executions.forEach((row, idx) => {
    const timestamp = row?.timestamp || row?.startedAt || row?.at || null;
    merged.push({
      key: `execution:${row?.id || row?.idempotencyKey || timestamp || idx}`,
      source: 'execution',
      sortKey: parseTimestampMs(timestamp),
      timestamp,
      raw: row,
    });
  });

  // Newest first; stable tie-breaker: activity before execution when
  // timestamps match (mirrors the two-section legacy ordering).
  merged.sort((a, b) => {
    if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
    if (a.source === b.source) return 0;
    return a.source === 'activity' ? -1 : 1;
  });

  return merged;
}

/**
 * Parse an ISO timestamp to epoch ms. Unparseable / missing → 0 so the
 * row sorts to the end under the newest-first comparator.
 */
function parseTimestampMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

// ── Primary component ────────────────────────────────────────────────

export interface ActivityTimelineProps {
  /** Activity-log rows (newest-first; the merge re-sorts). */
  entries?: ReadonlyArray<ActivityLogEntry>;
  /** Execution-store rows (newest-first; the merge re-sorts). */
  executions?: ReadonlyArray<ExecutionRecord>;
  /** Message rendered when both lists are empty. */
  emptyMessage?: string;
  /** Caption rendered above the timeline. */
  title?: string;
  /** Caller-supplied class name appended to the section root. */
  className?: string;
  /** Agent slug — passed through to row handlers but not rendered itself. */
  agentSlug?: string;
  /**
   * Click handler invoked when an activity row with an attached
   * execution-log path is selected. Rows without a log are non-clickable.
   */
  onSelectEntry?: (entry: ActivityLogEntry) => void;
}

/**
 * Unified chronological timeline.
 */
export function ActivityTimeline({
  entries = [],
  executions = [],
  emptyMessage = 'No activity in this range.',
  title = 'Timeline',
  className,
  agentSlug,
  onSelectEntry,
}: ActivityTimelineProps): React.ReactElement {
  const items = buildTimeline(entries, executions);
  const totalRows = items.length;

  return (
    <section
      data-component="activity-timeline"
      data-row-count={totalRows}
      className={[
        'rounded-md border border-border bg-muted/30',
        className || '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {title}
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {totalRows} row{totalRows === 1 ? '' : 's'}
        </div>
      </div>

      {totalRows === 0 ? (
        <div
          className="px-4 py-6 text-center text-xs italic text-muted-foreground"
          data-timeline-empty="true"
        >
          {emptyMessage}
        </div>
      ) : (
        <ol
          role="list"
          aria-label="Chronological activity timeline"
          className="relative divide-y divide-border"
        >
          {items.map((item) => (
            <TimelineRow
              key={item.key}
              item={item}
              agentSlug={agentSlug}
              onSelectEntry={onSelectEntry}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

export default ActivityTimeline;

// ── Row renderers ────────────────────────────────────────────────────

interface TimelineRowProps {
  item: TimelineItem;
  agentSlug?: string;
  onSelectEntry?: (entry: ActivityLogEntry) => void;
}

/**
 * Branch on item source — activity rows render friendly titles, execution
 * rows render heartbeat window + token / cost metadata.
 */
function TimelineRow({
  item,
  agentSlug: _agentSlug,
  onSelectEntry,
}: TimelineRowProps): React.ReactElement {
  const activityRaw =
    item.source === 'activity' ? (item.raw as ActivityLogEntry) : null;
  const clickable =
    activityRaw != null &&
    typeof onSelectEntry === 'function' &&
    !!executionLogBasename(activityRaw);
  const handleClick =
    clickable && activityRaw && onSelectEntry
      ? () => onSelectEntry(activityRaw)
      : undefined;
  const handleKeyDown =
    clickable && activityRaw && onSelectEntry
      ? (event: React.KeyboardEvent<HTMLLIElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelectEntry(activityRaw);
          }
        }
      : undefined;
  return (
    <li
      className={`flex items-start gap-3 px-4 py-2.5 ${
        clickable
          ? 'cursor-pointer transition-colors hover:bg-muted/50 focus-within:bg-muted/50'
          : ''
      }`}
      data-timeline-source={item.source}
      data-timeline-timestamp={item.timestamp || ''}
      data-timeline-clickable={clickable ? 'true' : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <SourceRail source={item.source} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {item.source === 'activity' ? (
          <ActivityRowBody
            entry={item.raw as ActivityLogEntry}
            timestamp={item.timestamp}
          />
        ) : (
          <ExecutionRowBody
            row={item.raw as ExecutionRecord}
            timestamp={item.timestamp}
          />
        )}
      </div>
    </li>
  );
}

interface SourceRailProps {
  source: TimelineSource;
}

/**
 * Left-side rail: a colored dot + short badge identifying the source.
 * The dot color is deliberately different per source so the interleaved
 * stream stays scannable.
 */
function SourceRail({ source }: SourceRailProps): React.ReactElement {
  if (source === 'execution') {
    return (
      <div
        className="flex flex-col items-center gap-1"
        aria-hidden="true"
      >
        <span
          className="mt-1.5 h-2.5 w-2.5 rounded-full border border-violet-300/70 bg-violet-500"
          data-rail-dot="execution"
        />
        <span className="w-px flex-1 bg-border" />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1" aria-hidden="true">
      <span
        className="mt-1.5 h-2.5 w-2.5 rounded-full border border-sky-300/70 bg-sky-500"
        data-rail-dot="activity"
      />
      <span className="w-px flex-1 bg-border" />
    </div>
  );
}

interface SourceBadgeProps {
  source: TimelineSource;
}

function SourceBadge({ source }: SourceBadgeProps): React.ReactElement {
  const label = source === 'execution' ? 'Heartbeat' : 'Activity';
  const tone =
    source === 'execution'
      ? 'border-violet-400/40 text-violet-200 bg-violet-500/10'
      : 'border-sky-400/40 text-sky-200 bg-sky-500/10';
  return (
    <span
      data-timeline-badge={source}
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${tone}`}
    >
      {label}
    </span>
  );
}

interface ActivityRowBodyProps {
  entry: ActivityLogEntry;
  timestamp: string | null;
}

function ActivityRowBody({
  entry,
  timestamp,
}: ActivityRowBodyProps): React.ReactElement {
  // Field names mirror `createLogEntry` in activity-log-store.js:
  //   { id, timestamp, agentId, status, title, taskId?, duration?, metadata? }
  const status = entry?.status || entry?.kind || entry?.type || 'event';
  const title =
    entry?.title || entry?.message || entry?.summary || entry?.text || '';
  const durationMs =
    typeof entry?.duration === 'number' && Number.isFinite(entry.duration)
      ? entry.duration
      : null;
  const taskId = entry?.taskId || null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <SourceBadge source="activity" />
        <time dateTime={timestamp || undefined} className="tabular-nums">
          {formatDate(timestamp)}
        </time>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground">
          {String(status)}
        </span>
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
    </>
  );
}

interface ExecutionRowBodyProps {
  row: ExecutionRecord;
  timestamp: string | null;
}

function ExecutionRowBody({
  row,
  timestamp,
}: ExecutionRowBodyProps): React.ReactElement {
  // Field names mirror `createExecutionRecord` in execution-store.js:
  //   { id, idempotencyKey, agentId, timestamp, windowStart, windowEnd,
  //     status, taskId?, duration?, metadata? }
  const status =
    row?.status || (row?.exitCode === 0 ? 'completed' : 'failed');
  const windowStart = row?.windowStart || null;
  const windowEnd =
    row?.windowEnd || row?.finishedAt || row?.endedAt || null;
  const durationMs =
    typeof row?.duration === 'number' && Number.isFinite(row.duration)
      ? row.duration
      : null;
  const tokens =
    row?.totalTokens ??
    row?.tokensUsed ??
    row?.metadata?.totalTokens ??
    row?.metadata?.tokensUsed;
  const cost = row?.costUsd ?? row?.metadata?.costUsd;
  const error = row?.error || row?.metadata?.error;
  const tone =
    status === 'completed' || status === 'success'
      ? 'text-emerald-300 border-emerald-400/40 bg-emerald-500/10'
      : status === 'failed' || status === 'failure'
        ? 'text-red-300 border-red-400/40 bg-red-500/10'
        : status === 'skipped'
          ? 'text-amber-300 border-amber-300/40 bg-amber-500/10'
          : 'text-muted-foreground border-border bg-muted/40';
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <SourceBadge source="execution" />
        <time dateTime={timestamp || undefined} className="tabular-nums">
          {formatDate(timestamp)}
        </time>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${tone}`}
        >
          {String(status)}
        </span>
        {windowStart && windowEnd && windowStart !== windowEnd ? (
          <span className="text-[11px] text-muted-foreground">
            window {formatDate(windowStart)} → {formatDate(windowEnd)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground">
        {row?.taskId ? (
          <span>
            Task <code className="text-[11px]">{row.taskId}</code>
          </span>
        ) : null}
        {durationMs != null ? <span>{formatDuration(durationMs)}</span> : null}
        {tokens != null ? <span>{formatTokens(tokens)} tokens</span> : null}
        {cost != null ? (
          <span>${(Number(cost) || 0).toFixed(4)}</span>
        ) : null}
      </div>
      {error ? (
        <div className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-300">
          {String(error)}
        </div>
      ) : null}
    </>
  );
}

/**
 * Derive the `<taskId>_<executionId>` basename the execution-log page
 * routes on from an activity entry. Uses the heartbeat's persisted
 * `metadata.execution.executionLogPath` (e.g.
 * `.aweek/agents/<slug>/executions/<taskId>_<executionId>.jsonl`). Returns
 * null when the entry predates execution-log plumbing or the path is
 * malformed — the caller suppresses the link in that case.
 */
export function executionLogBasename(
  entry: ActivityLogEntry | null | undefined,
): string | null {
  const path = entry?.metadata?.execution?.executionLogPath;
  if (typeof path !== 'string' || path.length === 0) return null;
  const last = path.split(/[/\\]/).pop() || '';
  return last.endsWith('.jsonl') ? last.slice(0, -'.jsonl'.length) : last || null;
}

// ── Formatters ───────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
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
 * `src/skills/status.js` / summary tables.
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
