/**
 * shadcn/ui Badge primitive (canonical markup).
 *
 * Vendored verbatim from shadcn/ui's reference implementation
 * (https://ui.shadcn.com/docs/components/badge). Inline status chip styled
 * via `class-variance-authority`. All colors resolve to the shadcn theme
 * tokens declared in `styles/globals.css` (`--primary`, `--secondary`,
 * `--destructive`, `--foreground`, …) so the control re-themes for free
 * when the `.dark` class is toggled on `<html>`.
 *
 * Public surface:
 *   - `<Badge>` — `<span>` element with a `variant` prop (and optional
 *     `asChild` for slotting `<Link>` / `<a>` targets).
 *   - `badgeVariants({ variant, className })` — CVA recipe helper for
 *     styling non-`<span>` elements as badges.
 *
 * Variants: `default` · `secondary` · `destructive` · `outline`.
 *
 * @module serve/spa/components/ui/badge
 */

import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';

import { cn } from '../../lib/cn.js';

/**
 * @typedef {'default' | 'secondary' | 'destructive' | 'outline'} BadgeVariant
 */

/**
 * CVA recipe — returns the resolved class string for a given `variant`.
 * Every color resolves to a shadcn theme token so the badge inherits the
 * active light/dark palette without any bespoke color classes.
 */
export const badgeVariants = cva(
  'inline-flex items-center justify-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/90',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'text-foreground hover:bg-accent hover:text-accent-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/**
 * Badge — inline status chip.
 *
 * When `asChild` is true the component renders via Radix `Slot`, cloning
 * its sole child and forwarding refs + props onto it (canonical shadcn
 * pattern used for turning `<Link>` / `<a>` into a styled badge).
 *
 * @param {{
 *   variant?: BadgeVariant,
 *   asChild?: boolean,
 *   className?: string,
 * } & React.HTMLAttributes<HTMLSpanElement>} props
 */
export const Badge = React.forwardRef(function Badge(
  { className, variant, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp
      ref={ref}
      data-component="badge"
      data-variant={variant ?? 'default'}
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
});

Badge.displayName = 'Badge';

export default Badge;
