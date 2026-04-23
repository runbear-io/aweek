/**
 * shadcn/ui-style Card primitives.
 *
 * Dependency-free vendored implementation of shadcn/ui's `card`
 * component family (https://ui.shadcn.com/docs/components/card). The
 * public surface mirrors the shadcn reference so later upgrades — e.g.
 * dropping in the official `@shadcn/ui` CLI install once the SPA is
 * fully bootstrapped — slot in without touching consumers:
 *
 *   Card
 *     ├── CardHeader
 *     │     ├── CardTitle
 *     │     └── CardDescription
 *     ├── CardContent
 *     └── CardFooter
 *
 * Cards are used throughout the SPA (dashboard stats, agent summary
 * panels, form containers) so the palette matches the surrounding
 * chrome — slate-800 border, slate-900/40 background, slate-100/200
 * text — per the shared dark dashboard tokens.
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
        'rounded-lg border border-slate-800 bg-slate-900/40 text-slate-100 shadow-sm',
        className,
      )}
      {...props}
    />
  );
});

/**
 * CardHeader — top slot for titles + optional trailing actions. Stacks
 * `CardTitle` + `CardDescription` with a 1.5 gap.
 */
export const CardHeader = React.forwardRef(function CardHeader(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="card-header"
      className={cn('flex flex-col gap-1.5 p-4 sm:p-6', className)}
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
        'text-base font-semibold leading-tight tracking-tight text-slate-100',
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
      className={cn('text-sm text-slate-400', className)}
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
      className={cn('p-4 pt-0 sm:p-6 sm:pt-0', className)}
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
      className={cn('flex items-center gap-2 p-4 pt-0 sm:p-6 sm:pt-0', className)}
      {...props}
    />
  );
});

export default Card;
