/**
 * shadcn/ui-style Input primitive.
 *
 * Dependency-free vendored implementation of shadcn/ui's `input`
 * component (https://ui.shadcn.com/docs/components/input). A thin
 * wrapper around `<input>` that applies the dark-palette Tailwind
 * classes used by the rest of the SPA chrome so form fields blend with
 * the surrounding cards, tables, and tab surfaces.
 *
 * Usage:
 *
 *   <Input placeholder="Search agents…" />
 *   <Input type="email" required aria-invalid={!isValid} />
 *   <Input disabled value={slug} />
 *
 * Accessibility:
 *   - Forwards `ref` so wrapping forms can focus / select the control.
 *   - `aria-invalid="true"` triggers a red border + ring, matching the
 *     shadcn pattern.
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
        'flex h-9 w-full rounded-md border border-slate-700 bg-slate-950/60 px-3 py-1 text-sm text-slate-100 shadow-sm transition-colors',
        'placeholder:text-slate-500',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-slate-200',
        'aria-[invalid=true]:border-red-500/70 aria-[invalid=true]:focus-visible:ring-red-500/60',
        className,
      )}
      {...props}
    />
  );
});

export default Input;
