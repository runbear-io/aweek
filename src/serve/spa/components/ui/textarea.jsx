/**
 * shadcn/ui-style Textarea primitive.
 *
 * Dependency-free vendored implementation of shadcn/ui's `textarea`
 * component (https://ui.shadcn.com/docs/components/textarea). Matches
 * the visual tokens used by `<Input />` so single-line and multi-line
 * form fields compose seamlessly.
 *
 * Usage:
 *
 *   <Textarea rows={4} placeholder="Goal description…" />
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
        'flex min-h-[72px] w-full rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 shadow-sm transition-colors',
        'placeholder:text-slate-500',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-red-500/70 aria-[invalid=true]:focus-visible:ring-red-500/60',
        className,
      )}
      {...props}
    />
  );
});

export default Textarea;
