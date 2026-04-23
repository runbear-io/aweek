/**
 * shadcn/ui-style ScrollArea primitives.
 *
 * Thin wrapper around `@radix-ui/react-scroll-area` — the same headless
 * component shadcn/ui itself ships on its reference page
 * (https://ui.shadcn.com/docs/components/scroll-area). The public
 * surface mirrors the shadcn reference exactly — `ScrollArea` plus the
 * lower-level `ScrollBar` — so pages like Activity Timeline and the
 * agent drill-down can use it as a drop-in replacement for a raw
 * `overflow-auto` div and get:
 *
 *   - An overlay-style scrollbar track that doesn't shift layout.
 *   - Correct keyboard scroll + focus handling.
 *   - Consistent chrome across webkit / firefox / safari.
 *
 * The visual palette (slate-900 track, slate-600 thumb) matches the
 * chrome used by `Nav`, `Tabs`, `Table`, and `Button` so the dashboard
 * reads as a single visual family.
 *
 * Usage:
 *
 *   <ScrollArea className="h-72 w-full rounded-md border border-slate-800">
 *     <div className="p-4 space-y-2">{items}</div>
 *   </ScrollArea>
 *
 * @module serve/spa/components/ui/scroll-area
 */

import React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

import { cn } from '../../lib/utils.js';

/**
 * Scrollable viewport with overlay scrollbars.
 *
 * @param {{
 *   className?: string,
 *   children?: React.ReactNode,
 * } & React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>} props
 */
export const ScrollArea = React.forwardRef(function ScrollArea(
  { className, children, ...props },
  ref,
) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      data-component="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-component="scroll-area-viewport"
        className="h-full w-full rounded-[inherit]"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
});

/**
 * Scrollbar track + thumb. Exposed separately so callers can opt into
 * horizontal scrollbars (`orientation="horizontal"`) or style the
 * vertical bar without rewriting the `ScrollArea` shell.
 *
 * @param {{
 *   className?: string,
 *   orientation?: 'vertical' | 'horizontal',
 * } & React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>} props
 */
export const ScrollBar = React.forwardRef(function ScrollBar(
  { className, orientation = 'vertical', ...props },
  ref,
) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      data-component="scroll-area-scrollbar"
      data-orientation={orientation}
      className={cn(
        'flex touch-none select-none transition-colors',
        orientation === 'vertical' &&
          'h-full w-2.5 border-l border-l-transparent p-px',
        orientation === 'horizontal' &&
          'h-2.5 flex-col border-t border-t-transparent p-px',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-component="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-slate-600"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
});

export default ScrollArea;
