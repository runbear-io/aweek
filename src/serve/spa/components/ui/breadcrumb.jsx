/**
 * shadcn/ui Breadcrumb primitives (canonical markup).
 *
 * Vendored verbatim from shadcn/ui's reference implementation
 * (https://ui.shadcn.com/docs/components/breadcrumb). The public surface
 * mirrors the shadcn reference so a later swap to the upstream
 * `@shadcn/ui` CLI install will slot in without touching consumers:
 *
 *   Breadcrumb
 *     └── BreadcrumbList
 *           ├── BreadcrumbItem
 *           │     ├── BreadcrumbLink    (asChild → <Link>)
 *           │     └── BreadcrumbPage    (current segment, aria-current="page")
 *           └── BreadcrumbSeparator
 *
 * All colors resolve to the shadcn theme tokens declared in
 * `styles/globals.css` (`--muted-foreground`, `--foreground`) so the
 * component re-themes for free when the `.dark` class is toggled on
 * `<html>`.
 *
 * @module serve/spa/components/ui/breadcrumb
 */

import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { ChevronRight, MoreHorizontal } from 'lucide-react';

import { cn } from '../../lib/cn.js';

/**
 * Breadcrumb — outer `<nav>` landmark. Defaults to `aria-label="breadcrumb"`
 * so screen readers announce the trail correctly without extra wiring.
 */
export const Breadcrumb = React.forwardRef(function Breadcrumb(
  { ...props },
  ref,
) {
  return (
    <nav
      ref={ref}
      aria-label="breadcrumb"
      data-component="breadcrumb"
      {...props}
    />
  );
});

Breadcrumb.displayName = 'Breadcrumb';

/**
 * BreadcrumbList — ordered list of crumbs. Wraps items with
 * muted-foreground tone so the trail recedes against the page heading.
 */
export const BreadcrumbList = React.forwardRef(function BreadcrumbList(
  { className, ...props },
  ref,
) {
  return (
    <ol
      ref={ref}
      data-component="breadcrumb-list"
      className={cn(
        'flex flex-wrap items-center gap-1.5 break-words text-sm text-muted-foreground sm:gap-2.5',
        className,
      )}
      {...props}
    />
  );
});

BreadcrumbList.displayName = 'BreadcrumbList';

/**
 * BreadcrumbItem — individual crumb slot. Hosts either a
 * `BreadcrumbLink` (navigable segment) or a `BreadcrumbPage` (current).
 */
export const BreadcrumbItem = React.forwardRef(function BreadcrumbItem(
  { className, ...props },
  ref,
) {
  return (
    <li
      ref={ref}
      data-component="breadcrumb-item"
      className={cn('inline-flex items-center gap-1.5', className)}
      {...props}
    />
  );
});

BreadcrumbItem.displayName = 'BreadcrumbItem';

/**
 * BreadcrumbLink — navigable segment. Uses `Slot` via the `asChild`
 * prop so callers can delegate to a react-router `<Link>` (or any
 * element) while keeping the canonical styling.
 */
export const BreadcrumbLink = React.forwardRef(function BreadcrumbLink(
  { asChild, className, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      ref={ref}
      data-component="breadcrumb-link"
      className={cn('transition-colors hover:text-foreground', className)}
      {...props}
    />
  );
});

BreadcrumbLink.displayName = 'BreadcrumbLink';

/**
 * BreadcrumbPage — current segment. Not a link; `aria-current="page"`
 * marks the leaf so assistive tech announces the user's position.
 */
export const BreadcrumbPage = React.forwardRef(function BreadcrumbPage(
  { className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      role="link"
      aria-disabled="true"
      aria-current="page"
      data-component="breadcrumb-page"
      className={cn('font-normal text-foreground', className)}
      {...props}
    />
  );
});

BreadcrumbPage.displayName = 'BreadcrumbPage';

/**
 * BreadcrumbSeparator — visual divider between crumbs. Defaults to a
 * chevron icon; callers can pass `children` to override (e.g. `/`).
 * Hidden from assistive tech via `role="presentation"`.
 */
export function BreadcrumbSeparator({ children, className, ...props }) {
  return (
    <li
      role="presentation"
      aria-hidden="true"
      data-component="breadcrumb-separator"
      className={cn('[&>svg]:size-3.5', className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  );
}

BreadcrumbSeparator.displayName = 'BreadcrumbSeparator';

/**
 * BreadcrumbEllipsis — overflow marker for truncated trails. Not used
 * by the aweek detail page today (the trail is always three segments),
 * but shipped for parity with the upstream shadcn reference so future
 * callers don't have to re-vendor it.
 */
export function BreadcrumbEllipsis({ className, ...props }) {
  return (
    <span
      role="presentation"
      aria-hidden="true"
      data-component="breadcrumb-ellipsis"
      className={cn('flex h-9 w-9 items-center justify-center', className)}
      {...props}
    >
      <MoreHorizontal className="h-4 w-4" />
      <span className="sr-only">More</span>
    </span>
  );
}

BreadcrumbEllipsis.displayName = 'BreadcrumbEllipsis';

export default Breadcrumb;
