/**
 * `AgentUsagePage` — per-agent budget/usage tab.
 *
 * Data contract (Sub-AC 3.3):
 *   Data is sourced _exclusively_ from `useAgentUsage(slug)`. No
 *   `props.usage`, no `window.__INITIAL_DATA__`, no SSR HTML fragment
 *   reading. Props exist only for navigation + test injection.
 *
 * Baseline parity (per `src/serve/data/budget.js` + `src/storage/usage-store.js`):
 *   - Current-week token total, limit, remaining, over-budget flag
 *   - Utilization % + progress bar
 *   - Per-week historical roll-up bar chart
 *   - Paused/pausedReason surfaced prominently
 *
 * Styling: every card on this page is composed from the shadcn `Card`
 * family (`Card`, `CardHeader`, `CardTitle`, `CardContent`). Buttons use
 * the shadcn `Button` primitive. The raw `<section>` / `<button>` nodes
 * that previously carried bespoke Tailwind borders have been
 * consolidated onto the primitives so the Budget tab reads as a single
 * visual family with the rest of the dashboard.
 *
 * @module serve/spa/pages/agent-usage-page
 */

import React from 'react';

import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../components/ui/card.jsx';
import { cn } from '../lib/cn.js';
import { useAgentUsage } from '../hooks/use-agent-usage.js';

/**
 * @typedef {import('../lib/api-client.js').AgentUsage} AgentUsage
 * @typedef {import('../lib/api-client.js').UsageWeek} UsageWeek
 */

/**
 * @param {{
 *   slug: string,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 * @returns {JSX.Element}
 */
export function AgentUsagePage({ slug, baseUrl, fetch: fetchImpl }) {
  const { data, error, loading, refresh } = useAgentUsage(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  if (!slug) return <UsageEmpty message="Select an agent to view usage." />;
  if (loading && !data) return <UsageSkeleton />;
  if (error && error.status === 404)
    return <UsageEmpty message={`No agent found for slug "${slug}".`} />;
  if (error && !data) return <UsageError error={error} onRetry={refresh} />;
  if (!data) return <UsageEmpty message={`No usage data for "${slug}".`} />;

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-usage"
      data-agent-slug={data.slug}
    >
      <UsageHeader usage={data} loading={loading} onRefresh={refresh} />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      {data.paused ? <PausedBanner usage={data} /> : null}
      <CurrentWeekCard usage={data} />
      <HistoryCard weeks={data.weeks} limit={data.tokenLimit} />
    </section>
  );
}

export default AgentUsagePage;

// ── Subcomponents ────────────────────────────────────────────────────

function UsageHeader({ usage, loading, onRefresh }) {
  return (
    <header className="flex items-center justify-between border-b border-slate-800 pb-3">
      <div>
        <h1 className="text-base font-semibold tracking-tight text-slate-100">
          {usage.name} — Budget
        </h1>
        <p className="text-xs text-slate-400">
          <code>{usage.slug}</code> · week of {usage.weekMonday}
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
    </header>
  );
}

function PausedBanner({ usage }) {
  return (
    <Card
      role="alert"
      className="border-amber-400/40 bg-amber-500/10 text-amber-200"
    >
      <CardContent className="p-3 pt-3 text-sm sm:p-3 sm:pt-3">
        <strong className="font-semibold uppercase tracking-wider text-amber-100">
          Paused
        </strong>
        {usage.pausedReason ? ` — ${formatPausedReason(usage.pausedReason)}` : null}
      </CardContent>
    </Card>
  );
}

/** @param {{ usage: AgentUsage }} props */
function CurrentWeekCard({ usage }) {
  const {
    tokenLimit,
    tokensUsed,
    remaining,
    overBudget,
    utilizationPct,
    inputTokens,
    outputTokens,
    costUsd,
    recordCount,
  } = usage;
  const noBudget = !tokenLimit || tokenLimit <= 0;
  return (
    <Card
      as="section"
      aria-label="This week"
      className={cn(overBudget && 'border-red-400/50 bg-red-500/5')}
    >
      <CardHeader className="border-b border-slate-800 bg-slate-900/50 p-0 px-4 py-2 sm:p-0 sm:px-4 sm:py-2">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-slate-400"
        >
          This week
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 pt-3 sm:p-4 sm:pt-3 md:grid-cols-2">
        {noBudget ? (
          <Stat
            label="Weekly limit"
            value={<span className="italic text-slate-500">no budget set</span>}
          />
        ) : (
          <Stat
            label="Tokens used"
            value={
              <span className={overBudget ? 'font-semibold text-red-400' : ''}>
                {formatTokens(tokensUsed)} / {formatTokens(tokenLimit)}
              </span>
            }
          />
        )}
        {!noBudget && (
          <Stat
            label="Utilisation"
            value={
              <span className={overBudget ? 'font-semibold text-red-400' : ''}>
                {utilizationPct != null ? `${utilizationPct}%` : '—'}
              </span>
            }
          />
        )}
        {!noBudget && (
          <Stat
            label={overBudget ? 'Exceeded by' : 'Remaining'}
            value={
              <span className="italic text-slate-500">
                {overBudget
                  ? `${formatTokens(tokensUsed - tokenLimit)} tokens`
                  : `${formatTokens(remaining)} tokens`}
              </span>
            }
          />
        )}
        <Stat label="Input tokens" value={formatTokens(inputTokens)} />
        <Stat label="Output tokens" value={formatTokens(outputTokens)} />
        <Stat label="Cost (USD)" value={`$${(Number(costUsd) || 0).toFixed(4)}`} />
        <Stat label="Records" value={recordCount} />
      </CardContent>
      {!noBudget ? (
        <CardContent className="p-4 pb-3 pt-0 sm:p-4 sm:pb-3 sm:pt-0">
          <ProgressBar value={utilizationPct ?? 0} danger={overBudget} />
        </CardContent>
      ) : null}
    </Card>
  );
}

/** @param {{ weeks: UsageWeek[], limit: number }} props */
function HistoryCard({ weeks, limit }) {
  if (!weeks || weeks.length === 0) {
    return (
      <Card
        as="section"
        aria-label="Weekly history"
      >
        <CardContent className="p-4 pt-4 text-sm italic text-slate-500 sm:p-4 sm:pt-4">
          No historical usage recorded yet.
        </CardContent>
      </Card>
    );
  }
  const peak = Math.max(
    ...weeks.map((w) => Number(w.totalTokens) || 0),
    limit || 0,
    1,
  );
  return (
    <Card as="section" aria-label="Weekly history">
      <CardHeader className="border-b border-slate-800 bg-slate-900/50 p-0 px-4 py-2 sm:p-0 sm:px-4 sm:py-2">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-slate-400"
        >
          Weekly history
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-3 sm:p-4 sm:pt-3">
        <ul role="list" className="flex flex-col gap-1">
          {weeks.map((week) => {
            const total = Number(week.totalTokens) || 0;
            const pct = Math.max(0, Math.min(100, (total / peak) * 100));
            const over = limit > 0 && total >= limit;
            return (
              <li
                key={week.weekMonday}
                className="grid grid-cols-[96px_1fr_auto] items-center gap-3 text-xs"
              >
                <time
                  className="tabular-nums text-slate-400"
                  dateTime={week.weekMonday}
                >
                  {week.weekMonday}
                </time>
                <div className="relative h-2 overflow-hidden rounded bg-slate-800">
                  <span
                    className={cn(
                      'absolute inset-y-0 left-0 rounded',
                      over ? 'bg-red-400' : 'bg-emerald-400/80',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span
                  className={cn(
                    'tabular-nums',
                    over ? 'font-semibold text-red-400' : 'text-slate-300',
                  )}
                >
                  {formatTokens(total)}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }) {
  return (
    <div className="flex flex-col text-sm">
      <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
        {label}
      </span>
      <span className="text-slate-100">{value}</span>
    </div>
  );
}

function ProgressBar({ value, danger }) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className="relative h-1.5 w-full overflow-hidden rounded bg-slate-800"
    >
      <span
        className={cn(
          'block h-full rounded transition-[width] duration-200',
          danger ? 'bg-red-400' : 'bg-emerald-400',
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

// ── Empty / loading / error ──────────────────────────────────────────

function UsageEmpty({ message }) {
  return (
    <Card
      className="border-dashed"
      data-page="agent-usage"
      data-state="empty"
    >
      <CardContent className="p-8 pt-8 text-center text-sm italic text-slate-400 sm:p-8 sm:pt-8">
        {message}
      </CardContent>
    </Card>
  );
}

function UsageSkeleton() {
  return (
    <Card
      role="status"
      aria-live="polite"
      className="animate-pulse border-slate-800"
      data-page="agent-usage"
      data-loading="true"
    >
      <CardContent className="p-4 pt-4 text-sm text-slate-500 sm:p-6 sm:pt-6">
        Loading usage…
      </CardContent>
    </Card>
  );
}

function UsageError({ error, onRetry }) {
  return (
    <Card
      role="alert"
      className="border-red-500/40 bg-red-500/10 text-red-200"
      data-page="agent-usage"
      data-error="true"
    >
      <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
        <CardTitle as="h2" className="text-sm text-red-100">
          Failed to load usage.
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0 sm:p-6 sm:pt-0">
        <p className="text-xs opacity-80">{error?.message || String(error)}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="self-start border-red-400/50 text-red-200 hover:bg-red-500/20"
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
    >
      <CardContent className="flex flex-wrap items-center gap-2 p-2.5 pt-2.5 text-xs sm:p-2.5 sm:pt-2.5">
        <span>
          Refresh failed ({error?.message || 'unknown error'}) — showing last-known
          data.
        </span>
        <Button
          variant="link"
          size="sm"
          onClick={onRetry}
          className="h-auto px-0 text-xs text-amber-200 underline decoration-dotted hover:decoration-solid"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function formatPausedReason(reason) {
  switch (reason) {
    case 'budget_exhausted':
      return 'budget exhausted';
    case 'subagent_missing':
      return 'subagent missing';
    case 'manual':
      return 'manual pause';
    default:
      return reason ? String(reason) : '';
  }
}

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}
