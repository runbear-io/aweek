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
 * @module serve/spa/pages/agent-plan-page
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
import { useAgentPlan } from '../hooks/use-agent-plan.js';

/**
 * @typedef {import('../lib/api-client.js').AgentPlan} AgentPlan
 * @typedef {import('../lib/api-client.js').WeeklyPlan} WeeklyPlan
 */

/**
 * @param {{
 *   slug: string,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 * }} props
 * @returns {JSX.Element}
 */
export function AgentPlanPage({ slug, baseUrl, fetch: fetchImpl }) {
  const { data, error, loading, refresh } = useAgentPlan(slug, {
    baseUrl,
    fetch: fetchImpl,
  });

  if (!slug) return <PlanEmpty message="Select an agent to view its plan." />;
  if (loading && !data) return <PlanSkeleton />;
  if (error && error.status === 404)
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
      <WeeklyPlansList plan={data} />
    </section>
  );
}

export default AgentPlanPage;

// ── Subcomponents ────────────────────────────────────────────────────

/**
 * Strategy tab header. Uses a semantic `<header>` element so the
 * document outline (and the @testing-library `getByRole('banner')`
 * lookup in the component tests) stay meaningful.
 */
function PlanHeader({ plan, loading, onRefresh }) {
  // Outer <header> stays a native landmark so `getByRole('banner')`
  // still resolves in tests. Inner chrome uses a shadcn Card so the
  // Strategy header reads as part of the same dashboard surface family
  // used across the SPA (Overview table, Activity timeline, etc.).
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

/** @param {{ plan: AgentPlan }} props */
function PlanMarkdown({ plan }) {
  if (!plan.hasPlan) {
    return (
      <Card
        className="border-dashed"
        data-plan-empty="true"
      >
        <CardContent className="p-6 pt-6 text-sm italic text-muted-foreground sm:p-6 sm:pt-6">
          No <code className="not-italic text-foreground">plan.md</code> yet for{' '}
          <strong className="not-italic text-foreground">{plan.name}</strong>.
          Run <code className="not-italic text-foreground">/aweek:plan</code> to
          draft long-term goals, monthly plans, and strategies.
        </CardContent>
      </Card>
    );
  }
  const blocks = parseMarkdown(plan.markdown);
  return (
    <Card data-plan-card="markdown">
      <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
        <article
          className="max-w-none text-sm leading-6 text-foreground"
          data-plan-body="true"
        >
          {blocks.map((block, idx) => (
            <MarkdownBlock key={idx} block={block} />
          ))}
        </article>
      </CardContent>
    </Card>
  );
}

/** @param {{ plan: AgentPlan }} props */
function WeeklyPlansList({ plan }) {
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

/**
 * @param {{ week: WeeklyPlan, isLatestApproved: boolean }} props
 */
function WeeklyPlanRow({ week, isLatestApproved }) {
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

/**
 * Approval chip. Stock shadcn Badge only ships `default` /
 * `secondary` / `destructive` / `outline` variants (no `success`
 * /`warning`), so the approval state is communicated via tone:
 * solid `secondary` for approved weeks, hollow `outline` for
 * pending. Tests assert the text label (`approved` vs `pending`)
 * not the variant.
 */
function ApprovalBadge({ approved }) {
  return (
    <Badge
      variant={approved ? 'secondary' : 'outline'}
      className="tracking-widest"
    >
      {approved ? 'approved' : 'pending'}
    </Badge>
  );
}

// ── Markdown ─────────────────────────────────────────────────────────
//
// Minimal CommonMark subset rendered as React elements — escapes first,
// then applies inline/block transforms. Kept intentionally small until a
// full-fat markdown library (remark/marked) is wired in.

/**
 * @param {string} md
 * @returns {Array<object>}
 */
function parseMarkdown(md) {
  if (typeof md !== 'string' || md.length === 0) return [];
  const stripped = md.replace(/<!--[\s\S]*?-->/g, '');

  const blocks = [];
  const fenceRe = /```(\w*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fenceRe.exec(stripped)) !== null) {
    const before = stripped.slice(lastIndex, match.index);
    if (before.trim()) blocks.push(...parseBlocks(before));
    blocks.push({ type: 'code', lang: (match[1] || '').trim(), body: match[2] });
    lastIndex = match.index + match[0].length;
  }
  const tail = stripped.slice(lastIndex);
  if (tail.trim()) blocks.push(...parseBlocks(tail));
  return blocks;
}

function parseBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  const isHeading = (l) => /^#{1,6}\s+/.test(l);
  const isUl = (l) => /^\s*[-*]\s+/.test(l);
  const isOl = (l) => /^\s*\d+\.\s+/.test(l);
  const isQuote = (l) => /^\s*>\s?/.test(l);
  const isBlank = (l) => /^\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (isHeading(line)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      const level = Math.min(m[1].length, 4);
      blocks.push({ type: 'heading', level, text: m[2] });
      i += 1;
      continue;
    }
    if (isUl(line)) {
      const items = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (isOl(line)) {
      const items = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    if (isQuote(line)) {
      const quoted = [];
      while (i < lines.length && isQuote(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseMarkdown(quoted.join('\n')) });
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !isHeading(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !isQuote(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

function MarkdownBlock({ block }) {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}`;
      return <Tag>{renderInline(block.text)}</Tag>;
    }
    case 'p':
      return <p>{renderInline(block.text)}</p>;
    case 'ul':
      return (
        <ul>
          {block.items.map((t, i) => (
            <li key={i}>{renderInline(t)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol>
          {block.items.map((t, i) => (
            <li key={i}>{renderInline(t)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote>
          {block.children.map((child, i) => (
            <MarkdownBlock key={i} block={child} />
          ))}
        </blockquote>
      );
    case 'code':
      return (
        <pre>
          <code className={block.lang ? `language-${block.lang}` : undefined}>
            {block.body}
          </code>
        </pre>
      );
    default:
      return null;
  }
}

/**
 * Render a line of inline markdown safely. React escapes text children
 * by default so we only need to interpret structure (no manual HTML
 * escaping). Returns an array of React nodes.
 *
 * @param {string} text
 * @returns {Array<React.ReactNode>}
 */
function renderInline(text) {
  if (!text) return [];
  const nodes = [];
  let remaining = text;
  let key = 0;
  // Pattern order: inline code → link → bold → italic.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tokens = [
      { re: /`([^`]+)`/, build: (m) => <code key={key++}>{m[1]}</code> },
      {
        re: /\[([^\]]+)\]\(([^)\s]+)\)/,
        build: (m) => (
          <a key={key++} href={m[2]}>
            {m[1]}
          </a>
        ),
      },
      {
        re: /\*\*([^*\n]+?)\*\*/,
        build: (m) => <strong key={key++}>{m[1]}</strong>,
      },
      {
        re: /(^|[^*])\*([^*\n]+?)\*(?!\*)/,
        build: (m) => (
          <React.Fragment key={key++}>
            {m[1]}
            <em>{m[2]}</em>
          </React.Fragment>
        ),
      },
    ];
    let earliest = null;
    for (const tok of tokens) {
      const m = tok.re.exec(remaining);
      if (m && (earliest === null || m.index < earliest.m.index)) {
        earliest = { m, build: tok.build };
      }
    }
    if (!earliest) {
      if (remaining) nodes.push(remaining);
      break;
    }
    if (earliest.m.index > 0) nodes.push(remaining.slice(0, earliest.m.index));
    nodes.push(earliest.build(earliest.m));
    remaining = remaining.slice(earliest.m.index + earliest.m[0].length);
  }
  return nodes;
}

// ── Empty / loading / error ──────────────────────────────────────────

function PlanEmpty({ message }) {
  return (
    <Card
      className="border-dashed"
      data-page="agent-plan"
      data-state="empty"
    >
      <CardContent className="p-8 pt-8 text-center text-sm italic text-muted-foreground sm:p-8 sm:pt-8">
        {message}
      </CardContent>
    </Card>
  );
}

function PlanSkeleton() {
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

function PlanError({ error, onRetry }) {
  // Destructive-token Card communicates failure in the same chrome
  // family used by sibling pages (see `AgentsPageError`) — no
  // hardcoded `red-*` utilities, so the alert tones re-theme for free
  // under light/dark mode.
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

function StaleBanner({ error, onRetry }) {
  // Neutral muted chrome for the advisory "stale" callout — stock
  // shadcn has no warning token, so the banner uses `muted` surface
  // tones and leaves the destructive palette for real failures.
  return (
    <Card
      role="alert"
      className="bg-muted text-muted-foreground"
      data-plan-stale="true"
    >
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
