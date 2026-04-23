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
 * @module serve/spa/pages/agent-activity-page
 */

import React, { useState } from 'react';

import { ActivityTimeline } from '../components/activity-timeline.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import { useAgentLogs } from '../hooks/use-agent-logs.js';

/**
 * @typedef {import('../lib/api-client.js').AgentLogs} AgentLogs
 * @typedef {import('../lib/api-client.js').DateRangePreset} DateRangePreset
 */

/** @type {ReadonlyArray<{ value: DateRangePreset, label: string }>} */
const DATE_RANGE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'this-week', label: 'This week' },
  { value: 'last-7-days', label: 'Last 7 days' },
];

/**
 * @param {{
 *   slug: string,
 *   initialDateRange?: DateRangePreset,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 * @returns {JSX.Element}
 */
export function AgentActivityPage({
  slug,
  initialDateRange = 'all',
  baseUrl,
  fetch: fetchImpl,
}) {
  // Local UI state — not injected from server. The hook re-runs when
  // `dateRange` changes (via its `deps` array).
  const [dateRange, setDateRange] = useState(initialDateRange);

  const { data, error, loading, refresh } = useAgentLogs(slug, {
    dateRange,
    baseUrl,
    fetch: fetchImpl,
  });

  if (!slug) return <ActivityEmpty message="Select an agent to view activity." />;
  if (loading && !data) return <ActivitySkeleton dateRange={dateRange} onRange={setDateRange} />;
  if (error && error.status === 404)
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
        entries={data.entries}
        executions={data.executions}
        title="Chronological timeline"
        emptyMessage={`No activity in this range for "${data.slug}".`}
      />
      <details
        className="group rounded-md border border-slate-800 bg-slate-900/30"
        data-page="agent-activity-breakdown"
      >
        <summary className="cursor-pointer select-none border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400 group-open:border-b-slate-800">
          By source
        </summary>
        <div className="flex flex-col gap-4 p-3">
          <ActivityEntries entries={data.entries} />
          <ExecutionEntries executions={data.executions} />
        </div>
      </details>
    </section>
  );
}

export default AgentActivityPage;

// ── Header + filter ─────────────────────────────────────────────────

function ActivityHeader({ logs, loading, onRefresh, dateRange, onRange }) {
  const totalRows =
    (logs.entries?.length || 0) + (logs.executions?.length || 0);
  return (
    <header className="flex flex-col gap-3 border-b border-slate-800 pb-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-slate-100">
            Activity
          </h1>
          <p className="text-xs text-slate-400">
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

function DateRangeFilter({ value, onChange }) {
  return (
    <div
      role="radiogroup"
      aria-label="Date range"
      className="flex flex-wrap gap-1.5"
    >
      {DATE_RANGE_OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-range-value={opt.value}
            onClick={() => onChange(opt.value)}
            className={
              selected
                ? 'rounded-full border border-sky-400/50 bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-200'
                : 'rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200'
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Entry lists ─────────────────────────────────────────────────────

function ActivityEntries({ entries }) {
  return (
    <section className="rounded-md border border-slate-800 bg-slate-900/30">
      <div className="border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
        Activity log
      </div>
      {entries && entries.length > 0 ? (
        <ul role="list" className="divide-y divide-slate-800">
          {entries.map((entry, idx) => (
            <EntryRow key={entry.id || entry.at || idx} entry={entry} />
          ))}
        </ul>
      ) : (
        <div className="px-4 py-6 text-center text-xs italic text-slate-500">
          No activity entries in this range.
        </div>
      )}
    </section>
  );
}

function ExecutionEntries({ executions }) {
  return (
    <section className="rounded-md border border-slate-800 bg-slate-900/30">
      <div className="border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
        Execution history
      </div>
      {executions && executions.length > 0 ? (
        <ul role="list" className="divide-y divide-slate-800">
          {executions.map((row, idx) => (
            <ExecutionRow key={row.id || row.startedAt || idx} row={row} />
          ))}
        </ul>
      ) : (
        <div className="px-4 py-6 text-center text-xs italic text-slate-500">
          No executions in this range.
        </div>
      )}
    </section>
  );
}

function EntryRow({ entry }) {
  // Field names mirror `src/storage/activity-log-store.js` → `createLogEntry`:
  //   { id, timestamp, agentId, status, title, taskId?, duration?, metadata? }
  // Fallback field names (at / kind / message) are retained as defensive
  // reads so extra metadata passed through from `gatherAgentLogs` still
  // renders cleanly if the upstream shape ever shifts.
  const at = entry.timestamp || entry.at || entry.createdAt;
  const status = entry.status || entry.kind || entry.type || 'event';
  const title =
    entry.title || entry.message || entry.summary || entry.text || '';
  const durationMs = Number.isFinite(entry.duration) ? entry.duration : null;
  const taskId = entry.taskId || null;
  return (
    <li className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <time dateTime={at} className="tabular-nums">
          {formatDate(at)}
        </time>
        <Badge variant="secondary" className="rounded">
          {status}
        </Badge>
        {taskId ? (
          <span className="text-[11px] text-slate-500">
            Task <code>{taskId}</code>
          </span>
        ) : null}
        {durationMs != null ? (
          <span className="text-[11px] text-slate-500">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </div>
      {title ? (
        <div className="text-sm text-slate-200">{String(title)}</div>
      ) : null}
    </li>
  );
}

function ExecutionRow({ row }) {
  // Field names mirror `src/storage/execution-store.js` → `createExecutionRecord`:
  //   { id, idempotencyKey, agentId, timestamp, windowStart, windowEnd,
  //     status, taskId?, duration?, metadata? }
  // Fallback reads let token / cost metadata tucked inside `row.metadata`
  // (or passed through as top-level fields) still render cleanly.
  const status =
    row.status || (row.exitCode === 0 ? 'completed' : 'failed');
  const timestamp = row.timestamp || row.startedAt || row.at;
  const windowStart = row.windowStart || null;
  const windowEnd = row.windowEnd || row.finishedAt || row.endedAt || null;
  const durationMs = Number.isFinite(row.duration) ? row.duration : null;
  const tokens =
    row.totalTokens ??
    row.tokensUsed ??
    row?.metadata?.totalTokens ??
    row?.metadata?.tokensUsed;
  const cost = row.costUsd ?? row?.metadata?.costUsd;
  const error = row.error || row?.metadata?.error;
  const variant =
    status === 'completed' || status === 'success'
      ? 'success'
      : status === 'failed' || status === 'failure'
        ? 'destructive'
        : status === 'skipped'
          ? 'warning'
          : 'outline';
  return (
    <li className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <time dateTime={timestamp} className="tabular-nums">
          {formatDate(timestamp)}
        </time>
        <Badge variant={variant} className="tracking-widest">
          {String(status)}
        </Badge>
        {windowStart && windowEnd && windowStart !== windowEnd ? (
          <span className="text-[11px] text-slate-500">
            window {formatDate(windowStart)} → {formatDate(windowEnd)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300">
        {row.taskId ? (
          <span>
            Task <code className="text-[11px]">{row.taskId}</code>
          </span>
        ) : null}
        {durationMs != null ? <span>{formatDuration(durationMs)}</span> : null}
        {tokens != null ? <span>{formatTokens(tokens)} tokens</span> : null}
        {cost != null ? <span>${(Number(cost) || 0).toFixed(4)}</span> : null}
      </div>
      {error ? (
        <div className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-300">
          {String(error)}
        </div>
      ) : null}
    </li>
  );
}

// ── Empty / loading / error ─────────────────────────────────────────

function ActivitySkeleton({ dateRange, onRange }) {
  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-activity"
      data-loading="true"
    >
      <header className="flex flex-col gap-3 border-b border-slate-800 pb-3">
        <div className="text-base font-semibold tracking-tight text-slate-100">
          Activity
        </div>
        <DateRangeFilter value={dateRange} onChange={onRange} />
      </header>
      <div
        role="status"
        aria-live="polite"
        className="animate-pulse text-sm text-slate-500"
      >
        Loading activity…
      </div>
    </section>
  );
}

function ActivityEmpty({ message }) {
  return (
    <div
      className="rounded-md border border-dashed border-slate-800 p-8 text-center text-sm italic text-slate-400"
      data-page="agent-activity"
      data-state="empty"
    >
      {message}
    </div>
  );
}

function ActivityError({ error, onRetry, dateRange, onRange }) {
  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-activity"
      data-error="true"
    >
      <header className="flex flex-col gap-3 border-b border-slate-800 pb-3">
        <div className="text-base font-semibold tracking-tight text-slate-100">
          Activity
        </div>
        <DateRangeFilter value={dateRange} onChange={onRange} />
      </header>
      <div
        role="alert"
        className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200"
      >
        <div className="font-semibold">Failed to load activity.</div>
        <div className="mt-1 text-xs opacity-80">
          {error?.message || String(error)}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="mt-3 border-red-400/50 text-red-200 hover:bg-red-500/20"
        >
          Retry
        </Button>
      </div>
    </section>
  );
}

function StaleBanner({ error, onRetry }) {
  return (
    <div
      role="alert"
      className="rounded border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-200"
    >
      Refresh failed ({error?.message || 'unknown error'}) — showing last-known data.{' '}
      <button
        type="button"
        onClick={onRetry}
        className="underline decoration-dotted hover:decoration-solid"
      >
        Retry
      </button>
    </div>
  );
}

function formatDate(iso) {
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

function formatTokens(n) {
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
