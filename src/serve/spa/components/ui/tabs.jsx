/**
 * shadcn/ui-style Tabs primitives.
 *
 * Thin wrapper around `@radix-ui/react-tabs` — the same headless
 * component shadcn/ui itself builds on top of — so we get WAI-ARIA
 * roving focus, keyboard navigation, and correct `aria-selected` /
 * `aria-controls` plumbing for free. The public surface mirrors the
 * shadcn reference exactly — `Tabs`, `TabsList`, `TabsTrigger`,
 * `TabsContent` — so consumers stay unchanged if we later swap the
 * styling palette.
 *
 * Composition shape:
 *
 *   <Tabs value={...} onValueChange={...}>
 *     <TabsList>
 *       <TabsTrigger value="calendar">Calendar</TabsTrigger>
 *       <TabsTrigger value="activity">Activity</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="calendar">…</TabsContent>
 *     <TabsContent value="activity">…</TabsContent>
 *   </Tabs>
 *
 * Controlled mode (`value` + `onValueChange`) takes precedence over
 * uncontrolled mode (`defaultValue`). Either works; the Agent Detail
 * shell uses controlled mode so the active tab can be seeded from the
 * `initialTab` prop and surfaced as `data-active-tab` on the wrapper.
 *
 * Local contract enforced on top of Radix:
 *
 *   - Inactive `TabsContent` returns `null` (unmounted) rather than
 *     Radix's default `hidden` div. The detail shell embeds hook-driven
 *     child pages that each own a request; rendering inactive panels
 *     would fire those fetches on mount, wasting tokens and racing the
 *     active panel.
 *   - `TabsTrigger` activates on `click` in addition to Radix's built-in
 *     `mousedown` handler, so jsdom's `element.click()` (used by tests
 *     and programmatic callers) selects the tab even though it does not
 *     fire a `mousedown` event.
 *
 * Styling uses Tailwind utilities composed via `../../lib/cn.js`. The
 * active/inactive visual is a coloured bottom border so the tab row
 * reads like the dashboard baseline's terminal tabs.
 *
 * @module serve/spa/components/ui/tabs
 */

import React, { createContext, useContext, useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '../../lib/cn.js';

/**
 * @typedef {{ current: string | undefined, setCurrent: (value: string) => void }} TabsState
 */

/** @type {React.Context<TabsState | null>} */
const TabsStateContext = createContext(null);

function useTabsState(component) {
  const ctx = useContext(TabsStateContext);
  if (!ctx) {
    throw new Error(
      `<${component}> must be used inside <Tabs>. Wrap the list / trigger / content in a <Tabs value=…>.`,
    );
  }
  return ctx;
}

/**
 * Root container for a tab group. Manages the active value and exposes
 * it to descendants via:
 *   1. `@radix-ui/react-tabs` for the ARIA + keyboard nav primitives.
 *   2. A local `TabsStateContext` so `TabsContent` can unmount inactive
 *      panels and `TabsTrigger` can handle synthetic `click` events.
 *
 * @param {{
 *   value?: string,
 *   defaultValue?: string,
 *   onValueChange?: (value: string) => void,
 *   className?: string,
 *   children?: React.ReactNode,
 * } & React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>} props
 */
export const Tabs = React.forwardRef(function Tabs(
  {
    value,
    defaultValue,
    onValueChange,
    className,
    children,
    ...props
  },
  ref,
) {
  const [internal, setInternal] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const setCurrent = (next) => {
    if (!controlled) setInternal(next);
    if (typeof onValueChange === 'function') onValueChange(next);
  };
  return (
    <TabsStateContext.Provider value={{ current, setCurrent }}>
      <TabsPrimitive.Root
        ref={ref}
        value={current}
        onValueChange={setCurrent}
        data-component="tabs"
        className={cn('flex flex-col gap-4', className)}
        {...props}
      >
        {children}
      </TabsPrimitive.Root>
    </TabsStateContext.Provider>
  );
});

/**
 * Horizontal row of triggers.
 *
 * Radix renders this as `role="tablist"` and handles keyboard nav.
 * A shared bottom border is applied here so the active trigger's
 * underline reads as continuous with the chrome.
 *
 * @param {{ className?: string, children?: React.ReactNode } & React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>} props
 */
export const TabsList = React.forwardRef(function TabsList(
  { className, ...props },
  ref,
) {
  return (
    <TabsPrimitive.List
      ref={ref}
      data-component="tabs-list"
      className={cn(
        'inline-flex items-center gap-1 border-b border-slate-800',
        className,
      )}
      {...props}
    />
  );
});

/**
 * Individual tab trigger.
 *
 * Radix handles the `mousedown` → select path natively; we additionally
 * wire `onClick` through `TabsStateContext` so `element.click()` (e.g.
 * jsdom test runs, programmatic callers) also selects the tab.
 *
 * @param {{
 *   value: string,
 *   className?: string,
 *   children?: React.ReactNode,
 * } & React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>} props
 */
export const TabsTrigger = React.forwardRef(function TabsTrigger(
  { value, className, onClick, disabled, ...props },
  ref,
) {
  const { setCurrent } = useTabsState('TabsTrigger');
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      disabled={disabled}
      onClick={(event) => {
        if (typeof onClick === 'function') onClick(event);
        if (!event.defaultPrevented && !disabled) setCurrent(value);
      }}
      data-component="tabs-trigger"
      data-tab-value={value}
      className={cn(
        // Base trigger chrome.
        '-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-400 transition-colors',
        // Focus ring.
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
        // Disabled.
        'disabled:pointer-events-none disabled:opacity-50',
        // Hover (inactive only — active is owned by data-[state=active]).
        'hover:border-slate-700 hover:text-slate-200',
        // Active state via Radix data-state hook.
        'data-[state=active]:border-sky-400 data-[state=active]:text-slate-100 data-[state=active]:hover:border-sky-400',
        className,
      )}
      {...props}
    />
  );
});

/**
 * Panel bound to a specific trigger value.
 *
 * Returns `null` (unmounted) when inactive unless `forceMount` is set.
 * The detail shell embeds hook-driven child pages that each own a
 * request — rendering inactive panels would fire those fetches on
 * mount, wasting tokens and racing the active panel.
 *
 * @param {{
 *   value: string,
 *   className?: string,
 *   children?: React.ReactNode,
 *   forceMount?: boolean,
 * } & React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>} props
 */
export const TabsContent = React.forwardRef(function TabsContent(
  { value, className, forceMount = false, children, ...props },
  ref,
) {
  const { current } = useTabsState('TabsContent');
  const active = current === value;
  if (!active && !forceMount) return null;
  return (
    <TabsPrimitive.Content
      ref={ref}
      value={value}
      forceMount={forceMount || undefined}
      data-component="tabs-content"
      data-tab={value}
      className={cn('focus-visible:outline-none', className)}
      {...props}
    >
      {children}
    </TabsPrimitive.Content>
  );
});

export default Tabs;
