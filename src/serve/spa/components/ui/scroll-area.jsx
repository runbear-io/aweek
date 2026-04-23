/**
 * shadcn/ui ScrollArea primitives.
 *
 * Canonical shadcn markup (https://ui.shadcn.com/docs/components/scroll-area)
 * wrapping `@radix-ui/react-scroll-area`. Exports `ScrollArea` + `ScrollBar`
 * so pages like Activity Timeline and the agent drill-down get:
 *
 *   - An overlay-style scrollbar track that doesn't shift layout.
 *   - Correct keyboard scroll + focus handling.
 *   - Consistent chrome across webkit / firefox / safari.
 *
 * Colours are driven by the shadcn design tokens in `styles/globals.css`
 * (`--border`, `--background`, ...) so the same markup renders correctly
 * in both the light and dark themes.
 *
 * Usage:
 *
 *   <ScrollArea className="h-72 w-full rounded-md border">
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
const ScrollArea = React.forwardRef(function ScrollArea(
  { className, children, ...props },
  ref,
) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
});
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

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
const ScrollBar = React.forwardRef(function ScrollBar(
  { className, orientation = 'vertical', ...props },
  ref,
) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        'flex touch-none select-none transition-colors',
        orientation === 'vertical' &&
          'h-full w-2.5 border-l border-l-transparent p-[1px]',
        orientation === 'horizontal' &&
          'h-2.5 flex-col border-t border-t-transparent p-[1px]',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
});
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
export default ScrollArea;
