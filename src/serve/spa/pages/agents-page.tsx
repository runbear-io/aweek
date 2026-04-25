/**
 * `AgentsPage` — overview table of every agent on disk.
 *
 * Data contract (Sub-AC 3.3):
 *   Data is sourced _exclusively_ from `useAgents()`. This component
 *   does NOT accept agent data via props, does NOT read from
 *   `window.__INITIAL_DATA__` / `window.__aweek` / similar SSR-injected
 *   globals, and does NOT fall back to a server-rendered HTML fragment.
 *   The full lifecycle (initial load, re-load, abort, error) is owned by
 *   the hook + its underlying `resource-controller`.
 *
 * Props are UI-orchestration only:
 *   - `onSelectAgent(slug)` → parent router swap.
 *   - `baseUrl` / `fetch`    → test injection for the hook, not data.
 *
 * Baseline parity (per `src/skills/summary.js`'s terminal `renderTable`):
 *   Terminal columns: Agent | Goals | Tasks | Budget | Status.
 *   The web table drops the Goals column (goals live in free-form
 *   `plan.md` now and have no programmatic count) and keeps:
 *   Agent | Status | Tasks | Budget — plus a week header mirroring the
 *   terminal's "Week: 2026-Wnn (Monday: YYYY-MM-DD)" caption.
 *
 * Styling uses canonical shadcn/ui token utilities only — every colour
 * resolves to a theme token declared in `styles/globals.css` (`--foreground`,
 * `--muted-foreground`, `--destructive`, …) so light and dark modes
 * render correctly without per-palette overrides.
 *
 * TypeScript migration note (AC 101 sub-AC 1):
 *   This module was the first SPA page converted from `.jsx` → `.tsx`.
 *   shadcn/ui primitives in `../components/ui/*` remain `.jsx` for this
 *   migration phase. They are imported via `* as <Name>Module` and the
 *   exported components are re-aliased through permissive
 *   `React.ComponentType` casts. This is the "cross-boundary import
 *   shim" pattern the migration plan calls out for unconverted JSX
 *   modules — once those primitives are converted in a later sub-AC,
 *   the casts disappear and the real types take over.
 *
 * @module serve/spa/pages/agents-page
 */

import * as React from 'react';

import * as BadgeModule from '../components/ui/badge.jsx';
import * as ButtonModule from '../components/ui/button.jsx';
import * as CardModule from '../components/ui/card.jsx';
import * as TableModule from '../components/ui/table.jsx';
import { cn } from '../lib/cn.js';
import { useAgents } from '../hooks/use-agents.js';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────
//
// The primitives under `../components/ui/*` use `React.forwardRef` with
// destructured params and no JSDoc — TypeScript can't recover proper
// prop types from those files (it widens to `RefAttributes<any>`). The
// migration plan explicitly allows `.d.ts`/inline shims for this case;
// we re-alias each used primitive to a permissive `ComponentType` here.
// Once `components/ui/*` is converted in a later sub-AC, these casts
// can be deleted and the real types take over.

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
type TableProps = React.HTMLAttributes<HTMLTableElement>;
type TableSectionProps = React.HTMLAttributes<HTMLTableSectionElement>;
type TableRowProps = React.HTMLAttributes<HTMLTableRowElement>;
type TableCellProps = React.TdHTMLAttributes<HTMLTableCellElement>;
type TableHeadCellProps = React.ThHTMLAttributes<HTMLTableCellElement>;

const Badge = BadgeModule.Badge as React.ComponentType<BadgeProps>;
const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;
const Card = CardModule.Card as React.ComponentType<CardProps>;
const CardContent = CardModule.CardContent as React.ComponentType<CardSectionProps>;
const CardDescription = CardModule.CardDescription as React.ComponentType<CardDescriptionProps>;
const CardHeader = CardModule.CardHeader as React.ComponentType<CardSectionProps>;
const CardTitle = CardModule.CardTitle as React.ComponentType<CardTitleProps>;
const Table = TableModule.Table as React.ComponentType<TableProps>;
const TableBody = TableModule.TableBody as React.ComponentType<TableSectionProps>;
const TableCell = TableModule.TableCell as React.ComponentType<TableCellProps>;
const TableHead = TableModule.TableHead as React.ComponentType<TableHeadCellProps>;
const TableHeader = TableModule.TableHeader as React.ComponentType<TableSectionProps>;
const TableRow = TableModule.TableRow as React.ComponentType<TableRowProps>;

// ── Domain types ─────────────────────────────────────────────────────
//
// `AgentListRow` and `AgentStatus` are exported as JSDoc typedefs from
// the still-`.js` `api-client.js`. With `allowJs: true` in
// `tsconfig.spa.json`, TypeScript still reads JSDoc typedefs when a
// `.tsx` consumer imports them via `import('…').Type` style aliasing.
// Re-aliasing here keeps the JSDoc as the single source of truth.

type AgentListRow = import('../lib/api-client.js').AgentListRow;
type AgentStatus = import('../lib/api-client.js').AgentStatus;

/**
 * Per-agent issue surfaced by `gatherAgentsList` when an individual
 * agent JSON fails schema validation. Mirrors the inline shape declared
 * in `api-client.js`'s `fetchAgentsList` JSDoc.
 */
type AgentLoadIssue = { id: string; message: string };

export interface AgentsPageProps {
  /** Click handler that hands off the row's slug to the SPA router. */
  onSelectAgent?: (slug: string) => void;
  /** Override the default same-origin base URL used by the data hook. */
  baseUrl?: string;
  /** Inject a custom fetch impl (Storybook, tests, MSW). */
  fetch?: typeof fetch;
}

interface AgentsPageHeaderProps {
  count: number;
  week: string;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
}

interface AgentsTableProps {
  rows: AgentListRow[];
  onSelect?: (slug: string) => void;
}

interface AgentRowProps {
  row: AgentListRow;
  onSelect?: (slug: string) => void;
}

interface StatusBadgeProps {
  status: AgentStatus | string;
}

interface IssuesBannerProps {
  issues: AgentLoadIssue[];
}

interface ErrorBannerProps {
  error: Error | { message?: string } | null;
  onRetry: () => void | Promise<void>;
}

/**
 * Overview page. Consumes `useAgents` — no SSR/inline data injection.
 */
export function AgentsPage({
  onSelectAgent,
  baseUrl,
  fetch: fetchImpl,
}: AgentsPageProps = {}): React.ReactElement {
  // Hook owns the data. No `props.agents`, no `window.__*` fallback.
  const { data, error, loading, refresh } = useAgents({ baseUrl, fetch: fetchImpl });

  if (loading && !data) return <AgentsPageSkeleton />;
  if (error && !data) return <AgentsPageError error={error} onRetry={refresh} />;

  const agents: AgentListRow[] = data?.rows ?? [];
  const issues: AgentLoadIssue[] = data?.issues ?? [];
  // Every row in a given response shares the same `week` (the gatherer
  // derives it once from the configured time zone). Prefer the first row
  // but fall back to '—' on an empty list so the header copy is safe.
  const week = agents[0]?.week || '—';

  return (
    <section className="flex flex-col gap-4" data-page="agents">
      <AgentsPageHeader
        count={agents.length}
        week={week}
        loading={loading}
        onRefresh={refresh}
      />
      {error ? <StaleBanner error={error} onRetry={refresh} /> : null}
      {issues.length > 0 ? <IssuesBanner issues={issues} /> : null}
      {agents.length === 0 && issues.length === 0 ? (
        <AgentsPageEmpty />
      ) : agents.length === 0 ? null : (
        <AgentsTable rows={agents} onSelect={onSelectAgent} />
      )}
    </section>
  );
}

export default AgentsPage;

// ── Subcomponents ────────────────────────────────────────────────────

function AgentsPageHeader({
  count,
  week,
  loading,
  onRefresh,
}: AgentsPageHeaderProps): React.ReactElement {
  // The outer element is a native <header> so the landmark role "banner"
  // is exposed without an explicit `role=` (tests rely on
  // `getByRole('banner')`). The inner chrome is composed from shadcn/ui
  // Card primitives so the header reads as part of the same dashboard
  // surface family used by the rest of the SPA.
  return (
    <header>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle as="h1" className="text-base">
              Agents
            </CardTitle>
            <CardDescription className="text-xs">
              Week <span className="font-mono text-foreground">{week}</span> ·{' '}
              {count} agent{count === 1 ? '' : 's'} · read from{' '}
              <code>.aweek/</code>
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
 * The Overview table. Columns mirror the terminal `renderTable` in
 * `src/skills/summary.js` minus Goals (which no longer have a
 * programmatic count — see plan.md migration).
 */
function AgentsTable({ rows, onSelect }: AgentsTableProps): React.ReactElement {
  // The table is wrapped in a shadcn/ui Card so the Overview surface
  // reads as a single card panel (matching the sibling detail pages).
  // `CardContent` drops its default padding so the Table primitive can
  // manage its own rhythm — the table's internal wrapper already
  // handles horizontal overflow on narrow viewports.
  return (
    <Card>
      <CardContent className="p-0 sm:p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Tasks</TableHead>
              <TableHead className="text-right">Budget</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.slug}
                data-agent-slug={row.slug}
                data-href={onSelect ? `/agents/${row.slug}` : undefined}
                onClick={onSelect ? () => onSelect(row.slug) : undefined}
                onKeyDown={
                  onSelect
                    ? (event: React.KeyboardEvent<HTMLTableRowElement>) => {
                        // Enter/Space activate the row like a native link so
                        // keyboard users can reach /agents/:slug without a
                        // dedicated click target.
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect(row.slug);
                        }
                      }
                    : undefined
                }
                role={onSelect ? 'link' : undefined}
                tabIndex={onSelect ? 0 : undefined}
                className={cn(
                  onSelect && 'cursor-pointer focus-within:bg-muted/50',
                )}
              >
                <TableCell>
                  <AgentCell row={row} onSelect={onSelect} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <TasksCell row={row} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <BudgetCell row={row} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Agent name + slug + missing-subagent marker. When `onSelect` is wired
 * the name doubles as the row click target (row click is primary, but a
 * nested button keeps keyboard focus sane and announces "select agent"
 * to assistive tech).
 */
function AgentCell({ row, onSelect }: AgentRowProps): React.ReactElement {
  const name = (
    <span className="flex items-center gap-2">
      <span className="text-sm font-semibold text-foreground">{row.name}</span>
      {row.missing ? (
        <Badge variant="destructive">subagent missing</Badge>
      ) : null}
    </span>
  );
  return (
    <div className="flex flex-col gap-0.5">
      {onSelect ? (
        <Button
          variant="link"
          size="sm"
          onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            onSelect(row.slug);
          }}
          className="h-auto justify-start p-0 text-left text-foreground no-underline hover:underline focus:underline"
        >
          {name}
        </Button>
      ) : (
        name
      )}
      <div className="flex min-w-0 max-w-[520px] items-center gap-2 text-xs text-muted-foreground">
        <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px]">
          {row.slug}
        </code>
        {row.description ? (
          <span className="min-w-0 truncate">· {row.description}</span>
        ) : null}
      </div>
    </div>
  );
}

function StatusBadge({ status }: StatusBadgeProps): React.ReactElement {
  const label = statusLabel(status);
  // Map agent status onto stock shadcn Badge variants only. "active"
  // reads as the neutral default fill, "paused" as a muted outline, and
  // any destructive/unknown state as the destructive variant.
  const variant: ShadcnVariant =
    status === 'active'
      ? 'default'
      : status === 'paused'
        ? 'outline'
        : 'destructive';
  return (
    <Badge variant={variant} className="tracking-widest">
      {label}
    </Badge>
  );
}

function statusLabel(status: AgentStatus | string | undefined | null): string {
  if (status === 'active') return 'ACTIVE';
  if (status === 'paused') return 'PAUSED';
  if (status === 'budget-exhausted') return 'BUDGET EXHAUSTED';
  return String(status || 'UNKNOWN').toUpperCase();
}

/**
 * Tasks cell — mirrors `formatTasksCell` in `src/skills/summary.js`:
 *   "—"       when no plan (total === 0)
 *   "C/T"     otherwise, e.g. 2/5
 */
function TasksCell({ row }: { row: AgentListRow }): React.ReactElement {
  const total = Number(row.tasksTotal) || 0;
  if (total <= 0) {
    return <span className="italic text-muted-foreground">—</span>;
  }
  const completed = Number(row.tasksCompleted) || 0;
  return (
    <span className="text-sm text-foreground">
      {completed}
      <span className="text-muted-foreground">/{total}</span>
    </span>
  );
}

/**
 * Budget cell — mirrors `formatBudgetCell` in `src/skills/summary.js`:
 *   "no limit"               when tokenLimit is falsy
 *   "used / limit (pct%)"    otherwise; destructive when at/over limit.
 */
function BudgetCell({ row }: { row: AgentListRow }): React.ReactElement {
  if (!row.tokenLimit || row.tokenLimit <= 0) {
    return <span className="italic text-muted-foreground">no limit</span>;
  }
  const over = row.tokensUsed >= row.tokenLimit;
  const pct = row.utilizationPct != null ? `${row.utilizationPct}%` : '—';
  return (
    <span className={cn(over ? 'font-semibold text-destructive' : 'text-foreground')}>
      {formatTokens(row.tokensUsed)}
      <span className="text-muted-foreground"> / {formatTokens(row.tokenLimit)}</span>
      <span className="ml-1 text-xs text-muted-foreground">({pct})</span>
    </span>
  );
}

function AgentsPageEmpty(): React.ReactElement {
  // Wrap the empty-state copy in a shadcn/ui Card so the dashed-border
  // chrome comes from the same primitive family used for the populated
  // table. Keeping a Card (rather than a plain <div>) lets the Overview
  // surface maintain visual consistency whether or not agents exist.
  return (
    <Card className="border-dashed">
      <CardContent className="p-8 text-center text-sm italic text-muted-foreground">
        No agents yet. Run{' '}
        <code className="not-italic text-foreground">/aweek:hire</code> to create
        one.
      </CardContent>
    </Card>
  );
}

function AgentsPageSkeleton(): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-pulse text-sm text-muted-foreground"
      data-page="agents"
      data-loading="true"
    >
      Loading agents…
    </div>
  );
}

function AgentsPageError({ error, onRetry }: ErrorBannerProps): React.ReactElement {
  // Destructive-token Card communicates failure in the same chrome
  // family as the healthy Overview surface (rather than a bespoke div).
  // `role="alert"` is kept on the outer element so assistive tech picks
  // the banner up immediately and the existing test contract
  // (`screen.findByRole('alert')` + `data-error="true"`) keeps working.
  return (
    <Card
      role="alert"
      data-page="agents"
      data-error="true"
      className="border-destructive/40 bg-destructive/10 text-destructive"
    >
      <CardHeader className="space-y-1">
        <CardTitle as="h2" className="text-sm text-destructive">
          Failed to load agents.
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

/**
 * Surface per-agent load failures returned by `gatherAgentsList`. The
 * dashboard used to silently drop agents whose JSON failed schema
 * validation — a single bad file would wipe the whole table. Now
 * `listAllAgentsPartial` collects the failures and we render them here
 * so the user can see which slug went wrong and why.
 */
function IssuesBanner({ issues }: IssuesBannerProps): React.ReactElement {
  return (
    <Card role="alert" data-issues-banner="true" className="border-destructive/50">
      <CardContent className="flex flex-col gap-2 p-4 text-xs">
        <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
          ⚠ Could not load {issues.length} agent{issues.length === 1 ? '' : 's'}
        </div>
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue) => (
            <li key={issue.id || issue.message} className="flex min-w-0 gap-2">
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                {issue.id || '(unknown)'}
              </code>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground">
                {issue.message}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function StaleBanner({ error, onRetry }: ErrorBannerProps): React.ReactElement {
  // Neutral muted chrome for the "stale" callout — the stock shadcn
  // palette does not expose a warning token, so we use the muted
  // surface + outline border to signal "advisory, not destructive".
  return (
    <Card role="alert" className="bg-muted text-muted-foreground">
      <CardContent className="flex items-center gap-2 p-2.5 text-xs">
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

/** Compact token formatter (12_345 → "12.3k"). */
function formatTokens(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}
