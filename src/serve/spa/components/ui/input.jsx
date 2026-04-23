/**
 * shadcn/ui-style Input primitive.
 *
 * Dependency-free vendored implementation of shadcn/ui's `input`
 * component (https://ui.shadcn.com/docs/components/input). A thin
 * wrapper around `<input>` that applies canonical shadcn token
 * utilities (`border-input`, `bg-background`,
 * `placeholder:text-muted-foreground`, `ring-ring`) so form fields
 * theme correctly under both light and dark modes via the CSS
 * variables defined in `styles/globals.css`.
 *
 * Usage:
 *
 *   <Input placeholder="Search agents…" />
 *   <Input type="email" required aria-invalid={!isValid} />
 *   <Input disabled value={slug} />
 *
 * Accessibility:
 *   - Forwards `ref` so wrapping forms can focus / select the control.
 *   - `aria-invalid="true"` triggers a destructive-token ring, matching
 *     the shadcn pattern.
 *   - `disabled` dims the control and blocks pointer events per the
 *     shadcn baseline.
 *
 * @module serve/spa/components/ui/input
 */

import React from 'react';

import { cn } from '../../lib/cn.js';

/**
 * Input — text field primitive.
 *
 * @param {{
 *   className?: string,
 *   type?: string,
 * } & React.InputHTMLAttributes<HTMLInputElement>} props
 */
export const Input = React.forwardRef(function Input(
  { className, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      data-component="input"
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive',
        className,
      )}
      {...props}
    />
  );
});

export default Input;
