/**
 * shadcn/ui Card primitives.
 *
 * Canonical shadcn/ui `card` component family
 * (https://ui.shadcn.com/docs/components/card). The public surface
 * mirrors the shadcn reference so later upgrades — e.g. dropping in
 * the official `@shadcn/ui` CLI install once the SPA is fully
 * bootstrapped — slot in without touching consumers:
 *
 *   Card
 *     ├── CardHeader
 *     │     ├── CardTitle
 *     │     └── CardDescription
 *     ├── CardContent
 *     └── CardFooter
 *
 * All colour/surface styling goes through shadcn theme tokens
 * (`bg-card`, `text-card-foreground`, `border`, `text-muted-foreground`)
 * so the same markup renders correctly in both light and dark themes
 * by toggling the `.dark` class on `<html>`.
 *
 * @module serve/spa/components/ui/card
 */

import React from 'react';

import { cn } from '../../lib/cn.js';

/**
 * Card — outer container. Default padding lives on the children
 * (`CardHeader` / `CardContent` / `CardFooter`) so callers can compose
 * partial cards without extra wrappers.
 *
 * The `as` prop lets a caller swap the underlying tag (e.g. `as="section"`
 * when an `aria-label` is supplied so the card participates in the
 * document outline). Defaults to `<div>` for backwards compatibility
 * with the canonical shadcn/ui reference.
 */
export const Card = React.forwardRef(function Card(
  { className, as: Component = 'div', ...props },
  ref,
) {
  return (
    <Component
      ref={ref}
      data-component="card"
      className={cn(
        'rounded-lg border bg-card text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
});

/**
 * CardHeader — top slot for titles + optional trailing actions. Stacks
 * `CardTitle` + `CardDescription` with canonical shadcn spacing.
 */
export const CardHeader = React.forwardRef(function CardHeader(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="card-header"
      className={cn('flex flex-col space-y-1.5 p-6', className)}
      {...props}
    />
  );
});

/**
 * CardTitle — semantic heading rendered as an `<h3>` by default so the
 * document outline stays readable. Callers can override via `as` if a
 * different level is needed for a deeper card in a section.
 */
export const CardTitle = React.forwardRef(function CardTitle(
  { className, as: Component = 'h3', ...props },
  ref,
) {
  return (
    <Component
      ref={ref}
      data-component="card-title"
      className={cn(
        'text-2xl font-semibold leading-none tracking-tight',
        className,
      )}
      {...props}
    />
  );
});

/**
 * CardDescription — muted caption text paired with `CardTitle`.
 */
export const CardDescription = React.forwardRef(function CardDescription(
  { className, ...props },
  ref,
) {
  return (
    <p
      ref={ref}
      data-component="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
});

/**
 * CardContent — main content slot. Matches the header's horizontal
 * padding; drops top padding so it sits flush with the header.
 */
export const CardContent = React.forwardRef(function CardContent(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="card-content"
      className={cn('p-6 pt-0', className)}
      {...props}
    />
  );
});

/**
 * CardFooter — bottom slot for actions. Defaults to a horizontal
 * flex row so primary / secondary buttons line up without wrappers.
 */
export const CardFooter = React.forwardRef(function CardFooter(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="card-footer"
      className={cn('flex items-center p-6 pt-0', className)}
      {...props}
    />
  );
});

export default Card;
