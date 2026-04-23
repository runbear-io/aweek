/**
 * shadcn/ui Button primitive (canonical markup).
 *
 * Vendored verbatim from shadcn/ui's reference implementation
 * (https://ui.shadcn.com/docs/components/button). The component is a
 * `React.forwardRef`'d native `<button>` (or a `Slot` when `asChild` is
 * set) styled via `class-variance-authority`. All colors resolve to the
 * shadcn theme tokens declared in `styles/globals.css` (`--primary`,
 * `--secondary`, `--destructive`, `--accent`, …) so the control re-themes
 * for free when the `.dark` class is toggled on `<html>`.
 *
 * Public surface:
 *   - `<Button>` — native button with `variant` + `size` props.
 *   - `buttonVariants({ variant, size, className })` — CVA recipe helper
 *     for styling non-`<button>` elements (e.g. anchor-as-button).
 *
 * Variants: `default` · `secondary` · `destructive` · `outline` · `ghost`
 *           · `link`.
 * Sizes:    `default` · `sm` · `lg` · `icon`.
 *
 * @module serve/spa/components/ui/button
 */

import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';

import { cn } from '../../lib/cn.js';

/**
 * CVA recipe — returns the resolved class string for a given
 * `variant` + `size`. Use this when styling a non-`<button>` element as a
 * button (e.g. an `<a>` link that must look like a primary action).
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/**
 * Button — primary interactive control.
 *
 * When `asChild` is true the component renders via Radix `Slot`, cloning
 * its sole child and forwarding refs + props onto it (canonical shadcn
 * pattern used for turning `<Link>` / `<a>` into a styled button).
 *
 * @param {{
 *   variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link',
 *   size?: 'default' | 'sm' | 'lg' | 'icon',
 *   asChild?: boolean,
 *   className?: string,
 *   type?: 'button' | 'submit' | 'reset',
 * } & React.ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export const Button = React.forwardRef(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      data-component="button"
      data-variant={variant ?? 'default'}
      data-size={size ?? 'default'}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

Button.displayName = 'Button';

export default Button;
