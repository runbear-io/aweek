/**
 * `AgentPlanPage` — per-agent plan.md + weekly plans tab.
 *
 * Data contract (Sub-AC 3.3):
 *   Data is sourced _exclusively_ from `useAgentPlan(slug)`. No
 *   `props.plan`, no `props.markdown`, no `window.__INITIAL_DATA__`,
 *   no reading of server-rendered HTML. Props exist only for
 *   navigation and test injection.
 *
 * Baseline parity (per `src/skills/plan.js` + plan.md source of truth):
 *   - Renders plan.md as formatted markdown
 *   - Surfaces structured weekly plans with approval state + task counts
 *   - Highlights the latest approved weekly plan
 *   - Empty state guides the operator to `/aweek:plan`
 *
 * Markdown rendering: a conservative CommonMark subset applied on the
 * client. We escape all user content before any transformation so a
 * malicious plan.md cannot inject markup. A full-fat markdown library
 * lands when the Vite build picks up `remark`/`marked`; for now the
 * subset covers the canonical plan.md structure (H1–H4, lists, code,
 * bold/italic, links, blockquotes).
 *
 * Styling: composed entirely from stock shadcn/ui primitives
 * (`Badge`, `Button`, `Card`, `CardHeader`, `CardTitle`,
 * `CardDescription`, `CardContent`). Every colour/surface class
 * resolves to a shadcn theme token declared in `styles/globals.css`
 * (`--foreground`, `--muted-foreground`, `--card`, `--destructive`,
 * …) — no hardcoded palette utilities — so the page re-themes for
 * both light and dark modes without per-palette overrides. Approval/latest-approved state is communicated via the
 * canonical Badge variants (`default` / `secondary` / `outline`)
 * rather than bespoke `success`/`warning` variants that don't exist
 * in stock shadcn.
 *
 * TypeScript migration note (AC 103 sub-AC 3):
 *   Converted from `.jsx` → `.tsx` as part of the per-tab page
 *   conversion sweep. shadcn/ui primitives in `../components/ui/*`
 *   remain `.jsx` for this migration phase, so each used primitive is
 *   re-aliased through a permissive `React.ComponentType` cast.
 *
 * @module serve/spa/pages/agent-plan-page
 */

import * as React from 'react';

import * as BadgeModule from '../components/ui/badge.jsx';
import * as ButtonModule from '../components/ui/button.jsx';
import * as CardModule from '../components/ui/card.jsx';
import { useAgentPlan } from '../hooks/use-agent-plan.js';
import { Markdown } from '../lib/markdown.js';

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

const Badge = BadgeModule.Badge as React.ComponentType<BadgeProps>;
const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;
const Card = CardModule.Card as React.ComponentType<CardProps>;
const CardContent = CardModule.CardContent as React.ComponentType<CardSectionProps>;
const CardDescription =
  CardModule.CardDescription as React.ComponentType<CardDescriptionProps>;
const CardHeader = CardModule.CardHeader as React.ComponentType<CardSectionProps>;
const CardTitle = CardModule.CardTitle as React.ComponentType<CardTitleProps>;

// ── Domain types ────────────────────────────────────────────────────

type AgentPlan = import('../lib/api-client.js').AgentPlan;
type WeeklyPlan = import('../lib/api-client.js').WeeklyPlan;
type AgentStrategyEntry = import('../lib/api-client.js').AgentStrategyEntry;

export interface AgentPlanPageProps {
  /** Agent slug — selects which agent's plan the page loads. */
  slug: string;
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
}

interface PlanHeaderProps {
  plan: AgentPlan;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
}

interface PlanSectionProps {
  plan: AgentPlan;
}

interface WeeklyPlanRowProps {
  week: WeeklyPlan;
  isLatestApproved: boolean;
}

interface WatchlistSectionProps {
  watchlist: { hasWatchlist: boolean; markdown: string };
}

interface StrategiesSectionProps {
  strategies: AgentStrategyEntry[];
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

/**
 * Per-agent plan page. Consumes `useAgentPlan` — no SSR/inline data
 * injection.
 */
export function AgentPlanPage({
  slug,
  baseUrl,
  fetch: fetchImpl,
}: AgentPlanPageProps): React.ReactElement {
  const { data, error, loading, refresh } = useAgentPlan(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  if (!slug) return <PlanEmpty message="Select an agent to view its plan." />;
  if (loading && !data) return <PlanSkeleton />;
  // `useAgentPlan` widens `error` to `Error | null`; the api-client throws
  // an `ApiError` subclass that carries a `.status` field. Read it through
  // a structural cast so the 404 short-circuit doesn't require importing
  // the class here.
  const errorWithStatus = error as unknown as { status?: unknown } | null;
  const errorStatus =
    errorWithStatus && typeof errorWithStatus.status === 'number'
      ? errorWithStatus.status
      : null;
  if (error && errorStatus === 404)
    return <PlanEmpty message={`No agent found for slug "${slug}".`} />;
  if (error && !data) return <PlanError error={error} onRetry={refresh} />;
  if (!data) return <PlanEmpty message={`No plan data for "${slug}".`} />;

  return (
    <section
      className="flex flex-col gap-6"
      data-page="agent-plan"
      data-agent-slug={data.slug}
    >
      <PlanHeader plan={data} loading={loading} onRefresh={refresh} />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      <PlanMarkdown plan={data} />
      {data.watchlist?.hasWatchlist ? <WatchlistSection watchlist={data.watchlist} /> : null}
      {data.strategies && data.strategies.length > 0 ? <StrategiesSection strategies={data.strategies} /> : null}
      <WeeklyPlansList plan={data} />
    </section>
  );
}

export default AgentPlanPage;

// ── Subcomponents ────────────────────────────────────────────────────

function PlanHeader({
  plan,
  loading,
  onRefresh,
}: PlanHeaderProps): React.ReactElement {
  return (
    <header data-plan-header="true">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle as="h1" className="text-base">
              {plan.name} — Plan
            </CardTitle>
            <CardDescription className="text-xs">
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                {plan.slug}
              </code>{' '}
              · {plan.weeklyPlans.length} weekly plan
              {plan.weeklyPlans.length === 1 ? '' : 's'}
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

function PlanMarkdown({ plan }: PlanSectionProps): React.ReactElement {
  if (!plan.hasPlan) {
    return (
      <Card className="border-dashed" data-plan-empty="true">
        <CardContent className="p-6 pt-6 text-sm italic text-muted-foreground sm:p-6 sm:pt-6">
          No <code className="not-italic text-foreground">plan.md</code> yet for{' '}
          <strong className="not-italic text-foreground">{plan.name}</strong>.
          Run <code className="not-italic text-foreground">/aweek:plan</code> to
          draft long-term goals, monthly plans, and strategies.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-plan-card="markdown">
      <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
        <article
          className="max-w-none text-sm leading-6 text-foreground"
          data-plan-body="true"
        >
          <Markdown source={plan.markdown} />
        </article>
      </CardContent>
    </Card>
  );
}

function WeeklyPlansList({ plan }: PlanSectionProps): React.ReactElement | null {
  if (!plan.weeklyPlans || plan.weeklyPlans.length === 0) return null;
  return (
    <Card data-plan-card="weekly">
      <CardHeader className="pb-2">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Weekly plans
        </CardTitle>
        <CardDescription className="text-xs">
          {plan.weeklyPlans.length} plan
          {plan.weeklyPlans.length === 1 ? '' : 's'} on disk
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
        <ul role="list" className="flex flex-col gap-2">
          {plan.weeklyPlans.map((week) => (
            <WeeklyPlanRow
              key={week.week}
              week={week}
              isLatestApproved={plan.latestApproved?.week === week.week}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function WeeklyPlanRow({
  week,
  isLatestApproved,
}: WeeklyPlanRowProps): React.ReactElement {
  return (
    <li
      data-week={week.week}
      className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-3">
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold text-foreground">
          {week.week}
        </code>
        {isLatestApproved ? (
          <Badge variant="default" className="tracking-widest">
            latest approved
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {(week.tasks || []).length} task
          {(week.tasks || []).length === 1 ? '' : 's'}
        </span>
      </div>
      <ApprovalBadge approved={!!week.approved} />
    </li>
  );
}

function ApprovalBadge({ approved }: ApprovalBadgeProps): React.ReactElement {
  return (
    <Badge
      variant={approved ? 'secondary' : 'outline'}
      className="tracking-widest"
    >
      {approved ? 'approved' : 'pending'}
    </Badge>
  );
}

// ── Watchlist ─────────────────────────────────────────────────────────

function WatchlistSection({ watchlist }: WatchlistSectionProps): React.ReactElement {
  return (
    <Card data-plan-card="watchlist">
      <CardHeader className="pb-2">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Watchlist
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
        <article className="max-w-none text-sm leading-6 text-foreground" data-watchlist-body="true">
          <Markdown source={watchlist.markdown} />
        </article>
      </CardContent>
    </Card>
  );
}

// ── Strategies ────────────────────────────────────────────────────────

function StrategiesSection({ strategies }: StrategiesSectionProps): React.ReactElement {
  return (
    <Card data-plan-card="strategies">
      <CardHeader className="pb-2">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Strategies
        </CardTitle>
        <CardDescription className="text-xs">
          {strategies.length} strategy document{strategies.length === 1 ? '' : 's'}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
        <div className="flex flex-col gap-4">
          {strategies.map((strategy) => (
            <details
              key={strategy.name}
              className="group rounded-md border bg-muted/40"
              data-strategy-name={strategy.name}
            >
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-foreground">
                {strategy.name}
              </summary>
              <div className="border-t px-3 py-3">
                <article className="max-w-none text-sm leading-6 text-foreground">
                  <Markdown source={strategy.markdown} />
                </article>
              </div>
            </details>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Empty / loading / error ──────────────────────────────────────────

function PlanEmpty({ message }: EmptyProps): React.ReactElement {
  return (
    <Card className="border-dashed" data-page="agent-plan" data-state="empty">
      <CardContent className="p-8 pt-8 text-center text-sm italic text-muted-foreground sm:p-8 sm:pt-8">
        {message}
      </CardContent>
    </Card>
  );
}

function PlanSkeleton(): React.ReactElement {
  return (
    <Card
      role="status"
      aria-live="polite"
      className="animate-pulse"
      data-page="agent-plan"
      data-loading="true"
    >
      <CardContent className="p-4 pt-4 text-sm text-muted-foreground sm:p-6 sm:pt-6">
        Loading plan…
      </CardContent>
    </Card>
  );
}

function PlanError({ error, onRetry }: ErrorBannerProps): React.ReactElement {
  return (
    <Card
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive"
      data-page="agent-plan"
      data-error="true"
    >
      <CardHeader className="p-4 pb-1 sm:p-6 sm:pb-2">
        <CardTitle as="h2" className="text-sm text-destructive">
          Failed to load plan.
        </CardTitle>
        <CardDescription className="text-xs text-destructive/80">
          {error?.message || String(error)}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-2 sm:p-6 sm:pt-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }: ErrorBannerProps): React.ReactElement {
  return (
    <Card role="alert" className="bg-muted text-muted-foreground" data-plan-stale="true">
      <CardContent className="flex flex-wrap items-center gap-2 p-2.5 pt-2.5 text-xs sm:p-2.5 sm:pt-2.5">
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
