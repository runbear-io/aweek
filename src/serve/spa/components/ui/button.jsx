/**
 * shadcn/ui-style Button primitive.
 *
 * Dependency-free vendored implementation of shadcn/ui's `button`
 * component (https://ui.shadcn.com/docs/components/button). The public
 * surface mirrors the shadcn reference — a `buttonVariants` factory
 * exposing `variant` / `size` options plus a default `<Button>` export —
 * so consumers can drop the official Radix/CVA build in later without
 * touching call sites.
 *
 * Styling uses Tailwind utilities composed via `../../lib/cn.js`. The
 * palette (sky-500 primary, slate-900 secondary, transparent ghost)
 * matches the chrome used by the `Nav`, `Tabs`, and `Table` primitives so
 * the dashboard reads as a single visual family.
 *
 * Usage:
 *
 *   <Button variant="primary">Save</Button>
 *   <Button variant="outline" size="sm">Cancel</Button>
 *   <Button variant="ghost" disabled>…</Button>
 *
 * Accessibility:
 *   - Forwards `ref` so forms that want to programmatically focus a
 *     submit button (e.g. after validation failure) can do so.
 *   - `type` defaults to `"button"` to avoid accidental form submission
 *     when rendered inside a `<form>` — matches the shadcn default.
 *   - `disabled` flips pointer events off and drops opacity to 50 % per
 *     the shadcn baseline.
 *
 * @module serve/spa/components/ui/button
 */

import React from 'react';

import { cn } from '../../lib/cn.js';

/**
 * Allowed visual variants. Names match shadcn's reference so upgrades
 * don't require a codemod.
 * @typedef {'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link'} ButtonVariant
 */

/**
 * Allowed size tokens. `default` is the canonical 36 px control; `sm` is
 * used for dense toolbars and table row actions; `lg` for full-width
 * primary CTAs; `icon` is a square control for single-glyph buttons.
 * @typedef {'default' | 'sm' | 'lg' | 'icon'} ButtonSize
 */

/** @type {Record<ButtonVariant, string>} */
const VARIANT_CLASSES = {
  primary:
    'border border-sky-400/60 bg-sky-500/90 text-slate-950 hover:bg-sky-400 focus-visible:ring-sky-400/60',
  secondary:
    'border border-slate-700 bg-slate-900/60 text-slate-100 hover:bg-slate-800 focus-visible:ring-slate-500/60',
  outline:
    'border border-slate-700 bg-transparent text-slate-200 hover:bg-slate-900/60 hover:text-slate-100 focus-visible:ring-slate-500/60',
  ghost:
    'border border-transparent bg-transparent text-slate-300 hover:bg-slate-900/60 hover:text-slate-100 focus-visible:ring-slate-500/60',
  destructive:
    'border border-red-500/60 bg-red-500/90 text-red-50 hover:bg-red-500 focus-visible:ring-red-400/60',
  link:
    'border border-transparent bg-transparent p-0 text-sky-300 underline-offset-4 hover:underline focus-visible:ring-sky-400/60',
};

/** @type {Record<ButtonSize, string>} */
const SIZE_CLASSES = {
  default: 'h-9 px-4 py-2 text-sm',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-10 px-6 text-sm',
  icon: 'h-9 w-9 p-0 text-sm',
};

/**
 * Common base classes shared by every variant. Kept separate so callers
 * can compose the variant recipe via {@link buttonVariants} when they
 * render a non-button element (e.g. `<a>` styled as a button).
 */
const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:pointer-events-none disabled:opacity-50';

/**
 * Recipe helper — returns the resolved class string for a given
 * `variant` + `size`, mirroring shadcn's `class-variance-authority`
 * factory. Useful when you want to style a non-`<button>` element as a
 * button (e.g. a `<a>` link that must look like a primary action).
 *
 * @param {{ variant?: ButtonVariant, size?: ButtonSize, className?: string }} [opts]
 * @returns {string}
 */
export function buttonVariants({
  variant = 'primary',
  size = 'default',
  className,
} = {}) {
  return cn(
    BASE_CLASSES,
    VARIANT_CLASSES[variant] || VARIANT_CLASSES.primary,
    SIZE_CLASSES[size] || SIZE_CLASSES.default,
    className,
  );
}

/**
 * Button — primary interactive control.
 *
 * @param {{
 *   variant?: ButtonVariant,
 *   size?: ButtonSize,
 *   className?: string,
 *   type?: 'button' | 'submit' | 'reset',
 * } & React.ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export const Button = React.forwardRef(function Button(
  { variant = 'primary', size = 'default', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-component="button"
      data-variant={variant}
      data-size={size}
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  );
});

export default Button;
