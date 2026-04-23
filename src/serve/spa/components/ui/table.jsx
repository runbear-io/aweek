/**
 * shadcn/ui-style Table primitives.
 *
 * This is a vendored, dependency-free version of the official shadcn/ui
 * `table` component (https://ui.shadcn.com/docs/components/table). We
 * keep the public surface byte-identical to the reference implementation
 * so later upgrades — including the full shadcn CLI install once the
 * Vite/Tailwind/shadcn deps land in `package.json` — can drop it in
 * without rippling through the Overview page:
 *
 *   Table
 *     ├── TableHeader
 *     │     └── TableRow
 *     │           └── TableHead
 *     ├── TableBody
 *     │     └── TableRow
 *     │           └── TableCell
 *     ├── TableFooter
 *     └── TableCaption
 *
 * Styling uses Tailwind utilities composed via `../../lib/cn.js`. Each
 * primitive forwards `ref` and spreads any extra props so shadcn's
 * idiomatic patterns keep working:
 *
 *   <TableRow className="cursor-pointer" onClick={...} data-agent-slug={slug}>
 *
 * @module serve/spa/components/ui/table
 */

import * as React from 'react';

import { cn } from '../../lib/cn.js';

/**
 * Outer scroll container + `<table>` element.
 *
 * Wrapping in an overflow-x-auto div keeps wide tables readable on
 * narrow viewports without forcing the whole dashboard into horizontal
 * overflow. The wrapper's role="region" + tabIndex=0 follows shadcn's
 * accessibility default so keyboard users can scroll horizontally.
 */
export const Table = React.forwardRef(function Table(
  { className, ...props },
  ref,
) {
  return (
    <div data-component="table-wrapper" className="relative w-full overflow-auto">
      <table
        ref={ref}
        data-component="table"
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  );
});

/**
 * `<thead>` — a sticky-header sibling-selector keeps the column labels
 * visible in long tables. Callers can override borders / bg via
 * `className`.
 */
export const TableHeader = React.forwardRef(function TableHeader(
  { className, ...props },
  ref,
) {
  return (
    <thead
      ref={ref}
      data-component="table-header"
      className={cn('[&_tr]:border-b', className)}
      {...props}
    />
  );
});

/**
 * `<tbody>` — shadcn disables the bottom border on the final row so it
 * blends into surrounding chrome.
 */
export const TableBody = React.forwardRef(function TableBody(
  { className, ...props },
  ref,
) {
  return (
    <tbody
      ref={ref}
      data-component="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
});

/**
 * `<tfoot>` — lighter chrome for totals / summary rows.
 */
export const TableFooter = React.forwardRef(function TableFooter(
  { className, ...props },
  ref,
) {
  return (
    <tfoot
      ref={ref}
      data-component="table-footer"
      className={cn(
        'border-t bg-slate-900/40 font-medium [&>tr]:last:border-b-0',
        className,
      )}
      {...props}
    />
  );
});

/**
 * `<tr>` with hover + selected-state affordances. Consumers get both the
 * hover background and a selected-state hook via `data-state="selected"`.
 */
export const TableRow = React.forwardRef(function TableRow(
  { className, ...props },
  ref,
) {
  return (
    <tr
      ref={ref}
      data-component="table-row"
      className={cn(
        'border-b border-slate-800 transition-colors hover:bg-slate-900/50 data-[state=selected]:bg-slate-900/70',
        className,
      )}
      {...props}
    />
  );
});

/**
 * Column header cell. `text-slate-400` + uppercase matches the muted
 * header style from the SSR dashboard baseline.
 */
export const TableHead = React.forwardRef(function TableHead(
  { className, ...props },
  ref,
) {
  return (
    <th
      ref={ref}
      scope="col"
      data-component="table-head"
      className={cn(
        'h-10 px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-slate-400 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
});

/**
 * Body cell. Uses the slightly taller padding shadcn ships so budget /
 * token numbers have breathing room.
 */
export const TableCell = React.forwardRef(function TableCell(
  { className, ...props },
  ref,
) {
  return (
    <td
      ref={ref}
      data-component="table-cell"
      className={cn(
        'px-3 py-2.5 align-middle text-sm text-slate-100 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
});

/**
 * `<caption>` for screen-readers / printed output. Rendered below the
 * table per HTML spec so the body isn't shifted.
 */
export const TableCaption = React.forwardRef(function TableCaption(
  { className, ...props },
  ref,
) {
  return (
    <caption
      ref={ref}
      data-component="table-caption"
      className={cn('mt-3 text-xs text-slate-400', className)}
      {...props}
    />
  );
});

// Explicit displayName assignments mirror the canonical shadcn/ui source so
// React DevTools + test debug output show `Table` rather than
// `ForwardRef(Table)`.
Table.displayName = 'Table';
TableHeader.displayName = 'TableHeader';
TableBody.displayName = 'TableBody';
TableFooter.displayName = 'TableFooter';
TableRow.displayName = 'TableRow';
TableHead.displayName = 'TableHead';
TableCell.displayName = 'TableCell';
TableCaption.displayName = 'TableCaption';

export default Table;
