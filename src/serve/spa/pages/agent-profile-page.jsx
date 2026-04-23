/**
 * `AgentProfilePage` — per-agent profile tab.
 *
 * Data contract (Sub-AC 3.3):
 *   Identity / scheduling data is sourced from `useAgentProfile(slug)`.
 *   The Budget/Usage summary (Sub-AC 4) consumes the dedicated usage
 *   endpoint via `useAgentUsage(slug)` — this surfaces richer per-week
 *   detail (input/output token split, cost, records) from
 *   `src/serve/data/budget.js → gatherAgentUsage`, which is the single
 *   source of truth for weekly spend vs. budget. When the usage fetch
 *   is still in-flight or fails, the Budget card falls back to the
 *   summary fields already present on `AgentProfile` so the card never
 *   goes blank.
 *
 *   No `props.profile` / `props.usage`, no `window.__INITIAL_DATA__`,
 *   no SSR-rendered HTML fragment is read. Props exist only to wire
 *   navigation and test injection.
 *
 * Baseline parity (per `src/skills/status.js` + `src/skills/summary.js`):
 *   - Identity card (name, slug, description, identity file path)
 *   - System prompt card — live body of `.claude/agents/<slug>.md`
 *     (Sub-AC 5: the subagent's instructions are the single source of
 *     truth for what the agent does, so the dashboard surfaces them
 *     read-only alongside name + description)
 *   - Scheduling card (status + paused reason, createdAt, updatedAt,
 *     period start)
 *   - Budget card (Sub-AC 4) — week-of header, tokens used vs limit,
 *     utilization % with progress bar, remaining or exceeded-by, plus
 *     input/output token split and cost (USD) pulled from the usage
 *     endpoint.
 *   - Missing-subagent banner when `.claude/agents/<slug>.md` is absent
 *   - 404 maps to an "agent not found" empty state
 *
 * Styling uses canonical shadcn/ui token utilities only — every color
 * resolves to a theme token declared in `styles/globals.css`
 * (`--foreground`, `--muted-foreground`, `--destructive`, `--primary`,
 * …). No hardcoded palette classes are used, so light and dark modes
 * render correctly without per-palette overrides. Every card composes the shadcn `Card` family rendered as a
 * semantic `<section>` so the accessibility + test contract (cards must
 * be discoverable via `getAllByLabelText(...).find(tagName ===
 * 'SECTION')`) holds. Buttons use the shadcn `Button` primitive; only
 * stock Badge variants (`default`, `secondary`, `destructive`, `outline`)
 * are used.
 *
 * @module serve/spa/pages/agent-profile-page
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
import { useAgentProfile } from '../hooks/use-agent-profile.js';
import { useAgentUsage } from '../hooks/use-agent-usage.js';

/**
 * @typedef {import('../lib/api-client.js').AgentProfile} AgentProfile
 * @typedef {import('../lib/api-client.js').AgentUsage} AgentUsage
 */

/**
 * Per-agent profile page. Consumes `useAgentProfile` — no SSR/inline
 * data injection.
 *
 * @param {{
 *   slug: string,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 * @returns {JSX.Element}
 */
export function AgentProfilePage({ slug, baseUrl, fetch: fetchImpl }) {
  const { data, error, loading, refresh } = useAgentProfile(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  // Sub-AC 4: the Budget card on the Profile tab consumes the dedicated
  // usage endpoint (`/api/agents/:slug/usage`). This hook runs in
  // parallel with `useAgentProfile` so tab paint isn't blocked on the
  // usage fetch; the Budget card falls back to profile summary fields
  // while `usage` is null.
  const {
    data: usage,
    error: usageError,
    loading: usageLoading,
    refresh: refreshUsage,
  } = useAgentUsage(slug, { baseUrl, fetch: fetchImpl });

  if (!slug) return <ProfileEmpty message="Select an agent to view its profile." />;
  if (loading && !data) return <ProfileSkeleton />;
  if (error && error.status === 404)
    return <ProfileEmpty message={`No agent found for slug "${slug}".`} />;
  if (error && !data) return <ProfileError error={error} onRetry={refresh} />;
  if (!data) return <ProfileEmpty message={`No profile data for "${slug}".`} />;

  const handleRefresh = () => {
    refresh();
    refreshUsage();
  };

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-profile"
      data-agent-slug={data.slug}
    >
      <ProfileHeader profile={data} loading={loading} onRefresh={handleRefresh} />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      <IdentityCard profile={data} />
      <SystemPromptCard profile={data} />
      <SchedulingCard profile={data} />
      <BudgetCard
        profile={data}
        usage={usage}
        usageLoading={usageLoading}
        usageError={usageError}
        onRetryUsage={refreshUsage}
      />
    </section>
  );
}

export default AgentProfilePage;

// ── Cards ────────────────────────────────────────────────────────────

function ProfileHeader({ profile, loading, onRefresh }) {
  // The outer element is a native <header> so the landmark role "banner"
  // is exposed without an explicit `role=` attribute. Inner chrome is
  // composed from the shadcn/ui Card primitives so the header reads as
  // part of the same dashboard surface family as the rest of the SPA.
  return (
    <header>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle as="h1" className="text-base">
              {profile.name}
            </CardTitle>
            <CardDescription className="text-xs">
              <code>{profile.slug}</code>
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

/**
 * Small reusable card shell backed by shadcn primitives. Renders as a
 * semantic `<section>` with an `aria-label` so the card participates in
 * the accessibility tree and surfaces through
 * `getAllByLabelText(title)` in the component tests.
 *
 * @param {{
 *   title: string,
 *   accent?: 'danger',
 *   children: React.ReactNode,
 * }} props
 */
function ProfileCard({ title, accent, children }) {
  return (
    <Card
      as="section"
      aria-label={title}
      className={cn(
        accent === 'danger' && 'border-destructive/40 bg-destructive/5',
      )}
    >
      <CardHeader className="border-b bg-muted/50 p-0 px-4 py-2 sm:p-0 sm:px-4 sm:py-2">
        <CardTitle
          as="h2"
          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
        >
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-3 sm:p-4 sm:pt-3">
        {children}
      </CardContent>
    </Card>
  );
}

/** @param {{ profile: AgentProfile }} props */
function IdentityCard({ profile }) {
  return (
    <ProfileCard title="Identity">
      {profile.missing ? (
        <div
          role="alert"
          className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <strong className="font-semibold">Subagent file missing</strong> —{' '}
          <code>.claude/agents/{profile.slug}.md</code> was not found. Restore it or
          re-run <code>/aweek:hire</code>.
        </div>
      ) : null}
      <h3 className="text-base font-bold tracking-tight text-foreground">
        {profile.name}
      </h3>
      <Field label="Slug">
        <code className="text-xs">{profile.slug}</code>
      </Field>
      {profile.description ? (
        <p className="text-sm leading-6 text-foreground">{profile.description}</p>
      ) : null}
      {profile.identityPath ? (
        <Field label="File">
          <code className="text-xs break-all">{profile.identityPath}</code>
        </Field>
      ) : null}
    </ProfileCard>
  );
}

/**
 * System-prompt card — renders the live body of `.claude/agents/<slug>.md`
 * (the `systemPrompt` field on `AgentProfile`). The prompt is the single
 * source of truth for subagent behaviour, so the dashboard surfaces it
 * read-only alongside the frontmatter (name + description).
 *
 * @param {{ profile: AgentProfile }} props
 */
function SystemPromptCard({ profile }) {
  if (profile.missing) {
    return (
      <ProfileCard title="System prompt">
        <p className="text-sm italic text-muted-foreground">
          No system prompt to show — the subagent .md file is missing.
        </p>
      </ProfileCard>
    );
  }

  const prompt = profile.systemPrompt || '';
  return (
    <ProfileCard title="System prompt">
      {prompt.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">
          Empty — no system prompt is set in the subagent .md file.
        </p>
      ) : (
        <pre
          data-field="system-prompt"
          className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-3 font-mono text-xs leading-5 text-foreground"
        >
          {prompt}
        </pre>
      )}
    </ProfileCard>
  );
}

/** @param {{ profile: AgentProfile }} props */
function SchedulingCard({ profile }) {
  const statusLabel = profile.paused
    ? profile.pausedReason
      ? `paused (${formatPausedReason(profile.pausedReason)})`
      : 'paused'
    : 'active';
  // Map scheduling status onto the stock shadcn Badge variants.
  // "active" reads as the neutral default fill; "paused" as a muted
  // outline. No bespoke "success" / "warning" variants are used — see
  // `components/ui/badge.jsx` for the canonical variant list.
  const statusVariant = profile.paused ? 'outline' : 'default';

  return (
    <ProfileCard title="Scheduling">
      <Field label="Status">
        <Badge variant={statusVariant} className="tracking-widest">
          {statusLabel}
        </Badge>
      </Field>
      {profile.periodStart ? (
        <Field label="Period start">{formatDate(profile.periodStart)}</Field>
      ) : null}
      {profile.createdAt ? (
        <Field label="Created">{formatDate(profile.createdAt)}</Field>
      ) : null}
      {profile.updatedAt ? (
        <Field label="Updated">{formatDate(profile.updatedAt)}</Field>
      ) : null}
    </ProfileCard>
  );
}

/**
 * Budget / usage summary card (Sub-AC 4).
 *
 * @param {{
 *   profile: AgentProfile,
 *   usage: AgentUsage | null | undefined,
 *   usageLoading?: boolean,
 *   usageError?: Error | null,
 *   onRetryUsage?: () => void,
 * }} props
 */
function BudgetCard({ profile, usage, usageLoading, usageError, onRetryUsage }) {
  const source = usage || profile;
  const tokenLimit = source.tokenLimit ?? 0;
  const tokensUsed = source.tokensUsed ?? 0;
  const remaining = source.remaining ?? 0;
  const overBudget = !!source.overBudget;
  const utilizationPct = source.utilizationPct ?? null;
  const weekMonday = source.weekMonday || profile.weekMonday;

  const hasUsageBreakdown = !!usage;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const costUsd = Number(usage?.costUsd) || 0;
  const recordCount = usage?.recordCount ?? 0;

  const noBudget = !tokenLimit || tokenLimit <= 0;
  const showUsageStale = !!(usageError && usage);

  return (
    <ProfileCard title="Budget" accent={overBudget ? 'danger' : undefined}>
      {weekMonday ? (
        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          Week of <time dateTime={weekMonday}>{weekMonday}</time>
        </div>
      ) : null}

      {showUsageStale ? (
        <UsageStaleBanner error={usageError} onRetry={onRetryUsage} />
      ) : null}

      {noBudget ? (
        <>
          <Field label="Weekly limit">
            <span className="italic text-muted-foreground">no budget set</span>
          </Field>
          <Field label="Tokens used">{formatTokens(tokensUsed)}</Field>
        </>
      ) : (
        <>
          <Field label="Tokens used">
            <span className={overBudget ? 'font-semibold text-destructive' : ''}>
              {formatTokens(tokensUsed)} / {formatTokens(tokenLimit)}
              {overBudget ? (
                <Badge variant="destructive" className="ml-2 tracking-widest">
                  over budget
                </Badge>
              ) : null}
            </span>
          </Field>
          <Field label="Utilisation">
            <span className={overBudget ? 'font-semibold text-destructive' : ''}>
              {utilizationPct != null ? `${utilizationPct}%` : '—'}
            </span>
          </Field>
          <ProgressBar value={utilizationPct ?? 0} danger={overBudget} />
          <Field label={overBudget ? 'Exceeded by' : 'Remaining'}>
            <span className="italic text-muted-foreground">
              {overBudget
                ? `${formatTokens(tokensUsed - tokenLimit)} tokens`
                : `${formatTokens(remaining)} tokens`}
            </span>
          </Field>
        </>
      )}

      {hasUsageBreakdown ? (
        <div
          className="mt-2 border-t pt-3"
          data-field="usage-breakdown"
        >
          <Field label="Input tokens">{formatTokens(inputTokens)}</Field>
          <Field label="Output tokens">{formatTokens(outputTokens)}</Field>
          <Field label="Cost (USD)">${costUsd.toFixed(4)}</Field>
          <Field label="Records">{recordCount}</Field>
        </div>
      ) : usageLoading ? (
        <div
          className="mt-2 text-[11px] italic text-muted-foreground"
          data-field="usage-loading"
        >
          Loading usage details…
        </div>
      ) : usageError ? (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground"
          data-field="usage-error"
        >
          <span>
            Couldn&apos;t load usage breakdown ({usageError.message || 'unknown error'}).
          </span>
          {typeof onRetryUsage === 'function' ? (
            <Button
              variant="link"
              size="sm"
              onClick={onRetryUsage}
              className="h-auto px-0 text-[11px]"
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </ProfileCard>
  );
}

// ── Shared ───────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-baseline gap-2 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="break-all text-foreground">{children}</span>
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

function ProfileEmpty({ message }) {
  // Dashed-border Card keeps the empty state in the same chrome family
  // as the populated surface; muted tokens re-theme automatically for
  // light/dark mode via `styles/globals.css`.
  return (
    <Card
      className="border-dashed"
      data-page="agent-profile"
      data-state="empty"
    >
      <CardContent className="p-8 pt-8 text-center text-sm italic text-muted-foreground sm:p-8 sm:pt-8">
        {message}
      </CardContent>
    </Card>
  );
}

function ProfileSkeleton() {
  return (
    <Card
      role="status"
      aria-live="polite"
      className="animate-pulse"
      data-page="agent-profile"
      data-loading="true"
    >
      <CardContent className="p-4 pt-4 text-sm text-muted-foreground sm:p-6 sm:pt-6">
        Loading profile…
      </CardContent>
    </Card>
  );
}

function ProfileError({ error, onRetry }) {
  // Destructive-token Card communicates failure in the same chrome
  // family as the healthy profile surface (rather than a bespoke div).
  return (
    <Card
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive"
      data-page="agent-profile"
      data-error="true"
    >
      <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
        <CardTitle as="h2" className="text-sm text-destructive">
          Failed to load profile.
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0 sm:p-6 sm:pt-0">
        <p className="text-xs opacity-80">{error?.message || String(error)}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="self-start"
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }) {
  // Muted surface + outline border signals "advisory, not destructive".
  // The stock shadcn token palette does not expose a warning colour, so
  // the muted family (bg-muted/text-muted-foreground) re-themes cleanly
  // across light + dark modes.
  return (
    <Card role="alert" className="bg-muted text-muted-foreground">
      <CardContent className="flex flex-wrap items-center gap-2 p-2.5 pt-2.5 text-xs sm:p-2.5 sm:pt-2.5">
        <span>
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

/**
 * Stale-data banner scoped to the Budget card — shown when the usage
 * fetch failed but we have a previous successful payload so the card
 * keeps rendering numbers (stale) rather than going blank.
 */
function UsageStaleBanner({ error, onRetry }) {
  return (
    <div
      role="alert"
      className="mb-2 flex flex-wrap items-center gap-1 rounded-md border bg-muted px-2 py-1 text-[11px] text-muted-foreground"
    >
      <span>
        Usage refresh failed ({error?.message || 'unknown error'}) — showing last-known
        values.
      </span>
      {typeof onRetry === 'function' ? (
        <Button
          variant="link"
          size="sm"
          onClick={onRetry}
          className="h-auto px-0 text-[11px]"
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function formatPausedReason(reason) {
  switch (reason) {
    case 'budget_exhausted':
      return 'budget exhausted';
    case 'subagent_missing':
      return 'subagent missing';
    case 'manual':
      return 'manual';
    default:
      return reason ? String(reason) : '';
  }
}

function formatDate(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
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
