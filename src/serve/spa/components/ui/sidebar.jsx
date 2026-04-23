/**
 * shadcn/ui-style Sidebar primitives.
 *
 * Vendored implementation of shadcn/ui's canonical `sidebar` component
 * family (https://ui.shadcn.com/docs/components/sidebar). Public surface
 * mirrors the upstream reference — `SidebarProvider`, `Sidebar`,
 * `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarGroup`,
 * `SidebarGroupLabel`, `SidebarGroupContent`, `SidebarMenu`,
 * `SidebarMenuItem`, `SidebarMenuButton`, `SidebarInset`,
 * `SidebarTrigger`, `SidebarSeparator`, and the `useSidebar` context hook
 * — so pages can import individual pieces exactly as they would from
 * upstream shadcn/ui.
 *
 * Design decisions:
 *   - `SidebarProvider` owns the expanded/collapsed state and exposes
 *     it via React context. State is persisted to `localStorage` under
 *     `aweek:sidebar:open` so the user's choice survives reloads.
 *   - `Sidebar` renders as a fixed left rail with a spacer sibling so
 *     the main content (`SidebarInset`) reflows beside it.
 *   - `SidebarMenuButton` supports `asChild` (via `@radix-ui/react-slot`)
 *     so callers can pass a `<Link>` / `<NavLink>` from any router and
 *     keep keyboard/focus semantics intact.
 *   - Styling is Tailwind-only, referencing shadcn theme tokens
 *     (`bg-background`, `text-foreground`, `border-border`,
 *     `bg-accent`, `text-accent-foreground`, `text-muted-foreground`,
 *     `ring-ring`) so both light and dark themes inherit correctly.
 *
 * @module serve/spa/components/ui/sidebar
 */

import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { PanelLeft } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Button } from './button.jsx';

/** Expanded width of the rail. */
const SIDEBAR_WIDTH = '16rem';
/** Collapsed icon-only width. */
const SIDEBAR_WIDTH_ICON = '3rem';
/** Keyboard shortcut to toggle the sidebar: Cmd/Ctrl + B (shadcn default). */
const SIDEBAR_KEYBOARD_SHORTCUT = 'b';
/** localStorage key for the persisted open state. */
export const SIDEBAR_STORAGE_KEY = 'aweek:sidebar:open';

/**
 * @typedef {object} SidebarContextValue
 * @property {'expanded' | 'collapsed'} state
 * @property {boolean} open
 * @property {(value: boolean | ((prev: boolean) => boolean)) => void} setOpen
 * @property {() => void} toggleSidebar
 */

const SidebarContext = React.createContext(null);

/**
 * Consume the sidebar state from the nearest `SidebarProvider`.
 *
 * @returns {SidebarContextValue}
 */
export function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }
  return context;
}

/** Safe localStorage read — returns `defaultValue` on any failure. */
function readStoredOpen(defaultValue) {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Safe localStorage write — silently swallows errors. */
function writeStoredOpen(value) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

/**
 * Provides sidebar state (expanded/collapsed) to the subtree via React
 * context and persists the user's choice to localStorage. Wrap the app
 * shell (sidebar + inset) in this component.
 *
 * @param {{
 *   defaultOpen?: boolean,
 *   open?: boolean,
 *   onOpenChange?: (open: boolean) => void,
 *   className?: string,
 *   style?: React.CSSProperties,
 *   children?: React.ReactNode,
 * } & React.HTMLAttributes<HTMLDivElement>} props
 */
export const SidebarProvider = React.forwardRef(function SidebarProvider(
  {
    defaultOpen = true,
    open: openProp,
    onOpenChange: setOpenProp,
    className,
    style,
    children,
    ...props
  },
  ref,
) {
  const [internalOpen, setInternalOpen] = React.useState(() =>
    readStoredOpen(defaultOpen),
  );
  const open = openProp ?? internalOpen;

  const setOpen = React.useCallback(
    (value) => {
      const next = typeof value === 'function' ? value(open) : value;
      if (typeof setOpenProp === 'function') {
        setOpenProp(next);
      } else {
        setInternalOpen(next);
      }
      writeStoredOpen(next);
    },
    [open, setOpenProp],
  );

  const toggleSidebar = React.useCallback(() => {
    setOpen((prev) => !prev);
  }, [setOpen]);

  // Keyboard shortcut: Cmd/Ctrl + B toggles the sidebar.
  React.useEffect(() => {
    function handleKey(event) {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [toggleSidebar]);

  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo(
    () => ({ state, open, setOpen, toggleSidebar }),
    [state, open, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        ref={ref}
        data-component="sidebar-wrapper"
        data-state={state}
        style={{
          '--sidebar-width': SIDEBAR_WIDTH,
          '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
          ...style,
        }}
        className={cn(
          'group/sidebar-wrapper flex min-h-screen w-full bg-background text-foreground',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
});

/**
 * Sidebar shell — a fixed-position column on the chosen side plus a
 * reserved-space spacer so main content reflows around it.
 *
 * @param {{
 *   side?: 'left' | 'right',
 *   variant?: 'sidebar' | 'inset' | 'floating',
 *   collapsible?: 'icon' | 'none',
 *   className?: string,
 *   children?: React.ReactNode,
 * } & React.HTMLAttributes<HTMLDivElement>} props
 */
export const Sidebar = React.forwardRef(function Sidebar(
  {
    side = 'left',
    variant = 'sidebar',
    collapsible = 'icon',
    className,
    children,
    ...props
  },
  ref,
) {
  const { state } = useSidebar();

  if (collapsible === 'none') {
    return (
      <div
        ref={ref}
        data-component="sidebar"
        data-side={side}
        data-variant={variant}
        data-state={state}
        data-collapsible="none"
        className={cn(
          'flex h-screen w-[--sidebar-width] shrink-0 flex-col border-r border-border bg-background text-foreground',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-component="sidebar"
      data-side={side}
      data-variant={variant}
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      className="group/sidebar peer hidden text-foreground md:block"
    >
      {/* Spacer — reserves inline flow space so `SidebarInset` slots beside the rail. */}
      <div
        data-component="sidebar-spacer"
        aria-hidden="true"
        className={cn(
          'relative h-screen w-[--sidebar-width] bg-transparent transition-[width] duration-200 ease-linear',
          'group-data-[collapsible=icon]/sidebar:w-[--sidebar-width-icon]',
        )}
      />
      {/* Fixed rail — actual visible sidebar chrome. */}
      <div
        data-component="sidebar-rail"
        className={cn(
          'fixed inset-y-0 z-10 hidden h-screen w-[--sidebar-width] transition-[left,right,width] duration-200 ease-linear md:flex',
          side === 'left'
            ? 'left-0 border-r border-border'
            : 'right-0 border-l border-border',
          'group-data-[collapsible=icon]/sidebar:w-[--sidebar-width-icon]',
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          className="flex h-full w-full flex-col bg-background"
        >
          {children}
        </div>
      </div>
    </div>
  );
});

/**
 * Main content region paired with a `Sidebar`. Renders as a `<main>` so
 * it carries the landmark role automatically.
 *
 * @param {{
 *   className?: string,
 * } & React.HTMLAttributes<HTMLElement>} props
 */
export const SidebarInset = React.forwardRef(function SidebarInset(
  { className, ...props },
  ref,
) {
  return (
    <main
      ref={ref}
      data-component="sidebar-inset"
      className={cn(
        'relative flex min-h-screen flex-1 flex-col bg-background text-foreground',
        className,
      )}
      {...props}
    />
  );
});

/**
 * Toggle the sidebar's expanded/collapsed state. Renders as a ghost
 * icon-sized `<Button>` — same primitive family used across the SPA.
 *
 * @param {{
 *   className?: string,
 *   onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void,
 * } & React.ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export const SidebarTrigger = React.forwardRef(function SidebarTrigger(
  { className, onClick, ...props },
  ref,
) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-component="sidebar-trigger"
      aria-label="Toggle sidebar"
      className={cn('h-7 w-7', className)}
      onClick={(event) => {
        if (typeof onClick === 'function') onClick(event);
        if (!event.defaultPrevented) toggleSidebar();
      }}
      {...props}
    >
      <PanelLeft className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
});

/** Header slot — flush with the top of the sidebar chrome. */
export const SidebarHeader = React.forwardRef(function SidebarHeader(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="sidebar-header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
});

/** Footer slot — flush with the bottom of the sidebar chrome. */
export const SidebarFooter = React.forwardRef(function SidebarFooter(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="sidebar-footer"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
});

/** Scrollable content slot between header & footer. */
export const SidebarContent = React.forwardRef(function SidebarContent(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="sidebar-content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]/sidebar:overflow-hidden',
        className,
      )}
      {...props}
    />
  );
});

/** Visual divider between sidebar regions. */
export const SidebarSeparator = React.forwardRef(function SidebarSeparator(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="sidebar-separator"
      role="separator"
      aria-orientation="horizontal"
      className={cn('mx-2 h-px w-auto bg-border', className)}
      {...props}
    />
  );
});

/** Grouping container inside `SidebarContent`. */
export const SidebarGroup = React.forwardRef(function SidebarGroup(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-component="sidebar-group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  );
});

/**
 * Group heading (e.g. "Navigation"). Pass `asChild` to render as any
 * element via `@radix-ui/react-slot`.
 *
 * @param {{
 *   asChild?: boolean,
 *   className?: string,
 * } & React.HTMLAttributes<HTMLDivElement>} props
 */
export const SidebarGroupLabel = React.forwardRef(function SidebarGroupLabel(
  { className, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      ref={ref}
      data-component="sidebar-group-label"
      className={cn(
        'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-muted-foreground outline-none ring-ring transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 group-data-[collapsible=icon]/sidebar:-mt-8 group-data-[collapsible=icon]/sidebar:opacity-0',
        className,
      )}
      {...props}
    />
  );
});

/** Content wrapper inside a `SidebarGroup`. */
export const SidebarGroupContent = React.forwardRef(
  function SidebarGroupContent({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-component="sidebar-group-content"
        className={cn('w-full text-sm', className)}
        {...props}
      />
    );
  },
);

/** Top-level menu `<ul>` wrapping `SidebarMenuItem`s. */
export const SidebarMenu = React.forwardRef(function SidebarMenu(
  { className, ...props },
  ref,
) {
  return (
    <ul
      ref={ref}
      data-component="sidebar-menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  );
});

/** Row `<li>` wrapping a single `SidebarMenuButton`. */
export const SidebarMenuItem = React.forwardRef(function SidebarMenuItem(
  { className, ...props },
  ref,
) {
  return (
    <li
      ref={ref}
      data-component="sidebar-menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  );
});

const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-ring transition-[width,height,padding] focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-accent data-[active=true]:font-medium data-[active=true]:text-accent-foreground hover:bg-accent hover:text-accent-foreground group-data-[collapsible=icon]/sidebar:!size-8 group-data-[collapsible=icon]/sidebar:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: '',
        outline:
          'bg-background border border-border hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]/sidebar:!p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/**
 * Primary menu row control. Pass `asChild` to render any interactive
 * element (e.g. a `<Link>` from react-router) while keeping the focus /
 * active / hover recipe. `isActive` flips the `data-active` hook so
 * callers can wire their own URL-based active-state logic.
 *
 * @param {{
 *   asChild?: boolean,
 *   isActive?: boolean,
 *   variant?: 'default' | 'outline',
 *   size?: 'default' | 'sm' | 'lg',
 *   className?: string,
 * } & React.ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export const SidebarMenuButton = React.forwardRef(function SidebarMenuButton(
  {
    asChild = false,
    isActive = false,
    variant = 'default',
    size = 'default',
    className,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      data-component="sidebar-menu-button"
      data-active={isActive ? 'true' : 'false'}
      data-variant={variant}
      data-size={size}
      aria-current={isActive ? 'page' : undefined}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

export default Sidebar;
