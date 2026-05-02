/**
 * `AgentReviewsPage` — per-agent weekly reviews tab.
 *
 * Data contract (Sub-AC 3.3):
 *   Data is sourced _exclusively_ from `useAgentReviews(slug)`. No
 *   `props.reviews`, no `window.__INITIAL_DATA__`, no SSR HTML reading.
 *
 * Layout:
 *   Left rail — week/date selector list (newest on top).
 *   Right pane — markdown body for the selected review rendered via the
 *     same `parseMarkdown` + `MarkdownBlock` helpers used in
 *     `agent-plan-page.tsx`.
 *
 * Empty state: "No reviews yet for this agent."
 *
 * @module serve/spa/pages/agent-reviews-page
 */

import * as React from 'react';

import * as ButtonModule from '../components/ui/button.jsx';
import * as CardModule from '../components/ui/card.jsx';
import { useAgentReviews } from '../hooks/use-agent-reviews.js';
import { Markdown } from '../lib/markdown.js';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────

type ButtonVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

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

const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;
const Card = CardModule.Card as React.ComponentType<CardProps>;
const CardContent = CardModule.CardContent as React.ComponentType<CardSectionProps>;
const CardDescription = CardModule.CardDescription as React.ComponentType<CardDescriptionProps>;
const CardHeader = CardModule.CardHeader as React.ComponentType<CardSectionProps>;
const CardTitle = CardModule.CardTitle as React.ComponentType<CardTitleProps>;

// ── Domain types ─────────────────────────────────────────────────────

type AgentReviews = import('../lib/api-client.js').AgentReviews;
type AgentReviewEntry = import('../lib/api-client.js').AgentReviewEntry;

/**
 * Frontmatter pair extracted from a review body's preamble.
 *
 * Reviews don't carry YAML frontmatter — the orchestrator writes a
 * block of `**Key:** value` lines between the H1 and the first
 * horizontal rule (see `weekly-review-orchestrator.ts`). We surface
 * that block as a structured table so users get the at-a-glance
 * metadata view instead of a wall of bold text.
 */
export interface FrontmatterEntry {
  key: string;
  value: string;
}

/**
 * Split a review body into its preamble metadata + remaining markdown.
 *
 * Preamble shape produced by the review pipeline:
 *
 *   # Daily Review: <slug> — <day>, <date>
 *
 *   **Date:** 2026-04-23 (Thursday)
 *   **Week:** 2026-W17
 *   **Agent:** content-writer
 *   **Generated:** 2026-04-24T00:00:40.055Z
 *
 *   ---
 *
 * Returns the H1 + the entries plus the rest of the body (everything
 * past the first `---` rule). Falls back to `{ entries: [], rest: md }`
 * when the markdown doesn't match the shape so unstructured reviews
 * still render unchanged.
 */
export function splitReviewPreamble(md: string): {
  title: string | null;
  entries: FrontmatterEntry[];
  rest: string;
} {
  if (typeof md !== 'string' || md.length === 0) {
    return { title: null, entries: [], rest: '' };
  }
  const lines = md.split(/\r?\n/);
  let i = 0;
  let title: string | null = null;
  while (i < lines.length && /^\s*$/.test(lines[i] as string)) i++;
  const headingMatch = /^#\s+(.+?)\s*$/.exec((lines[i] || '') as string);
  if (headingMatch) {
    title = headingMatch[1] ?? null;
    i++;
  }
  while (i < lines.length && /^\s*$/.test(lines[i] as string)) i++;
  const entries: FrontmatterEntry[] = [];
  const pairRe = /^\s*\*\*([^*]+?):\*\*\s*(.*)$/;
  while (i < lines.length) {
    const line = lines[i] as string;
    const m = pairRe.exec(line);
    if (!m) break;
    entries.push({ key: (m[1] || '').trim(), value: (m[2] || '').trim() });
    i++;
  }
  if (entries.length === 0) {
    return { title, entries: [], rest: title ? lines.slice(1).join('\n') : md };
  }
  while (i < lines.length && /^\s*$/.test(lines[i] as string)) i++;
  if (i < lines.length && /^\s*-{3,}\s*$/.test(lines[i] as string)) i++;
  const rest = lines.slice(i).join('\n');
  return { title, entries, rest };
}

// ── Prop types ───────────────────────────────────────────────────────

export interface AgentReviewsPageProps {
  /** Agent slug — selects which agent's reviews the page loads. */
  slug: string;
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
  /**
   * URL-driven review week (`"2026-W17"` or `"daily-2026-04-23"`). When
   * provided, the URL is the source of truth: clicking a different review
   * pushes a new URL through `onSelectWeek`. When omitted, the component
   * tracks selection in local state and auto-selects the newest review.
   */
  selectedWeek?: string | undefined;
  /**
   * Notify the parent router that the user picked a different review.
   * Pass `null` to clear the selection and fall back to the newest review.
   */
  onSelectWeek?: (week: string | null) => void;
}

// ── Component ────────────────────────────────────────────────────────

export function AgentReviewsPage({
  slug,
  baseUrl,
  fetch: fetchImpl,
  selectedWeek: urlSelectedWeek,
  onSelectWeek,
}: AgentReviewsPageProps): React.ReactElement {
  const { data, error, loading, refresh } = useAgentReviews(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  // Local state is used only when the parent doesn't push a URL-driven
  // selection. When `urlSelectedWeek` is provided the URL is the single
  // source of truth — clicking a different review pushes a new URL
  // through `onSelectWeek` instead of mutating local state.
  const urlDriven = urlSelectedWeek !== undefined;
  const [internalWeek, setInternalWeek] = React.useState<string | null>(null);

  // Auto-select the first (newest) review when data arrives, but only in
  // the local-state mode. URL-driven mode lets the URL stand alone — an
  // empty `:week` segment never reaches this component (the parent route
  // doesn't match an empty segment).
  React.useEffect(() => {
    if (urlDriven) return;
    if (data && data.reviews.length > 0 && internalWeek === null) {
      setInternalWeek(data.reviews[0].week);
    }
    if (!data) setInternalWeek(null);
  }, [data, slug, urlDriven]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!slug) return <ReviewsEmpty message="Select an agent to view reviews." />;
  if (loading && !data) return <ReviewsSkeleton />;

  const errorWithStatus = error as unknown as { status?: unknown } | null;
  const errorStatus =
    errorWithStatus && typeof errorWithStatus.status === 'number'
      ? errorWithStatus.status
      : null;
  if (error && errorStatus === 404)
    return <ReviewsEmpty message={`No agent found for slug "${slug}".`} />;
  if (error && !data) return <ReviewsError error={error} onRetry={refresh} />;
  if (!data || data.reviews.length === 0)
    return <ReviewsEmpty message="No reviews yet for this agent." />;

  const requestedWeek = urlDriven ? (urlSelectedWeek ?? null) : internalWeek;
  const matchedEntry =
    requestedWeek != null
      ? data.reviews.find((r) => r.week === requestedWeek)
      : null;

  // URL-driven mode + unknown week → "review not found" empty state.
  // The agent and the reviews tab still load; only the right pane shows
  // the not-found card so the user can click another week to recover.
  const notFound = urlDriven && requestedWeek != null && !matchedEntry;
  const selectedEntry = matchedEntry ?? data.reviews[0];

  const handleSelect = (next: string): void => {
    if (urlDriven) {
      if (typeof onSelectWeek === 'function') onSelectWeek(next);
    } else {
      setInternalWeek(next);
      if (typeof onSelectWeek === 'function') onSelectWeek(next);
    }
  };

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-reviews"
      data-agent-slug={data.slug}
    >
      <ReviewsHeader data={data} loading={loading} onRefresh={refresh} />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      {/*
        Mobile-first layout (Sub-AC 3.3): below `md` the rail stacks above
        the body as a horizontally-scrollable strip of week pills so the
        right pane reclaims the full viewport width (a fixed `w-48` rail
        in a 343 px usable area would leave only ~135 px for the body and
        force horizontal overflow inside the FrontmatterTable). Above `md`
        the canonical vertical sidebar is restored.
      */}
      <div className="flex flex-col gap-4 md:flex-row">
        {/* Left rail — week selector */}
        <aside className="w-full shrink-0 md:w-48">
          <nav aria-label="Review weeks">
            <ul
              role="list"
              className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-x-visible md:pb-0"
            >
              {data.reviews.map((entry) => {
                const active = !notFound && entry.week === selectedEntry.week;
                return (
                  <li key={entry.week} className="shrink-0 md:shrink">
                    <Button
                      variant={active ? 'default' : 'ghost'}
                      size="sm"
                      className="w-full shrink-0 justify-start whitespace-nowrap font-mono text-xs md:truncate md:whitespace-normal"
                      onClick={() => handleSelect(entry.week)}
                      aria-current={active ? 'true' : undefined}
                      data-review-week={entry.week}
                    >
                      {entry.week}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        {/* Right pane — markdown body or not-found state */}
        <div className="min-w-0 flex-1">
          {notFound && requestedWeek ? (
            <ReviewNotFound
              week={requestedWeek}
              slug={data.slug}
              onClear={onSelectWeek}
            />
          ) : (
            <ReviewBody entry={selectedEntry} agentSlug={data.slug} />
          )}
        </div>
      </div>
    </section>
  );
}

export default AgentReviewsPage;

// ── Sub-components ────────────────────────────────────────────────────

interface ReviewsHeaderProps {
  data: AgentReviews;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
}

function ReviewsHeader({ data, loading, onRefresh }: ReviewsHeaderProps): React.ReactElement {
  return (
    <header className="flex items-center justify-between gap-3 border-b pb-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-base font-semibold leading-none tracking-tight text-foreground">
          Reviews
        </h1>
        <p className="text-xs text-muted-foreground break-words">
          <code className="break-all">{data.slug}</code> · {data.reviews.length} review
          {data.reviews.length === 1 ? '' : 's'}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading} className="shrink-0">
        {loading ? 'Refreshing…' : 'Refresh'}
      </Button>
    </header>
  );
}

interface ReviewBodyProps {
  entry: AgentReviewEntry;
  /** Agent slug — used to build the permalink for the Copy link button. */
  agentSlug: string;
}

function ReviewBody({ entry, agentSlug }: ReviewBodyProps): React.ReactElement {
  if (!entry.markdown) {
    return (
      <Card className="border-dashed" data-review-empty="true">
        <CardContent className="p-6 text-sm italic text-muted-foreground">
          No content for <code className="not-italic text-foreground">{entry.week}</code>.
        </CardContent>
      </Card>
    );
  }
  const { title, entries, rest } = splitReviewPreamble(entry.markdown);
  return (
    <Card data-review-body={entry.week}>
      <CardHeader className="space-y-1 border-b bg-muted/50 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {entry.week}
              {entry.generatedAt
                ? ` · ${new Date(entry.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`
                : ''}
            </p>
            {title ? (
              <h1 className="text-base font-semibold leading-tight text-foreground break-words">
                {title}
              </h1>
            ) : null}
          </div>
          <CopyPermalinkButton agentSlug={agentSlug} week={entry.week} />
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
        {entries.length > 0 ? (
          <FrontmatterTable entries={entries} />
        ) : null}
        <article
          className="max-w-none text-sm leading-6 text-foreground"
          data-review-content="true"
        >
          <Markdown source={rest} />
        </article>
      </CardContent>
    </Card>
  );
}

interface CopyPermalinkButtonProps {
  agentSlug: string;
  week: string;
}

/**
 * Shareable-URL action for the active review.
 *
 * Builds the permalink from `window.location.origin` + the canonical
 * route shape (`/agents/<slug>/reviews/<week>`) so the copied link works
 * even when the user reached this view via the un-permalinked URL
 * (`/agents/:slug/reviews`). Falls back to the path-only string when
 * `window` is unavailable (SSR, tests without jsdom).
 */
function CopyPermalinkButton({
  agentSlug,
  week,
}: CopyPermalinkButtonProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const buildHref = (): string => {
    const path = `/agents/${encodeURIComponent(agentSlug)}/reviews/${encodeURIComponent(week)}`;
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin}${path}`;
    }
    return path;
  };
  const handleCopy = async (): Promise<void> => {
    const href = buildHref();
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(href);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard write can reject (insecure context, denied permission).
      // Swallow and let the user copy from the address bar.
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      data-review-copy-link="true"
      data-review-week={week}
      aria-label={`Copy permalink to review ${week}`}
    >
      {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}

interface ReviewNotFoundProps {
  week: string;
  slug: string;
  onClear?: (week: string | null) => void;
}

/**
 * Right-pane state when the URL points at a review that the loaded list
 * doesn't contain (e.g. stale link, deleted file, typo). The left rail
 * stays interactive so the user can pick a different week without going
 * back; this card just calls out the miss and offers a one-click reset.
 */
function ReviewNotFound({
  week,
  slug,
  onClear,
}: ReviewNotFoundProps): React.ReactElement {
  return (
    <Card
      className="border-dashed"
      data-page="agent-reviews"
      data-state="not-found"
      data-review-week={week}
    >
      <CardHeader className="space-y-1 p-6 text-center">
        <CardTitle as="h2" className="text-sm font-semibold text-foreground">
          Review not found.
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          No review exists at{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground">
            {week}
          </code>{' '}
          for{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground">
            {slug}
          </code>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center pt-0">
        {onClear ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onClear(null)}
            data-review-back="true"
          >
            Back to latest review
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface FrontmatterTableProps {
  entries: FrontmatterEntry[];
}

/**
 * Tabular render of the review's preamble metadata block. Stock shadcn
 * design tokens (`bg-muted`, `border-border`, `text-muted-foreground`)
 * so the table re-themes correctly in light + dark.
 */
function FrontmatterTable({
  entries,
}: FrontmatterTableProps): React.ReactElement {
  return (
    <div
      className="mb-4 overflow-hidden rounded-md border"
      data-review-frontmatter="true"
    >
      <table className="w-full text-xs">
        <tbody>
          {entries.map((entry, idx) => (
            <tr
              key={`${entry.key}-${idx}`}
              className="border-b last:border-b-0 even:bg-muted/30"
            >
              <th
                scope="row"
                className="w-24 px-2 py-1.5 text-left font-medium uppercase tracking-wider text-[10px] text-muted-foreground align-top break-words md:w-32 md:px-3"
              >
                {entry.key}
              </th>
              <td className="px-2 py-1.5 text-foreground tabular-nums break-all md:px-3 md:break-words">
                {entry.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface EmptyProps { message: string }
interface ErrorBannerProps { error: Error | { message?: string } | null; onRetry: () => void | Promise<void> }

function ReviewsEmpty({ message }: EmptyProps): React.ReactElement {
  return (
    <Card className="border-dashed" data-page="agent-reviews" data-state="empty">
      <CardHeader className="items-center p-8 text-center">
        <CardDescription className="text-sm italic">{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function ReviewsSkeleton(): React.ReactElement {
  return (
    <Card role="status" aria-live="polite" className="animate-pulse" data-page="agent-reviews" data-loading="true">
      <CardContent className="p-4 text-sm text-muted-foreground">
        Loading reviews…
      </CardContent>
    </Card>
  );
}

function ReviewsError({ error, onRetry }: ErrorBannerProps): React.ReactElement {
  return (
    <Card role="alert" className="border-destructive/40 bg-destructive/10 text-destructive" data-page="agent-reviews" data-error="true">
      <CardHeader className="space-y-1 p-4">
        <CardTitle as="h2" className="text-sm font-semibold leading-none text-destructive">
          Failed to load reviews.
        </CardTitle>
        <CardDescription className="text-xs text-destructive/80">
          {error?.message || String(error)}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }: ErrorBannerProps): React.ReactElement {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
      <span>Refresh failed ({error?.message || 'unknown error'}) — showing last-known data.</span>
      <Button type="button" onClick={onRetry} variant="link" size="sm" className="h-auto px-0 py-0 text-xs">
        Retry
      </Button>
    </div>
  );
}
