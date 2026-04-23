/**
 * shadcn/ui-style Label primitive.
 *
 * Dependency-free vendored implementation of shadcn/ui's `label`
 * component (https://ui.shadcn.com/docs/components/label). Renders a
 * native `<label>` with the Tailwind typography tokens used across the
 * SPA so form captions align with the rest of the chrome.
 *
 * Usage:
 *
 *   <Label htmlFor="slug">Slug</Label>
 *   <Input id="slug" name="slug" />
 *
 * Accessibility:
 *   - `htmlFor` is forwarded unmodified — pair it with the target
 *     input's `id` so clicks on the label focus the control.
 *   - The `peer-disabled` variant dims the caption when the associated
 *     input is `disabled` (shadcn default).
 *
 * @module serve/spa/components/ui/label
 */

import React from 'react';

import { cn } from '../../lib/cn.js';

/**
 * Label — form caption primitive.
 *
 * @param {{
 *   className?: string,
 * } & React.LabelHTMLAttributes<HTMLLabelElement>} props
 */
export const Label = React.forwardRef(function Label(
  { className, ...props },
  ref,
) {
  return (
    <label
      ref={ref}
      data-component="label"
      className={cn(
        'text-sm font-medium leading-none text-foreground',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  );
});

export default Label;
