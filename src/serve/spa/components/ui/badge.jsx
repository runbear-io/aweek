/**
 * shadcn/ui-style Badge primitive.
 *
 * Dependency-free vendored implementation of shadcn/ui's `badge`
 * component (https://ui.shadcn.com/docs/components/badge). Used for
 * inline status chips (agent state, run result, budget tier) across the
 * SPA. Variants reuse the same palette family as `Button` so tone is
 * consistent across controls.
 *
 * Usage:
 *
 *   <Badge>default</Badge>
 *   <Badge variant="success">healthy</Badge>
 *   <Badge variant="destructive">paused</Badge>
 *
 * @module serve/spa/components/ui/badge
 */

import React from 'react';

import { cn } from '../../lib/cn.js';

/**
 * @typedef {'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive'} BadgeVariant
 */

/** @type {Record<BadgeVariant, string>} */
const VARIANT_CLASSES = {
  default:
    'border-sky-400/40 bg-sky-500/10 text-sky-200',
  secondary:
    'border-slate-700 bg-slate-900/60 text-slate-200',
  outline:
    'border-slate-700 bg-transparent text-slate-300',
  success:
    'border-emerald-400/40 bg-emerald-500/10 text-emerald-200',
  warning:
    'border-amber-400/40 bg-amber-500/10 text-amber-200',
  destructive:
    'border-red-400/40 bg-red-500/10 text-red-200',
};

/**
 * Recipe helper — returns the resolved class string for a given
 * `variant`, mirroring shadcn's CVA factory.
 *
 * @param {{ variant?: BadgeVariant, className?: string }} [opts]
 * @returns {string}
 */
export function badgeVariants({ variant = 'default', className } = {}) {
  return cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
    VARIANT_CLASSES[variant] || VARIANT_CLASSES.default,
    className,
  );
}

/**
 * Badge — inline status chip.
 *
 * @param {{
 *   variant?: BadgeVariant,
 *   className?: string,
 * } & React.HTMLAttributes<HTMLSpanElement>} props
 */
export const Badge = React.forwardRef(function Badge(
  { variant = 'default', className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      data-component="badge"
      data-variant={variant}
      className={badgeVariants({ variant, className })}
      {...props}
    />
  );
});

export default Badge;
