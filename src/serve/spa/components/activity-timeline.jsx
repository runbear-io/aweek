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
 * @module serve/spa/components/activity-timeline
 */

import React from 'react';

/**
 * @typedef {import('../lib/api-client.js').ActivityEntry} ActivityEntry
 * @typedef {import('../lib/api-client.js').ExecutionEntry} ExecutionEntry
 *
 * @typedef {'activity' | 'execution'} TimelineSource
 *
 * @typedef {object} TimelineItem
 * @property {string} key              Stable React key (source + id / idx).
 * @property {TimelineSource} source   Which store the row came from.
 * @property {number} sortKey          Numeric timestamp used for sorting.
 * @property {string | null} timestamp ISO-8601 timestamp (null if absent).
 * @property {object} raw              The unmodified underlying row.
 */

// ── Merge helpers (exported for tests) ───────────────────────────────

/**
 * Merge activity entries + execution records into a single, newest-first
 * timeline. Rows missing a `timestamp` are still preserved but sort to the
 * end (they should not normally occur — the schemas require it — but the
 * read-only dashboard stays forgiving).
 *
 * Stable: equal timestamps retain input order (activity, then execution)
 * so the output is deterministic under a test snapshot.
 *
 * @param {ReadonlyArray<object>} entries     Activity-log entries.
 * @param {ReadonlyArray<object>} executions  Execution records.
 * @returns {TimelineItem[]}
 */
export function buildTimeline(entries = [], executions = []) {
  /** @type {TimelineItem[]} */
  const merged = [];

  entries.forEach((entry, idx) => {
    const timestamp = entry?.timestamp || entry?.at || entry?.createdAt || null;
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
 *
 * @param {string | null | undefined} iso
 * @returns {number}
 */
function parseTimestampMs(iso) {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

// ── Primary component ────────────────────────────────────────────────

/**
 * Unified chronological timeline.
 *
 * @param {{
 *   entries?: ReadonlyArray<object>,
 *   executions?: ReadonlyArray<object>,
 *   emptyMessage?: string,
 *   title?: string,
 *   className?: string,
 * }} props
 * @returns {JSX.Element}
 */
export function ActivityTimeline({
  entries = [],
  executions = [],
  emptyMessage = 'No activity in this range.',
  title = 'Timeline',
  className,
}) {
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
            <TimelineRow key={item.key} item={item} />
          ))}
        </ol>
      )}
    </section>
  );
}

export default ActivityTimeline;

// ── Row renderers ────────────────────────────────────────────────────

/**
 * Branch on item source — activity rows render friendly titles, execution
 * rows render heartbeat window + token / cost metadata.
 *
 * @param {{ item: TimelineItem }} props
 */
function TimelineRow({ item }) {
  return (
    <li
      className="flex items-start gap-3 px-4 py-2.5"
      data-timeline-source={item.source}
      data-timeline-timestamp={item.timestamp || ''}
    >
      <SourceRail source={item.source} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {item.source === 'activity' ? (
          <ActivityRowBody entry={item.raw} timestamp={item.timestamp} />
        ) : (
          <ExecutionRowBody row={item.raw} timestamp={item.timestamp} />
        )}
      </div>
    </li>
  );
}

/**
 * Left-side rail: a colored dot + short badge identifying the source.
 * The dot color is deliberately different per source so the interleaved
 * stream stays scannable.
 */
function SourceRail({ source }) {
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

function SourceBadge({ source }) {
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

function ActivityRowBody({ entry, timestamp }) {
  // Field names mirror `createLogEntry` in activity-log-store.js:
  //   { id, timestamp, agentId, status, title, taskId?, duration?, metadata? }
  const status = entry?.status || entry?.kind || entry?.type || 'event';
  const title =
    entry?.title || entry?.message || entry?.summary || entry?.text || '';
  const durationMs = Number.isFinite(entry?.duration) ? entry.duration : null;
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

function ExecutionRowBody({ row, timestamp }) {
  // Field names mirror `createExecutionRecord` in execution-store.js:
  //   { id, idempotencyKey, agentId, timestamp, windowStart, windowEnd,
  //     status, taskId?, duration?, metadata? }
  const status =
    row?.status || (row?.exitCode === 0 ? 'completed' : 'failed');
  const windowStart = row?.windowStart || null;
  const windowEnd =
    row?.windowEnd || row?.finishedAt || row?.endedAt || null;
  const durationMs = Number.isFinite(row?.duration) ? row.duration : null;
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

// ── Formatters ───────────────────────────────────────────────────────

function formatDate(iso) {
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

function formatTokens(n) {
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
function formatDuration(ms) {
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
