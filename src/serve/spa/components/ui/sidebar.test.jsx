/**
 * Component tests for the shadcn/ui Sidebar primitive family
 * (AC 2 — stock shadcn sidebar primitive).
 *
 * Scope:
 *   - `SidebarProvider` owns the open/collapsed state and persists the
 *     user's choice to localStorage under `aweek:sidebar:open`.
 *   - `useSidebar` throws outside a provider (guards against misuse).
 *   - `SidebarMenuButton` composes the active recipe, forwards refs,
 *     and supports `asChild` for link-as-button rendering.
 *   - `SidebarTrigger` toggles the context state.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';

import {
  SIDEBAR_STORAGE_KEY,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from './sidebar.jsx';

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
});

describe('SidebarProvider', () => {
  it('renders the wrapper with expanded state and exposes CSS variables', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent />
        </Sidebar>
      </SidebarProvider>,
    );
    const wrapper = container.querySelector('[data-component="sidebar-wrapper"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('data-state', 'expanded');
    // Inline CSS custom properties must be present so the primitive
    // width is consistent regardless of Tailwind plugin config.
    expect(wrapper.style.getPropertyValue('--sidebar-width')).toBe('16rem');
    expect(wrapper.style.getPropertyValue('--sidebar-width-icon')).toBe('3rem');
  });

  it('defaults to open=true when no stored value is present', () => {
    let seen;
    function Probe() {
      seen = useSidebar();
      return null;
    }
    render(
      <SidebarProvider>
        <Probe />
      </SidebarProvider>,
    );
    expect(seen.open).toBe(true);
    expect(seen.state).toBe('expanded');
  });

  it('hydrates open=false from localStorage', () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'false');
    let seen;
    function Probe() {
      seen = useSidebar();
      return null;
    }
    render(
      <SidebarProvider>
        <Probe />
      </SidebarProvider>,
    );
    expect(seen.open).toBe(false);
    expect(seen.state).toBe('collapsed');
  });

  it('persists toggles to localStorage', () => {
    function Harness() {
      const { open, toggleSidebar } = useSidebar();
      return (
        <button type="button" data-testid="probe" onClick={toggleSidebar}>
          {open ? 'OPEN' : 'CLOSED'}
        </button>
      );
    }
    const { getByTestId } = render(
      <SidebarProvider>
        <Harness />
      </SidebarProvider>,
    );
    const btn = getByTestId('probe');
    expect(btn).toHaveTextContent('OPEN');
    fireEvent.click(btn);
    expect(btn).toHaveTextContent('CLOSED');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('false');
    fireEvent.click(btn);
    expect(btn).toHaveTextContent('OPEN');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('true');
  });
});

describe('useSidebar', () => {
  it('throws outside a SidebarProvider', () => {
    function Consumer() {
      useSidebar();
      return null;
    }
    // React logs the error to console.error on throw — swallow it so
    // the test output stays clean. We only care that `render` throws.
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Consumer />)).toThrow(/SidebarProvider/);
    } finally {
      console.error = originalError;
    }
  });
});

describe('Sidebar markup', () => {
  it('renders rail + spacer when collapsible="icon"', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarContent />
        </Sidebar>
      </SidebarProvider>,
    );
    expect(container.querySelector('[data-component="sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-spacer"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-rail"]')).not.toBeNull();
  });

  it('renders a single column when collapsible="none"', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar collapsible="none">
          <SidebarContent />
        </Sidebar>
      </SidebarProvider>,
    );
    const sidebar = container.querySelector('[data-component="sidebar"]');
    expect(sidebar).toHaveAttribute('data-collapsible', 'none');
    expect(container.querySelector('[data-component="sidebar-spacer"]')).toBeNull();
  });

  it('SidebarInset renders a <main> landmark beside the sidebar', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent />
        </Sidebar>
        <SidebarInset>content</SidebarInset>
      </SidebarProvider>,
    );
    const inset = container.querySelector('[data-component="sidebar-inset"]');
    expect(inset).not.toBeNull();
    expect(inset.tagName).toBe('MAIN');
  });
});

describe('SidebarMenuButton', () => {
  it('renders a <button> by default with data-active="false"', () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>Agents</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarProvider>,
    );
    const btn = container.querySelector('[data-component="sidebar-menu-button"]');
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('data-active', 'false');
    expect(btn).not.toHaveAttribute('aria-current');
  });

  it('sets aria-current="page" when isActive', () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarMenuButton isActive>Agents</SidebarMenuButton>
      </SidebarProvider>,
    );
    const btn = container.querySelector('[data-component="sidebar-menu-button"]');
    expect(btn).toHaveAttribute('data-active', 'true');
    expect(btn).toHaveAttribute('aria-current', 'page');
  });

  it('renders as the child element when asChild', () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarMenuButton asChild>
          <a href="/agents">Agents</a>
        </SidebarMenuButton>
      </SidebarProvider>,
    );
    const el = container.querySelector('[data-component="sidebar-menu-button"]');
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('A');
    expect(el).toHaveAttribute('href', '/agents');
    expect(el).toHaveTextContent('Agents');
  });

  it('forwards refs and composes caller className last', () => {
    const ref = React.createRef();
    const { container } = render(
      <SidebarProvider>
        <SidebarMenuButton ref={ref} className="shadow-xl">
          Agents
        </SidebarMenuButton>
      </SidebarProvider>,
    );
    const btn = container.querySelector('[data-component="sidebar-menu-button"]');
    expect(ref.current).toBe(btn);
    expect(btn.className).toContain('shadow-xl');
    // Base recipe tokens must still be present.
    expect(btn.className).toContain('rounded-md');
  });
});

describe('SidebarTrigger', () => {
  it('toggles the sidebar state when clicked', () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );
    const wrapper = container.querySelector('[data-component="sidebar-wrapper"]');
    const trigger = container.querySelector(
      '[data-component="sidebar-trigger"]',
    );
    expect(wrapper).toHaveAttribute('data-state', 'expanded');
    fireEvent.click(trigger);
    expect(wrapper).toHaveAttribute('data-state', 'collapsed');
    fireEvent.click(trigger);
    expect(wrapper).toHaveAttribute('data-state', 'expanded');
  });
});

describe('Sidebar composition', () => {
  it('supports the full Header / Content / Menu nesting', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>brand</SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Navigation</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Agents</SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    expect(container.querySelector('[data-component="sidebar-header"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-content"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-group"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-group-label"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-group-content"]')).not.toBeNull();
    expect(container.querySelector('[data-component="sidebar-menu"]').tagName).toBe('UL');
    expect(container.querySelector('[data-component="sidebar-menu-item"]').tagName).toBe('LI');
  });
});
