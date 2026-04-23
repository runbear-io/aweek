/**
 * shadcn/ui-style Textarea primitive.
 *
 * Dependency-free vendored implementation of shadcn/ui's `textarea`
 * component (https://ui.shadcn.com/docs/components/textarea). Applies
 * canonical shadcn token utilities (`border-input`, `bg-background`,
 * `placeholder:text-muted-foreground`, `ring-ring`) so multi-line form
 * fields theme correctly under both light and dark modes via the CSS
 * variables defined in `styles/globals.css`. Matches the visual tokens
 * used by `<Input />` so single-line and multi-line form fields compose
 * seamlessly.
 *
 * Usage:
 *
 *   <Textarea rows={4} placeholder="Goal description…" />
 *
 * Accessibility:
 *   - Forwards `ref` so wrapping forms can focus / select the control.
 *   - `aria-invalid="true"` triggers a destructive-token ring, matching
 *     the shadcn pattern.
 *   - `disabled` dims the control and blocks pointer events per the
 *     shadcn baseline.
 *
 * @module serve/spa/components/ui/textarea
 */

import React from 'react';

import { cn } from '../../lib/cn.js';

/**
 * Textarea — multi-line text field primitive.
 *
 * @param {{
 *   className?: string,
 * } & React.TextareaHTMLAttributes<HTMLTextAreaElement>} props
 */
export const Textarea = React.forwardRef(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      data-component="textarea"
      className={cn(
        'flex min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors',
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

export default Textarea;
