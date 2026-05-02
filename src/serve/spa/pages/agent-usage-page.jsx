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
 * Styling uses canonical shadcn/ui token utilities only — every colour
 * resolves to a theme token declared in `styles/globals.css`
 * (`--foreground`, `--muted-foreground`, `--destructive`, `--primary`, …)
 * so light and dark modes render correctly without per-palette overrides.
 * Every card on this page is composed from the shadcn `Card` family
 * (`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`).
 * Buttons use the shadcn `Button` primitive.
 *
 * @module serve/spa/pages/agent-usage-page
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
  // The outer element is a native <header> so the landmark role "banner"
  // is exposed without an explicit `role=`. The inner chrome is composed
  // from shadcn/ui Card primitives so the header reads as part of the
  // same dashboard surface family used by the rest of the SPA.
  return (
    <header>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle as="h1" className="text-base">
              {usage.name} — Budget
            </CardTitle>
            <CardDescription className="text-xs">
              <code className="font-mono text-foreground">{usage.slug}</code> ·
              week of{' '}
              <time dateTime={usage.weekMonday} className="tabular-nums">
                {usage.weekMonday}
              </time>
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </CardHeader>
      </Card>
    </header>
  );
}

function PausedBanner({ usage }) {
  // Neutral muted chrome — the stock shadcn palette does not expose a
  // warning token, so the "advisory" paused state uses the muted surface
  // (parity with the stale-data banner below).
  return (
    <Card role="alert" className="bg-muted text-muted-foreground">
      <CardContent className="p-3 text-sm">
        <strong className="font-semibold uppercase tracking-wider text-foreground">
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
      className={cn(overBudget && 'border-destructive/40 bg-destructive/5')}
    >
      <CardHeader className="border-b bg-muted/50 px-4 py-2 space-y-0">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
        >
          This week
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 md:grid-cols-2">
        {noBudget ? (
          <Stat
            label="Weekly limit"
            value={<span className="italic text-muted-foreground">no budget set</span>}
          />
        ) : (
          <Stat
            label="Tokens used"
            value={
              <span className={overBudget ? 'font-semibold text-destructive' : ''}>
                {formatTokens(tokensUsed)} / {formatTokens(tokenLimit)}
              </span>
            }
          />
        )}
        {!noBudget && (
          <Stat
            label="Utilisation"
            value={
              <span className={overBudget ? 'font-semibold text-destructive' : ''}>
                {utilizationPct != null ? `${utilizationPct}%` : '—'}
              </span>
            }
          />
        )}
        {!noBudget && (
          <Stat
            label={overBudget ? 'Exceeded by' : 'Remaining'}
            value={
              <span className="italic text-muted-foreground">
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
        <CardContent className="px-4 pb-3 pt-0">
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
      <Card as="section" aria-label="Weekly history">
        <CardContent className="p-4 text-sm italic text-muted-foreground">
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
      <CardHeader className="border-b bg-muted/50 px-4 py-2 space-y-0">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Weekly history
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4">
        <ul role="list" className="flex flex-col gap-1">
          {weeks.map((week) => {
            const total = Number(week.totalTokens) || 0;
            const pct = Math.max(0, Math.min(100, (total / peak) * 100));
            const over = limit > 0 && total >= limit;
            return (
              <li
                key={week.weekMonday}
                data-component="usage-week-row"
                // Mobile (<768px): stack the date as a header row, then
                // bar + total share a second row. Treats each weekly
                // entry as a stacked card row instead of a tight 3-column
                // table line that crops the bar on a 375px viewport.
                // Desktop (>=md): re-collapses to the canonical
                // [96px_1fr_auto] grid via `md:contents` on the inner
                // wrapper so the bar and total become direct grid
                // children of the <li> grid.
                className="flex flex-col gap-1 text-xs md:grid md:grid-cols-[96px_1fr_auto] md:items-center md:gap-3"
              >
                <time
                  className="tabular-nums text-muted-foreground"
                  dateTime={week.weekMonday}
                >
                  {week.weekMonday}
                </time>
                <div className="flex items-center gap-3 md:contents">
                  <div className="relative h-2 flex-1 overflow-hidden rounded bg-muted">
                    <span
                      className={cn(
                        'absolute inset-y-0 left-0 rounded',
                        over ? 'bg-destructive' : 'bg-primary',
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      'shrink-0 tabular-nums',
                      over
                        ? 'font-semibold text-destructive'
                        : 'text-foreground',
                    )}
                  >
                    {formatTokens(total)}
                  </span>
                </div>
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
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-foreground">{value}</span>
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
      className="relative h-1.5 w-full overflow-hidden rounded bg-muted"
    >
      <span
        className={cn(
          'block h-full rounded transition-[width] duration-200',
          danger ? 'bg-destructive' : 'bg-primary',
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
      <CardContent className="p-8 text-center text-sm italic text-muted-foreground">
        {message}
      </CardContent>
    </Card>
  );
}

function UsageSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-pulse text-sm text-muted-foreground"
      data-page="agent-usage"
      data-loading="true"
    >
      Loading usage…
    </div>
  );
}

function UsageError({ error, onRetry }) {
  // Destructive-token Card communicates failure in the same chrome family
  // as the healthy usage surface. Mirrors `AgentsPageError` so the alert
  // re-themes cleanly via the `--destructive` token in light + dark modes.
  return (
    <Card
      role="alert"
      data-page="agent-usage"
      data-error="true"
      className="border-destructive/40 bg-destructive/10 text-destructive"
    >
      <CardHeader className="space-y-1">
        <CardTitle as="h2" className="text-sm text-destructive">
          Failed to load usage.
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

function StaleBanner({ error, onRetry }) {
  // Neutral muted chrome for the "stale" callout — the stock shadcn
  // palette does not expose a warning token, so we use the muted surface
  // to signal "advisory, not destructive" (parity with `agents-page.jsx`).
  //
  // Sub-AC 8.4: `flex-wrap` lets the Retry button drop to a second line
  // instead of forcing the message past the 375px viewport when the
  // upstream error message is long. `break-words` on the message span
  // additionally clips opaque tokens (e.g. URLs in error chains) at any
  // glyph boundary so a single long word can't blow out the card width.
  return (
    <Card role="alert" className="bg-muted text-muted-foreground">
      <CardContent className="flex flex-wrap items-center gap-2 p-2.5 text-xs">
        <span className="break-words">
          Refresh failed ({error?.message || 'unknown error'}) — showing last-known
          data.
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
