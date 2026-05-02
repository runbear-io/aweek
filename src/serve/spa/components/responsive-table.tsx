/**
 * `ResponsiveTable` — table-to-card adapter that swaps layouts at the
 * Tailwind `md` breakpoint (768px).
 *
 * Why this component exists (AC 40002, sub-AC 2):
 *   The dashboard SPA renders several columnar surfaces (`AgentsTable`,
 *   per-agent activity feeds, etc.) that read fine on a desktop viewport
 *   but overflow horizontally on a phone. Rather than maintain two parallel
 *   markups per page, this component takes a single column-definition +
 *   row-data shape and renders:
 *
 *   - **≥ 768px** — the canonical shadcn `Table` family, identical to the
 *     existing desktop UX so the visual baseline does not regress.
 *   - **< 768px** — a stacked list of shadcn `Card` panels, one per row,
 *     with each cell relabeled and stacked. Every clickable card meets a
 *     44 × 44 px minimum touch area (Apple HIG / WCAG 2.5.5 baseline).
 *
 * Why CSS-only responsive (`hidden md:block` / `md:hidden`) instead of
 * `useIsMobile` branching:
 *   - SSR-safe (no `window` access during render).
 *   - No hydration mismatch when the client first paints.
 *   - No layout flash on initial mount when the JS hook hasn't measured
 *     yet — both layouts are in the DOM, the browser hides one with CSS.
 *   - Matches the existing `Layout` shell, which already renders both the
 *     desktop `<AppSidebar>` and the mobile `<MobileAppSidebar>` Sheet
 *     unconditionally and lets CSS pick the visible one.
 *
 * Public API:
 *
 *   <ResponsiveTable
 *     columns={[
 *       { key: 'name', header: 'Agent', cell: (row) => row.name, primary: true },
 *       { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
 *       { key: 'tasks', header: 'Tasks', cell: (row) => `${row.done}/${row.total}`, headClassName: 'text-right' },
 *     ]}
 *     rows={agents}
 *     getRowKey={(row) => row.slug}
 *     onRowSelect={(row) => navigate(`/agents/${row.slug}`)}
 *     getRowAriaLabel={(row) => `Open ${row.name}`}
 *     emptyMessage="No agents yet."
 *   />
 *
 * Column-definition fields:
 *   - `key`            — stable React key + identifier for the column.
 *   - `header`         — table header content; reused as the mobile card
 *                        cell label unless `mobileLabel` is supplied.
 *   - `cell(row, idx)` — renderer that returns the cell content. The same
 *                        renderer is invoked for both desktop table cells
 *                        and mobile card cells so callers maintain one
 *                        shape.
 *   - `cellClassName`  — appended to the desktop `<td>` (e.g. text-right
 *                        for numeric columns).
 *   - `headClassName`  — appended to the desktop `<th>`.
 *   - `mobileLabel`    — overrides the header text in the mobile card; pass
 *                        `null` to hide the label entirely on mobile.
 *   - `primary`        — when true, the column renders as the card's
 *                        prominent title row (no label, larger text). Best
 *                        for the row's identity column (name, slug, etc.).
 *   - `hideOnMobile`   — when true, the column is omitted from mobile
 *                        cards entirely (still renders on desktop). Use
 *                        this for derived/secondary columns that would
 *                        bloat a card.
 *
 * Styling contract:
 *   Every colour / surface resolves to a shadcn theme token (`bg-card`,
 *   `text-muted-foreground`, `border-border`, …) so the component
 *   re-themes for free under `.dark`. No hardcoded slate / gray / zinc
 *   palette utilities.
 *
 * @module serve/spa/components/responsive-table
 */

import * as React from 'react';

import { cn } from '../lib/cn.js';
import * as CardModule from './ui/card.jsx';
import * as TableModule from './ui/table.jsx';

// ── Cross-boundary shims for still-`.jsx` shadcn/ui primitives ──────
//
// The primitives under `./ui/*` use `React.forwardRef` with destructured
// params and JSDoc — TypeScript can't recover proper prop types from
// those `.jsx` files. The migration plan explicitly allows `.d.ts` /
// inline shims for this case; we re-alias each used primitive to a
// permissive `ComponentType` here. Once `components/ui/*` is converted
// in a later sub-AC, these casts can be deleted.

// `Card` accepts an optional `as` override (canonical shadcn extension).
// When the caller passes `as="button"`, the rendered element is a real
// `<button>` and accepts the full `ButtonHTMLAttributes` surface (`type`,
// `disabled`, etc.). Widen the cast to the union of div + button props
// so consumers can flip between the two without a per-call cast.
type CardProps = React.HTMLAttributes<HTMLElement> &
  Partial<React.ButtonHTMLAttributes<HTMLButtonElement>> & {
    as?: React.ElementType;
  };
type CardSectionProps = React.HTMLAttributes<HTMLDivElement>;
type TableProps = React.HTMLAttributes<HTMLTableElement>;
type TableSectionProps = React.HTMLAttributes<HTMLTableSectionElement>;
type TableRowProps = React.HTMLAttributes<HTMLTableRowElement>;
type TableCellProps = React.TdHTMLAttributes<HTMLTableCellElement>;
type TableHeadCellProps = React.ThHTMLAttributes<HTMLTableCellElement>;
type TableCaptionProps = React.HTMLAttributes<HTMLTableCaptionElement>;

const Card = CardModule.Card as React.ComponentType<CardProps>;
const CardContent = CardModule.CardContent as React.ComponentType<CardSectionProps>;
const Table = TableModule.Table as React.ComponentType<TableProps>;
const TableBody = TableModule.TableBody as React.ComponentType<TableSectionProps>;
const TableCaption =
  TableModule.TableCaption as React.ComponentType<TableCaptionProps>;
const TableCell = TableModule.TableCell as React.ComponentType<TableCellProps>;
const TableHead = TableModule.TableHead as React.ComponentType<TableHeadCellProps>;
const TableHeader = TableModule.TableHeader as React.ComponentType<TableSectionProps>;
const TableRow = TableModule.TableRow as React.ComponentType<TableRowProps>;

// ── Public types ─────────────────────────────────────────────────────

/**
 * One column's definition. Generic `T` is the row shape.
 */
export interface ResponsiveTableColumn<T> {
  /** Stable identifier — used as the React key for the cell. */
  key: string;
  /** Header content — rendered in the desktop `<th>` and (by default) as
   *  the cell label in mobile cards. */
  header: React.ReactNode;
  /**
   * Cell renderer invoked for both desktop and mobile layouts. Receives
   * the row plus the row's zero-based index.
   */
  cell: (row: T, index: number) => React.ReactNode;
  /** Class names appended to the desktop `<td>`. */
  cellClassName?: string;
  /** Class names appended to the desktop `<th>`. */
  headClassName?: string;
  /**
   * Override for the mobile card cell label. Defaults to the column's
   * `header`. Pass `null` to hide the label entirely on mobile (the
   * cell value will render full-width without a label).
   */
  mobileLabel?: React.ReactNode;
  /**
   * When true, this column renders as the card's prominent title row
   * (no label, larger text). Best for the row's identity column.
   * At most one column should be marked `primary`; if multiple are, the
   * first one wins.
   */
  primary?: boolean;
  /**
   * When true, the column is omitted from mobile cards entirely (still
   * renders on desktop). Use for derived/secondary columns that would
   * bloat a small-screen card.
   */
  hideOnMobile?: boolean;
}

export interface ResponsiveTableProps<T> {
  /** Column definitions in display order. */
  columns: ReadonlyArray<ResponsiveTableColumn<T>>;
  /** Row data. */
  rows: ReadonlyArray<T>;
  /** Stable React key for each row. */
  getRowKey: (row: T, index: number) => string | number;
  /** Optional caption rendered below the desktop table (uses
   *  `<TableCaption>`); also rendered as a muted blurb above mobile
   *  cards so screen readers and small-screen users see the same context. */
  caption?: React.ReactNode;
  /** Empty-state content rendered when `rows.length === 0`. */
  emptyMessage?: React.ReactNode;
  /** Click handler — when supplied, every row becomes a focusable,
   *  Enter/Space-activatable target. */
  onRowSelect?: (row: T, index: number) => void;
  /** Per-row aria-label for click targets. */
  getRowAriaLabel?: (row: T, index: number) => string;
  /** Class names appended to the outer wrapper. */
  className?: string;
  /** Optional accessible label for the table — surfaced via `aria-label`. */
  ariaLabel?: string;
}

// ── Component ────────────────────────────────────────────────────────

/**
 * Render a responsive table that swaps to stacked cards below the
 * Tailwind `md` breakpoint (768px).
 *
 * The component is generic over the row shape so callers get full
 * type-safety on `cell(row)` and `getRowKey(row)` callbacks.
 */
export function ResponsiveTable<T>({
  columns,
  rows,
  getRowKey,
  caption,
  emptyMessage,
  onRowSelect,
  getRowAriaLabel,
  className,
  ariaLabel,
}: ResponsiveTableProps<T>): React.ReactElement {
  const isEmpty = rows.length === 0;

  return (
    <div
      data-component="responsive-table"
      data-row-count={rows.length}
      className={cn('w-full', className)}
    >
      {/* Desktop layout — visible from `md` (>= 768px). Hidden on mobile
          via Tailwind's `hidden` default + `md:block` override. The
          `block` class is fine on a wrapper because the inner
          `<Table>` primitive owns its own display rules. */}
      <div
        data-responsive-layout="desktop"
        className="hidden md:block"
      >
        {isEmpty ? (
          <ResponsiveTableEmpty>{emptyMessage}</ResponsiveTableEmpty>
        ) : (
          <Table aria-label={ariaLabel}>
            {caption ? <TableCaption>{caption}</TableCaption> : null}
            <TableHeader>
              <TableRow>
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    className={col.headClassName}
                    data-column-key={col.key}
                  >
                    {col.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => {
                const key = getRowKey(row, rowIndex);
                const clickable = typeof onRowSelect === 'function';
                const handleClick = clickable
                  ? () => onRowSelect?.(row, rowIndex)
                  : undefined;
                const handleKeyDown = clickable
                  ? (event: React.KeyboardEvent<HTMLTableRowElement>) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowSelect?.(row, rowIndex);
                      }
                    }
                  : undefined;
                return (
                  <TableRow
                    key={key}
                    data-row-key={String(key)}
                    role={clickable ? 'link' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-label={getRowAriaLabel?.(row, rowIndex)}
                    onClick={handleClick}
                    onKeyDown={handleKeyDown}
                    className={cn(
                      clickable &&
                        'cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none',
                    )}
                  >
                    {columns.map((col) => (
                      <TableCell
                        key={col.key}
                        className={col.cellClassName}
                        data-column-key={col.key}
                      >
                        {col.cell(row, rowIndex)}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Mobile layout — stacked cards visible below `md` (< 768px).
          Hidden at `md` and above so the desktop table takes over. */}
      <div
        data-responsive-layout="mobile"
        className="flex flex-col gap-3 md:hidden"
        role="list"
        aria-label={ariaLabel}
      >
        {caption ? (
          <p className="text-xs text-muted-foreground">{caption}</p>
        ) : null}
        {isEmpty ? (
          <ResponsiveTableEmpty>{emptyMessage}</ResponsiveTableEmpty>
        ) : (
          rows.map((row, rowIndex) => {
            const key = getRowKey(row, rowIndex);
            return (
              <ResponsiveTableMobileCard
                key={key}
                row={row}
                rowIndex={rowIndex}
                rowKey={key}
                columns={columns}
                onRowSelect={onRowSelect}
                ariaLabel={getRowAriaLabel?.(row, rowIndex)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

export default ResponsiveTable;

// ── Mobile card ──────────────────────────────────────────────────────

interface ResponsiveTableMobileCardProps<T> {
  row: T;
  rowIndex: number;
  rowKey: string | number;
  columns: ReadonlyArray<ResponsiveTableColumn<T>>;
  onRowSelect?: (row: T, index: number) => void;
  ariaLabel?: string;
}

/**
 * One mobile-card row. Renders columns as label/value pairs; the
 * `primary` column (if any) is promoted to the card's title row.
 * Clickable when `onRowSelect` is supplied — the card becomes a
 * native `<button>` so keyboard focus + Enter/Space work for free, with
 * a guaranteed 44 px minimum touch area to satisfy WCAG 2.5.5.
 */
function ResponsiveTableMobileCard<T>({
  row,
  rowIndex,
  rowKey,
  columns,
  onRowSelect,
  ariaLabel,
}: ResponsiveTableMobileCardProps<T>): React.ReactElement {
  // First column flagged `primary` becomes the card title; all other
  // visible columns render as label/value rows below. Columns flagged
  // `hideOnMobile` are skipped entirely.
  const visibleColumns = columns.filter((c) => !c.hideOnMobile);
  const primaryIndex = visibleColumns.findIndex((c) => c.primary);
  const primaryColumn = primaryIndex >= 0 ? visibleColumns[primaryIndex] : null;
  const detailColumns =
    primaryIndex >= 0
      ? visibleColumns.filter((_c, idx) => idx !== primaryIndex)
      : visibleColumns;

  const clickable = typeof onRowSelect === 'function';

  // Inner content shared by the clickable and read-only variants. The
  // outer element changes from a `<div>` to a `<button>` based on
  // whether the row is selectable, so screen-reader semantics match the
  // visible affordance.
  const inner = (
    <CardContent
      // Drop default padding so we control rhythm; `min-h-[44px]`
      // guarantees the WCAG 2.5.5 minimum touch target even on rows
      // with a single-line value (e.g. a status badge).
      className="flex min-h-[44px] flex-col gap-2 p-4"
    >
      {primaryColumn ? (
        <div
          className="text-sm font-semibold text-foreground"
          data-mobile-cell="primary"
          data-column-key={primaryColumn.key}
        >
          {primaryColumn.cell(row, rowIndex)}
        </div>
      ) : null}
      {detailColumns.length > 0 ? (
        <dl className="flex flex-col gap-1.5">
          {detailColumns.map((col) => {
            // `mobileLabel === null` collapses the label entirely;
            // otherwise it falls back to the canonical column header.
            const label =
              col.mobileLabel !== undefined ? col.mobileLabel : col.header;
            return (
              <div
                key={col.key}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs"
                data-mobile-cell="detail"
                data-column-key={col.key}
              >
                {label !== null ? (
                  <dt className="text-muted-foreground">{label}</dt>
                ) : null}
                <dd
                  className={cn(
                    'min-w-0 break-words text-foreground',
                    label === null ? 'w-full' : 'text-right',
                  )}
                >
                  {col.cell(row, rowIndex)}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </CardContent>
  );

  if (clickable) {
    return (
      <Card
        as="button"
        type="button"
        // 44 × 44 px is the documented WCAG 2.5.5 / Apple HIG minimum
        // touch area; the inner `min-h-[44px]` on `CardContent` already
        // covers vertical, but mirroring it on the outer button keeps
        // the hit area predictable when extra padding shifts.
        className="block min-h-[44px] w-full cursor-pointer text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-mobile-card-key={String(rowKey)}
        data-clickable="true"
        role="listitem"
        aria-label={ariaLabel}
        onClick={() => onRowSelect?.(row, rowIndex)}
      >
        {inner}
      </Card>
    );
  }

  return (
    <Card
      data-mobile-card-key={String(rowKey)}
      role="listitem"
      aria-label={ariaLabel}
      className="min-h-[44px]"
    >
      {inner}
    </Card>
  );
}

// ── Empty state ──────────────────────────────────────────────────────

interface ResponsiveTableEmptyProps {
  children?: React.ReactNode;
}

function ResponsiveTableEmpty({
  children,
}: ResponsiveTableEmptyProps): React.ReactElement {
  return (
    <Card className="border-dashed" data-responsive-empty="true">
      <CardContent className="p-6 text-center text-sm italic text-muted-foreground">
        {children || 'No rows to display.'}
      </CardContent>
    </Card>
  );
}
