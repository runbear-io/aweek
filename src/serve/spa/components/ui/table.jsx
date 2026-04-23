/**
 * shadcn/ui Table primitives — canonical reference implementation.
 *
 * This is the vendored, dependency-free version of the official
 * shadcn/ui `table` component (https://ui.shadcn.com/docs/components/table).
 * The public surface is byte-identical to the reference so a future
 * `shadcn@latest add table` install can drop in without changes:
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
 * Styling uses only shadcn theme tokens resolved by
 * `tailwind.config.js` → `globals.css` custom properties:
 *
 *   - `border-border` (implicit via the `* { @apply border-border }`
 *      base reset in `globals.css`, so `border-b` / `border-t` on the
 *      table primitives picks the themed colour automatically)
 *   - `bg-muted`, `bg-muted/50` for selected-row and footer tints
 *   - `text-muted-foreground` for muted chrome (column headers, caption)
 *
 * No hardcoded slate/gray/zinc palette classes anywhere — both light
 * and dark modes derive from the `--*` tokens declared on `:root` and
 * `.dark` in `globals.css`.
 *
 * Each primitive forwards `ref` and spreads extra props so shadcn's
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
 * Wrapping in an overflow-auto div keeps wide tables readable on
 * narrow viewports without forcing the whole dashboard into horizontal
 * overflow.
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
 * `<thead>` — every descendant `<tr>` gets a bottom border so the
 * header row reads as a separator above the body.
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
 * `<tfoot>` — muted fill for totals / summary rows.
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
        'border-t bg-muted/50 font-medium [&>tr]:last:border-b-0',
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
        'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
});

/**
 * Column header cell. `text-muted-foreground` matches the canonical
 * shadcn chrome — the actual hue comes from the themed `--muted-foreground`
 * token so light and dark modes render correctly without per-mode overrides.
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
        'h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
});

/**
 * Body cell. Uses canonical shadcn padding so budget / token numbers
 * have breathing room. Inherits colour from the parent `text-foreground`
 * body rule declared in `globals.css`.
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
        'p-4 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
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
      className={cn('mt-4 text-sm text-muted-foreground', className)}
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
