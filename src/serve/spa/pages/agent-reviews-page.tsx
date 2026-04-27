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

// ── Markdown block model (mirrors agent-plan-page.tsx) ────────────────

type HeadingLevel = 1 | 2 | 3 | 4;
interface HeadingBlock { type: 'heading'; level: HeadingLevel; text: string }
interface ParagraphBlock { type: 'p'; text: string }
interface ListBlock { type: 'ul' | 'ol'; items: string[] }
interface QuoteBlock { type: 'quote'; children: MarkdownBlockNode[] }
interface CodeBlock { type: 'code'; lang: string; body: string }
type MarkdownBlockNode = HeadingBlock | ParagraphBlock | ListBlock | QuoteBlock | CodeBlock;

interface InlineToken {
  re: RegExp;
  build: (m: RegExpExecArray) => React.ReactNode;
}

function parseMarkdown(md: string): MarkdownBlockNode[] {
  if (typeof md !== 'string' || md.length === 0) return [];
  const stripped = md.replace(/<!--[\s\S]*?-->/g, '');
  const blocks: MarkdownBlockNode[] = [];
  const fenceRe = /```(\w*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(stripped)) !== null) {
    const before = stripped.slice(lastIndex, match.index);
    if (before.trim()) blocks.push(...parseBlocks(before));
    blocks.push({ type: 'code', lang: (match[1] || '').trim(), body: match[2] || '' });
    lastIndex = match.index + match[0].length;
  }
  const tail = stripped.slice(lastIndex);
  if (tail.trim()) blocks.push(...parseBlocks(tail));
  return blocks;
}

function parseBlocks(md: string): MarkdownBlockNode[] {
  const lines = md.split(/\r?\n/);
  const blocks: MarkdownBlockNode[] = [];
  let i = 0;
  const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
  const isUl = (l: string) => /^\s*[-*]\s+/.test(l);
  const isOl = (l: string) => /^\s*\d+\.\s+/.test(l);
  const isQuote = (l: string) => /^\s*>\s?/.test(l);
  const isBlank = (l: string) => /^\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) { i++; continue; }
    if (isHeading(line)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (m) blocks.push({ type: 'heading', level: Math.min(m[1]!.length, 4) as HeadingLevel, text: m[2] || '' });
      i++; continue;
    }
    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i] as string)) { items.push((lines[i] as string).replace(/^\s*[-*]\s+/, '')); i++; }
      blocks.push({ type: 'ul', items }); continue;
    }
    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i] as string)) { items.push((lines[i] as string).replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push({ type: 'ol', items }); continue;
    }
    if (isQuote(line)) {
      const quoted: string[] = [];
      while (i < lines.length && isQuote(lines[i] as string)) { quoted.push((lines[i] as string).replace(/^\s*>\s?/, '')); i++; }
      blocks.push({ type: 'quote', children: parseMarkdown(quoted.join('\n')) }); continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i] as string) && !isHeading(lines[i] as string) && !isUl(lines[i] as string) && !isOl(lines[i] as string) && !isQuote(lines[i] as string)) {
      para.push(lines[i] as string); i++;
    }
    if (para.length > 0) blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

function MarkdownBlock({ block }: { block: MarkdownBlockNode }): React.ReactElement | null {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4';
      return <Tag>{renderInline(block.text)}</Tag>;
    }
    case 'p': return <p>{renderInline(block.text)}</p>;
    case 'ul': return <ul>{block.items.map((t, i) => <li key={i}>{renderInline(t)}</li>)}</ul>;
    case 'ol': return <ol>{block.items.map((t, i) => <li key={i}>{renderInline(t)}</li>)}</ol>;
    case 'quote': return <blockquote>{block.children.map((c, i) => <MarkdownBlock key={i} block={c} />)}</blockquote>;
    case 'code': return <pre><code className={block.lang ? `language-${block.lang}` : undefined}>{block.body}</code></pre>;
    default: return null;
  }
}

function renderInline(text: string): React.ReactNode[] {
  if (!text) return [];
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tokens: InlineToken[] = [
      { re: /`([^`]+)`/, build: (m) => <code key={key++}>{m[1]}</code> },
      { re: /\[([^\]]+)\]\(([^)\s]+)\)/, build: (m) => <a key={key++} href={m[2]}>{m[1]}</a> },
      { re: /\*\*([^*\n]+?)\*\*/, build: (m) => <strong key={key++}>{m[1]}</strong> },
      { re: /(^|[^*])\*([^*\n]+?)\*(?!\*)/, build: (m) => <React.Fragment key={key++}>{m[1]}<em>{m[2]}</em></React.Fragment> },
    ];
    let earliest: { m: RegExpExecArray; build: InlineToken['build'] } | null = null;
    for (const tok of tokens) {
      const m = tok.re.exec(remaining);
      if (m && (earliest === null || m.index < earliest.m.index)) earliest = { m, build: tok.build };
    }
    if (!earliest) { if (remaining) nodes.push(remaining); break; }
    if (earliest.m.index > 0) nodes.push(remaining.slice(0, earliest.m.index));
    nodes.push(earliest.build(earliest.m));
    remaining = remaining.slice(earliest.m.index + earliest.m[0].length);
  }
  return nodes;
}

// ── Prop types ───────────────────────────────────────────────────────

export interface AgentReviewsPageProps {
  /** Agent slug — selects which agent's reviews the page loads. */
  slug: string;
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
}

// ── Component ────────────────────────────────────────────────────────

export function AgentReviewsPage({
  slug,
  baseUrl,
  fetch: fetchImpl,
}: AgentReviewsPageProps): React.ReactElement {
  const { data, error, loading, refresh } = useAgentReviews(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  // Local state: which review week is currently selected.
  const [selectedWeek, setSelectedWeek] = React.useState<string | null>(null);

  // Auto-select the first (newest) review when data arrives.
  React.useEffect(() => {
    if (data && data.reviews.length > 0 && selectedWeek === null) {
      setSelectedWeek(data.reviews[0].week);
    }
    // When slug changes reset selection.
    if (!data) setSelectedWeek(null);
  }, [data, slug]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const selectedEntry = data.reviews.find((r) => r.week === selectedWeek) ?? data.reviews[0];

  return (
    <section
      className="flex flex-col gap-4"
      data-page="agent-reviews"
      data-agent-slug={data.slug}
    >
      <ReviewsHeader data={data} loading={loading} onRefresh={refresh} />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      <div className="flex gap-4">
        {/* Left rail — week selector */}
        <aside className="w-48 shrink-0">
          <nav aria-label="Review weeks">
            <ul role="list" className="flex flex-col gap-1">
              {data.reviews.map((entry) => {
                const active = entry.week === selectedEntry.week;
                return (
                  <li key={entry.week}>
                    <Button
                      variant={active ? 'default' : 'ghost'}
                      size="sm"
                      className="w-full justify-start truncate font-mono text-xs"
                      onClick={() => setSelectedWeek(entry.week)}
                      aria-current={active ? 'true' : undefined}
                    >
                      {entry.week}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        {/* Right pane — markdown body */}
        <div className="min-w-0 flex-1">
          <ReviewBody entry={selectedEntry} />
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
    <header className="flex items-center justify-between border-b pb-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-semibold leading-none tracking-tight text-foreground">
          Reviews
        </h1>
        <p className="text-xs text-muted-foreground">
          <code>{data.slug}</code> · {data.reviews.length} review
          {data.reviews.length === 1 ? '' : 's'}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </Button>
    </header>
  );
}

interface ReviewBodyProps {
  entry: AgentReviewEntry;
}

function ReviewBody({ entry }: ReviewBodyProps): React.ReactElement {
  if (!entry.markdown) {
    return (
      <Card className="border-dashed" data-review-empty="true">
        <CardContent className="p-6 text-sm italic text-muted-foreground">
          No content for <code className="not-italic text-foreground">{entry.week}</code>.
        </CardContent>
      </Card>
    );
  }
  const blocks = parseMarkdown(entry.markdown);
  return (
    <Card data-review-body={entry.week}>
      <CardHeader className="space-y-0 border-b bg-muted/50 px-4 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {entry.week}
          {entry.generatedAt
            ? ` · ${new Date(entry.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`
            : ''}
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
        <article className="max-w-none text-sm leading-6 text-foreground" data-review-content="true">
          {blocks.map((block, idx) => (
            <MarkdownBlock key={idx} block={block} />
          ))}
        </article>
      </CardContent>
    </Card>
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
